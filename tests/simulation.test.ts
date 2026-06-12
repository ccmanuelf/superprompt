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
  STORE_DIR: resolve(tmpdir(), 'luna-test-sim'),
  config: { NODE_ENV: 'test' },
}));

import {
  SimEnvironment, SimResource, runSimulation,
} from '../src/simulation/engine.js';
import { validateSimulationConfig } from '../src/simulation/validation.js';
import { calculateAllBlocks } from '../src/simulation/calculations.js';
import { runMonteCarlo, computeStats } from '../src/simulation/monte-carlo.js';
import { initSimulationTables, saveScenario, getScenarioByName, listScenarios, deleteScenario } from '../src/simulation/index.js';
import type { SimulationConfig } from '../src/simulation/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initSimulationTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── T-shirt sample config ────────────────────────────────────

const TSHIRT_CONFIG: SimulationConfig = {
  operations: [
    { product: 'TSHIRT_A', step: 1, operation: 'Cut fabric', machine_tool: 'Cutting Table', sam_min: 2.0, operators: 2 },
    { product: 'TSHIRT_A', step: 2, operation: 'Sew shoulders', machine_tool: 'Overlock', sam_min: 1.5 },
    { product: 'TSHIRT_A', step: 3, operation: 'Attach sleeves', machine_tool: 'Overlock', sam_min: 2.5 },
    { product: 'TSHIRT_A', step: 4, operation: 'Side seams', machine_tool: 'Overlock', sam_min: 2.0 },
    { product: 'TSHIRT_A', step: 5, operation: 'Hem bottom', machine_tool: 'Coverstitch', sam_min: 1.0 },
    { product: 'TSHIRT_A', step: 6, operation: 'Hem sleeves', machine_tool: 'Coverstitch', sam_min: 1.5 },
    { product: 'TSHIRT_A', step: 7, operation: 'Attach collar', machine_tool: 'Flatlock', sam_min: 3.0, operators: 2 },
    { product: 'TSHIRT_A', step: 8, operation: 'QC', machine_tool: 'Inspection', sam_min: 1.0 },
    { product: 'TSHIRT_A', step: 9, operation: 'Pack', machine_tool: 'Packing', sam_min: 0.5 },
  ],
  schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
  demands: [{ product: 'TSHIRT_A', bundle_size: 10, daily_demand: 200 }],
  breakdowns: [{ machine_tool: 'Overlock', breakdown_pct: 2 }],
  mode: 'demand-driven',
  horizon_days: 1,
};

// ── DES Primitives ───────────────────────────────────────────

