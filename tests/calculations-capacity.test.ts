import { describe, it, expect } from 'vitest';
import {
  calculateCapacityMetrics,
  calculateRoiMetrics,
} from '../src/calculations/capacity.js';
import type { CapacityPlanConfig, ROIInput } from '../src/capacity/models.js';

describe('calculateCapacityMetrics', () => {
  const config: CapacityPlanConfig = {
    name: 'Test Plan',
    period_label: 'Week 13',
    period_start: '2026-03-23',
    period_end: '2026-03-29',
    calendar: { working_days: 5, shifts_per_day: 1, hours_per_shift: 8 },
    lines: [
      {
        id: 'L1',
        code: 'LINE-1',
        name: 'Line 1',
        max_operators: 5,
        efficiency_factor: 0.85,
        absenteeism_factor: 0.05,
      },
    ],
    demands: [
      { product: 'A', line_id: 'L1', quantity: 100, hours: 100 },
    ],
  };

  it('returns analysis result with correct line count', () => {
    const result = calculateCapacityMetrics(config, {}, 'standard');
    expect(result.value.lines_analyzed).toBe(1);
    expect(result.value.lines).toHaveLength(1);
  });

  it('site-adjusted with no overrides equals standard (Phase 1)', () => {
    const standard = calculateCapacityMetrics(config, {}, 'standard');
    const adjusted = calculateCapacityMetrics(config, {}, 'site_adjusted');
    expect(adjusted.value.overall_utilization_pct).toBe(
      standard.value.overall_utilization_pct,
    );
    expect(adjusted.value.bottleneck_count).toBe(standard.value.bottleneck_count);
  });

  it('records inputsUsed envelope and empty assumptions', () => {
    const result = calculateCapacityMetrics(config, {}, 'site_adjusted');
    expect(result.mode).toBe('site_adjusted');
    expect(result.inputsUsed.planName).toBe('Test Plan');
    expect(result.inputsUsed.lineCount).toBe(1);
    expect(result.inputsUsed.demandCount).toBe(1);
    expect(result.inputsUsed.workingDays).toBe(5);
    expect(result.assumptionsApplied).toEqual([]);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('calculateRoiMetrics', () => {
  const input: ROIInput = {
    scenario_name: 'Add Line',
    investment_cost: 100000,
    monthly_operating_cost: 5000,
    capacity_gain_hours: 200,
    revenue_per_unit: 10,
    units_per_hour: 50,
  };

  it('produces NPV, payback, and ROI in standard mode', () => {
    const result = calculateRoiMetrics(input, {}, 'standard');
    expect(result.value.scenario_name).toBe('Add Line');
    expect(result.value.payback_months).toBeGreaterThan(0);
    expect(typeof result.value.npv).toBe('number');
    expect(typeof result.value.roi_pct).toBe('number');
  });

  it('site-adjusted with no overrides equals standard', () => {
    const standard = calculateRoiMetrics(input, {}, 'standard');
    const adjusted = calculateRoiMetrics(input, {}, 'site_adjusted');
    expect(adjusted.value.payback_months).toBe(standard.value.payback_months);
    expect(adjusted.value.npv).toBe(standard.value.npv);
    expect(adjusted.value.roi_pct).toBe(standard.value.roi_pct);
  });

  it('records inputsUsed envelope including optional fields', () => {
    const result = calculateRoiMetrics(input, {}, 'site_adjusted');
    expect(result.inputsUsed.scenarioName).toBe('Add Line');
    expect(result.inputsUsed.investmentCost).toBe(100000);
    expect(result.inputsUsed.capacityGainHours).toBe(200);
    expect(result.inputsUsed.revenuePerUnit).toBe(10);
    expect(result.inputsUsed.analysisMonths).toBeNull();
    expect(result.assumptionsApplied).toEqual([]);
  });

  it('omitted optional inputs surface as null in inputsUsed', () => {
    const sparse: ROIInput = {
      scenario_name: 'Sparse',
      investment_cost: 50000,
      capacity_gain_hours: 100,
    };
    const result = calculateRoiMetrics(sparse, {}, 'standard');
    expect(result.inputsUsed.monthlyOperatingCost).toBeNull();
    expect(result.inputsUsed.revenuePerUnit).toBeNull();
    expect(result.inputsUsed.discountRate).toBeNull();
  });
});
