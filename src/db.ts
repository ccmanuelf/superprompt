import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { STORE_DIR } from './config.js';

let db: Database.Database;

// ── Initialization ──────────────────────────────────────────

export function initDatabase(): Database.Database {
  mkdirSync(STORE_DIR, { recursive: true });

  db = new Database(resolve(STORE_DIR, 'clauded.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function createTables(): void {
  db.exec(`
    -- Sessions: tracks active AI session per chat
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      updated_at INTEGER NOT NULL
    );

    -- Memories: dual-sector (semantic + episodic) with salience decay
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

    -- FTS5 full-text search index for memories
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid=id
    );

    -- Scheduled tasks
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

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(status, next_run);

    CREATE INDEX IF NOT EXISTS idx_memories_chat
      ON memories(chat_id, sector);

    CREATE INDEX IF NOT EXISTS idx_memories_salience
      ON memories(salience);
  `);

  // FTS5 sync triggers — keep memories_fts in sync with memories table
  db.exec(`
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
}

// ── Sessions CRUD ───────────────────────────────────────────

export interface Session {
  chat_id: string;
  session_id: string;
  provider: string;
  updated_at: number;
}

export function getSession(chatId: string): Session | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE chat_id = ?')
    .get(chatId) as Session | undefined;
}

export function setSession(
  chatId: string,
  sessionId: string,
  provider: string = 'claude',
): void {
  db.prepare(
    `INSERT INTO sessions (chat_id, session_id, provider, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       session_id = excluded.session_id,
       provider = excluded.provider,
       updated_at = excluded.updated_at`,
  ).run(chatId, sessionId, provider, Date.now());
}

export function updateSessionProvider(
  chatId: string,
  provider: string,
): void {
  db.prepare(
    `UPDATE sessions SET provider = ?, updated_at = ? WHERE chat_id = ?`,
  ).run(provider, Date.now(), chatId);
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// ── Memories CRUD ───────────────────────────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  topic_key: string | null;
  content: string;
  sector: 'semantic' | 'episodic';
  salience: number;
  created_at: number;
  accessed_at: number;
}

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
       VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
    )
    .run(chatId, topicKey ?? null, content, sector, now, now);
  return result.lastInsertRowid as number;
}

export function searchMemories(
  chatId: string,
  query: string,
  limit: number = 5,
): Memory[] {
  return db
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts fts ON fts.rowid = m.id
       WHERE fts.content MATCH ? AND m.chat_id = ?
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(query, chatId, limit) as Memory[];
}

export function getRecentMemories(
  chatId: string,
  limit: number = 10,
): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ? AND salience > 0.1
       ORDER BY accessed_at DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number): void {
  db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(
    Date.now(),
    id,
  );
}

export function getMemoriesByChatId(chatId: string): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND salience > 0.1
       ORDER BY salience DESC, accessed_at DESC`,
    )
    .all(chatId) as Memory[];
}

export function deleteMemory(id: number): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function decayMemories(decayFactor: number = 0.98): number {
  const result = db
    .prepare('UPDATE memories SET salience = salience * ? WHERE salience > 0.1')
    .run(decayFactor);

  // Delete memories that have decayed below threshold
  db.prepare('DELETE FROM memories WHERE salience <= 0.1').run();

  return result.changes;
}

// ── Scheduled Tasks CRUD ────────────────────────────────────

export interface ScheduledTask {
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused';
  created_at: number;
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number,
): void {
  db.prepare(
    `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  ).run(id, chatId, prompt, schedule, nextRun, Date.now());
}

export function getDueTasks(): ScheduledTask[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?`,
    )
    .all(Date.now()) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
): void {
  db.prepare(
    `UPDATE scheduled_tasks
     SET last_run = ?, next_run = ?, last_result = ?
     WHERE id = ?`,
  ).run(Date.now(), nextRun, result, id);
}

export function pauseTask(id: string): void {
  db.prepare(
    `UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?`,
  ).run(id);
}

export function resumeTask(id: string): void {
  db.prepare(
    `UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`,
  ).run(id);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getTasksByChat(chatId: string): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ?')
    .all(chatId) as ScheduledTask[];
}

export function getTask(id: string): ScheduledTask | undefined {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined;
}

// ── Cleanup ─────────────────────────────────────────────────

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
