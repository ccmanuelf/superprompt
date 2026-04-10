/**
 * Guardrails Memory Sector — permanent learned constraints.
 *
 * Unlike semantic memory (facts) and episodic memory (summaries) which decay
 * over time, guardrails are PERMANENT. They're injected into every interaction
 * at the highest priority to prevent repeating past mistakes.
 *
 * Inspired by iannuttall/ralph's "Signs" pattern — structured accumulated wisdom.
 *
 * Sources of guardrails:
 * 1. Tool failures: "Tool X consistently fails for query type Y"
 * 2. User corrections: "User corrected approach — use method B instead of A"
 * 3. Quality issues: "Responses about topic Z tend to be low quality — use tool first"
 * 4. Manual: User or admin adds a guardrail via /guardrail command
 */

import { getKnex } from './db-knex.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Types ────────────────────────────────────────────────────

export interface Guardrail {
  id: number;
  chatId: string;
  content: string;
  source: 'tool_failure' | 'user_correction' | 'quality_issue' | 'manual';
  context: string;
  createdAt: number;
}

// ── Table Initialization ─────────────────────────────────────

export async function initGuardrailsTables(): Promise<void> {
  const db = getKnex();
  const exists = await db.schema.hasTable('guardrails');
  if (!exists) {
    await db.schema.createTable('guardrails', (t) => {
      t.increments('id').primary();
      t.text('chat_id').notNullable();
      t.text('content').notNullable();
      t.text('source').notNullable();
      t.text('context').notNullable().defaultTo('');
      t.integer('created_at').notNullable();
      t.index(['chat_id'], 'idx_guardrails_chat');
    });
  }
}

