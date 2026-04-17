/**
 * Core database module — Knex-based, cross-dialect (SQLite/MariaDB/PostgreSQL).
 *
 * This is the Knex migration of db.ts. All functions are async.
 * During the transition period, both db.ts (sync, SQLite-only) and db-core.ts
 * (async, any backend) coexist. Modules migrate one by one from db.ts to db-core.ts.
 *
 * Once all modules are migrated, db.ts will be removed.
 */

import { mkdirSync } from 'node:fs';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { initKnex, getKnex, destroyKnex, readDbConfig } from './db-knex.js';
import { createFullTextSearch, createVectorTable, columnExists, insertVecRow } from './db-dialect.js';
import type { StorageProvider, TableInitializer } from './core/interfaces.js';
import type { Knex } from 'knex';

// ── Re-export types (same as db.ts for backward compat) ────

export interface Session {
  chat_id: string;
  session_id: string;
  provider: string;
  ollama_model: string | null;
  claude_model: string | null;
  auto_route: number;
  updated_at: number;
}

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

export interface Episode {
  id: number;
  chat_id: string;
  summary: string;
  key_facts: string | null;
  open_threads: string | null;
  source_count: number;
  created_at: number;
}

// ── Initialization ──────────────────────────────────────────

async function createCoreTables(db: Knex): Promise<void> {
  // Sessions
  if (!(await db.schema.hasTable('sessions'))) {
    await db.schema.createTable('sessions', (t) => {
      t.string('chat_id').primary();
      t.string('session_id').notNullable();
      t.string('provider').notNullable().defaultTo('claude');
      t.string('ollama_model').nullable();
      t.integer('auto_route').notNullable().defaultTo(0);
      t.bigInteger('updated_at').notNullable();
    });
  }
  // Migration: ollama_model
  if (!(await columnExists(db, 'sessions', 'ollama_model'))) {
    await db.schema.alterTable('sessions', (t) => { t.string('ollama_model').nullable(); });
  }
  // Migration: auto_route
  if (!(await columnExists(db, 'sessions', 'auto_route'))) {
    await db.schema.alterTable('sessions', (t) => { t.integer('auto_route').notNullable().defaultTo(0); });
  }
  // Migration: claude_model (rc.68) — per-chat Claude model override
  if (!(await columnExists(db, 'sessions', 'claude_model'))) {
    await db.schema.alterTable('sessions', (t) => { t.string('claude_model').nullable(); });
  }

  // Memories
  if (!(await db.schema.hasTable('memories'))) {
    await db.schema.createTable('memories', (t) => {
      t.increments('id').primary();
      t.string('chat_id').notNullable();
      t.string('topic_key').nullable();
      t.text('content').notNullable();
      t.string('sector').notNullable();
      t.float('salience').notNullable().defaultTo(1.0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('accessed_at').notNullable();
      t.binary('embedding').nullable();
      t.index(['chat_id', 'sector']);
      t.index(['salience']);
    });
  }
  // Migration: embedding column
  if (!(await columnExists(db, 'memories', 'embedding'))) {
    await db.schema.alterTable('memories', (t) => { t.binary('embedding').nullable(); });
  }

  // FTS for memories
  await createFullTextSearch(db, 'memories', 'content', 'memories_fts');

  // Scheduled tasks
  if (!(await db.schema.hasTable('scheduled_tasks'))) {
    await db.schema.createTable('scheduled_tasks', (t) => {
      t.string('id').primary();
      t.string('chat_id').notNullable();
      t.text('prompt').notNullable();
      t.string('schedule').notNullable();
      t.bigInteger('next_run').notNullable();
      t.bigInteger('last_run').nullable();
      t.text('last_result').nullable();
      t.string('status').notNullable().defaultTo('active');
      t.bigInteger('created_at').notNullable();
      t.index(['status', 'next_run']);
    });
  }

  // Skills
  if (!(await db.schema.hasTable('skills'))) {
    await db.schema.createTable('skills', (t) => {
      t.string('id').primary();
      t.string('name').notNullable().unique();
      t.text('description').notNullable();
      t.text('system_prompt').notNullable();
      t.text('allowed_tools').nullable();
      t.integer('is_builtin').notNullable().defaultTo(0);
      t.string('source_file').nullable();
      t.integer('locked').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  // Migration: source_file, locked
  if (!(await columnExists(db, 'skills', 'source_file'))) {
    await db.schema.alterTable('skills', (t) => { t.string('source_file').nullable(); });
  }
  if (!(await columnExists(db, 'skills', 'locked'))) {
    await db.schema.alterTable('skills', (t) => { t.integer('locked').notNullable().defaultTo(0); });
  }

  // Chat skills (active skill per chat)
  if (!(await db.schema.hasTable('chat_skills'))) {
    await db.schema.createTable('chat_skills', (t) => {
      t.string('chat_id').primary();
      t.string('skill_id').notNullable();
      t.bigInteger('activated_at').notNullable();
      t.integer('auto_triggered').notNullable().defaultTo(0);
      t.integer('remaining_turns').notNullable().defaultTo(-1);
      t.foreign('skill_id').references('skills.id').onDelete('CASCADE');
    });
  }
  // Migration: auto_triggered, remaining_turns
  if (!(await columnExists(db, 'chat_skills', 'auto_triggered'))) {
    await db.schema.alterTable('chat_skills', (t) => { t.integer('auto_triggered').notNullable().defaultTo(0); });
  }
  if (!(await columnExists(db, 'chat_skills', 'remaining_turns'))) {
    await db.schema.alterTable('chat_skills', (t) => { t.integer('remaining_turns').notNullable().defaultTo(-1); });
  }

  // Skill revisions
  if (!(await db.schema.hasTable('skill_revisions'))) {
    await db.schema.createTable('skill_revisions', (t) => {
      t.increments('id').primary();
      t.string('skill_id').notNullable();
      t.text('system_prompt').notNullable();
      t.text('revision_note').nullable();
      t.bigInteger('created_at').notNullable();
      t.foreign('skill_id').references('skills.id').onDelete('CASCADE');
    });
  }

  // User tools
  if (!(await db.schema.hasTable('user_tools'))) {
    await db.schema.createTable('user_tools', (t) => {
      t.string('id').primary();
      t.string('name').notNullable().unique();
      t.text('description').notNullable();
      t.string('tool_type').notNullable();
      t.text('config').notNullable();
      t.integer('enabled').notNullable().defaultTo(1);
      t.integer('locked').notNullable().defaultTo(0);
      t.string('source_file').nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }

  // Tool revisions
  if (!(await db.schema.hasTable('tool_revisions'))) {
    await db.schema.createTable('tool_revisions', (t) => {
      t.increments('id').primary();
      t.string('tool_id').notNullable();
      t.text('config').notNullable();
      t.text('revision_note').nullable();
      t.bigInteger('created_at').notNullable();
      t.foreign('tool_id').references('user_tools.id').onDelete('CASCADE');
    });
  }

  // Episodes
  if (!(await db.schema.hasTable('episodes'))) {
    await db.schema.createTable('episodes', (t) => {
      t.increments('id').primary();
      t.string('chat_id').notNullable();
      t.text('summary').notNullable();
      t.text('key_facts').nullable();
      t.text('open_threads').nullable();
      t.integer('source_count').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.index(['chat_id']);
    });
  }

  // FTS for episodes
  await createFullTextSearch(db, 'episodes', 'summary', 'episodes_fts');

  // Episode follow-ups
  if (!(await db.schema.hasTable('episode_follow_ups'))) {
    await db.schema.createTable('episode_follow_ups', (t) => {
      t.integer('episode_id').primary();
      t.bigInteger('followed_up_at').notNullable();
      t.foreign('episode_id').references('episodes.id').onDelete('CASCADE');
    });
  }

  // Digest preferences
  if (!(await db.schema.hasTable('digest_preferences'))) {
    await db.schema.createTable('digest_preferences', (t) => {
      t.string('chat_id').primary();
      t.string('frequency').notNullable().defaultTo('off');
      t.bigInteger('updated_at').notNullable();
    });
  }

  // Vector tables (dialect-specific: sqlite-vec / BLOB / pgvector)
  await createVectorTable(db, 'memories_vec', 'memory_id', 768);
  await createVectorTable(db, 'episodes_vec', 'episode_id', 768);
}

export const coreTableInit: TableInitializer = {
  name: 'core',
  initTables: async () => {
    const db = getKnex();
    await createCoreTables(db);
  },
};

/**
 * Create a StorageProvider backed by Knex.
 * Replaces db.js createStorageProvider() — works with SQLite, MariaDB, PostgreSQL.
 */
export function createStorageProvider(): StorageProvider {
  const tableInitializers: TableInitializer[] = [];

  return {
    init(): void {
      // Ensure store directory exists (for SQLite file)
      mkdirSync(STORE_DIR, { recursive: true });
      // Initialize Knex (reads DB_DRIVER from config)
      initKnex(readDbConfig());
    },
    getDb() {
      // Legacy compat — returns the Knex instance typed as any
      // Modules should use getKnex() directly instead
      return getKnex() as unknown as import('better-sqlite3').Database;
    },
    registerTables(initializer: TableInitializer): void {
      tableInitializers.push(initializer);
    },
    async initAllTables(): Promise<void> {
      for (const init of tableInitializers) {
        await init.initTables();
        logger.debug({ table: init.name }, 'Table initializer executed');
      }
      logger.info({ count: tableInitializers.length }, 'All table initializers executed');
    },
    close(): void {
      destroyKnex().catch((err) => logger.warn({ err }, 'Error closing database'));
    },
  };
}

// ── Sessions CRUD ───────────────────────────────────────────

export async function getSession(chatId: string): Promise<Session | undefined> {
  const db = getKnex();
  return db('sessions').where({ chat_id: chatId }).first();
}

export async function setSession(
  chatId: string,
  sessionId: string,
  provider: string = 'claude',
): Promise<void> {
  const db = getKnex();
  await db('sessions')
    .insert({ chat_id: chatId, session_id: sessionId, provider, updated_at: Date.now() })
    .onConflict('chat_id')
    .merge({ session_id: sessionId, provider, updated_at: Date.now() });
}

export async function updateSessionProvider(chatId: string, provider: string): Promise<void> {
  const db = getKnex();
  await db('sessions').where({ chat_id: chatId }).update({ provider, updated_at: Date.now() });
}

export async function updateSessionOllamaModel(chatId: string, model: string | null): Promise<void> {
  const db = getKnex();
  await db('sessions').where({ chat_id: chatId }).update({ ollama_model: model, updated_at: Date.now() });
}

export async function updateSessionClaudeModel(chatId: string, model: string | null): Promise<void> {
  const db = getKnex();
  await db('sessions').where({ chat_id: chatId }).update({ claude_model: model, updated_at: Date.now() });
}

export async function clearSession(chatId: string): Promise<void> {
  const db = getKnex();
  await db('sessions').where({ chat_id: chatId }).del();
}

export async function setAutoRoute(chatId: string, enabled: boolean): Promise<void> {
  const db = getKnex();
  const session = await getSession(chatId);
  if (session) {
    await db('sessions').where({ chat_id: chatId }).update({ auto_route: enabled ? 1 : 0, updated_at: Date.now() });
  } else {
    await db('sessions').insert({ chat_id: chatId, session_id: '', provider: 'claude', auto_route: enabled ? 1 : 0, updated_at: Date.now() });
  }
}

export async function isAutoRouteEnabled(chatId: string): Promise<boolean> {
  const session = await getSession(chatId);
  return session?.auto_route === 1;
}

// ── Memories CRUD ───────────────────────────────────────────

export async function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
  embedding?: number[],
): Promise<number> {
  const db = getKnex();
  const now = Date.now();
  const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;

  const [id] = await db('memories').insert({
    chat_id: chatId,
    topic_key: topicKey ?? null,
    content,
    sector,
    salience: 1.0,
    created_at: now,
    accessed_at: now,
    embedding: embeddingBlob,
  });

  const memoryId = typeof id === 'number' ? id : Number(id);

  if (embedding && embeddingBlob) {
    try {
      await insertVecRow(db, 'memories_vec', 'memory_id', memoryId, embeddingBlob);
    } catch (err) {
      logger.warn({ err, memoryId }, 'Failed to insert into memories_vec');
    }
  }

  return memoryId;
}

export async function searchMemories(chatId: string, query: string, limit: number = 5): Promise<Memory[]> {
  const db = getKnex();
  const { fullTextSearch } = await import('./db-dialect.js');
  return fullTextSearch(db, 'memories', 'content', 'memories_fts', chatId, query, limit) as Promise<Memory[]>;
}

export async function getRecentMemories(chatId: string, limit: number = 10): Promise<Memory[]> {
  const db = getKnex();
  return db('memories')
    .where({ chat_id: chatId })
    .where('salience', '>', 0.1)
    .orderBy('accessed_at', 'desc')
    .limit(limit);
}

export async function touchMemory(id: number): Promise<void> {
  const db = getKnex();
  await db('memories').where({ id }).update({ accessed_at: Date.now() });
}

export async function getMemoriesByChatId(chatId: string): Promise<Memory[]> {
  const db = getKnex();
  return db('memories')
    .where({ chat_id: chatId })
    .where('salience', '>', 0.1)
    .orderBy([{ column: 'salience', order: 'desc' }, { column: 'accessed_at', order: 'desc' }]);
}

export async function deleteMemory(id: number): Promise<void> {
  const db = getKnex();
  try { await db('memories_vec').where({ memory_id: id }).del(); } catch { /* vec may not exist */ }
  await db('memories').where({ id }).del();
}

export async function decayMemories(decayFactor: number = 0.98): Promise<number> {
  const db = getKnex();
  const count = await db('memories').where('salience', '>', 0.1).update({ salience: db.raw('salience * ?', [decayFactor]) });

  // Clean up decayed memories
  const toDelete = await db('memories').where('salience', '<=', 0.1).select('id');
  for (const row of toDelete) {
    try { await db('memories_vec').where({ memory_id: row.id }).del(); } catch { /* best-effort */ }
  }
  await db('memories').where('salience', '<=', 0.1).del();

  return count;
}

export async function vectorSearchMemories(chatId: string, embedding: number[], limit: number = 5): Promise<Memory[]> {
  try {
    const db = getKnex();
    const { vectorSearch } = await import('./db-dialect.js');
    return vectorSearch(db, 'memories_vec', 'memory_id', 'memories', chatId, embedding, limit) as Promise<Memory[]>;
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, returning empty results');
    return [];
  }
}

export async function getUnembeddedMemoryCount(): Promise<number> {
  const db = getKnex();
  const result = await db('memories').whereNull('embedding').count('* as count').first();
  return (result as { count: number })?.count ?? 0;
}

export async function getUnembeddedMemories(limit: number = 10): Promise<Memory[]> {
  const db = getKnex();
  return db('memories').whereNull('embedding').limit(limit);
}

export async function updateMemoryEmbedding(id: number, embedding: number[]): Promise<void> {
  const db = getKnex();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  await db('memories').where({ id }).update({ embedding: embeddingBlob });

  try {
    await db('memories_vec').where({ memory_id: id }).del();
    await insertVecRow(db, 'memories_vec', 'memory_id', id, embeddingBlob);
  } catch (err) {
    logger.warn({ err, id }, 'Failed to update memories_vec for backfill');
  }
}

// ── Scheduled Tasks CRUD ────────────────────────────────────

export async function createTask(id: string, chatId: string, prompt: string, schedule: string, nextRun: number): Promise<void> {
  const db = getKnex();
  await db('scheduled_tasks').insert({ id, chat_id: chatId, prompt, schedule, next_run: nextRun, status: 'active', created_at: Date.now() });
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const db = getKnex();
  return db('scheduled_tasks').where({ status: 'active' }).where('next_run', '<=', Date.now());
}

export async function updateTaskAfterRun(id: string, nextRun: number, result: string): Promise<void> {
  const db = getKnex();
  await db('scheduled_tasks').where({ id }).update({ last_run: Date.now(), next_run: nextRun, last_result: result });
}

export async function pauseTask(id: string): Promise<void> {
  const db = getKnex();
  await db('scheduled_tasks').where({ id }).update({ status: 'paused' });
}

export async function resumeTask(id: string): Promise<void> {
  const db = getKnex();
  await db('scheduled_tasks').where({ id }).update({ status: 'active' });
}

export async function deleteTask(id: string): Promise<void> {
  const db = getKnex();
  await db('scheduled_tasks').where({ id }).del();
}

export async function getTasksByChat(chatId: string): Promise<ScheduledTask[]> {
  const db = getKnex();
  return db('scheduled_tasks').where({ chat_id: chatId });
}

export async function getTask(id: string): Promise<ScheduledTask | undefined> {
  const db = getKnex();
  return db('scheduled_tasks').where({ id }).first();
}

// ── Skills CRUD ─────────────────────────────────────────────

export async function createSkill(
  id: string, name: string, description: string, systemPrompt: string,
  allowedTools?: string[] | null, isBuiltin: boolean = false, sourceFile?: string,
): Promise<void> {
  const db = getKnex();
  const now = Date.now();
  await db('skills')
    .insert({
      id, name, description, system_prompt: systemPrompt,
      allowed_tools: allowedTools ? JSON.stringify(allowedTools) : null,
      is_builtin: isBuiltin ? 1 : 0, source_file: sourceFile ?? null,
      locked: 0, created_at: now, updated_at: now,
    })
    .onConflict('id')
    .merge({
      name, description, system_prompt: systemPrompt,
      allowed_tools: allowedTools ? JSON.stringify(allowedTools) : null,
      is_builtin: isBuiltin ? 1 : 0, source_file: sourceFile ?? null,
      updated_at: now,
    });
}

export async function createSkillIfNotExists(
  id: string, name: string, description: string, systemPrompt: string,
  allowedTools?: string[] | null, isBuiltin: boolean = false,
): Promise<void> {
  const db = getKnex();
  const now = Date.now();
  // Insert only if not exists — Knex onConflict.ignore()
  await db('skills')
    .insert({
      id, name, description, system_prompt: systemPrompt,
      allowed_tools: allowedTools ? JSON.stringify(allowedTools) : null,
      is_builtin: isBuiltin ? 1 : 0, source_file: null,
      locked: 0, created_at: now, updated_at: now,
    })
    .onConflict('id')
    .ignore();
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return getKnex()('skills').where({ id }).first();
}

export async function getSkillByName(name: string): Promise<Skill | undefined> {
  return getKnex()('skills').where({ name }).first();
}

export async function listSkills(): Promise<Skill[]> {
  return getKnex()('skills').orderBy([{ column: 'is_builtin', order: 'desc' }, { column: 'name', order: 'asc' }]);
}

export async function updateSkill(
  id: string,
  updates: { name?: string; description?: string; systemPrompt?: string; allowedTools?: string[] | null },
): Promise<void> {
  const db = getKnex();
  const skill = await getSkill(id);
  if (!skill) throw new Error(`Skill not found: ${id}`);

  const data: Record<string, unknown> = { updated_at: Date.now() };
  if (updates.name !== undefined) data.name = updates.name;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.systemPrompt !== undefined) data.system_prompt = updates.systemPrompt;
  if (updates.allowedTools !== undefined) {
    data.allowed_tools = updates.allowedTools ? JSON.stringify(updates.allowedTools) : null;
  }

  await db('skills').where({ id }).update(data);
}

export async function deleteSkill(id: string): Promise<boolean> {
  const skill = await getSkill(id);
  if (!skill) return false;
  if (skill.is_builtin) throw new Error('Cannot delete built-in skill');
  if (skill.locked) throw new Error('Skill is locked. Unlock it first with /skill unlock');
  await getKnex()('skills').where({ id }).del();
  return true;
}

export async function setActiveSkill(chatId: string, skillId: string): Promise<void> {
  const db = getKnex();
  await db('chat_skills')
    .insert({ chat_id: chatId, skill_id: skillId, activated_at: Date.now(), auto_triggered: 0, remaining_turns: -1 })
    .onConflict('chat_id')
    .merge({ skill_id: skillId, activated_at: Date.now() });
}

export async function getActiveSkill(chatId: string): Promise<Skill | undefined> {
  const db = getKnex();
  return db('skills')
    .join('chat_skills', 'chat_skills.skill_id', 'skills.id')
    .where({ 'chat_skills.chat_id': chatId })
    .select('skills.*')
    .first();
}

export async function clearActiveSkill(chatId: string): Promise<void> {
  await getKnex()('chat_skills').where({ chat_id: chatId }).del();
}

export async function setActiveSkillAutoTriggered(chatId: string, skillId: string, remainingTurns: number): Promise<void> {
  const db = getKnex();
  await db('chat_skills')
    .insert({ chat_id: chatId, skill_id: skillId, activated_at: Date.now(), auto_triggered: 1, remaining_turns: remainingTurns })
    .onConflict('chat_id')
    .merge({ skill_id: skillId, activated_at: Date.now(), auto_triggered: 1, remaining_turns: remainingTurns });
}

export async function isSkillAutoTriggered(chatId: string): Promise<boolean> {
  const row = await getKnex()('chat_skills').where({ chat_id: chatId }).select('auto_triggered').first();
  return (row as { auto_triggered: number } | undefined)?.auto_triggered === 1;
}

export async function decrementSkillTurns(chatId: string): Promise<boolean> {
  const db = getKnex();
  const row = await db('chat_skills').where({ chat_id: chatId }).select('remaining_turns', 'auto_triggered').first() as { remaining_turns: number; auto_triggered: number } | undefined;
  if (!row || !row.auto_triggered) return false;
  if (row.remaining_turns <= 0 && row.remaining_turns !== -1) return true;
  if (row.remaining_turns === -1) return false;
  const newTurns = row.remaining_turns - 1;
  await db('chat_skills').where({ chat_id: chatId }).update({ remaining_turns: newTurns });
  return newTurns <= 0;
}

export async function lockSkill(id: string): Promise<void> {
  await getKnex()('skills').where({ id }).update({ locked: 1, updated_at: Date.now() });
}

export async function unlockSkill(id: string): Promise<void> {
  await getKnex()('skills').where({ id }).update({ locked: 0, updated_at: Date.now() });
}

export async function insertSkillRevision(skillId: string, systemPrompt: string, revisionNote?: string): Promise<number> {
  const [id] = await getKnex()('skill_revisions').insert({ skill_id: skillId, system_prompt: systemPrompt, revision_note: revisionNote ?? null, created_at: Date.now() });
  return typeof id === 'number' ? id : Number(id);
}

export async function getSkillRevisions(skillId: string, limit: number = 10): Promise<SkillRevision[]> {
  return getKnex()('skill_revisions').where({ skill_id: skillId }).orderBy('created_at', 'desc').limit(limit);
}

// ── User Tools CRUD ─────────────────────────────────────────

export async function createUserTool(
  id: string, name: string, description: string,
  toolType: 'declarative_http' | 'generated_code', config: string, sourceFile?: string,
): Promise<void> {
  const db = getKnex();
  const now = Date.now();
  await db('user_tools')
    .insert({ id, name, description, tool_type: toolType, config, enabled: 1, locked: 0, source_file: sourceFile ?? null, created_at: now, updated_at: now })
    .onConflict('id')
    .merge({ name, description, tool_type: toolType, config, source_file: sourceFile ?? null, updated_at: now });
}

export async function getUserTool(id: string): Promise<UserTool | undefined> {
  return getKnex()('user_tools').where({ id }).first();
}

export async function getUserToolByName(name: string): Promise<UserTool | undefined> {
  return getKnex()('user_tools').where({ name }).first();
}

export async function listUserTools(): Promise<UserTool[]> {
  return getKnex()('user_tools').orderBy('name', 'asc');
}

export async function updateUserTool(id: string, updates: { description?: string; config?: string }): Promise<void> {
  const data: Record<string, unknown> = { updated_at: Date.now() };
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.config !== undefined) data.config = updates.config;
  await getKnex()('user_tools').where({ id }).update(data);
}

export async function deleteUserTool(id: string): Promise<boolean> {
  const tool = await getUserTool(id);
  if (!tool) return false;
  await getKnex()('user_tools').where({ id }).del();
  return true;
}

export async function enableUserTool(id: string): Promise<void> {
  await getKnex()('user_tools').where({ id }).update({ enabled: 1, updated_at: Date.now() });
}

export async function disableUserTool(id: string): Promise<void> {
  await getKnex()('user_tools').where({ id }).update({ enabled: 0, updated_at: Date.now() });
}

export async function lockUserTool(id: string): Promise<void> {
  await getKnex()('user_tools').where({ id }).update({ locked: 1, updated_at: Date.now() });
}

export async function unlockUserTool(id: string): Promise<void> {
  await getKnex()('user_tools').where({ id }).update({ locked: 0, updated_at: Date.now() });
}

export async function insertToolRevision(toolId: string, config: string, revisionNote?: string): Promise<number> {
  const [id] = await getKnex()('tool_revisions').insert({ tool_id: toolId, config, revision_note: revisionNote ?? null, created_at: Date.now() });
  return typeof id === 'number' ? id : Number(id);
}

export async function getToolRevisions(toolId: string, limit: number = 10): Promise<ToolRevision[]> {
  return getKnex()('tool_revisions').where({ tool_id: toolId }).orderBy('created_at', 'desc').limit(limit);
}

// ── Episodes CRUD ───────────────────────────────────────────

export async function insertEpisode(
  chatId: string, summary: string, keyFacts: string[] | null,
  openThreads: string[] | null, sourceCount: number, embedding?: number[],
): Promise<number> {
  const db = getKnex();
  const [id] = await db('episodes').insert({
    chat_id: chatId, summary,
    key_facts: keyFacts ? JSON.stringify(keyFacts) : null,
    open_threads: openThreads ? JSON.stringify(openThreads) : null,
    source_count: sourceCount, created_at: Date.now(),
  });
  const episodeId = typeof id === 'number' ? id : Number(id);

  if (embedding) {
    try {
      const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
      await insertVecRow(db, 'episodes_vec', 'episode_id', episodeId, embeddingBlob);
    } catch (err) {
      logger.warn({ err, episodeId }, 'Failed to insert into episodes_vec');
    }
  }
  return episodeId;
}

export async function searchEpisodes(chatId: string, query: string, limit: number = 2): Promise<Episode[]> {
  try {
    const db = getKnex();
    const { fullTextSearch } = await import('./db-dialect.js');
    return fullTextSearch(db, 'episodes', 'summary', 'episodes_fts', chatId, query, limit) as Promise<Episode[]>;
  } catch {
    return [];
  }
}

export async function vectorSearchEpisodes(chatId: string, embedding: number[], limit: number = 2): Promise<Episode[]> {
  try {
    const db = getKnex();
    const { vectorSearch } = await import('./db-dialect.js');
    return vectorSearch(db, 'episodes_vec', 'episode_id', 'episodes', chatId, embedding, limit) as Promise<Episode[]>;
  } catch {
    return [];
  }
}

export async function getCompressibleMemories(chatId: string, maxSalience: number = 0.3): Promise<Memory[]> {
  const db = getKnex();
  return db('memories')
    .where({ chat_id: chatId, sector: 'episodic' })
    .where('salience', '>', 0.1)
    .where('salience', '<=', maxSalience)
    .orderBy('created_at', 'asc');
}

export async function getChatsWithCompressibleMemories(maxSalience: number = 0.3): Promise<string[]> {
  const db = getKnex();
  const rows = await db('memories')
    .where({ sector: 'episodic' })
    .where('salience', '>', 0.1)
    .where('salience', '<=', maxSalience)
    .distinct('chat_id');
  return rows.map((r: { chat_id: string }) => r.chat_id);
}

export async function deleteMemories(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getKnex();
  await db.transaction(async (trx) => {
    for (const id of ids) {
      try { await trx('memories_vec').where({ memory_id: id }).del(); } catch { /* best-effort */ }
      await trx('memories').where({ id }).del();
    }
  });
}

// ── Cleanup ─────────────────────────────────────────────────

export async function closeDatabase(): Promise<void> {
  await destroyKnex();
}
