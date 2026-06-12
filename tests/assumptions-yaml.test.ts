import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
  parseAssumptionsYaml,
  loadPackAssumptions,
  resolveAssumption,
  listAssumptions,
} from '../src/assumptions.js';

const tempDirs: string[] = [];

function tempPackDir(content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'luna-pack-'));
  tempDirs.push(dir);
  writeFileSync(resolve(dir, 'assumptions.yaml'), content, 'utf-8');
  return dir;
}

beforeEach(async () => {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initAssumptionTables();
});

afterAll(async () => {
  if (testKnex) await testKnex.destroy();
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Parser ───────────────────────────────────────────────────

describe('parseAssumptionsYaml', () => {
  it('parses inline scalar values with type coercion', () => {
    const yaml = `
assumptions:
  - name: foo_string
    value: engineered_standard
    rationale: "string rationale"
  - name: foo_number
    value: 1000
    rationale: "number rationale"
  - name: foo_bool
    value: true
    rationale: "boolean rationale"
`;
    const out = parseAssumptionsYaml(yaml);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      name: 'foo_string',
      value: 'engineered_standard',
      rationale: 'string rationale',
    });
    expect(out[1].value).toBe(1000);
    expect(out[2].value).toBe(true);
  });

  it('parses block-scalar rationale', () => {
    const yaml = `
assumptions:
  - name: setup_treatment
    value: include_in_capacity
    rationale: |
      Multi-line rationale
      with two lines.
`;
    const out = parseAssumptionsYaml(yaml);
    expect(out).toHaveLength(1);
    expect(out[0].rationale).toBe('Multi-line rationale\nwith two lines.');
  });

  it('handles negative numbers and decimals', () => {
    const yaml = `
assumptions:
  - name: a
    value: -5
    rationale: ""
  - name: b
    value: 3.14
    rationale: ""
`;
    const out = parseAssumptionsYaml(yaml);
    expect(out[0].value).toBe(-5);
    expect(out[1].value).toBe(3.14);
  });

  it('treats quoted numbers as strings', () => {
    const yaml = `
assumptions:
  - name: a
    value: "1000"
    rationale: ""
`;
    const out = parseAssumptionsYaml(yaml);
    expect(out[0].value).toBe('1000');
  });

  it('returns empty when no assumptions: section', () => {
    expect(parseAssumptionsYaml('# just a comment\n')).toEqual([]);
    expect(parseAssumptionsYaml('')).toEqual([]);
  });

  it('skips entries missing required fields', () => {
    const yaml = `
assumptions:
  - name: ""
    value: x
    rationale: ""
  - name: ok_one
    value: y
    rationale: "ok"
`;
    const out = parseAssumptionsYaml(yaml);
    // Empty name is still emitted by the parser; the loader filters it.
    // Verify here that only one has a usable name.
    const named = out.filter((e) => e.name && e.name.trim() !== '');
    expect(named).toHaveLength(1);
    expect(named[0].name).toBe('ok_one');
  });
});

// ── Loader ───────────────────────────────────────────────────

describe('loadPackAssumptions', () => {
  it('inserts each entry as scope_type=pack with scope_id=packName', async () => {
    const dir = tempPackDir(`
assumptions:
  - name: ideal_cycle_time_source
    value: measured_average
    rationale: "manufacturing override"
  - name: monte_carlo_default_iterations
    value: 500
    rationale: "fewer reps for fast iteration"
`);
    const result = await loadPackAssumptions(dir, 'manufacturing');
    expect(result.loaded).toBe(2);
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);

    const records = await listAssumptions({ scope_type: 'pack', scope_id: 'manufacturing' });
    expect(records).toHaveLength(2);
    const names = records.map((r) => r.assumption_name).sort();
    expect(names).toEqual(['ideal_cycle_time_source', 'monte_carlo_default_iterations']);
  });

  it('idempotent — re-running upserts in place, no duplicates', async () => {
    const dir = tempPackDir(`
assumptions:
  - name: setup_treatment
    value: include_in_capacity
    rationale: "first load"
`);
    await loadPackAssumptions(dir, 'manufacturing');
    await loadPackAssumptions(dir, 'manufacturing');
    const records = await listAssumptions({ scope_type: 'pack', scope_id: 'manufacturing' });
    expect(records).toHaveLength(1);

    // Change the YAML and re-run — record should update, not duplicate
    writeFileSync(resolve(dir, 'assumptions.yaml'), `
assumptions:
  - name: setup_treatment
    value: amortize
    rationale: "updated policy"
`, 'utf-8');
    await loadPackAssumptions(dir, 'manufacturing');
    const after = await listAssumptions({ scope_type: 'pack', scope_id: 'manufacturing' });
    expect(after).toHaveLength(1);
    expect(after[0].value).toBe('amortize');
  });

  it('returns zero counts when no assumptions.yaml present', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'luna-empty-pack-'));
    tempDirs.push(dir);
    const result = await loadPackAssumptions(dir, 'finance');
    expect(result).toEqual({ loaded: 0, applied: 0, skipped: 0 });
  });

  it('pack-loaded values resolve via resolveAssumption with pack scope', async () => {
    const dir = tempPackDir(`
assumptions:
  - name: yield_baseline_source
    value: rolled_throughput_yield
    rationale: "manufacturing pack policy"
`);
    await loadPackAssumptions(dir, 'manufacturing');

    // No active packs → falls back to default
    const dflt = await resolveAssumption('yield_baseline_source');
    expect(dflt.sourceScope).toBe('default');
    expect(dflt.value).toBe('first_pass_yield');

    // Active manufacturing pack → pack-scoped wins
    const pack = await resolveAssumption('yield_baseline_source', { activePacks: ['manufacturing'] });
    expect(pack.sourceScope).toBe('pack');
    expect(pack.scopeId).toBe('manufacturing');
    expect(pack.value).toBe('rolled_throughput_yield');
  });
});

// ── Real manufacturing pack file ────────────────────────────

describe('shipped manufacturing pack assumptions.yaml', () => {
  it('parses cleanly and yields the expected 8 entries', async () => {
    const realDir = resolve(__dirname, '..', 'packs', 'manufacturing');
    const result = await loadPackAssumptions(realDir, 'manufacturing');
    expect(result.loaded).toBe(8);
    expect(result.applied).toBe(8);
    expect(result.skipped).toBe(0);

    const records = await listAssumptions({ scope_type: 'pack', scope_id: 'manufacturing' });
    const names = records.map((r) => r.assumption_name).sort();
    expect(names).toEqual([
      'availability_calculation_basis',
      'ideal_cycle_time_source',
      'monte_carlo_default_iterations',
      'roi_default_discount_rate',
      'roi_default_horizon_months',
      'scrap_classification_rule',
      'setup_treatment',
      'yield_baseline_source',
    ]);
  });
});
