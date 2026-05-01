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
  // Active hooks: when caller omits discount_rate / analysis_months and the
  // assumption bag carries resolved roi_default_* values, use them. Caller-
  // provided values still win. Standard mode passes empty assumptions so
  // calculateROI falls back to its own DEFAULT_DISCOUNT_RATE / DEFAULT_ANALYSIS_MONTHS.
  const assumedDiscountRate = assumptions['roi_default_discount_rate']?.value;
  const assumedHorizon = assumptions['roi_default_horizon_months']?.value;
  const effectiveInputs: ROIInput = {
    ...inputs,
    discount_rate:
      inputs.discount_rate ??
      (typeof assumedDiscountRate === 'number' && Number.isFinite(assumedDiscountRate)
        ? assumedDiscountRate
        : undefined),
    analysis_months:
      inputs.analysis_months ??
      (typeof assumedHorizon === 'number' && Number.isFinite(assumedHorizon)
        ? assumedHorizon
        : undefined),
  };

  const value = calculateROI(effectiveInputs);

  return {
    value,
    mode,
    inputsUsed: {
      scenarioName: inputs.scenario_name,
      investmentCost: inputs.investment_cost,
      capacityGainHours: inputs.capacity_gain_hours,
      monthlyOperatingCost: inputs.monthly_operating_cost ?? null,
      revenuePerUnit: inputs.revenue_per_unit ?? null,
      analysisMonths: effectiveInputs.analysis_months ?? null,
      discountRate: effectiveInputs.discount_rate ?? null,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
