/**
 * Line-balancing metric calculation — dual-view wrapper.
 * Delegates to pure functions in src/balance.ts.
 */

import { calculateEfficiency, calculateSmoothness } from '../balance.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface BalanceMetricInputs {
  totalTaskTime: number;
  numStations: number;
  taktTime: number;
  stationTimes: number[];
}

export interface BalanceMetrics {
  efficiency: number;
  smoothness: number;
}

export function calculateBalanceMetrics(
  inputs: BalanceMetricInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<BalanceMetrics> {
  const efficiency = calculateEfficiency(
    inputs.totalTaskTime,
    inputs.numStations,
    inputs.taktTime,
  );
  const smoothness = calculateSmoothness(inputs.stationTimes);

  return {
    value: { efficiency, smoothness },
    mode,
    inputsUsed: {
      totalTaskTime: inputs.totalTaskTime,
      numStations: inputs.numStations,
      taktTime: inputs.taktTime,
      stationCount: inputs.stationTimes.length,
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}
