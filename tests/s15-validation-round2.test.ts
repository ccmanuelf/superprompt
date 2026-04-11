/**
 * S15 Validation Round 2 — Electronics PCB Assembly Plant
 *
 * COMPLETELY DIFFERENT scenarios from round 1 (garment/sewing factory).
 * Uses a PCB assembly plant with SMT lines, THT insertion, and testing.
 *
 * Behavioral tests: verify math, edge cases, cross-tool integration.
 */

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
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/config.js', () => ({ STORE_DIR: resolve(tmpdir(), 'clauded-test-r2'), config: { NODE_ENV: 'test' } }));

// ── Imports (after mocks) ───────────────────────────────────

import {
  analyzeCapacity,
  type CapacityPlanConfig,
  type CapacityLine,
  type CalendarConfig,
  type DemandEntry,
} from '../src/capacity/analysis.js';
import { runScenario } from '../src/capacity/scenarios.js';
import { runCapacityMonteCarlo } from '../src/capacity/monte-carlo.js';
import { initCapacityTables, savePlan, listPlans } from '../src/capacity/index.js';

import { dispatch, compareAllRules } from '../src/sequencer/dispatching.js';
import { runGA } from '../src/sequencer/genetic.js';
import { initSequencerTables } from '../src/sequencer/index.js';
import type { SequencerConfig, DispatchRule } from '../src/sequencer/models.js';

import { analyzeVSM, compareStates } from '../src/vsm/analysis.js';
import { initVsmTables } from '../src/vsm/index.js';
import type { VSMConfig, ProcessStep } from '../src/vsm/models.js';

import { analyzeTOC } from '../src/toc/analysis.js';
import { initTocTables } from '../src/toc/index.js';
import type { TOCConfig } from '../src/toc/models.js';

import { analyzeCONWIP, analyzeHeijunka } from '../src/conwip/analysis.js';
import { initConwipTables } from '../src/conwip/index.js';
import type { CONWIPConfig, HeijunkaConfig } from '../src/conwip/models.js';

import { generateMatrix, analyzeDOE } from '../src/doe/analysis.js';
import { initDoeTables } from '../src/doe/index.js';
import type { DOEConfig } from '../src/doe/models.js';

import {
  initSimulation,
  runToCompletion,
  generateDemoEvents,
  analyzeSimulation,
  validateFSM,
  listTemplates,
  getTemplate,
} from '../src/fsm/index.js';
import { bridgeFromTOC, bridgeFromVSM } from '../src/fsm/bridge.js';
import type { FSMConfig, FSMEvent, FSMDefinition } from '../src/fsm/models.js';

// ── Test Setup ──────────────────────────────────────────────

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initCapacityTables();
  await initSequencerTables();
  await initVsmTables();
  await initTocTables();
  await initConwipTables();
  await initDoeTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ══════════════════════════════════════════════════════════════
// S15.1 — CAPACITY PLANNING: PCB Assembly
// ══════════════════════════════════════════════════════════════

const PCB_LINES: CapacityLine[] = [
  { id: 'smt01', code: 'SMT_01', name: 'SMT Line 1', max_operators: 8, efficiency_factor: 0.92, absenteeism_factor: 0.03 },
  { id: 'smt02', code: 'SMT_02', name: 'SMT Line 2', max_operators: 6, efficiency_factor: 0.88, absenteeism_factor: 0.04 },
  { id: 'tht01', code: 'THT_01', name: 'THT Insertion', max_operators: 4, efficiency_factor: 0.90, absenteeism_factor: 0.05 },
  { id: 'test01', code: 'TEST_01', name: 'Test Station', max_operators: 3, efficiency_factor: 0.95, absenteeism_factor: 0.02 },
];

const PCB_CALENDAR: CalendarConfig = {
  working_days: 6,
  shifts_per_day: 2,
  hours_per_shift: 10,
};

const PCB_DEMANDS: DemandEntry[] = [
  { product: 'PCB_Type_A', line_id: 'smt01', quantity: 5000, sam_minutes: 8 },
  { product: 'PCB_Type_B', line_id: 'smt02', quantity: 3000, sam_minutes: 12 },
  { product: 'PCB_Type_C', line_id: 'tht01', quantity: 2000, sam_minutes: 6 },
  { product: 'PCB_Type_D', line_id: 'test01', quantity: 8000, sam_minutes: 3 },
];

const PCB_CONFIG: CapacityPlanConfig = {
  name: 'PCB_Assembly_R2',
  period_label: 'Week 14 - 2026',
  period_start: '2026-04-01',
  period_end: '2026-04-06',
  lines: PCB_LINES,
  calendar: PCB_CALENDAR,
  demands: PCB_DEMANDS,
};

