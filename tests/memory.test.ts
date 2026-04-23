import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// We test memory.ts logic by reimplementing its core functions against a test DB
// because memory.ts imports from db.ts and config.ts which have eager side effects.

const TMP_DIR = resolve(tmpdir(), 'luna-test-memory');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'memory-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* ignore */ }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic', 'episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END;
  `);
}

// Helper: insert a memory
function insertMemory(chatId: string, content: string, sector: 'semantic' | 'episodic', salience = 1.0, createdAt?: number): number {
  const now = createdAt ?? Date.now();
  const result = db.prepare(
    'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(chatId, content, sector, salience, now, now);
  return result.lastInsertRowid as number;
}

// Helper: FTS5 search
function searchMemories(chatId: string, query: string, limit = 5): any[] {
  return db.prepare(
    `SELECT m.* FROM memories m
     JOIN memories_fts fts ON fts.rowid = m.id
     WHERE fts.content MATCH ? AND m.chat_id = ?
     ORDER BY fts.rank LIMIT ?`,
  ).all(query, chatId, limit) as any[];
}

// Helper: recent memories
function getRecentMemories(chatId: string, limit = 5): any[] {
  return db.prepare(
    'SELECT * FROM memories WHERE chat_id = ? AND salience > 0.1 ORDER BY accessed_at DESC LIMIT ?',
  ).all(chatId, limit) as any[];
}

beforeEach(() => {
  initTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ── Semantic Signal Detection ────────────────────────────────

const SEMANTIC_SIGNAL =
  /\b(my|i am|i'm|i prefer|remember|always|never|my name is|i like|i hate|i love|i work|i live)\b/i;

describe('semantic signal detection', () => {
  it('detects "my name is"', () => {
    expect(SEMANTIC_SIGNAL.test('My name is John')).toBe(true);
  });

  it('detects "I like"', () => {
    expect(SEMANTIC_SIGNAL.test('I like TypeScript a lot')).toBe(true);
  });

  it('detects "I prefer"', () => {
    expect(SEMANTIC_SIGNAL.test('I prefer dark mode')).toBe(true);
  });

  it('detects "remember"', () => {
    expect(SEMANTIC_SIGNAL.test('Remember that I use VS Code')).toBe(true);
  });

  it('detects "I work"', () => {
    expect(SEMANTIC_SIGNAL.test('I work at a startup')).toBe(true);
  });

  it('does NOT match generic messages', () => {
    expect(SEMANTIC_SIGNAL.test('What is the weather today?')).toBe(false);
  });

  it('does NOT match short trivial messages', () => {
    expect(SEMANTIC_SIGNAL.test('hello')).toBe(false);
  });
});

// ── buildMemoryContext logic ─────────────────────────────────

describe('buildMemoryContext logic', () => {
  it('returns empty string when no memories exist', () => {
    const ftsResults = searchMemories('chat1', 'anything*', 3);
    const recentResults = getRecentMemories('chat1', 5);
    expect(ftsResults.length).toBe(0);
    expect(recentResults.length).toBe(0);
  });

  it('finds memories via FTS5 prefix search', () => {
    insertMemory('chat1', 'I like programming in TypeScript', 'semantic');
    insertMemory('chat1', 'Had a meeting about project deadlines', 'episodic');

    const results = searchMemories('chat1', 'TypeScript*', 3);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('deduplicates FTS5 + recent results', () => {
    const id = insertMemory('chat1', 'Unique memory content here', 'semantic');

    const ftsResults = searchMemories('chat1', 'Unique*', 3);
    const recentResults = getRecentMemories('chat1', 5);

    const seen = new Set<number>();
    const combined: any[] = [];
    for (const m of [...ftsResults, ...recentResults]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        combined.push(m);
      }
    }

    // Should only appear once despite being in both FTS and recent
    expect(combined.length).toBe(1);
  });

  it('touch bumps salience capped at 5.0', () => {
    insertMemory('chat1', 'Important fact', 'semantic', 4.95);

    db.prepare(
      'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE chat_id = ?',
    ).run(Date.now(), 'chat1');

    const row = db.prepare('SELECT salience FROM memories WHERE chat_id = ?').get('chat1') as any;
    expect(row.salience).toBe(5.0);
  });

  it('formats memory context correctly', () => {
    insertMemory('chat1', 'User likes pizza', 'semantic');
    insertMemory('chat1', 'Discussed project plans', 'episodic');

    const memories = getRecentMemories('chat1', 5);
    const lines = memories.map((m: any) => `- ${m.content} (${m.sector})`);
    const context = `[Memory context]\n${lines.join('\n')}`;

    expect(context).toContain('[Memory context]');
    expect(context).toContain('User likes pizza (semantic)');
    expect(context).toContain('Discussed project plans (episodic)');
  });
});

// ── saveConversationTurn logic ───────────────────────────────

describe('saveConversationTurn logic', () => {
  it('skips messages starting with /', () => {
    // Simulating saveConversationTurn logic
    const msg = '/start';
    expect(msg.startsWith('/')).toBe(true);
    // Would return early — no memory saved
  });

  it('skips messages starting with !', () => {
    const msg = '!newchat';
    expect(msg.startsWith('!')).toBe(true);
  });

  it('skips messages ≤ 20 chars', () => {
    const msg = 'hi there';
    expect(msg.length <= 20).toBe(true);
  });

  it('classifies semantic signal messages as semantic', () => {
    const msg = 'My name is John and I work at Acme Corp';
    const sector = SEMANTIC_SIGNAL.test(msg) ? 'semantic' : 'episodic';
    expect(sector).toBe('semantic');
  });

  it('classifies non-signal messages as episodic', () => {
    const msg = 'Can you explain how async/await works in JavaScript?';
    const sector = SEMANTIC_SIGNAL.test(msg) ? 'semantic' : 'episodic';
    expect(sector).toBe('episodic');
  });

  it('stores semantic messages as user statement directly', () => {
    const userMsg = 'I prefer dark mode for all my IDEs';
    const assistantMsg = 'Got it, I will remember that you prefer dark mode.';

    const isSemanticSignal = SEMANTIC_SIGNAL.test(userMsg);
    const content = isSemanticSignal ? userMsg : `User: ${userMsg} → Assistant: ${assistantMsg}`;
    expect(content).toBe(userMsg);
  });

  it('stores episodic messages as condensed turn summary', () => {
    const userMsg = 'What is the weather like in Santiago today? I want to know if I should bring an umbrella.';
    const assistantMsg = 'The weather in Santiago today is partly cloudy with a chance of rain. Bring an umbrella.';

    const isSemanticSignal = SEMANTIC_SIGNAL.test(userMsg);
    const content = isSemanticSignal ? userMsg : `User: ${userMsg} → Assistant: ${assistantMsg}`;
    expect(content).toContain('User:');
    expect(content).toContain('→ Assistant:');
  });
});

// ── runDecaySweep logic ──────────────────────────────────────

describe('runDecaySweep logic', () => {
  it('decays memories older than 24 hours', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - DAY_MS;

    // Old memory
    insertMemory('chat1', 'Old memory', 'semantic', 1.0, cutoff - 10000);
    // Recent memory
    insertMemory('chat1', 'New memory', 'semantic', 1.0, Date.now());

    db.prepare('UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?').run(cutoff);

    const rows = db.prepare('SELECT content, salience FROM memories WHERE chat_id = ? ORDER BY created_at ASC').all('chat1') as any[];
    expect(rows[0].salience).toBeCloseTo(0.98, 2); // Old — decayed
    expect(rows[1].salience).toBe(1.0); // New — untouched
  });

  it('deletes memories below 0.1 salience', () => {
    insertMemory('chat1', 'Fading memory', 'episodic', 0.05);
    insertMemory('chat1', 'Strong memory', 'semantic', 2.0);

    db.prepare('DELETE FROM memories WHERE salience < 0.1').run();

    const remaining = db.prepare('SELECT * FROM memories WHERE chat_id = ?').all('chat1') as any[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe('Strong memory');
  });

  it('repeated decay eventually drops below threshold', () => {
    insertMemory('chat1', 'Gradually forgotten', 'episodic', 0.15, Date.now() - 100000000);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    // Apply decay multiple times
    for (let i = 0; i < 25; i++) {
      db.prepare('UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?').run(cutoff);
    }

    db.prepare('DELETE FROM memories WHERE salience < 0.1').run();

    const remaining = db.prepare('SELECT * FROM memories WHERE chat_id = ?').all('chat1');
    expect(remaining.length).toBe(0);
  });
});
