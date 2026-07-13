/**
 * Forced-local SAM guard plumbing (spec 2026-07-13 §5) — per-turn sam_*
 * call/error counts, derived with the exact same error-shaped-result signal
 * as updateNovalinkStats (rc.129+). The router prepends the UNVERIFIED
 * banner when a forced-local SAM turn has NO samToolStats (zero calls).
 */
import { describe, it, expect } from 'vitest';
import { updateSamStats } from '../src/providers/ollama.js';

describe('updateSamStats', () => {
  const zero = { calls: 0, errors: 0 };

  it('ignores non-sam tools (including novalink_*)', () => {
    expect(updateSamStats(zero, 'web_search', { ok: true })).toEqual({ calls: 0, errors: 0 });
    expect(updateSamStats(zero, 'novalink_query', { error: 'boom' })).toEqual({ calls: 0, errors: 0 });
    expect(updateSamStats(zero, 'generate_document', { __docgen: true })).toEqual({ calls: 0, errors: 0 });
  });

  it('counts sam_* calls and error-shaped results', () => {
    expect(updateSamStats(zero, 'sam_search', { results: [] })).toEqual({ calls: 1, errors: 0 });
    expect(updateSamStats({ calls: 1, errors: 0 }, 'sam_get_analysis', { error: 'HTTP 404: Analysis not found' }))
      .toEqual({ calls: 2, errors: 1 });
    expect(updateSamStats({ calls: 2, errors: 1 }, 'sam_health', { reachable: true })).toEqual({ calls: 3, errors: 1 });
  });

  it('is pure — does not mutate its input', () => {
    const s = { calls: 0, errors: 0 };
    updateSamStats(s, 'sam_export', { __docgen: true, path: '/x' });
    expect(s).toEqual({ calls: 0, errors: 0 });
  });
});
