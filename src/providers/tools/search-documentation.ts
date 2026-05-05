import type { Tool } from 'ollama';
import { searchDocumentation } from '../../doc-awareness.js';

export const searchDocumentationDefinition: Tool = {
  type: 'function',
  function: {
    name: 'search_documentation',
    description:
      'Search Luna documentation (docs/* and reference/*) for a phrase. Returns up to 15 matched '
      + 'lines with their nearest heading and ±1 line of context. Use this for open-ended "how do I…" '
      + 'questions when you do not already know which document to consult. Case-insensitive substring '
      + 'match — no regex syntax in the query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search phrase (case-insensitive substring, max 200 chars).',
        },
        max: {
          type: 'number',
          description: 'Max hits to return (default 15, capped at 15).',
        },
      },
      required: ['query'],
    },
  },
};

export function searchDocumentationTool(args: { query: string; max?: number }): Record<string, unknown> {
  return searchDocumentation(args);
}
