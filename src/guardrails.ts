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

import { getDatabase } from './db.js';
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

export function initGuardrailsTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS guardrails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('tool_failure', 'user_correction', 'quality_issue', 'manual')),
      context TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guardrails_chat ON guardrails(chat_id);
  `);
}

export const guardrailsTableInit: TableInitializer = {
  name: 'guardrails',
  initTables: initGuardrailsTables,
};

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Add a guardrail for a chat. Deduplicates by content (won't add if identical exists).
 */
export function addGuardrail(
  chatId: string,
  content: string,
  source: Guardrail['source'],
  context: string = '',
): number | null {
  const db = getDatabase();

  // Deduplicate — don't add if very similar guardrail exists
  const existing = db.prepare(
    'SELECT id FROM guardrails WHERE chat_id = ? AND content = ?',
  ).get(chatId, content) as { id: number } | undefined;

  if (existing) return null;

  const result = db.prepare(
    'INSERT INTO guardrails (chat_id, content, source, context, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, content, source, context, Date.now());

  logger.info({ chatId, source, content: content.slice(0, 80) }, 'Guardrail added');
  return result.lastInsertRowid as number;
}

/**
 * Get all guardrails for a chat.
 */
export function getGuardrails(chatId: string): Guardrail[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT id, chat_id as chatId, content, source, context, created_at as createdAt FROM guardrails WHERE chat_id = ? ORDER BY created_at ASC',
  ).all(chatId) as Guardrail[];
}

/**
 * Get global guardrails (chat_id = 'global' — apply to ALL chats).
 */
export function getGlobalGuardrails(): Guardrail[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT id, chat_id as chatId, content, source, context, created_at as createdAt FROM guardrails WHERE chat_id = ? ORDER BY created_at ASC',
  ).all('global') as Guardrail[];
}

/**
 * Remove a guardrail by ID.
 */
export function removeGuardrail(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM guardrails WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Clear all guardrails for a chat.
 */
export function clearGuardrails(chatId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM guardrails WHERE chat_id = ?').run(chatId);
  return result.changes;
}

// ── Context Building ─────────────────────────────────────────

/**
 * Build the guardrails context string for injection into system prompt.
 * Combines chat-specific + global guardrails.
 * Injected at HIGHEST priority — before memory, before skills.
 */
export function buildGuardrailsContext(chatId: string): string {
  const chatGuardrails = getGuardrails(chatId);
  const globalGuardrails = getGlobalGuardrails();
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
export function detectToolFailureGuardrail(
  chatId: string,
  toolName: string,
  args: Record<string, unknown>,
  error: string,
): void {
  // Only create guardrail after 2+ failures with same tool in this session
  // (prevents one-off errors from becoming permanent constraints)
  const db = getDatabase();
  const recentFailures = db.prepare(
    "SELECT COUNT(*) as cnt FROM guardrails WHERE chat_id = ? AND source = 'tool_failure' AND content LIKE ? AND created_at > ?",
  ).get(chatId, `%${toolName}%`, Date.now() - 3600000) as { cnt: number };

  if (recentFailures.cnt > 0) return; // Already have a guardrail for this tool recently

  // Create a concise guardrail
  const argsPreview = JSON.stringify(args).slice(0, 100);
  const content = `Tool "${toolName}" failed with args like ${argsPreview}. Error: ${error.slice(0, 150)}. Consider alternative approaches.`;

  addGuardrail(chatId, content, 'tool_failure', `Tool: ${toolName}`);
}

/**
 * Detect guardrail from user correction (when user says "no, that's wrong").
 * Called from auto-skills correction detection.
 */
export function detectCorrectionGuardrail(
  chatId: string,
  userMessage: string,
  context: string,
): void {
  const content = `User corrected: "${userMessage.slice(0, 200)}". Adjust approach for similar requests.`;
  addGuardrail(chatId, content, 'user_correction', context);
}

/**
 * Detect guardrail from low quality response.
 * Called when self-monitor detects quality < 50.
 */
export function detectQualityGuardrail(
  chatId: string,
  topic: string,
  qualityScore: number,
  issues: string,
): void {
  if (qualityScore >= 50) return; // Only learn from significant failures

  const content = `Responses about "${topic.slice(0, 100)}" scored low (${qualityScore}/100): ${issues.slice(0, 150)}. Use tools for data-driven answers.`;
  addGuardrail(chatId, content, 'quality_issue', `Score: ${qualityScore}`);
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