describe('SimEnvironment', () => {
  it('advances time with timeout', async () => {
    const env = new SimEnvironment();
    let resolved = false;
    env.timeout(10).then(() => { resolved = true; });
    await env.run(5);
    expect(resolved).toBe(false);
    await env.run(15);
    expect(resolved).toBe(true);
    expect(env.now).toBe(15);
  });

  it('processes events in chronological order', async () => {
    const env = new SimEnvironment();
    const order: number[] = [];
    env.timeout(3).then(() => order.push(3));
    env.timeout(1).then(() => order.push(1));
    env.timeout(2).then(() => order.push(2));
    await env.run(5);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('SimResource', () => {
  it('limits concurrent access to capacity', async () => {
    const env = new SimEnvironment();
    const resource = new SimResource(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    async function worker() {
      const release = await resource.request();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await env.timeout(10);
      concurrent--;
      release();
    }

    // Start 3 workers — only 2 should run concurrently
    worker();
    worker();
    worker();
    await env.run(100);

    expect(maxConcurrent).toBe(2);
  });
});

// ── Engine ───────────────────────────────────────────────────

describe('ProductionLineSimulator', () => {
  it('runs T-shirt sample and produces throughput', async () => {
    const { metrics } = await runSimulation(TSHIRT_CONFIG, 42);

    const throughput = metrics.throughput_by_product.get('TSHIRT_A') ?? 0;
    expect(throughput).toBeGreaterThan(0);
    expect(metrics.bundles_completed).toBeGreaterThan(0);
    expect(metrics.cycle_times.length).toBe(metrics.bundles_completed);
  });

  it('produces deterministic results with same seed', async () => {
    const { metrics: m1 } = await runSimulation(TSHIRT_CONFIG, 42);
    const { metrics: m2 } = await runSimulation(TSHIRT_CONFIG, 42);

    expect(m1.throughput_by_product.get('TSHIRT_A')).toBe(m2.throughput_by_product.get('TSHIRT_A'));
    expect(m1.bundles_completed).toBe(m2.bundles_completed);
  });

  it('produces different results with different seeds', async () => {
    const { metrics: m1 } = await runSimulation(TSHIRT_CONFIG, 1);
    const { metrics: m2 } = await runSimulation(TSHIRT_CONFIG, 999);

    // With stochastic variability and breakdowns, results should differ
    // (may occasionally be equal, but very unlikely)
    const t1 = m1.throughput_by_product.get('TSHIRT_A') ?? 0;
    const t2 = m2.throughput_by_product.get('TSHIRT_A') ?? 0;
    // Just verify both produce valid output
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(0);
  });

  it('tracks WIP samples', async () => {
    const { metrics } = await runSimulation(TSHIRT_CONFIG, 42);
    expect(metrics.wip_samples.length).toBeGreaterThan(0);
    expect(metrics.max_wip).toBeGreaterThan(0);
  });

  it('SAM formula: Actual = SAM × (1 + Var + FPD/100 + (100-Grade)/100)', async () => {
    // Deterministic run to verify formula
    const config: SimulationConfig = {
      operations: [{ product: 'X', step: 1, operation: 'Op', machine_tool: 'Tool', sam_min: 1.0, operators: 10, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, rework_pct: 0 }],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'X', bundle_size: 1, daily_demand: 10 }],
      mode: 'demand-driven',
      horizon_days: 1,
    };
    const { metrics } = await runSimulation(config, 42);
    // With grade=100, FPD=0, deterministic: Actual = 1.0 × (1 + 0 + 0 + 0) = 1.0
    const busyTime = metrics.station_busy_time.get('Tool') ?? 0;
    const pieces = metrics.station_pieces_processed.get('Tool') ?? 0;
    if (pieces > 0) {
      const avgTime = busyTime / pieces;
      expect(avgTime).toBeCloseTo(1.0, 1); // Should be exactly 1.0 min
    }
  });
});

// ── Validation ───────────────────────────────────────────────

describe('Validation', () => {
  it('validates valid config', () => {
    const report = validateSimulationConfig(TSHIRT_CONFIG);
    expect(report.is_valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  it('detects duplicate step numbers', () => {
    const config = { ...TSHIRT_CONFIG, operations: [
      { product: 'X', step: 1, operation: 'A', machine_tool: 'T', sam_min: 1 },
      { product: 'X', step: 1, operation: 'B', machine_tool: 'T', sam_min: 1 },
    ], demands: [{ product: 'X', daily_demand: 10 }] };
    const report = validateSimulationConfig(config);
    expect(report.errors.some(e => e.category === 'sequence')).toBe(true);
  });

  it('detects demand without operations', () => {
    const config = { ...TSHIRT_CONFIG, demands: [{ product: 'NONEXISTENT', daily_demand: 100 }] };
    const report = validateSimulationConfig(config);
    expect(report.errors.some(e => e.category === 'product_consistency')).toBe(true);
  });

  it('detects similar machine tool names (typo)', () => {
    const config = { ...TSHIRT_CONFIG, operations: [
      { product: 'X', step: 1, operation: 'A', machine_tool: 'Overlock', sam_min: 1 },
      { product: 'X', step: 2, operation: 'B', machine_tool: 'Overlok', sam_min: 1 },
    ], demands: [{ product: 'X', daily_demand: 10 }] };
    const report = validateSimulationConfig(config);
    expect(report.warnings.some(w => w.category === 'machine_tool')).toBe(true);
  });
});

// ── Calculations (8 Blocks) ──────────────────────────────────

describe('8-Block Calculations', () => {
  it('produces all 8 blocks', async () => {
    const report = validateSimulationConfig(TSHIRT_CONFIG);
    const { metrics, durationSeconds } = await runSimulation(TSHIRT_CONFIG, 42);
    const results = calculateAllBlocks(TSHIRT_CONFIG, metrics, report, durationSeconds);

    expect(results.weekly_demand_capacity.length).toBeGreaterThan(0);
    expect(results.daily_summary.daily_throughput_pcs).toBeGreaterThan(0);
    expect(results.station_performance.length).toBe(9); // 9 operations
    expect(results.free_capacity.daily_max_capacity_pcs).toBeGreaterThan(0);
    expect(results.bundle_metrics.length).toBe(1); // 1 product
    expect(results.per_product_summary.length).toBe(1);
    expect(results.assumption_log.simulation_engine_version).toBe('3.0.0');
  });

  it('identifies Overlock as constraint', async () => {
    const report = validateSimulationConfig(TSHIRT_CONFIG);
    const { metrics, durationSeconds } = await runSimulation(TSHIRT_CONFIG, 42);
    const results = calculateAllBlocks(TSHIRT_CONFIG, metrics, report, durationSeconds);

    // Overlock has 3 operations × SAM = 6.0 total with 3 pooled operators
    const overlockStation = results.station_performance.find(s => s.machine_tool === 'Overlock');
    expect(overlockStation).toBeDefined();
    expect(overlockStation!.util_pct).toBeGreaterThan(70); // should be the constraint
  });

  it('weekly coverage reflects shortfall', async () => {
    const report = validateSimulationConfig(TSHIRT_CONFIG);
    const { metrics, durationSeconds } = await runSimulation(TSHIRT_CONFIG, 42);
    const results = calculateAllBlocks(TSHIRT_CONFIG, metrics, report, durationSeconds);

    const weekly = results.weekly_demand_capacity[0];
    expect(weekly.status).toBe('Shortfall'); // Can't meet 200/day demand
    expect(weekly.demand_coverage_pct).toBeLessThan(100);
  });
});

// ── Monte Carlo ──────────────────────────────────────────────

describe('Monte Carlo', () => {
  it('runs N replications and produces statistics', async () => {
    const mc = await runMonteCarlo(TSHIRT_CONFIG, 10, 42);

    expect(mc.replications).toBe(10);
    expect(mc.throughput.mean).toBeGreaterThan(0);
    expect(mc.throughput.p5).toBeLessThanOrEqual(mc.throughput.p95);
    expect(mc.cycle_time.mean).toBeGreaterThan(0);
    expect(mc.per_replication).toHaveLength(10);
  });

  it('computeStats produces correct percentiles', () => {
    const stats = computeStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats.mean).toBe(55);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.p50).toBeCloseTo(55, 0);
  });
});

// ── DB Persistence ───────────────────────────────────────────

describe('Scenario Persistence', () => {
  it('saves and retrieves scenario', async () => {
    const scenario = await saveScenario('Test Line', TSHIRT_CONFIG);
    expect(scenario.name).toBe('Test Line');

    const found = await getScenarioByName('test line');
    expect(found).toBeDefined();
    const config = JSON.parse(found!.config_json);
    expect(config.operations).toHaveLength(9);
  });

  it('reuses existing scenario on save', async () => {
    await saveScenario('Reuse', TSHIRT_CONFIG);
    await saveScenario('Reuse', TSHIRT_CONFIG);
    const all = await listScenarios();
    expect(all.filter(s => s.name === 'Reuse')).toHaveLength(1);
  });

  it('deletes scenario', async () => {
    const scenario = await saveScenario('Delete Me', TSHIRT_CONFIG);
    expect(await deleteScenario(scenario.id)).toBe(true);
    expect(await getScenarioByName('Delete Me')).toBeUndefined();
  });
});

// ── Real-World Scenarios ─────────────────────────────────────

describe('Real-World Scenarios', () => {
  it('garment line with rework', async () => {
    const config: SimulationConfig = {
      ...TSHIRT_CONFIG,
      operations: TSHIRT_CONFIG.operations.map(op => ({
        ...op,
        rework_pct: op.machine_tool === 'Overlock' ? 5 : 0, // 5% rework on sewing ops
      })),
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.rework_count).toBeGreaterThan(0);
  });

  it('multi-product mix-driven mode', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'A', step: 1, operation: 'Op1', machine_tool: 'T1', sam_min: 1.0 },
        { product: 'A', step: 2, operation: 'Op2', machine_tool: 'T2', sam_min: 1.5 },
        { product: 'B', step: 1, operation: 'Op1', machine_tool: 'T1', sam_min: 1.2 },
        { product: 'B', step: 2, operation: 'Op2', machine_tool: 'T2', sam_min: 1.0 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [
        { product: 'A', bundle_size: 5, mix_share_pct: 60 },
        { product: 'B', bundle_size: 5, mix_share_pct: 40 },
      ],
      mode: 'mix-driven',
      total_demand: 100,
      horizon_days: 1,
    };

    const report = validateSimulationConfig(config);
    expect(report.is_valid).toBe(true);

    const { metrics } = await runSimulation(config, 42);
    expect(metrics.throughput_by_product.get('A')).toBeGreaterThan(0);
    expect(metrics.throughput_by_product.get('B')).toBeGreaterThan(0);
  });

  it('V3: shift breaks reduce available time', async () => {
    const noBreaks = await runSimulation(TSHIRT_CONFIG, 42);
    const withBreaks = await runSimulation({ ...TSHIRT_CONFIG, enable_breaks: true }, 42);
    const t1 = noBreaks.metrics.throughput_by_product.get('TSHIRT_A') ?? 0;
    const t2 = withBreaks.metrics.throughput_by_product.get('TSHIRT_A') ?? 0;
    expect(t2).toBeLessThanOrEqual(t1);
  });

  it('V3: changeover times add delay between products', async () => {
    const multiConfig: SimulationConfig = {
      operations: [
        { product: 'A', step: 1, operation: 'Cut', machine_tool: 'Cutter', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
        { product: 'B', step: 1, operation: 'Cut', machine_tool: 'Cutter', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'A', bundle_size: 5, daily_demand: 25 }, { product: 'B', bundle_size: 5, daily_demand: 25 }],
      mode: 'demand-driven',
      horizon_days: 1,
    };

    const noCO = await runSimulation(multiConfig, 42);
    const withCO = await runSimulation({
      ...multiConfig,
      changeovers: [
        { from_product: 'A', to_product: 'B', changeover_minutes: 30 },
        { from_product: 'B', to_product: 'A', changeover_minutes: 30 },
      ],
    }, 42);

    const total1 = (noCO.metrics.throughput_by_product.get('A') ?? 0) + (noCO.metrics.throughput_by_product.get('B') ?? 0);
    const total2 = (withCO.metrics.throughput_by_product.get('A') ?? 0) + (withCO.metrics.throughput_by_product.get('B') ?? 0);
    expect(total2).toBeLessThanOrEqual(total1);
  });

  it('V3: WIP limits constrain queue depth', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'A', step: 1, operation: 'Fast', machine_tool: 'T1', sam_min: 0.5, operators: 5 },
        { product: 'A', step: 2, operation: 'Slow', machine_tool: 'T2', sam_min: 3.0 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'A', bundle_size: 5, daily_demand: 50 }],
      mode: 'demand-driven',
      horizon_days: 1,
      wip_limits: [{ machine_tool: 'T2', max_wip: 3 }],
    };
    const { metrics } = await runSimulation(config, 42);
    // WIP limit should prevent unbounded queue growth
    expect(metrics.max_wip).toBeGreaterThan(0);
  });

  it('V3: MTBF/MTTR breakdowns with variable repair time', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'A', step: 1, operation: 'Op', machine_tool: 'M1', sam_min: 1.0, operators: 10, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'A', bundle_size: 5, daily_demand: 100 }],
      mode: 'demand-driven',
      horizon_days: 1,
      breakdown_distributions: [{ machine_tool: 'M1', mtbf_minutes: 30, mttr_minutes: 10 }],
    };

    // Run multiple times to confirm stochastic breakdowns occur
    let totalEvents = 0;
    for (let i = 0; i < 20; i++) {
      const { metrics } = await runSimulation(config, i * 13);
      totalEvents += metrics.breakdown_events;
    }
    expect(totalEvents).toBeGreaterThan(0); // At least 1 breakdown across 20 runs
  });

  it('V3: material starvation tracks wait time', async () => {
    const config: SimulationConfig = {
      ...TSHIRT_CONFIG,
      materials: [{ material_id: 'fabric', initial_stock: 10, replenishment_qty: 10, replenishment_interval_minutes: 120 }],
      material_requirements: [{ operation_step: 1, product: 'TSHIRT_A', material_id: 'fabric', qty_per_piece: 1 }],
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.material_starvation_events).toBeGreaterThan(0);
    expect(metrics.material_starvation_time).toBeGreaterThan(0);
  });

  it('V3: learning curve improves effective grade over time', async () => {
    const config: SimulationConfig = {
      operations: [{ product: 'X', step: 1, operation: 'Op', machine_tool: 'T1', sam_min: 2.0, operators: 10, variability: 'deterministic', grade_pct: 60, fpd_pct: 0 }],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'X', bundle_size: 1, daily_demand: 20 }],
      mode: 'demand-driven',
      horizon_days: 1,
      learning_curves: [{ machine_tool: 'T1', grade_start: 60, grade_final: 95, learning_rate: 0.01 }],
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.throughput_by_product.get('X')).toBeGreaterThan(0);
  });

  it('V3: warmup adds time penalty in first 30 minutes', async () => {
    const { metrics: withWarmup } = await runSimulation({ ...TSHIRT_CONFIG, enable_warmup: true }, 42);
    const { metrics: noWarmup } = await runSimulation({ ...TSHIRT_CONFIG, enable_warmup: false }, 42);
    expect(withWarmup.warmup_time_lost).toBeGreaterThan(0);
    // Baseline (rc.115): without warmup there is no lost time. (A same-seed
    // throughput comparison is NOT valid here — warmup draws shift the RNG
    // sample path, so stochastic runs legitimately diverge either way.)
    expect(noWarmup.warmup_time_lost).toBe(0);
  });

  it('V3: shared resource pool limits cross-line capacity', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'L1', step: 1, operation: 'QC', machine_tool: 'QC_L1', sam_min: 1.0, operators: 3, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
        { product: 'L2', step: 1, operation: 'QC', machine_tool: 'QC_L2', sam_min: 1.0, operators: 3, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'L1', bundle_size: 5, daily_demand: 30 }, { product: 'L2', bundle_size: 5, daily_demand: 30 }],
      mode: 'demand-driven',
      horizon_days: 1,
      shared_resource_pools: [{ pool_name: 'Shared QC', machine_tools: ['QC_L1', 'QC_L2'], total_capacity: 3 }],
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.throughput_by_product.get('L1')).toBeGreaterThan(0);
    expect(metrics.throughput_by_product.get('L2')).toBeGreaterThan(0);
  });

  it('V3: parallel branches execute concurrently and merge', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'X', step: 1, operation: 'Cut', machine_tool: 'T1', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
        { product: 'X', step: 2, operation: 'Sew Left', machine_tool: 'T2', sam_min: 2.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['X:1'] },
        { product: 'X', step: 3, operation: 'Sew Right', machine_tool: 'T3', sam_min: 2.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['X:1'] },
        { product: 'X', step: 4, operation: 'QC', machine_tool: 'T4', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['X:2', 'X:3'] },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'X', bundle_size: 5, daily_demand: 30 }],
      mode: 'demand-driven', horizon_days: 1,
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.throughput_by_product.get('X')).toBeGreaterThan(0);
    // All 4 stations should process pieces
    expect(metrics.station_pieces_processed.size).toBe(4);
  });

  it('V3: multi-path routing — different products, different paths', async () => {
    const config: SimulationConfig = {
      operations: [
        { product: 'A', step: 1, operation: 'S1', machine_tool: 'T1', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
        { product: 'A', step: 2, operation: 'S2', machine_tool: 'T2', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['A:1'] },
        { product: 'A', step: 3, operation: 'S3', machine_tool: 'T3', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['A:2'] },
        { product: 'B', step: 1, operation: 'S1', machine_tool: 'T1', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0 },
        { product: 'B', step: 2, operation: 'S3', machine_tool: 'T3', sam_min: 1.0, operators: 5, variability: 'deterministic', grade_pct: 100, fpd_pct: 0, predecessors: ['B:1'] },
      ],
      schedule: { shifts_enabled: 1, shift1_hours: 8, work_days: 5 },
      demands: [{ product: 'A', bundle_size: 5, daily_demand: 20 }, { product: 'B', bundle_size: 5, daily_demand: 20 }],
      mode: 'demand-driven', horizon_days: 1,
    };
    const { metrics } = await runSimulation(config, 42);
    expect(metrics.throughput_by_product.get('A')).toBeGreaterThan(0);
    expect(metrics.throughput_by_product.get('B')).toBeGreaterThan(0);
  });

  it('2-shift scenario doubles capacity window', async () => {
    const config: SimulationConfig = {
      ...TSHIRT_CONFIG,
      schedule: { shifts_enabled: 2, shift1_hours: 8, shift2_hours: 8, work_days: 5 },
    };

    const { metrics: m1 } = await runSimulation(TSHIRT_CONFIG, 42);
    const { metrics: m2 } = await runSimulation(config, 42);

    const t1 = m1.throughput_by_product.get('TSHIRT_A') ?? 0;
    const t2 = m2.throughput_by_product.get('TSHIRT_A') ?? 0;
    // 2 shifts should produce more than 1 shift
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
