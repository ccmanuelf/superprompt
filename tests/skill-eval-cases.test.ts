/**
 * skill_eval_cases — the recorded examples a heal candidate is replayed against.
 *
 * Real SQLite, no mocks of the logic. Pins capture + retrieval + the per-split
 * FIFO cap that bounds replay cost (opportunity A1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  initAutoSkillsTables,
  recordSkillEvalCase,
  getSkillEvalCases,
  captureSuccessfulUse,
  MAX_EVAL_CASES_PER_SPLIT,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'auto-demo', name: 'demo', description: 'd', system_prompt: 'p',
    allowed_tools: null, is_builtin: 0, source_file: null, locked: 0,
    created_at: Date.now(), updated_at: Date.now(), ...over,
  } as Skill;
}

async function createTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await testKnex.schema.createTable('skills', (t) => {
    t.text('id').primary();
    t.text('name').notNullable().unique();
    t.text('description').notNullable();
    t.text('system_prompt').notNullable();
    t.text('allowed_tools');
    t.integer('is_builtin').notNullable().defaultTo(0);
    t.text('source_file');
    t.integer('locked').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await initAutoSkillsTables();
  await testKnex('skills').insert({
    id: 'auto-demo', name: 'demo', description: 'd', system_prompt: 'p',
    is_builtin: 0, locked: 0, created_at: Date.now(), updated_at: Date.now(),
  });
}

describe('skill_eval_cases', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('records and retrieves a case with its split and quality signal', async () => {
    await recordSkillEvalCase({
      skillId: 'auto-demo', userMessage: 'do the thing',
      contextSummary: 'it worked', qualityScore: 85, split: 'held_in',
    });
    const cases = await getSkillEvalCases('auto-demo');
    expect(cases).toHaveLength(1);
    expect(cases[0].split).toBe('held_in');
    expect(cases[0].user_message).toBe('do the thing');
    expect(cases[0].expected_signal).toBe(85);
  });

  it('keeps held_in and held_out as independent buckets', async () => {
    await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'a', contextSummary: '', qualityScore: 80, split: 'held_in' });
    await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'b', contextSummary: '', qualityScore: 75, split: 'held_out' });
    const cases = await getSkillEvalCases('auto-demo');
    expect(cases.filter((c) => c.split === 'held_in')).toHaveLength(1);
    expect(cases.filter((c) => c.split === 'held_out')).toHaveLength(1);
  });

  it('caps each split FIFO so replay cost stays bounded', async () => {
    const over = MAX_EVAL_CASES_PER_SPLIT + 2;
    for (let i = 0; i < over; i++) {
      await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: `msg-${i}`, contextSummary: '', qualityScore: 70, split: 'held_out' });
    }
    const held = (await getSkillEvalCases('auto-demo')).filter((c) => c.split === 'held_out');
    expect(held).toHaveLength(MAX_EVAL_CASES_PER_SPLIT);
    // Oldest (msg-0, msg-1) evicted; newest retained.
    expect(held.some((c) => c.user_message === 'msg-0')).toBe(false);
    expect(held.some((c) => c.user_message === `msg-${over - 1}`)).toBe(true);
  });
});

describe('captureSuccessfulUse', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('seeds the first successful use as a held_in case', async () => {
    await captureSuccessfulUse({ skill: makeSkill(), userMessage: 'u1', responseText: 'r1', qualityScore: 85 });
    const cases = await getSkillEvalCases('auto-demo');
    expect(cases).toHaveLength(1);
    expect(cases[0].split).toBe('held_in');
  });

  it('records later successful uses as held_out cases', async () => {
    await captureSuccessfulUse({ skill: makeSkill(), userMessage: 'u1', responseText: 'r1', qualityScore: 85 });
    await captureSuccessfulUse({ skill: makeSkill(), userMessage: 'u2', responseText: 'r2', qualityScore: 90 });
    const cases = await getSkillEvalCases('auto-demo');
    expect(cases.filter((c) => c.split === 'held_in')).toHaveLength(1);
    expect(cases.filter((c) => c.split === 'held_out')).toHaveLength(1);
  });

  it('ignores builtin/non-auto skills', async () => {
    await captureSuccessfulUse({ skill: makeSkill({ id: 'builtin-x', is_builtin: 1 }), userMessage: 'u', responseText: 'r', qualityScore: 90 });
    expect(await getSkillEvalCases('builtin-x')).toHaveLength(0);
  });

  it('ignores low-quality uses (a gap, not an example to preserve)', async () => {
    await captureSuccessfulUse({ skill: makeSkill(), userMessage: 'u', responseText: 'r', qualityScore: 40 });
    expect(await getSkillEvalCases('auto-demo')).toHaveLength(0);
  });
});
