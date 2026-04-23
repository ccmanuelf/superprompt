/**
 * Auto-Generated Skills — Core Engine
 *
 * When a user completes a complex task successfully, Luna offers to save
 * the workflow as a reusable skill. This is how the Jarvis-like assistant
 * learns — as fundamental as memory.
 *
 * Adapted from Hermes Agent's concept: the LLM itself drafts the skill
 * as natural language instructions (system prompts), not generated code.
 *
 * Detection → Extraction → Drafting → Proposal → Approval → Storage
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { ProviderRouter } from './providers/router.js';
import type { StepResult } from './orchestrator.js';
import type { TableInitializer } from './core/interfaces.js';
import type { Skill } from './db-core.js';

// ── Types ────────────────────────────────────────────────────

export interface SkillCandidate {
  sourceType: 'orchestration' | 'tool_chain';
  originalRequest: string;
  toolsUsed: string[];
  stepResults?: StepResult[];
  qualityScore: number;
  chatId: string;
}

export interface SkillProposal {
  id: string;
  chatId: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  triggerPatterns: string[];
  sourceType: string;
  sourceSummary: string;
}

// ── Constants ────────────────────────────────────────────────

/** Minimum distinct tools to qualify as a skill candidate (single-turn) */
const MIN_TOOLS_FOR_CANDIDATE = 3;

/** Minimum steps for orchestration-based candidate */
const MIN_STEPS_FOR_CANDIDATE = 3;

/** Minimum quality score to consider a skill candidate */
const MIN_QUALITY_SCORE = 70;

/** Cooldown: max 1 proposal per chat per this many milliseconds */
const PROPOSAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Tool overlap threshold for deduplication (0-1) */
const DEDUP_OVERLAP_THRESHOLD = 0.8;

// ── Table Initialization ─────────────────────────────────────

export async function initAutoSkillsTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('skill_triggers'))) {
    await db.schema.createTable('skill_triggers', (t) => {
      t.increments('id').primary();
      t.string('skill_id').notNullable();
      t.string('pattern').notNullable();
      t.string('mode').notNullable().defaultTo('suggest');
      t.bigInteger('created_at').notNullable();
      t.foreign('skill_id').references('skills.id').onDelete('CASCADE');
      t.index(['skill_id']);
    });
  }

  if (!(await db.schema.hasTable('skill_proposals'))) {
    await db.schema.createTable('skill_proposals', (t) => {
      t.string('id').primary();
      t.string('chat_id').notNullable();
      t.string('proposed_name').notNullable();
      t.text('proposed_description').notNullable();
      t.text('proposed_prompt').notNullable();
      t.text('proposed_tools').nullable();
      t.text('proposed_triggers').nullable();
      t.string('source_type').notNullable();
      t.text('source_summary').notNullable();
      t.bigInteger('created_at').notNullable();
      t.string('status').notNullable().defaultTo('pending');
      t.index(['chat_id']);
      t.index(['status']);
    });
  }
}

export const autoSkillsTableInit: TableInitializer = {
  name: 'auto-skills',
  initTables: initAutoSkillsTables,
};

// ── DB Accessors ─────────────────────────────────────────────

export async function insertSkillTrigger(skillId: string, pattern: string, mode: string = 'suggest'): Promise<void> {
  const db = getKnex();
  await db('skill_triggers').insert({
    skill_id: skillId, pattern, mode, created_at: Date.now(),
  });
}

export async function getSkillTriggers(): Promise<Array<{ id: number; skill_id: string; pattern: string; mode: string }>> {
  const db = getKnex();
  return db('skill_triggers').select('id', 'skill_id', 'pattern', 'mode');
}

export async function getSkillTriggersForSkill(skillId: string): Promise<Array<{ pattern: string; mode: string }>> {
  const db = getKnex();
  return db('skill_triggers').where({ skill_id: skillId }).select('pattern', 'mode');
}

