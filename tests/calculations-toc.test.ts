import { describe, it, expect } from 'vitest';
import { calculateTocMetrics } from '../src/calculations/toc.js';
import type { TOCConfig } from '../src/toc/models.js';

const SAMPLE_CONFIG: TOCConfig = {
  name: 'Sample Plant',
  work_centers: [
    {
      id: 'WC1',
      name: 'Cutting',
      capacity_units_per_hour: 10,
      available_hours_per_day: 8,
      operators: 1,
      current_wip: 0,
    },
    {
      id: 'WC2',
      name: 'Assembly',
      capacity_units_per_hour: 6,
      available_hours_per_day: 8,
      operators: 1,
      current_wip: 0,
    },
    {
      id: 'WC3',
      name: 'Packaging',
      capacity_units_per_hour: 12,
      available_hours_per_day: 8,
      operators: 1,
      current_wip: 0,
    },
  ],
  selling_price_per_unit: 100,
  total_variable_cost_per_unit: 40,
  operating_expense_per_period: 80000,
  investment: 500000,
  demand_units_per_day: 50,
  available_hours_per_day: 8,
};

describe('calculateTocMetrics', () => {
  it('identifies the constraint (lowest-capacity work center)', () => {
    const result = calculateTocMetrics(SAMPLE_CONFIG, {}, 'standard');
    // Assembly has 6 units/hr → lowest → should be CCR
    expect(result.value.constraint.ccr_name).toBe('Assembly');
    expect(result.value.constraint.ccr_id).toBe('WC2');
  });

  it('throughput accounting computes T = Price - TVC per unit', () => {
    const result = calculateTocMetrics(SAMPLE_CONFIG, {}, 'standard');
    expect(result.value.throughput.throughput_per_unit).toBeCloseTo(60, 2);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateTocMetrics(SAMPLE_CONFIG, {}, 'standard');
    const adjusted = calculateTocMetrics(SAMPLE_CONFIG, {}, 'site_adjusted');
    expect(adjusted.value.constraint.ccr_id).toBe(standard.value.constraint.ccr_id);
    expect(adjusted.value.throughput.net_profit).toBe(
      standard.value.throughput.net_profit,
    );
  });

  it('records inputsUsed envelope and empty assumptions', () => {
    const result = calculateTocMetrics(SAMPLE_CONFIG, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.configName).toBe('Sample Plant');
    expect(result.inputsUsed.workCenterCount).toBe(3);
    expect(result.inputsUsed.demandUnitsPerDay).toBe(50);
    expect(result.inputsUsed.sellingPricePerUnit).toBe(100);
    expect(result.inputsUsed.tvcPerUnit).toBe(40);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
