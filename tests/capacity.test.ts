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
  STORE_DIR: resolve(tmpdir(), 'luna-test-capacity'),
  config: { NODE_ENV: 'test' },
}));

import {
  analyzeCapacity,
  analyzeLineCapacity,
  aggregateDemandByLine,
  generateUtilizationHeatmap,
  type CapacityPlanConfig,
  type CapacityLine,
  type CalendarConfig,
  type DemandEntry,
  type ScenarioParams,
  type ROIInput,
} from '../src/capacity/analysis.js';
import { runScenario, compareScenarios, getScenarioDefaults } from '../src/capacity/scenarios.js';
import { runCapacityMonteCarlo, computeStats } from '../src/capacity/monte-carlo.js';
import { calculateROI, compareROIs } from '../src/capacity/roi.js';
import {
  initCapacityTables,
  savePlan,
  getPlan,
  listPlans,
  deletePlan,
  saveResult,
  getResults,
} from '../src/capacity/index.js';

// ── Test Helpers ─────────────────────────────────────────────

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initCapacityTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const SAMPLE_LINES: CapacityLine[] = [
  { id: 'line_1', code: 'SEW_01', name: 'Sewing Line 1', department: 'Sewing', max_operators: 12, efficiency_factor: 0.85, absenteeism_factor: 0.05 },
  { id: 'line_2', code: 'SEW_02', name: 'Sewing Line 2', department: 'Sewing', max_operators: 10, efficiency_factor: 0.80, absenteeism_factor: 0.08 },
  { id: 'line_3', code: 'CUT_01', name: 'Cutting Line', department: 'Cutting', max_operators: 6, efficiency_factor: 0.90, absenteeism_factor: 0.03 },
];

const SAMPLE_CALENDAR: CalendarConfig = {
  working_days: 5,
  shifts_per_day: 1,
  hours_per_shift: 8,
};

const SAMPLE_DEMANDS: DemandEntry[] = [
  { product: 'Style A', line_id: 'line_1', quantity: 2000, sam_minutes: 15 },
  { product: 'Style B', line_id: 'line_1', quantity: 1000, sam_minutes: 20 },
  { product: 'Style C', line_id: 'line_2', quantity: 1500, sam_minutes: 18 },
  { product: 'Style D', line_id: 'line_3', quantity: 800, sam_minutes: 10 },
];

const SAMPLE_CONFIG: CapacityPlanConfig = {
  name: 'Test Plan',
  period_label: 'Week 13',
  period_start: '2026-03-23',
  period_end: '2026-03-27',
  lines: SAMPLE_LINES,
  calendar: SAMPLE_CALENDAR,
  demands: SAMPLE_DEMANDS,
};

// ══════════════════════════════════════════════════════════════
// 12-Step Analysis Engine
// ══════════════════════════════════════════════════════════════