export const guardrailsTableInit: TableInitializer = {
  name: 'guardrails',
  initTables: initGuardrailsTables,
};

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Add a guardrail for a chat. Deduplicates by content (won't add if identical exists).
 */
export async function addGuardrail(
  chatId: string,
  content: string,
  source: Guardrail['source'],
  context: string = '',
): Promise<number | null> {
  const db = getKnex();

  // Deduplicate — don't add if very similar guardrail exists
  const existing = await db('guardrails')
    .where({ chat_id: chatId, content })
    .select('id')
    .first();

  if (existing) return null;

  const [result] = await db('guardrails').insert({
    chat_id: chatId,
    content,
    source,
    context,
    created_at: Date.now(),
  });

  logger.info({ chatId, source, content: content.slice(0, 80) }, 'Guardrail added');
  return result as number;
}

/**
 * Get all guardrails for a chat.
 */
export async function getGuardrails(chatId: string): Promise<Guardrail[]> {
  const db = getKnex();
  return db('guardrails')
    .where('chat_id', chatId)
    .orderBy('created_at', 'asc')
    .select(
      'id',
      db.ref('chat_id').as('chatId'),
      'content',
      'source',
      'context',
      db.ref('created_at').as('createdAt'),
    ) as Promise<Guardrail[]>;
}

/**
 * Get global guardrails (chat_id = 'global' — apply to ALL chats).
 */
export async function getGlobalGuardrails(): Promise<Guardrail[]> {
  const db = getKnex();
  return db('guardrails')
    .where('chat_id', 'global')
    .orderBy('created_at', 'asc')
    .select(
      'id',
      db.ref('chat_id').as('chatId'),
      'content',
      'source',
      'context',
      db.ref('created_at').as('createdAt'),
    ) as Promise<Guardrail[]>;
}

/**
 * Remove a guardrail by ID.
 */
export async function removeGuardrail(id: number): Promise<boolean> {
  const db = getKnex();
  const count = await db('guardrails').where('id', id).del();
  return count > 0;
}

/**
 * Clear all guardrails for a chat.
 */
export async function clearGuardrails(chatId: string): Promise<number> {
  const db = getKnex();
  return db('guardrails').where('chat_id', chatId).del();
}

// ── Context Building ─────────────────────────────────────────

/**
 * Build the guardrails context string for injection into system prompt.
 * Combines chat-specific + global guardrails.
 * Injected at HIGHEST priority — before memory, before skills.
 */
export async function buildGuardrailsContext(chatId: string): Promise<string> {
  const chatGuardrails = await getGuardrails(chatId);
  const globalGuardrails = await getGlobalGuardrails();
  const all = [...globalGuardrails, ...chatGuardrails];

  if (all.length === 0) return '';

  const lines = all.map((g) => {
    const sourceLabel = {
      tool_failure: 'Tool lesson',
      user_correction: 'User preference',
      quality_issue: 'Quality note',
      manual: 'Rule',
    }[g.source];
    return `- [${sourceLabel}] ${g.content}`;
  });

  return `[GUARDRAILS — permanent learned constraints. ALWAYS follow these.]\n${lines.join('\n')}\n[END GUARDRAILS]`;
}

// ── Auto-Detection ───────────────────────────────────────────

/**
 * Detect guardrail-worthy events from tool execution results.
 * Called after tool execution — learns from failures.
 */
export async function detectToolFailureGuardrail(
  chatId: string,
  toolName: string,
  args: Record<string, unknown>,
  error: string,
): Promise<void> {
  // Only create guardrail after 2+ failures with same tool in this session
  // (prevents one-off errors from becoming permanent constraints)
  const db = getKnex();
  const result = await db('guardrails')
    .where('chat_id', chatId)
    .where('source', 'tool_failure')
    .where('content', 'like', `%${toolName}%`)
    .where('created_at', '>', Date.now() - 3600000)
    .count('* as cnt')
    .first() as { cnt: number } | undefined;

  if (result && result.cnt > 0) return; // Already have a guardrail for this tool recently

  // Create a concise guardrail
  const argsPreview = JSON.stringify(args).slice(0, 100);
  const content = `Tool "${toolName}" failed with args like ${argsPreview}. Error: ${error.slice(0, 150)}. Consider alternative approaches.`;

  await addGuardrail(chatId, content, 'tool_failure', `Tool: ${toolName}`);
}

/**
 * Detect guardrail from user correction (when user says "no, that's wrong").
 * Called from auto-skills correction detection.
 */
export async function detectCorrectionGuardrail(
  chatId: string,
  userMessage: string,
  context: string,
): Promise<void> {
  const content = `User corrected: "${userMessage.slice(0, 200)}". Adjust approach for similar requests.`;
  await addGuardrail(chatId, content, 'user_correction', context);
}

/**
 * Detect guardrail from low quality response.
 * Called when self-monitor detects quality < 50.
 */
export async function detectQualityGuardrail(
  chatId: string,
  topic: string,
  qualityScore: number,
  issues: string,
): Promise<void> {
  if (qualityScore >= 50) return; // Only learn from significant failures

  const content = `Responses about "${topic.slice(0, 100)}" scored low (${qualityScore}/100): ${issues.slice(0, 150)}. Use tools for data-driven answers.`;
  await addGuardrail(chatId, content, 'quality_issue', `Score: ${qualityScore}`);
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format guardrails list for display (bilingual).
 */
export function formatGuardrailsList(guardrails: Guardrail[]): string {
  if (guardrails.length === 0) {
    return '[EN] No guardrails set. Guardrails are permanent rules learned from experience.\n[ES] Sin guardrails configurados. Los guardrails son reglas permanentes aprendidas de la experiencia.';
  }

  const lines = guardrails.map((g) => {
    const emoji = { tool_failure: '🔧', user_correction: '👤', quality_issue: '📊', manual: '📌' }[g.source];
    const date = new Date(g.createdAt).toLocaleDateString();
    return `${emoji} #${g.id} [${g.source}] ${g.content.slice(0, 120)} (${date})`;
  });

  return [
    '[EN] Active guardrails (permanent learned constraints):',
    ...lines,
    '',
    '[ES] Guardrails activos (restricciones permanentes aprendidas):',
    ...lines,
  ].join('\n');
}