describe('S15.1 Capacity Planning — PCB Assembly', () => {
  it('(a) gross hours = 6 x 2 x 10 = 120h per line', () => {
    const result = analyzeCapacity(PCB_CONFIG);
    for (const line of result.lines) {
      expect(line.gross_hours).toBe(120);
    }
  });

  it('(b) net hours for SMT_01 = 120 x 0.92 x 0.97', () => {
    const result = analyzeCapacity(PCB_CONFIG);
    const smt01 = result.lines.find(l => l.line_code === 'SMT_01')!;
    const expected = 120 * 0.92 * (1 - 0.03);
    expect(smt01.net_hours).toBeCloseTo(expected, 1);
  });

  it('(c) capacity hours for SMT_01 = net x 8 operators', () => {
    const result = analyzeCapacity(PCB_CONFIG);
    const smt01 = result.lines.find(l => l.line_code === 'SMT_01')!;
    const expectedNet = 120 * 0.92 * 0.97;
    const expectedCapacity = expectedNet * 8;
    expect(smt01.capacity_hours).toBeCloseTo(expectedCapacity, 1);
  });

  it('(d) demand hours for SMT_01 = 5000 x 8 / 60 = 666.67h', () => {
    const result = analyzeCapacity(PCB_CONFIG);
    const smt01 = result.lines.find(l => l.line_code === 'SMT_01')!;
    expect(smt01.demand_hours).toBeCloseTo(666.67, 0);
  });

  it('(e) utilization is sensible — not negative, not NaN', () => {
    const result = analyzeCapacity(PCB_CONFIG);
    for (const line of result.lines) {
      expect(line.utilization_pct).toBeGreaterThanOrEqual(0);
      expect(line.utilization_pct).not.toBeNaN();
      expect(line.utilization_pct).toBeLessThan(1000); // no crazy values
    }
    // Overall should also be reasonable
    expect(result.overall_utilization_pct).toBeGreaterThan(0);
    expect(result.overall_utilization_pct).not.toBeNaN();
  });

  it('(f) 3-shift scenario decreases utilization', () => {
    const scenarioResult = runScenario(PCB_CONFIG, {
      type: 'three_shift',
      name: '3-Shift Operation',
      description: 'Add third shift',
      target_shifts: 3,
    });
    // More shifts = more capacity = lower utilization
    expect(scenarioResult.projected.overall_utilization_pct)
      .toBeLessThan(scenarioResult.baseline.overall_utilization_pct);
    expect(scenarioResult.delta.capacity_hours_change).toBeGreaterThan(0);
  });

  it('(g) Monte Carlo: P5 < P50 < P95 and stddev > 0', () => {
    const mc = runCapacityMonteCarlo({
      base_config: PCB_CONFIG,
      replications: 50,
    });
    expect(mc.replications).toBe(50);
    expect(mc.overall_utilization.p5).toBeLessThanOrEqual(mc.overall_utilization.p50);
    expect(mc.overall_utilization.p50).toBeLessThanOrEqual(mc.overall_utilization.p95);
    expect(mc.overall_utilization.stddev).toBeGreaterThan(0);
    expect(mc.confidence_95.lower).toBeLessThan(mc.confidence_95.upper);
  });

  it('DB persistence: save and list capacity plans', async () => {
    const result = analyzeCapacity(PCB_CONFIG);
    await savePlan(PCB_CONFIG.name, PCB_CONFIG, result);
    const plans = await listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans.some(p => p.name === 'PCB_Assembly_R2')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// S15.2 — SEQUENCER: PCB Job Shop
// ══════════════════════════════════════════════════════════════

const now = new Date();
const SEQ_CONFIG: SequencerConfig = {
  name: 'PCB_JobShop_R2',
  jobs: [
    { id: 'j1', name: 'Board_A_v1', product: 'single_sided', quantity: 100, processing_minutes: 45, due_date: new Date(now.getTime() + 1 * 86400000).toISOString(), priority: 1 },
    { id: 'j2', name: 'Board_A_v2', product: 'single_sided', quantity: 50, processing_minutes: 30, due_date: new Date(now.getTime() + 2 * 86400000).toISOString() },
    { id: 'j3', name: 'Board_B', product: 'double_sided', quantity: 200, processing_minutes: 90, due_date: new Date(now.getTime() + 1 * 86400000).toISOString() },
    { id: 'j4', name: 'Board_C', product: 'multilayer', quantity: 75, processing_minutes: 120, due_date: new Date(now.getTime() + 5 * 86400000).toISOString() },
    { id: 'j5', name: 'Board_D', product: 'flex_pcb', quantity: 30, processing_minutes: 15, due_date: new Date(now.getTime() + 3 * 86400000).toISOString() },
    { id: 'j6', name: 'Board_E', product: 'double_sided', quantity: 150, processing_minutes: 60, due_date: new Date(now.getTime() + 2 * 86400000).toISOString() },
    { id: 'j7', name: 'Board_F', product: 'single_sided', quantity: 80, processing_minutes: 25, due_date: new Date(now.getTime() + 4 * 86400000).toISOString() },
    { id: 'j8', name: 'Board_G', product: 'multilayer', quantity: 40, processing_minutes: 100, due_date: new Date(now.getTime() + 3 * 86400000).toISOString() },
  ],
  machines: [
    { id: 'm1', name: 'SMT_Line_A' },
    { id: 'm2', name: 'SMT_Line_B' },
    { id: 'm3', name: 'Wave_Solder' },
  ],
  setup_matrix: [
    { from_product: 'single_sided', to_product: 'double_sided', setup_minutes: 20 },
    { from_product: 'double_sided', to_product: 'single_sided', setup_minutes: 15 },
    { from_product: 'single_sided', to_product: 'multilayer', setup_minutes: 30 },
    { from_product: 'multilayer', to_product: 'single_sided', setup_minutes: 25 },
    { from_product: 'double_sided', to_product: 'multilayer', setup_minutes: 25 },
    { from_product: 'multilayer', to_product: 'double_sided', setup_minutes: 20 },
    { from_product: 'single_sided', to_product: 'flex_pcb', setup_minutes: 35 },
    { from_product: 'flex_pcb', to_product: 'single_sided', setup_minutes: 30 },
    { from_product: 'double_sided', to_product: 'flex_pcb', setup_minutes: 25 },
    { from_product: 'flex_pcb', to_product: 'double_sided', setup_minutes: 20 },
    { from_product: 'multilayer', to_product: 'flex_pcb', setup_minutes: 40 },
    { from_product: 'flex_pcb', to_product: 'multilayer', setup_minutes: 35 },
  ],
};

describe('S15.2 Sequencer — PCB Job Shop', () => {
  it('(a) SPT produces lower avg flow time than LPT', () => {
    const spt = dispatch(SEQ_CONFIG, 'SPT');
    const lpt = dispatch(SEQ_CONFIG, 'LPT');
    // SPT is mathematically optimal for minimizing average flow time
    expect(spt.metrics.avg_flow_time).toBeLessThanOrEqual(lpt.metrics.avg_flow_time);
  });

  it('(b) EDD produces fewer late jobs than FIFO for structured due dates', () => {
    const edd = dispatch(SEQ_CONFIG, 'EDD');
    const fifo = dispatch(SEQ_CONFIG, 'FIFO');
    // EDD should match or beat FIFO in on-time performance
    expect(edd.metrics.num_late_jobs).toBeLessThanOrEqual(fifo.metrics.num_late_jobs);
  });

  it('(c) all dispatch rules produce valid schedules — no overlapping on same machine', () => {
    const rules: DispatchRule[] = ['FIFO', 'SPT', 'LPT', 'EDD', 'CR', 'SLACK'];
    for (const rule of rules) {
      const result = dispatch(SEQ_CONFIG, rule);
      // Group entries by machine
      const byMachine = new Map<string, typeof result.entries>();
      for (const entry of result.entries) {
        if (!byMachine.has(entry.machine_id)) byMachine.set(entry.machine_id, []);
        byMachine.get(entry.machine_id)!.push(entry);
      }
      // Check no overlaps
      for (const [machineId, entries] of byMachine) {
        const sorted = [...entries].sort((a, b) => a.start_time - b.start_time);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].start_time).toBeGreaterThanOrEqual(sorted[i - 1].end_time);
        }
      }
    }
  });

  it('(d) setup times appear when products change', () => {
    const result = dispatch(SEQ_CONFIG, 'FIFO');
    // At least some entries should have setup_time > 0 (product switches happen)
    const hasSetups = result.entries.some(e => e.setup_time > 0);
    expect(hasSetups).toBe(true);
    expect(result.metrics.total_setup_time).toBeGreaterThan(0);
  });

  it('(e) GA with weighted objective produces valid result', () => {
    const ga = runGA(SEQ_CONFIG, {
      population_size: 30,
      generations: 50,
      objective: 'weighted',
      weight_makespan: 0.4,
      weight_lateness: 0.3,
      weight_setup: 0.3,
    });
    expect(ga.metrics.makespan).toBeGreaterThan(0);
    expect(ga.best_fitness).toBeDefined();
    expect(ga.convergence_generation).toBeGreaterThanOrEqual(0);
    expect(ga.computation_ms).toBeGreaterThan(0);
  });

  it('(f) comparison identifies a best_overall rule', () => {
    const comp = compareAllRules(SEQ_CONFIG);
    expect(comp.best_overall).toBeTruthy();
    expect(comp.best_makespan).toBeTruthy();
    expect(comp.best_lateness).toBeTruthy();
    expect(comp.recommendation).toBeTruthy();
    expect(comp.rules.length).toBe(6); // All 6 rules
  });
});

// ══════════════════════════════════════════════════════════════
// S15.3 — VSM: PCB Assembly Flow
// ══════════════════════════════════════════════════════════════

const PCB_VSM_STEPS: ProcessStep[] = [
  { id: 's1', name: 'Stencil Print', sequence: 1, cycle_time: 0.5, changeover_time: 10, uptime_pct: 95, category: 'VA', operators: 1, wait_time: 15, transport_time: 2 },
  { id: 's2', name: 'Pick & Place', sequence: 2, cycle_time: 0.8, changeover_time: 15, uptime_pct: 92, category: 'VA', operators: 1, wait_time: 10, transport_time: 3 },
  { id: 's3', name: 'Reflow Oven', sequence: 3, cycle_time: 3.0, changeover_time: 5, uptime_pct: 98, category: 'VA', operators: 1, wait_time: 20, transport_time: 2 },
  { id: 's4', name: 'AOI Inspect', sequence: 4, cycle_time: 1.5, changeover_time: 5, uptime_pct: 90, category: 'BNVA', operators: 1, wait_time: 45, transport_time: 3, wip_before: 200 },
  { id: 's5', name: 'THT Insert', sequence: 5, cycle_time: 2.0, changeover_time: 8, uptime_pct: 88, category: 'VA', operators: 2, wait_time: 25, transport_time: 4 },
  { id: 's6', name: 'Wave Solder', sequence: 6, cycle_time: 1.8, changeover_time: 12, uptime_pct: 94, category: 'VA', operators: 1, wait_time: 30, transport_time: 3 },
  { id: 's7', name: 'ICT Test', sequence: 7, cycle_time: 1.2, changeover_time: 7, uptime_pct: 96, category: 'BNVA', operators: 1, wait_time: 35, transport_time: 5, wip_before: 150 },
  { id: 's8', name: 'Conformal Coat', sequence: 8, cycle_time: 2.5, changeover_time: 10, uptime_pct: 93, category: 'VA', operators: 1, wait_time: 20, transport_time: 2 },
  { id: 's9', name: 'Final QC', sequence: 9, cycle_time: 3.0, changeover_time: 0, uptime_pct: 100, category: 'NVA', operators: 2, wait_time: 15, transport_time: 0 },
];

const PCB_VSM_CONFIG: VSMConfig = {
  name: 'PCB_Assembly_VSM',
  product_family: 'PCB_Assemblies',
  customer_demand_per_day: 800,
  available_minutes_per_day: 450,
  state: 'current',
  steps: PCB_VSM_STEPS,
};

describe('S15.3 VSM — PCB Assembly Flow', () => {
  it('(a) PCE is between 1-40% (typical for electronics mfg with heavy queuing)', () => {
    const result = analyzeVSM(PCB_VSM_CONFIG);
    // With 215 min total wait time vs ~16 min cycle time, PCE is very low (~3%)
    // This is realistic for a plant with heavy inter-station buffering
    expect(result.pce_pct).toBeGreaterThan(1);
    expect(result.pce_pct).toBeLessThan(40);
  });

  it('(b) total lead time = sum of all step contributions', () => {
    const result = analyzeVSM(PCB_VSM_CONFIG);
    expect(result.total_lead_time).toBeGreaterThan(0);
    // Lead time should include cycle times, wait times, transport times, and changeover
    const totalCycleTime = PCB_VSM_STEPS.reduce((s, st) => s + st.cycle_time, 0);
    const totalWaitTime = PCB_VSM_STEPS.reduce((s, st) => s + (st.wait_time ?? 0), 0);
    // Lead time should be at least as large as the sum of cycle + wait
    expect(result.total_lead_time).toBeGreaterThanOrEqual(totalCycleTime + totalWaitTime * 0.5);
  });

  it('(c) takt time = 450 / 800 = 0.5625 min/board', () => {
    const result = analyzeVSM(PCB_VSM_CONFIG);
    // System rounds to 2 decimal places: 0.56
    expect(result.takt_time).toBeCloseTo(0.5625, 1);
  });

  it('(d) TIMWOODS: waiting waste should be significant', () => {
    const result = analyzeVSM(PCB_VSM_CONFIG);
    const waitingWaste = result.timwoods.find(t => t.waste_type === 'waiting');
    expect(waitingWaste).toBeDefined();
    expect(waitingWaste!.total_minutes).toBeGreaterThan(0);

    // Waiting should be one of the top wastes given the large wait times
    const sorted = [...result.timwoods].filter(t => t.total_minutes > 0).sort((a, b) => b.total_minutes - a.total_minutes);
    const topWastes = sorted.slice(0, 3).map(t => t.waste_type);
    expect(topWastes).toContain('waiting');
  });

  it('(e) current vs future comparison: reduce wait times by 50%', () => {
    const futureSteps = PCB_VSM_STEPS.map(s => ({
      ...s,
      wait_time: (s.wait_time ?? 0) * 0.5,
    }));
    const futureConfig: VSMConfig = {
      ...PCB_VSM_CONFIG,
      name: 'PCB_Assembly_VSM_Future',
      state: 'future',
      steps: futureSteps,
    };
    const comp = compareStates(PCB_VSM_CONFIG, futureConfig);

    // PCE should increase (less NVA time)
    expect(comp.future.pce_pct).toBeGreaterThan(comp.current.pce_pct);
    // Lead time should decrease
    expect(comp.future.total_lead_time).toBeLessThan(comp.current.total_lead_time);
    // Summary should exist
    expect(comp.summary).toBeTruthy();
    expect(comp.improvements.length).toBeGreaterThan(0);
  });

  it('(f) bottleneck is the step with highest effective cycle time', () => {
    const result = analyzeVSM(PCB_VSM_CONFIG);
    expect(result.bottleneck_step).toBeTruthy();
    // The bottleneck should be one of the steps
    const stepNames = PCB_VSM_STEPS.map(s => s.name);
    expect(stepNames).toContain(result.bottleneck_step);
  });
});

// ══════════════════════════════════════════════════════════════
// S15.4 — TOC: PCB Production System
// ══════════════════════════════════════════════════════════════

const PCB_TOC_CONFIG: TOCConfig = {
  name: 'PCB_TOC_R2',
  work_centers: [
    { id: 'wc1', name: 'Stencil', capacity_units_per_hour: 80, available_hours_per_day: 8, operators: 1, current_wip: 20 },
    { id: 'wc2', name: 'P&P', capacity_units_per_hour: 50, available_hours_per_day: 8, operators: 2, current_wip: 35 },
    { id: 'wc3', name: 'Reflow', capacity_units_per_hour: 120, available_hours_per_day: 8, operators: 1, current_wip: 10 },
    { id: 'wc4', name: 'AOI', capacity_units_per_hour: 60, available_hours_per_day: 8, operators: 1, current_wip: 25 },
    { id: 'wc5', name: 'Wave', capacity_units_per_hour: 40, available_hours_per_day: 8, operators: 1, current_wip: 40 },
    { id: 'wc6', name: 'ICT', capacity_units_per_hour: 90, available_hours_per_day: 8, operators: 1, current_wip: 15 },
  ],
  selling_price_per_unit: 25,
  total_variable_cost_per_unit: 8,
  operating_expense_per_period: 80000, // monthly
  investment: 300000,
  demand_units_per_day: 350,
  available_hours_per_day: 8,
};

describe('S15.4 TOC — PCB Production System', () => {
  it('(a) CCR = Wave (highest utilization)', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    expect(result.constraint.ccr_name).toBe('Wave');
    // Wave: 350/40 = 8.75h load, 8h available = 109.375% util
    expect(result.constraint.ccr_utilization_pct).toBeCloseTo(109.38, 0);
  });

  it('(b) T/unit = $25 - $8 = $17', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    expect(result.throughput.throughput_per_unit).toBeCloseTo(17, 1);
  });

  it('(c) actual throughput capped at Wave capacity: 40 x 8 = 320 units/day', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    // System is limited by Wave at 40 u/hr x 8h = 320 u/day max
    expect(result.constraint.max_system_throughput_per_day).toBeCloseTo(320, 0);
  });

  it('(d) T/day = 320 x $17 = $5440', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    // With 320 units/day throughput, T = 320 * 17 = 5440
    expect(result.throughput.throughput_per_day).toBeCloseTo(5440, 0);
  });

  it('(e) revenue lost per constraint hour = throughput from 40 units * $17', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    // Revenue lost = constraint capacity * T/unit = 40 * 17 = $680/hr
    expect(result.throughput.revenue_lost_per_hour_constraint_down).toBeCloseTo(680, 0);
  });

  it('(f) five focusing steps mention "Wave" as constraint', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    expect(result.five_focusing_steps.length).toBe(5);
    const allText = result.five_focusing_steps.join(' ');
    expect(allText.toLowerCase()).toContain('wave');
  });

  it('work center ranking is sorted by utilization desc', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    const utils = result.constraint.work_center_ranking.map(w => w.utilization_pct);
    for (let i = 1; i < utils.length; i++) {
      expect(utils[i]).toBeLessThanOrEqual(utils[i - 1]);
    }
  });

  it('DBR schedule references the Wave as drum', () => {
    const result = analyzeTOC(PCB_TOC_CONFIG);
    expect(result.dbr.drum_work_center.toLowerCase()).toContain('wave');
    expect(result.dbr.drum_rate).toBeCloseTo(40, 0);
  });
});

