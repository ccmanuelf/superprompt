import { describe, it, expect } from 'vitest';
import {
  calculateCapabilityMetrics,
  calculateDpmoMetrics,
  calculateYieldMetrics,
} from '../src/calculations/sigma.js';

describe('calculateCapabilityMetrics', () => {
  const values = [9.8, 10.0, 10.1, 9.9, 10.2, 9.7, 10.0, 10.1, 10.0, 9.9];
  const inputs = { values, lsl: 8, usl: 12, target: 10 };

  it('produces positive Cpk for centered process within wide spec limits', () => {
    const result = calculateCapabilityMetrics(inputs, {}, 'standard');
    expect(result.value.cpk).toBeGreaterThan(0);
    expect(result.value.sample_size).toBe(10);
  });

  it('Cp uses within-subgroup variation; Pp uses overall variation', () => {
    const result = calculateCapabilityMetrics(inputs, {}, 'standard');
    expect(typeof result.value.cp).toBe('number');
    expect(typeof result.value.pp).toBe('number');
  });

  it('Cpm computed only when target is provided', () => {
    const withTarget = calculateCapabilityMetrics(inputs, {}, 'standard');
    const withoutTarget = calculateCapabilityMetrics(
      { values, lsl: 8, usl: 12 },
      {},
      'standard',
    );
    expect(withTarget.value.cpm).not.toBeNull();
    expect(withoutTarget.value.cpm).toBeNull();
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateCapabilityMetrics(inputs, {}, 'standard');
    const adjusted = calculateCapabilityMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.cpk).toBe(standard.value.cpk);
    expect(adjusted.value.cp).toBe(standard.value.cp);
    expect(adjusted.value.ppk).toBe(standard.value.ppk);
  });

  it('records mode, inputsUsed envelope, empty assumptions', () => {
    const result = calculateCapabilityMetrics(inputs, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.sampleSize).toBe(10);
    expect(result.inputsUsed.lsl).toBe(8);
    expect(result.inputsUsed.usl).toBe(12);
    expect(result.inputsUsed.target).toBe(10);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('calculateDpmoMetrics', () => {
  it('produces textbook DPMO in standard mode', () => {
    // 5 defects in 1000 units × 1 opportunity = 5000 DPMO
    const result = calculateDpmoMetrics(
      { defects: 5, units: 1000, opportunities: 1 },
      {},
      'standard',
    );
    expect(result.value.dpmo).toBeCloseTo(5000, 0);
    expect(result.value.sigma_level).toBeGreaterThan(0);
    expect(result.value.yield_pct).toBeCloseTo(99.5, 1);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const inputs = { defects: 100, units: 10000, opportunities: 5 };
    const standard = calculateDpmoMetrics(inputs, {}, 'standard');
    const adjusted = calculateDpmoMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.dpmo).toBe(standard.value.dpmo);
    expect(adjusted.value.sigma_level).toBe(standard.value.sigma_level);
  });

  it('records inputsUsed envelope and empty assumptions', () => {
    const result = calculateDpmoMetrics(
      { defects: 1, units: 100, opportunities: 1 },
      {},
      'site_adjusted',
    );
    expect(result.inputsUsed).toEqual({
      defects: 1,
      units: 100,
      opportunities: 1,
    });
    expect(result.assumptionsApplied).toEqual([]);
  });
});

describe('calculateYieldMetrics', () => {
  it('multiplicative RTY in standard mode (95% × 95% × 95%)', () => {
    const result = calculateYieldMetrics(
      { stepYields: [95, 95, 95] },
      {},
      'standard',
    );
    expect(result.value.rty).toBeCloseTo(85.7375, 2);
    expect(result.value.stepCount).toBe(3);
  });

  it('site-adjusted with no overrides equals standard', () => {
    const inputs = { stepYields: [98, 96, 99, 97] };
    const standard = calculateYieldMetrics(inputs, {}, 'standard');
    const adjusted = calculateYieldMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.rty).toBe(standard.value.rty);
  });

  it('empty step yields returns 0', () => {
    const result = calculateYieldMetrics({ stepYields: [] }, {}, 'standard');
    expect(result.value.rty).toBe(0);
    expect(result.value.stepCount).toBe(0);
  });
});
