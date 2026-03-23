import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { initLearningTables } from './learning/db.js';
import { initCitationTable } from './citations.js';
import { initBalanceTables } from './balance.js';

let db: Database.Database;

// ── Initialization ──────────────────────────────────────────

export function initDatabase(): Database.Database {
  mkdirSync(STORE_DIR, { recursive: true });

  db = new Database(resolve(STORE_DIR, 'clauded.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension for vector similarity search
  sqliteVec.load(db);

  createTables();
  initLearningTables();
  initCitationTable();
  initBalanceTables();
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

    -- Skills system
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      allowed_tools TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_skills (
      chat_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
  `);

  // Migration: add auto_triggered and remaining_turns columns to chat_skills
  const chatSkillCols = db.prepare("PRAGMA table_info(chat_skills)").all() as Array<{ name: string }>;
  if (!chatSkillCols.some((c) => c.name === 'auto_triggered')) {
    db.exec('ALTER TABLE chat_skills ADD COLUMN auto_triggered INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added auto_triggered column to chat_skills');
  }
  if (!chatSkillCols.some((c) => c.name === 'remaining_turns')) {
    db.exec('ALTER TABLE chat_skills ADD COLUMN remaining_turns INTEGER NOT NULL DEFAULT -1');
    logger.info('Migration: added remaining_turns column to chat_skills');
  }

  // Migration: add embedding column if it doesn't exist
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'embedding')) {
    db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
    logger.info('Migration: added embedding column to memories');
  }

  // Migration: add ollama_model column to sessions if it doesn't exist
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === 'ollama_model')) {
    db.exec('ALTER TABLE sessions ADD COLUMN ollama_model TEXT');
    logger.info('Migration: added ollama_model column to sessions');
  }
  if (!sessionCols.some((c) => c.name === 'auto_route')) {
    db.exec('ALTER TABLE sessions ADD COLUMN auto_route INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added auto_route column to sessions');
  }

  // Migration: add source_file and locked columns to skills if they don't exist
  const skillCols = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
  if (!skillCols.some((c) => c.name === 'source_file')) {
    db.exec('ALTER TABLE skills ADD COLUMN source_file TEXT');
    logger.info('Migration: added source_file column to skills');
  }
  if (!skillCols.some((c) => c.name === 'locked')) {
    db.exec('ALTER TABLE skills ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added locked column to skills');
  }

  // Migration: skill_revisions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      revision_note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
  `);

  // Migration: user_tools table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      tool_type TEXT NOT NULL CHECK(tool_type IN ('declarative_http', 'generated_code')),
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      locked INTEGER NOT NULL DEFAULT 0,
      source_file TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id TEXT NOT NULL,
      config TEXT NOT NULL,
      revision_note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES user_tools(id) ON DELETE CASCADE
    );
  `);

  // Episodes: compressed summaries of episodic memory groups
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_facts TEXT,
      open_threads TEXT,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_chat
      ON episodes(chat_id);
  `);

  // Episode follow-up tracking (proactive messaging)
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_follow_ups (
      episode_id INTEGER PRIMARY KEY,
      followed_up_at INTEGER NOT NULL,
      FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS digest_preferences (
      chat_id TEXT PRIMARY KEY,
      frequency TEXT NOT NULL DEFAULT 'off' CHECK(frequency IN ('daily', 'weekly', 'off')),
      updated_at INTEGER NOT NULL
    );
  `);

  // Episodes FTS5
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      summary,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, summary) VALUES (new.id, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF summary ON episodes BEGIN
      UPDATE episodes_fts SET summary = new.summary WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      DELETE FROM episodes_fts WHERE rowid = old.id;
    END;
  `);

  // Create vec0 virtual table for vector similarity search (768 dims = nomic-embed-text)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        memory_id INTEGER PRIMARY KEY,
        embedding float[768]
      );
    `);
  } catch (err) {
    logger.warn({ err }, 'Could not create memories_vec table (sqlite-vec may not be loaded)');
  }

  // Episodes vector table
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
        episode_id INTEGER PRIMARY KEY,
        embedding float[768]
      );
    `);
  } catch (err) {
    logger.warn({ err }, 'Could not create episodes_vec table (sqlite-vec may not be loaded)');
  }

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
  ollama_model: string | null;
  auto_route: number;
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

