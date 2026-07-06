/**
 * Pipeline surgery Task 9 — breaker-open failure detection.
 *
 * `lastAssistantText` finds the last *assistant* message with non-empty
 * content, searching backwards. At every real loop exit the trailing
 * message is a `role: 'tool'` message (JSON.stringify'd tool result),
 * which is never empty — so naively reading `messages.at(-1)?.content`
 * always looks "usable" and breaker-open never marks the turn failed.
 * The correct signal is whether the model itself produced usable text.
 */
import { describe, it, expect } from 'vitest';
import { lastAssistantText } from '../src/providers/ollama.js';

const assistant = (content: string, toolCalls = false) => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { tool_calls: [{ function: { name: 'x', arguments: {} } }] } : {}),
});
const tool = (content: string) => ({ role: 'tool', content });

describe('lastAssistantText', () => {
  it('returns null when the loop exits on a tool-result tail with no assistant text', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant('', true),
      tool(JSON.stringify({ status: 'ok' })),
      tool(JSON.stringify({ status: 'confirmation_required' })),
    ];
    expect(lastAssistantText(messages as never)).toBeNull();
  });

  it('finds the last non-empty assistant message even with tool messages after it', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant('here is what I found so far'),
      assistant('', true),
      tool(JSON.stringify({ status: 'ok' })),
    ];
    expect(lastAssistantText(messages as never)).toBe('here is what I found so far');
  });

  it('returns null for an empty message list', () => {
    expect(lastAssistantText([] as never)).toBeNull();
  });

  it('treats whitespace-only assistant content as unusable', () => {
    const messages = [assistant('   \n  ')];
    expect(lastAssistantText(messages as never)).toBeNull();
  });
});
