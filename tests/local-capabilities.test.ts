import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';
import { estimateTokens } from '../src/context-budget.js';

// Hermetic in-memory Knex bootstrap — same pattern as
// tests/router-pinned-turns.test.ts. loadAllPacks()'s tool/skill import
// calls getKnex() (via db-core.ts / assumptions.ts); previously that threw
// "Knex not initialized" on every pack (caught per-file and merely logged),
// which depended on nothing but was noisy and untested-by-design. Wiring a
// real in-memory DB makes the pack-loading path actually exercised and
// removes any dependence on ambient process state or test ordering.
let testKnex: Knex;

vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});

describe('buildLocalCapabilitiesPrompt (Task 7b — capabilities diet for the local path)', () => {
  beforeAll(async () => {
    testKnex = createTestKnex();
    const { coreTableInit } = await import('../src/db-core.js');
    const { autoSkillsTableInit } = await import('../src/auto-skills.js');
    const { assumptionsTableInit } = await import('../src/assumptions.js');
    await coreTableInit.initTables();
    await autoSkillsTableInit.initTables();
    await assumptionsTableInit.initTables();

    // Populate the real pack registry from packs/*/pack.yaml (same source
    // getAggregatedCapabilities() reads) so the budget/content tests reflect
    // "all current packs enabled", not an empty registry.
    const { loadAllPacks } = await import('../src/packs.js');
    await loadAllPacks();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  it('hard budget: estimated tokens <= 800 with all current packs enabled', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const out = buildLocalCapabilitiesPrompt();
    expect(estimateTokens(out)).toBeLessThanOrEqual(800);
  });

  it('lists every enabled pack that getAggregatedCapabilities() would include', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const { getLoadedPacks } = await import('../src/packs.js');
    const out = buildLocalCapabilitiesPrompt();
    const enabledPacks = getLoadedPacks().filter((p) => p.enabled && p.capabilities);
    expect(enabledPacks.length).toBeGreaterThan(0);
    for (const pack of enabledPacks) {
      expect(out).toContain(pack.name);
    }
  });

  it('keeps action-critical facts: documents, memory, tasks, and which tool reaches web dashboards', async () => {
    const { buildLocalCapabilitiesPrompt } = await import('../src/capabilities.js');
    const out = buildLocalCapabilitiesPrompt();
    expect(out).toContain('generate_document');
    expect(out).toContain('query_memory');
    expect(out).toContain('kanban_manage');
    expect(out).toContain('/sim');
  });
});
