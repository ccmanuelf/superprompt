/**
 * Handler-boundary helpers for the dual-view calculation architecture.
 *
 * Bridges between the request layer (Web UI body / provider tool args /
 * Telegram command text) and the wrapper layer. Keeps each call site
 * tight:
 *
 *   const mode = parseCalcMode(body);
 *   const snapshot = await buildHandlerSnapshot('simulation', mode, chatId);
 *   const result = (await calculateMonteCarloMetrics(inputs, snapshot, mode)).value;
 *
 * Phase 3 sub-rc 2 wiring. The wrappers themselves stay independent of
 * pack-subscription queries and request shape; this layer is what ties
 * them to a real user / active-pack context.
 */

import { buildAssumptionSnapshot } from '../assumptions.js';
import { getEnabledPackNames } from '../packs.js';
import { recordRecentResult } from './recent-results.js';
import type { AssumptionSet, CalculationMode, CalculationResult } from './types.js';

/**
 * Read the desired calculation mode from a request-shaped object (Web UI
 * POST body, provider tool args, etc.). Defaults to 'standard' — only
 * flips to 'site_adjusted' when an explicit flag is present, matching the
 * spec's "Default behavior: return the standard result, with a footnote
 * indicating site-adjusted is available."
 *
 * Accepted forms:
 *   { mode: 'site_adjusted' }
 *   { site_adjusted: true }
 */
export function parseCalcMode(source: unknown): CalculationMode {
  if (!source || typeof source !== 'object') return 'standard';
  const obj = source as Record<string, unknown>;
  if (obj.mode === 'site_adjusted') return 'site_adjusted';
  if (obj.site_adjusted === true) return 'site_adjusted';
  return 'standard';
}

/**
 * Parse the --site-adjusted flag out of a Telegram command's text. Returns
 * the mode and the text with the flag stripped (so command-arg parsers
 * downstream don't need to know the flag exists).
 */
export function parseCalcModeFromText(text: string): {
  mode: CalculationMode;
  cleanText: string;
} {
  const flagPattern = /\s*--site-adjusted\b/g;
  if (flagPattern.test(text)) {
    return {
      mode: 'site_adjusted',
      cleanText: text.replace(flagPattern, '').replace(/\s+/g, ' ').trim(),
    };
  }
  return { mode: 'standard', cleanText: text };
}

/**
 * Stash a calculation result in the ephemeral most-recent-result store
 * (Phase 4 — /explain). Only stashes site_adjusted results — standard-mode
 * lineage has no assumption metadata to surface and would crowd out the
 * actually-interesting calls. No-op for empty chatId.
 */
export function maybeRecordRecent(
  chatId: string,
  metricName: string,
  label: string,
  calcResult: CalculationResult<unknown>,
): void {
  if (calcResult.mode !== 'site_adjusted') return;
  recordRecentResult(chatId, metricName, label, calcResult);
}

/**
 * Build the AssumptionSet bag for a handler call. Wraps
 * buildAssumptionSnapshot with handler-specific context:
 *   - userId: chatId / web session ID
 *   - activePacks: pulled from the pack-subscription system in load order
 *
 * Returns `{}` immediately for standard mode (no DB / pack-query work).
 * Site_adjusted mode does the resolve work once per request.
 */
export async function buildHandlerSnapshot(
  metricName: string,
  mode: CalculationMode,
  chatId: string,
): Promise<AssumptionSet> {
  if (mode === 'standard') return {};
  const activePacks = await getEnabledPackNames(chatId);
  return buildAssumptionSnapshot(metricName, mode, {
    userId: chatId || undefined,
    activePacks,
  });
}
