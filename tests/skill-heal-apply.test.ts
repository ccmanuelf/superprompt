/**
 * gateHealCandidate — the applying gate for skill self-healing.
 *
 * Real SQLite + an injected deterministic scorer (no LLM). Pins that a candidate
 * prompt is promoted only when it passes the non-regression rule, that rejects
 * leave the live skill untouched, and that every attempt records a structured
 * insight note (A2 + A3).
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
  gateHealCandidate,
  healSkill,
  countConsecutiveHealRejections,
  MAX_CONSECUTIVE_HEAL_REJECTS,
  type ReplayScorer,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';
import type { ProviderRouter } from '../src/providers/router.js';

/** Counts draft attempts so tests can prove a heal short-circuited BEFORE drafting. */
let routerCalls = 0;
const countingRouter = {
  sendMessage: async () => { routerCalls++; return { text: 'x'.repeat(80), provider: 'ollama' }; },
} as unknown as ProviderRouter;

const OLD = 'OLD PROMPT';
const NEW = 'NEW PROMPT';

function makeSkill(): Skill {
  return {
    id: 'auto-demo', name: 'demo', description: 'd', system_prompt: OLD,
    allowed_tools: null, is_builtin: 0, source_file: null, locked: 0,
    created_at: Date.now(), updated_at: Date.now(),
  } as Skill;
}

/** Scores the NEW prompt at `candScore`, everything else (the OLD prompt) at 50. */
const scorerWhereNewIs = (candScore: number): ReplayScorer =>
  async (prompt: string) => (prompt === NEW ? candScore : 50);

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
  await testKnex.schema.createTable('skill_revisions', (t) => {
    t.increments('id').primary();
    t.text('skill_id').notNullable().references('id').inTable('skills').onDelete('CASCADE');
    t.text('system_prompt').notNullable();
    t.text('revision_note');
    t.bigInteger('created_at').notNullable();
  });
  await initAutoSkillsTables();
  await testKnex('skills').insert({
    id: 'auto-demo', name: 'demo', description: 'd', system_prompt: OLD,
    is_builtin: 0, locked: 0, created_at: Date.now(), updated_at: Date.now(),
  });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-in', contextSummary: '', qualityScore: 50, split: 'held_in' });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-out', contextSummary: '', qualityScore: 50, split: 'held_out' });
}

describe('gateHealCandidate', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('promotes a candidate that beats the current prompt and writes it live', async () => {
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue x', scorerWhereNewIs(90));
    expect(result.promote).toBe(true);
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(NEW);
  });

  it('rejects a regressing candidate and leaves the live skill untouched', async () => {
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue x', scorerWhereNewIs(40));
    expect(result.promote).toBe(false);
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD);
  });

  it('records a structured insight note on promote AND on reject', async () => {
    await gateHealCandidate(makeSkill(), NEW, 'issue P', scorerWhereNewIs(90));
    await gateHealCandidate(makeSkill(), NEW, 'issue R', scorerWhereNewIs(40));
    const notes = (await testKnex('skill_revisions').where({ skill_id: 'auto-demo' }).select('revision_note'))
      .map((r: { revision_note: string }) => r.revision_note);
    expect(notes.some((n) => /promote/i.test(n))).toBe(true);
    expect(notes.some((n) => /reject/i.test(n))).toBe(true);
  });

  it('refuses to promote when there is no eval coverage to verify against', async () => {
    await testKnex('skill_eval_cases').where({ skill_id: 'auto-demo' }).del();
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue x', scorerWhereNewIs(99));
    expect(result.promote).toBe(false);
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD);
  });
});

describe('heal stop ceiling (A4)', () => {
  beforeEach(async () => { await createTestDb(); routerCalls = 0; });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  async function addRevision(note: string): Promise<void> {
    await testKnex('skill_revisions').insert({
      skill_id: 'auto-demo', system_prompt: OLD, revision_note: note, created_at: Date.now(),
    });
  }

  it('counts only the most-recent run of consecutive rejections', async () => {
    await addRevision('promote: Δ_in=5');
    await addRevision('reject: Δ_in=-2');
    await addRevision('reject: Δ_in=-4');
    expect(await countConsecutiveHealRejections('auto-demo')).toBe(2);
  });

  it('resets the count when the latest attempt was a promotion', async () => {
    await addRevision('reject: Δ_in=-2');
    await addRevision('promote: Δ_in=5');
    expect(await countConsecutiveHealRejections('auto-demo')).toBe(0);
  });

  it('pauses healing (no draft) once the ceiling of consecutive rejects is hit', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_HEAL_REJECTS; i++) await addRevision('reject: Δ_in=-1');
    const result = await healSkill(makeSkill(), 'issue', 'ctx', countingRouter, 'auto-demo');
    expect(result.patched).toBe(false);
    expect(routerCalls).toBe(0); // proves no draft was attempted
  });

  it('skips drafting entirely when the skill has no eval coverage yet', async () => {
    await testKnex('skill_eval_cases').where({ skill_id: 'auto-demo' }).del();
    const result = await healSkill(makeSkill(), 'issue', 'ctx', countingRouter, 'auto-demo');
    expect(result.patched).toBe(false);
    expect(routerCalls).toBe(0); // proves no wasted draft
  });
});
