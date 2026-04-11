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
vi.mock('../src/config.js', () => ({ STORE_DIR: resolve(tmpdir(), 'clauded-test-conwip'), config: { NODE_ENV: 'test' } }));

import { analyzeCONWIP, analyzeHeijunka } from '../src/conwip/analysis.js';
import { initConwipTables, saveConwip, getConwip, listConwips, deleteConwip } from '../src/conwip/index.js';
import type { CONWIPConfig, HeijunkaConfig, ProductionStage, ProductType } from '../src/conwip/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initConwipTables();
}
beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const STAGES: ProductionStage[] = [
  { id: 's1', name: 'Cut', sequence: 1, cycle_time_minutes: 1.5, capacity_per_hour: 40 },
  { id: 's2', name: 'Form', sequence: 2, cycle_time_minutes: 2.5, capacity_per_hour: 24 },
  { id: 's3', name: 'Weld', sequence: 3, cycle_time_minutes: 4.0, capacity_per_hour: 15 },
  { id: 's4', name: 'Paint', sequence: 4, cycle_time_minutes: 3.0, capacity_per_hour: 20 },
  { id: 's5', name: 'QC', sequence: 5, cycle_time_minutes: 1.0, capacity_per_hour: 60 },
];

const PRODUCTS: ProductType[] = [
  { id: 'p1', name: 'Widget A', mix_pct: 50, cycle_time_minutes: 3, changeover_minutes: 10 },
  { id: 'p2', name: 'Widget B', mix_pct: 30, cycle_time_minutes: 4, changeover_minutes: 15 },
  { id: 'p3', name: 'Widget C', mix_pct: 20, cycle_time_minutes: 2.5, changeover_minutes: 8 },
];

const CW_CONFIG: CONWIPConfig = {
  name: 'Test CONWIP',
  stages: STAGES,
  wip_limit: 15,
  products: PRODUCTS,
  available_minutes_per_day: 460,
  demand_per_day: 200,
};

const HJ_CONFIG: HeijunkaConfig = {
  name: 'Test Heijunka',
  products: PRODUCTS,
  takt_time_minutes: 4.6,
  pitch_minutes: 46,
  pack_out_quantity: 10,
  slots_per_shift: 8,
  shifts_per_day: 1,
  demand_per_day: 200,
};

// ══════════════════════════════════════════════════════════════
// CONWIP
// ══════════════════════════════════════════════════════════════

describe('CONWIP Analysis', () => {
  it('should distribute tokens across stages', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    expect(result.tokens.length).toBeLessThanOrEqual(CW_CONFIG.wip_limit);
    expect(result.tokens.length).toBeGreaterThan(0);
  });

  it('should identify bottleneck stage', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    const bottleneck = result.stage_utilization.find((s) => s.is_bottleneck);
    expect(bottleneck).toBeDefined();
    // Weld has lowest capacity (15 u/hr) so highest utilization
    expect(bottleneck!.stage_name).toBe('Weld');
  });

  it('should compute throughput limited by bottleneck', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    expect(result.throughput_per_hour).toBeGreaterThan(0);
    expect(result.throughput_per_hour).toBeLessThanOrEqual(60); // Max of any stage
  });

  it('should compute average cycle time', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    // Sum of all stage CTs: 1.5 + 2.5 + 4 + 3 + 1 = 12
    expect(result.avg_cycle_time).toBe(12);
  });

  it('should compute WIP turns per day', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    expect(result.wip_turns_per_day).toBeGreaterThan(0);
  });

  it('should generate recommendations', () => {
    const result = analyzeCONWIP(CW_CONFIG);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('should handle single stage', () => {
    const config: CONWIPConfig = { ...CW_CONFIG, stages: [STAGES[0]], wip_limit: 5 };
    const result = analyzeCONWIP(config);
    expect(result.stage_utilization).toHaveLength(1);
    expect(result.tokens.length).toBeLessThanOrEqual(5);
  });
});

// ══════════════════════════════════════════════════════════════
// Heijunka
// ══════════════════════════════════════════════════════════════

