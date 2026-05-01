import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  initAssumptionTables,
  setAssumption,
  retireAssumption,
  getAssumptionById,
  listAssumptions,
  listMetricDependencies,
  resolveAssumption,
  resolveAssumptionsForMetric,
  ASSUMPTION_DEFAULTS,
} from '../src/assumptions.js';

async function freshDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initAssumptionTables();
}

beforeEach(async () => { await freshDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

describe('schema + seed data', () => {
  it('creates the three tables and seeds metric dependencies', async () => {
    expect(await testKnex.schema.hasTable('luna_assumptions')).toBe(true);
    expect(await testKnex.schema.hasTable('luna_assumption_changes')).toBe(true);
    expect(await testKnex.schema.hasTable('luna_metric_assumption_dependencies')).toBe(true);

    const deps = await listMetricDependencies();
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.find((d) => d.metric_name === 'oee')).toBeTruthy();
  });

  it('listMetricDependencies filters by metric_name', async () => {
    const oeeDeps = await listMetricDependencies('oee');
    expect(oeeDeps.length).toBeGreaterThan(0);
    expect(oeeDeps.every((d) => d.metric_name === 'oee')).toBe(true);
  });

  it('built-in catalog stays under the v1 cap of 15', () => {
    expect(Object.keys(ASSUMPTION_DEFAULTS).length).toBeLessThanOrEqual(15);
  });
});

describe('setAssumption + audit log', () => {
  it('creates a new active record and logs to changes', async () => {
    const created = await setAssumption({
      scope_type: 'global',
      scope_id: null,
      assumption_name: 'ideal_cycle_time_source',
      value: 'measured_average',
      rationale: 'Switching to measured for this site',
      created_by: 'manuel',
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('active');
    expect(created.value).toBe('measured_average');

    const changes = await testKnex('luna_assumption_changes').where({ assumption_id: created.id });
    expect(changes).toHaveLength(1);
    expect(changes[0].change_reason).toBe('created');
  });

  it('updates existing same-scope record and logs the change with previous value', async () => {
    await setAssumption({
      scope_type: 'global',
      scope_id: null,
      assumption_name: 'monte_carlo_default_iterations',
      value: 500,
      rationale: 'Initial',
      created_by: 'manuel',
    });
    const updated = await setAssumption({
      scope_type: 'global',
      scope_id: null,
      assumption_name: 'monte_carlo_default_iterations',
      value: 2000,
      rationale: 'More replications for confidence',
      created_by: 'manuel',
      change_reason: 'tuning',
    });
    expect(updated.value).toBe(2000);

    const changes = await testKnex('luna_assumption_changes').where({ assumption_id: updated.id }).orderBy('changed_at');
    expect(changes).toHaveLength(2);
    expect(JSON.parse(changes[1].previous_value as string)).toBe(500);
    expect(JSON.parse(changes[1].new_value as string)).toBe(2000);
    expect(changes[1].change_reason).toBe('tuning');
  });
});

describe('retireAssumption', () => {
  it('soft-deletes by setting status=retired and logs the change', async () => {
    const created = await setAssumption({
      scope_type: 'global',
      scope_id: null,
      assumption_name: 'setup_treatment',
      value: 'amortize',
      rationale: 'test',
      created_by: 'manuel',
    });
    const ok = await retireAssumption(created.id, 'manuel', 'reverted policy');
    expect(ok).toBe(true);

    const after = await getAssumptionById(created.id);
    expect(after?.status).toBe('retired');

    const changes = await testKnex('luna_assumption_changes').where({ assumption_id: created.id });
    expect(changes).toHaveLength(2);
    expect(changes[1].change_reason).toBe('reverted policy');
  });

  it('returns false when the id is unknown or already retired', async () => {
    expect(await retireAssumption('does-not-exist', 'manuel')).toBe(false);
  });
});

describe('listAssumptions', () => {
  it('filters by scope_type and status', async () => {
    await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'ideal_cycle_time_source', value: 'engineered_standard',
      rationale: '', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'pack', scope_id: 'manufacturing',
      assumption_name: 'ideal_cycle_time_source', value: 'measured_average',
      rationale: '', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'user', scope_id: 'u123',
      assumption_name: 'ideal_cycle_time_source', value: 'best_observed',
      rationale: '', created_by: 'manuel',
    });

    const globals = await listAssumptions({ scope_type: 'global' });
    expect(globals).toHaveLength(1);

    const packs = await listAssumptions({ scope_type: 'pack' });
    expect(packs).toHaveLength(1);
    expect(packs[0].scope_id).toBe('manufacturing');
  });
});

describe('resolveAssumption — precedence', () => {
  it('falls back to built-in default when no DB record exists', async () => {
    const resolved = await resolveAssumption('ideal_cycle_time_source');
    expect(resolved.sourceScope).toBe('default');
    expect(resolved.value).toBe('engineered_standard');
  });

  it('global beats default', async () => {
    await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'ideal_cycle_time_source', value: 'measured_average',
      rationale: 'plant-wide policy', created_by: 'manuel',
    });
    const resolved = await resolveAssumption('ideal_cycle_time_source');
    expect(resolved.sourceScope).toBe('global');
    expect(resolved.value).toBe('measured_average');
  });

  it('pack beats global, in activation order (first match wins)', async () => {
    await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'setup_treatment', value: 'include_in_capacity',
      rationale: '', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'pack', scope_id: 'manufacturing',
      assumption_name: 'setup_treatment', value: 'separate',
      rationale: 'manufacturing pack policy', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'pack', scope_id: 'finance',
      assumption_name: 'setup_treatment', value: 'amortize',
      rationale: 'finance pack policy', created_by: 'manuel',
    });

    // Activation order [manufacturing, finance] → manufacturing wins
    const a = await resolveAssumption('setup_treatment', { activePacks: ['manufacturing', 'finance'] });
    expect(a.sourceScope).toBe('pack');
    expect(a.scopeId).toBe('manufacturing');
    expect(a.value).toBe('separate');

    // Reversed order → finance wins
    const b = await resolveAssumption('setup_treatment', { activePacks: ['finance', 'manufacturing'] });
    expect(b.sourceScope).toBe('pack');
    expect(b.scopeId).toBe('finance');
    expect(b.value).toBe('amortize');
  });

  it('user beats pack and global', async () => {
    await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'monte_carlo_default_iterations', value: 100,
      rationale: '', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'pack', scope_id: 'manufacturing',
      assumption_name: 'monte_carlo_default_iterations', value: 500,
      rationale: '', created_by: 'manuel',
    });
    await setAssumption({
      scope_type: 'user', scope_id: 'u123',
      assumption_name: 'monte_carlo_default_iterations', value: 5000,
      rationale: 'I want tight CIs', created_by: 'u123',
    });

    const resolved = await resolveAssumption('monte_carlo_default_iterations', {
      userId: 'u123',
      activePacks: ['manufacturing'],
    });
    expect(resolved.sourceScope).toBe('user');
    expect(resolved.value).toBe(5000);
  });

  it('retired records are skipped during resolution', async () => {
    const created = await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'yield_baseline_source', value: 'final_yield',
      rationale: '', created_by: 'manuel',
    });
    await retireAssumption(created.id, 'manuel', 'wrong policy');
    const resolved = await resolveAssumption('yield_baseline_source');
    expect(resolved.sourceScope).toBe('default');
    expect(resolved.value).toBe('first_pass_yield');
  });

  it('records outside their effective window are skipped', async () => {
    const future = Date.now() + 1000 * 60 * 60 * 24; // tomorrow
    await setAssumption({
      scope_type: 'global', scope_id: null,
      assumption_name: 'availability_calculation_basis', value: 'total_uptime',
      rationale: '', created_by: 'manuel',
      effective_date: future,
    });
    const resolved = await resolveAssumption('availability_calculation_basis');
    expect(resolved.sourceScope).toBe('default');
    expect(resolved.value).toBe('scheduled_uptime');
  });

  it('unknown name returns null with a warning rationale', async () => {
    const resolved = await resolveAssumption('this_name_does_not_exist_anywhere');
    expect(resolved.value).toBeNull();
    expect(resolved.sourceScope).toBe('default');
    expect(resolved.rationale).toMatch(/UNKNOWN ASSUMPTION/);
  });
});

describe('resolveAssumptionsForMetric', () => {
  it('returns a map keyed by assumption_name for the metric dependencies', async () => {
    const map = await resolveAssumptionsForMetric('oee');
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(map.availability_calculation_basis).toBeTruthy();
    expect(map.availability_calculation_basis.sourceScope).toBe('default');
  });

  it('honors precedence within the metric resolution', async () => {
    await setAssumption({
      scope_type: 'pack', scope_id: 'manufacturing',
      assumption_name: 'availability_calculation_basis', value: 'total_uptime',
      rationale: 'pack override', created_by: 'manuel',
    });
    const map = await resolveAssumptionsForMetric('oee', { activePacks: ['manufacturing'] });
    expect(map.availability_calculation_basis.sourceScope).toBe('pack');
    expect(map.availability_calculation_basis.value).toBe('total_uptime');
  });
});
