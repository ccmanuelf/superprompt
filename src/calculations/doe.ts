/**
 * Design of Experiments metrics — dual-view wrappers.
 * Delegates to pure functions in src/doe/.
 *
 * Two primary entry points used in sequence:
 *   - calculateDoeMatrix    → generates the experimental design (run plan)
 *   - calculateDoeAnalysis  → analyzes the matrix once response data is filled in
 */

import { generateMatrix, analyzeDOE } from '../doe/analysis.js';
import type {
  DOEConfig,
  ExperimentMatrix,
  DOEAnalysis,
} from '../doe/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export type DoeMatrixInputs = DOEConfig;

export function calculateDoeMatrix(
  inputs: DoeMatrixInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<ExperimentMatrix> {
  const value = generateMatrix(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.name,
      designType: inputs.design_type,
      factorCount: inputs.factors.length,
      responseCount: inputs.responses.length,
      replicates: inputs.replicates ?? 1,
      blocks: inputs.blocks ?? 1,
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}

export interface DoeAnalysisInputs {
  config: DOEConfig;
  matrix: ExperimentMatrix;
}

export function calculateDoeAnalysis(
  inputs: DoeAnalysisInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<DOEAnalysis> {
  const value = analyzeDOE(inputs.config, inputs.matrix);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.config.name,
      designType: inputs.config.design_type,
      factorCount: inputs.config.factors.length,
      responseCount: inputs.config.responses.length,
      runsAnalyzed: inputs.matrix.total_runs,
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}