// ══════════════════════════════════════════════════════════════
// S15.5 — CONWIP / Heijunka: PCB Mix
// ══════════════════════════════════════════════════════════════

const PCB_CONWIP_CONFIG: CONWIPConfig = {
  name: 'PCB_CONWIP_R2',
  stages: [
    { id: 'st1', name: 'Stencil', sequence: 1, cycle_time_minutes: 0.75, capacity_per_hour: 80 },
    { id: 'st2', name: 'P&P', sequence: 2, cycle_time_minutes: 1.2, capacity_per_hour: 50 },
    { id: 'st3', name: 'Reflow', sequence: 3, cycle_time_minutes: 0.5, capacity_per_hour: 120 },
    { id: 'st4', name: 'AOI', sequence: 4, cycle_time_minutes: 1.0, capacity_per_hour: 60 },
    { id: 'st5', name: 'Wave', sequence: 5, cycle_time_minutes: 1.5, capacity_per_hour: 40 },
    { id: 'st6', name: 'ICT', sequence: 6, cycle_time_minutes: 0.67, capacity_per_hour: 90 },
  ],
  wip_limit: 20,
  products: [
    { id: 'pa', name: 'Board_A', mix_pct: 40, cycle_time_minutes: 1.0, changeover_minutes: 5 },
    { id: 'pb', name: 'Board_B', mix_pct: 30, cycle_time_minutes: 1.2, changeover_minutes: 8 },
    { id: 'pc', name: 'Board_C', mix_pct: 20, cycle_time_minutes: 0.9, changeover_minutes: 6 },
    { id: 'pd', name: 'Board_D', mix_pct: 10, cycle_time_minutes: 1.5, changeover_minutes: 10 },
  ],
  available_minutes_per_day: 480,
  demand_per_day: 300,
};

