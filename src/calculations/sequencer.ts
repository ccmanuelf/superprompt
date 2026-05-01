/**
 * Job-shop sequencing metrics — dual-view wrappers.
 * Delegates to pure functions in src/sequencer/.
 *
 * Three primary entry points:
 *   - calculateDispatchSchedule  → single dispatching rule (FIFO/SPT/EDD/...)
 *   - calculateRuleComparison    → all rules side-by-side
 *   - calculateGeneticSchedule   → genetic algorithm optimization
 *
 * Note: GA seed/population/generations are stochastic-control parameters;
 * per spec-owner Q3, site_adjusted mode affects input distributions only,
 * not seed policy. GA hyperparameters are accepted as-is in both modes.
 */

import { dispatch, compareAllRules } from '../sequencer/dispatching.js';
import { runGA } from '../sequencer/genetic.js';
import type {
  SequencerConfig,
  ScheduleResult,
  RuleComparison,
  GAResult,
  GAConfig,
  DispatchRule,
} from '../sequencer/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface DispatchScheduleInputs {
  config: SequencerConfig;
  rule: DispatchRule;
}

export function calculateDispatchSchedule(
  inputs: DispatchScheduleInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<ScheduleResult> {
  const value = dispatch(inputs.config, inputs.rule);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.config.name,
      rule: inputs.rule,
      jobCount: inputs.config.jobs.length,
      machineCount: inputs.config.machines.length,
      hasSetupMatrix: Boolean(inputs.config.setup_matrix?.length),
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}

export type RuleComparisonInputs = SequencerConfig;

export function calculateRuleComparison(
  inputs: RuleComparisonInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<RuleComparison> {
  const value = compareAllRules(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.name,
      jobCount: inputs.jobs.length,
      machineCount: inputs.machines.length,
      hasSetupMatrix: Boolean(inputs.setup_matrix?.length),
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}

export interface GeneticScheduleInputs {
  config: SequencerConfig;
  gaConfig?: Partial<GAConfig>;
}

export function calculateGeneticSchedule(
  inputs: GeneticScheduleInputs,
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<GAResult> {
  const value = runGA(inputs.config, inputs.gaConfig);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.config.name,
      jobCount: inputs.config.jobs.length,
      machineCount: inputs.config.machines.length,
      populationSize: inputs.gaConfig?.population_size ?? null,
      generations: inputs.gaConfig?.generations ?? null,
      objective: inputs.gaConfig?.objective ?? null,
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}
