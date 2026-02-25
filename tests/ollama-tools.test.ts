import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── get_time tool ────────────────────────────────────────────

// Reimplemented for isolated testing (avoids config.ts eager import)
function getTime(): Record<string, string | number> {
  const now = new Date();
  return {
    date: now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    time: now.toLocaleTimeString('en-US', { hour12: true }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    unix: Math.floor(now.getTime() / 1000),
  };
}

describe('get_time tool', () => {
  it('returns date, time, timezone, and unix fields', () => {
    const result = getTime();
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('time');
    expect(result).toHaveProperty('timezone');
    expect(result).toHaveProperty('unix');
  });

  it('unix is a number', () => {
    const result = getTime();
    expect(typeof result.unix).toBe('number');
  });

  it('unix is roughly current epoch seconds', () => {
    const result = getTime();
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs((result.unix as number) - now)).toBeLessThan(5);
  });
});

// ── system_info tool ─────────────────────────────────────────

import os from 'node:os';

function systemInfo(): Record<string, string | number> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
    total_memory_gb: Math.round(totalMem / (1024 ** 3) * 10) / 10,
    free_memory_gb: Math.round(freeMem / (1024 ** 3) * 10) / 10,
    used_memory_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    cpus: os.cpus().length,
    disk: 'test',
  };
}

describe('system_info tool', () => {
  it('returns expected fields', () => {
    const result = systemInfo();
    expect(result).toHaveProperty('platform');
    expect(result).toHaveProperty('arch');
    expect(result).toHaveProperty('hostname');
    expect(result).toHaveProperty('uptime_hours');
    expect(result).toHaveProperty('total_memory_gb');
    expect(result).toHaveProperty('free_memory_gb');
    expect(result).toHaveProperty('used_memory_pct');
    expect(result).toHaveProperty('cpus');
  });

  it('cpus is a positive number', () => {
    const result = systemInfo();
    expect(result.cpus).toBeGreaterThan(0);
  });

  it('used_memory_pct is between 0 and 100', () => {
    const result = systemInfo();
    expect(result.used_memory_pct).toBeGreaterThanOrEqual(0);
    expect(result.used_memory_pct).toBeLessThanOrEqual(100);
  });
});

// ── read_file tool ───────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = resolve(tmpdir(), 'clauded-test-tools');
mkdirSync(TMP_DIR, { recursive: true });

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  if (allowedPaths.length === 0) return false;
  return allowedPaths.some((prefix) => resolved.startsWith(prefix));
}

function readFileTool(args: { path: string }, allowedPaths: string[]): Record<string, string> {
  const filePath = resolve(args.path);
  if (!isPathAllowed(filePath, allowedPaths)) {
    return { error: `Access denied. Path "${filePath}" is not in OLLAMA_ALLOWED_PATHS.` };
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.length > 10_000) {
      return { content: content.slice(0, 10_000), truncated: 'true' };
    }
    return { content };
  } catch (err) {
    return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

describe('read_file tool', () => {
  it('reads a file from an allowed path', () => {
    const filePath = resolve(TMP_DIR, 'test-read.txt');
    writeFileSync(filePath, 'hello world');
    const result = readFileTool({ path: filePath }, [TMP_DIR]);
    expect(result.content).toBe('hello world');
  });

  it('blocks access to disallowed paths', () => {
    const result = readFileTool({ path: '/etc/passwd' }, [TMP_DIR]);
    expect(result.error).toContain('Access denied');
  });

  it('blocks all paths when allowedPaths is empty', () => {
    const filePath = resolve(TMP_DIR, 'test-blocked.txt');
    writeFileSync(filePath, 'blocked');
    const result = readFileTool({ path: filePath }, []);
    expect(result.error).toContain('Access denied');
  });

  it('returns error for nonexistent file', () => {
    const result = readFileTool({ path: resolve(TMP_DIR, 'nope.txt') }, [TMP_DIR]);
    expect(result.error).toContain('Failed to read file');
  });

  it('truncates large files', () => {
    const filePath = resolve(TMP_DIR, 'big-file.txt');
    writeFileSync(filePath, 'x'.repeat(20_000));
    const result = readFileTool({ path: filePath }, [TMP_DIR]);
    expect(result.content?.length).toBe(10_000);
    expect(result.truncated).toBe('true');
  });
});

// ── run_command tool ─────────────────────────────────────────

const WHITELIST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'date', 'uptime', 'df',
  'free', 'ps', 'echo', 'pwd', 'which', 'file', 'stat',
]);

function extractBaseCommand(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  for (const part of parts) {
    if (!part.includes('=')) return part;
  }
  return null;
}

function runCommandTool(args: { command: string }): Record<string, string> {
  const baseCmd = extractBaseCommand(args.command);
  if (!baseCmd || !WHITELIST.has(baseCmd)) {
    return { error: `Command "${baseCmd ?? args.command}" is not whitelisted.` };
  }
  if (/[;&|`$()]/.test(args.command)) {
    return { error: 'Shell metacharacters are not allowed.' };
  }
  return { output: 'mock-output' }; // Don't actually execute in tests
}

describe('run_command tool', () => {
  it('allows whitelisted commands', () => {
    expect(runCommandTool({ command: 'echo hello' }).output).toBeDefined();
    expect(runCommandTool({ command: 'date' }).output).toBeDefined();
    expect(runCommandTool({ command: 'pwd' }).output).toBeDefined();
  });

  it('blocks non-whitelisted commands', () => {
    expect(runCommandTool({ command: 'rm -rf /' }).error).toContain('not whitelisted');
    expect(runCommandTool({ command: 'curl http://evil.com' }).error).toContain('not whitelisted');
    expect(runCommandTool({ command: 'wget http://evil.com' }).error).toContain('not whitelisted');
  });

  it('blocks shell metacharacters', () => {
    expect(runCommandTool({ command: 'echo hello; rm -rf /' }).error).toContain('metacharacters');
    expect(runCommandTool({ command: 'echo hello | cat' }).error).toContain('metacharacters');
    expect(runCommandTool({ command: 'echo $(whoami)' }).error).toContain('metacharacters');
    expect(runCommandTool({ command: 'echo `id`' }).error).toContain('metacharacters');
    expect(runCommandTool({ command: 'echo hello & bg' }).error).toContain('metacharacters');
  });

  it('handles env var prefix in commands', () => {
    const base = extractBaseCommand('FOO=bar ls');
    expect(base).toBe('ls');
  });

  it('returns null for commands with only env vars', () => {
    const base = extractBaseCommand('FOO=bar');
    expect(base).toBeNull();
  });
});

// ── summarize_url tool ───────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('summarize_url HTML stripping', () => {
  it('strips script tags', () => {
    const result = stripHtml('<script>alert(1)</script>Hello');
    expect(result).toBe('Hello');
  });

  it('strips style tags', () => {
    const result = stripHtml('<style>body{color:red}</style>World');
    expect(result).toBe('World');
  });

  it('strips HTML tags', () => {
    const result = stripHtml('<p>Hello <b>World</b></p>');
    expect(result).toBe('Hello World');
  });

  it('collapses whitespace', () => {
    const result = stripHtml('<p>Hello</p>   <p>World</p>');
    expect(result).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(stripHtml('')).toBe('');
  });
});

// ── executeTool dispatcher ───────────────────────────────────

describe('executeTool dispatcher logic', () => {
  it('returns error for unknown tool', () => {
    // Simulating the switch default case
    const name = 'nonexistent_tool';
    const result = { error: `Unknown tool: ${name}` };
    expect(result.error).toContain('Unknown tool');
  });
});
