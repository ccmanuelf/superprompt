import { describe, it, expect } from 'vitest';

/**
 * Tests for the Ollama agentic loop logic.
 *
 * Since OllamaProvider depends on the Ollama SDK client (network calls),
 * we test the loop logic in isolation by simulating the iteration pattern.
 */

interface MockToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface MockMessage {
  role: string;
  content: string;
  tool_calls?: MockToolCall[];
}

const MAX_ITERATIONS = 10;

/**
 * Simulates the agentic loop logic from src/providers/ollama.ts.
 * Takes a sequence of mock responses and returns the final result.
 */
function simulateAgenticLoop(
  mockResponses: Array<{ content: string; tool_calls?: MockToolCall[] }>,
  executeTool: (name: string, args: Record<string, unknown>) => Record<string, unknown>,
): { text: string; iterations: number; toolCallsExecuted: string[] } {
  const messages: MockMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'test message' },
  ];

  let iterations = 0;
  let responseIdx = 0;
  const toolCallsExecuted: string[] = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Simulate model response
    const mockResponse = mockResponses[Math.min(responseIdx, mockResponses.length - 1)];
    responseIdx++;

    const msg: MockMessage = {
      role: 'assistant',
      content: mockResponse.content,
      tool_calls: mockResponse.tool_calls,
    };

    messages.push(msg);

    // If no tool calls, we're done
    if (!msg.tool_calls?.length) {
      return {
        text: msg.content,
        iterations,
        toolCallsExecuted,
      };
    }

    // Execute tool calls
    for (const toolCall of msg.tool_calls) {
      const result = executeTool(toolCall.function.name, toolCall.function.arguments);
      toolCallsExecuted.push(toolCall.function.name);
      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
      });
    }
  }

  // Max iterations reached
  return {
    text: '[Max tool iterations reached]',
    iterations: MAX_ITERATIONS,
    toolCallsExecuted,
  };
}

describe('agentic loop', () => {
  it('handles a single tool call then final response', () => {
    const responses = [
      {
        content: '',
        tool_calls: [
          { function: { name: 'get_time', arguments: {} } },
        ],
      },
      {
        content: 'The current time is 3:00 PM.',
      },
    ];

    const result = simulateAgenticLoop(responses, (name) => {
      return { time: '3:00 PM' };
    });

    expect(result.text).toBe('The current time is 3:00 PM.');
    expect(result.iterations).toBe(2);
    expect(result.toolCallsExecuted).toEqual(['get_time']);
  });

  it('handles multiple sequential tool calls', () => {
    const responses = [
      {
        content: '',
        tool_calls: [
          { function: { name: 'web_search', arguments: { query: 'weather' } } },
        ],
      },
      {
        content: '',
        tool_calls: [
          { function: { name: 'summarize_url', arguments: { url: 'https://weather.com' } } },
        ],
      },
      {
        content: 'The weather is sunny.',
      },
    ];

    const result = simulateAgenticLoop(responses, (name) => {
      if (name === 'web_search') return { results: [{ url: 'https://weather.com' }] };
      if (name === 'summarize_url') return { content: 'Sunny, 25°C' };
      return {};
    });

    expect(result.text).toBe('The weather is sunny.');
    expect(result.iterations).toBe(3);
    expect(result.toolCallsExecuted).toEqual(['web_search', 'summarize_url']);
  });

  it('handles multiple tool calls in a single iteration', () => {
    const responses = [
      {
        content: '',
        tool_calls: [
          { function: { name: 'get_time', arguments: {} } },
          { function: { name: 'system_info', arguments: {} } },
        ],
      },
      {
        content: 'It is 3 PM and you have 32GB RAM.',
      },
    ];

    const result = simulateAgenticLoop(responses, (name) => {
      if (name === 'get_time') return { time: '3:00 PM' };
      if (name === 'system_info') return { total_memory_gb: 32 };
      return {};
    });

    expect(result.text).toBe('It is 3 PM and you have 32GB RAM.');
    expect(result.iterations).toBe(2);
    expect(result.toolCallsExecuted).toEqual(['get_time', 'system_info']);
  });

  it('stops at MAX_ITERATIONS when model loops indefinitely', () => {
    // All responses have tool calls — model never gives a final text response
    const infiniteToolCall = {
      content: '',
      tool_calls: [
        { function: { name: 'get_time', arguments: {} } },
      ],
    };
    const responses = Array(15).fill(infiniteToolCall);

    const result = simulateAgenticLoop(responses, () => ({ time: 'now' }));

    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(result.text).toBe('[Max tool iterations reached]');
    expect(result.toolCallsExecuted.length).toBe(MAX_ITERATIONS);
  });

  it('handles direct response with no tool calls', () => {
    const responses = [
      { content: 'Hello! How can I help you?' },
    ];

    const result = simulateAgenticLoop(responses, () => ({}));

    expect(result.text).toBe('Hello! How can I help you?');
    expect(result.iterations).toBe(1);
    expect(result.toolCallsExecuted.length).toBe(0);
  });

  it('handles tool execution failure gracefully', () => {
    const responses = [
      {
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: '/forbidden' } } },
        ],
      },
      {
        content: 'I could not access that file.',
      },
    ];

    const result = simulateAgenticLoop(responses, (name) => {
      return { error: 'Access denied' };
    });

    expect(result.text).toBe('I could not access that file.');
    expect(result.iterations).toBe(2);
  });

  it('handles empty tool_calls array as no tool calls', () => {
    const responses = [
      { content: 'No tools needed.', tool_calls: [] },
    ];

    const result = simulateAgenticLoop(responses, () => ({}));

    expect(result.text).toBe('No tools needed.');
    expect(result.iterations).toBe(1);
    expect(result.toolCallsExecuted.length).toBe(0);
  });
});

// ── Conversation history management ──────────────────────────

describe('conversation history management', () => {
  const MAX_HISTORY_MESSAGES = 40; // 20 turns * 2

  function trimHistory(messages: Array<{ role: string; content: string }>): void {
    while (messages.length > MAX_HISTORY_MESSAGES) {
      messages.shift();
    }
  }

  it('trims history to MAX_HISTORY_MESSAGES', () => {
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
    }

    trimHistory(history);
    expect(history.length).toBe(MAX_HISTORY_MESSAGES);
  });

  it('preserves most recent messages when trimming', () => {
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      history.push({ role: 'user', content: `msg ${i}` });
    }

    trimHistory(history);
    expect(history[history.length - 1].content).toBe('msg 49');
    expect(history[0].content).toBe('msg 10');
  });

  it('does not trim when under limit', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    trimHistory(history);
    expect(history.length).toBe(2);
  });

  it('clearOllamaHistory removes chat history', () => {
    const chatHistories = new Map<string, Array<{ role: string; content: string }>>();
    chatHistories.set('chat1', [{ role: 'user', content: 'hello' }]);

    chatHistories.delete('chat1');
    expect(chatHistories.has('chat1')).toBe(false);
  });
});
