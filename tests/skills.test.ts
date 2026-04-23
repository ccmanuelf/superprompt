import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = resolve(tmpdir(), 'luna-test-skills');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'skills-test.db');

let db: Database.Database;

function createTestDb(): Database.Database {
  try { rmSync(DB_PATH); } catch { /* ignore */ }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
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

  return db;
}

function insertSkill(
  id: string,
  name: string,
  desc: string,
  prompt: string,
  tools: string[] | null = null,
  builtin = false,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, desc, prompt, tools ? JSON.stringify(tools) : null, builtin ? 1 : 0, now, now);
}

beforeEach(() => {
  createTestDb();
});

afterAll(() => {
  if (db) db.close();
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe('skills CRUD', () => {
  it('creates and retrieves a skill', () => {
    insertSkill('test-1', 'translator', 'Translate things', 'You are a translator', ['web_search'], true);

    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get('test-1') as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('translator');
    expect(row.is_builtin).toBe(1);
    expect(JSON.parse(row.allowed_tools)).toEqual(['web_search']);
  });

  it('lists all skills', () => {
    insertSkill('s1', 'general', 'Default', '', null, true);
    insertSkill('s2', 'coder', 'Code expert', 'You code', ['read_file'], true);

    const skills = db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as any[];
    expect(skills.length).toBe(2);
  });

  it('name is unique', () => {
    insertSkill('s1', 'unique-skill', 'First', 'prompt1');
    // Same name, different ID → should replace via INSERT OR REPLACE on PRIMARY KEY
    // But name UNIQUE will cause conflict with different ID
    expect(() => {
      db.prepare(
        'INSERT INTO skills (id, name, description, system_prompt, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ).run('s2', 'unique-skill', 'Second', 'prompt2', Date.now(), Date.now());
    }).toThrow();
  });

  it('deletes a skill and cascades to chat_skills', () => {
    insertSkill('s1', 'deleteme', 'To delete', 'prompt');
    db.prepare('INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)').run('chat1', 's1', Date.now());

    db.prepare('DELETE FROM skills WHERE id = ?').run('s1');

    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get('s1');
    expect(skill).toBeUndefined();

    const chatSkill = db.prepare('SELECT * FROM chat_skills WHERE chat_id = ?').get('chat1');
    expect(chatSkill).toBeUndefined();
  });
});

describe('chat_skills (activate/deactivate)', () => {
  it('sets active skill for a chat', () => {
    insertSkill('s1', 'translator', 'Translate', 'You translate', null, true);

    db.prepare(
      'INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)',
    ).run('chat1', 's1', Date.now());

    const row = db.prepare(
      'SELECT s.* FROM skills s JOIN chat_skills cs ON cs.skill_id = s.id WHERE cs.chat_id = ?',
    ).get('chat1') as any;
    expect(row.name).toBe('translator');
  });

  it('deactivates skill by deleting chat_skills row', () => {
    insertSkill('s1', 'translator', 'Translate', 'You translate', null, true);
    db.prepare(
      'INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)',
    ).run('chat1', 's1', Date.now());

    db.prepare('DELETE FROM chat_skills WHERE chat_id = ?').run('chat1');

    const row = db.prepare(
      'SELECT * FROM chat_skills WHERE chat_id = ?',
    ).get('chat1');
    expect(row).toBeUndefined();
  });

  it('switching skill replaces the previous one (upsert)', () => {
    insertSkill('s1', 'translator', 'Translate', 'prompt1', null, true);
    insertSkill('s2', 'coder', 'Code', 'prompt2', null, true);

    db.prepare(
      `INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET skill_id = excluded.skill_id, activated_at = excluded.activated_at`,
    ).run('chat1', 's1', Date.now());

    db.prepare(
      `INSERT INTO chat_skills (chat_id, skill_id, activated_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET skill_id = excluded.skill_id, activated_at = excluded.activated_at`,
    ).run('chat1', 's2', Date.now());

    const row = db.prepare(
      'SELECT s.name FROM skills s JOIN chat_skills cs ON cs.skill_id = s.id WHERE cs.chat_id = ?',
    ).get('chat1') as any;
    expect(row.name).toBe('coder');
  });
});

describe('allowed tools', () => {
  it('null means all tools', () => {
    insertSkill('s1', 'general', 'Default', '', null, true);
    const row = db.prepare('SELECT allowed_tools FROM skills WHERE id = ?').get('s1') as any;
    expect(row.allowed_tools).toBeNull();
  });

  it('JSON array means restricted tools', () => {
    insertSkill('s1', 'analyst', 'Data', 'prompt', ['parse_file', 'read_file', 'generate_document']);
    const row = db.prepare('SELECT allowed_tools FROM skills WHERE id = ?').get('s1') as any;
    const tools = JSON.parse(row.allowed_tools);
    expect(tools).toEqual(['parse_file', 'read_file', 'generate_document']);
    expect(tools.length).toBe(3);
  });
});

describe('built-in protection', () => {
  it('built-in skills have is_builtin = 1', () => {
    insertSkill('s1', 'builtin-test', 'Built-in', 'prompt', null, true);
    const row = db.prepare('SELECT is_builtin FROM skills WHERE id = ?').get('s1') as any;
    expect(row.is_builtin).toBe(1);
  });

  it('custom skills have is_builtin = 0', () => {
    insertSkill('s1', 'custom-test', 'Custom', 'prompt', null, false);
    const row = db.prepare('SELECT is_builtin FROM skills WHERE id = ?').get('s1') as any;
    expect(row.is_builtin).toBe(0);
  });
});
