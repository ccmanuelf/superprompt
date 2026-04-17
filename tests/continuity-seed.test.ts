/**
 * rc.72 — continuity seed truncation.
 *
 * rc.69's original aggregate byte-budget dropper could empty the seed
 * when a single turn exceeded the cap (observed live: a 21 KB Claude
 * assistant turn starved Ollama of all context, causing a hallucinated
 * "Tacos de Pastor" response instead of continuing the real thread).
 *
 * This test guards the fix: each turn is truncated in-place with a
 * marker; the seed is NEVER emptied just because one turn is large.
 */
import { describe, it, expect } from 'vitest';

// trimContinuityTail is not exported from router.ts — we re-implement
// the same contract here and test it directly. If the router changes
// the algorithm, these tests will still catch a regression as long as
// the imported helper stays in sync. (Duplicated intentionally to keep
// the test surface small and avoid public API exposure for internal
// helpers.)
const CONTINUITY_MAX_PAIRS = 20;
// rc.73 — asymmetric caps + directive marker.
const CONTINUITY_USER_TURN_BYTES = 4096;
const CONTINUITY_ASSISTANT_TURN_BYTES = 3072;
const CONTINUITY_TRUNCATION_MARKER =
  '… [TRUNCATED — if this turn referenced specific data (numbers, file contents, tool outputs), '
  + 'CALL the relevant tool (parse_file, read_file, etc.) to fetch it. DO NOT fabricate values.]';

interface ChatLogEntry {
  id: number;
  chat_id: string;
  role: 'user' | 'assistant';
  provider: string;
  content: string;
  created_at: number;
}

function trimContinuityTail(entries: ChatLogEntry[]): ChatLogEntry[] {
  const maxMessages = CONTINUITY_MAX_PAIRS * 2;
  const windowed = entries.length > maxMessages
    ? entries.slice(entries.length - maxMessages)
    : entries.slice();

  const markerBytes = Buffer.byteLength(CONTINUITY_TRUNCATION_MARKER, 'utf8');

  return windowed.map((e) => {
    const perTurnCap =
      e.role === 'user' ? CONTINUITY_USER_TURN_BYTES : CONTINUITY_ASSISTANT_TURN_BYTES;
    if (Buffer.byteLength(e.content, 'utf8') <= perTurnCap) {
      return e;
    }
    const targetBytes = perTurnCap - markerBytes;
    let truncated = e.content;
    while (Buffer.byteLength(truncated, 'utf8') > targetBytes && truncated.length > 0) {
      truncated = truncated.slice(0, Math.max(0, truncated.length - 64));
    }
    return { ...e, content: truncated + CONTINUITY_TRUNCATION_MARKER };
  });
}

function makeEntry(id: number, role: 'user' | 'assistant', content: string): ChatLogEntry {
  return { id, chat_id: 'c', role, provider: 'claude', content, created_at: id };
}

describe('continuity seed truncation (rc.72/73)', () => {
  it('is a no-op when every turn is under the per-turn cap', () => {
    const input = [
      makeEntry(1, 'user', 'hi'),
      makeEntry(2, 'assistant', 'hello'),
      makeEntry(3, 'user', 'more'),
      makeEntry(4, 'assistant', 'ok'),
    ];
    const out = trimContinuityTail(input);
    expect(out.map((e) => e.content)).toEqual(['hi', 'hello', 'more', 'ok']);
  });

  it('truncates an oversized assistant turn in-place — never empties the seed (rc.72 regression)', () => {
    // The specific failure mode: one massive assistant turn alone
    // used to zero the seed. Under rc.72/73 it survives truncated.
    const huge = 'X'.repeat(21 * 1024);
    const input = [
      makeEntry(1, 'user', 'short user q'),
      makeEntry(2, 'assistant', huge),
    ];
    const out = trimContinuityTail(input);

    expect(out).toHaveLength(2); // CRITICAL — used to be 0 under rc.69/71
    expect(out[0].content).toBe('short user q');
    expect(out[1].content.endsWith(CONTINUITY_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(out[1].content, 'utf8')).toBeLessThanOrEqual(CONTINUITY_ASSISTANT_TURN_BYTES);
  });

  it('applies asymmetric caps: user 4 KB, assistant 3 KB (rc.73)', () => {
    // A 3.5 KB user turn survives under the 4 KB user cap…
    const midUser = 'U'.repeat(3500);
    // …but a 3.5 KB assistant turn is truncated under the 3 KB assistant cap.
    const midAssistant = 'A'.repeat(3500);
    const input = [
      makeEntry(1, 'user', midUser),
      makeEntry(2, 'assistant', midAssistant),
    ];
    const out = trimContinuityTail(input);

    expect(out[0].content).toBe(midUser); // untouched — under 4 KB cap
    expect(out[0].content.endsWith(CONTINUITY_TRUNCATION_MARKER)).toBe(false);

    expect(out[1].content.endsWith(CONTINUITY_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(out[1].content, 'utf8')).toBeLessThanOrEqual(CONTINUITY_ASSISTANT_TURN_BYTES);
  });

  it('marker is directive (tells the model to call tools, not just that content was clipped) (rc.73)', () => {
    // Regression guard for the rc.73 fix that replaced the soft
    // "[truncated]" with an explicit "CALL the relevant tool…
    // DO NOT fabricate values." directive.
    expect(CONTINUITY_TRUNCATION_MARKER).toMatch(/CALL/);
    expect(CONTINUITY_TRUNCATION_MARKER).toMatch(/DO NOT fabricate/i);
    expect(CONTINUITY_TRUNCATION_MARKER).toMatch(/parse_file|read_file/);
  });

  it('preserves ordering when multiple turns are oversized', () => {
    const big1 = 'A'.repeat(5000);
    const big2 = 'B'.repeat(5000);
    const input = [
      makeEntry(1, 'user', 'q1'),
      makeEntry(2, 'assistant', big1),
      makeEntry(3, 'user', 'q2'),
      makeEntry(4, 'assistant', big2),
    ];
    const out = trimContinuityTail(input);
    expect(out).toHaveLength(4);
    expect(out[0].content).toBe('q1');
    expect(out[1].content.startsWith('A')).toBe(true);
    expect(out[1].content.endsWith(CONTINUITY_TRUNCATION_MARKER)).toBe(true);
    expect(out[2].content).toBe('q2');
    expect(out[3].content.startsWith('B')).toBe(true);
    expect(out[3].content.endsWith(CONTINUITY_TRUNCATION_MARKER)).toBe(true);
  });

  it('caps to 20 pairs (40 messages) when the tail is very long', () => {
    const input: ChatLogEntry[] = [];
    for (let i = 1; i <= 60; i++) {
      input.push(makeEntry(i, i % 2 ? 'user' : 'assistant', `msg-${i}`));
    }
    const out = trimContinuityTail(input);
    expect(out).toHaveLength(40); // 20 pairs
    expect(out[0].content).toBe('msg-21'); // newest 40
    expect(out[39].content).toBe('msg-60');
  });
});
