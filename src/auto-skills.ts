/**
 * Auto-Generated Skills — Core Engine
 *
 * When a user completes a complex task successfully, clauded offers to save
 * the workflow as a reusable skill. This is how the Jarvis-like assistant
 * learns — as fundamental as memory.
 *
 * Adapted from Hermes Agent's concept: the LLM itself drafts the skill
 * as natural language instructions (system prompts), not generated code.
 *
 * Detection → Extraction → Drafting → Proposal → Approval → Storage
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from './db.js';
import { logger } from './logger.js';
import type { ProviderRouter } from './providers/router.js';
import type { StepResult } from './orchestrator.js';
import type { TableInitializer } from './core/interfaces.js';
import type { Skill } from './db.js';

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

export function initAutoSkillsTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'suggest',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_skill_triggers_skill ON skill_triggers(skill_id);

    CREATE TABLE IF NOT EXISTS skill_proposals (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      proposed_name TEXT NOT NULL,
      proposed_description TEXT NOT NULL,
      proposed_prompt TEXT NOT NULL,
      proposed_tools TEXT,
      proposed_triggers TEXT,
      source_type TEXT NOT NULL,
      source_summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_skill_proposals_chat ON skill_proposals(chat_id);
    CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status);
  `);
}

export const autoSkillsTableInit: TableInitializer = {
  name: 'auto-skills',
  initTables: initAutoSkillsTables,
};

// ── DB Accessors ─────────────────────────────────────────────

export function insertSkillTrigger(skillId: string, pattern: string, mode: string = 'suggest'): void {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO skill_triggers (skill_id, pattern, mode, created_at) VALUES (?, ?, ?, ?)',
  ).run(skillId, pattern, mode, Date.now());
}

export function getSkillTriggers(): Array<{ id: number; skill_id: string; pattern: string; mode: string }> {
  const db = getDatabase();
  return db.prepare('SELECT id, skill_id, pattern, mode FROM skill_triggers').all() as any[];
}

export function getSkillTriggersForSkill(skillId: string): Array<{ pattern: string; mode: string }> {
  const db = getDatabase();
  return db.prepare('SELECT pattern, mode FROM skill_triggers WHERE skill_id = ?').all(skillId) as any[];
}

export function insertSkillProposal(proposal: SkillProposal): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO skill_proposals (id, chat_id, proposed_name, proposed_description, proposed_prompt,
     proposed_tools, proposed_triggers, source_type, source_summary, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    proposal.id, proposal.chatId, proposal.name, proposal.description, proposal.systemPrompt,
    JSON.stringify(proposal.allowedTools), JSON.stringify(proposal.triggerPatterns),
    proposal.sourceType, proposal.sourceSummary, Date.now(),
  );
}

export function getPendingProposal(chatId: string): SkillProposal | null {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT * FROM skill_proposals WHERE chat_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
  ).get(chatId) as any;
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

export function updateProposalStatus(id: string, status: 'approved' | 'rejected' | 'expired'): void {
  const db = getDatabase();
  db.prepare('UPDATE skill_proposals SET status = ? WHERE id = ?').run(status, id);
}

function getRecentProposalCount(chatId: string, windowMs: number): number {
  const db = getDatabase();
  const since = Date.now() - windowMs;
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM skill_proposals WHERE chat_id = ? AND created_at > ?',
  ).get(chatId, since) as { cnt: number };
  return row.cnt;
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
export function detectSkillCandidate(params: {
  toolsUsed: string[];
  stepResults?: StepResult[];
  qualityScore: number;
  chatId: string;
  originalRequest: string;
}): SkillCandidate | null {
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
  const recentCount = getRecentProposalCount(chatId, PROPOSAL_COOLDOWN_MS);
  if (recentCount > 0) {
    logger.debug({ chatId, recentCount }, 'Skill proposal cooldown active');
    return null;
  }

  // Deduplication: check if existing skills overlap significantly
  if (isDuplicateSkill(toolsUsed)) {
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

function isDuplicateSkill(toolsUsed: string[]): boolean {
  const db = getDatabase();
  const skills = db.prepare('SELECT allowed_tools FROM skills WHERE allowed_tools IS NOT NULL').all() as Array<{ allowed_tools: string }>;

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
export function handleProposalResponse(chatId: string, approved: boolean): string {
  const proposal = getPendingProposal(chatId);
  if (!proposal) {
    return '[EN] No pending skill proposal found. [ES] No se encontro una propuesta de habilidad pendiente.';
  }

  if (approved) {
    const skillId = createAutoSkill(proposal);
    updateProposalStatus(proposal.id, 'approved');
    return [
      `[EN] Skill "${proposal.name}" created! It will activate when similar tasks are detected.`,
      `[ES] Habilidad "${proposal.name}" creada! Se activara cuando se detecten tareas similares.`,
    ].join('\n');
  } else {
    updateProposalStatus(proposal.id, 'rejected');
    return [
      `[EN] Skill proposal skipped. I'll remember not to suggest this pattern again.`,
      `[ES] Propuesta de habilidad omitida. Recordare no sugerir este patron de nuevo.`,
    ].join('\n');
  }
}

/**
 * Expire any pending proposals for a chat (when user sends a normal message without responding).
 */
export function expirePendingProposals(chatId: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE skill_proposals SET status = 'expired' WHERE chat_id = ? AND status = 'pending'",
  ).run(chatId);
}

// ── Skill Creation ───────────────────────────────────────────

/**
 * Create an auto-generated skill from an approved proposal.
 * Stores the skill + dynamic trigger patterns + revision.
 */
export function createAutoSkill(proposal: SkillProposal): string {
  const db = getDatabase();
  const skillId = `auto-${proposal.name}`;
  const now = Date.now();

  // Create the skill
  db.prepare(
    `INSERT OR REPLACE INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    skillId, proposal.name, proposal.description, proposal.systemPrompt,
    JSON.stringify(proposal.allowedTools), now, now,
  );

  // Register dynamic trigger patterns
  for (const pattern of proposal.triggerPatterns) {
    try {
      // Validate the regex before storing
      new RegExp(pattern, 'i');
      insertSkillTrigger(skillId, pattern, 'suggest');
    } catch {
      logger.warn({ pattern }, 'Invalid trigger pattern — skipped');
    }
  }

  // Store revision
  db.prepare(
    'INSERT INTO skill_revisions (skill_id, system_prompt, revision_note, created_at) VALUES (?, ?, ?, ?)',
  ).run(skillId, proposal.systemPrompt, 'Auto-generated from workflow', now);

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
    });

    if (!response.text || response.text.length < 50) {
      return { patched: false, summary: 'AI could not generate a meaningful patch' };
    }

    const newPrompt = response.text.trim();
    const db = getDatabase();
    const now = Date.now();

    // Update the skill
    db.prepare('UPDATE skills SET system_prompt = ?, updated_at = ? WHERE id = ?')
      .run(newPrompt, now, skill.id);

    // Store revision
    db.prepare(
      'INSERT INTO skill_revisions (skill_id, system_prompt, revision_note, created_at) VALUES (?, ?, ?, ?)',
    ).run(skill.id, newPrompt, `Self-healed: ${issue.slice(0, 200)}`, now);

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
