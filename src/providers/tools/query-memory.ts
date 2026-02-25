import type { Tool } from 'ollama';
import { searchMemories, getRecentMemories, type Memory } from '../../db.js';

export const queryMemoryDefinition: Tool = {
  type: 'function',
  function: {
    name: 'query_memory',
    description:
      'Search stored memories for relevant information. Use when the user asks about something you might have discussed before or when you need context about past conversations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for memories',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 5)',
        },
      },
      required: ['query'],
    },
  },
};

function formatMemory(m: Memory): string {
  const age = Math.round((Date.now() - m.created_at) / (1000 * 60 * 60 * 24));
  return `[${m.sector}] (${age}d ago, salience: ${m.salience.toFixed(2)}) ${m.content}`;
}

export function queryMemory(
  args: { query: string; limit?: number },
  chatId: string,
): Record<string, string | string[]> {
  const limit = args.limit ?? 5;

  try {
    // Try FTS5 search first
    let memories = searchMemories(chatId, args.query, limit);

    // Fall back to recent memories if FTS5 returns nothing
    if (memories.length === 0) {
      memories = getRecentMemories(chatId, limit);
    }

    if (memories.length === 0) {
      return { result: 'No memories found for this query.' };
    }

    return {
      memories: memories.map(formatMemory),
    };
  } catch {
    // FTS5 match can fail on malformed queries — fall back to recent
    const memories = getRecentMemories(chatId, limit);
    if (memories.length === 0) {
      return { result: 'No memories found.' };
    }
    return { memories: memories.map(formatMemory) };
  }
}
