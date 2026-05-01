/**
 * Capacity planning metrics — dual-view wrappers.
 * Delegates to pure functions in src/capacity/.
 *
 * Two primary metrics in this module:
 *   - calculateCapacityMetrics  → 12-step line capacity analysis
 *   - calculateRoiMetrics       → investment ROI / NPV / payback
 *
 * Note: internal compositions inside src/capacity/ (scenarios.ts, monte-carlo.ts)
 * call the underlying functions directly to avoid wrapper overhead in hot loops
 * (Monte Carlo runs analyzeCapacity per replication, default 1000 reps).
 * The wrappers are the boundary for external consumers (web/api, tools/provider).
 */

import { analyzeCapacity } from '../capacity/analysis.js';
import { calculateROI } from '../capacity/roi.js';
import type {
  CapacityPlanConfig,
  CapacityAnalysisResult,
  ROIInput,
  ROIResult,
} from '../capacity/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export type CapacityMetricInputs = CapacityPlanConfig;

export function calculateCapacityMetrics(
  inputs: CapacityMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<CapacityAnalysisResult> {
  const value = analyzeCapacity(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      planName: inputs.name,
      periodLabel: inputs.period_label,
      lineCount: inputs.lines.length,
      demandCount: inputs.demands.length,
      workingDays: inputs.calendar.working_days,
      shiftsPerDay: inputs.calendar.shifts_per_day,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}

export type RoiMetricInputs = ROIInput;

export function calculateRoiMetrics(
  inputs: RoiMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<ROIResult> {
  const value = calculateROI(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      scenarioName: inputs.scenario_name,
      investmentCost: inputs.investment_cost,
      capacityGainHours: inputs.capacity_gain_hours,
      monthlyOperatingCost: inputs.monthly_operating_cost ?? null,
      revenuePerUnit: inputs.revenue_per_unit ?? null,
      analysisMonths: inputs.analysis_months ?? null,
      discountRate: inputs.discount_rate ?? null,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
