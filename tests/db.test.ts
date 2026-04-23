import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// We need to set STORE_DIR before importing db.ts because config.ts reads env eagerly.
// Instead, we'll import the database module directly and initialize it with a temp path.
import Database from 'better-sqlite3';

// Use a temp directory for the test database
const TMP_DB_DIR = resolve(tmpdir(), 'luna-test-db');
mkdirSync(TMP_DB_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DB_DIR, 'test.db');

// Since db.ts depends on config.ts which reads .env eagerly,
// we test the database logic by importing the module and overriding internals.
// For isolated testing we create our own database with the same schema.

let db: Database.Database;

function createTestDb(): Database.Database {
  // Remove old file
  try { rmSync(DB_PATH); } catch { /* ignore */ }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      updated_at INTEGER NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
      created_at INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      UPDATE memories_fts SET content = new.content WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END;
  `);

  return db;
}

beforeEach(() => {
  createTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DB_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ── Sessions ─────────────────────────────────────────────────

describe('sessions CRUD', () => {
  it('inserts and retrieves a session', () => {
    db.prepare(
      'INSERT INTO sessions (chat_id, session_id, provider, updated_at) VALUES (?, ?, ?, ?)',
    ).run('chat1', 'sess-abc', 'claude', Date.now());

    const row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get('chat1') as any;
    expect(row).toBeDefined();
    expect(row.session_id).toBe('sess-abc');
    expect(row.provider).toBe('claude');
  });

  it('upserts a session (ON CONFLICT)', () => {
    const stmt = db.prepare(
      `INSERT INTO sessions (chat_id, session_id, provider, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         session_id = excluded.session_id,
         provider = excluded.provider,
         updated_at = excluded.updated_at`,
    );

    stmt.run('chat1', 'sess-1', 'claude', 1000);
    stmt.run('chat1', 'sess-2', 'ollama', 2000);

    const row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get('chat1') as any;
    expect(row.session_id).toBe('sess-2');
    expect(row.provider).toBe('ollama');
  });

  it('deletes a session', () => {
    db.prepare(
      'INSERT INTO sessions (chat_id, session_id, provider, updated_at) VALUES (?, ?, ?, ?)',
    ).run('chat1', 'sess-1', 'claude', Date.now());

    db.prepare('DELETE FROM sessions WHERE chat_id = ?').run('chat1');
    const row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get('chat1');
    expect(row).toBeUndefined();
  });

  it('updates provider for existing session', () => {
    db.prepare(
      'INSERT INTO sessions (chat_id, session_id, provider, updated_at) VALUES (?, ?, ?, ?)',
    ).run('chat1', 'sess-1', 'claude', 1000);

    db.prepare('UPDATE sessions SET provider = ?, updated_at = ? WHERE chat_id = ?')
      .run('ollama', 2000, 'chat1');

    const row = db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get('chat1') as any;
    expect(row.provider).toBe('ollama');
  });
});

// ── Memories ─────────────────────────────────────────────────

describe('memories CRUD', () => {
  it('inserts a memory and syncs to FTS5', () => {
    const now = Date.now();
    const result = db.prepare(
      'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', null, 'I like pizza', 'semantic', now, now);

    const id = result.lastInsertRowid as number;

    // Verify FTS5 sync
    const ftsResult = db.prepare(
      'SELECT * FROM memories_fts WHERE content MATCH ?',
    ).all('pizza');
    expect(ftsResult.length).toBeGreaterThan(0);
  });

  it('searches memories via FTS5', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'The user prefers TypeScript', 'semantic', now, now);
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'The user had lunch at noon', 'episodic', now, now);

    const results = db.prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts fts ON fts.rowid = m.id
       WHERE fts.content MATCH ? AND m.chat_id = ?
       ORDER BY fts.rank LIMIT 5`,
    ).all('TypeScript', 'chat1') as any[];

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('retrieves recent memories ordered by accessed_at', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'older memory', 'semantic', now - 2000, now - 2000);
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'newer memory', 'semantic', now, now);

    const results = db.prepare(
      'SELECT * FROM memories WHERE chat_id = ? AND salience > 0.1 ORDER BY accessed_at DESC LIMIT 5',
    ).all('chat1') as any[];

    expect(results.length).toBe(2);
    expect(results[0].content).toBe('newer memory');
  });

  it('applies salience decay', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'decaying memory', 'semantic', now, now);

    db.prepare('UPDATE memories SET salience = salience * 0.98 WHERE salience > 0.1').run();

    const row = db.prepare('SELECT salience FROM memories WHERE chat_id = ?').get('chat1') as any;
    expect(row.salience).toBeCloseTo(0.98, 2);
  });

  it('deletes memories below salience threshold', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 0.05, ?, ?)',
    ).run('chat1', 'almost forgotten', 'episodic', now, now);

    db.prepare('DELETE FROM memories WHERE salience <= 0.1').run();

    const results = db.prepare('SELECT * FROM memories WHERE chat_id = ?').all('chat1');
    expect(results.length).toBe(0);
  });

  it('FTS5 sync works on delete', () => {
    const now = Date.now();
    const result = db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'to be deleted', 'semantic', now, now);
    const id = result.lastInsertRowid as number;

    db.prepare('DELETE FROM memories WHERE id = ?').run(id);

    const ftsResults = db.prepare(
      'SELECT * FROM memories_fts WHERE content MATCH ?',
    ).all('deleted');
    expect(ftsResults.length).toBe(0);
  });

  it('isolates memories by chat_id', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat1', 'chat1 memory', 'semantic', now, now);
    db.prepare(
      'INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 1.0, ?, ?)',
    ).run('chat2', 'chat2 memory', 'semantic', now, now);

    const results = db.prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts fts ON fts.rowid = m.id
       WHERE fts.content MATCH ? AND m.chat_id = ?
       LIMIT 5`,
    ).all('memory', 'chat1') as any[];

    expect(results.length).toBe(1);
    expect(results[0].chat_id).toBe('chat1');
  });
});

// ── Scheduled Tasks ──────────────────────────────────────────

describe('scheduled tasks CRUD', () => {
  it('creates and retrieves a task', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run('task-1', 'chat1', 'Hello!', '0 9 * * *', now + 60000, now);

    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('task-1') as any;
    expect(row).toBeDefined();
    expect(row.prompt).toBe('Hello!');
    expect(row.status).toBe('active');
  });

  it('retrieves due tasks', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run('task-due', 'chat1', 'Due!', '* * * * *', now - 1000, now);
    db.prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run('task-future', 'chat1', 'Future!', '* * * * *', now + 99999, now);

    const due = db.prepare(
      'SELECT * FROM scheduled_tasks WHERE status = ? AND next_run <= ?',
    ).all('active', now) as any[];

    expect(due.length).toBe(1);
    expect(due[0].id).toBe('task-due');
  });

  it('pauses and resumes a task', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run('task-pr', 'chat1', 'PR!', '0 * * * *', now, now);

    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run('task-pr');
    let row = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get('task-pr') as any;
    expect(row.status).toBe('paused');

    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run('task-pr');
    row = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get('task-pr') as any;
    expect(row.status).toBe('active');
  });

  it('deletes a task', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run('task-del', 'chat1', 'Del!', '0 * * * *', now, now);

    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run('task-del');
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('task-del');
    expect(row).toBeUndefined();
  });

  it('enforces status CHECK constraint', () => {
    const now = Date.now();
    expect(() => {
      db.prepare(
        `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'invalid_status', ?)`,
      ).run('task-bad', 'chat1', 'Bad!', '* * * * *', now, now);
    }).toThrow();
  });
});