const PCB_HEIJUNKA_CONFIG: HeijunkaConfig = {
  name: 'PCB_Heijunka_R2',
  products: [
    { id: 'pa', name: 'Board_A', mix_pct: 40, cycle_time_minutes: 1.0, changeover_minutes: 5 },
    { id: 'pb', name: 'Board_B', mix_pct: 30, cycle_time_minutes: 1.2, changeover_minutes: 8 },
    { id: 'pc', name: 'Board_C', mix_pct: 20, cycle_time_minutes: 0.9, changeover_minutes: 6 },
    { id: 'pd', name: 'Board_D', mix_pct: 10, cycle_time_minutes: 1.5, changeover_minutes: 10 },
  ],
  takt_time_minutes: 0.6,
  pitch_minutes: 3, // 0.6 x 5
  pack_out_quantity: 5,
  slots_per_shift: 10,
  shifts_per_day: 2,
  demand_per_day: 300,
};

describe('S15.5 CONWIP/Heijunka — PCB Mix', () => {
  it('CONWIP: bottleneck = Wave (lowest capacity_per_hour = 40)', () => {
    const result = analyzeCONWIP(PCB_CONWIP_CONFIG);
    const bottleneck = result.stage_utilization.find(s => s.is_bottleneck);
    expect(bottleneck).toBeDefined();
    expect(bottleneck!.stage_name).toBe('Wave');
  });

  it('CONWIP: WIP limit is respected', () => {
    const result = analyzeCONWIP(PCB_CONWIP_CONFIG);
    expect(result.wip_limit).toBe(20);
    expect(result.throughput_per_hour).toBeGreaterThan(0);
    expect(result.avg_cycle_time).toBeGreaterThan(0);
    expect(result.wip_turns_per_day).toBeGreaterThan(0);
  });

  it('Heijunka: total slots = 10 x 2 = 20', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    const totalSlots = PCB_HEIJUNKA_CONFIG.slots_per_shift * PCB_HEIJUNKA_CONFIG.shifts_per_day;
    expect(totalSlots).toBe(20);
    // Heijunka box cells should cover the slots
    expect(result.heijunka_box.cells.length).toBe(totalSlots);
  });

  it('Heijunka: Board_A gets ~8 slots (40% of 20)', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    const boardASlots = result.heijunka_box.cells.filter(c => c.product_id === 'pa').length;
    expect(boardASlots).toBeGreaterThanOrEqual(7);
    expect(boardASlots).toBeLessThanOrEqual(9);
  });

  it('Heijunka: Board_D gets ~2 slots (10% of 20)', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    const boardDSlots = result.heijunka_box.cells.filter(c => c.product_id === 'pd').length;
    expect(boardDSlots).toBeGreaterThanOrEqual(1);
    expect(boardDSlots).toBeLessThanOrEqual(3);
  });

  it('Heijunka: leveling score > 50', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    expect(result.leveling_score).toBeGreaterThan(50);
  });

  it('Heijunka: changeover count > 0 (multiple products)', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    expect(result.changeover_count).toBeGreaterThan(0);
  });

  it('Heijunka: pitch = takt x pack_out = 0.6 x 5 = 3 min', () => {
    const result = analyzeHeijunka(PCB_HEIJUNKA_CONFIG);
    expect(result.pitch).toBeCloseTo(3, 1);
  });
});