describe('Heijunka Analysis', () => {
  it('should build heijunka box with correct dimensions', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.heijunka_box.products).toHaveLength(3);
    expect(result.heijunka_box.slots).toHaveLength(8); // 8 slots × 1 shift
    expect(result.heijunka_box.cells).toHaveLength(8);
  });

  it('should calculate pitch = takt × pack-out', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.pitch).toBe(46); // 4.6 × 10
  });

  it('should compute leveling score 0-100', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.leveling_score).toBeGreaterThanOrEqual(0);
    expect(result.leveling_score).toBeLessThanOrEqual(100);
  });

  it('should compute product mix deviation', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.actual_mix).toHaveLength(3);
    for (const m of result.actual_mix) {
      expect(m.target_pct).toBeGreaterThanOrEqual(0);
      expect(m.actual_pct).toBeGreaterThanOrEqual(0);
    }
  });

  it('should count changeovers', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.changeover_count).toBeGreaterThanOrEqual(0);
  });

  it('should generate shift plans', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.shift_plans).toHaveLength(1);
    expect(result.shift_plans[0].total_quantity).toBeGreaterThan(0);
  });

  it('should generate changeover suggestions', () => {
    const result = analyzeHeijunka(HJ_CONFIG);
    expect(result.changeover_suggestions.length).toBeGreaterThan(0);
  });

  it('should handle multi-shift', () => {
    const config: HeijunkaConfig = { ...HJ_CONFIG, shifts_per_day: 3 };
    const result = analyzeHeijunka(config);
    expect(result.heijunka_box.slots).toHaveLength(24); // 8 × 3
    expect(result.shift_plans).toHaveLength(3);
  });

  it('should handle single product (100% mix)', () => {
    const config: HeijunkaConfig = {
      ...HJ_CONFIG,
      products: [{ id: 'p1', name: 'Only', mix_pct: 100, cycle_time_minutes: 3, changeover_minutes: 0 }],
    };
    const result = analyzeHeijunka(config);
    expect(result.leveling_score).toBe(100); // Perfect leveling with 1 product
    expect(result.changeover_count).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve', async () => {
    const saved = await saveConwip('My Config', CW_CONFIG);
    expect(saved.id).toBeTruthy();
    const retrieved = await getConwip('My Config');
    expect(retrieved).toBeDefined();
  });

  it('should update on name collision', async () => {
    await saveConwip('Same', CW_CONFIG);
    await saveConwip('Same', HJ_CONFIG);
    expect((await listConwips()).filter((c) => c.name === 'Same')).toHaveLength(1);
  });

  it('should delete', async () => {
    const saved = await saveConwip('Del', CW_CONFIG);
    expect(await deleteConwip(saved.id)).toBe(true);
    expect(await getConwip(saved.id)).toBeUndefined();
  });

  it('should list sorted', async () => {
    await saveConwip('A', CW_CONFIG);
    await saveConwip('B', HJ_CONFIG);
    const all = await listConwips();
    expect(all).toHaveLength(2);
    expect(all[0].updated_at).toBeGreaterThanOrEqual(all[1].updated_at);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle zero WIP limit', () => {
    const config: CONWIPConfig = { ...CW_CONFIG, wip_limit: 0 };
    const result = analyzeCONWIP(config);
    expect(result.tokens).toHaveLength(0);
  });

  it('should handle zero demand', () => {
    const config: CONWIPConfig = { ...CW_CONFIG, demand_per_day: 0 };
    const result = analyzeCONWIP(config);
    expect(result.stage_utilization.every((s) => s.utilization_pct === 0)).toBe(true);
  });

  it('should handle equal mix products', () => {
    const products: ProductType[] = [
      { id: 'a', name: 'A', mix_pct: 50, cycle_time_minutes: 3, changeover_minutes: 5 },
      { id: 'b', name: 'B', mix_pct: 50, cycle_time_minutes: 3, changeover_minutes: 5 },
    ];
    const config: HeijunkaConfig = { ...HJ_CONFIG, products };
    const result = analyzeHeijunka(config);
    // Both should be close to 50%
    for (const m of result.actual_mix) {
      expect(Math.abs(m.deviation_pct)).toBeLessThan(15);
    }
  });
});
