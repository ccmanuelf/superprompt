import type { Tool } from 'ollama';
import { resolve } from 'node:path';
import { parseFile } from '../../files.js';
import { config, UPLOADS_DIR } from '../../config.js';

export const parseFileDefinition: Tool = {
  type: 'function',
  function: {
    name: 'parse_file',
    description:
      'Parse a document file and extract its text content. Supports XLSX, DOCX, PDF, CSV, JSON, Markdown, TXT, and PPTX formats. Use when you need to read the contents of a document the user sent or referenced.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path to parse',
        },
      },
      required: ['path'],
    },
  },
};

export async function parseFileTool(
  args: { path: string },
): Promise<Record<string, unknown>> {
  const filePath = resolve(args.path);

  // Validate path against allowed locations
  const allowedPaths = config.OLLAMA_ALLOWED_PATHS
    ? config.OLLAMA_ALLOWED_PATHS.split(',').map((p) => p.trim())
    : [];
  allowedPaths.push(UPLOADS_DIR);

  const isAllowed = allowedPaths.some((allowed) =>
    filePath.startsWith(resolve(allowed)),
  );

  if (!isAllowed) {
    return { error: `Access denied: ${filePath} is not in an allowed path` };
  }

  const result = await parseFile(filePath);

  if (result.error) {
    return { error: result.error };
  }

  return {
    text: result.text,
    format: result.format,
    pageCount: result.pageCount,
    sheetCount: result.sheetCount,
    truncated: result.truncated,
  };
}
