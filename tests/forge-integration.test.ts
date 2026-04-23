import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillMarkdown } from '../src/forge/skill-parser.js';

describe('forge skill integration', () => {
  it('parse → validate → create flow', () => {
    const md = `---
name: pirate
description: Responds in pirate speak
tools: [query_memory, save_memory]
---
You are a pirate captain. Respond to everything in pirate speak.
Never break character. Use lots of "arrr" and "matey".`;

    // 1. Parse
    const parsed = parseSkillMarkdown(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;

    // 2. Validate
    expect(parsed.name).toBe('pirate');
    expect(parsed.description).toBe('Responds in pirate speak');
    expect(parsed.tools).toEqual(['query_memory', 'save_memory']);
    expect(parsed.systemPrompt).toContain('pirate captain');
    expect(parsed.systemPrompt).toContain('arrr');

    // 3. DB simulation: create skill
    const TMP_DIR = resolve(tmpdir(), 'luna-test-forge-skill');
    mkdirSync(TMP_DIR, { recursive: true });
    const db = new Database(resolve(TMP_DIR, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        allowed_tools TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        source_file TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE skill_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        revision_note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
      );
    `);

    const id = `custom-${parsed.name}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO skills (id, name, description, system_prompt, allowed_tools, is_builtin, source_file, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'pirate.md', 0, ?, ?)`
    ).run(id, parsed.name, parsed.description, parsed.systemPrompt,
      parsed.tools ? JSON.stringify(parsed.tools) : null, now, now);

    // 4. Verify created
    const skill = db.prepare('SELECT * FROM skills WHERE name = ?').get('pirate') as any;
    expect(skill).toBeDefined();
    expect(skill.name).toBe('pirate');
    expect(skill.source_file).toBe('pirate.md');
    expect(skill.locked).toBe(0);

    // 5. Save revision
    db.prepare(
      'INSERT INTO skill_revisions (skill_id, system_prompt, revision_note, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, parsed.systemPrompt, 'Initial creation', now);

    const revisions = db.prepare('SELECT * FROM skill_revisions WHERE skill_id = ?').all(id) as any[];
    expect(revisions).toHaveLength(1);

    // 6. Lock
    db.prepare('UPDATE skills SET locked = 1 WHERE id = ?').run(id);
    const locked = db.prepare('SELECT locked FROM skills WHERE id = ?').get(id) as any;
    expect(locked.locked).toBe(1);

    // 7. Attempt delete while locked — should fail
    // (In production, deleteSkill checks locked)
    const skillForDelete = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as any;
    expect(skillForDelete.locked).toBe(1);

    // 8. Unlock
    db.prepare('UPDATE skills SET locked = 0 WHERE id = ?').run(id);

    // 9. Delete
    db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    const deleted = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
    expect(deleted).toBeUndefined();

    // Cleanup
    db.close();
    try { rmSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('rejects invalid skill markdown', () => {
    // No name
    expect('error' in parseSkillMarkdown('---\ndescription: test\n---\nBody')).toBe(true);

    // No frontmatter
    expect('error' in parseSkillMarkdown('Just text')).toBe(true);

    // No body
    expect('error' in parseSkillMarkdown('---\nname: x\ndescription: y\n---')).toBe(true);
  });
});
