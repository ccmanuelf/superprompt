import { describe, it, expect } from 'vitest';
import {
  calculateDoeMatrix,
  calculateDoeAnalysis,
} from '../src/calculations/doe.js';
import type { DOEConfig } from '../src/doe/models.js';

const FF_CONFIG: DOEConfig = {
  name: '2^3 Test',
  design_type: 'full_factorial',
  factors: [
    { id: 'A', name: 'Temp', type: 'numeric', levels: [180, 220] },
    { id: 'B', name: 'Time', type: 'numeric', levels: [30, 60] },
    { id: 'C', name: 'Pressure', type: 'numeric', levels: [10, 20] },
  ],
  responses: [
    { id: 'Y', name: 'Strength', minimize: false },
  ],
};

describe('calculateDoeMatrix', () => {
  it('generates 2^3 full factorial = 8 runs', () => {
    const result = calculateDoeMatrix(FF_CONFIG, {}, 'standard');
    expect(result.value.total_runs).toBe(8);
    expect(result.value.runs).toHaveLength(8);
    expect(result.value.factors).toHaveLength(3);
    expect(result.value.responses).toHaveLength(1);
  });

  it('site-adjusted with no overrides equals standard run count (Phase 1)', () => {
    const standard = calculateDoeMatrix(FF_CONFIG, {}, 'standard');
    const adjusted = calculateDoeMatrix(FF_CONFIG, {}, 'site_adjusted');
    expect(adjusted.value.total_runs).toBe(standard.value.total_runs);
    expect(adjusted.value.design_type).toBe(standard.value.design_type);
  });

  it('records inputsUsed envelope', () => {
    const result = calculateDoeMatrix(FF_CONFIG, {}, 'site_adjusted');
    expect(result.inputsUsed.designType).toBe('full_factorial');
    expect(result.inputsUsed.factorCount).toBe(3);
    expect(result.inputsUsed.responseCount).toBe(1);
    expect(result.inputsUsed.replicates).toBe(1);
    expect(result.assumptionsApplied).toEqual([]);
  });
});

describe('calculateDoeAnalysis', () => {
  function buildFilledMatrix() {
    const matrixResult = calculateDoeMatrix(FF_CONFIG, {}, 'standard');
    const matrix = matrixResult.value;
    // Fill in synthetic responses correlated with factor A (Temp)
    for (const run of matrix.runs) {
      run.responses['Y'] = 50 + 10 * run.factor_coded['A'] + 2 * run.factor_coded['B'];
    }
    return matrix;
  }

  it('produces ANOVA + main effects when responses filled in', () => {
    const matrix = buildFilledMatrix();
    const result = calculateDoeAnalysis({ config: FF_CONFIG, matrix }, {}, 'standard');
    expect(result.value.anova.length).toBeGreaterThan(0);
    expect(result.value.main_effects.length).toBeGreaterThan(0);
  });

  it('site-adjusted with no overrides equals standard analysis', () => {
    const matrix = buildFilledMatrix();
    const standard = calculateDoeAnalysis(
      { config: FF_CONFIG, matrix },
      {},
      'standard',
    );
    const adjusted = calculateDoeAnalysis(
      { config: FF_CONFIG, matrix },
      {},
      'site_adjusted',
    );
    expect(adjusted.value.main_effects[0].effect_size).toBe(
      standard.value.main_effects[0].effect_size,
    );
  });

  it('records inputsUsed envelope including runs analyzed', () => {
    const matrix = buildFilledMatrix();
    const result = calculateDoeAnalysis(
      { config: FF_CONFIG, matrix },
      {},
      'site_adjusted',
    );
    expect(result.inputsUsed.runsAnalyzed).toBe(8);
    expect(result.inputsUsed.factorCount).toBe(3);
    expect(result.assumptionsApplied).toEqual([]);
  });
});
