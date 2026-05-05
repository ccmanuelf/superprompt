import type { Tool } from 'ollama';
import { searchDocumentation } from '../../doc-awareness.js';
import { logger } from '../../logger.js';

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
  const result = searchDocumentation(args);
  // rc.111 telemetry — log search invocations with the unique set of
  // matched filenames so operators can answer "which queries pull
  // which docs" and "which docs answer no questions" (latent gaps).
  const hits = Array.isArray(result.hits) ? (result.hits as Array<{ filename?: string }>) : null;
  const files = hits ? Array.from(new Set(hits.map((h) => h.filename).filter((f): f is string => typeof f === 'string'))) : undefined;
  logger.info(
    {
      tool: 'search_documentation',
      query: args.query,
      max: args.max ?? 15,
      matchCount: typeof result.matchCount === 'number' ? result.matchCount : undefined,
      truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined,
      files,
      error: typeof result.error === 'string' ? result.error : undefined,
    },
    'doc-aware tool invoked',
  );
  return result;
}
