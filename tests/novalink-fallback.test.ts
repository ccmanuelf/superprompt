import { describe, it, expect } from 'vitest';
import {
  shouldFallbackToClaude,
  allDataToolsFailed,
  FALLBACK_DISCLOSURE,
  applyFallbackDisclosure,
  mergeNovalinkStats,
} from '../src/providers/router.js';
import type { AIResponse } from '../src/providers/types.js';

describe('soft fallback', () => {
  it('fallback fires only for failed local responses on pinned turns', () => {
    expect(shouldFallbackToClaude({ pinned: true, response: { text: 'Ollama error: connect ECONNREFUSED', provider: 'ollama', failed: true } })).toBe(true);
    expect(shouldFallbackToClaude({ pinned: true, response: { text: 'all good', provider: 'ollama' } })).toBe(false);
    expect(shouldFallbackToClaude({ pinned: false, response: { text: 'x', provider: 'ollama', failed: true } })).toBe(false);
  });
  it('disclosure is prefixed exactly once', () => {
    const out = applyFallbackDisclosure({ text: 'the answer', provider: 'claude' });
    expect(out.text!.startsWith(FALLBACK_DISCLOSURE)).toBe(true);
    expect(applyFallbackDisclosure(out).text!.match(/⚠️/g)).toHaveLength(1);
  });
});

// Fabrication guard — bridge-down turns must trigger fallback even when
// `failed` never fires (novalink tool errors are data failures, not the
// transport-level failures `failed` is designed to catch).
describe('allDataToolsFailed', () => {
  const base: AIResponse = { text: 'x', provider: 'ollama' };

  it('is false when no novalinkToolStats are present', () => {
    expect(allDataToolsFailed({ ...base })).toBe(false);
  });

  it('is false when calls is 0 (no novalink tools were invoked)', () => {
    expect(allDataToolsFailed({ ...base, novalinkToolStats: { calls: 0, errors: 0 } })).toBe(false);
  });

  it('is false when only some novalink calls errored', () => {
    expect(allDataToolsFailed({ ...base, novalinkToolStats: { calls: 3, errors: 2 } })).toBe(false);
  });

  it('is true when every novalink call errored', () => {
    expect(allDataToolsFailed({ ...base, novalinkToolStats: { calls: 2, errors: 2 } })).toBe(true);
  });
});

describe('composed fallback decision (pinned + failed OR all-data-tools-failed)', () => {
  it('fires when pinned, all novalink tools failed, but the provider-level `failed` flag is false', () => {
    const response: AIResponse = {
      text: 'I looked it up: company 1054 has 12 open shortages.',
      provider: 'ollama',
      failed: false,
      novalinkToolStats: { calls: 2, errors: 2 },
    };
    expect(shouldFallbackToClaude({ pinned: true, response })).toBe(true);
  });

  it('does not fire on an unpinned turn even when all data tools failed', () => {
    const response: AIResponse = {
      text: 'fabricated-looking answer',
      provider: 'ollama',
      failed: false,
      novalinkToolStats: { calls: 2, errors: 2 },
    };
    expect(shouldFallbackToClaude({ pinned: false, response })).toBe(false);
  });

  it('does not fire on a pinned turn with only partial novalink errors', () => {
    const response: AIResponse = {
      text: 'partially degraded but real answer',
      provider: 'ollama',
      failed: false,
      novalinkToolStats: { calls: 3, errors: 1 },
    };
    expect(shouldFallbackToClaude({ pinned: true, response })).toBe(false);
  });
});

// fab-guard fix pass 2 — the rc.75 deliverable retry replaces `response` with
// the retry's response wholesale on success. The turn spans BOTH attempts, so
// discarding attempt 1's novalinkToolStats would launder a bridge outage seen
// on attempt 1 (all novalink_* calls errored) if the retry made no novalink
// calls at all (stats undefined) — allDataToolsFailed would then see no stats
// and never fire, shipping a fabricated report with no disclosure.
describe('mergeNovalinkStats', () => {
  it('attempt1 all-errored + retry no-stats → merged still shows all-errored (fallback fires)', () => {
    const merged = mergeNovalinkStats({ calls: 2, errors: 2 }, undefined);
    expect(merged).toEqual({ calls: 2, errors: 2 });
    expect(allDataToolsFailed({ text: 'x', provider: 'ollama', novalinkToolStats: merged })).toBe(true);
  });

  it('attempt1 stats + retry partial-success → merged is partial, no fallback', () => {
    const merged = mergeNovalinkStats({ calls: 2, errors: 2 }, { calls: 1, errors: 0 });
    expect(merged).toEqual({ calls: 3, errors: 2 });
    expect(allDataToolsFailed({ text: 'x', provider: 'ollama', novalinkToolStats: merged })).toBe(false);
  });

  it('both undefined → undefined', () => {
    expect(mergeNovalinkStats(undefined, undefined)).toBeUndefined();
  });

  it('omits the field (returns undefined) when combined calls is 0', () => {
    expect(mergeNovalinkStats({ calls: 0, errors: 0 }, { calls: 0, errors: 0 })).toBeUndefined();
  });
});
