import { describe, it, expect } from 'vitest';
import { calculateInventoryMetrics } from '../src/calculations/inventory.js';

describe('calculateInventoryMetrics', () => {
  const inputs = {
    annualDemand: 10000,
    orderCost: 50,
    holdingCostPerUnit: 2,
    dailyDemand: 10000 / 365,
    leadTimeDays: 7,
    serviceLevel: 0.95,
    demandStddev: 5,
  };

  it('produces textbook EOQ in standard mode (sqrt(2DS/H))', () => {
    const result = calculateInventoryMetrics(inputs, {}, 'standard');
    // EOQ = sqrt(2 * 10000 * 50 / 2) = sqrt(500000) ≈ 707.107
    expect(result.value.eoq).toBeCloseTo(707.107, 2);
  });

  it('safety stock is positive given lead time and service level > 0.5', () => {
    const result = calculateInventoryMetrics(inputs, {}, 'standard');
    expect(result.value.safetyStock).toBeGreaterThan(0);
  });

  it('reorder point = daily_demand × lead_time + safety_stock', () => {
    const result = calculateInventoryMetrics(inputs, {}, 'standard');
    const expected = inputs.dailyDemand * inputs.leadTimeDays + result.value.safetyStock;
    expect(result.value.reorderPoint).toBeCloseTo(expected, 4);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateInventoryMetrics(inputs, {}, 'standard');
    const adjusted = calculateInventoryMetrics(inputs, {}, 'site_adjusted');
    expect(adjusted.value.eoq).toBe(standard.value.eoq);
    expect(adjusted.value.safetyStock).toBe(standard.value.safetyStock);
    expect(adjusted.value.reorderPoint).toBe(standard.value.reorderPoint);
  });

  it('records mode, inputsUsed, computedAt envelope and empty assumptions', () => {
    const result = calculateInventoryMetrics(inputs, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.serviceLevel).toBe(0.95);
    expect(result.inputsUsed.leadTimeDays).toBe(7);
    expect(result.inputsUsed.demandStddev).toBe(5);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('demandStddev omitted is recorded as null in inputsUsed', () => {
    const result = calculateInventoryMetrics(
      { ...inputs, demandStddev: undefined },
      {},
      'standard',
    );
    expect(result.inputsUsed.demandStddev).toBeNull();
    expect(result.value.safetyStock).toBeGreaterThan(0);
  });
});
