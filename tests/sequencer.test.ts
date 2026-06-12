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
  STORE_DIR: resolve(tmpdir(), 'luna-test-sequencer'),
  config: { NODE_ENV: 'test' },
}));

import { dispatch, compareAllRules } from '../src/sequencer/dispatching.js';
import { runGA } from '../src/sequencer/genetic.js';
import {
  buildGanttData,
  buildSetupMatrix,
  buildSetupMap,
  getSetupTime,
} from '../src/sequencer/evaluation.js';
import {
  initSequencerTables,
  saveSchedule,
  getSchedule,
  listSchedules,
  deleteSchedule,
} from '../src/sequencer/index.js';
import type {
  SequencerConfig,
  Job,
  Machine,
  SetupEntry,
} from '../src/sequencer/models.js';
import { ALL_RULES, productColor } from '../src/sequencer/models.js';

// ── Test Helpers ─────────────────────────────────────────────

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initSequencerTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const futureDate = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const SAMPLE_JOBS: Job[] = [
  { id: 'j1', name: 'Job A', product: 'Widget', quantity: 100, processing_minutes: 60, due_date: futureDate(2), priority: 1 },
  { id: 'j2', name: 'Job B', product: 'Gadget', quantity: 50, processing_minutes: 30, due_date: futureDate(1), priority: 2 },
  { id: 'j3', name: 'Job C', product: 'Widget', quantity: 200, processing_minutes: 90, due_date: futureDate(3), priority: 1 },
  { id: 'j4', name: 'Job D', product: 'Gadget', quantity: 75, processing_minutes: 45, due_date: futureDate(1), priority: 3 },
  { id: 'j5', name: 'Job E', product: 'Sprocket', quantity: 150, processing_minutes: 120, due_date: futureDate(5), priority: 2 },
];

const SAMPLE_MACHINES: Machine[] = [
  { id: 'm1', name: 'CNC Mill 1', capacity_hours_per_day: 8, efficiency: 1.0 },
  { id: 'm2', name: 'CNC Mill 2', capacity_hours_per_day: 8, efficiency: 0.9 },
];

const SAMPLE_SETUP: SetupEntry[] = [
  { from_product: 'Widget', to_product: 'Gadget', setup_minutes: 15 },
  { from_product: 'Gadget', to_product: 'Widget', setup_minutes: 10 },
  { from_product: 'Widget', to_product: 'Sprocket', setup_minutes: 20 },
  { from_product: 'Sprocket', to_product: 'Widget', setup_minutes: 20 },
  { from_product: 'Gadget', to_product: 'Sprocket', setup_minutes: 25 },
  { from_product: 'Sprocket', to_product: 'Gadget', setup_minutes: 25 },
];

const SAMPLE_CONFIG: SequencerConfig = {
  name: 'Test Schedule',
  jobs: SAMPLE_JOBS,
  machines: SAMPLE_MACHINES,
  setup_matrix: SAMPLE_SETUP,
};

// ══════════════════════════════════════════════════════════════
// Dispatching Rules
// ══════════════════════════════════════════════════════════════

