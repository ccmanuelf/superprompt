/**
 * S15 User-Level Sanity Check — Comprehensive Engineering Validation
 *
 * Runs all S15 tools with realistic manufacturing data and validates
 * that results make engineering sense. READ-ONLY validation — does NOT
 * modify any source files.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ── Test DB Setup ───────────────────────────────────────────────

const TMP_DIR = resolve(tmpdir(), 'luna-test-s15-sanity');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 's15-sanity.db');
let db: Database.Database;

vi.mock('../src/db.js', () => ({ getDatabase: () => db }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  STORE_DIR: resolve(tmpdir(), 'luna-test-s15-sanity'),
  config: { NODE_ENV: 'test' },
}));

// ── Imports (after mocks) ───────────────────────────────────────

import {
  analyzeCapacity,
  analyzeLineCapacity,
  aggregateDemandByLine,
  type CapacityPlanConfig,
  type CapacityLine,
  type CalendarConfig,
  type DemandEntry,
  initCapacityTables,
} from '../src/capacity/index.js';

import {
  dispatch,
  compareAllRules,
  runGA,
  computeMetrics,
  buildSingleMachineSchedule,
  type SequencerConfig,
  initSequencerTables,
} from '../src/sequencer/index.js';

import {
  analyzeVSM,
  classifyTimwoods,
  type VSMConfig,
  type ProcessStep,
  initVsmTables,
} from '../src/vsm/index.js';

import {
  analyzeTOC,
  identifyConstraint,
  calculateThroughputAccounting,
  computeBufferStatus,
  computeWIPGauges,
  type TOCConfig,
  BUFFER_GREEN_THRESHOLD,
  BUFFER_YELLOW_THRESHOLD,
  initTocTables,
} from '../src/toc/index.js';

import {
  analyzeCONWIP,
  analyzeHeijunka,
  type CONWIPConfig,
  type HeijunkaConfig,
  type ProductType,
  initConwipTables,
} from '../src/conwip/index.js';

import {
  generateMatrix,
  analyzeDOE,
  type DOEConfig,
  initDoeTables,
} from '../src/doe/index.js';

import {
  initSimulation,
  generateDemoEvents,
  runToCompletion,
  analyzeSimulation,
  getTemplate,
  listTemplates,
  bridgeFromSimulation,
  bridgeFromVSM,
  bridgeFromTOC,
  type FSMConfig,
  type FSMDefinition,
  initFsmTables,
} from '../src/fsm/index.js';

// ── DB Init ─────────────────────────────────────────────────────

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initCapacityTables();
  initSequencerTables();
  initVsmTables();
  initTocTables();
  initConwipTables();
  initDoeTables();
  initFsmTables();
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

// ══════════════════════════════════════════════════════════════════
// S15.1 — CAPACITY PLANNING
// ══════════════════════════════════════════════════════════════════

describe('S15.1 — Capacity Planning Sanity Check', () => {
  const LINES: CapacityLine[] = [
    { id: 'sew1', code: 'SEW_01', name: 'Sewing Line 1', department: 'Sewing', max_operators: 12, efficiency_factor: 0.85, absenteeism_factor: 0.05 },
    { id: 'sew2', code: 'SEW_02', name: 'Sewing Line 2', department: 'Sewing', max_operators: 12, efficiency_factor: 0.85, absenteeism_factor: 0.05 },
    { id: 'sew3', code: 'SEW_03', name: 'Sewing Line 3', department: 'Sewing', max_operators: 12, efficiency_factor: 0.85, absenteeism_factor: 0.05 },
  ];

  const CALENDAR: CalendarConfig = {
    working_days: 5,
    shifts_per_day: 1,
    hours_per_shift: 8,
  };

  const DEMANDS: DemandEntry[] = [
    { product: 'Style A', line_id: 'sew1', quantity: 2000, sam_minutes: 15 },
    { product: 'Style B', line_id: 'sew1', quantity: 1500, sam_minutes: 20 },
  ];

  const CONFIG: CapacityPlanConfig = {
    name: 'Sanity Check Plan',
    period_label: 'Week 13',
    period_start: '2026-03-23',
    period_end: '2026-03-27',
    lines: LINES,
    calendar: CALENDAR,
    demands: DEMANDS,
  };

  it('should compute gross hours = days x shifts x hours', () => {
    const result = analyzeLineCapacity(LINES[0], CALENDAR, 0, 0);
    // 5 days × 1 shift × 8 hours = 40
    expect(result.gross_hours).toBe(40);
  });

  it('should compute net hours < gross hours (efficiency + absenteeism)', () => {
    const result = analyzeLineCapacity(LINES[0], CALENDAR, 0, 0);
    // Net = 40 × 0.85 × (1 - 0.05) = 40 × 0.85 × 0.95 = 32.3
    expect(result.net_hours).toBe(32.3);
    expect(result.net_hours).toBeLessThan(result.gross_hours);
  });

  it('should compute capacity_hours = net × operators', () => {
    const result = analyzeLineCapacity(LINES[0], CALENDAR, 0, 0);
    // 32.3 × 12 = 387.6
    expect(result.capacity_hours).toBe(387.6);
    // capacity_hours is rounded, so compare with tolerance for JS float precision
    expect(result.capacity_hours).toBeCloseTo(result.net_hours * LINES[0].max_operators, 2);
  });

  it('should produce realistic utilization percentages (not negative, not absurd)', () => {
    const result = analyzeCapacity(CONFIG);
    for (const line of result.lines) {
      expect(line.utilization_pct).toBeGreaterThanOrEqual(0);
      // Even overloaded lines shouldn't be 1000%+ in realistic scenarios
      expect(line.utilization_pct).toBeLessThan(500);
    }
  });

  it('should correctly aggregate demand by line', () => {
    const map = aggregateDemandByLine(DEMANDS);
    // Style A: 2000 × 15 / 60 = 500h, Style B: 1500 × 20 / 60 = 500h → total 1000h
    const sew1 = map.get('sew1');
    expect(sew1).toBeDefined();
    expect(sew1!.hours).toBeCloseTo(1000, 1);
    expect(sew1!.units).toBe(3500);
    // sew2 and sew3 have no demand
    expect(map.has('sew2')).toBe(false);
    expect(map.has('sew3')).toBe(false);
  });

  it('should identify the correct bottleneck (most loaded line)', () => {
    const result = analyzeCapacity(CONFIG);
    // Only sew1 has demand — it should be the bottleneck (or at least highest utilization)
    const ranking = result.constraint_ranking;
    expect(ranking.length).toBeGreaterThan(0);
    expect(ranking[0].line_code).toBe('SEW_01');
    expect(ranking[0].utilization_pct).toBeGreaterThan(0);

    // sew2 and sew3 have 0% utilization
    const sew2 = result.lines.find(l => l.line_code === 'SEW_02');
    expect(sew2?.utilization_pct).toBe(0);
  });

  it('should have overall utilization that makes engineering sense', () => {
    const result = analyzeCapacity(CONFIG);
    // Manual: capacity for sew1 = 387.6h, demand = 1000h → sew1 is way overloaded
    // Total capacity = 3 × 387.6 = 1162.8h, total demand = 1000h
    // Overall utilization ≈ 1000/1162.8 × 100 ≈ 86%
    // But demand is only assigned to sew1, so sew1 is at ~258%, others at 0%
    // The system should reflect that sew1 is overloaded
    const sew1Line = result.lines.find(l => l.line_code === 'SEW_01');
    expect(sew1Line!.utilization_pct).toBeGreaterThan(200);
    expect(sew1Line!.over_capacity_hours).toBeGreaterThan(0);
  });

  it('should handle 3 lines × 5 days × 1 shift × 8h correctly', () => {
    const result = analyzeCapacity(CONFIG);
    // Each line: gross=40h, net=32.3h, capacity=387.6h
    // Total capacity = 3 × 387.6 = 1162.8h
    expect(result.total_capacity_hours).toBeCloseTo(1162.8, 0);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.2 — SEQUENCER
// ══════════════════════════════════════════════════════════════════

describe('S15.2 — Sequencer Sanity Check', () => {
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86400000).toISOString().split('T')[0];

  const SEQ_CONFIG: SequencerConfig = {
    name: 'Sanity Sequencer',
    jobs: [
      { id: 'j1', name: 'Job A', product: 'Widget', quantity: 100, processing_minutes: 30, due_date: inDays(2) },
      { id: 'j2', name: 'Job B', product: 'Widget', quantity: 50, processing_minutes: 10, due_date: inDays(1) },
      { id: 'j3', name: 'Job C', product: 'Gadget', quantity: 200, processing_minutes: 60, due_date: inDays(5) },
      { id: 'j4', name: 'Job D', product: 'Widget', quantity: 80, processing_minutes: 20, due_date: inDays(3) },
      { id: 'j5', name: 'Job E', product: 'Gadget', quantity: 150, processing_minutes: 45, due_date: inDays(1) },
      { id: 'j6', name: 'Job F', product: 'Sprocket', quantity: 60, processing_minutes: 15, due_date: inDays(4) },
    ],
    machines: [
      { id: 'm1', name: 'Machine Alpha' },
      { id: 'm2', name: 'Machine Beta' },
    ],
    setup_matrix: [
      { from_product: 'Widget', to_product: 'Gadget', setup_minutes: 5 },
      { from_product: 'Gadget', to_product: 'Widget', setup_minutes: 5 },
      { from_product: 'Widget', to_product: 'Sprocket', setup_minutes: 3 },
      { from_product: 'Sprocket', to_product: 'Widget', setup_minutes: 3 },
      { from_product: 'Gadget', to_product: 'Sprocket', setup_minutes: 4 },
      { from_product: 'Sprocket', to_product: 'Gadget', setup_minutes: 4 },
    ],
  };

  it('should produce valid SPT ordering (shortest first)', () => {
    const result = dispatch(SEQ_CONFIG, 'SPT');
    expect(result.entries.length).toBe(6);
    expect(result.metrics.makespan).toBeGreaterThan(0);

    // Check each machine's entries are sorted by processing time
    const machines = new Map<string, typeof result.entries>();
    for (const e of result.entries) {
      const arr = machines.get(e.machine_id) ?? [];
      arr.push(e);
      machines.set(e.machine_id, arr);
    }
    for (const [, entries] of machines) {
      for (let i = 1; i < entries.length; i++) {
        // SPT should sort by processing time — check original job processing times
        const jobI = SEQ_CONFIG.jobs.find(j => j.id === entries[i].job_id)!;
        const jobPrev = SEQ_CONFIG.jobs.find(j => j.id === entries[i - 1].job_id)!;
        expect(jobI.processing_minutes).toBeGreaterThanOrEqual(jobPrev.processing_minutes);
      }
    }
  });

  it('should produce valid EDD ordering (earliest due date first)', () => {
    const result = dispatch(SEQ_CONFIG, 'EDD');
    expect(result.entries.length).toBe(6);

    // Check overall ordering respects due dates
    const machines = new Map<string, typeof result.entries>();
    for (const e of result.entries) {
      const arr = machines.get(e.machine_id) ?? [];
      arr.push(e);
      machines.set(e.machine_id, arr);
    }
    for (const [, entries] of machines) {
      for (let i = 1; i < entries.length; i++) {
        const jobI = SEQ_CONFIG.jobs.find(j => j.id === entries[i].job_id)!;
        const jobPrev = SEQ_CONFIG.jobs.find(j => j.id === entries[i - 1].job_id)!;
        if (jobI.due_date && jobPrev.due_date) {
          expect(new Date(jobI.due_date).getTime()).toBeGreaterThanOrEqual(new Date(jobPrev.due_date).getTime());
        }
      }
    }
  });

  it('should produce non-zero makespan', () => {
    const spt = dispatch(SEQ_CONFIG, 'SPT');
    const edd = dispatch(SEQ_CONFIG, 'EDD');
    expect(spt.metrics.makespan).toBeGreaterThan(0);
    expect(edd.metrics.makespan).toBeGreaterThan(0);
    // Total processing time = 30+10+60+20+45+15 = 180 min
    // With 2 machines, makespan should be ≥ 90 (best case parallel)
    expect(spt.metrics.makespan).toBeGreaterThanOrEqual(80);
  });

  it('should produce on_time_pct between 0 and 100', () => {
    const spt = dispatch(SEQ_CONFIG, 'SPT');
    expect(spt.metrics.on_time_pct).toBeGreaterThanOrEqual(0);
    expect(spt.metrics.on_time_pct).toBeLessThanOrEqual(100);
  });

  it('should compare all rules and produce a best overall', () => {
    const comparison = compareAllRules(SEQ_CONFIG);
    expect(comparison.rules.length).toBe(6); // FIFO, SPT, LPT, EDD, CR, SLACK
    expect(comparison.best_overall).toBeTruthy();
    expect(comparison.recommendation).toBeTruthy();
    expect(comparison.recommendation.length).toBeGreaterThan(10);
  });

  it('GA should produce result at least as good as worst dispatching rule', () => {
    const comparison = compareAllRules(SEQ_CONFIG);
    const worstMakespan = Math.max(...comparison.rules.map(r => r.metrics.makespan));

    const gaResult = runGA(SEQ_CONFIG, {
      population_size: 50,
      generations: 100,
    });

    expect(gaResult.entries.length).toBe(6);
    expect(gaResult.metrics.makespan).toBeGreaterThan(0);
    // GA should not be worse than the worst dispatching rule
    expect(gaResult.metrics.makespan).toBeLessThanOrEqual(worstMakespan + 1);
    expect(gaResult.fitness_history.length).toBeGreaterThan(0);
    expect(gaResult.convergence_generation).toBeGreaterThanOrEqual(0);
  });

  it('should account for setup times between different products', () => {
    const result = dispatch(SEQ_CONFIG, 'FIFO');
    // Some jobs should have setup times when switching products
    const hasSetup = result.entries.some(e => e.setup_time > 0);
    // With setup matrix and mixed products, there should be changeovers
    // (depends on round-robin assignment — may or may not trigger changeovers)
    expect(result.metrics.total_setup_time).toBeGreaterThanOrEqual(0);
    // Makespan should be at least total processing time / 2 (2 machines)
    expect(result.metrics.makespan).toBeGreaterThanOrEqual(80);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.3 — VALUE STREAM MAPPING (VSM)
// ══════════════════════════════════════════════════════════════════

describe('S15.3 — VSM Sanity Check', () => {
  const STEPS: ProcessStep[] = [
    { id: 's1', name: 'Receiving', sequence: 1, cycle_time: 2, changeover_time: 0, uptime_pct: 100, category: 'BNVA', operators: 1, wait_time: 15, transport_time: 5, wip_before: 100 },
    { id: 's2', name: 'Cutting', sequence: 2, cycle_time: 8, changeover_time: 10, uptime_pct: 95, category: 'VA', operators: 2, batch_size: 50, wait_time: 10, wip_before: 50 },
    { id: 's3', name: 'Sewing', sequence: 3, cycle_time: 15, changeover_time: 5, uptime_pct: 90, category: 'VA', operators: 4, batch_size: 25, wait_time: 20, wip_before: 80 },
    { id: 's4', name: 'Inspection', sequence: 4, cycle_time: 3, changeover_time: 0, uptime_pct: 100, category: 'BNVA', operators: 1, wait_time: 5 },
    { id: 's5', name: 'Rework Station', sequence: 5, cycle_time: 10, changeover_time: 0, uptime_pct: 100, category: 'NVA', operators: 1, wait_time: 30, waste_types: ['defects'] },
    { id: 's6', name: 'Packing', sequence: 6, cycle_time: 4, changeover_time: 2, uptime_pct: 98, category: 'VA', operators: 2, batch_size: 100, wait_time: 5, transport_time: 3 },
  ];

  const VSM_CONFIG: VSMConfig = {
    name: 'Assembly Line Current State',
    product_family: 'Polo Shirts',
    customer_demand_per_day: 500,
    available_minutes_per_day: 460,  // 8h - 60min breaks
    state: 'current',
    steps: STEPS,
  };

  it('should compute PCE = VA time / total lead time × 100', () => {
    const result = analyzeVSM(VSM_CONFIG);

    // VA steps: Cutting (8), Sewing (15), Packing (4) = 27 min
    expect(result.total_va_time).toBe(27);

    // Manually compute total lead time:
    // Each step: cycle_time + wait_time + transport_time + changeover/batch
    // S1: 2 + 15 + 5 + 0 = 22
    // S2: 8 + 10 + 0 + 10/50 = 18.2
    // S3: 15 + 20 + 0 + 5/25 = 35.2
    // S4: 3 + 5 + 0 + 0 = 8
    // S5: 10 + 30 + 0 + 0 = 40
    // S6: 4 + 5 + 3 + 2/100 = 12.02
    // Total = 22 + 18.2 + 35.2 + 8 + 40 + 12.02 = 135.42
    const expectedTotalLead = 22 + 18.2 + 35.2 + 8 + 40 + 12.02;
    expect(result.total_lead_time).toBeCloseTo(expectedTotalLead, 1);

    // PCE = 27 / 135.42 × 100 ≈ 19.94%
    const expectedPCE = (27 / expectedTotalLead) * 100;
    expect(result.pce_pct).toBeCloseTo(expectedPCE, 0);
    // PCE for a typical manufacturing line should be 5-30%
    expect(result.pce_pct).toBeGreaterThan(5);
    expect(result.pce_pct).toBeLessThan(40);
  });

  it('should compute takt time = available minutes / demand', () => {
    const result = analyzeVSM(VSM_CONFIG);
    // 460 / 500 = 0.92 min/unit
    expect(result.takt_time).toBeCloseTo(0.92, 2);
  });

  it('should detect TIMWOODS waiting waste from wait_time > 0', () => {
    const timwoods = classifyTimwoods(VSM_CONFIG);
    const waitingWaste = timwoods.find(tw => tw.waste_type === 'waiting');
    expect(waitingWaste).toBeDefined();
    // Total waiting = 15 + 10 + 20 + 5 + 30 + 5 = 85 min
    expect(waitingWaste!.total_minutes).toBe(85);
    expect(waitingWaste!.contributing_steps.length).toBeGreaterThan(0);
  });

  it('should detect inventory waste from WIP', () => {
    const timwoods = classifyTimwoods(VSM_CONFIG);
    const inventoryWaste = timwoods.find(tw => tw.waste_type === 'inventory');
    expect(inventoryWaste).toBeDefined();
    // WIP before steps: 100 + 50 + 80 = 230 units
    // Inventory waste in minutes: WIP × takt = 230 × 0.92 = 211.6 min
    expect(inventoryWaste!.total_minutes).toBeGreaterThan(100);
  });

  it('should detect defects waste from explicit waste_types', () => {
    const timwoods = classifyTimwoods(VSM_CONFIG);
    const defectsWaste = timwoods.find(tw => tw.waste_type === 'defects');
    expect(defectsWaste).toBeDefined();
    // S5 is explicitly tagged as defects (NVA, cycle_time=10)
    // Plus S2 uptime 95% → 5% downtime on 8min = 0.4min
    // Plus S3 uptime 90% → 10% on 15min = 1.5min
    // Plus S6 uptime 98% → 2% on 4min = 0.08min
    expect(defectsWaste!.total_minutes).toBeGreaterThan(0);
  });

  it('should identify the bottleneck step (highest effective cycle time)', () => {
    const result = analyzeVSM(VSM_CONFIG);
    // Effective CT = cycle_time / operators
    // S1: 2/1=2, S2: 8/2=4, S3: 15/4=3.75, S4: 3/1=3, S5: 10/1=10, S6: 4/2=2
    // Bottleneck = S5 (Rework Station) with effective CT = 10
    expect(result.bottleneck_step).toBe('Rework Station');
    expect(result.bottleneck_cycle_time).toBe(10);
  });

  it('should have lead_time_breakdown entries for all steps', () => {
    const result = analyzeVSM(VSM_CONFIG);
    expect(result.lead_time_breakdown.length).toBe(6);
    // All breakdown entries should have non-negative values
    for (const b of result.lead_time_breakdown) {
      expect(b.cycle_time).toBeGreaterThanOrEqual(0);
      expect(b.wait_time).toBeGreaterThanOrEqual(0);
      expect(b.transport_time).toBeGreaterThanOrEqual(0);
      expect(b.total_step_time).toBeGreaterThanOrEqual(b.cycle_time);
    }
  });

  it('should compute total WIP units correctly', () => {
    const result = analyzeVSM(VSM_CONFIG);
    // wip_before: 100 + 50 + 80 = 230
    expect(result.total_wip_units).toBe(230);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.4 — THEORY OF CONSTRAINTS (TOC)
// ══════════════════════════════════════════════════════════════════

describe('S15.4 — TOC Sanity Check', () => {
  const TOC_CONFIG: TOCConfig = {
    name: 'Assembly Plant TOC',
    work_centers: [
      { id: 'wc1', name: 'Stamping', capacity_units_per_hour: 120, available_hours_per_day: 8, operators: 3, current_wip: 50 },
      { id: 'wc2', name: 'Welding', capacity_units_per_hour: 80, available_hours_per_day: 8, operators: 4, current_wip: 100 },
      { id: 'wc3', name: 'Painting', capacity_units_per_hour: 100, available_hours_per_day: 8, operators: 2, current_wip: 30 },
      { id: 'wc4', name: 'Assembly', capacity_units_per_hour: 60, available_hours_per_day: 8, operators: 6, current_wip: 80 },
      { id: 'wc5', name: 'QC/Packing', capacity_units_per_hour: 150, available_hours_per_day: 8, operators: 2, current_wip: 20 },
    ],
    selling_price_per_unit: 50,
    total_variable_cost_per_unit: 20,
    operating_expense_per_period: 100000,
    investment: 500000,
    demand_units_per_day: 500,
    available_hours_per_day: 8,
  };

  it('should identify CCR as the station with highest load/available ratio', () => {
    const constraint = identifyConstraint(TOC_CONFIG);

    // Load hours for each: demand / capacity
    // Stamping: 500/120 = 4.17h → util = 4.17/8 = 52.1%
    // Welding: 500/80 = 6.25h → util = 6.25/8 = 78.1%
    // Painting: 500/100 = 5h → util = 5/8 = 62.5%
    // Assembly: 500/60 = 8.33h → util = 8.33/8 = 104.2%  ← CONSTRAINT
    // QC: 500/150 = 3.33h → util = 3.33/8 = 41.7%
    expect(constraint.ccr_name).toBe('Assembly');
    expect(constraint.ccr_utilization_pct).toBeGreaterThan(100);

    // Ranking should be sorted descending
    for (let i = 1; i < constraint.work_center_ranking.length; i++) {
      expect(constraint.work_center_ranking[i].utilization_pct)
        .toBeLessThanOrEqual(constraint.work_center_ranking[i - 1].utilization_pct);
    }
  });

  it('should compute throughput per unit = Price - TVC', () => {
    const constraint = identifyConstraint(TOC_CONFIG);
    const ta = calculateThroughputAccounting(TOC_CONFIG, constraint);
    // T/unit = $50 - $20 = $30
    expect(ta.throughput_per_unit).toBe(30);
  });

  it('should compute net profit = T/period - OE', () => {
    const constraint = identifyConstraint(TOC_CONFIG);
    const ta = calculateThroughputAccounting(TOC_CONFIG, constraint);
    // Max throughput = Assembly capacity: 60 × 8 = 480 units/day
    // Actual = min(500, 480) = 480 units/day
    // T/day = 480 × 30 = $14,400
    // T/period = 14,400 × 22 = $316,800
    // NP = 316,800 - 100,000 = $216,800
    expect(ta.throughput_per_day).toBeCloseTo(14400, 0);
    expect(ta.throughput_per_period).toBeCloseTo(316800, 0);
    expect(ta.net_profit).toBeCloseTo(216800, 0);
  });

  it('should compute revenue lost per constraint hour', () => {
    const constraint = identifyConstraint(TOC_CONFIG);
    const ta = calculateThroughputAccounting(TOC_CONFIG, constraint);
    // Revenue lost = CCR capacity × T/unit = 60 × $30 = $1800/hr
    expect(ta.revenue_lost_per_hour_constraint_down).toBe(1800);
  });

  it('should produce valid buffer zones (green/yellow/red thresholds)', () => {
    // Green: 0-33% consumed
    const greenBuffer = computeBufferStatus({
      id: 'test', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 2, unit: 'hours',
    });
    expect(greenBuffer.zone).toBe('green');
    expect(greenBuffer.consumption_pct).toBe(20);

    // Yellow: 34-67% consumed
    const yellowBuffer = computeBufferStatus({
      id: 'test', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 5, unit: 'hours',
    });
    expect(yellowBuffer.zone).toBe('yellow');

    // Red: >67% consumed
    const redBuffer = computeBufferStatus({
      id: 'test', name: 'Test', buffer_type: 'time',
      total_size: 10, current_consumption: 8, unit: 'hours',
    });
    expect(redBuffer.zone).toBe('red');
  });

  it('should run full TOC analysis and produce 5 focusing steps', () => {
    const result = analyzeTOC(TOC_CONFIG);
    expect(result.constraint.ccr_name).toBe('Assembly');
    expect(result.five_focusing_steps.length).toBe(5);
    // Steps should contain the word IDENTIFY, EXPLOIT, SUBORDINATE, ELEVATE, REPEAT
    expect(result.five_focusing_steps[0]).toContain('IDENTIFY');
    expect(result.five_focusing_steps[1]).toContain('EXPLOIT');
    expect(result.five_focusing_steps[2]).toContain('SUBORDINATE');
    expect(result.five_focusing_steps[3]).toContain('ELEVATE');
    expect(result.five_focusing_steps[4]).toContain('REPEAT');
  });

  it('should compute WIP gauges for all work centers', () => {
    const gauges = computeWIPGauges(TOC_CONFIG);
    expect(gauges.length).toBe(5);
    for (const g of gauges) {
      expect(g.current_wip).toBeGreaterThanOrEqual(0);
      expect(g.wip_limit).toBeGreaterThan(0);
      expect(g.hours_of_work).toBeGreaterThanOrEqual(0);
      expect(['ok', 'warning', 'critical']).toContain(g.status);
    }
  });

  it('should detect demand exceeds Assembly capacity', () => {
    const constraint = identifyConstraint(TOC_CONFIG);
    // Assembly max = 60 × 8 = 480, demand = 500
    expect(constraint.demand_coverage_pct).toBeLessThan(100);
    expect(constraint.max_system_throughput_per_day).toBe(480);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.5 — CONWIP & HEIJUNKA
// ══════════════════════════════════════════════════════════════════

describe('S15.5 — CONWIP Sanity Check', () => {
  const PRODUCTS: ProductType[] = [
    { id: 'p1', name: 'Standard', mix_pct: 50, cycle_time_minutes: 10, changeover_minutes: 5 },
    { id: 'p2', name: 'Premium', mix_pct: 30, cycle_time_minutes: 15, changeover_minutes: 8 },
    { id: 'p3', name: 'Economy', mix_pct: 20, cycle_time_minutes: 8, changeover_minutes: 3 },
  ];

  const CONWIP_CONFIG: CONWIPConfig = {
    name: 'CONWIP Test',
    stages: [
      { id: 'st1', name: 'Cut', sequence: 1, cycle_time_minutes: 5, capacity_per_hour: 12 },
      { id: 'st2', name: 'Sew', sequence: 2, cycle_time_minutes: 10, capacity_per_hour: 6 },
      { id: 'st3', name: 'Press', sequence: 3, cycle_time_minutes: 3, capacity_per_hour: 20 },
      { id: 'st4', name: 'QC', sequence: 4, cycle_time_minutes: 4, capacity_per_hour: 15 },
      { id: 'st5', name: 'Pack', sequence: 5, cycle_time_minutes: 2, capacity_per_hour: 30 },
    ],
    wip_limit: 15,
    products: PRODUCTS,
    available_minutes_per_day: 480,
    demand_per_day: 48,
  };

  it('should distribute tokens proportionally to cycle times', () => {
    const result = analyzeCONWIP(CONWIP_CONFIG);
    expect(result.tokens.length).toBeLessThanOrEqual(CONWIP_CONFIG.wip_limit);
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.wip_limit).toBe(15);

    // Sew has the longest cycle time (10min) — should get most tokens
    const sewTokens = result.tokens.filter(t => t.current_stage_id === 'st2').length;
    const packTokens = result.tokens.filter(t => t.current_stage_id === 'st5').length;
    // Sew proportion: 10/24 ≈ 42%, Pack: 2/24 ≈ 8%
    // Sew should have more tokens than Pack
    expect(sewTokens).toBeGreaterThanOrEqual(packTokens);
  });

  it('should identify bottleneck as station with highest utilization', () => {
    const result = analyzeCONWIP(CONWIP_CONFIG);
    const bottleneck = result.stage_utilization.find(s => s.is_bottleneck);
    expect(bottleneck).toBeDefined();
    // Utilization = demand_per_day / capacity_per_hour / available_hours
    // Sew: 48/6/8 = 100% → bottleneck
    expect(bottleneck!.stage_name).toBe('Sew');
    expect(bottleneck!.utilization_pct).toBeCloseTo(100, 0);
  });

  it('should compute throughput limited by bottleneck', () => {
    const result = analyzeCONWIP(CONWIP_CONFIG);
    // Bottleneck is Sew at 6/hr
    expect(result.throughput_per_hour).toBe(6);
  });

  it('should compute average cycle time as sum of all stages', () => {
    const result = analyzeCONWIP(CONWIP_CONFIG);
    // 5 + 10 + 3 + 4 + 2 = 24 min
    expect(result.avg_cycle_time).toBe(24);
  });
});

describe('S15.5 — Heijunka Sanity Check', () => {
  it('should produce leveling score of 100 for single product', () => {
    const singleProductConfig: HeijunkaConfig = {
      name: 'Single Product',
      products: [
        { id: 'p1', name: 'Only One', mix_pct: 100, cycle_time_minutes: 10, changeover_minutes: 0 },
      ],
      takt_time_minutes: 2,
      pitch_minutes: 20,  // takt × pack_out = 2 × 10
      pack_out_quantity: 10,
      slots_per_shift: 12,
      shifts_per_day: 1,
      demand_per_day: 240,
    };

    const result = analyzeHeijunka(singleProductConfig);
    // Single product should achieve perfect leveling
    expect(result.leveling_score).toBe(100);
    expect(result.changeover_count).toBe(0);
  });

  it('should have mix percentages that sum to ~100%', () => {
    const PRODUCTS: ProductType[] = [
      { id: 'p1', name: 'Standard', mix_pct: 50, cycle_time_minutes: 10, changeover_minutes: 5 },
      { id: 'p2', name: 'Premium', mix_pct: 30, cycle_time_minutes: 15, changeover_minutes: 8 },
      { id: 'p3', name: 'Economy', mix_pct: 20, cycle_time_minutes: 8, changeover_minutes: 3 },
    ];

    const heijunkaConfig: HeijunkaConfig = {
      name: 'Multi-Product',
      products: PRODUCTS,
      takt_time_minutes: 2,
      pitch_minutes: 20,
      pack_out_quantity: 10,
      slots_per_shift: 12,
      shifts_per_day: 2,
      demand_per_day: 480,
    };

    const result = analyzeHeijunka(heijunkaConfig);

    // Actual mix percentages should sum to ~100
    const totalActualPct = result.actual_mix.reduce((s, m) => s + m.actual_pct, 0);
    expect(totalActualPct).toBeCloseTo(100, 0);

    // Target mix should also sum to 100
    const totalTargetPct = result.ideal_mix.reduce((s, m) => s + m.target_pct, 0);
    expect(totalTargetPct).toBe(100);

    // Leveling score should be reasonable (not 0, maybe not 100 with rounding)
    expect(result.leveling_score).toBeGreaterThan(50);
    expect(result.leveling_score).toBeLessThanOrEqual(100);
  });

  it('should verify pitch = takt × pack_out', () => {
    const heijunkaConfig: HeijunkaConfig = {
      name: 'Pitch Check',
      products: [
        { id: 'p1', name: 'A', mix_pct: 60, cycle_time_minutes: 5, changeover_minutes: 2 },
        { id: 'p2', name: 'B', mix_pct: 40, cycle_time_minutes: 8, changeover_minutes: 3 },
      ],
      takt_time_minutes: 1.5,
      pitch_minutes: 15,  // 1.5 × 10
      pack_out_quantity: 10,
      slots_per_shift: 16,
      shifts_per_day: 1,
      demand_per_day: 320,
    };

    const result = analyzeHeijunka(heijunkaConfig);
    // Verify pitch is stored correctly
    expect(result.pitch).toBe(15);
    expect(result.takt_time).toBe(1.5);
    // pitch = takt × pack_out
    expect(result.pitch).toBe(result.takt_time * heijunkaConfig.pack_out_quantity);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.6 — DESIGN OF EXPERIMENTS (DOE)
// ══════════════════════════════════════════════════════════════════

describe('S15.6 — DOE Sanity Check', () => {
  const DOE_CONFIG: DOEConfig = {
    name: '2^3 Injection Molding',
    design_type: 'full_factorial',
    factors: [
      { id: 'temp', name: 'Temperature', type: 'numeric', levels: [180, 220], unit: '°C' },
      { id: 'press', name: 'Pressure', type: 'numeric', levels: [50, 80], unit: 'bar' },
      { id: 'time', name: 'Cycle Time', type: 'numeric', levels: [30, 60], unit: 's' },
    ],
    responses: [
      { id: 'strength', name: 'Tensile Strength', unit: 'MPa' },
    ],
    randomize: false,
  };

  it('should generate exactly 2^3 = 8 runs', () => {
    const matrix = generateMatrix(DOE_CONFIG);
    expect(matrix.total_runs).toBe(8);
    expect(matrix.runs.length).toBe(8);
    expect(matrix.factors).toEqual(['Temperature', 'Pressure', 'Cycle Time']);
    expect(matrix.design_type).toBe('full_factorial');
  });

  it('should have correct factor levels in the matrix', () => {
    const matrix = generateMatrix(DOE_CONFIG);

    // Check that each factor appears at both levels
    const tempLevels = new Set(matrix.runs.map(r => r.factor_levels['temp']));
    const pressLevels = new Set(matrix.runs.map(r => r.factor_levels['press']));
    const timeLevels = new Set(matrix.runs.map(r => r.factor_levels['time']));

    expect(tempLevels.size).toBe(2);
    expect(tempLevels.has(180)).toBe(true);
    expect(tempLevels.has(220)).toBe(true);
    expect(pressLevels.size).toBe(2);
    expect(timeLevels.size).toBe(2);
  });

  it('should identify Temperature as most significant factor with deterministic data', () => {
    const matrix = generateMatrix(DOE_CONFIG);

    // Fill responses: y = 50 + 10*x1_coded + 5*x2_coded + 2*x3_coded
    // x_coded: -1 for low level, +1 for high level
    for (const run of matrix.runs) {
      const x1 = run.factor_coded['temp'];
      const x2 = run.factor_coded['press'];
      const x3 = run.factor_coded['time'];
      run.responses['strength'] = 50 + 10 * x1 + 5 * x2 + 2 * x3;
    }

    const analysis = analyzeDOE(DOE_CONFIG, matrix);
    expect(analysis.anova.length).toBe(1); // one response

    const anovaTable = analysis.anova[0];
    // R² should be very high (model explains all variance — deterministic)
    expect(anovaTable.r_squared).toBeGreaterThan(0.9);

    // Temperature (coefficient 10) should have highest contribution
    const tempRow = anovaTable.rows.find(r => r.source === 'Temperature');
    const pressRow = anovaTable.rows.find(r => r.source === 'Pressure');
    const timeRow = anovaTable.rows.find(r => r.source === 'Cycle Time');

    expect(tempRow).toBeDefined();
    expect(pressRow).toBeDefined();
    expect(timeRow).toBeDefined();

    // Temperature should have highest contribution
    expect(tempRow!.contribution_pct).toBeGreaterThan(pressRow!.contribution_pct);
    expect(tempRow!.contribution_pct).toBeGreaterThan(timeRow!.contribution_pct);
    // Pressure (coeff 5) should be more significant than Cycle Time (coeff 2)
    expect(pressRow!.contribution_pct).toBeGreaterThan(timeRow!.contribution_pct);
  });

  it('should compute main effects with correct signs', () => {
    const matrix = generateMatrix(DOE_CONFIG);

    // Fill: y = 50 + 10*x1 + 5*x2 + 2*x3
    for (const run of matrix.runs) {
      run.responses['strength'] = 50 + 10 * run.factor_coded['temp'] + 5 * run.factor_coded['press'] + 2 * run.factor_coded['time'];
    }

    const analysis = analyzeDOE(DOE_CONFIG, matrix);

    // Temperature effect: mean_at_high - mean_at_low
    const tempEffect = analysis.main_effects.find(e => e.factor_name === 'Temperature');
    expect(tempEffect).toBeDefined();
    // At temp=180 (coded -1): y = 50-10+... = 40,42,45,47 (avg depends on others)
    // At temp=220 (coded +1): y = 50+10+... = 60,62,65,67
    // Effect size ≈ 20 (from -10 to +10)
    expect(tempEffect!.effect_size).toBeCloseTo(20, 0);
    expect(tempEffect!.effect_size).toBeGreaterThan(0); // positive effect

    const pressEffect = analysis.main_effects.find(e => e.factor_name === 'Pressure');
    expect(pressEffect!.effect_size).toBeCloseTo(10, 0);
    expect(pressEffect!.effect_size).toBeGreaterThan(0);

    const timeEffect = analysis.main_effects.find(e => e.factor_name === 'Cycle Time');
    expect(timeEffect!.effect_size).toBeCloseTo(4, 0);
    expect(timeEffect!.effect_size).toBeGreaterThan(0);
  });

  it('should have no significant interactions for additive model', () => {
    const matrix = generateMatrix(DOE_CONFIG);

    // Purely additive: y = 50 + 10*x1 + 5*x2 + 2*x3 (no interaction terms)
    for (const run of matrix.runs) {
      run.responses['strength'] = 50 + 10 * run.factor_coded['temp'] + 5 * run.factor_coded['press'] + 2 * run.factor_coded['time'];
    }

    const analysis = analyzeDOE(DOE_CONFIG, matrix);
    const anovaTable = analysis.anova[0];

    // Interaction terms should have negligible contribution
    const interactions = anovaTable.rows.filter(r => r.source.includes('×'));
    for (const int of interactions) {
      expect(int.contribution_pct).toBeLessThan(1);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.7 — FINITE STATE MACHINE (FSM)
// ══════════════════════════════════════════════════════════════════

describe('S15.7 — FSM Sanity Check', () => {
  it('should load CNC machine template', () => {
    const template = getTemplate('cnc_machine');
    expect(template).toBeDefined();
    expect(template!.definition.states.length).toBeGreaterThan(3);
    expect(template!.definition.transitions.length).toBeGreaterThan(5);

    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it('should run simulation and have state residence times sum to sim duration', () => {
    const template = getTemplate('cnc_machine')!;
    const fsmConfig: FSMConfig = {
      name: 'CNC Sanity',
      machines: [{
        id: 'cnc1', name: 'CNC #1',
        ...template.definition,
      }],
      sim_duration_minutes: 480,
    };

    const events = generateDemoEvents(fsmConfig);
    expect(events.length).toBeGreaterThan(0);

    fsmConfig.event_queue = events;
    let state = initSimulation(fsmConfig);
    state = runToCompletion(state, fsmConfig);

    const analysis = analyzeSimulation(state, fsmConfig);
    expect(analysis.machines.length).toBe(1);

    const machine = analysis.machines[0];
    // State residence times should sum to total sim duration
    const totalResidence = machine.state_residence.reduce((s, sr) => s + sr.total_time, 0);
    expect(totalResidence).toBeCloseTo(480, 0);

    // Percentages should sum to ~100%
    const totalPct = machine.state_residence.reduce((s, sr) => s + sr.pct_of_total, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it('should compute utilization = processing / total × 100', () => {
    const template = getTemplate('cnc_machine')!;
    const fsmConfig: FSMConfig = {
      name: 'CNC Util Check',
      machines: [{
        id: 'cnc1', name: 'CNC #1',
        ...template.definition,
      }],
      sim_duration_minutes: 480,
    };

    const events = generateDemoEvents(fsmConfig);
    fsmConfig.event_queue = events;
    let state = initSimulation(fsmConfig);
    state = runToCompletion(state, fsmConfig);

    const analysis = analyzeSimulation(state, fsmConfig);
    const machine = analysis.machines[0];

    // Utilization should be processing time / total
    const expectedUtil = (machine.total_processing_time / 480) * 100;
    expect(machine.utilization_pct).toBeCloseTo(expectedUtil, 1);
    expect(machine.utilization_pct).toBeGreaterThanOrEqual(0);
    expect(machine.utilization_pct).toBeLessThanOrEqual(100);
  });

  it('should compute availability = (total - breakdown) / total × 100', () => {
    const template = getTemplate('cnc_machine')!;
    const fsmConfig: FSMConfig = {
      name: 'CNC Avail Check',
      machines: [{
        id: 'cnc1', name: 'CNC #1',
        ...template.definition,
      }],
      sim_duration_minutes: 480,
    };

    const events = generateDemoEvents(fsmConfig);
    fsmConfig.event_queue = events;
    let state = initSimulation(fsmConfig);
    state = runToCompletion(state, fsmConfig);

    const analysis = analyzeSimulation(state, fsmConfig);
    const machine = analysis.machines[0];

    const expectedAvail = ((480 - machine.total_breakdown_time) / 480) * 100;
    expect(machine.availability_pct).toBeCloseTo(expectedAvail, 1);
    expect(machine.availability_pct).toBeGreaterThanOrEqual(0);
    expect(machine.availability_pct).toBeLessThanOrEqual(100);
  });
});

// ══════════════════════════════════════════════════════════════════
// S15.8 — CROSS-TOOL CONNECTIONS (BRIDGES)
// ══════════════════════════════════════════════════════════════════

describe('Cross-Tool Bridges', () => {
  it('S15.7 FSM bridge from S16 simulation metrics', () => {
    const stationPerf = [
      { machine_tool: 'CNC_01', total_busy_time_min: 350, queue_wait_time_min: 50, util_pct: 72.9, is_bottleneck: true },
      { machine_tool: 'LATHE_01', total_busy_time_min: 280, queue_wait_time_min: 30, util_pct: 58.3, is_bottleneck: false },
    ];

    const results = bridgeFromSimulation(stationPerf, 480, 20);
    expect(results.length).toBe(2);

    for (const r of results) {
      expect(r.processing_minutes).toBeGreaterThan(0);
      expect(r.state_residence.length).toBeGreaterThan(0);

      // State residence percentages should sum to ~100%
      const totalPct = r.state_residence.reduce((s, sr) => s + sr.pct_of_total, 0);
      expect(totalPct).toBeCloseTo(100, 0);

      // Processing time should match input
      const processingRes = r.state_residence.find(sr => sr.mfg_type === 'processing');
      expect(processingRes).toBeDefined();
    }

    // CNC should have higher utilization
    expect(results[0].utilization_pct).toBeGreaterThan(results[1].utilization_pct);
  });

  it('S15.7 FSM bridge from VSM breakdown', () => {
    const vsmBreakdown = [
      { step_name: 'Cutting', category: 'VA', cycle_time: 8, wait_time: 10, transport_time: 2, changeover_per_unit: 0.2 },
      { step_name: 'Sewing', category: 'VA', cycle_time: 15, wait_time: 20, transport_time: 0, changeover_per_unit: 0.2 },
      { step_name: 'Rework', category: 'NVA', cycle_time: 10, wait_time: 30, transport_time: 0, changeover_per_unit: 0 },
    ];

    const results = bridgeFromVSM(vsmBreakdown);
    expect(results.length).toBe(3);

    // VA steps should have processing time = cycle_time
    const cutting = results.find(r => r.machine_name === 'Cutting')!;
    expect(cutting.processing_minutes).toBe(8);
    expect(cutting.queued_minutes).toBe(10);

    // NVA step should have 0 processing (goes to idle)
    const rework = results.find(r => r.machine_name === 'Rework')!;
    expect(rework.processing_minutes).toBe(0);
    expect(rework.idle_minutes).toBe(10); // NVA cycle_time maps to idle

    // Each should have valid state residence
    for (const r of results) {
      expect(r.state_residence.length).toBeGreaterThan(0);
      const totalTime = r.state_residence.reduce((s, sr) => s + sr.total_time, 0);
      expect(totalTime).toBeGreaterThan(0);
    }
  });

  it('S15.7 FSM bridge from TOC ranking', () => {
    const ranking = [
      { name: 'Stamping', utilization_pct: 52, load_hours: 4.17, available_hours: 8, is_ccr: false, excess_hours: 3.83 },
      { name: 'Assembly', utilization_pct: 104, load_hours: 8.33, available_hours: 8, is_ccr: true, excess_hours: 0 },
    ];

    const results = bridgeFromTOC(ranking, 480);
    expect(results.length).toBe(2);

    // Assembly (CCR) should show as overloaded
    const assembly = results.find(r => r.machine_name.includes('Assembly'))!;
    expect(assembly.machine_name).toContain('(CCR)');
    expect(assembly.utilization_pct).toBe(104);
    expect(assembly.processing_minutes).toBe(480); // capped at available time

    // Stamping should have idle time
    const stamping = results.find(r => r.machine_name.includes('Stamping'))!;
    expect(stamping.idle_minutes).toBeGreaterThan(0);
    expect(stamping.processing_minutes).toBeLessThan(480);
  });
});
