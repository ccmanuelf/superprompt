import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from 'ollama';
import { config } from '../../config.js';

const MAX_CHARS = 10_000;

export const readFileDefinition: Tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read the contents of a file from the filesystem. Only works on allowed paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
};

function getAllowedPaths(): string[] {
  // rc.70: always allow the bot's own uploads directory. Files there
  // were explicitly handed to the bot by the user (Telegram/Matrix
  // uploads, voice transcripts, generated documents), so reading them
  // back is already within the user's intent — the sandbox should
  // protect other parts of the filesystem, not the user's own content.
  const paths = [config.UPLOADS_DIR, config.WORKSPACE_DIR];
  if (config.OLLAMA_ALLOWED_PATHS) {
    paths.push(...config.OLLAMA_ALLOWED_PATHS.split(',').map((p) => p.trim()));
  }
  return paths.filter(Boolean);
}

function isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  const allowed = getAllowedPaths();
  if (allowed.length === 0) return false;
  return allowed.some((prefix) => resolved.startsWith(prefix));
}

export function readFileTool(args: {
  path: string;
}): Record<string, string> {
  const filePath = resolve(args.path);

  if (!isPathAllowed(filePath)) {
    return {
      error: `Access denied. Path "${filePath}" is not in OLLAMA_ALLOWED_PATHS.`,
    };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.length > MAX_CHARS) {
      return {
        content: content.slice(0, MAX_CHARS),
        truncated: `true (showing first ${MAX_CHARS} of ${content.length} chars)`,
      };
    }
    return { content };
  } catch (err) {
    return {
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
