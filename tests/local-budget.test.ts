/**
 * Pipeline surgery Task 6 — token-budget backstop on the local (Ollama) path.
 *
 * `capHistoryToBudget` drops the oldest history messages first until
 * system + history fits maxInputTokens, but never drops the last message
 * (the current user turn). It must not mutate the input `history` array —
 * callers pass the live per-chat history, and this function is applied
 * before the agentic loop starts to cap what the first iteration sends.
 */
import { describe, it, expect } from 'vitest';
import { capHistoryToBudget } from '../src/providers/ollama.js';

const msg = (role: 'user' | 'assistant', chars: number) => ({ role, content: 'x'.repeat(chars) });

describe('local history budget backstop', () => {
  it('drops oldest messages first until history fits', () => {
    const history = [msg('user', 40000), msg('assistant', 40000), msg('user', 400), msg('assistant', 400)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(2);
    expect(kept).toHaveLength(2);
    expect(kept[0].content.length).toBe(400);
  });

  it('never drops the latest user message even if over budget', () => {
    const history = [msg('user', 100000)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it('no-op under budget', () => {
    const history = [msg('user', 400), msg('assistant', 400)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('does not mutate the input history array', () => {
    const history = [msg('user', 40000), msg('assistant', 40000), msg('user', 400), msg('assistant', 400)];
    const originalLength = history.length;
    const originalFirst = history[0];
    capHistoryToBudget(history as never, 2000, 12000);
    expect(history.length).toBe(originalLength);
    expect(history[0]).toBe(originalFirst);
  });
});
