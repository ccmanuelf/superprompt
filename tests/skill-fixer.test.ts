import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// We test the fixer logic by mocking the DB and router
const TMP_DIR = resolve(tmpdir(), 'clauded-test-skill-fixer');

describe('skill-fixer', () => {
  it('rejects locked skills', async () => {
    // Import dynamically so we can mock
    const { fixSkill } = await import('../src/forge/skill-fixer.js');

    // Mock getSkill to return a locked skill
    const db = await import('../src/db.js');
    vi.spyOn(db, 'getSkill').mockReturnValue({
      id: 'test-1',
      name: 'locked-skill',
      description: 'A locked skill',
      system_prompt: 'original prompt',
      allowed_tools: null,
      is_builtin: 0,
      source_file: null,
      locked: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const mockRouter = {} as any;
    const result = await fixSkill('test-1', 'fix this', 'chat1', mockRouter);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('locked');
    }

    vi.restoreAllMocks();
  });

  it('returns error for missing skill', async () => {
    const { fixSkill } = await import('../src/forge/skill-fixer.js');
    const db = await import('../src/db.js');
    vi.spyOn(db, 'getSkill').mockReturnValue(undefined);

    const mockRouter = {} as any;
    const result = await fixSkill('nonexistent', 'fix this', 'chat1', mockRouter);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not found');
    }

    vi.restoreAllMocks();
  });
});
