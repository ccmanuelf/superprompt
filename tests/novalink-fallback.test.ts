import { describe, it, expect } from 'vitest';
import {
  shouldFallbackToClaude,
  allDataToolsFailed,
  FALLBACK_DISCLOSURE,
  applyFallbackDisclosure,
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
