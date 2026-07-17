/**
 * initBuiltinSkills builtin-prompt sync (spec 2026-07-17 §A).
 *
 * createSkillIfNotExists uses onConflict('id').ignore() — a shipped edit to a
 * BUILTIN_SKILLS systemPrompt would never reach a DB seeded by an older
 * build, and getSkillSystemPrompt serves the STORED prompt to BOTH provider
 * paths. The sync pass updates builtin rows whose stored prompt differs from
 * code, UNLESS the skill has skill_revisions rows (user revised it via the
 * AI fixer — user feedback outranks the shipped default).
 *
 * Also pins the spec §A.2 task-first override line in the debugger body.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { initBuiltinSkills, BUILTIN_SKILLS } from '../src/skills.js';
import { coreTableInit, getSkill, insertSkillRevision } from '../src/db-core.js';

const DEBUGGER = BUILTIN_SKILLS.find((s) => s.id === 'builtin-debugger')!;

describe('debugger systemPrompt content (spec 2026-07-17 §A.2)', () => {
  it('carries the task-first override verbatim, before PHASE 1', () => {
    expect(DEBUGGER.systemPrompt).toContain(
      'TASK-FIRST OVERRIDE: If the user\'s message is actually a task or a data lookup, do it first and investigate only what actually fails; do not preface execution with an investigation phase or clarifying questions the user already answered.',
    );
    expect(DEBUGGER.systemPrompt.indexOf('TASK-FIRST OVERRIDE'))
      .toBeLessThan(DEBUGGER.systemPrompt.indexOf('PHASE 1 — INVESTIGATE'));
  });

  it('keeps the real-debugging method intact (spec guardrail)', () => {
    for (const kept of ['PHASE 1 — INVESTIGATE', 'PHASE 2', 'PHASE 3', 'PHASE 4', 'CIRCUIT BREAKER', 'ANTI-RATIONALIZATION']) {
      expect(DEBUGGER.systemPrompt).toContain(kept);
    }
  });
});

describe('initBuiltinSkills sync (real in-memory DB)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  it('updates a stale builtin prompt from an older build', async () => {
    await initBuiltinSkills();
    // Simulate an older build's row
    await testKnex('skills').where({ id: 'builtin-debugger' }).update({ system_prompt: 'OLD SHIPPED PROMPT' });
    await initBuiltinSkills();
    const row = await getSkill('builtin-debugger');
    expect(row!.system_prompt).toBe(DEBUGGER.systemPrompt);
  });

  it('does NOT clobber a user-revised builtin (skill_revisions present)', async () => {
    await initBuiltinSkills();
    await testKnex('skills').where({ id: 'builtin-debugger' }).update({ system_prompt: 'USER-FIXED PROMPT' });
    await insertSkillRevision('builtin-debugger', 'USER-FIXED PROMPT', 'Fix: user feedback');
    await initBuiltinSkills();
    const row = await getSkill('builtin-debugger');
    expect(row!.system_prompt).toBe('USER-FIXED PROMPT');
  });

  it('is idempotent when prompts already match', async () => {
    await initBuiltinSkills();
    const before = await getSkill('builtin-debugger');
    await initBuiltinSkills();
    const after = await getSkill('builtin-debugger');
    expect(after!.system_prompt).toBe(before!.system_prompt);
    expect(after!.updated_at).toBe(before!.updated_at); // no gratuitous write
  });
});
