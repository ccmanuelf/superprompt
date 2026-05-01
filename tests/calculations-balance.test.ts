import { describe, it, expect } from 'vitest';
import { calculateBalanceMetrics } from '../src/calculations/balance.js';

describe('calculateBalanceMetrics', () => {
  const inputs = {
    totalTaskTime: 200,
    numStations: 3,
    taktTime: 80,
    stationTimes: [70, 65, 65],
  };

  it('produces textbook efficiency in standard mode', () => {
    const result = calculateBalanceMetrics(inputs, {}, 'standard');
    expect(result.value.efficiency).toBeCloseTo(83.333, 2);
    expect(result.mode).toBe('standard');
  });

  it('produces textbook smoothness index in standard mode', () => {
    const result = calculateBalanceMetrics(inputs, {}, 'standard');
    expect(result.value.smoothness).toBeCloseTo(Math.sqrt(50 / 3), 4);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateBalanceMetrics(inputs, {}, 'standard');
    const adjusted = calculateBalanceMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.efficiency).toBe(standard.value.efficiency);
    expect(adjusted.value.smoothness).toBe(standard.value.smoothness);
  });

  it('records mode, inputsUsed, computedAt envelope and empty assumptions', () => {
    const result = calculateBalanceMetrics(inputs, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.numStations).toBe(3);
    expect(result.inputsUsed.taktTime).toBe(80);
    expect(result.inputsUsed.stationCount).toBe(3);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles degenerate input (zero stations) without throwing', () => {
    const result = calculateBalanceMetrics(
      { totalTaskTime: 0, numStations: 0, taktTime: 0, stationTimes: [] },
      {},
      'standard',
    );
    expect(result.value.efficiency).toBe(0);
    expect(result.value.smoothness).toBe(0);
  });
});