export function updateSessionOllamaModel(
  chatId: string,
  model: string | null,
): void {
  db.prepare(
    `UPDATE sessions SET ollama_model = ?, updated_at = ? WHERE chat_id = ?`,
  ).run(model, Date.now(), chatId);
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

export function setAutoRoute(chatId: string, enabled: boolean): void {
  const session = getSession(chatId);
  if (session) {
    db.prepare('UPDATE sessions SET auto_route = ?, updated_at = ? WHERE chat_id = ?')
      .run(enabled ? 1 : 0, Date.now(), chatId);
  } else {
    db.prepare(
      `INSERT INTO sessions (chat_id, session_id, provider, auto_route, updated_at)
       VALUES (?, '', 'claude', ?, ?)`,
    ).run(chatId, enabled ? 1 : 0, Date.now());
  }
}

export function isAutoRouteEnabled(chatId: string): boolean {
  const session = getSession(chatId);
  return session?.auto_route === 1;
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
  embedding?: Buffer | null;
}

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
  embedding?: number[],
): number {
  const now = Date.now();
  const embeddingBlob = embedding
    ? Buffer.from(new Float32Array(embedding).buffer)
    : null;

  const result = db
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, embedding)
       VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)`,
    )
    .run(chatId, topicKey ?? null, content, sector, now, now, embeddingBlob);

  const memoryId = Number(result.lastInsertRowid);

  // Sync to vec0 table if embedding was provided
  if (embedding) {
    try {
      // sqlite-vec vec0 requires INTEGER affinity — use CAST to ensure JS number
      // isn't bound as REAL by better-sqlite3
      db.prepare(
        'INSERT INTO memories_vec (memory_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
      ).run(memoryId, embeddingBlob);
    } catch (err) {
      logger.warn({ err, memoryId }, 'Failed to insert into memories_vec');
    }
  }

  return memoryId;
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
  // Remove from vec0 first (no cascade trigger support)
  try {
    db.prepare('DELETE FROM memories_vec WHERE memory_id = ?').run(id);
  } catch {
    // memories_vec may not exist or row may not be there
  }
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function decayMemories(decayFactor: number = 0.98): number {
  const result = db
    .prepare('UPDATE memories SET salience = salience * ? WHERE salience > 0.1')
    .run(decayFactor);

  // Get IDs that will be deleted so we can clean up vec0
  const toDelete = db
    .prepare('SELECT id FROM memories WHERE salience <= 0.1')
    .all() as Array<{ id: number }>;

  if (toDelete.length > 0) {
    const ids = toDelete.map((r) => r.id);
    for (const id of ids) {
      try {
        db.prepare('DELETE FROM memories_vec WHERE memory_id = ?').run(id);
      } catch {
        // best-effort vec0 cleanup
      }
    }
  }

  // Delete memories that have decayed below threshold
  db.prepare('DELETE FROM memories WHERE salience <= 0.1').run();

  return result.changes;
}

/**
 * Vector similarity search using sqlite-vec.
 * Returns memories ordered by cosine distance (closest first).
 */
export function vectorSearchMemories(
  chatId: string,
  embedding: number[],
  limit: number = 5,
): Memory[] {
  try {
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_vec v ON v.memory_id = m.id
         WHERE m.chat_id = ? AND m.salience > 0.1
         AND v.embedding MATCH ?
         AND v.k = ?
         ORDER BY v.distance`,
      )
      .all(chatId, embeddingBlob, limit) as Memory[];
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, returning empty results');
    return [];
  }
}

/**
 * Get count of memories without embeddings (for startup warning / backfill).
 */
export function getUnembeddedMemoryCount(): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL')
    .get() as { count: number };
  return row.count;
}

/**
 * Get memories without embeddings for backfill.
 */
export function getUnembeddedMemories(limit: number = 10): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE embedding IS NULL LIMIT ?')
    .all(limit) as Memory[];
}

/**
 * Update a memory's embedding (for backfill).
 */
