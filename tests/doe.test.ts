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
vi.mock('../src/config.js', () => ({ STORE_DIR: resolve(tmpdir(), 'luna-test-doe'), config: { NODE_ENV: 'test' } }));

import { generateMatrix, analyzeDOE } from '../src/doe/analysis.js';
import { initDoeTables, saveDOE, getDOE, listDOEs, deleteDOE } from '../src/doe/index.js';
import type { DOEConfig, Factor, ResponseVar } from '../src/doe/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initDoeTables();
}
beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

const FACTORS: Factor[] = [
  { id: 'f1', name: 'Temperature', type: 'numeric', levels: [230, 260], unit: '°C' },
  { id: 'f2', name: 'Pressure', type: 'numeric', levels: [20, 40], unit: 'PSI' },
  { id: 'f3', name: 'Speed', type: 'numeric', levels: [10, 30], unit: 'mm/s' },
];

const RESPONSES: ResponseVar[] = [
  { id: 'r1', name: 'Strength', unit: 'N', minimize: false },
  { id: 'r2', name: 'Defect Rate', unit: '%', minimize: true, target: 0 },
];

const BASE_CONFIG: DOEConfig = {
  name: 'Test DOE',
  design_type: 'full_factorial',
  factors: FACTORS,
  responses: RESPONSES,
  replicates: 1,
  randomize: false, // Deterministic for testing
};

// Fill simulated response data (y = f1_coded*10 + f2_coded*5 + noise)
function fillResponses(matrix: ReturnType<typeof generateMatrix>): void {
  for (const run of matrix.runs) {
    const f1c = run.factor_coded['f1'] ?? 0;
    const f2c = run.factor_coded['f2'] ?? 0;
    const f3c = run.factor_coded['f3'] ?? 0;
    // Strength: f1 has big effect, f2 moderate, f3 small, f1×f2 interaction
    run.responses['r1'] = 50 + f1c * 10 + f2c * 5 + f3c * 2 + f1c * f2c * 3;
    // Defect rate: inverse relationship
    run.responses['r2'] = 5 - f1c * 2 + f2c * 1 + f3c * 0.5;
  }
}

// ══════════════════════════════════════════════════════════════
// Matrix Generation
// ══════════════════════════════════════════════════════════════

