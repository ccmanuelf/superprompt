import type { Tool } from 'ollama';
import { insertMemory } from '../../db.js';

export const saveMemoryDefinition: Tool = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      'Save an important fact or piece of information to long-term memory. Use when the user tells you something important about themselves, their preferences, or facts they want you to remember.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember',
        },
        sector: {
          type: 'string',
          enum: ['semantic', 'episodic'],
          description:
            'Type: semantic for facts/preferences, episodic for events/conversations',
        },
      },
      required: ['content'],
    },
  },
};

export function saveMemory(
  args: { content: string; sector?: string },
  chatId: string,
): Record<string, string | number> {
  const sector =
    args.sector === 'episodic' ? 'episodic' : 'semantic';

  const id = insertMemory(chatId, args.content, sector);
  return {
    saved: 'true',
    id,
    sector,
    content: args.content,
  };
}
