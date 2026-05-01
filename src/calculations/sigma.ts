/**
 * Six Sigma metrics — dual-view wrappers.
 * Delegates to pure functions in src/sigma.ts.
 *
 * Three primary metrics in this module:
 *   - calculateCapabilityMetrics  → Cp/Cpk/Pp/Ppk/Cpm
 *   - calculateDpmoMetrics        → DPMO + sigma level + yield
 *   - calculateYieldMetrics       → Rolled Throughput Yield
 */

import {
  calculateCapability,
  calculateDpmo,
  rolledThroughputYield,
} from '../sigma.js';
import type { CapabilityResult, DpmoResult, SpecLimits } from '../sigma.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface CapabilityMetricInputs {
  values: number[];
  lsl: number;
  usl: number;
  target?: number;
  subgroups?: string[];
}

export function calculateCapabilityMetrics(
  inputs: CapabilityMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<CapabilityResult> {
  const spec: SpecLimits = {
    usl: inputs.usl,
    lsl: inputs.lsl,
    target: inputs.target,
  };
  const value = calculateCapability(inputs.values, spec, inputs.subgroups);

  return {
    value,
    mode,
    inputsUsed: {
      sampleSize: inputs.values.length,
      lsl: inputs.lsl,
      usl: inputs.usl,
      target: inputs.target ?? null,
      subgroupCount: inputs.subgroups
        ? new Set(inputs.subgroups).size
        : 0,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}

export interface DpmoMetricInputs {
  defects: number;
  units: number;
  opportunities: number;
}

export function calculateDpmoMetrics(
  inputs: DpmoMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<DpmoResult> {
  const value = calculateDpmo(inputs.defects, inputs.units, inputs.opportunities);

  return {
    value,
    mode,
    inputsUsed: {
      defects: inputs.defects,
      units: inputs.units,
      opportunities: inputs.opportunities,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}

export interface YieldMetricInputs {
  stepYields: number[];
}

export interface YieldMetrics {
  rty: number;
  stepCount: number;
}

export function calculateYieldMetrics(
  inputs: YieldMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<YieldMetrics> {
  const rty = rolledThroughputYield(inputs.stepYields);

  return {
    value: { rty, stepCount: inputs.stepYields.length },
    mode,
    inputsUsed: { stepCount: inputs.stepYields.length },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
