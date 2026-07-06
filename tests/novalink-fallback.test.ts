import { describe, it, expect } from 'vitest';
import { shouldFallbackToClaude, FALLBACK_DISCLOSURE, applyFallbackDisclosure } from '../src/providers/router.js';

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
