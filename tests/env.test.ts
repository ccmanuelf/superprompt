import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readEnvFile } from '../src/env.js';

const TMP = resolve(tmpdir(), 'luna-test-env');
mkdirSync(TMP, { recursive: true });

function writeEnv(name: string, content: string): string {
  const p = resolve(TMP, name);
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  // Clean up temp files (best-effort)
  try {
    const { readdirSync } = require('node:fs');
    for (const f of readdirSync(TMP)) {
      unlinkSync(resolve(TMP, f));
    }
  } catch { /* ignore */ }
});

describe('readEnvFile', () => {
  it('parses KEY=value pairs', () => {
    const path = writeEnv('basic.env', 'FOO=bar\nBAZ=qux\n');
    const env = readEnvFile(path);
    expect(env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    const path = writeEnv('quoted.env', 'MSG="hello world"\n');
    const env = readEnvFile(path);
    expect(env.MSG).toBe('hello world');
  });

  it('handles single-quoted values', () => {
    const path = writeEnv('single.env', "KEY='value with spaces'\n");
    const env = readEnvFile(path);
    expect(env.KEY).toBe('value with spaces');
  });

  it('strips inline comments from unquoted values', () => {
    const path = writeEnv('comment.env', 'HOST=localhost # the host\n');
    const env = readEnvFile(path);
    expect(env.HOST).toBe('localhost');
  });

  it('preserves inline # inside quoted values', () => {
    const path = writeEnv('hash.env', 'URL="http://example.com/#page"\n');
    const env = readEnvFile(path);
    expect(env.URL).toBe('http://example.com/#page');
  });

  it('skips blank lines and comments', () => {
    const path = writeEnv('skip.env', '# comment\n\nKEY=val\n  # another\n');
    const env = readEnvFile(path);
    expect(env).toEqual({ KEY: 'val' });
  });

  it('skips lines without =', () => {
    const path = writeEnv('noeq.env', 'NOEQ\nGOOD=yes\n');
    const env = readEnvFile(path);
    expect(env).toEqual({ GOOD: 'yes' });
  });

  it('handles empty values', () => {
    const path = writeEnv('empty.env', 'EMPTY=\n');
    const env = readEnvFile(path);
    expect(env.EMPTY).toBe('');
  });

  it('handles values with = signs', () => {
    const path = writeEnv('eqval.env', 'CONN=postgres://host:5432/db?sslmode=require\n');
    const env = readEnvFile(path);
    expect(env.CONN).toBe('postgres://host:5432/db?sslmode=require');
  });

  it('returns empty object for missing file', () => {
    const env = readEnvFile('/nonexistent/path/.env');
    expect(env).toEqual({});
  });

  it('trims whitespace around keys and values', () => {
    const path = writeEnv('ws.env', '  KEY  =  value  \n');
    const env = readEnvFile(path);
    expect(env.KEY).toBe('value');
  });

  it('handles Windows-style line endings', () => {
    const path = writeEnv('crlf.env', 'A=1\r\nB=2\r\n');
    const env = readEnvFile(path);
    expect(env.A).toBe('1');
    expect(env.B).toBe('2');
  });
});
