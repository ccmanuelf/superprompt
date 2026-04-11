import { describe, it, expect, vi } from 'vitest';

describe('tool-fixer', () => {
  it('rejects locked tools', async () => {
    const { fixTool } = await import('../src/forge/tool-fixer.js');
    const db = await import('../src/db-core.js');

    vi.spyOn(db, 'getUserTool').mockResolvedValue({
      id: 'test-tool-1',
      name: 'locked-tool',
      description: 'A locked tool',
      tool_type: 'declarative_http',
      config: '{}',
      enabled: 1,
      locked: 1,
      source_file: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const mockRouter = {} as any;
    const result = await fixTool('test-tool-1', 'fix this', 'chat1', mockRouter);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('locked');
    }

    vi.restoreAllMocks();
  });

  it('returns error for missing tool', async () => {
    const { fixTool } = await import('../src/forge/tool-fixer.js');
    const db = await import('../src/db-core.js');
    vi.spyOn(db, 'getUserTool').mockResolvedValue(undefined);

    const mockRouter = {} as any;
    const result = await fixTool('nonexistent', 'fix this', 'chat1', mockRouter);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not found');
    }

    vi.restoreAllMocks();
  });
});
