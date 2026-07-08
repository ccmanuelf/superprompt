import { describe, it, expect } from 'vitest';
import { formatMemoryBlock } from '../src/memory.js';

// Live cross-part contamination bug (2026-07-07 20:44 turn): the local model
// fetched fresh QUANTITIES for part FSZ3A55D3008I31 but decorated the answer
// with ANOTHER part's description recalled from memory ("Thinsulate" —
// belongs to WSCS150-US), presenting it as one coherent live answer.
// formatMemoryBlock's framing header must warn the model that retrieved
// memory lines may describe a different identifier than the one in question.
describe('formatMemoryBlock — attribute provenance warning (live bug 2026-07-07)', () => {
  it('returns empty string for no lines', () => {
    expect(formatMemoryBlock([])).toBe('');
  });

  it('opens with the [RETRIEVED MEMORY ...] header (unchanged prefix, relied on by db-core cleanup LIKE query)', () => {
    const block = formatMemoryBlock(['- some memory line (semantic)']);
    expect(block.startsWith('[RETRIEVED MEMORY')).toBe(true);
  });

  it('includes a warning that memory lines may describe OTHER identifiers than the current question', () => {
    const block = formatMemoryBlock(['- WSCS150-US: Thinsulate insulation (semantic)']);
    expect(block).toContain('may describe OTHER parts/orders than the current question');
    expect(block).toContain('never copy attributes across identifiers');
  });

  it('closes with [END MEMORY] and preserves the memory lines verbatim in between', () => {
    const block = formatMemoryBlock(['- line one (semantic)', '- line two (episodic)']);
    expect(block).toContain('- line one (semantic)');
    expect(block).toContain('- line two (episodic)');
    expect(block.endsWith('[END MEMORY]')).toBe(true);
    // Warning line must appear before the actual memory content, not after.
    expect(block.indexOf('never copy attributes across identifiers')).toBeLessThan(block.indexOf('- line one'));
  });
});
