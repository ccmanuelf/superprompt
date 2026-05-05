import type { Tool } from 'ollama';
import { readDocumentation } from '../../doc-awareness.js';

export const readDocumentationDefinition: Tool = {
  type: 'function',
  function: {
    name: 'read_documentation',
    description:
      'Read a Luna documentation file by id (e.g. "docs/user-guide", "reference/decisions"). '
      + 'Returns the markdown body. Use the "Available Documentation" manifest in your system prompt to find filenames. '
      + 'Output is chunked at 30KB; if the response is truncated, call again with the returned `nextOffset`.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Document id, optionally prefixed with "docs/" or "reference/". Bare ids default to docs/.',
        },
        offset: {
          type: 'number',
          description: 'Char offset to resume reading from. 0 (the default) starts at the top.',
        },
      },
      required: ['filename'],
    },
  },
};

export function readDocumentationTool(args: { filename: string; offset?: number }): Record<string, unknown> {
  return readDocumentation(args);
}
