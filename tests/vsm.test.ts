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
  STORE_DIR: resolve(tmpdir(), 'luna-test-vsm'),
  config: { NODE_ENV: 'test' },
}));

import { analyzeVSM, compareStates, classifyTimwoods } from '../src/vsm/analysis.js';
import {
  initVsmTables,
  saveVSM,
  getVSM,
  listVSMs,
  deleteVSM,
} from '../src/vsm/index.js';
import type { VSMConfig, ProcessStep } from '../src/vsm/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initVsmTables();
}

beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const SAMPLE_STEPS: ProcessStep[] = [
  { id: 's1', name: 'Receive', sequence: 1, cycle_time: 0.5, changeover_time: 0, uptime_pct: 100, category: 'BNVA', operators: 1, wait_time: 30, wip_before: 200 },
  { id: 's2', name: 'Cut', sequence: 2, cycle_time: 2.0, changeover_time: 15, uptime_pct: 90, category: 'VA', operators: 2, wait_time: 10, batch_size: 50 },
  { id: 's3', name: 'Sew', sequence: 3, cycle_time: 4.5, changeover_time: 10, uptime_pct: 85, category: 'VA', operators: 4, wait_time: 15, wip_before: 100 },
  { id: 's4', name: 'Inspect', sequence: 4, cycle_time: 1.0, changeover_time: 0, uptime_pct: 100, category: 'BNVA', operators: 1, wait_time: 5 },
  { id: 's5', name: 'Pack', sequence: 5, cycle_time: 1.5, changeover_time: 5, uptime_pct: 95, category: 'VA', operators: 2, transport_time: 3 },
  { id: 's6', name: 'Ship', sequence: 6, cycle_time: 0.5, changeover_time: 0, uptime_pct: 100, category: 'BNVA', operators: 1, wait_time: 20 },
];

const SAMPLE_CONFIG: VSMConfig = {
  name: 'Test Assembly VSM',
  product_family: 'Widget',
  customer_demand_per_day: 100,
  available_minutes_per_day: 460,
  state: 'current',
  steps: SAMPLE_STEPS,
  inventory_points: [
    { id: 'inv1', name: 'Raw Material', after_step_id: 's1', quantity: 500 },
  ],
};

// ══════════════════════════════════════════════════════════════
// Takt Time
// ══════════════════════════════════════════════════════════════