export function updateMemoryEmbedding(id: number, embedding: number[]): void {
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embeddingBlob, id);

  try {
    // Try to insert into vec0; if exists, delete first
    db.prepare('DELETE FROM memories_vec WHERE memory_id = CAST(? AS INTEGER)').run(id);
    db.prepare('INSERT INTO memories_vec (memory_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(id, embeddingBlob);
  } catch (err) {
    logger.warn({ err, id }, 'Failed to update memories_vec for backfill');
  }
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

// ── Skills CRUD ─────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  allowed_tools: string | null;
  is_builtin: number;
  source_file: string | null;
  locked: number;
  created_at: number;
  updated_at: number;
}

export interface SkillRevision {
  id: number;
  skill_id: string;
  system_prompt: string;
  revision_note: string | null;
  created_at: number;
}

export function createSkill(
  id: string,
  name: string,
  description: string,
  systemPrompt: string,
  allowedTools?: string[] | null,
  isBuiltin: boolean = false,
  sourceFile?: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, source_file, locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    name,
    description,
    systemPrompt,
    allowedTools ? JSON.stringify(allowedTools) : null,
    isBuiltin ? 1 : 0,
    sourceFile ?? null,
    now,
    now,
  );
}

/**
 * Insert a skill only if it doesn't exist (for built-in seeding).
 * Preserves user modifications across restarts.
 */
export function createSkillIfNotExists(
  id: string,
  name: string,
  description: string,
  systemPrompt: string,
  allowedTools?: string[] | null,
  isBuiltin: boolean = false,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, source_file, locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(
    id,
    name,
    description,
    systemPrompt,
    allowedTools ? JSON.stringify(allowedTools) : null,
    isBuiltin ? 1 : 0,
    now,
    now,
  );
}

export function getSkill(id: string): Skill | undefined {
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | undefined;
}

export function getSkillByName(name: string): Skill | undefined {
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as Skill | undefined;
}

export function listSkills(): Skill[] {
  return db.prepare('SELECT * FROM skills ORDER BY is_builtin DESC, name ASC').all() as Skill[];
}

