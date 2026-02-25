import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Test the routing logic in isolation by recreating the session DB schema
// and testing the routing decision logic directly.

const TMP_DIR = resolve(tmpdir(), 'clauded-test-router');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'router-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* ignore */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      updated_at INTEGER NOT NULL
    );
  `);
}

// Simulated routing logic matching src/providers/router.ts
function getProviderForChat(chatId: string, defaultProvider: string): string {
  const row = db.prepare('SELECT provider FROM sessions WHERE chat_id = ?').get(chatId) as { provider: string } | undefined;
  return row?.provider || defaultProvider;
}

function switchProvider(chatId: string, providerName: string): string {
  const normalized = providerName.toLowerCase().trim();
  if (normalized !== 'claude' && normalized !== 'ollama') {
    return `Unknown provider "${providerName}". Use "claude" or "ollama".`;
  }

  const session = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(chatId);
  if (session) {
    db.prepare('UPDATE sessions SET provider = ?, updated_at = ? WHERE chat_id = ?')
      .run(normalized, Date.now(), chatId);
  } else {
    db.prepare('INSERT INTO sessions (chat_id, session_id, provider, updated_at) VALUES (?, ?, ?, ?)')
      .run(chatId, '', normalized, Date.now());
  }
  return normalized;
}

function newChat(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

beforeEach(() => {
  initTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe('provider routing', () => {
  it('defaults to configured provider when no session exists', () => {
    expect(getProviderForChat('chat1', 'claude')).toBe('claude');
    expect(getProviderForChat('chat1', 'ollama')).toBe('ollama');
  });

  it('uses per-chat override from session', () => {
    switchProvider('chat1', 'ollama');
    expect(getProviderForChat('chat1', 'claude')).toBe('ollama');
  });

  it('switches provider for existing session', () => {
    switchProvider('chat1', 'claude');
    expect(getProviderForChat('chat1', 'claude')).toBe('claude');

    switchProvider('chat1', 'ollama');
    expect(getProviderForChat('chat1', 'claude')).toBe('ollama');
  });

  it('returns error for unknown provider', () => {
    const result = switchProvider('chat1', 'gpt');
    expect(result).toContain('Unknown provider');
  });

  it('normalizes provider name to lowercase', () => {
    const result = switchProvider('chat1', 'CLAUDE');
    expect(result).toBe('claude');
  });

  it('trims provider name whitespace', () => {
    const result = switchProvider('chat1', '  ollama  ');
    expect(result).toBe('ollama');
  });

  it('newChat clears the session', () => {
    switchProvider('chat1', 'ollama');
    expect(getProviderForChat('chat1', 'claude')).toBe('ollama');

    newChat('chat1');
    expect(getProviderForChat('chat1', 'claude')).toBe('claude'); // Falls back to default
  });

  it('handles multiple chats independently', () => {
    switchProvider('chat1', 'ollama');
    switchProvider('chat2', 'claude');

    expect(getProviderForChat('chat1', 'claude')).toBe('ollama');
    expect(getProviderForChat('chat2', 'claude')).toBe('claude');
  });
});

// ── shouldUseTools heuristic ─────────────────────────────────

// Reimplemented from src/providers/ollama.ts for isolated testing
function shouldUseTools(message: string): boolean {
  const lower = message.toLowerCase();
  const actionVerbs = /\b(search|read|check|find|get|look\s*up|fetch|query|save|remember|run|execute|look)\b/;
  const toolNouns = /\b(file|url|web|time|date|memory|system|command|website|page|info|uptime|disk)\b/;

  if (/\b(use tools?|search for|read the file|run command|what time|system info)\b/i.test(lower)) {
    return true;
  }
  if (actionVerbs.test(lower) && toolNouns.test(lower)) {
    return true;
  }
  return false;
}

describe('shouldUseTools heuristic', () => {
  it('routes "search for TypeScript docs" to tools', () => {
    expect(shouldUseTools('search for TypeScript docs')).toBe(true);
  });

  it('routes "read the file config.ts" to tools', () => {
    expect(shouldUseTools('read the file config.ts')).toBe(true);
  });

  it('routes "what time is it" to tools', () => {
    expect(shouldUseTools('what time is it')).toBe(true);
  });

  it('routes "run command ls" to tools', () => {
    expect(shouldUseTools('run command ls')).toBe(true);
  });

  it('routes "check system info" to tools', () => {
    expect(shouldUseTools('check system info')).toBe(true);
  });

  it('routes "get the file contents" to tools', () => {
    expect(shouldUseTools('get the file contents')).toBe(true);
  });

  it('routes "look up this website" to tools', () => {
    expect(shouldUseTools('look up this website')).toBe(true);
  });

  it('routes "save this to memory" to tools', () => {
    expect(shouldUseTools('save this to memory')).toBe(true);
  });

  it('does NOT route "explain async/await" to tools', () => {
    expect(shouldUseTools('explain async/await')).toBe(false);
  });

  it('does NOT route "what is the meaning of life" to tools', () => {
    expect(shouldUseTools('what is the meaning of life')).toBe(false);
  });

  it('does NOT route "tell me a joke" to tools', () => {
    expect(shouldUseTools('tell me a joke')).toBe(false);
  });

  it('does NOT route "hello how are you" to tools', () => {
    expect(shouldUseTools('hello how are you')).toBe(false);
  });
});