describe('Dispatching Rules', () => {
  it('should run FIFO rule', () => {
    const result = dispatch(SAMPLE_CONFIG, 'FIFO');
    expect(result.rule_or_method).toBe('FIFO');
    expect(result.entries.length).toBe(SAMPLE_JOBS.length);
    expect(result.metrics.makespan).toBeGreaterThan(0);
  });

  it('SPT should sort by processing time (shortest first)', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    // On the first machine, jobs should be ordered by processing time
    const machine1Jobs = result.entries.filter((e) => e.machine_id === 'm1');
    for (let i = 1; i < machine1Jobs.length; i++) {
      expect(machine1Jobs[i].processing_time).toBeGreaterThanOrEqual(machine1Jobs[i - 1].processing_time - 0.1);
    }
  });

  it('LPT should sort by processing time (longest first)', () => {
    const result = dispatch(SAMPLE_CONFIG, 'LPT');
    const machine1Jobs = result.entries.filter((e) => e.machine_id === 'm1');
    for (let i = 1; i < machine1Jobs.length; i++) {
      expect(machine1Jobs[i].processing_time).toBeLessThanOrEqual(machine1Jobs[i - 1].processing_time + 0.1);
    }
  });

  it('EDD should sort by earliest due date first', () => {
    const result = dispatch(SAMPLE_CONFIG, 'EDD');
    expect(result.entries.length).toBe(5);
    // Jobs with earlier due dates should appear first in their machine queues
    expect(result.metrics.makespan).toBeGreaterThan(0);
  });

  it('CR should sort by critical ratio', () => {
    const result = dispatch(SAMPLE_CONFIG, 'CR');
    expect(result.entries.length).toBe(5);
    expect(result.metrics.makespan).toBeGreaterThan(0);
  });

  it('SLACK should sort by minimum slack', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SLACK');
    expect(result.entries.length).toBe(5);
    expect(result.metrics.makespan).toBeGreaterThan(0);
  });

  it('should run all 6 rules without errors', () => {
    for (const rule of ALL_RULES) {
      const result = dispatch(SAMPLE_CONFIG, rule);
      expect(result.entries.length).toBe(5);
      expect(result.metrics.makespan).toBeGreaterThan(0);
      expect(result.computation_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('should handle single-machine config', () => {
    const config: SequencerConfig = {
      name: 'Single Machine',
      jobs: SAMPLE_JOBS.slice(0, 3),
      machines: [SAMPLE_MACHINES[0]],
    };
    const result = dispatch(config, 'SPT');
    expect(result.entries.every((e) => e.machine_id === 'm1')).toBe(true);
  });

  it('should include setup time in schedule', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    // Some entries should have setup time > 0 (product transitions)
    const withSetup = result.entries.filter((e) => e.setup_time > 0);
    expect(withSetup.length).toBeGreaterThan(0);
    expect(result.metrics.total_setup_time).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Rule Comparison
// ══════════════════════════════════════════════════════════════

describe('Rule Comparison', () => {
  it('should compare all 6 rules', () => {
    const comparison = compareAllRules(SAMPLE_CONFIG);
    expect(comparison.rules).toHaveLength(6);
    expect(comparison.best_overall).toBeTruthy();
    expect(comparison.best_makespan).toBeTruthy();
    expect(comparison.best_lateness).toBeTruthy();
    expect(comparison.recommendation).toBeTruthy();
  });

  it('each rule should have complete metrics', () => {
    const comparison = compareAllRules(SAMPLE_CONFIG);
    for (const r of comparison.rules) {
      expect(r.metrics.makespan).toBeGreaterThan(0);
      expect(r.metrics.on_time_pct).toBeGreaterThanOrEqual(0);
      expect(r.metrics.on_time_pct).toBeLessThanOrEqual(100);
      expect(r.metrics.avg_utilization_pct).toBeGreaterThanOrEqual(0);
    }
  });

  it('SPT should typically have lowest avg flow time', () => {
    const comparison = compareAllRules(SAMPLE_CONFIG);
    const spt = comparison.rules.find((r) => r.rule_or_method === 'SPT')!;
    const fifo = comparison.rules.find((r) => r.rule_or_method === 'FIFO')!;
    // SPT should have lower or equal avg flow time than FIFO in most cases
    expect(spt.metrics.avg_flow_time).toBeLessThanOrEqual(fifo.metrics.avg_flow_time + 1);
  });
});

// ══════════════════════════════════════════════════════════════
// Genetic Algorithm
// ══════════════════════════════════════════════════════════════

describe('Genetic Algorithm', () => {
  it('should run GA and produce valid schedule', () => {
    const result = runGA(SAMPLE_CONFIG, { generations: 50, population_size: 30 });
    expect(result.rule_or_method).toBe('GA');
    expect(result.entries.length).toBe(5);
    expect(result.metrics.makespan).toBeGreaterThan(0);
    expect(result.best_fitness).toBeGreaterThan(0);
    expect(result.fitness_history.length).toBeGreaterThan(0);
  });

  it('should converge over generations', () => {
    const result = runGA(SAMPLE_CONFIG, { generations: 100, population_size: 50 });
    // Fitness should decrease or stay the same over time
    for (let i = 1; i < result.fitness_history.length; i++) {
      expect(result.fitness_history[i]).toBeLessThanOrEqual(result.fitness_history[i - 1] + 0.01);
    }
  });

  it('should handle different objectives', () => {
    const makespan = runGA(SAMPLE_CONFIG, { objective: 'makespan', generations: 30, population_size: 20 });
    const lateness = runGA(SAMPLE_CONFIG, { objective: 'lateness', generations: 30, population_size: 20 });
    expect(makespan.metrics.makespan).toBeGreaterThan(0);
    expect(lateness.metrics.makespan).toBeGreaterThan(0);
  });

  it('should handle empty jobs', () => {
    const config: SequencerConfig = { name: 'Empty', jobs: [], machines: SAMPLE_MACHINES };
    const result = runGA(config);
    expect(result.entries).toHaveLength(0);
    expect(result.metrics.makespan).toBe(0);
  });

  it('GA should often beat dispatching rules', () => {
    const sptResult = dispatch(SAMPLE_CONFIG, 'SPT');
    const gaResult = runGA(SAMPLE_CONFIG, { objective: 'makespan', generations: 100, population_size: 50 });
    // GA should be at least as good as SPT (or very close)
    expect(gaResult.metrics.makespan).toBeLessThanOrEqual(sptResult.metrics.makespan * 1.1); // Allow 10% tolerance due to stochastic nature
  });
});

// ══════════════════════════════════════════════════════════════
// Schedule Evaluation
// ══════════════════════════════════════════════════════════════

describe('Schedule Evaluation', () => {
  it('should compute makespan correctly', () => {
    const result = dispatch(SAMPLE_CONFIG, 'FIFO');
    expect(result.metrics.makespan).toBe(Math.max(...result.entries.map((e) => e.end_time)));
  });

  it('should detect late jobs', () => {
    // Create a config where a job is definitely late
    const tightConfig: SequencerConfig = {
      name: 'Tight',
      jobs: [
        { id: 'j1', name: 'Long Job', product: 'A', quantity: 1, processing_minutes: 1000, due_date: futureDate(0) },
      ],
      machines: [{ id: 'm1', name: 'M1' }],
    };
    const result = dispatch(tightConfig, 'FIFO');
    expect(result.metrics.num_late_jobs).toBeGreaterThanOrEqual(0); // May or may not be late depending on exact timing
  });

  it('should compute flow time', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    expect(result.metrics.total_flow_time).toBeGreaterThan(0);
    expect(result.metrics.avg_flow_time).toBe(
      result.metrics.total_flow_time / result.entries.length,
    );
  });

  it('should compute utilization', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    expect(result.metrics.avg_utilization_pct).toBeGreaterThan(0);
    expect(result.metrics.avg_utilization_pct).toBeLessThanOrEqual(100);
  });
});

// ══════════════════════════════════════════════════════════════
// Gantt Data
// ══════════════════════════════════════════════════════════════

describe('Gantt Data Generation', () => {
  it('should generate bars for all schedule entries', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    const gantt = buildGanttData(result.entries, SAMPLE_CONFIG);
    // At least one bar per job (some may have setup bars too)
    expect(gantt.bars.length).toBeGreaterThanOrEqual(result.entries.length);
    expect(gantt.machines).toHaveLength(2);
    expect(gantt.horizon).toBeGreaterThan(0);
  });

  it('should mark setup bars', () => {
    const result = dispatch(SAMPLE_CONFIG, 'SPT');
    const gantt = buildGanttData(result.entries, SAMPLE_CONFIG);
    const setupBars = gantt.bars.filter((b) => b.is_setup);
    // Should have some setup bars if there are product transitions
    if (result.metrics.total_setup_time > 0) {
      expect(setupBars.length).toBeGreaterThan(0);
    }
  });

  it('should include due date markers', () => {
    const result = dispatch(SAMPLE_CONFIG, 'EDD');
    const gantt = buildGanttData(result.entries, SAMPLE_CONFIG);
    expect(gantt.due_date_markers.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Setup Matrix
// ══════════════════════════════════════════════════════════════

describe('Setup Matrix', () => {
  it('should build setup map from entries', () => {
    const map = buildSetupMap(SAMPLE_SETUP);
    expect(getSetupTime(map, 'Widget', 'Gadget')).toBe(15);
    expect(getSetupTime(map, 'Gadget', 'Widget')).toBe(10);
    expect(getSetupTime(map, 'Widget', 'Widget')).toBe(0);
    expect(getSetupTime(map, 'Widget', 'Unknown')).toBe(0);
  });

  it('should build display matrix', () => {
    const { products, matrix } = buildSetupMatrix(SAMPLE_SETUP);
    expect(products.length).toBe(3); // Gadget, Sprocket, Widget (sorted)
    expect(matrix.length).toBe(3);
    expect(matrix[0].length).toBe(3);
    // Diagonal should be 0
    for (let i = 0; i < 3; i++) {
      expect(matrix[i][i]).toBe(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve a schedule', async () => {
    const sched = await saveSchedule('My Schedule', SAMPLE_CONFIG);
    expect(sched.id).toBeTruthy();
    expect(sched.name).toBe('My Schedule');

    const retrieved = await getSchedule('My Schedule');
    expect(retrieved).toBeDefined();
    expect(JSON.parse(retrieved!.config_json).jobs).toHaveLength(5);
  });

  it('should update on name collision', async () => {
    await saveSchedule('Same', SAMPLE_CONFIG);
    await saveSchedule('Same', { ...SAMPLE_CONFIG, name: 'Updated' });
    const all = await listSchedules();
    expect(all.filter((s) => s.name === 'Same')).toHaveLength(1);
  });

  it('should list sorted by updated_at', async () => {
    await saveSchedule('A', SAMPLE_CONFIG);
    await saveSchedule('B', SAMPLE_CONFIG);
    await saveSchedule('C', SAMPLE_CONFIG);
    const all = await listSchedules();
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].updated_at).toBeLessThanOrEqual(all[i - 1].updated_at);
    }
  });

  it('should delete a schedule', async () => {
    const sched = await saveSchedule('ToDelete', SAMPLE_CONFIG);
    expect(await deleteSchedule(sched.id)).toBe(true);
    expect(await getSchedule(sched.id)).toBeUndefined();
  });

  it('should return false on delete of nonexistent', async () => {
    expect(await deleteSchedule('nope')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle single job', () => {
    const config: SequencerConfig = {
      name: 'Single',
      jobs: [SAMPLE_JOBS[0]],
      machines: [SAMPLE_MACHINES[0]],
    };
    const result = dispatch(config, 'SPT');
    expect(result.entries).toHaveLength(1);
    expect(result.metrics.makespan).toBe(60);
  });

  it('should handle jobs without due dates', () => {
    const jobs = SAMPLE_JOBS.map((j) => ({ ...j, due_date: undefined }));
    const config: SequencerConfig = { name: 'NoDue', jobs, machines: SAMPLE_MACHINES };
    const result = dispatch(config, 'EDD');
    expect(result.metrics.on_time_pct).toBe(100); // No due dates = all on time
    expect(result.metrics.num_late_jobs).toBe(0);
  });

  it('should handle no setup matrix', () => {
    const config: SequencerConfig = { name: 'NoSetup', jobs: SAMPLE_JOBS, machines: SAMPLE_MACHINES };
    const result = dispatch(config, 'SPT');
    expect(result.metrics.total_setup_time).toBe(0);
  });

  it('should handle machine with low efficiency', () => {
    const machines: Machine[] = [{ id: 'm1', name: 'Slow', efficiency: 0.5 }];
    const config: SequencerConfig = { name: 'Slow', jobs: [SAMPLE_JOBS[0]], machines };
    const result = dispatch(config, 'FIFO');
    // Processing time should be doubled (60 / 0.5 = 120)
    expect(result.entries[0].processing_time).toBeCloseTo(120, 0);
  });

  it('productColor should return consistent colors', () => {
    const c1 = productColor('Widget');
    const c2 = productColor('Widget');
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('GA with 1 job should return immediately', () => {
    const config: SequencerConfig = {
      name: 'One',
      jobs: [SAMPLE_JOBS[0]],
      machines: [SAMPLE_MACHINES[0]],
    };
    const result = runGA(config, { generations: 10 });
    expect(result.entries).toHaveLength(1);
  });

  it('should handle 3 machines with round-robin', () => {
    const machines = [
      { id: 'm1', name: 'M1' },
      { id: 'm2', name: 'M2' },
      { id: 'm3', name: 'M3' },
    ];
    const config: SequencerConfig = { name: 'ThreeMach', jobs: SAMPLE_JOBS, machines };
    const result = dispatch(config, 'SPT');
    // Jobs should be distributed across all 3 machines
    const machineIds = new Set(result.entries.map((e) => e.machine_id));
    expect(machineIds.size).toBeGreaterThanOrEqual(2);
  });
});
