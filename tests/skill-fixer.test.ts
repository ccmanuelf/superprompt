import { describe, it, expect, vi } from 'vitest';

describe('skill-fixer', () => {
  it('rejects locked skills', async () => {
    // Import dynamically so we can mock
    const { fixSkill } = await import('../src/forge/skill-fixer.js');

    // Mock getSkill to return a locked skill
    const db = await import('../src/db-core.js');
    vi.spyOn(db, 'getSkill').mockResolvedValue({
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
    const db = await import('../src/db-core.js');
    vi.spyOn(db, 'getSkill').mockResolvedValue(undefined);

    const mockRouter = {} as any;
    const result = await fixSkill('nonexistent', 'fix this', 'chat1', mockRouter);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not found');
    }

    vi.restoreAllMocks();
  });
});
