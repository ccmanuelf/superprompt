import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'clauded-test-toc'),
  config: { NODE_ENV: 'test' },
}));

import {
  analyzeTOC,
  identifyConstraint,
  calculateThroughputAccounting,
  buildDBRSchedule,
  computeBufferStatus,
  computeWIPGauges,
} from '../src/toc/analysis.js';
import {
  initTocTables,
  saveTOC,
  getTOC,
  listTOCs,
  deleteTOC,
} from '../src/toc/index.js';
import type { TOCConfig, WorkCenter, BufferConfig } from '../src/toc/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initTocTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const SAMPLE_WCS: WorkCenter[] = [
  { id: 'wc1', name: 'Cutting', capacity_units_per_hour: 40, available_hours_per_day: 8, operators: 2, current_wip: 15 },
  { id: 'wc2', name: 'Assembly', capacity_units_per_hour: 25, available_hours_per_day: 8, operators: 4, current_wip: 40 },
  { id: 'wc3', name: 'Welding', capacity_units_per_hour: 20, available_hours_per_day: 8, operators: 3, current_wip: 60 },
  { id: 'wc4', name: 'Paint', capacity_units_per_hour: 30, available_hours_per_day: 8, operators: 2, current_wip: 25 },
  { id: 'wc5', name: 'QC/Pack', capacity_units_per_hour: 50, available_hours_per_day: 8, operators: 2, current_wip: 10 },
];

const SAMPLE_CONFIG: TOCConfig = {
  name: 'Test Production',
  work_centers: SAMPLE_WCS,
  selling_price_per_unit: 50,
  total_variable_cost_per_unit: 20,
  operating_expense_per_period: 100000,
  investment: 500000,
  demand_units_per_day: 200,
  available_hours_per_day: 8,
};

// ══════════════════════════════════════════════════════════════
// Constraint Identification
// ══════════════════════════════════════════════════════════════

describe('Constraint Identification (CCR)', () => {
  it('should identify the work center with highest utilization as CCR', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    // Welding: 200/20 = 10h load / 8h available = 125% utilization (highest)
    expect(result.ccr_name).toBe('Welding');
    expect(result.ccr_utilization_pct).toBeGreaterThan(100);
  });

  it('should rank work centers by utilization descending', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    for (let i = 1; i < result.work_center_ranking.length; i++) {
      expect(result.work_center_ranking[i].utilization_pct)
        .toBeLessThanOrEqual(result.work_center_ranking[i - 1].utilization_pct);
    }
  });

  it('should mark exactly one CCR', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    const ccrs = result.work_center_ranking.filter((wc) => wc.is_ccr);
    expect(ccrs).toHaveLength(1);
  });

  it('should calculate max system throughput limited by CCR', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    // Welding: 20 u/hr × 8h = 160 units/day max
    expect(result.max_system_throughput_per_day).toBe(160);
  });

  it('should calculate demand coverage %', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    // 160 / 200 = 80%
    expect(result.demand_coverage_pct).toBe(80);
  });

  it('should handle work center with excess capacity', () => {
    const result = identifyConstraint(SAMPLE_CONFIG);
    const qcPack = result.work_center_ranking.find((wc) => wc.name === 'QC/Pack')!;
    // 200/50 = 4h load, 8h available → 50% util, 4h excess
    expect(qcPack.utilization_pct).toBe(50);
    expect(qcPack.excess_hours).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════
// Throughput Accounting
// ══════════════════════════════════════════════════════════════

describe('Throughput Accounting', () => {
  it('should calculate throughput per unit = Price - TVC', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    expect(ta.throughput_per_unit).toBe(30); // 50 - 20
  });

  it('should calculate throughput per day', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    // T/day = 30 × min(200, 160) = 30 × 160 = 4800
    expect(ta.throughput_per_day).toBe(4800);
  });

  it('should calculate net profit', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    // T/month = 4800 × 22 = 105600, NP = 105600 - 100000 = 5600
    expect(ta.net_profit).toBe(5600);
  });

  it('should calculate ROI', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    // ROI = 5600 / 500000 × 100 = 1.12%
    expect(ta.roi_pct).toBeCloseTo(1.12, 1);
  });

  it('should calculate revenue lost per constraint hour', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    // 20 u/hr × $30/u = $600/hr
    expect(ta.revenue_lost_per_hour_constraint_down).toBe(600);
  });

  it('should calculate productivity T/OE', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    // 105600 / 100000 = 1.056
    expect(ta.productivity).toBeCloseTo(1.056, 2);
  });
});

