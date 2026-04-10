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

import { getKnex } from './db-knex.js';
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

export async function initPackTunerTables(): Promise<void> {
  const db = getKnex();
  const exists = await db.schema.hasTable('pack_weights');
  if (!exists) {
    await db.schema.createTable('pack_weights', (t) => {
      t.text('pack_name').notNullable();
      t.text('chat_id').notNullable();
      t.integer('success_count').notNullable().defaultTo(0);
      t.integer('failure_count').notNullable().defaultTo(0);
      t.integer('total_calls').notNullable().defaultTo(0);
      t.float('weight').notNullable().defaultTo(1.0);
      t.integer('last_updated').notNullable();
      t.primary(['pack_name', 'chat_id']);
    });
  }
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
export async function recordPackToolOutcome(
  packName: string,
  chatId: string,
  success: boolean,
): Promise<void> {
  const db = getKnex();
  const now = Date.now();

  const existing = await db('pack_weights')
    .where({ pack_name: packName, chat_id: chatId })
    .select('success_count', 'failure_count', 'total_calls', 'weight')
    .first() as { success_count: number; failure_count: number; total_calls: number; weight: number } | undefined;

  if (!existing) {
    await db('pack_weights').insert({
      pack_name: packName,
      chat_id: chatId,
      success_count: success ? 1 : 0,
      failure_count: success ? 0 : 1,
      total_calls: 1,
      weight: DEFAULT_WEIGHT,
      last_updated: now,
    });
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

  await db('pack_weights')
    .where({ pack_name: packName, chat_id: chatId })
    .update({
      success_count: newSuccess,
      failure_count: newFailure,
      total_calls: newTotal,
      weight: newWeight,
      last_updated: now,
    });

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
export async function getPackWeight(packName: string, chatId: string): Promise<number> {
  try {
    const db = getKnex();
    const row = await db('pack_weights')
      .where({ pack_name: packName, chat_id: chatId })
      .select('weight', 'total_calls')
      .first() as { weight: number; total_calls: number } | undefined;

    if (!row || row.total_calls < MIN_CALLS_FOR_ADJUSTMENT) return DEFAULT_WEIGHT;
    return row.weight;
  } catch {
    return DEFAULT_WEIGHT;
  }
}

/**
 * Get all pack weights for a chat.
 */
export async function getAllPackWeights(chatId: string): Promise<PackWeight[]> {
  try {
    const db = getKnex();
    return await db('pack_weights')
      .where('chat_id', chatId)
      .orderBy('weight', 'desc')
      .select(
        db.ref('pack_name').as('packName'),
        db.ref('chat_id').as('chatId'),
        db.ref('success_count').as('successCount'),
        db.ref('failure_count').as('failureCount'),
        db.ref('total_calls').as('totalCalls'),
        'weight',
        db.ref('last_updated').as('lastUpdated'),
      ) as PackWeight[];
  } catch {
    return [];
  }
}

/**
 * Apply tuned weights to pack intent scores.
 * Called by scorePackIntent() to boost/dampen packs based on history.
 */
export async function applyTunedWeight(baseScore: number, packName: string, chatId: string): Promise<number> {
  const weight = await getPackWeight(packName, chatId);
  return Math.round(baseScore * weight);
}

/**
 * Reset weights for a pack + chat (or all packs for a chat).
 */
export async function resetPackWeights(chatId: string, packName?: string): Promise<number> {
  const db = getKnex();
  if (packName) {
    return db('pack_weights').where({ chat_id: chatId, pack_name: packName }).del();
  }
  return db('pack_weights').where('chat_id', chatId).del();
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
export async function getToolPackName(toolName: string, explicitPackName?: string): Promise<string | null> {
  // 1. Explicit packName from ToolEntry (set during pack registration)
  if (explicitPackName) return explicitPackName;

  // 2. Check DB for user tools from packs (source_file path)
  try {
    const db = getKnex();
    const tool = await db('user_tools')
      .where('name', toolName)
      .select('source_file')
      .first() as { source_file: string | null } | undefined;

    if (tool?.source_file?.includes('packs/')) {
      const match = tool.source_file.match(/packs\/([^/]+)\//);
      if (match) return match[1];
    }
  } catch {
    // DB not ready
  }

  return null;
}
