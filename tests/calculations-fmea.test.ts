import { describe, it, expect } from 'vitest';
import { calculateFmeaMetrics } from '../src/calculations/fmea.js';

describe('calculateFmeaMetrics', () => {
  it('multiplicative RPN in standard mode', () => {
    const result = calculateFmeaMetrics(
      { severity: 8, occurrence: 5, detection: 6 },
      {},
      'standard',
    );
    expect(result.value.rpn).toBe(240);
  });

  it('AIAG-VDA Action Priority — High when RPN ≥ 200', () => {
    const result = calculateFmeaMetrics(
      { severity: 8, occurrence: 5, detection: 6 },
      {},
      'standard',
    );
    expect(result.value.actionPriority).toBe('H');
  });

  it('AIAG-VDA Action Priority — High when severity ≥ 9', () => {
    const result = calculateFmeaMetrics(
      { severity: 9, occurrence: 1, detection: 1 },
      {},
      'standard',
    );
    expect(result.value.actionPriority).toBe('H');
  });

  it('AIAG-VDA Action Priority — Low for benign combinations', () => {
    const result = calculateFmeaMetrics(
      { severity: 2, occurrence: 3, detection: 4 },
      {},
      'standard',
    );
    expect(result.value.actionPriority).toBe('L');
    expect(result.value.rpn).toBe(24);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const inputs = { severity: 7, occurrence: 4, detection: 5 };
    const standard = calculateFmeaMetrics(inputs, {}, 'standard');
    const adjusted = calculateFmeaMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.rpn).toBe(standard.value.rpn);
    expect(adjusted.value.actionPriority).toBe(standard.value.actionPriority);
  });

  it('records mode, inputsUsed, computedAt envelope and empty assumptions', () => {
    const result = calculateFmeaMetrics(
      { severity: 5, occurrence: 5, detection: 5 },
      {},
      'site_adjusted',
    );
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed).toEqual({ severity: 5, occurrence: 5, detection: 5 });
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
