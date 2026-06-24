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
import { config } from './config.js';
import { checkResponseQuality } from './self-monitor.js';
import { ClaudeProvider } from './providers/claude.js';
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

  if (!(await db.schema.hasTable('skill_eval_cases'))) {
    await db.schema.createTable('skill_eval_cases', (t) => {
      t.increments('id').primary();
      t.string('skill_id').notNullable();
      t.text('user_message').notNullable();
      t.text('context_summary').nullable();
      t.integer('expected_signal').notNullable();
      t.string('split').notNullable(); // 'held_in' | 'held_out'
      t.bigInteger('created_at').notNullable();
      t.foreign('skill_id').references('skills.id').onDelete('CASCADE');
      t.index(['skill_id', 'split']);
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

// ── Eval cases (replay set for the self-healing validation gate) ──
// Recorded examples of the skill working. A heal candidate is replayed against
// these before promotion. Capped per (skill, split) to bound replay cost.

/** Max recorded cases per split per skill — FIFO bound on replay cost. */
export const MAX_EVAL_CASES_PER_SPLIT = 10;

export interface SkillEvalCase {
  id: number;
  skill_id: string;
  user_message: string;
  context_summary: string;
  expected_signal: number;
  split: 'held_in' | 'held_out';
  created_at: number;
}

/** Record one replay case, evicting the oldest in its split past the cap. */
export async function recordSkillEvalCase(c: {
  skillId: string;
  userMessage: string;
  contextSummary: string;
  qualityScore: number;
  split: 'held_in' | 'held_out';
}): Promise<void> {
  const db = getKnex();
  await db('skill_eval_cases').insert({
    skill_id: c.skillId,
    user_message: c.userMessage,
    context_summary: c.contextSummary,
    expected_signal: c.qualityScore,
    split: c.split,
    created_at: Date.now(),
  });
  const rows = await db('skill_eval_cases')
    .where({ skill_id: c.skillId, split: c.split })
    .orderBy('id', 'asc')
    .select('id');
  if (rows.length > MAX_EVAL_CASES_PER_SPLIT) {
    const evict = rows.slice(0, rows.length - MAX_EVAL_CASES_PER_SPLIT).map((r) => r.id);
    await db('skill_eval_cases').whereIn('id', evict).del();
  }
}

/** All recorded cases for a skill, oldest first. */
export async function getSkillEvalCases(skillId: string): Promise<SkillEvalCase[]> {
  const db = getKnex();
  return db('skill_eval_cases')
    .where({ skill_id: skillId })
    .orderBy('id', 'asc')
    .select('id', 'skill_id', 'user_message', 'context_summary', 'expected_signal', 'split', 'created_at');
}

/**
 * Capture a known-good interaction as a replay case. Platform-neutral so both
 * Telegram and Matrix call it with one line at their post-response success seam.
 * Only auto-generated skills are healed, so only they accrue a replay set; the
 * first good use seeds held_in, later ones fill held_out (the regression guard).
 */
export async function captureSuccessfulUse(params: {
  skill: Skill;
  userMessage: string;
  responseText: string;
  qualityScore: number;
}): Promise<void> {
  const { skill, userMessage, responseText, qualityScore } = params;
  if (skill.is_builtin || !skill.id.startsWith('auto-')) return;
  if (qualityScore < MIN_QUALITY_SCORE) return; // a gap to fix, not an example to keep
  const existing = await getSkillEvalCases(skill.id);
  const split: 'held_in' | 'held_out' = existing.some((c) => c.split === 'held_in') ? 'held_out' : 'held_in';
  await recordSkillEvalCase({
    skillId: skill.id,
    userMessage,
    contextSummary: responseText.slice(0, 500),
    qualityScore,
    split,
  });
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

interface SkillProposalRow {
  id: string;
  chat_id: string;
  proposed_name: string;
  proposed_description: string;
  proposed_prompt: string;
  proposed_tools: string | null;
  proposed_triggers: string | null;
  source_type: string;
  source_summary: string;
  created_at: number;
  status: string;
}

export async function getPendingProposal(chatId: string): Promise<SkillProposal | null> {
  const db = getKnex();
  const row = (await db('skill_proposals')
    .where({ chat_id: chatId, status: 'pending' })
    .orderBy('created_at', 'desc')
    .first()) as SkillProposalRow | undefined;
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
    await createAutoSkill(proposal);
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

/** Mean quality scores for a candidate/current prompt on each replay split. */
export interface HealScores {
  heldIn: number[];
  heldOut: number[];
}

/** Outcome of the non-regression gate for one heal attempt. */
export interface HealAcceptance {
  promote: boolean;
  deltaIn: number;
  deltaOut: number;
  reason: string;
}

/** mean(candidate) − mean(current); 0 if either side has no cases (no evidence). */
function splitDelta(current: number[], candidate: number[]): number {
  if (current.length === 0 || candidate.length === 0) return 0;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(candidate) - mean(current);
}

/**
 * Self-Harness non-regression rule (paper 2606.09498): a healed candidate
 * prompt is promoted only if it does not regress either split and improves at
 * least one: Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0. An empty split
 * contributes Δ = 0 — it can neither block nor justify a promotion.
 */
export function evaluateHealAcceptance(current: HealScores, candidate: HealScores): HealAcceptance {
  const deltaIn = splitDelta(current.heldIn, candidate.heldIn);
  const deltaOut = splitDelta(current.heldOut, candidate.heldOut);
  const promote = deltaIn >= 0 && deltaOut >= 0 && Math.max(deltaIn, deltaOut) > 0;
  const reason = promote
    ? `promote: Δ_in=${deltaIn}, Δ_out=${deltaOut}`
    : `reject: Δ_in=${deltaIn}, Δ_out=${deltaOut} (rule: Δ_in≥0 ∧ Δ_out≥0 ∧ max>0)`;
  return { promote, deltaIn, deltaOut, reason };
}

/** Scores a response generated under `prompt` for `userMessage` (0–100). */
export type ReplayScorer = (prompt: string, userMessage: string) => Promise<number>;

export interface HealGateResult {
  promote: boolean;
  acceptance: HealAcceptance;
}

async function scoreCases(prompt: string, cases: SkillEvalCase[], scorer: ReplayScorer): Promise<number[]> {
  const scores: number[] = [];
  for (const c of cases) scores.push(await scorer(prompt, c.user_message));
  return scores;
}

/**
 * The validation gate: replay the recorded cases under the current and candidate
 * prompts, apply the non-regression rule, and promote the candidate only if it
 * passes. Persists a structured insight note on BOTH promote and reject (A3) so
 * later heals and the stop-ceiling (A4) can read why prior attempts went the way
 * they did. With no eval coverage, the heal cannot be verified, so it is refused
 * rather than shipped blind.
 */
export async function gateHealCandidate(
  skill: Skill,
  candidatePrompt: string,
  issue: string,
  scorer: ReplayScorer,
): Promise<HealGateResult> {
  const cases = await getSkillEvalCases(skill.id);
  if (cases.length === 0) {
    return {
      promote: false,
      acceptance: { promote: false, deltaIn: 0, deltaOut: 0, reason: 'reject: no eval cases — heal cannot be verified (ungated)' },
    };
  }
  const heldIn = cases.filter((c) => c.split === 'held_in');
  const heldOut = cases.filter((c) => c.split === 'held_out');
  const current: HealScores = {
    heldIn: await scoreCases(skill.system_prompt, heldIn, scorer),
    heldOut: await scoreCases(skill.system_prompt, heldOut, scorer),
  };
  const candidate: HealScores = {
    heldIn: await scoreCases(candidatePrompt, heldIn, scorer),
    heldOut: await scoreCases(candidatePrompt, heldOut, scorer),
  };
  const acceptance = evaluateHealAcceptance(current, candidate);

  const db = getKnex();
  const now = Date.now();
  if (acceptance.promote) {
    await db('skills').where({ id: skill.id }).update({ system_prompt: candidatePrompt, updated_at: now });
  }
  await db('skill_revisions').insert({
    skill_id: skill.id,
    system_prompt: acceptance.promote ? candidatePrompt : skill.system_prompt,
    revision_note: `${acceptance.reason} | issue: ${issue.slice(0, 160)}`,
    created_at: now,
  });
  return { promote: acceptance.promote, acceptance };
}

/** Consecutive gate rejections before auto-healing pauses for manual review. */
export const MAX_CONSECUTIVE_HEAL_REJECTS = 3;

/**
 * Number of consecutive gate rejections at the head of the skill's revision log
 * (most recent first), stopping at the first promotion. A4's stop signal: it
 * reads the structured notes A3 persists, so a skill whose candidates keep
 * losing is detected and paused rather than re-drafted forever.
 */
export async function countConsecutiveHealRejections(skillId: string): Promise<number> {
  const db = getKnex();
  const rows = await db('skill_revisions')
    .where({ skill_id: skillId })
    .orderBy('id', 'desc')
    .select('revision_note');
  let count = 0;
  for (const r of rows) {
    if (/^reject/i.test(String(r.revision_note ?? '').trim())) count++;
    else break;
  }
  return count;
}

const JUDGE_SYSTEM =
  'You are a strict evaluator. Given a user REQUEST and an assistant RESPONSE, '
  + 'rate how well the response satisfies the request. Reply with JSON only: '
  + '{"score": <integer 0-100>} where 100 is a perfect answer and 0 is useless or wrong.';

/** Extract a 0–100 score from the judge reply; null if unparseable. */
function parseJudgeScore(text: string): number | null {
  if (!text) return null;
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) body = fence[1].trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'score' in parsed) {
      const s = Number((parsed as { score: unknown }).score);
      if (Number.isFinite(s)) return Math.max(0, Math.min(100, s));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Production scorer for the heal gate. Generates a response under the given
 * prompt (the router picks the provider — usually the free local model),
 * applies self-monitor as a hard floor (an obviously-broken response scores low
 * regardless of the judge), then — unless HEAL_GATE_GRADER is off — adds a
 * Claude LLM-judge that rates 0–100 how well the response served the request.
 */
export function makeDefaultScorer(router: ProviderRouter, chatId: string): ReplayScorer {
  const judge = new ClaudeProvider();
  return async (prompt: string, userMessage: string): Promise<number> => {
    const gen = await router.sendMessage({
      message: userMessage,
      chatId,
      systemPrompt: prompt,
      skipTools: true,
      skipAutoTrigger: true,
      skipTurnLog: true,
    });
    const quality = checkResponseQuality(gen, userMessage);
    if (!quality.passed) return Math.max(0, quality.score); // broken — floor it, skip the judge
    if (!config.HEAL_GATE_GRADER) return Math.max(0, quality.score);
    try {
      const judged = await judge.sendMessage({
        message: `REQUEST:\n${userMessage}\n\nRESPONSE:\n${gen.text ?? ''}`,
        chatId,
        systemPrompt: JUDGE_SYSTEM,
        skipTools: true,
      });
      return parseJudgeScore(judged.text ?? '') ?? Math.max(0, quality.score);
    } catch (err) {
      logger.debug({ err, skillId: chatId }, 'Heal-gate judge failed — using self-monitor score');
      return Math.max(0, quality.score);
    }
  };
}

/**
 * Heal a skill: draft a candidate prompt, then promote it ONLY if it passes the
 * validation gate (replay recorded cases under the non-regression rule). The
 * `scorer` seam is injectable for tests; production uses makeDefaultScorer.
 *
 * This is the closed loop: use → find gap → draft → verify → promote-or-reject.
 */
export async function healSkill(
  skill: Skill,
  issue: string,
  conversationContext: string,
  router: ProviderRouter,
  chatId: string,
  scorer?: ReplayScorer,
): Promise<{ patched: boolean; summary: string }> {
  // A4 guard 1: nothing to verify against yet — don't draft a candidate we can't gate.
  const evalCases = await getSkillEvalCases(skill.id);
  if (evalCases.length === 0) {
    logger.debug({ skillId: skill.id }, 'Heal skipped — no eval cases to verify against yet');
    return { patched: false, summary: '' };
  }
  // A4 guard 2: candidates keep losing — stop drafting and flag for manual review.
  const consecutiveRejects = await countConsecutiveHealRejections(skill.id);
  if (consecutiveRejects >= MAX_CONSECUTIVE_HEAL_REJECTS) {
    logger.warn(
      { skillId: skill.id, skillName: skill.name, consecutiveRejects },
      'Heal paused — too many consecutive rejected candidates; manual review suggested',
    );
    return { patched: false, summary: '' };
  }

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

    // Validation gate: replay recorded cases and promote only on non-regression.
    const gate = await gateHealCandidate(skill, newPrompt, issue, scorer ?? makeDefaultScorer(router, chatId));

    logger.info(
      { skillId: skill.id, skillName: skill.name, promote: gate.promote, reason: gate.acceptance.reason },
      gate.promote ? 'Skill self-healed (gate passed)' : 'Skill heal candidate rejected by gate',
    );

    if (!gate.promote) {
      return { patched: false, summary: '' }; // rejected — no user-facing claim of improvement
    }
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
