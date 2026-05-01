/**
 * Phase 4 — ephemeral most-recent-calculation store.
 *
 * Per locked spec-owner decisions (rc.100 audit Q4 + Q5): /explain is
 * Web-UI-only and ephemeral. Each chatId / web session has at most one
 * stashed CalculationResult; new results overwrite, no persistence.
 *
 * Server restart clears the map. Stale entries (default 1 hour) are
 * swept opportunistically on every write.
 *
 * Standard-mode results are NOT stashed — the lineage there is just the
 * textbook formula with no assumption metadata to explain. /explain
 * surfaces site_adjusted results where the registry actually contributed.
 */

import type { CalculationResult } from './types.js';

export interface RecentResult {
  metricName: string;
  label: string;
  result: CalculationResult<unknown>;
  recordedAt: number;
}

const recentMap = new Map<string, RecentResult>();
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export function recordRecentResult(
  chatId: string,
  metricName: string,
  label: string,
  result: CalculationResult<unknown>,
): void {
  if (!chatId) return;
  recentMap.set(chatId, {
    metricName,
    label,
    result,
    recordedAt: Date.now(),
  });
  sweepStale();
}

export function getRecentResult(chatId: string): RecentResult | undefined {
  if (!chatId) return undefined;
  const entry = recentMap.get(chatId);
  if (!entry) return undefined;
  if (Date.now() - entry.recordedAt > MAX_AGE_MS) {
    recentMap.delete(chatId);
    return undefined;
  }
  return entry;
}

export function clearRecentResult(chatId: string): boolean {
  if (!chatId) return false;
  return recentMap.delete(chatId);
}

/** Test seam — clear everything. Not for production use. */
export function _clearAllRecentResults(): void {
  recentMap.clear();
}

function sweepStale(): void {
  const now = Date.now();
  for (const [key, entry] of recentMap.entries()) {
    if (now - entry.recordedAt > MAX_AGE_MS) {
      recentMap.delete(key);
    }
  }
}
