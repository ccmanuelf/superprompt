/**
 * Fabrication guard — per-turn novalink_* tool-call stats derivation.
 *
 * The agentic loop already inspects each tool result for the `{ error: ... }`
 * shape to increment `toolErrorCount` and steer the model with a recovery
 * note (rc.70, B2). `updateNovalinkStats` reuses that exact signal, scoped
 * to tools named `novalink_*`, so the router can detect "every data-tool
 * call this turn errored" (bridge down) without depending on the
 * transport-level `failed` flag. Extracted as a pure function so the
 * accumulation logic is unit-testable without spinning up the full loop
 * (mirrors how tests/loop-terminal.test.ts unit-tests `lastAssistantText`).
 */
import { describe, it, expect } from 'vitest';
import { updateNovalinkStats } from '../src/providers/ollama.js';

describe('updateNovalinkStats', () => {
  const zero = { calls: 0, errors: 0 };

  it('ignores non-novalink tool calls', () => {
    expect(updateNovalinkStats(zero, 'web_search', { ok: true })).toEqual({ calls: 0, errors: 0 });
    expect(updateNovalinkStats(zero, 'web_search', { error: 'boom' })).toEqual({ calls: 0, errors: 0 });
  });

  it('counts a successful novalink call without incrementing errors', () => {
    expect(updateNovalinkStats(zero, 'novalink_query', { rows: [] })).toEqual({ calls: 1, errors: 0 });
  });

  it('counts a failed novalink call (error-shaped result) as both a call and an error', () => {
    expect(updateNovalinkStats(zero, 'novalink_query', { error: 'bridge unreachable' })).toEqual({ calls: 1, errors: 1 });
  });

  it('accumulates across multiple calls of different novalink tools', () => {
    let stats = zero;
    stats = updateNovalinkStats(stats, 'novalink_list_queries', { queries: [] });
    stats = updateNovalinkStats(stats, 'novalink_query', { error: 'timeout' });
    stats = updateNovalinkStats(stats, 'novalink_health', { error: 'unreachable' });
    expect(stats).toEqual({ calls: 3, errors: 2 });
  });

  it('does not mutate the input stats object (pure)', () => {
    const input = { calls: 1, errors: 1 };
    const result = updateNovalinkStats(input, 'novalink_query', { rows: [] });
    expect(input).toEqual({ calls: 1, errors: 1 });
    expect(result).toEqual({ calls: 2, errors: 1 });
  });

  it('treats a non-object result as a successful call (no error key)', () => {
    expect(updateNovalinkStats(zero, 'novalink_query', null)).toEqual({ calls: 1, errors: 0 });
    expect(updateNovalinkStats(zero, 'novalink_query', 'plain string result')).toEqual({ calls: 1, errors: 0 });
  });
});
