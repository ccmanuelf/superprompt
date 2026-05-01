/**
 * FMEA RPN + Action Priority calculation — dual-view wrapper.
 * Delegates to pure functions in src/fmea.ts.
 */

import { calculateActionPriority } from '../fmea.js';
import type { ActionPriority } from '../fmea.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface FmeaMetricInputs {
  severity: number;
  occurrence: number;
  detection: number;
}

export interface FmeaMetrics {
  rpn: number;
  actionPriority: ActionPriority;
}

export function calculateFmeaMetrics(
  inputs: FmeaMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<FmeaMetrics> {
  const rpn = inputs.severity * inputs.occurrence * inputs.detection;
  const actionPriority = calculateActionPriority(
    inputs.severity,
    inputs.occurrence,
    inputs.detection,
  );

  return {
    value: { rpn, actionPriority },
    mode,
    inputsUsed: {
      severity: inputs.severity,
      occurrence: inputs.occurrence,
      detection: inputs.detection,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