describe('12-Step Capacity Analysis', () => {
  it('should calculate gross hours = days × shifts × hours', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 0, 0);
    // 5 days × 1 shift × 8 hours = 40
    expect(result.gross_hours).toBe(40);
  });

  it('should calculate net hours with efficiency and absenteeism', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 0, 0);
    // 40 × 0.85 × (1 - 0.05) = 40 × 0.85 × 0.95 = 32.30
    expect(result.net_hours).toBe(32.3);
  });

  it('should calculate capacity hours = net × operators', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 0, 0);
    // 32.3 × 12 = 387.6
    expect(result.capacity_hours).toBe(387.6);
  });

  it('should calculate utilization correctly', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 200, 1000);
    // 200 / 387.6 × 100 ≈ 51.60%
    expect(result.utilization_pct).toBeCloseTo(51.60, 0);
    expect(result.is_bottleneck).toBe(false);
    expect(result.bottleneck_severity).toBe('ok');
  });

  it('should identify bottleneck at ≥80% utilization (warning)', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 320, 5000);
    expect(result.utilization_pct).toBeGreaterThanOrEqual(80);
    expect(result.is_bottleneck).toBe(true);
    expect(result.bottleneck_severity).toBe('warning');
  });

  it('should identify critical bottleneck at ≥95%', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 380, 8000);
    expect(result.utilization_pct).toBeGreaterThanOrEqual(95);
    expect(result.bottleneck_severity).toBe('critical');
  });

  it('should handle zero demand gracefully', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 0, 0);
    expect(result.utilization_pct).toBe(0);
    expect(result.available_hours).toBeGreaterThan(0);
    expect(result.over_capacity_hours).toBe(0);
    expect(result.is_bottleneck).toBe(false);
  });

  it('should handle over-capacity demand', () => {
    const result = analyzeLineCapacity(SAMPLE_LINES[0], SAMPLE_CALENDAR, 500, 10000);
    expect(result.utilization_pct).toBeGreaterThan(100);
    expect(result.over_capacity_hours).toBeGreaterThan(0);
    expect(result.available_hours).toBe(0);
  });

  it('should handle 2-shift calendar', () => {
    const twoShift: CalendarConfig = { working_days: 5, shifts_per_day: 2, hours_per_shift: 8 };
    const result = analyzeLineCapacity(SAMPLE_LINES[0], twoShift, 0, 0);
    expect(result.gross_hours).toBe(80);
    expect(result.capacity_hours).toBeGreaterThan(387.6); // More than single shift
  });

  it('should handle 3-shift calendar', () => {
    const threeShift: CalendarConfig = { working_days: 5, shifts_per_day: 3, hours_per_shift: 8 };
    const result = analyzeLineCapacity(SAMPLE_LINES[0], threeShift, 0, 0);
    expect(result.gross_hours).toBe(120);
  });
});

// ══════════════════════════════════════════════════════════════
// Full Capacity Analysis
// ══════════════════════════════════════════════════════════════