// ══════════════════════════════════════════════════════════════
// Drum-Buffer-Rope
// ══════════════════════════════════════════════════════════════

describe('DBR Schedule', () => {
  it('should set drum rate to CCR capacity', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    const dbr = buildDBRSchedule(SAMPLE_CONFIG, constraint, ta);
    expect(dbr.drum_rate).toBe(20); // Welding capacity
    expect(dbr.drum_work_center).toBe('Welding');
  });

  it('should create shipping and constraint buffers', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    const dbr = buildDBRSchedule(SAMPLE_CONFIG, constraint, ta);
    expect(dbr.shipping_buffer).toBeDefined();
    expect(dbr.constraint_buffer).toBeDefined();
    expect(dbr.shipping_buffer.total_size).toBeGreaterThan(0);
    expect(dbr.constraint_buffer.total_size).toBeGreaterThan(0);
  });

  it('should generate rope releases', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    const dbr = buildDBRSchedule(SAMPLE_CONFIG, constraint, ta);
    expect(dbr.rope_releases.length).toBeGreaterThan(0);
    // First release should be to the first work center
    expect(dbr.rope_releases[0].work_center_name).toBe('Cutting');
  });

  it('should calculate planned throughput per day', () => {
    const constraint = identifyConstraint(SAMPLE_CONFIG);
    const ta = calculateThroughputAccounting(SAMPLE_CONFIG, constraint);
    const dbr = buildDBRSchedule(SAMPLE_CONFIG, constraint, ta);
    expect(dbr.planned_throughput_per_day).toBe(160); // min(drum×hours, demand)
  });
});

// ══════════════════════════════════════════════════════════════
// Buffer Management
// ══════════════════════════════════════════════════════════════

describe('Buffer Management', () => {
  it('should classify green zone (0-33%)', () => {
    const status = computeBufferStatus({
      id: 'b1', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 2, unit: 'hours',
    });
    expect(status.zone).toBe('green');
    expect(status.consumption_pct).toBe(20);
  });

  it('should classify yellow zone (34-67%)', () => {
    const status = computeBufferStatus({
      id: 'b1', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 5, unit: 'hours',
    });
    expect(status.zone).toBe('yellow');
  });

  it('should classify red zone (>67%)', () => {
    const status = computeBufferStatus({
      id: 'b1', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 8, unit: 'hours',
    });
    expect(status.zone).toBe('red');
    expect(status.action).toContain('Immediate action');
  });

  it('should compute remaining buffer', () => {
    const status = computeBufferStatus({
      id: 'b1', name: 'Test', buffer_type: 'stock',
      total_size: 100, current_consumption: 60, unit: 'units',
    });
    expect(status.remaining).toBe(40);
  });
});

// ══════════════════════════════════════════════════════════════
// WIP Tracking
// ══════════════════════════════════════════════════════════════

