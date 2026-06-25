/**
 * heal-plan-gate-wiring — pins that healSkill inserts the plan-gate between
 * drafting and the delivery (replay) gate, so an obviously-bad candidate is
 * rejected cheaply without ever running the replay scorer.
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
  healSkill,
  type ReplayScorer,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';
import type { ProviderRouter } from '../src/providers/router.js';

const OLD = 'OLD PROMPT';

function makeSkill(): Skill {
  return {
    id: 'auto-demo', name: 'demo', description: 'd', system_prompt: OLD,
    allowed_tools: null, is_builtin: 0, source_file: null, locked: 0,
    created_at: Date.now(), updated_at: Date.now(),
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

describe('healSkill plan-gate wiring', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('rejects a no-op candidate at the plan-gate without running the delivery scorer', async () => {
    let scorerCalls = 0;
    const scorer: ReplayScorer = async () => { scorerCalls++; return 99; }; // would PROMOTE if ever reached
    const noopRouter = { sendMessage: async () => ({ text: OLD, provider: 'ollama' }) } as unknown as ProviderRouter;
    // planJudge stub avoids constructing a real ClaudeProvider; no-op rejects before it anyway.
    const result = await healSkill(makeSkill(), 'issue', 'ctx', noopRouter, 'auto-demo', scorer, async () => true);

    expect(result.patched).toBe(false);
    expect(scorerCalls).toBe(0);                     // delivery gate never ran
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD);            // untouched
    const note = (await testKnex('skill_revisions').where({ skill_id: 'auto-demo' }).first()).revision_note;
    expect(note).toMatch(/plan-gate/i);              // recorded → counts toward the ceiling
  });

  it('proceeds to the delivery gate for a plausible, non-trivial candidate', async () => {
    const NEW = 'A clearly different and sufficiently long rewritten skill prompt that fixes the reported issue.';
    let scorerCalls = 0;
    const scorer: ReplayScorer = async (prompt) => { scorerCalls++; return prompt === NEW ? 90 : 50; };
    const router = { sendMessage: async () => ({ text: NEW, provider: 'ollama' }) } as unknown as ProviderRouter;
    const result = await healSkill(makeSkill(), 'issue', 'ctx', router, 'auto-demo', scorer, async () => true);

    expect(scorerCalls).toBeGreaterThan(0);          // delivery gate ran
    expect(result.patched).toBe(true);               // promoted
  });
});