export async function insertSkillProposal(proposal: SkillProposal): Promise<void> {
  const db = getKnex();
  await db('skill_proposals').insert({
    id: proposal.id,
    chat_id: proposal.chatId,
    proposed_name: proposal.name,
    proposed_description: proposal.description,
    proposed_prompt: proposal.systemPrompt,
    proposed_tools: JSON.stringify(proposal.allowedTools),
    proposed_triggers: JSON.stringify(proposal.triggerPatterns),
    source_type: proposal.sourceType,
    source_summary: proposal.sourceSummary,
    created_at: Date.now(),
    status: 'pending',
  });
}

export async function getPendingProposal(chatId: string): Promise<SkillProposal | null> {
  const db = getKnex();
  const row = await db('skill_proposals')
    .where({ chat_id: chatId, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first() as any;
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    name: row.proposed_name,
    description: row.proposed_description,
    systemPrompt: row.proposed_prompt,
    allowedTools: JSON.parse(row.proposed_tools || '[]'),
    triggerPatterns: JSON.parse(row.proposed_triggers || '[]'),
    sourceType: row.source_type,
    sourceSummary: row.source_summary,
  };
}

export async function updateProposalStatus(id: string, status: 'approved' | 'rejected' | 'expired'): Promise<void> {
  const db = getKnex();
  await db('skill_proposals').where({ id }).update({ status });
}

async function getRecentProposalCount(chatId: string, windowMs: number): Promise<number> {
  const db = getKnex();
  const since = Date.now() - windowMs;
  const row = await db('skill_proposals')
    .where({ chat_id: chatId })
    .where('created_at', '>', since)
    .count('* as cnt')
    .first() as { cnt: number };
  return row?.cnt ?? 0;
}

// ── Detection ────────────────────────────────────────────────

/**
 * Detect if a completed task is a candidate for auto-skill generation.
 *
 * Thresholds:
 * - Orchestration: ≥3 steps, all successful
 * - Single-turn: ≥3 distinct tools used
 * - Quality score ≥70
 * - Cooldown: max 1 proposal per chat per hour
 * - Deduplication: skip if existing skill uses ≥80% same tools
 */
export async function detectSkillCandidate(params: {
  toolsUsed: string[];
  stepResults?: StepResult[];
  qualityScore: number;
  chatId: string;
  originalRequest: string;
}): Promise<SkillCandidate | null> {
  const { toolsUsed, stepResults, qualityScore, chatId, originalRequest } = params;

  // Quality threshold
  if (qualityScore < MIN_QUALITY_SCORE) return null;

  // Determine source type and validate
  let sourceType: 'orchestration' | 'tool_chain';

  if (stepResults && stepResults.length >= MIN_STEPS_FOR_CANDIDATE) {
    // Orchestration: all steps must be successful
    if (!stepResults.every((s) => s.success)) return null;
    sourceType = 'orchestration';
  } else if (toolsUsed.length >= MIN_TOOLS_FOR_CANDIDATE) {
    sourceType = 'tool_chain';
  } else {
    return null;
  }

  // Cooldown check
  const recentCount = await getRecentProposalCount(chatId, PROPOSAL_COOLDOWN_MS);
  if (recentCount > 0) {
    logger.debug({ chatId, recentCount }, 'Skill proposal cooldown active');
    return null;
  }

  // Deduplication: check if existing skills overlap significantly
  if (await isDuplicateSkill(toolsUsed)) {
    logger.debug({ chatId, toolsUsed }, 'Skill candidate too similar to existing skill');
    return null;
  }

  return {
    sourceType,
    originalRequest,
    toolsUsed,
    stepResults,
    qualityScore,
    chatId,
  };
}

async function isDuplicateSkill(toolsUsed: string[]): Promise<boolean> {
  const db = getKnex();
  const skills = await db('skills').whereNotNull('allowed_tools').select('allowed_tools') as Array<{ allowed_tools: string }>;

  const candidateTools = new Set(toolsUsed);

  for (const skill of skills) {
    try {
      const existingTools = JSON.parse(skill.allowed_tools) as string[];
      if (!Array.isArray(existingTools) || existingTools.length === 0) continue;

      const overlap = existingTools.filter((t) => candidateTools.has(t)).length;
      const overlapRatio = overlap / Math.max(candidateTools.size, existingTools.length);

      if (overlapRatio >= DEDUP_OVERLAP_THRESHOLD) return true;
    } catch {
      continue;
    }
  }

  return false;
}

// ── Drafting (AI-powered) ────────────────────────────────────

/**
 * Draft a skill definition using AI self-reflection.
 * The LLM itself is the skill author — it decides what's worth saving
 * and how to formulate the instructions.
 */
export async function draftSkillDefinition(
  candidate: SkillCandidate,
  router: ProviderRouter,
  chatId: string,
): Promise<SkillProposal | null> {
  const stepSummary = candidate.stepResults
    ? candidate.stepResults.map((s) =>
        `Step ${s.step}: ${s.instruction} → ${s.success ? 'Success' : 'Failed'}${s.toolsUsed ? ` (tools: ${s.toolsUsed.join(', ')})` : ''}`,
      ).join('\n')
    : `Tools used: ${candidate.toolsUsed.join(', ')}`;

  const metaprompt = `You are creating a reusable skill definition based on a successful workflow.

ORIGINAL USER REQUEST:
${candidate.originalRequest}

WORKFLOW:
${stepSummary}

TOOLS USED: ${candidate.toolsUsed.join(', ')}

Generate a skill definition as JSON. The system_prompt should be detailed instructions that another AI instance can follow to replicate this workflow. The trigger_patterns should be regex patterns (without / delimiters) that would match similar future requests.

Return ONLY valid JSON:
{
  "name": "short-lowercase-kebab-name",
  "description": "One sentence describing when to use this skill (in English)",
  "system_prompt": "Detailed step-by-step instructions for the AI to follow when this skill is triggered. Include which tools to use, in what order, and what to look for at each step. Be specific enough that the workflow is reproducible.",
  "trigger_patterns": ["regex pattern 1", "regex pattern 2"],
  "allowed_tools": ["tool1", "tool2"]
}`;

  try {
    const response = await router.sendMessage({
      message: metaprompt,
      chatId,
      skipTools: true,
      skipAutoTrigger: true,
      skipTurnLog: true,
    });

    if (!response.text) return null;

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.name || !parsed.system_prompt) return null;

    return {
      id: randomBytes(16).toString('hex'),
      chatId,
      name: String(parsed.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64),
      description: String(parsed.description || '').slice(0, 1024),
      systemPrompt: String(parsed.system_prompt),
      allowedTools: Array.isArray(parsed.allowed_tools) ? parsed.allowed_tools : candidate.toolsUsed,
      triggerPatterns: Array.isArray(parsed.trigger_patterns) ? parsed.trigger_patterns.map(String) : [],
      sourceType: candidate.sourceType,
      sourceSummary: candidate.originalRequest.slice(0, 500),
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to draft skill definition');
    return null;
  }
}

// ── User Interaction ─────────────────────────────────────────

/**
 * Format a bilingual proposal message for the user.
 */
export function proposeSkillToUser(proposal: SkillProposal): string {
  const triggers = proposal.triggerPatterns.length > 0
    ? proposal.triggerPatterns.map((p) => `\`${p}\``).join(', ')
    : '(auto-detected)';

  return [
    `[EN] I noticed this workflow could be saved as a reusable skill.`,
    `**Name:** ${proposal.name}`,
    `**Description:** ${proposal.description}`,
    `**Tools:** ${proposal.allowedTools.join(', ')}`,
    `**Triggers:** ${triggers}`,
    `Reply "yes" to save, or "no" to skip.`,
    ``,
    `[ES] Note que este flujo podria guardarse como una habilidad reutilizable.`,
    `**Nombre:** ${proposal.name}`,
    `**Descripcion:** ${proposal.description}`,
    `**Herramientas:** ${proposal.allowedTools.join(', ')}`,
    `**Disparadores:** ${triggers}`,
    `Responde "si" para guardar, o "no" para omitir.`,
  ].join('\n');
}

/**
 * Check if the user's message is a response to a pending skill proposal.
 * Returns 'approve' | 'reject' | null (not a response to a proposal).
 */
export function detectProposalResponse(message: string): 'approve' | 'reject' | null {
  const lower = message.trim().toLowerCase();
  // Only match short responses (1-3 words) to avoid false positives
  if (lower.split(/\s+/).length > 3) return null;

  if (/^(yes|si|sí|sure|ok|okay|yep|yeah|dale|claro|por supuesto|save it|guardalo|guárdalo)$/i.test(lower)) {
    return 'approve';
  }
  if (/^(no|nah|nope|skip|cancel|omitir|cancelar|no thanks|no gracias)$/i.test(lower)) {
    return 'reject';
  }
  return null;
}

/**
 * Handle user's response to a pending skill proposal.
 * Returns a bilingual confirmation message.
 */
export async function handleProposalResponse(chatId: string, approved: boolean): Promise<string> {
  const proposal = await getPendingProposal(chatId);
  if (!proposal) {
    return '[EN] No pending skill proposal found. [ES] No se encontro una propuesta de habilidad pendiente.';
  }

  if (approved) {
    const skillId = await createAutoSkill(proposal);
    await updateProposalStatus(proposal.id, 'approved');
    return [
      `[EN] Skill "${proposal.name}" created! It will activate when similar tasks are detected.`,
      `[ES] Habilidad "${proposal.name}" creada! Se activara cuando se detecten tareas similares.`,
    ].join('\n');
  } else {
    await updateProposalStatus(proposal.id, 'rejected');
    return [
      `[EN] Skill proposal skipped. I'll remember not to suggest this pattern again.`,
      `[ES] Propuesta de habilidad omitida. Recordare no sugerir este patron de nuevo.`,
    ].join('\n');
  }
}

/**
 * Expire any pending proposals for a chat (when user sends a normal message without responding).
 */
export async function expirePendingProposals(chatId: string): Promise<void> {
  const db = getKnex();
  await db('skill_proposals')
    .where({ chat_id: chatId, status: 'pending' })
    .update({ status: 'expired' });
}

// ── Skill Creation ───────────────────────────────────────────

/**
 * Create an auto-generated skill from an approved proposal.
 * Stores the skill + dynamic trigger patterns + revision.
 */
export async function createAutoSkill(proposal: SkillProposal): Promise<string> {
  const db = getKnex();
  const skillId = `auto-${proposal.name}`;
  const now = Date.now();

  // Create the skill
  await db('skills')
    .insert({
      id: skillId, name: proposal.name, description: proposal.description,
      system_prompt: proposal.systemPrompt, allowed_tools: JSON.stringify(proposal.allowedTools),
      is_builtin: 0, source_file: null, locked: 0, created_at: now, updated_at: now,
    })
    .onConflict('id')
    .merge({
      name: proposal.name, description: proposal.description,
      system_prompt: proposal.systemPrompt, allowed_tools: JSON.stringify(proposal.allowedTools),
      updated_at: now,
    });

  // Register dynamic trigger patterns
  for (const pattern of proposal.triggerPatterns) {
    try {
      // Validate the regex before storing
      new RegExp(pattern, 'i');
      await insertSkillTrigger(skillId, pattern, 'suggest');
    } catch {
      logger.warn({ pattern }, 'Invalid trigger pattern — skipped');
    }
  }

  // Store revision
  await db('skill_revisions').insert({
    skill_id: skillId, system_prompt: proposal.systemPrompt,
    revision_note: 'Auto-generated from workflow', created_at: now,
  });

  logger.info(
    { skillId, name: proposal.name, triggers: proposal.triggerPatterns.length },
    'Auto-generated skill created',
  );

  return skillId;
}

// ── Skill Self-Healing ───────────────────────────────────────
// When the AI uses a skill and the result is suboptimal, or the user
// corrects the approach, the skill is automatically patched to incorporate
// the learning. "Skills that aren't maintained become liabilities." — Hermes

/** Correction patterns (EN + ES) — user is telling the AI its approach was wrong */
const CORRECTION_PATTERNS = [
  /\b(no,?\s*(that'?s|that\s+is)\s*(wrong|incorrect|not right|not what I))/i,
  /\b(try\s+(again|differently|another\s+way))/i,
  /\b(that\s+didn'?t\s+work|doesn'?t\s+work|not\s+working)/i,
  /\b(wrong\s+approach|incorrect\s+approach|bad\s+approach)/i,
  /\b(you\s+should\s+(have|instead))/i,
  /\b(no,?\s*eso\s+(esta|está)\s+mal)/i,
  /\b(intenta\s+(de\s+nuevo|otra\s+vez|diferente))/i,
  /\b(eso\s+no\s+(funciona|sirve|es\s+correcto))/i,
  /\b(enfoque\s+(incorrecto|equivocado|malo))/i,
  /\b(deberias\s+(haber|en\s+su\s+lugar))/i,
];

/**
 * Detect if the user's message is a correction to a skill-guided response.
 */
export function detectSkillCorrection(message: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(message));
}

/**
 * Check if a skill needs healing based on quality score or user correction.
 *
 * @param activeSkill - The skill that was active during the response
 * @param qualityScore - Quality score of the response (0-100)
 * @param userMessage - The user's next message (may contain corrections)
 * @returns true if the skill should be patched
 */
export function shouldHealSkill(
  activeSkill: Skill,
  qualityScore: number,
  userMessage?: string,
): boolean {
  // Only heal auto-generated skills (not builtin or manually created)
  if (activeSkill.is_builtin) return false;
  if (!activeSkill.id.startsWith('auto-')) return false;

  // Low quality response while skill was active → skill has a gap
  if (qualityScore < MIN_QUALITY_SCORE) return true;

  // User correction detected
  if (userMessage && detectSkillCorrection(userMessage)) return true;

  return false;
}

/**
 * Heal a skill by patching its system prompt based on what went wrong.
 * Uses AI self-reflection to improve the skill instructions.
 *
 * This is the closed loop: use → find gap → patch → next use is better.
 */
export async function healSkill(
  skill: Skill,
  issue: string,
  conversationContext: string,
  router: ProviderRouter,
  chatId: string,
): Promise<{ patched: boolean; summary: string }> {
  const metaprompt = `You are improving an existing skill that had an issue during use.

CURRENT SKILL: "${skill.name}"
CURRENT SYSTEM PROMPT:
${skill.system_prompt}

ISSUE ENCOUNTERED:
${issue}

CONVERSATION CONTEXT (what happened):
${conversationContext}

Rewrite the system prompt to fix this issue. Preserve everything that works well.
Add specific instructions to handle the case that caused the problem.
If the issue was a missing step, add it. If the approach was wrong, correct it.
If a pitfall was discovered, add a "Pitfalls" section.

Return ONLY the updated system prompt text (no JSON wrapper, no markdown code block).`;

  try {
    const response = await router.sendMessage({
      message: metaprompt,
      chatId,
      skipTools: true,
      skipAutoTrigger: true,
      skipTurnLog: true,
    });

    if (!response.text || response.text.length < 50) {
      return { patched: false, summary: 'AI could not generate a meaningful patch' };
    }

    const newPrompt = response.text.trim();
    const db = getKnex();
    const now = Date.now();

    // Update the skill
    await db('skills').where({ id: skill.id }).update({ system_prompt: newPrompt, updated_at: now });

    // Store revision
    await db('skill_revisions').insert({
      skill_id: skill.id, system_prompt: newPrompt,
      revision_note: `Self-healed: ${issue.slice(0, 200)}`, created_at: now,
    });

    logger.info(
      { skillId: skill.id, skillName: skill.name, issue: issue.slice(0, 100) },
      'Skill self-healed',
    );

    return {
      patched: true,
      summary: `[EN] Skill "${skill.name}" has been automatically improved based on this experience.\n`
        + `[ES] La habilidad "${skill.name}" fue mejorada automaticamente basandose en esta experiencia.`,
    };
  } catch (err) {
    logger.warn({ err, skillId: skill.id }, 'Skill self-healing failed');
    return { patched: false, summary: 'Self-healing failed — will retry on next use' };
  }
}