describe('WIP Gauges', () => {
  it('should compute WIP gauge for each work center', () => {
    const gauges = computeWIPGauges(SAMPLE_CONFIG);
    expect(gauges).toHaveLength(5);
  });

  it('should calculate hours of work', () => {
    const gauges = computeWIPGauges(SAMPLE_CONFIG);
    const welding = gauges.find((g) => g.work_center_name === 'Welding')!;
    // 60 WIP / 20 u/hr = 3 hours
    expect(welding.hours_of_work).toBe(3);
  });

  it('should set WIP status based on limit', () => {
    const gauges = computeWIPGauges(SAMPLE_CONFIG);
    for (const g of gauges) {
      expect(['ok', 'warning', 'critical']).toContain(g.status);
      expect(g.wip_limit).toBeGreaterThan(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Full Analysis
// ══════════════════════════════════════════════════════════════

describe('Full TOC Analysis', () => {
  it('should produce complete analysis', () => {
    const result = analyzeTOC(SAMPLE_CONFIG);
    expect(result.constraint).toBeDefined();
    expect(result.throughput).toBeDefined();
    expect(result.dbr).toBeDefined();
    expect(result.wip_gauges).toHaveLength(5);
    expect(result.five_focusing_steps).toHaveLength(5);
    expect(result.total_wip).toBeGreaterThan(0);
  });

  it('should generate 5 focusing steps', () => {
    const result = analyzeTOC(SAMPLE_CONFIG);
    expect(result.five_focusing_steps[0]).toContain('IDENTIFY');
    expect(result.five_focusing_steps[1]).toContain('EXPLOIT');
    expect(result.five_focusing_steps[2]).toContain('SUBORDINATE');
    expect(result.five_focusing_steps[3]).toContain('ELEVATE');
    expect(result.five_focusing_steps[4]).toContain('REPEAT');
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve', async () => {
    const saved = await saveTOC('My TOC', SAMPLE_CONFIG);
    expect(saved.id).toBeTruthy();
    const retrieved = await getTOC('My TOC');
    expect(retrieved).toBeDefined();
    expect(JSON.parse(retrieved!.config_json).work_centers).toHaveLength(5);
  });

  it('should save with result', async () => {
    const result = analyzeTOC(SAMPLE_CONFIG);
    await saveTOC('With Result', SAMPLE_CONFIG, result);
    const retrieved = await getTOC('With Result');
    expect(retrieved!.result_json).toBeTruthy();
  });

  it('should update on name collision', async () => {
    await saveTOC('Same', SAMPLE_CONFIG);
    await saveTOC('Same', { ...SAMPLE_CONFIG, demand_units_per_day: 999 });
    expect((await listTOCs()).filter((t) => t.name === 'Same')).toHaveLength(1);
  });

  it('should delete', async () => {
    const saved = await saveTOC('ToDelete', SAMPLE_CONFIG);
    expect(await deleteTOC(saved.id)).toBe(true);
    expect(await getTOC(saved.id)).toBeUndefined();
  });

  it('should list sorted', async () => {
    await saveTOC('A', SAMPLE_CONFIG);
    await saveTOC('B', SAMPLE_CONFIG);
    const all = await listTOCs();
    expect(all).toHaveLength(2);
    expect(all[0].updated_at).toBeGreaterThanOrEqual(all[1].updated_at);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle single work center', () => {
    const config: TOCConfig = {
      ...SAMPLE_CONFIG,
      work_centers: [SAMPLE_WCS[0]],
    };
    const result = analyzeTOC(config);
    expect(result.constraint.ccr_name).toBe('Cutting');
  });

  it('should handle zero demand', () => {
    const config = { ...SAMPLE_CONFIG, demand_units_per_day: 0 };
    const result = analyzeTOC(config);
    expect(result.constraint.ccr_utilization_pct).toBe(0);
  });

  it('should handle zero investment', () => {
    const config = { ...SAMPLE_CONFIG, investment: 0 };
    const result = analyzeTOC(config);
    expect(result.throughput.roi_pct).toBe(0);
  });

  it('should handle all WCs with same capacity', () => {
    const wcs = SAMPLE_WCS.map((wc) => ({ ...wc, capacity_units_per_hour: 25 }));
    const config = { ...SAMPLE_CONFIG, work_centers: wcs };
    const result = analyzeTOC(config);
    // All same util → first one becomes CCR
    expect(result.constraint.ccr_name).toBeTruthy();
    expect(result.constraint.work_center_ranking.every((r) =>
      r.utilization_pct === result.constraint.work_center_ranking[0].utilization_pct,
    )).toBe(true);
  });
});
