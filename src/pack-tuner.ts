/**
 * Self-Tuning Pack Weights — learn which packs work best from usage.
 *
 * Tracks tool execution outcomes per pack and adjusts intent scoring
 * weights over time. Packs whose tools succeed more often get boosted;
 * packs whose tools fail get dampened.
 *
 * Inspired by kevinrgu/autoagent's score-driven evolution concept.
 * Applied to pack selection rather than agent improvement.
 *
 * Works identically for both providers — tuning is based on tool outcomes,
 * not which AI provider was used.
 */

import { getDatabase } from './db.js';
import { logger } from './logger.js';
import type { TableInitializer } from './core/interfaces.js';

// ── Types ────────────────────────────────────────────────────

export interface PackWeight {
  packName: string;
  chatId: string;
  successCount: number;
  failureCount: number;
  totalCalls: number;
  weight: number; // 0.5 to 2.0 (1.0 = default)
  lastUpdated: number;
}

// ── Configuration ────────────────────────────────────────────

/** Minimum calls before weight adjusts (prevents overreacting to small samples) */
const MIN_CALLS_FOR_ADJUSTMENT = 5;

/** Weight bounds */
const MIN_WEIGHT = 0.5;
const MAX_WEIGHT = 2.0;
const DEFAULT_WEIGHT = 1.0;

/** How much each success/failure moves the weight */
const SUCCESS_BOOST = 0.05;
const FAILURE_DAMPEN = 0.08; // Failures penalize more than successes reward

// ── Table Initialization ─────────────────────────────────────