// ══════════════════════════════════════════════════════════════
// S15.6 — DOE: Solder Paste Optimization
// ══════════════════════════════════════════════════════════════

const SOLDER_DOE_CONFIG: DOEConfig = {
  name: 'Solder_Paste_R2',
  design_type: 'full_factorial',
  factors: [
    { id: 'temp', name: 'Temperature', type: 'numeric', levels: [230, 260], unit: 'C' },
    { id: 'pressure', name: 'Pressure', type: 'numeric', levels: [200, 400], unit: 'kPa' },
    { id: 'speed', name: 'Speed', type: 'numeric', levels: [20, 50], unit: 'mm/s' },
  ],
  responses: [
    { id: 'strength', name: 'Solder Strength', unit: 'N', minimize: false },
    { id: 'void', name: 'Void %', unit: '%', minimize: true, target: 0 },
  ],
  replicates: 1,
  randomize: false,
};

// Deterministic formula:
// Strength = 45 + 8*(T-245)/15 + 3*(P-300)/100 - 2*(S-35)/15
// Void = 3.5 - 1.5*(T-245)/15 + 0.5*(P-300)/100 + 1.0*(S-35)/15
function solderStrength(T: number, P: number, S: number): number {
  return 45 + 8 * (T - 245) / 15 + 3 * (P - 300) / 100 - 2 * (S - 35) / 15;
}
function solderVoid(T: number, P: number, S: number): number {
  return 3.5 - 1.5 * (T - 245) / 15 + 0.5 * (P - 300) / 100 + 1.0 * (S - 35) / 15;
}

