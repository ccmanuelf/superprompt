/**
 * CONWIP & Heijunka metrics — dual-view wrappers.
 * Delegates to pure functions in src/conwip/.
 *
 * Two primary metrics:
 *   - calculateConwipMetrics    → CONWIP token flow + stage utilization
 *   - calculateHeijunkaMetrics  → Heijunka leveling box + leveling score
 */

import { analyzeCONWIP, analyzeHeijunka } from '../conwip/analysis.js';
import type {
  CONWIPConfig,
  CONWIPAnalysis,
  HeijunkaConfig,
  HeijunkaAnalysis,
} from '../conwip/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export type ConwipMetricInputs = CONWIPConfig;

export function calculateConwipMetrics(
  inputs: ConwipMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<CONWIPAnalysis> {
  const value = analyzeCONWIP(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.name,
      stageCount: inputs.stages.length,
      productCount: inputs.products.length,
      wipLimit: inputs.wip_limit,
      demandPerDay: inputs.demand_per_day,
      availableMinutesPerDay: inputs.available_minutes_per_day,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}

export type HeijunkaMetricInputs = HeijunkaConfig;

export function calculateHeijunkaMetrics(
  inputs: HeijunkaMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<HeijunkaAnalysis> {
  const value = analyzeHeijunka(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.name,
      productCount: inputs.products.length,
      taktTimeMinutes: inputs.takt_time_minutes,
      pitchMinutes: inputs.pitch_minutes,
      packOutQuantity: inputs.pack_out_quantity,
      slotsPerShift: inputs.slots_per_shift,
      shiftsPerDay: inputs.shifts_per_day,
      demandPerDay: inputs.demand_per_day,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