export function initPackTunerTables(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pack_weights (
      pack_name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      total_calls INTEGER NOT NULL DEFAULT 0,
      weight REAL NOT NULL DEFAULT 1.0,
      last_updated INTEGER NOT NULL,
      PRIMARY KEY (pack_name, chat_id)
    );
  `);
}

export const packTunerTableInit: TableInitializer = {
  name: 'pack-tuner',
  initTables: initPackTunerTables,
};

// ── Core Functions ───────────────────────────────────────────

/**
 * Record a tool execution outcome for a pack.
 * Called after tool execution — success or failure.
 */
export function recordPackToolOutcome(
  packName: string,
  chatId: string,
  success: boolean,
): void {
  const db = getDatabase();
  const now = Date.now();

  const existing = db.prepare(
    'SELECT success_count, failure_count, total_calls, weight FROM pack_weights WHERE pack_name = ? AND chat_id = ?',
  ).get(packName, chatId) as { success_count: number; failure_count: number; total_calls: number; weight: number } | undefined;

  if (!existing) {
    db.prepare(
      'INSERT INTO pack_weights (pack_name, chat_id, success_count, failure_count, total_calls, weight, last_updated) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).run(packName, chatId, success ? 1 : 0, success ? 0 : 1, DEFAULT_WEIGHT, now);
    return;
  }

  const newSuccess = existing.success_count + (success ? 1 : 0);
  const newFailure = existing.failure_count + (success ? 0 : 1);
  const newTotal = existing.total_calls + 1;

  // Calculate new weight (only after minimum calls)
  let newWeight = existing.weight;
  if (newTotal >= MIN_CALLS_FOR_ADJUSTMENT) {
    if (success) {
      newWeight = Math.min(MAX_WEIGHT, existing.weight + SUCCESS_BOOST);
    } else {
      newWeight = Math.max(MIN_WEIGHT, existing.weight - FAILURE_DAMPEN);
    }
  }

  db.prepare(
    'UPDATE pack_weights SET success_count = ?, failure_count = ?, total_calls = ?, weight = ?, last_updated = ? WHERE pack_name = ? AND chat_id = ?',
  ).run(newSuccess, newFailure, newTotal, newWeight, now, packName, chatId);

  if (newWeight !== existing.weight) {
    logger.debug(
      { pack: packName, chatId, weight: newWeight, total: newTotal, success: newSuccess },
      'Pack weight adjusted',
    );
  }
}

/**
 * Get the tuned weight for a pack + chat.
 * Returns 1.0 (default) if no data or insufficient calls.
 */
export function getPackWeight(packName: string, chatId: string): number {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT weight, total_calls FROM pack_weights WHERE pack_name = ? AND chat_id = ?',
    ).get(packName, chatId) as { weight: number; total_calls: number } | undefined;

    if (!row || row.total_calls < MIN_CALLS_FOR_ADJUSTMENT) return DEFAULT_WEIGHT;
    return row.weight;
  } catch {
    return DEFAULT_WEIGHT;
  }
}

/**
 * Get all pack weights for a chat.
 */
export function getAllPackWeights(chatId: string): PackWeight[] {
  try {
    const db = getDatabase();
    return db.prepare(
      'SELECT pack_name as packName, chat_id as chatId, success_count as successCount, failure_count as failureCount, total_calls as totalCalls, weight, last_updated as lastUpdated FROM pack_weights WHERE chat_id = ? ORDER BY weight DESC',
    ).all(chatId) as PackWeight[];
  } catch {
    return [];
  }
}

/**
 * Apply tuned weights to pack intent scores.
 * Called by scorePackIntent() to boost/dampen packs based on history.
 */
export function applyTunedWeight(baseScore: number, packName: string, chatId: string): number {
  const weight = getPackWeight(packName, chatId);
  return Math.round(baseScore * weight);
}

/**
 * Reset weights for a pack + chat (or all packs for a chat).
 */
export function resetPackWeights(chatId: string, packName?: string): number {
  const db = getDatabase();
  if (packName) {
    const result = db.prepare('DELETE FROM pack_weights WHERE chat_id = ? AND pack_name = ?').run(chatId, packName);
    return result.changes;
  }
  const result = db.prepare('DELETE FROM pack_weights WHERE chat_id = ?').run(chatId);
  return result.changes;
}

/**
 * Format pack weights for display (bilingual).
 */
export function formatPackWeights(weights: PackWeight[]): string {
  if (weights.length === 0) {
    return '[EN] No pack usage data yet. Weights adjust as you use tools.\n[ES] Sin datos de uso de packs aun. Los pesos se ajustan al usar herramientas.';
  }

  const lines = weights.map((w) => {
    const emoji = w.weight > 1.1 ? '📈' : w.weight < 0.9 ? '📉' : '➡️';
    const successRate = w.totalCalls > 0 ? Math.round(w.successCount / w.totalCalls * 100) : 0;
    return `${emoji} **${w.packName}** — weight: ${w.weight.toFixed(2)} (${successRate}% success, ${w.totalCalls} calls)`;
  });

  return [
    '[EN] Pack performance weights (auto-tuned from usage):',
    ...lines,
    '',
    '[ES] Pesos de rendimiento de packs (auto-ajustados por uso):',
    ...lines,
  ].join('\n');
}

/**
 * Determine which pack a tool belongs to.
 *
 * Priority:
 * 1. Explicit packName field on ToolEntry (set during registration)
 * 2. DB lookup for user tools (source_file path contains pack name)
 * 3. null (core builtin, not owned by a pack)
 *
 * CTO feedback (rc.29): replaced hardcoded manufacturing tool set with
 * explicit packName field to prevent drift as packs evolve.
 */
export function getToolPackName(toolName: string, explicitPackName?: string): string | null {
  // 1. Explicit packName from ToolEntry (set during pack registration)
  if (explicitPackName) return explicitPackName;

  // 2. Check DB for user tools from packs (source_file path)
  try {
    const db = getDatabase();
    const tool = db.prepare(
      'SELECT source_file FROM user_tools WHERE name = ?',
    ).get(toolName) as { source_file: string | null } | undefined;

    if (tool?.source_file?.includes('packs/')) {
      const match = tool.source_file.match(/packs\/([^/]+)\//);
      if (match) return match[1];
    }
  } catch {
    // DB not ready
  }

  return null;
}