export function updateSkill(
  id: string,
  updates: { name?: string; description?: string; systemPrompt?: string; allowedTools?: string[] | null },
): void {
  const skill = getSkill(id);
  if (!skill) throw new Error(`Skill not found: ${id}`);

  db.prepare(
    `UPDATE skills SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       system_prompt = COALESCE(?, system_prompt),
       allowed_tools = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    updates.name ?? null,
    updates.description ?? null,
    updates.systemPrompt ?? null,
    updates.allowedTools !== undefined
      ? (updates.allowedTools ? JSON.stringify(updates.allowedTools) : null)
      : skill.allowed_tools,
    Date.now(),
    id,
  );
}

export function deleteSkill(id: string): boolean {
  const skill = getSkill(id);
  if (!skill) return false;
  if (skill.is_builtin) throw new Error('Cannot delete built-in skill');
  if (skill.locked) throw new Error('Skill is locked. Unlock it first with /skill unlock');
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  return true;
}

export function setActiveSkill(chatId: string, skillId: string): void {
  db.prepare(
    `INSERT INTO chat_skills (chat_id, skill_id, activated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       skill_id = excluded.skill_id,
       activated_at = excluded.activated_at`,
  ).run(chatId, skillId, Date.now());
}

export function getActiveSkill(chatId: string): Skill | undefined {
  const row = db
    .prepare(
      `SELECT s.* FROM skills s
       JOIN chat_skills cs ON cs.skill_id = s.id
       WHERE cs.chat_id = ?`,
    )
    .get(chatId) as Skill | undefined;
  return row;
}

export function clearActiveSkill(chatId: string): void {
  db.prepare('DELETE FROM chat_skills WHERE chat_id = ?').run(chatId);
}

/**
 * Set the active skill with auto-trigger metadata.
 * remaining_turns: how many messages before auto-deactivation (-1 = manual, never auto-deactivates)
 */
export function setActiveSkillAutoTriggered(
  chatId: string,
  skillId: string,
  remainingTurns: number,
): void {
  db.prepare(
    `INSERT INTO chat_skills (chat_id, skill_id, activated_at, auto_triggered, remaining_turns)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       skill_id = excluded.skill_id,
       activated_at = excluded.activated_at,
       auto_triggered = 1,
       remaining_turns = excluded.remaining_turns`,
  ).run(chatId, skillId, Date.now(), remainingTurns);
}

/**
 * Check if the current skill was auto-triggered (not manually activated).
 */
export function isSkillAutoTriggered(chatId: string): boolean {
  const row = db.prepare(
    'SELECT auto_triggered FROM chat_skills WHERE chat_id = ?',
  ).get(chatId) as { auto_triggered: number } | undefined;
  return row?.auto_triggered === 1;
}

/**
 * Decrement remaining turns for an auto-triggered skill.
 * Returns true if the skill should be deactivated (turns exhausted).
 */
export function decrementSkillTurns(chatId: string): boolean {
  const row = db.prepare(
    'SELECT remaining_turns, auto_triggered FROM chat_skills WHERE chat_id = ?',
  ).get(chatId) as { remaining_turns: number; auto_triggered: number } | undefined;

  if (!row || !row.auto_triggered) return false;
  if (row.remaining_turns <= 0 && row.remaining_turns !== -1) return true;
  if (row.remaining_turns === -1) return false; // Manual, never expires

  const newTurns = row.remaining_turns - 1;
  db.prepare('UPDATE chat_skills SET remaining_turns = ? WHERE chat_id = ?').run(newTurns, chatId);

  return newTurns <= 0;
}

// ── Skill Lock/Unlock + Revisions ───────────────────────────

export function lockSkill(id: string): void {
  db.prepare('UPDATE skills SET locked = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function unlockSkill(id: string): void {
  db.prepare('UPDATE skills SET locked = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function insertSkillRevision(
  skillId: string,
  systemPrompt: string,
  revisionNote?: string,
): number {
  const result = db.prepare(
    'INSERT INTO skill_revisions (skill_id, system_prompt, revision_note, created_at) VALUES (?, ?, ?, ?)',
  ).run(skillId, systemPrompt, revisionNote ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

export function getSkillRevisions(skillId: string, limit: number = 10): SkillRevision[] {
  return db.prepare(
    'SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(skillId, limit) as SkillRevision[];
}

// ── User Tools CRUD ─────────────────────────────────────────

export interface UserTool {
  id: string;
  name: string;
  description: string;
  tool_type: 'declarative_http' | 'generated_code';
  config: string;
  enabled: number;
  locked: number;
  source_file: string | null;
  created_at: number;
  updated_at: number;
}

export interface ToolRevision {
  id: number;
  tool_id: string;
  config: string;
  revision_note: string | null;
  created_at: number;
}

export function createUserTool(
  id: string,
  name: string,
  description: string,
  toolType: 'declarative_http' | 'generated_code',
  config: string,
  sourceFile?: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO user_tools (id, name, description, tool_type, config, enabled, locked, source_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  ).run(id, name, description, toolType, config, sourceFile ?? null, now, now);
}

export function getUserTool(id: string): UserTool | undefined {
  return db.prepare('SELECT * FROM user_tools WHERE id = ?').get(id) as UserTool | undefined;
}

export function getUserToolByName(name: string): UserTool | undefined {
  return db.prepare('SELECT * FROM user_tools WHERE name = ?').get(name) as UserTool | undefined;
}

export function listUserTools(): UserTool[] {
  return db.prepare('SELECT * FROM user_tools ORDER BY name ASC').all() as UserTool[];
}

export function updateUserTool(
  id: string,
  updates: { description?: string; config?: string },
): void {
  db.prepare(
    `UPDATE user_tools SET
       description = COALESCE(?, description),
       config = COALESCE(?, config),
       updated_at = ?
     WHERE id = ?`,
  ).run(updates.description ?? null, updates.config ?? null, Date.now(), id);
}

export function deleteUserTool(id: string): boolean {
  const tool = getUserTool(id);
  if (!tool) return false;
  db.prepare('DELETE FROM user_tools WHERE id = ?').run(id);
  return true;
}

export function enableUserTool(id: string): void {
  db.prepare('UPDATE user_tools SET enabled = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function disableUserTool(id: string): void {
  db.prepare('UPDATE user_tools SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function lockUserTool(id: string): void {
  db.prepare('UPDATE user_tools SET locked = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function unlockUserTool(id: string): void {
  db.prepare('UPDATE user_tools SET locked = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function insertToolRevision(
  toolId: string,
  config: string,
  revisionNote?: string,
): number {
  const result = db.prepare(
    'INSERT INTO tool_revisions (tool_id, config, revision_note, created_at) VALUES (?, ?, ?, ?)',
  ).run(toolId, config, revisionNote ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

export function getToolRevisions(toolId: string, limit: number = 10): ToolRevision[] {
  return db.prepare(
    'SELECT * FROM tool_revisions WHERE tool_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(toolId, limit) as ToolRevision[];
}

// ── Episodes CRUD ───────────────────────────────────────────

export interface Episode {
  id: number;
  chat_id: string;
  summary: string;
  key_facts: string | null;
  open_threads: string | null;
  source_count: number;
  created_at: number;
}

export function insertEpisode(
  chatId: string,
  summary: string,
  keyFacts: string[] | null,
  openThreads: string[] | null,
  sourceCount: number,
  embedding?: number[],
): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO episodes (chat_id, summary, key_facts, open_threads, source_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    summary,
    keyFacts ? JSON.stringify(keyFacts) : null,
    openThreads ? JSON.stringify(openThreads) : null,
    sourceCount,
    now,
  );

  const episodeId = Number(result.lastInsertRowid);

  if (embedding) {
    try {
      const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare(
        'INSERT INTO episodes_vec (episode_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
      ).run(episodeId, embeddingBlob);
    } catch (err) {
      logger.warn({ err, episodeId }, 'Failed to insert into episodes_vec');
    }
  }

  return episodeId;
}

export function searchEpisodes(
  chatId: string,
  query: string,
  limit: number = 2,
): Episode[] {
  try {
    return db.prepare(
      `SELECT e.* FROM episodes e
       JOIN episodes_fts fts ON fts.rowid = e.id
       WHERE fts.summary MATCH ? AND e.chat_id = ?
       ORDER BY fts.rank
       LIMIT ?`,
    ).all(query, chatId, limit) as Episode[];
  } catch {
    return [];
  }
}

export function vectorSearchEpisodes(
  chatId: string,
  embedding: number[],
  limit: number = 2,
): Episode[] {
  try {
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
    return db.prepare(
      `SELECT e.* FROM episodes e
       JOIN episodes_vec v ON v.episode_id = e.id
       WHERE e.chat_id = ?
       AND v.embedding MATCH ?
       AND v.k = ?
       ORDER BY v.distance`,
    ).all(chatId, embeddingBlob, limit) as Episode[];
  } catch {
    return [];
  }
}

/**
 * Get episodic memories eligible for compression.
 * Returns memories grouped by chat_id with salience between 0.1 and 0.3
 * (decayed enough to be candidates but not yet deleted).
 */
export function getCompressibleMemories(
  chatId: string,
  maxSalience: number = 0.3,
): Memory[] {
  return db.prepare(
    `SELECT * FROM memories
     WHERE chat_id = ? AND sector = 'episodic' AND salience > 0.1 AND salience <= ?
     ORDER BY created_at ASC`,
  ).all(chatId, maxSalience) as Memory[];
}

/**
 * Get all distinct chat IDs that have compressible episodic memories.
 */
export function getChatsWithCompressibleMemories(maxSalience: number = 0.3): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT chat_id FROM memories
     WHERE sector = 'episodic' AND salience > 0.1 AND salience <= ?`,
  ).all(maxSalience) as Array<{ chat_id: string }>;
  return rows.map((r) => r.chat_id);
}

/**
 * Delete specific memories by ID (used after episode compression).
 */
export function deleteMemories(ids: number[]): void {
  if (ids.length === 0) return;

  const transaction = db.transaction(() => {
    for (const id of ids) {
      try {
        db.prepare('DELETE FROM memories_vec WHERE memory_id = ?').run(id);
      } catch {
        // best-effort vec0 cleanup
      }
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }
  });

  transaction();
}

// ── Cleanup ─────────────────────────────────────────────────

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