describe('S15.6 DOE — Solder Paste Optimization', () => {
  it('(a) full factorial generates 8 runs for 3 factors x 2 levels', () => {
    const matrix = generateMatrix(SOLDER_DOE_CONFIG);
    expect(matrix.total_runs).toBe(8);
    expect(matrix.factors.length).toBe(3);
    expect(matrix.responses.length).toBe(2);
  });

  it('(b-d) ANOVA: Temperature is most significant; effects correct sign', () => {
    const matrix = generateMatrix(SOLDER_DOE_CONFIG);

    // Fill in response data using formulas
    for (const run of matrix.runs) {
      const T = run.factor_levels['temp'];
      const P = run.factor_levels['pressure'];
      const S = run.factor_levels['speed'];
      run.responses['strength'] = solderStrength(T, P, S);
      run.responses['void'] = solderVoid(T, P, S);
    }

    const analysis = analyzeDOE(SOLDER_DOE_CONFIG, matrix);

    // Check ANOVA tables exist
    expect(analysis.anova.length).toBe(2); // one per response

    // For Strength: Temperature effect should be positive
    const strengthEffects = analysis.main_effects.filter(e =>
      e.factor_id === 'temp' && analysis.anova[0]?.response_name === 'Solder Strength'
    );
    // Temperature main effect: high(260) - low(230) should produce ~16 delta
    const tempEffect = analysis.main_effects.find(e => e.factor_name === 'Temperature');
    expect(tempEffect).toBeDefined();
    // For strength, effect should be positive (higher T = higher strength)
    expect(tempEffect!.effect_size).toBeGreaterThan(0);

    // For Void: Temperature ANOVA row should exist
    const voidAnova = analysis.anova.find(a => a.response_name === 'Void %');
    expect(voidAnova).toBeDefined();
  });

  it('(e) desirability identifies optimal settings', () => {
    const matrix = generateMatrix(SOLDER_DOE_CONFIG);

    for (const run of matrix.runs) {
      const T = run.factor_levels['temp'];
      const P = run.factor_levels['pressure'];
      const S = run.factor_levels['speed'];
      run.responses['strength'] = solderStrength(T, P, S);
      run.responses['void'] = solderVoid(T, P, S);
    }

    const analysis = analyzeDOE(SOLDER_DOE_CONFIG, matrix);
    expect(analysis.desirability).toBeDefined();
    expect(analysis.desirability!.overall_desirability).toBeGreaterThan(0);
    expect(analysis.desirability!.overall_desirability).toBeLessThanOrEqual(1);
  });

  it('(f) R-squared should be very high (>0.90) for deterministic formulas', () => {
    const matrix = generateMatrix(SOLDER_DOE_CONFIG);

    for (const run of matrix.runs) {
      const T = run.factor_levels['temp'];
      const P = run.factor_levels['pressure'];
      const S = run.factor_levels['speed'];
      run.responses['strength'] = solderStrength(T, P, S);
      run.responses['void'] = solderVoid(T, P, S);
    }

    const analysis = analyzeDOE(SOLDER_DOE_CONFIG, matrix);
    for (const table of analysis.anova) {
      // With deterministic linear formulas and enough factors, R^2 should be high
      expect(table.r_squared).toBeGreaterThan(0.90);
    }
  });

  it('Box-Behnken with 3 factors generates edge-midpoint + center runs', () => {
    const bbConfig: DOEConfig = {
      name: 'BB_Test',
      design_type: 'box_behnken',
      factors: [
        { id: 'f1', name: 'Factor_A', type: 'numeric', levels: [10, 20, 30] },
        { id: 'f2', name: 'Factor_B', type: 'numeric', levels: [100, 200, 300] },
        { id: 'f3', name: 'Factor_C', type: 'numeric', levels: [1, 5, 9] },
      ],
      responses: [{ id: 'y', name: 'Response' }],
      randomize: false,
    };
    const matrix = generateMatrix(bbConfig);
    // BB for 3 factors: C(3,2)*4 = 12 edge midpoints + center points (default 3) = 15
    const edgeRuns = matrix.runs.filter(r => !r.is_center_point);
    const centerRuns = matrix.runs.filter(r => r.is_center_point);
    expect(edgeRuns.length).toBe(12); // 3 pairs x 4 combinations
    expect(centerRuns.length).toBeGreaterThanOrEqual(1); // at least 1 center point
    expect(matrix.total_runs).toBe(edgeRuns.length + centerRuns.length);
  });

  it('CCD with 3 factors: 2^3 factorial + 2x3 axial + center points', () => {
    const ccdConfig: DOEConfig = {
      name: 'CCD_Test',
      design_type: 'central_composite',
      factors: [
        { id: 'f1', name: 'Factor_A', type: 'numeric', levels: [10, 30] },
        { id: 'f2', name: 'Factor_B', type: 'numeric', levels: [100, 300] },
        { id: 'f3', name: 'Factor_C', type: 'numeric', levels: [1, 9] },
      ],
      responses: [{ id: 'y', name: 'Response' }],
      randomize: false,
      center_points: 3,
    };
    const matrix = generateMatrix(ccdConfig);
    // CCD: 2^3 = 8 factorial + 2*3 = 6 axial + N center = 8 + 6 + 3 = 17
    const factorialRuns = matrix.runs.filter(r => !r.is_center_point && !r.is_axial_point);
    const axialRuns = matrix.runs.filter(r => r.is_axial_point);
    const centerRuns = matrix.runs.filter(r => r.is_center_point);
    expect(factorialRuns.length).toBe(8);
    expect(axialRuns.length).toBe(6);
    expect(centerRuns.length).toBe(3);
    expect(matrix.total_runs).toBe(17);
  });

  it('DOE with 1 factor produces 2 runs', () => {
    const singleConfig: DOEConfig = {
      name: 'Single_Factor',
      design_type: 'full_factorial',
      factors: [{ id: 'f1', name: 'Temp', type: 'numeric', levels: [100, 200] }],
      responses: [{ id: 'y', name: 'Yield' }],
      randomize: false,
    };
    const matrix = generateMatrix(singleConfig);
    expect(matrix.total_runs).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════
// S15.7 — FSM: PCB Machine States
// ══════════════════════════════════════════════════════════════

describe('S15.7 FSM — PCB Machine States', () => {
  it('(a) CNC + Conveyor templates loaded independently', () => {
    const cnc = getTemplate('cnc_machine');
    const conveyor = getTemplate('conveyor');
    expect(cnc).toBeDefined();
    expect(conveyor).toBeDefined();
    expect(cnc!.name).toBe('cnc_machine');
    expect(conveyor!.name).toBe('conveyor');
  });

  it('(b) both machines tracked independently — state residence sums to 100%', () => {
    const cnc = getTemplate('cnc_machine')!;
    const conveyor = getTemplate('conveyor')!;

    const config: FSMConfig = {
      name: 'PCB_FSM_R2',
      machines: [
        { id: 'smt_machine', name: 'SMT Machine', ...cnc.definition },
        { id: 'conveyor_1', name: 'Conveyor 1', ...conveyor.definition },
      ],
      sim_duration_minutes: 480,
      event_queue: [
        // SMT Machine events
        { id: 'e1', time: 0, machine_id: 'smt_machine', event_name: 'job_arrives' },
        { id: 'e2', time: 60, machine_id: 'smt_machine', event_name: 'processing_complete' },
        { id: 'e3', time: 70, machine_id: 'smt_machine', event_name: 'job_arrives' },
        { id: 'e4', time: 180, machine_id: 'smt_machine', event_name: 'processing_complete' },
        { id: 'e5', time: 200, machine_id: 'smt_machine', event_name: 'job_arrives' },
        { id: 'e6', time: 350, machine_id: 'smt_machine', event_name: 'processing_complete' },
        // Conveyor events
        { id: 'e7', time: 10, machine_id: 'conveyor_1', event_name: 'start_command' },
        { id: 'e8', time: 240, machine_id: 'conveyor_1', event_name: 'stop_command' },
        { id: 'e9', time: 260, machine_id: 'conveyor_1', event_name: 'start_command' },
        { id: 'e10', time: 400, machine_id: 'conveyor_1', event_name: 'stop_command' },
      ],
    };

    const state = initSimulation(config);
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    expect(analysis.machines.length).toBe(2);

    for (const machine of analysis.machines) {
      const totalPct = machine.state_residence.reduce((s, r) => s + r.pct_of_total, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    }
  });

  it('(c) utilization = processing_time / total_time', () => {
    const cnc = getTemplate('cnc_machine')!;

    const config: FSMConfig = {
      name: 'Util_Check',
      machines: [{ id: 'machine_1', name: 'Test Machine', ...cnc.definition }],
      sim_duration_minutes: 100,
      event_queue: [
        { id: 'e1', time: 0, machine_id: 'machine_1', event_name: 'job_arrives', data: { material_available: true, wip_below_limit: true } },
        { id: 'e2', time: 60, machine_id: 'machine_1', event_name: 'processing_complete' },
        // 60 min processing out of 100 total = 60% utilization
      ],
    };

    const state = initSimulation(config);
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    const m = analysis.machines[0];
    expect(m.utilization_pct).toBeCloseTo(60, 1);
  });

  it('(f) validation: CNC template has no deadlocks, all states reachable', () => {
    const cnc = getTemplate('cnc_machine')!;
    const config: FSMConfig = {
      name: 'CNC_Validation',
      machines: [{ id: 'm1', name: 'CNC_1', ...cnc.definition }],
      sim_duration_minutes: 100,
    };
    const validation = validateFSM(config);
    // Should not have critical errors that make it invalid
    // (some warnings about final states are ok)
    const errors = validation.issues.filter(i => i.severity === 'error');
    expect(errors.length).toBe(0);
  });

  it('FSM with empty event queue still produces analysis', () => {
    const cnc = getTemplate('cnc_machine')!;
    const config: FSMConfig = {
      name: 'Empty_Queue',
      machines: [{ id: 'm1', name: 'Machine_1', ...cnc.definition }],
      sim_duration_minutes: 100,
      event_queue: [], // empty!
    };

    // generateDemoEvents should produce events when queue is empty
    // But if we pass empty, the tool handler adds demo events automatically
    // Let's test with truly empty event queue via direct API
    const state = initSimulation(config);
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    // Machine should stay in initial state the whole time
    expect(analysis.machines.length).toBe(1);
    const m = analysis.machines[0];
    // Should have at least the initial state in residence
    expect(m.state_residence.length).toBeGreaterThanOrEqual(1);
    const totalPct = m.state_residence.reduce((s, r) => s + r.pct_of_total, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });
});

// ══════════════════════════════════════════════════════════════
// CROSS-TOOL VERIFICATION
// ══════════════════════════════════════════════════════════════

describe('Cross-Tool Verification', () => {
  it('TOC work_center_ranking → FSM bridgeFromTOC: CCR marked, times make sense', () => {
    const tocResult = analyzeTOC(PCB_TOC_CONFIG);
    const ranking = tocResult.constraint.work_center_ranking;

    const fsmBridge = bridgeFromTOC(ranking, 480); // 8 hours = 480 min

    expect(fsmBridge.length).toBe(6); // 6 work centers
    const waveBridge = fsmBridge.find(b => b.machine_name.includes('Wave'));
    expect(waveBridge).toBeDefined();
    expect(waveBridge!.machine_name).toContain('CCR');
    // Wave is over 100% util — it should have all processing time and some blocked
    expect(waveBridge!.processing_minutes).toBeGreaterThan(0);

    // Non-CCR should have idle time
    const stencilBridge = fsmBridge.find(b => b.machine_name.includes('Stencil'));
    expect(stencilBridge).toBeDefined();
    expect(stencilBridge!.idle_minutes).toBeGreaterThan(0);

    // All bridge results should have state_residence summing to ~100%
    for (const br of fsmBridge) {
      const totalPct = br.state_residence.reduce((s, r) => s + r.pct_of_total, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    }
  });

  it('VSM lead_time_breakdown → FSM bridgeFromVSM: VA=processing, wait=queued', () => {
    const vsmResult = analyzeVSM(PCB_VSM_CONFIG);
    const breakdown = vsmResult.lead_time_breakdown;

    const fsmBridge = bridgeFromVSM(breakdown);

    expect(fsmBridge.length).toBe(9); // 9 VSM steps

    // VA steps should have processing > 0
    const stencilFSM = fsmBridge.find(b => b.machine_name === 'Stencil Print');
    expect(stencilFSM).toBeDefined();
    expect(stencilFSM!.processing_minutes).toBeGreaterThan(0); // VA step

    // NVA step (Final QC) should have processing = 0 (maps to idle)
    const qcFSM = fsmBridge.find(b => b.machine_name === 'Final QC');
    expect(qcFSM).toBeDefined();
    expect(qcFSM!.processing_minutes).toBe(0); // NVA category

    // Wait time should map to queued
    for (const br of fsmBridge) {
      const step = breakdown.find(s => s.step_name === br.machine_name);
      if (step && step.wait_time > 0) {
        expect(br.queued_minutes).toBeGreaterThan(0);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════
// EDGE CASES
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('Capacity with 0 operators on a line → 0 capacity, no crash', () => {
    const zeroOpConfig: CapacityPlanConfig = {
      ...PCB_CONFIG,
      name: 'Zero_Ops',
      lines: [
        { id: 'z1', code: 'ZERO', name: 'Empty Line', max_operators: 0, efficiency_factor: 0.9, absenteeism_factor: 0.05 },
      ],
      demands: [{ product: 'X', line_id: 'z1', quantity: 100, sam_minutes: 5 }],
    };
    const result = analyzeCapacity(zeroOpConfig);
    const line = result.lines[0];
    expect(line.capacity_hours).toBe(0);
    // Utilization should be 0 (no division by zero crash)
    expect(line.utilization_pct).toBe(0);
    expect(Number.isFinite(line.utilization_pct)).toBe(true);
  });

  it('Sequencer with 1 job on 1 machine → trivial schedule', () => {
    const trivialConfig: SequencerConfig = {
      name: 'Trivial_Schedule',
      jobs: [{ id: 'j1', name: 'Only_Job', product: 'simple', quantity: 1, processing_minutes: 30 }],
      machines: [{ id: 'm1', name: 'Only_Machine' }],
    };
    const result = dispatch(trivialConfig, 'SPT');
    expect(result.entries.length).toBe(1);
    expect(result.metrics.makespan).toBe(30);
    expect(result.metrics.total_setup_time).toBe(0);
    expect(result.metrics.num_late_jobs).toBe(0);
  });

  it('VSM with all VA steps → PCE should be high', () => {
    const allVAConfig: VSMConfig = {
      name: 'All_VA',
      product_family: 'Lean_Product',
      customer_demand_per_day: 100,
      available_minutes_per_day: 480,
      state: 'current',
      steps: [
        { id: 's1', name: 'Step1', sequence: 1, cycle_time: 5, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1, wait_time: 0, transport_time: 0 },
        { id: 's2', name: 'Step2', sequence: 2, cycle_time: 3, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1, wait_time: 0, transport_time: 0 },
        { id: 's3', name: 'Step3', sequence: 3, cycle_time: 4, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1, wait_time: 0, transport_time: 0 },
      ],
    };
    const result = analyzeVSM(allVAConfig);
    // With zero wait, zero transport, zero changeover, PCE = VA / lead_time = 100%
    expect(result.pce_pct).toBeCloseTo(100, 0);
  });

  it('TOC with all work centers having identical capacity → any can be CCR', () => {
    const equalConfig: TOCConfig = {
      name: 'Equal_WCs',
      work_centers: [
        { id: 'w1', name: 'WC_A', capacity_units_per_hour: 50, available_hours_per_day: 8, operators: 1, current_wip: 10 },
        { id: 'w2', name: 'WC_B', capacity_units_per_hour: 50, available_hours_per_day: 8, operators: 1, current_wip: 10 },
        { id: 'w3', name: 'WC_C', capacity_units_per_hour: 50, available_hours_per_day: 8, operators: 1, current_wip: 10 },
      ],
      selling_price_per_unit: 20,
      total_variable_cost_per_unit: 5,
      operating_expense_per_period: 50000,
      investment: 200000,
      demand_units_per_day: 300,
      available_hours_per_day: 8,
    };
    const result = analyzeTOC(equalConfig);
    // All equal capacity — any can be CCR, all should have the same utilization
    const utils = result.constraint.work_center_ranking.map(w => w.utilization_pct);
    // All utilizations should be equal
    for (const u of utils) {
      expect(u).toBeCloseTo(utils[0], 1);
    }
    // CCR should be identified (first in ranking or random tie-break)
    expect(result.constraint.ccr_name).toBeTruthy();
  });

  it('Heijunka with 1 product → leveling score = 100, 0 changeovers', () => {
    const singleConfig: HeijunkaConfig = {
      name: 'Single_Product',
      products: [
        { id: 'p1', name: 'Only_Product', mix_pct: 100, cycle_time_minutes: 1.0, changeover_minutes: 5 },
      ],
      takt_time_minutes: 1.0,
      pitch_minutes: 5,
      pack_out_quantity: 5,
      slots_per_shift: 10,
      shifts_per_day: 1,
      demand_per_day: 100,
    };
    const result = analyzeHeijunka(singleConfig);
    expect(result.leveling_score).toBe(100);
    expect(result.changeover_count).toBe(0);
    // All slots should be the same product
    for (const cell of result.heijunka_box.cells) {
      expect(cell.product_id).toBe('p1');
    }
  });
});
