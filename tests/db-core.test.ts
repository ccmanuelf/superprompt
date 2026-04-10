import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getKnex: () => testKnex,
    getDbDriver: () => 'sqlite',
    initKnex: () => testKnex,
    destroyKnex: async () => { if (testKnex) await testKnex.destroy(); },
  };
});

vi.mock('../src/config.js', () => ({
  STORE_DIR: '/tmp/clauded-test',
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  coreTableInit,
  // Sessions
  getSession, setSession, updateSessionProvider, updateSessionOllamaModel,
  clearSession, setAutoRoute, isAutoRouteEnabled,
  // Memories
  insertMemory, getRecentMemories, touchMemory, deleteMemory, decayMemories,
  getMemoriesByChatId, getUnembeddedMemoryCount, getUnembeddedMemories,
  getCompressibleMemories, getChatsWithCompressibleMemories, deleteMemories,
  // Tasks
  createTask, getDueTasks, updateTaskAfterRun, pauseTask, resumeTask,
  deleteTask, getTasksByChat, getTask,
  // Skills
  createSkill, createSkillIfNotExists, getSkill, getSkillByName, listSkills,
  updateSkill, deleteSkill, setActiveSkill, getActiveSkill, clearActiveSkill,
  setActiveSkillAutoTriggered, isSkillAutoTriggered, decrementSkillTurns,
  lockSkill, unlockSkill, insertSkillRevision, getSkillRevisions,
  // User Tools
  createUserTool, getUserTool, getUserToolByName, listUserTools,
  updateUserTool, deleteUserTool, enableUserTool, disableUserTool,
  lockUserTool, unlockUserTool, insertToolRevision, getToolRevisions,
  // Episodes
  insertEpisode, getCompressibleMemories as _gc, closeDatabase,
} from '../src/db-core.js';

describe('db-core (Knex)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  // ── Sessions ─────────────────────────────────────────

  describe('sessions', () => {
    it('creates and retrieves a session', async () => {
      await setSession('chat1', 'sess-abc', 'claude');
      const s = await getSession('chat1');
      expect(s).toBeDefined();
      expect(s!.session_id).toBe('sess-abc');
      expect(s!.provider).toBe('claude');
    });

    it('upserts on conflict', async () => {
      await setSession('chat1', 'sess-1', 'claude');
      await setSession('chat1', 'sess-2', 'ollama');
      const s = await getSession('chat1');
      expect(s!.session_id).toBe('sess-2');
      expect(s!.provider).toBe('ollama');
    });

    it('updates provider', async () => {
      await setSession('chat1', 'sess-1', 'claude');
      await updateSessionProvider('chat1', 'ollama');
      expect((await getSession('chat1'))!.provider).toBe('ollama');
    });

    it('updates ollama model', async () => {
      await setSession('chat1', 'sess-1', 'ollama');
      await updateSessionOllamaModel('chat1', 'qwen3.5:latest');
      expect((await getSession('chat1'))!.ollama_model).toBe('qwen3.5:latest');
    });

    it('clears session', async () => {
      await setSession('chat1', 'sess-1', 'claude');
      await clearSession('chat1');
      expect(await getSession('chat1')).toBeUndefined();
    });

    it('manages auto-route', async () => {
      expect(await isAutoRouteEnabled('chat1')).toBe(false);
      await setAutoRoute('chat1', true);
      expect(await isAutoRouteEnabled('chat1')).toBe(true);
      await setAutoRoute('chat1', false);
      expect(await isAutoRouteEnabled('chat1')).toBe(false);
    });
  });

  // ── Memories ─────────────────────────────────────────

  describe('memories', () => {
    it('inserts and retrieves memories', async () => {
      const id = await insertMemory('chat1', 'User prefers Lean methodology', 'semantic');
      expect(id).toBeGreaterThan(0);

      const mems = await getRecentMemories('chat1');
      expect(mems).toHaveLength(1);
      expect(mems[0].content).toBe('User prefers Lean methodology');
      expect(mems[0].sector).toBe('semantic');
    });

    it('touches memory (updates accessed_at)', async () => {
      const id = await insertMemory('chat1', 'test', 'semantic');
      const before = (await getRecentMemories('chat1'))[0].accessed_at;
      await new Promise(r => setTimeout(r, 10));
      await touchMemory(id);
      const after = (await getRecentMemories('chat1'))[0].accessed_at;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('deletes memory', async () => {
      const id = await insertMemory('chat1', 'to-delete', 'episodic');
      await deleteMemory(id);
      expect(await getRecentMemories('chat1')).toHaveLength(0);
    });

    it('decays memories', async () => {
      await insertMemory('chat1', 'will-decay', 'semantic');
      const before = (await getRecentMemories('chat1'))[0].salience;
      await decayMemories(0.5);
      const after = (await getRecentMemories('chat1'))[0].salience;
      expect(after).toBeLessThan(before);
    });

    it('scopes by chat_id', async () => {
      await insertMemory('chat1', 'for-chat1', 'semantic');
      await insertMemory('chat2', 'for-chat2', 'semantic');
      expect(await getRecentMemories('chat1')).toHaveLength(1);
      expect(await getRecentMemories('chat2')).toHaveLength(1);
    });

    it('counts unembedded memories', async () => {
      await insertMemory('chat1', 'no-embedding', 'semantic');
      expect(await getUnembeddedMemoryCount()).toBe(1);
    });

    it('getCompressibleMemories returns episodic with low salience', async () => {
      await insertMemory('chat1', 'will-compress', 'episodic');
      // Manually set salience low
      await testKnex('memories').where({ chat_id: 'chat1' }).update({ salience: 0.2 });
      const compressible = await getCompressibleMemories('chat1');
      expect(compressible).toHaveLength(1);
    });

    it('deleteMemories batch delete', async () => {
      const id1 = await insertMemory('chat1', 'one', 'episodic');
      const id2 = await insertMemory('chat1', 'two', 'episodic');
      await deleteMemories([id1, id2]);
      expect(await getRecentMemories('chat1')).toHaveLength(0);
    });
  });

  // ── Scheduled Tasks ──────────────────────────────────

  describe('scheduled tasks', () => {
    it('creates and retrieves task', async () => {
      await createTask('t1', 'chat1', 'daily report', '0 9 * * *', Date.now() + 86400000);
      const t = await getTask('t1');
      expect(t).toBeDefined();
      expect(t!.prompt).toBe('daily report');
    });

    it('gets due tasks', async () => {
      await createTask('t1', 'chat1', 'due now', '* * * * *', Date.now() - 1000);
      await createTask('t2', 'chat1', 'future', '* * * * *', Date.now() + 999999);
      const due = await getDueTasks();
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('t1');
    });

    it('pauses and resumes', async () => {
      await createTask('t1', 'chat1', 'test', '* * * * *', Date.now());
      await pauseTask('t1');
      expect((await getTask('t1'))!.status).toBe('paused');
      await resumeTask('t1');
      expect((await getTask('t1'))!.status).toBe('active');
    });

    it('deletes task', async () => {
      await createTask('t1', 'chat1', 'test', '* * * * *', Date.now());
      await deleteTask('t1');
      expect(await getTask('t1')).toBeUndefined();
    });

    it('getTasksByChat scopes correctly', async () => {
      await createTask('t1', 'chat1', 'a', '* * * * *', Date.now());
      await createTask('t2', 'chat2', 'b', '* * * * *', Date.now());
      expect(await getTasksByChat('chat1')).toHaveLength(1);
    });
  });

  // ── Skills ───────────────────────────────────────────

  describe('skills', () => {
    it('creates and retrieves skill', async () => {
      await createSkill('s1', 'debugger', 'Debug things', 'You are a debugger');
      const s = await getSkill('s1');
      expect(s).toBeDefined();
      expect(s!.name).toBe('debugger');
    });

    it('createSkillIfNotExists does not overwrite', async () => {
      await createSkill('s1', 'original', 'desc', 'prompt');
      await createSkillIfNotExists('s1', 'modified', 'desc2', 'prompt2');
      expect((await getSkill('s1'))!.name).toBe('original');
    });

    it('lists skills', async () => {
      await createSkill('s1', 'alpha', 'd', 'p');
      await createSkill('s2', 'beta', 'd', 'p');
      expect(await listSkills()).toHaveLength(2);
    });

    it('updates skill', async () => {
      await createSkill('s1', 'old', 'desc', 'old prompt');
      await updateSkill('s1', { systemPrompt: 'new prompt' });
      expect((await getSkill('s1'))!.system_prompt).toBe('new prompt');
    });

    it('deletes non-builtin skill', async () => {
      await createSkill('s1', 'custom', 'desc', 'prompt', null, false);
      expect(await deleteSkill('s1')).toBe(true);
      expect(await getSkill('s1')).toBeUndefined();
    });

    it('refuses to delete builtin skill', async () => {
      await createSkill('s1', 'builtin', 'desc', 'prompt', null, true);
      await expect(deleteSkill('s1')).rejects.toThrow(/built-in/);
    });

    it('manages active skill per chat', async () => {
      await createSkill('s1', 'skill1', 'd', 'p');
      await setActiveSkill('chat1', 's1');
      const active = await getActiveSkill('chat1');
      expect(active).toBeDefined();
      expect(active!.id).toBe('s1');
      await clearActiveSkill('chat1');
      expect(await getActiveSkill('chat1')).toBeUndefined();
    });

    it('auto-triggered skill decrements turns', async () => {
      await createSkill('s1', 'auto', 'd', 'p');
      await setActiveSkillAutoTriggered('chat1', 's1', 3);
      expect(await isSkillAutoTriggered('chat1')).toBe(true);
      expect(await decrementSkillTurns('chat1')).toBe(false); // 3→2
      expect(await decrementSkillTurns('chat1')).toBe(false); // 2→1
      expect(await decrementSkillTurns('chat1')).toBe(true);  // 1→0 = exhausted
    });

    it('locks and unlocks skill', async () => {
      await createSkill('s1', 'lockable', 'd', 'p');
      await lockSkill('s1');
      expect((await getSkill('s1'))!.locked).toBe(1);
      await unlockSkill('s1');
      expect((await getSkill('s1'))!.locked).toBe(0);
    });

    it('manages skill revisions', async () => {
      await createSkill('s1', 'rev-test', 'd', 'original');
      const revId = await insertSkillRevision('s1', 'original', 'Initial');
      expect(revId).toBeGreaterThan(0);
      const revs = await getSkillRevisions('s1');
      expect(revs).toHaveLength(1);
      expect(revs[0].revision_note).toBe('Initial');
    });
  });

  // ── User Tools ───────────────────────────────────────

  describe('user tools', () => {
    it('creates and retrieves tool', async () => {
      await createUserTool('t1', 'my-tool', 'A tool', 'declarative_http', '{}');
      const t = await getUserTool('t1');
      expect(t).toBeDefined();
      expect(t!.name).toBe('my-tool');
      expect(t!.enabled).toBe(1);
    });

    it('finds by name', async () => {
      await createUserTool('t1', 'unique-name', 'desc', 'generated_code', '{}');
      expect(await getUserToolByName('unique-name')).toBeDefined();
      expect(await getUserToolByName('nonexistent')).toBeUndefined();
    });

    it('lists tools', async () => {
      await createUserTool('t1', 'alpha', 'd', 'declarative_http', '{}');
      await createUserTool('t2', 'beta', 'd', 'declarative_http', '{}');
      expect(await listUserTools()).toHaveLength(2);
    });

    it('enables and disables', async () => {
      await createUserTool('t1', 'toggle', 'd', 'declarative_http', '{}');
      await disableUserTool('t1');
      expect((await getUserTool('t1'))!.enabled).toBe(0);
      await enableUserTool('t1');
      expect((await getUserTool('t1'))!.enabled).toBe(1);
    });

    it('deletes tool', async () => {
      await createUserTool('t1', 'delete-me', 'd', 'declarative_http', '{}');
      expect(await deleteUserTool('t1')).toBe(true);
      expect(await getUserTool('t1')).toBeUndefined();
    });

    it('manages tool revisions', async () => {
      await createUserTool('t1', 'rev-tool', 'd', 'declarative_http', '{"v":1}');
      const revId = await insertToolRevision('t1', '{"v":1}', 'Initial');
      expect(revId).toBeGreaterThan(0);
      const revs = await getToolRevisions('t1');
      expect(revs).toHaveLength(1);
    });
  });

  // ── Episodes ─────────────────────────────────────────

  describe('episodes', () => {
    it('inserts episode', async () => {
      const id = await insertEpisode('chat1', 'Summary of events', ['fact1'], ['thread1'], 5);
      expect(id).toBeGreaterThan(0);
    });
  });
});