describe('Full Capacity Analysis', () => {
  it('should analyze all lines', () => {
    const result = analyzeCapacity(SAMPLE_CONFIG);
    expect(result.lines_analyzed).toBe(3);
    expect(result.lines).toHaveLength(3);
    expect(result.total_capacity_hours).toBeGreaterThan(0);
    expect(result.total_demand_hours).toBeGreaterThan(0);
  });

  it('should calculate overall utilization', () => {
    const result = analyzeCapacity(SAMPLE_CONFIG);
    expect(result.overall_utilization_pct).toBeGreaterThan(0);
    expect(result.overall_utilization_pct).toBeLessThan(200);
  });

  it('should generate constraint ranking', () => {
    const result = analyzeCapacity(SAMPLE_CONFIG);
    expect(result.constraint_ranking.length).toBeGreaterThan(0);
    // Ranking should be sorted by utilization descending
    for (let i = 1; i < result.constraint_ranking.length; i++) {
      expect(result.constraint_ranking[i].utilization_pct)
        .toBeLessThanOrEqual(result.constraint_ranking[i - 1].utilization_pct);
    }
  });

  it('should include recommendations in constraint ranking', () => {
    const result = analyzeCapacity(SAMPLE_CONFIG);
    for (const cr of result.constraint_ranking) {
      expect(cr.recommendation).toBeTruthy();
      expect(cr.rank).toBeGreaterThan(0);
    }
  });

  it('should handle empty demands', () => {
    const config = { ...SAMPLE_CONFIG, demands: [] };
    const result = analyzeCapacity(config);
    expect(result.overall_utilization_pct).toBe(0);
    expect(result.bottleneck_count).toBe(0);
  });

  it('should handle empty lines', () => {
    const config = { ...SAMPLE_CONFIG, lines: [] };
    const result = analyzeCapacity(config);
    expect(result.lines_analyzed).toBe(0);
    expect(result.total_capacity_hours).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Demand Aggregation
// ══════════════════════════════════════════════════════════════

describe('Demand Aggregation', () => {
  it('should aggregate multiple demands per line', () => {
    const map = aggregateDemandByLine(SAMPLE_DEMANDS);
    const line1 = map.get('line_1');
    expect(line1).toBeDefined();
    // Style A: 2000 × 15 / 60 = 500h, Style B: 1000 × 20 / 60 ≈ 333.33h
    expect(line1!.hours).toBeCloseTo(833.33, 1);
    expect(line1!.units).toBe(3000);
  });

  it('should handle direct hours', () => {
    const demands: DemandEntry[] = [
      { product: 'X', line_id: 'a', quantity: 100, hours: 50 },
    ];
    const map = aggregateDemandByLine(demands);
    expect(map.get('a')!.hours).toBe(50);
  });

  it('should prefer direct hours over SAM', () => {
    const demands: DemandEntry[] = [
      { product: 'X', line_id: 'a', quantity: 100, hours: 50, sam_minutes: 10 },
    ];
    const map = aggregateDemandByLine(demands);
    expect(map.get('a')!.hours).toBe(50); // hours takes priority
  });
});

// ══════════════════════════════════════════════════════════════
// Heatmap Generation
// ══════════════════════════════════════════════════════════════

describe('Heatmap Generation', () => {
  it('should generate heatmap with lines × periods', () => {
    const heatmap = generateUtilizationHeatmap(SAMPLE_CONFIG, 5);
    expect(heatmap.rows).toHaveLength(3);
    expect(heatmap.columns).toHaveLength(5);
    expect(heatmap.cells).toHaveLength(15); // 3 lines × 5 periods
  });

  it('should have valid utilization values in cells', () => {
    const heatmap = generateUtilizationHeatmap(SAMPLE_CONFIG, 3);
    for (const cell of heatmap.cells) {
      expect(cell.utilization_pct).toBeGreaterThanOrEqual(0);
      expect(cell.severity).toMatch(/^(critical|warning|ok)$/);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Scenario Engine
// ══════════════════════════════════════════════════════════════

describe('Scenario Engine', () => {
  it('should run overtime scenario', () => {
    const scenario: ScenarioParams = {
      type: 'overtime',
      name: 'Overtime +20%',
      description: '',
      overtime_pct: 20,
      overtime_cost_per_hour: 15,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    expect(result.baseline).toBeDefined();
    expect(result.projected).toBeDefined();
    expect(result.delta).toBeDefined();
    // Overtime should increase capacity
    expect(result.projected.total_capacity_hours).toBeGreaterThan(result.baseline.total_capacity_hours);
  });

  it('should run three-shift scenario', () => {
    const scenario: ScenarioParams = {
      type: 'three_shift',
      name: '3-Shift',
      description: '',
      target_shifts: 3,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    expect(result.projected.total_capacity_hours).toBeGreaterThan(result.baseline.total_capacity_hours);
  });

  it('should run efficiency improvement scenario', () => {
    const scenario: ScenarioParams = {
      type: 'efficiency_improvement',
      name: 'Eff +10%',
      description: '',
      efficiency_new_pct: 0.10,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    // Higher efficiency → lower utilization (more capacity)
    expect(result.projected.overall_utilization_pct).toBeLessThanOrEqual(result.baseline.overall_utilization_pct);
  });

  it('should run absenteeism spike scenario', () => {
    const scenario: ScenarioParams = {
      type: 'absenteeism_spike',
      name: 'Absenteeism 15%',
      description: '',
      absenteeism_new_pct: 0.15,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    // Higher absenteeism → higher utilization (less capacity)
    expect(result.projected.overall_utilization_pct).toBeGreaterThan(result.baseline.overall_utilization_pct);
  });

  it('should run subcontract scenario', () => {
    const scenario: ScenarioParams = {
      type: 'subcontract',
      name: 'Subcontract 40%',
      description: '',
      subcontract_pct: 40,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    // Less demand → lower utilization
    expect(result.projected.total_demand_hours).toBeLessThan(result.baseline.total_demand_hours);
  });

  it('should run setup reduction scenario', () => {
    const scenario: ScenarioParams = {
      type: 'setup_reduction',
      name: 'Setup -30%',
      description: '',
      setup_reduction_pct: 30,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    expect(result.projected.total_demand_hours).toBeLessThanOrEqual(result.baseline.total_demand_hours);
  });

  it('should run new line scenario', () => {
    const scenario: ScenarioParams = {
      type: 'new_line',
      name: 'Add Line',
      description: '',
      new_line: { code: 'NEW', name: 'New Line', max_operators: 8, efficiency_factor: 0.75, absenteeism_factor: 0.05 },
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    expect(result.projected.lines_analyzed).toBe(result.baseline.lines_analyzed + 1);
  });

  it('should compare multiple scenarios', () => {
    const scenarios: ScenarioParams[] = [
      { type: 'overtime', name: 'OT', description: '', overtime_pct: 20 },
      { type: 'three_shift', name: '3-Shift', description: '', target_shifts: 3 },
      { type: 'subcontract', name: 'Sub', description: '', subcontract_pct: 40 },
    ];
    const comparison = compareScenarios(SAMPLE_CONFIG, scenarios);
    expect(comparison.scenarios).toHaveLength(3);
    expect(comparison.best_scenario).toBeTruthy();
    expect(comparison.recommendation).toBeTruthy();
    expect(comparison.baseline).toBeDefined();
  });

  it('should compute meaningful deltas', () => {
    const scenario: ScenarioParams = {
      type: 'overtime',
      name: 'OT',
      description: '',
      overtime_pct: 20,
    };
    const result = runScenario(SAMPLE_CONFIG, scenario);
    expect(result.delta.capacity_hours_change).toBeGreaterThan(0);
    expect(result.delta.capacity_hours_change_pct).toBeGreaterThan(0);
  });

  it('should return default scenario params', () => {
    const defaults = getScenarioDefaults('overtime');
    expect(defaults.overtime_pct).toBe(20);
    expect(defaults.name).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════
// Monte Carlo Analysis
// ══════════════════════════════════════════════════════════════

describe('Monte Carlo Capacity Analysis', () => {
  it('should run N replications', () => {
    const mc = runCapacityMonteCarlo({ base_config: SAMPLE_CONFIG, replications: 100 });
    expect(mc.replications).toBe(100);
    expect(mc.overall_utilization.mean).toBeGreaterThan(0);
  });

  it('should compute distribution statistics', () => {
    const mc = runCapacityMonteCarlo({ base_config: SAMPLE_CONFIG, replications: 200 });
    const u = mc.overall_utilization;
    expect(u.p5).toBeLessThanOrEqual(u.p25);
    expect(u.p25).toBeLessThanOrEqual(u.p50);
    expect(u.p50).toBeLessThanOrEqual(u.p75);
    expect(u.p75).toBeLessThanOrEqual(u.p95);
    expect(u.min).toBeLessThanOrEqual(u.max);
    expect(u.stddev).toBeGreaterThanOrEqual(0);
  });

  it('should compute confidence intervals', () => {
    const mc = runCapacityMonteCarlo({ base_config: SAMPLE_CONFIG, replications: 200 });
    expect(mc.confidence_90.lower).toBeLessThan(mc.confidence_90.upper);
    expect(mc.confidence_95.lower).toBeLessThan(mc.confidence_95.upper);
    expect(mc.confidence_99.lower).toBeLessThanOrEqual(mc.confidence_99.upper);
    // 99% CI should be wider than 90% CI
    expect(mc.confidence_99.upper - mc.confidence_99.lower)
      .toBeGreaterThanOrEqual(mc.confidence_90.upper - mc.confidence_90.lower - 1);
  });

  it('should compute per-line bottleneck probability', () => {
    const mc = runCapacityMonteCarlo({ base_config: SAMPLE_CONFIG, replications: 100 });
    for (const line of SAMPLE_CONFIG.lines) {
      const prob = mc.per_line_bottleneck_probability[line.id];
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(100);
    }
  });

  it('should handle custom distributions', () => {
    const mc = runCapacityMonteCarlo({
      base_config: SAMPLE_CONFIG,
      replications: 50,
      efficiency_distribution: { type: 'triangular', min: 0.70, mode: 0.85, max: 0.95 },
      demand_distribution: { type: 'uniform', min: 0.8, max: 1.2 },
    });
    expect(mc.replications).toBe(50);
    expect(mc.overall_utilization.mean).toBeGreaterThan(0);
  });

  it('computeStats should handle empty array', () => {
    const stats = computeStats([]);
    expect(stats.mean).toBe(0);
    expect(stats.stddev).toBe(0);
  });

  it('computeStats should handle single value', () => {
    const stats = computeStats([42]);
    expect(stats.mean).toBe(42);
    expect(stats.p50).toBe(42);
  });
});

// ══════════════════════════════════════════════════════════════
// ROI Calculator
// ══════════════════════════════════════════════════════════════

describe('ROI Calculator', () => {
  const BASE_ROI: ROIInput = {
    scenario_name: 'New Line',
    investment_cost: 50000,
    monthly_operating_cost: 2000,
    capacity_gain_hours: 160,
    revenue_per_unit: 5,
    units_per_hour: 50,
    discount_rate: 0.10,
    analysis_months: 24,
  };

  it('should calculate payback period', () => {
    const result = calculateROI(BASE_ROI);
    expect(result.payback_months).toBeGreaterThan(0);
    expect(result.payback_months).toBeLessThan(Infinity);
  });

  it('should calculate NPV', () => {
    const result = calculateROI(BASE_ROI);
    // With $38k monthly net benefit over 24 months, NPV should be strongly positive
    expect(result.npv).toBeGreaterThan(0);
  });

  it('should calculate ROI %', () => {
    const result = calculateROI(BASE_ROI);
    expect(result.roi_pct).toBeGreaterThan(0);
  });

  it('should calculate break-even utilization', () => {
    const result = calculateROI(BASE_ROI);
    expect(result.break_even_utilization_pct).toBeGreaterThan(0);
    expect(result.break_even_utilization_pct).toBeLessThanOrEqual(100);
  });

  it('should handle zero revenue', () => {
    const input = { ...BASE_ROI, revenue_per_unit: 0 };
    const result = calculateROI(input);
    expect(result.payback_months).toBe(Infinity);
    expect(result.npv).toBeLessThan(0);
  });

  it('should handle zero investment', () => {
    const input = { ...BASE_ROI, investment_cost: 0 };
    const result = calculateROI(input);
    expect(result.roi_pct).toBe(0); // 0 investment → 0% ROI (division by 0 case)
  });

  it('should compare multiple ROIs and sort by NPV', () => {
    const inputs = [
      { ...BASE_ROI, scenario_name: 'Small', investment_cost: 10000, capacity_gain_hours: 40 },
      { ...BASE_ROI, scenario_name: 'Large', investment_cost: 100000, capacity_gain_hours: 320 },
      { ...BASE_ROI, scenario_name: 'Medium' },
    ];
    const results = compareROIs(inputs);
    expect(results).toHaveLength(3);
    // Should be sorted by NPV descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].npv).toBeLessThanOrEqual(results[i - 1].npv);
    }
  });

  it('should generate recommendation', () => {
    const result = calculateROI(BASE_ROI);
    expect(result.recommendation).toBeTruthy();
    expect(result.recommendation.length).toBeGreaterThan(10);
  });

  it('should calculate additional units per month', () => {
    const result = calculateROI(BASE_ROI);
    // 160 hours × 50 units/hour = 8000 units
    expect(result.additional_units_per_month).toBe(8000);
  });

  it('should calculate monthly net benefit', () => {
    const result = calculateROI(BASE_ROI);
    // Revenue: 8000 × $5 = $40000, minus $2000 operating = $38000
    expect(result.monthly_net_benefit).toBe(38000);
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve a plan', async () => {
    const plan = await savePlan('My Plan', SAMPLE_CONFIG);
    expect(plan.id).toBeTruthy();
    expect(plan.name).toBe('My Plan');

    const retrieved = await getPlan('My Plan');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('My Plan');
    expect(JSON.parse(retrieved!.config_json).lines).toHaveLength(3);
  });

  it('should save plan with result', async () => {
    const result = analyzeCapacity(SAMPLE_CONFIG);
    const plan = await savePlan('With Result', SAMPLE_CONFIG, result);

    const retrieved = await getPlan(plan.id);
    expect(retrieved!.result_json).toBeTruthy();
    const parsedResult = JSON.parse(retrieved!.result_json!);
    expect(parsedResult.overall_utilization_pct).toBeGreaterThan(0);
  });

  it('should update existing plan on name collision', async () => {
    await savePlan('Same Name', SAMPLE_CONFIG);
    const config2 = { ...SAMPLE_CONFIG, name: 'Updated' };
    await savePlan('Same Name', config2);

    const plans = await listPlans();
    const matching = plans.filter((p) => p.name === 'Same Name');
    expect(matching).toHaveLength(1);
    expect(JSON.parse(matching[0].config_json).name).toBe('Updated');
  });

  it('should list plans sorted by updated_at desc', async () => {
    await savePlan('Plan A', SAMPLE_CONFIG);
    await savePlan('Plan B', SAMPLE_CONFIG);
    await savePlan('Plan C', SAMPLE_CONFIG);

    const plans = await listPlans();
    expect(plans).toHaveLength(3);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].updated_at).toBeLessThanOrEqual(plans[i - 1].updated_at);
    }
  });

  it('should delete a plan', async () => {
    const plan = await savePlan('To Delete', SAMPLE_CONFIG);
    expect(await deletePlan(plan.id)).toBe(true);
    expect(await getPlan(plan.id)).toBeUndefined();
  });

  it('should return false when deleting non-existent plan', async () => {
    expect(await deletePlan('nonexistent')).toBe(false);
  });

  it('should save and retrieve results', async () => {
    const plan = await savePlan('With Results', SAMPLE_CONFIG);
    const resultId = await saveResult(plan.id, 'analysis', { test: true });
    expect(resultId).toBeTruthy();

    const results = await getResults(plan.id);
    expect(results).toHaveLength(1);
    expect(results[0].result_type).toBe('analysis');
    expect(JSON.parse(results[0].result_json).test).toBe(true);
  });

  it('should get plan by ID or name', async () => {
    const plan = await savePlan('Findable Plan', SAMPLE_CONFIG);
    expect(await getPlan(plan.id)).toBeDefined();
    expect(await getPlan('Findable Plan')).toBeDefined();
    expect(await getPlan('Nonexistent')).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle line with 1 operator', () => {
    const line: CapacityLine = { id: 'l1', code: 'L1', name: 'L1', max_operators: 1, efficiency_factor: 1.0, absenteeism_factor: 0 };
    const result = analyzeLineCapacity(line, SAMPLE_CALENDAR, 40, 100);
    expect(result.capacity_hours).toBe(40);
    expect(result.utilization_pct).toBe(100);
  });

  it('should handle 100% efficiency and 0% absenteeism', () => {
    const line: CapacityLine = { id: 'l1', code: 'L1', name: 'L1', max_operators: 10, efficiency_factor: 1.0, absenteeism_factor: 0 };
    const result = analyzeLineCapacity(line, SAMPLE_CALENDAR, 0, 0);
    expect(result.net_hours).toBe(result.gross_hours);
    expect(result.capacity_hours).toBe(result.gross_hours * 10);
  });

  it('should handle very low efficiency', () => {
    const line: CapacityLine = { id: 'l1', code: 'L1', name: 'L1', max_operators: 10, efficiency_factor: 0.10, absenteeism_factor: 0 };
    const result = analyzeLineCapacity(line, SAMPLE_CALENDAR, 0, 0);
    expect(result.net_hours).toBe(4); // 40 × 0.10
  });

  it('should handle single demand with SAM', () => {
    const demands: DemandEntry[] = [
      { product: 'X', line_id: 'line_1', quantity: 600, sam_minutes: 10 },
    ];
    const map = aggregateDemandByLine(demands);
    expect(map.get('line_1')!.hours).toBe(100); // 600 × 10 / 60
  });

  it('should handle demands with no matching line', () => {
    const config = {
      ...SAMPLE_CONFIG,
      demands: [{ product: 'X', line_id: 'nonexistent', quantity: 100, hours: 50 }],
    };
    const result = analyzeCapacity(config);
    // Lines should still have capacity but no demand
    expect(result.lines.every((l) => l.demand_hours === 0)).toBe(true);
  });

  it('should handle scenario on empty plan', () => {
    const emptyConfig = { ...SAMPLE_CONFIG, lines: [], demands: [] };
    const scenario: ScenarioParams = { type: 'overtime', name: 'OT', description: '', overtime_pct: 20 };
    const result = runScenario(emptyConfig, scenario);
    expect(result.baseline.lines_analyzed).toBe(0);
    expect(result.projected.lines_analyzed).toBe(0);
  });

  it('should handle Monte Carlo with 1 replication', () => {
    const mc = runCapacityMonteCarlo({ base_config: SAMPLE_CONFIG, replications: 1 });
    expect(mc.replications).toBe(1);
    expect(mc.overall_utilization.mean).toBeGreaterThan(0);
  });
});
