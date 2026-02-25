import { execSync } from 'node:child_process';
import type { Tool } from 'ollama';

const MAX_OUTPUT = 5_000;
const TIMEOUT_MS = 10_000;

const WHITELIST = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'date',
  'uptime',
  'df',
  'free',
  'ps',
  'echo',
  'pwd',
  'which',
  'file',
  'stat',
]);

export const runCommandDefinition: Tool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command. Only whitelisted commands are allowed (ls, cat, head, tail, wc, date, uptime, df, free, ps, echo, pwd, which, file, stat).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
};

function extractBaseCommand(command: string): string | null {
  const trimmed = command.trim();
  // Handle env vars prefixed commands like "VAR=x ls"
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (!part.includes('=')) return part;
  }
  return null;
}

export function runCommand(args: {
  command: string;
}): Record<string, string> {
  const baseCmd = extractBaseCommand(args.command);

  if (!baseCmd || !WHITELIST.has(baseCmd)) {
    return {
      error: `Command "${baseCmd ?? args.command}" is not whitelisted. Allowed: ${[...WHITELIST].join(', ')}`,
    };
  }

  // Block shell metacharacters that could chain commands
  if (/[;&|`$()]/.test(args.command)) {
    return {
      error: 'Shell metacharacters (;, &, |, `, $, (, )) are not allowed.',
    };
  }

  try {
    const output = execSync(args.command, {
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });

    const trimmed = output.trim();
    if (trimmed.length > MAX_OUTPUT) {
      return {
        output: trimmed.slice(0, MAX_OUTPUT),
        truncated: `true (showing first ${MAX_OUTPUT} of ${trimmed.length} chars)`,
      };
    }
    return { output: trimmed };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    return { error: `Command failed: ${msg.slice(0, 500)}` };
  }
}