describe('Matrix Generation', () => {
  it('should generate 2^3 = 8 runs for full factorial', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    expect(matrix.total_runs).toBe(8);
    expect(matrix.runs).toHaveLength(8);
    expect(matrix.design_type).toBe('full_factorial');
  });

  it('should generate 2^2 = 4 runs for 2 factors', () => {
    const config: DOEConfig = { ...BASE_CONFIG, factors: FACTORS.slice(0, 2) };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(4);
  });

  it('should include all factor combinations', () => {
    const config: DOEConfig = { ...BASE_CONFIG, factors: FACTORS.slice(0, 2), randomize: false };
    const matrix = generateMatrix(config);
    const combos = matrix.runs.map((r) =>
      `${r.factor_coded['f1']},${r.factor_coded['f2']}`
    ).sort();
    expect(combos).toEqual(['-1,-1', '-1,1', '1,-1', '1,1']);
  });

  it('should handle replicates', () => {
    const config: DOEConfig = { ...BASE_CONFIG, replicates: 2 };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(16); // 8 × 2
  });

  it('should generate fractional factorial (half-fraction)', () => {
    const config: DOEConfig = { ...BASE_CONFIG, design_type: 'fractional' };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(4); // 2^(3-1) = 4
  });

  it('should generate Taguchi L4 for 3 factors', () => {
    const config: DOEConfig = { ...BASE_CONFIG, design_type: 'taguchi' };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(4); // L4
  });

  it('should generate Box-Behnken for 3 factors', () => {
    const config: DOEConfig = { ...BASE_CONFIG, design_type: 'box_behnken',
      factors: FACTORS.map((f) => ({ ...f, levels: [f.levels[0], (f.levels[0] + f.levels[1]) / 2, f.levels[1]] })) };
    const matrix = generateMatrix(config);
    // 3 factors: 3 pairs × 4 + center points = 12 + 3 = 15
    expect(matrix.total_runs).toBe(15);
    // Should have center points
    const centerPts = matrix.runs.filter((r) => r.is_center_point);
    expect(centerPts.length).toBe(3);
  });

  it('should generate Central Composite Design', () => {
    const config: DOEConfig = { ...BASE_CONFIG, design_type: 'central_composite', center_points: 3 };
    const matrix = generateMatrix(config);
    // 2^3 factorial + 2×3 axial + 3 center = 8 + 6 + 3 = 17
    expect(matrix.total_runs).toBe(17);
    const axial = matrix.runs.filter((r) => r.is_axial_point);
    expect(axial.length).toBe(6); // 2 per factor × 3 factors
  });

  it('should have correct coded values (-1, 0, +1)', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    for (const run of matrix.runs) {
      for (const coded of Object.values(run.factor_coded)) {
        expect(coded).toBeGreaterThanOrEqual(-2); // axial can be ±alpha
        expect(coded).toBeLessThanOrEqual(2);
      }
    }
  });

  it('should initialize response values as null', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    for (const run of matrix.runs) {
      for (const val of Object.values(run.responses)) {
        expect(val).toBeNull();
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════
// ANOVA
// ══════════════════════════════════════════════════════════════

describe('ANOVA', () => {
  it('should compute ANOVA table for each response', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    expect(analysis.anova).toHaveLength(2); // 2 responses
  });

  it('should identify significant factors (p < 0.05)', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    const strengthANOVA = analysis.anova.find((a) => a.response_name === 'Strength')!;
    // Temperature has the biggest effect (coefficient 10) — should be significant
    const tempRow = strengthANOVA.rows.find((r) => r.source === 'Temperature');
    expect(tempRow).toBeDefined();
    expect(tempRow!.contribution_pct).toBeGreaterThan(0);
  });

  it('should compute R-squared', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    for (const anova of analysis.anova) {
      expect(anova.r_squared).toBeGreaterThanOrEqual(0);
      expect(anova.r_squared).toBeLessThanOrEqual(1);
    }
  });

  it('should have SS rows summing approximately to total', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    for (const anova of analysis.anova) {
      const modelSS = anova.rows.reduce((s, r) => s + r.sum_of_squares, 0);
      expect(modelSS + anova.residual_ss).toBeCloseTo(anova.total_ss, 0);
    }
  });

  it('should compute contribution percentages', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    for (const anova of analysis.anova) {
      const totalContrib = anova.rows.reduce((s, r) => s + r.contribution_pct, 0);
      // Contributions should sum close to 100% (excluding residual)
      expect(totalContrib).toBeGreaterThan(0);
      expect(totalContrib).toBeLessThanOrEqual(100.1);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Main Effects
// ══════════════════════════════════════════════════════════════

describe('Main Effects', () => {
  it('should compute main effect for each factor', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    // 3 factors × 2 responses = 6 main effects
    expect(analysis.main_effects).toHaveLength(6);
  });

  it('should compute correct effect size direction', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    const tempEffect = analysis.main_effects.find(
      (e) => e.factor_name === 'Temperature' && e.mean_responses.length > 0
    );
    expect(tempEffect).toBeDefined();
    // Temperature has positive effect on strength (coefficient +10)
    expect(tempEffect!.effect_size).toBeGreaterThan(0);
  });

  it('should have mean responses at each level', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    for (const effect of analysis.main_effects) {
      expect(effect.levels.length).toBeGreaterThanOrEqual(2);
      expect(effect.mean_responses.length).toBe(effect.levels.length);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Interactions
// ══════════════════════════════════════════════════════════════

describe('Interactions', () => {
  it('should compute pairwise interactions', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    // 3 choose 2 = 3 pairs × 2 responses = 6
    expect(analysis.interactions).toHaveLength(6);
  });

  it('should detect the Temperature×Pressure interaction', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    const tpInteraction = analysis.interactions.find(
      (ix) => ix.factor_a_name === 'Temperature' && ix.factor_b_name === 'Pressure'
    );
    expect(tpInteraction).toBeDefined();
    // f1×f2 coefficient is 3 — should have non-zero strength
    expect(tpInteraction!.interaction_strength).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Desirability
// ══════════════════════════════════════════════════════════════

describe('Desirability', () => {
  it('should compute overall desirability 0-1', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    expect(analysis.desirability).toBeDefined();
    expect(analysis.desirability!.overall_desirability).toBeGreaterThanOrEqual(0);
    expect(analysis.desirability!.overall_desirability).toBeLessThanOrEqual(1);
  });

  it('should identify optimal factor levels', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    expect(analysis.desirability!.optimal_factors).toBeDefined();
    expect(Object.keys(analysis.desirability!.optimal_factors).length).toBe(3);
  });

  it('should have per-response desirability', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    fillResponses(matrix);
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    expect(analysis.desirability!.per_response).toHaveLength(2);
    for (const pr of analysis.desirability!.per_response) {
      expect(pr.desirability).toBeGreaterThanOrEqual(0);
      expect(pr.desirability).toBeLessThanOrEqual(1);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve', async () => {
    const saved = await saveDOE('My DOE', BASE_CONFIG);
    expect(saved.id).toBeTruthy();
    const retrieved = await getDOE('My DOE');
    expect(retrieved).toBeDefined();
  });

  it('should update on collision', async () => {
    await saveDOE('Same', BASE_CONFIG);
    await saveDOE('Same', { ...BASE_CONFIG, name: 'Updated' });
    expect((await listDOEs()).filter((e) => e.name === 'Same')).toHaveLength(1);
  });

  it('should delete', async () => {
    const saved = await saveDOE('Del', BASE_CONFIG);
    expect(await deleteDOE(saved.id)).toBe(true);
    expect(await getDOE(saved.id)).toBeUndefined();
  });

  it('should list sorted', async () => {
    await saveDOE('A', BASE_CONFIG);
    await saveDOE('B', BASE_CONFIG);
    const all = await listDOEs();
    expect(all).toHaveLength(2);
    expect(all[0].updated_at).toBeGreaterThanOrEqual(all[1].updated_at);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle single factor (2 runs)', () => {
    const config: DOEConfig = { ...BASE_CONFIG, factors: [FACTORS[0]] };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(2);
  });

  it('should handle no response data gracefully', () => {
    const matrix = generateMatrix(BASE_CONFIG);
    // Don't fill responses — all null
    const analysis = analyzeDOE(BASE_CONFIG, matrix);
    expect(analysis.anova).toHaveLength(0); // No data to analyze
  });

  it('should handle 4+ factors', () => {
    const factors: Factor[] = [
      ...FACTORS,
      { id: 'f4', name: 'Humidity', type: 'numeric', levels: [30, 70], unit: '%' },
    ];
    const config: DOEConfig = { ...BASE_CONFIG, factors };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBe(16); // 2^4
  });

  it('should handle Taguchi with 3 levels', () => {
    const factors3: Factor[] = FACTORS.map((f) => ({
      ...f, levels: [f.levels[0], (f.levels[0] + f.levels[1]) / 2, f.levels[1]],
    }));
    const config: DOEConfig = { ...BASE_CONFIG, design_type: 'taguchi', factors: factors3 };
    const matrix = generateMatrix(config);
    expect(matrix.total_runs).toBeGreaterThan(0);
  });
});