describe('Takt Time', () => {
  it('should calculate takt time correctly', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    // 460 / 100 = 4.6 min/unit
    expect(result.takt_time).toBe(4.6);
  });

  it('should handle zero demand', () => {
    const config = { ...SAMPLE_CONFIG, customer_demand_per_day: 0 };
    const result = analyzeVSM(config);
    expect(result.takt_time).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// PCE Calculation
// ══════════════════════════════════════════════════════════════

describe('PCE (Process Cycle Efficiency)', () => {
  it('should calculate PCE = VA / lead time × 100', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    // VA steps: Cut(2.0) + Sew(4.5) + Pack(1.5) = 8.0 min
    expect(result.total_va_time).toBe(8);
    expect(result.pce_pct).toBeGreaterThan(0);
    expect(result.pce_pct).toBeLessThan(100);
    // Verify formula: PCE = 8.0 / total_lead_time × 100
    expect(result.pce_pct).toBeCloseTo((8.0 / result.total_lead_time) * 100, 1);
  });

  it('should be 100% when all steps are VA with no wait/transport', () => {
    const steps: ProcessStep[] = [
      { id: 's1', name: 'Step 1', sequence: 1, cycle_time: 5, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
      { id: 's2', name: 'Step 2', sequence: 2, cycle_time: 3, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 },
    ];
    const config: VSMConfig = { ...SAMPLE_CONFIG, steps };
    const result = analyzeVSM(config);
    expect(result.pce_pct).toBe(100);
  });

  it('should be 0% when no VA steps', () => {
    const steps: ProcessStep[] = [
      { id: 's1', name: 'Wait', sequence: 1, cycle_time: 10, changeover_time: 0, uptime_pct: 100, category: 'NVA', operators: 1 },
    ];
    const config: VSMConfig = { ...SAMPLE_CONFIG, steps };
    const result = analyzeVSM(config);
    expect(result.pce_pct).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Lead Time Breakdown
// ══════════════════════════════════════════════════════════════

describe('Lead Time Breakdown', () => {
  it('should break down each step', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    expect(result.lead_time_breakdown).toHaveLength(6);
  });

  it('should sum to total lead time', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    const summedTime = result.lead_time_breakdown.reduce((s, b) => s + b.total_step_time, 0);
    expect(summedTime).toBeCloseTo(result.total_lead_time, 1);
  });

  it('should include wait and transport times', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    expect(result.total_wait_time).toBeGreaterThan(0);
    expect(result.total_transport_time).toBeGreaterThan(0);
  });

  it('should compute changeover per unit correctly', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    const cutStep = result.lead_time_breakdown.find((b) => b.step_name === 'Cut')!;
    // Cut: changeover=15, batch_size=50 → 15/50 = 0.3 min/unit
    expect(cutStep.changeover_per_unit).toBeCloseTo(0.3, 1);
  });

  it('should classify VA, NVA, BNVA correctly', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    expect(result.total_va_time).toBeGreaterThan(0);
    expect(result.total_bnva_time).toBeGreaterThan(0);
    expect(result.total_va_time + result.total_nva_time + result.total_bnva_time)
      .toBeCloseTo(result.lead_time_breakdown.reduce((s, b) => s + b.cycle_time, 0), 1);
  });
});

// ══════════════════════════════════════════════════════════════
// TIMWOODS Waste
// ══════════════════════════════════════════════════════════════

describe('TIMWOODS Waste Classification', () => {
  it('should detect waiting waste from wait_time', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    const waiting = tw.find((t) => t.waste_type === 'waiting');
    expect(waiting).toBeDefined();
    expect(waiting!.total_minutes).toBeGreaterThan(0);
    // Total wait: 30 + 10 + 15 + 5 + 20 = 80 min
    expect(waiting!.total_minutes).toBe(80);
  });

  it('should detect transport waste', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    const transport = tw.find((t) => t.waste_type === 'transport');
    expect(transport).toBeDefined();
    // Pack step has transport_time: 3
    expect(transport!.total_minutes).toBe(3);
  });

  it('should detect inventory waste from WIP + inventory points', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    const inventory = tw.find((t) => t.waste_type === 'inventory');
    expect(inventory).toBeDefined();
    expect(inventory!.total_minutes).toBeGreaterThan(0);
  });

  it('should detect defects waste from low uptime', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    const defects = tw.find((t) => t.waste_type === 'defects');
    expect(defects).toBeDefined();
    // Cut: 90% uptime → 10% × 2.0 = 0.2, Sew: 85% → 15% × 4.5 = 0.675, Pack: 95% → 5% × 1.5 = 0.075
    expect(defects!.total_minutes).toBeCloseTo(0.95, 1);
  });

  it('should include suggestions for each waste type', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    for (const t of tw) {
      if (t.total_minutes > 0) {
        expect(t.suggestion).toBeTruthy();
        expect(t.suggestion.length).toBeGreaterThan(10);
      }
    }
  });

  it('should sort by total_minutes descending', () => {
    const tw = classifyTimwoods(SAMPLE_CONFIG);
    const withValues = tw.filter((t) => t.total_minutes > 0);
    for (let i = 1; i < withValues.length; i++) {
      expect(withValues[i].total_minutes).toBeLessThanOrEqual(withValues[i - 1].total_minutes);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Current vs Future Comparison
// ══════════════════════════════════════════════════════════════

describe('State Comparison', () => {
  it('should compare current vs future and show improvements', () => {
    const futureSteps: ProcessStep[] = SAMPLE_STEPS.map((s) => ({
      ...s,
      wait_time: Math.round((s.wait_time ?? 0) * 0.5), // 50% wait reduction
      wip_before: Math.round((s.wip_before ?? 0) * 0.6), // 40% WIP reduction
    }));
    const futureConfig: VSMConfig = { ...SAMPLE_CONFIG, name: 'Future', state: 'future', steps: futureSteps };

    const comp = compareStates(SAMPLE_CONFIG, futureConfig);
    expect(comp.current.state).toBe('current');
    expect(comp.future.state).toBe('future');
    expect(comp.improvements.length).toBeGreaterThan(0);
    expect(comp.summary).toBeTruthy();

    // Lead time should decrease
    const ltImprovement = comp.improvements.find((i) => i.metric === 'Lead Time');
    expect(ltImprovement).toBeDefined();
    expect(ltImprovement!.change).toBeLessThan(0); // Decrease

    // PCE should increase
    const pceImprovement = comp.improvements.find((i) => i.metric === 'PCE');
    expect(pceImprovement).toBeDefined();
    expect(pceImprovement!.change).toBeGreaterThan(0); // Increase
  });

  it('should handle identical states', () => {
    const comp = compareStates(SAMPLE_CONFIG, SAMPLE_CONFIG);
    for (const imp of comp.improvements) {
      expect(imp.change).toBeCloseTo(0, 1);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Waterfall Data
// ══════════════════════════════════════════════════════════════

describe('Waterfall Data', () => {
  it('should generate waterfall entries for each step', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    expect(result.waterfall).toHaveLength(6);
  });

  it('should have increasing cumulative values', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    for (let i = 1; i < result.waterfall.length; i++) {
      expect(result.waterfall[i].cumulative).toBeGreaterThanOrEqual(result.waterfall[i - 1].cumulative);
    }
  });

  it('should classify VA vs NVA in waterfall', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    // Cut is VA → va_minutes > 0
    const cutEntry = result.waterfall.find((w) => w.label === 'Cut')!;
    expect(cutEntry.va_minutes).toBeGreaterThan(0);
    expect(cutEntry.nva_minutes).toBe(0);

    // Receive is BNVA → nva_minutes > 0
    const receiveEntry = result.waterfall.find((w) => w.label === 'Receive')!;
    expect(receiveEntry.va_minutes).toBe(0);
    expect(receiveEntry.nva_minutes).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Bottleneck
// ══════════════════════════════════════════════════════════════

describe('Bottleneck Detection', () => {
  it('should identify bottleneck as highest effective cycle time', () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    // Sew: 4.5 / 4 ops = 1.125, Cut: 2.0 / 2 = 1.0, Pack: 1.5 / 2 = 0.75
    // But Sew: 4.5/4=1.125 is the highest effective C/T
    expect(result.bottleneck_step).toBe('Sew');
    expect(result.bottleneck_cycle_time).toBeCloseTo(1.125, 2);
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve a VSM', async () => {
    const saved = await saveVSM('My VSM', SAMPLE_CONFIG);
    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe('My VSM');

    const retrieved = await getVSM('My VSM');
    expect(retrieved).toBeDefined();
    expect(JSON.parse(retrieved!.config_json).steps).toHaveLength(6);
  });

  it('should save with analysis result', async () => {
    const result = analyzeVSM(SAMPLE_CONFIG);
    await saveVSM('With Result', SAMPLE_CONFIG, result);
    const retrieved = await getVSM('With Result');
    expect(retrieved!.result_json).toBeTruthy();
    expect(JSON.parse(retrieved!.result_json!).pce_pct).toBeGreaterThan(0);
  });

  it('should update on name collision', async () => {
    await saveVSM('Same', SAMPLE_CONFIG);
    await saveVSM('Same', { ...SAMPLE_CONFIG, product_family: 'Gadget' });
    const all = await listVSMs();
    expect(all.filter((v) => v.name === 'Same')).toHaveLength(1);
  });

  it('should delete a VSM', async () => {
    const saved = await saveVSM('ToDelete', SAMPLE_CONFIG);
    expect(await deleteVSM(saved.id)).toBe(true);
    expect(await getVSM(saved.id)).toBeUndefined();
  });

  it('should list sorted by updated_at', async () => {
    await saveVSM('A', SAMPLE_CONFIG);
    await saveVSM('B', SAMPLE_CONFIG);
    const all = await listVSMs();
    expect(all).toHaveLength(2);
    expect(all[0].updated_at).toBeGreaterThanOrEqual(all[1].updated_at);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle single step', () => {
    const config: VSMConfig = {
      ...SAMPLE_CONFIG,
      steps: [{ id: 's1', name: 'Only Step', sequence: 1, cycle_time: 5, changeover_time: 0, uptime_pct: 100, category: 'VA', operators: 1 }],
    };
    const result = analyzeVSM(config);
    expect(result.pce_pct).toBe(100);
    expect(result.total_lead_time).toBe(5);
  });

  it('should handle all NVA steps', () => {
    const steps = SAMPLE_STEPS.map((s) => ({ ...s, category: 'NVA' as const }));
    const config: VSMConfig = { ...SAMPLE_CONFIG, steps };
    const result = analyzeVSM(config);
    expect(result.pce_pct).toBe(0);
    expect(result.total_nva_time).toBeGreaterThan(0);
  });

  it('should handle steps with zero cycle time', () => {
    const steps: ProcessStep[] = [
      { id: 's1', name: 'Buffer', sequence: 1, cycle_time: 0, changeover_time: 0, uptime_pct: 100, category: 'NVA', operators: 1, wait_time: 60 },
    ];
    const config: VSMConfig = { ...SAMPLE_CONFIG, steps };
    const result = analyzeVSM(config);
    expect(result.total_wait_time).toBe(60);
    expect(result.pce_pct).toBe(0);
  });

  it('should handle no inventory points', () => {
    const config: VSMConfig = { ...SAMPLE_CONFIG, inventory_points: [] };
    const result = analyzeVSM(config);
    expect(result.total_wip_units).toBeGreaterThanOrEqual(0);
  });
});
