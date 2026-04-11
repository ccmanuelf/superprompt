import type { Tool } from 'ollama';
import { searchMemories, getRecentMemories, vectorSearchMemories, type Memory } from '../../db-core.js';
import { generateEmbedding } from '../../embeddings.js';

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

export async function queryMemory(
  args: { query: string; limit?: number },
  chatId: string,
): Promise<Record<string, string | string[]>> {
  const limit = args.limit ?? 5;

  try {
    // FTS5 keyword search
    let ftsMemories: Memory[] = [];
    try {
      ftsMemories = await searchMemories(chatId, args.query, limit);
    } catch {
      // FTS5 match can fail on malformed queries
    }

    // Vector similarity search
    let vecMemories: Memory[] = [];
    try {
      const embedding = await generateEmbedding(args.query);
      if (embedding) {
        vecMemories = await vectorSearchMemories(chatId, embedding, limit);
      }
    } catch {
      // Embedding/vector search failure is non-critical
    }

    // Merge and deduplicate
    const seen = new Set<number>();
    const combined: Memory[] = [];
    for (const m of [...ftsMemories, ...vecMemories]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        combined.push(m);
      }
    }

    // Fall back to recent memories if both searches return nothing
    if (combined.length === 0) {
      const recent = await getRecentMemories(chatId, limit);
      if (recent.length === 0) {
        return { result: 'No memories found for this query.' };
      }
      return { memories: recent.map(formatMemory) };
    }

    return {
      memories: combined.slice(0, limit).map(formatMemory),
    };
  } catch {
    // Complete fallback to recent
    const memories = await getRecentMemories(chatId, limit);
    if (memories.length === 0) {
      return { result: 'No memories found.' };
    }
    return { memories: memories.map(formatMemory) };
  }
}
