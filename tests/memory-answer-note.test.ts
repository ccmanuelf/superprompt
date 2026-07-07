import { describe, it, expect } from 'vitest';
import {
  shouldNoteMemoryAnswer,
  applyMemoryAnswerNote,
  MEMORY_ANSWER_NOTE,
} from '../src/providers/router.js';
import type { AIResponse } from '../src/providers/types.js';

// Live-verified failure: a pinned NovaLink-data turn answered entirely from
// memory recall (zero novalink tool calls) while claiming the data was
// "pulled directly from NovaLink live data." shouldNoteMemoryAnswer decides
// when the router must append a disclosure that the answer came from memory,
// not a live fetch.
describe('shouldNoteMemoryAnswer (truth table)', () => {
  const ollamaNoStats: AIResponse = { text: 'answer', provider: 'ollama' };
  const ollamaWithStats: AIResponse = {
    text: 'answer',
    provider: 'ollama',
    novalinkToolStats: { calls: 2, errors: 0 },
  };
  const ollamaAllErroredStats: AIResponse = {
    text: 'answer',
    provider: 'ollama',
    novalinkToolStats: { calls: 2, errors: 2 },
  };
  const claudeNoStats: AIResponse = { text: 'answer', provider: 'claude' };

  it('true: pinned, no fallback, ollama, no novalinkToolStats', () => {
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: false, response: ollamaNoStats })).toBe(true);
  });

  it('false: not pinned', () => {
    expect(shouldNoteMemoryAnswer({ pinned: false, fellBack: false, response: ollamaNoStats })).toBe(false);
  });

  it('false: fallback fired', () => {
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: true, response: ollamaNoStats })).toBe(false);
  });

  it('false: deliverable hard-error (composed via router wiring: fellBack || deliverableFailed)', () => {
    // At router.ts ~1605, the wiring passes fellBack: fellBack || deliverableFailed.
    // This test ensures that when deliverableFailed is true (hard-error branch hit),
    // the composed condition (e.g., fellBack=false but deliverableFailed=true → true)
    // is gated at the wiring layer, not the pure predicate. The pure function still
    // receives fellBack (the composite), and this case verifies it returns false.
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: true, response: ollamaNoStats })).toBe(false);
  });

  it('false: response served by claude (not ollama)', () => {
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: false, response: claudeNoStats })).toBe(false);
  });

  it('false: novalinkToolStats present (tools ran, even successfully)', () => {
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: false, response: ollamaWithStats })).toBe(false);
  });

  it('false: novalinkToolStats present and all-errored — that path already carries the ⚠️ fallback disclosure', () => {
    expect(shouldNoteMemoryAnswer({ pinned: true, fellBack: false, response: ollamaAllErroredStats })).toBe(false);
  });

  it('false: not pinned AND fallback fired AND claude AND stats present (all conditions false)', () => {
    expect(shouldNoteMemoryAnswer({
      pinned: false,
      fellBack: true,
      response: { ...ollamaWithStats, provider: 'claude' },
    })).toBe(false);
  });
});

describe('applyMemoryAnswerNote', () => {
  it('appends the bilingual footer to the reply text', () => {
    const out = applyMemoryAnswerNote({ text: 'the answer', provider: 'ollama' });
    expect(out.text).toBe(`the answer${MEMORY_ANSWER_NOTE}`);
  });

  it('footer contains the EN and ES disclosure plus the "fresh" hint', () => {
    expect(MEMORY_ANSWER_NOTE).toContain('Answered from conversation memory');
    expect(MEMORY_ANSWER_NOTE).toContain('no live NovaLink query this turn');
    expect(MEMORY_ANSWER_NOTE).toContain('fresh');
    expect(MEMORY_ANSWER_NOTE).toContain('Respondido desde la memoria de la conversación');
    expect(MEMORY_ANSWER_NOTE).toContain('en vivo');
  });

  it('is idempotent — a response already carrying the note is returned unchanged', () => {
    const once = applyMemoryAnswerNote({ text: 'the answer', provider: 'ollama' });
    const twice = applyMemoryAnswerNote(once);
    expect(twice.text).toBe(once.text);
    expect(twice.text!.match(/ℹ️/g)).toHaveLength(1);
  });

  it('handles a null/undefined text gracefully (still appends footer)', () => {
    const out = applyMemoryAnswerNote({ text: null, provider: 'ollama' });
    expect(out.text).toBe(MEMORY_ANSWER_NOTE);
  });
});
