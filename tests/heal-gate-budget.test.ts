/**
 * Budget cap on the delivery gate. A wall-clock breach must ABORT scoring and
 * return a reject (fail-closed) that leaves the live skill untouched and counts
 * toward the reject ceiling. Deterministic via an injected clock + a scorer that
 * advances it, so no real time passes.
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
  initAutoSkillsTables, recordSkillEvalCase, gateHealCandidate, type ReplayScorer,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';

const OLD = 'OLD PROMPT';
const NEW = 'NEW PROMPT THAT IS LONG ENOUGH TO BE A REAL REWRITE';
function makeSkill(): Skill {
  return { id: 'auto-demo', name: 'demo', description: 'd', system_prompt: OLD,
    allowed_tools: null, is_builtin: 0, source_file: null, locked: 0,
    created_at: Date.now(), updated_at: Date.now() } as Skill;
}

async function createTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await testKnex.schema.createTable('skills', (t) => {
    t.text('id').primary(); t.text('name').notNullable().unique();
    t.text('description').notNullable(); t.text('system_prompt').notNullable();
    t.text('allowed_tools'); t.integer('is_builtin').notNullable().defaultTo(0);
    t.text('source_file'); t.integer('locked').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable(); t.bigInteger('updated_at').notNullable();
  });
  await testKnex.schema.createTable('skill_revisions', (t) => {
    t.increments('id').primary();
    t.text('skill_id').notNullable().references('id').inTable('skills').onDelete('CASCADE');
    t.text('system_prompt').notNullable(); t.text('revision_note'); t.bigInteger('created_at').notNullable();
  });
  await initAutoSkillsTables();
  await testKnex('skills').insert({ id: 'auto-demo', name: 'demo', description: 'd',
    system_prompt: OLD, is_builtin: 0, locked: 0, created_at: Date.now(), updated_at: Date.now() });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-in', contextSummary: '', qualityScore: 50, split: 'held_in' });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-out', contextSummary: '', qualityScore: 50, split: 'held_out' });
}

describe('gateHealCandidate budget cap', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('aborts as a reject when the wall-clock deadline is exceeded mid-replay', async () => {
    let t = 1000;
    let calls = 0;
    const clock = () => t;
    // Manual counter (repo style — see routerCalls in skill-heal-apply.test.ts).
    const slowScorer: ReplayScorer = async () => { calls++; t += 1000; return 90; };
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue', slowScorer, { budgetMs: 500, now: clock });
    expect(result.promote).toBe(false);
    expect(result.acceptance.reason).toMatch(/budget/i);
    // Stopped early: only the first batch (held_in, 1 case) scored before abort.
    expect(calls).toBe(1);
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD); // untouched
    const note = (await testKnex('skill_revisions').where({ skill_id: 'auto-demo' }).first()).revision_note;
    expect(note).toMatch(/^reject/i); // counts toward the ceiling
  });

  it('completes normally under a generous budget', async () => {
    const scorer: ReplayScorer = async (prompt) => (prompt === NEW ? 90 : 50);
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue', scorer, { budgetMs: 60_000 });
    expect(result.promote).toBe(true);
  });
});
