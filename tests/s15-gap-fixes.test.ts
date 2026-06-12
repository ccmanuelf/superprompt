/**
 * S15 Gap Fixes Validation
 *
 * Verifies each of the 10 gaps fixed in the S15 sprint actually work correctly.
 * Gaps tested: #2, #3, #6, #7, #8, #10, #11, #12, #15, #16
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
vi.mock('../src/config.js', () => ({ STORE_DIR: resolve(tmpdir(), 'luna-test-gap-fixes'), config: { NODE_ENV: 'test' } }));

// ── Imports (after mocks) ───────────────────────────────────

import {
  analyzeCapacity,
  type CapacityPlanConfig,
  type CapacityLine,
  type CalendarConfig,
} from '../src/capacity/analysis.js';
import { initCapacityTables } from '../src/capacity/index.js';

import { dispatch } from '../src/sequencer/dispatching.js';
import { buildGanttData, dateToPlanMinutes } from '../src/sequencer/evaluation.js';
import { initSequencerTables } from '../src/sequencer/index.js';
import type { SequencerConfig } from '../src/sequencer/models.js';

import { analyzeVSM } from '../src/vsm/analysis.js';
import { initVsmTables } from '../src/vsm/index.js';
import type { VSMConfig } from '../src/vsm/models.js';

import { analyzeTOC } from '../src/toc/analysis.js';
import { initTocTables, recordThroughput, getThroughputHistory } from '../src/toc/index.js';
import type { TOCConfig } from '../src/toc/models.js';

// ── Test Helpers ────────────────────────────────────────────

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initCapacityTables();
  await initSequencerTables();
  await initVsmTables();
  await initTocTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ═════════════════════════════════════════════════════════════
// GAP #2 — Per-line calendar override
// ═════════════════════════════════════════════════════════════

describe('GAP #2 — Per-line calendar override', () => {
  it('uses per-line calendar_override when set, plan-level calendar otherwise', () => {
    const planCalendar: CalendarConfig = {
      working_days: 5,
      shifts_per_day: 1,
      hours_per_shift: 8,
    };

    const lineWithOverride: CapacityLine = {
      id: 'line_a',
      code: 'A',
      name: 'Line A (3-shift override)',
      max_operators: 10,
      efficiency_factor: 0.85,
      absenteeism_factor: 0.05,
      calendar_override: {
        working_days: 5,
        shifts_per_day: 3,
        hours_per_shift: 8,
      },
    };

    const lineWithoutOverride: CapacityLine = {
      id: 'line_b',
      code: 'B',
      name: 'Line B (plan calendar)',
      max_operators: 10,
      efficiency_factor: 0.85,
      absenteeism_factor: 0.05,
    };

    const config: CapacityPlanConfig = {
      name: 'Gap #2 Test',
      period_label: 'Week 1',
      period_start: '2026-01-01',
      period_end: '2026-01-07',
      calendar: planCalendar,
      lines: [lineWithOverride, lineWithoutOverride],
      demands: [
        { product: 'X', line_id: 'line_a', quantity: 100, hours: 10 },
        { product: 'Y', line_id: 'line_b', quantity: 100, hours: 10 },
      ],
    };

    const result = analyzeCapacity(config);
    const lineA = result.lines.find((l) => l.line_id === 'line_a')!;
    const lineB = result.lines.find((l) => l.line_id === 'line_b')!;

    // Line A should use 3 shifts
    expect(lineA.shifts_per_day).toBe(3);
    // Line B should use plan-level 1 shift
    expect(lineB.shifts_per_day).toBe(1);

    // Gross hours differ: A = 5 * 3 * 8 = 120, B = 5 * 1 * 8 = 40
    expect(lineA.gross_hours).toBe(120);
    expect(lineB.gross_hours).toBe(40);
    expect(lineA.gross_hours).toBeGreaterThan(lineB.gross_hours);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #3 — Units throughput
// ═════════════════════════════════════════════════════════════

describe('GAP #3 — Units throughput', () => {
  it('computes capacity_units and throughput_rate_uph when standard_capacity_uph is set', () => {
    const line: CapacityLine = {
      id: 'line_uph',
      code: 'UPH',
      name: 'UPH Line',
      max_operators: 5,
      efficiency_factor: 0.90,
      absenteeism_factor: 0.05,
      standard_capacity_uph: 50,
    };

    const config: CapacityPlanConfig = {
      name: 'Gap #3 Test',
      period_label: 'Week 1',
      period_start: '2026-01-01',
      period_end: '2026-01-07',
      calendar: { working_days: 5, shifts_per_day: 1, hours_per_shift: 8 },
      lines: [line],
      demands: [{ product: 'P', line_id: 'line_uph', quantity: 500, hours: 20 }],
    };

    const result = analyzeCapacity(config);
    const lineResult = result.lines[0];

    // capacity_units = capacity_hours * standard_capacity_uph
    expect(lineResult.capacity_units).toBeDefined();
    expect(lineResult.capacity_units).toBeCloseTo(lineResult.capacity_hours * 50, 1);

    // throughput_rate_uph is set and > 0
    expect(lineResult.throughput_rate_uph).toBeDefined();
    expect(lineResult.throughput_rate_uph!).toBeGreaterThan(0);
    // throughput_rate_uph = standard_capacity_uph * efficiency * (1 - absenteeism)
    expect(lineResult.throughput_rate_uph).toBeCloseTo(50 * 0.90 * 0.95, 1);
  });

  it('has capacity_units === undefined when standard_capacity_uph is not set', () => {
    const line: CapacityLine = {
      id: 'line_no_uph',
      code: 'NOUPH',
      name: 'No UPH Line',
      max_operators: 5,
      efficiency_factor: 0.90,
      absenteeism_factor: 0.05,
      // NO standard_capacity_uph
    };

    const config: CapacityPlanConfig = {
      name: 'Gap #3 Test No UPH',
      period_label: 'Week 1',
      period_start: '2026-01-01',
      period_end: '2026-01-07',
      calendar: { working_days: 5, shifts_per_day: 1, hours_per_shift: 8 },
      lines: [line],
      demands: [{ product: 'P', line_id: 'line_no_uph', quantity: 500, hours: 20 }],
    };

    const result = analyzeCapacity(config);
    expect(result.lines[0].capacity_units).toBeUndefined();
    expect(result.lines[0].throughput_rate_uph).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #6 — 0-processing-time job warning
// ═════════════════════════════════════════════════════════════

describe('GAP #6 — 0-processing-time job warning', () => {
  it('emits a warning for jobs with 0 processing time', () => {
    const config: SequencerConfig = {
      name: 'Gap #6 Test',
      jobs: [
        { id: 'j1', name: 'Normal Job', product: 'A', quantity: 10, processing_minutes: 30 },
        { id: 'j2', name: 'Zero Job', product: 'B', quantity: 5, processing_minutes: 0 },
      ],
      machines: [{ id: 'm1', name: 'Machine 1' }],
    };

    const result = dispatch(config, 'FIFO');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    const zeroWarning = result.warnings!.find((w) => w.includes('Zero Job') && w.includes('0'));
    expect(zeroWarning).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #7 — Idle bars in Gantt
// ═════════════════════════════════════════════════════════════

describe('GAP #7 — Idle bars in Gantt', () => {
  it('inserts Idle bars in gaps between jobs on the same machine', () => {
    // Create 2 jobs with a forced gap: job1 starts at T=0, ends at T=30
    // job2 has arrival_time=60 so it cannot start until T=60
    const config: SequencerConfig = {
      name: 'Gap #7 Test',
      jobs: [
        { id: 'j1', name: 'Job 1', product: 'A', quantity: 10, processing_minutes: 30, arrival_time: 0 },
        { id: 'j2', name: 'Job 2', product: 'A', quantity: 10, processing_minutes: 30, arrival_time: 60 },
      ],
      machines: [{ id: 'm1', name: 'Machine 1' }],
    };

    const result = dispatch(config, 'FIFO');
    const gantt = buildGanttData(result.entries, config);

    // There should be an idle bar between T=30 and T=60
    const idleBars = gantt.bars.filter((b) => b.job_name === 'Idle');
    expect(idleBars.length).toBeGreaterThanOrEqual(1);

    const idleBar = idleBars[0];
    expect(idleBar.start).toBe(30);
    expect(idleBar.end).toBe(60);
    expect(idleBar.color).toBe('#e0e0e0');
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #8 — Configurable planning start date
// ═════════════════════════════════════════════════════════════

describe('GAP #8 — Configurable planning start date', () => {
  it('uses planning_start_date and working_hours_per_day for date-to-minutes conversion', () => {
    const config: SequencerConfig = {
      name: 'Gap #8 Test',
      jobs: [],
      machines: [],
      planning_start_date: '2026-01-01',
      working_hours_per_day: 10,
    };

    // Due date is 2026-01-03 (2 days later)
    // Expected: ~2 days * 10 hours * 60 = 1200 min
    // dateToPlanMinutes sets due to 17:00, start to 00:00
    // diffDays = (Jan 3 17:00 - Jan 1 00:00) / 86400000 = 2.708...
    // result = round(2.708 * 10 * 60) = round(1625) = 1625
    const minutes = dateToPlanMinutes('2026-01-03', config);

    // The exact value depends on EOB (17:00) handling:
    // Jan 1 00:00 to Jan 3 17:00 = 2 days 17 hours = 2.708 days
    // 2.708 * 10 * 60 = 1625 minutes
    expect(minutes).toBeGreaterThan(1000);
    expect(minutes).toBeLessThan(2000);
    // More precisely: ~1625
    expect(minutes).toBeCloseTo(1625, -1);
  });

  it('defaults to 8 hours per day when working_hours_per_day is not set', () => {
    const config: SequencerConfig = {
      name: 'Gap #8 Default Hours',
      jobs: [],
      machines: [],
      planning_start_date: '2026-01-01',
      // no working_hours_per_day -> defaults to 8
    };

    const minutes = dateToPlanMinutes('2026-01-03', config);
    // 2.708 days * 8 * 60 = 1300
    expect(minutes).toBeGreaterThan(800);
    expect(minutes).toBeLessThan(1600);
    expect(minutes).toBeCloseTo(1300, -1);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #10 — VSM cycle time validation warning
// ═════════════════════════════════════════════════════════════

describe('GAP #10 — VSM cycle time validation warning', () => {
  it('warns about suspiciously large cycle times (possible seconds vs minutes)', () => {
    const config: VSMConfig = {
      name: 'Gap #10 Test',
      product_family: 'Test Product',
      customer_demand_per_day: 100,
      available_minutes_per_day: 460,
      state: 'current',
      steps: [
        { id: 's1', name: 'Normal Step', sequence: 1, cycle_time: 2, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
        { id: 's2', name: 'Suspicious Step', sequence: 2, cycle_time: 600, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
      ],
    };

    const result = analyzeVSM(config);
    expect(result.warnings.length).toBeGreaterThan(0);
    const ctWarning = result.warnings.find((w) => w.includes('Suspicious Step') && w.includes('600'));
    expect(ctWarning).toBeDefined();
  });

  it('does not warn for normal cycle times', () => {
    const config: VSMConfig = {
      name: 'Gap #10 No Warn',
      product_family: 'Test Product',
      customer_demand_per_day: 100,
      available_minutes_per_day: 460,
      state: 'current',
      steps: [
        { id: 's1', name: 'Step 1', sequence: 1, cycle_time: 2, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
        { id: 's2', name: 'Step 2', sequence: 2, cycle_time: 5, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
      ],
    };

    const result = analyzeVSM(config);
    expect(result.warnings.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #11 — VSM lead time in hours/days
// ═════════════════════════════════════════════════════════════

describe('GAP #11 — VSM lead time in hours/days', () => {
  it('computes lead_time_hours and lead_time_days from total_lead_time', () => {
    const config: VSMConfig = {
      name: 'Gap #11 Test',
      product_family: 'Widgets',
      customer_demand_per_day: 50,
      available_minutes_per_day: 480,
      state: 'current',
      steps: [
        { id: 's1', name: 'Cut', sequence: 1, cycle_time: 10, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 2, wait_time: 60 },
        { id: 's2', name: 'Weld', sequence: 2, cycle_time: 20, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 3, wait_time: 120 },
        { id: 's3', name: 'Paint', sequence: 3, cycle_time: 15, changeover_time: 30, uptime_pct: 100, category: 'VA', operators: 1, wait_time: 30, batch_size: 10 },
      ],
    };

    const result = analyzeVSM(config);

    // total_lead_time = sum of (cycle_time + wait_time + transport_time + changeover_per_unit) for each step
    // s1: 10 + 60 + 0 + 0 = 70
    // s2: 20 + 120 + 0 + 0 = 140
    // s3: 15 + 30 + 0 + 3 (30/10) = 48
    // total = 258 min
    expect(result.total_lead_time).toBeCloseTo(258, 0);

    // lead_time_hours = total_lead_time / 60
    expect(result.lead_time_hours).toBeCloseTo(result.total_lead_time / 60, 1);

    // lead_time_days = total_lead_time / 480 (8h working day)
    expect(result.lead_time_days).toBeCloseTo(result.total_lead_time / 480, 1);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #12 — VSM takt vs bottleneck
// ═════════════════════════════════════════════════════════════

describe('GAP #12 — VSM takt vs bottleneck', () => {
  it('meets_takt = true when bottleneck C/T < takt time', () => {
    // takt = 480 / 100 = 4.8 min, bottleneck C/T = 2 min => meets
    const config: VSMConfig = {
      name: 'Gap #12 Meets',
      product_family: 'Test',
      customer_demand_per_day: 100,
      available_minutes_per_day: 480,
      state: 'current',
      steps: [
        { id: 's1', name: 'Step A', sequence: 1, cycle_time: 1, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
        { id: 's2', name: 'Step B', sequence: 2, cycle_time: 2, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
      ],
    };

    const result = analyzeVSM(config);
    expect(result.takt_time).toBeCloseTo(4.8, 1);
    expect(result.bottleneck_cycle_time).toBe(2);
    expect(result.meets_takt).toBe(true);
    expect(result.takt_gap_minutes).toBeGreaterThan(0);
    expect(result.takt_gap_minutes).toBeCloseTo(2.8, 1);
  });

  it('meets_takt = false when bottleneck C/T > takt time', () => {
    // takt = 480 / 100 = 4.8 min, bottleneck C/T = 8 min => does NOT meet
    const config: VSMConfig = {
      name: 'Gap #12 Fails',
      product_family: 'Test',
      customer_demand_per_day: 100,
      available_minutes_per_day: 480,
      state: 'current',
      steps: [
        { id: 's1', name: 'Step A', sequence: 1, cycle_time: 3, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
        { id: 's2', name: 'Step B', sequence: 2, cycle_time: 8, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
      ],
    };

    const result = analyzeVSM(config);
    expect(result.takt_time).toBeCloseTo(4.8, 1);
    expect(result.bottleneck_cycle_time).toBe(8);
    expect(result.meets_takt).toBe(false);
    expect(result.takt_gap_minutes).toBeLessThan(0);
    expect(result.takt_gap_minutes).toBeCloseTo(-3.2, 1);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #15 — TOC throughput history
// ═════════════════════════════════════════════════════════════

describe('GAP #15 — TOC throughput history', () => {
  it('records and retrieves throughput data points sorted by period desc', async () => {
    await recordThroughput('MyPlant', '2026-01', 1000, 50000, 85.5, 200);
    await recordThroughput('MyPlant', '2026-02', 1100, 55000, 88.0, 180);
    await recordThroughput('MyPlant', '2026-03', 1200, 60000, 90.0, 160);

    const history = await getThroughputHistory('MyPlant');
    expect(history.length).toBe(3);

    // Sorted by period desc
    expect(history[0].period).toBe('2026-03');
    expect(history[1].period).toBe('2026-02');
    expect(history[2].period).toBe('2026-01');

    // Verify values
    expect(history[0].throughput_units).toBe(1200);
    expect(history[0].throughput_dollars).toBe(60000);
    expect(history[0].constraint_utilization_pct).toBe(90.0);
    expect(history[0].wip_units).toBe(160);
  });

  it('filters by config_name — different plants do not mix', async () => {
    await recordThroughput('PlantA', '2026-01', 500, 25000, 70, 100);
    await recordThroughput('PlantB', '2026-01', 800, 40000, 92, 150);

    const historyA = await getThroughputHistory('PlantA');
    const historyB = await getThroughputHistory('PlantB');

    expect(historyA.length).toBe(1);
    expect(historyA[0].throughput_units).toBe(500);
    expect(historyB.length).toBe(1);
    expect(historyB[0].throughput_units).toBe(800);
  });
});

// ═════════════════════════════════════════════════════════════
// GAP #16 — TOC assembly buffer
// ═════════════════════════════════════════════════════════════

describe('GAP #16 — TOC assembly buffer', () => {
  it('analyzeTOC produces an assembly_buffer in the DBR schedule', () => {
    const config: TOCConfig = {
      name: 'Gap #16 Assembly Buffer',
      work_centers: [
        { id: 'wc1', name: 'Machining', capacity_units_per_hour: 20, available_hours_per_day: 8, operators: 3, current_wip: 50 },
        { id: 'wc2', name: 'Assembly', capacity_units_per_hour: 15, available_hours_per_day: 8, operators: 5, current_wip: 30 },
        { id: 'wc3', name: 'Testing', capacity_units_per_hour: 25, available_hours_per_day: 8, operators: 2, current_wip: 10 },
      ],
      selling_price_per_unit: 100,
      total_variable_cost_per_unit: 40,
      operating_expense_per_period: 50000,
      investment: 500000,
      demand_units_per_day: 130,
      available_hours_per_day: 8,
    };

    const result = analyzeTOC(config);

    // assembly_buffer must exist
    expect(result.dbr.assembly_buffer).toBeDefined();
    expect(result.dbr.assembly_buffer!.total_size).toBeGreaterThan(0);
    expect(['green', 'yellow', 'red']).toContain(result.dbr.assembly_buffer!.zone);

    // Also verify shipping and constraint buffers exist
    expect(result.dbr.shipping_buffer).toBeDefined();
    expect(result.dbr.shipping_buffer.total_size).toBeGreaterThan(0);
    expect(result.dbr.constraint_buffer).toBeDefined();
    expect(result.dbr.constraint_buffer.total_size).toBeGreaterThan(0);
  });
});
