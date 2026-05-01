/**
 * Production-line simulation metrics — dual-view wrappers.
 * Delegates to async pure functions in src/simulation/.
 *
 * Two primary metrics in this module:
 *   - calculateSimulationMetrics  → single-run DES + 8-block calculation pipeline
 *   - calculateMonteCarloMetrics  → multi-replication Monte Carlo aggregation
 *
 * These wrappers are async — first divergence from the sync trivial-trio +
 * sigma + capacity wrappers. The simulation engine drives an event loop and
 * yields between events, so the underlying functions are async by design.
 *
 * Internal compositions inside src/simulation/ continue calling the underlying
 * functions directly. The wrappers are the boundary for external consumers
 * (web/sim-api.ts, providers/tools/simulation.ts).
 */

import { runSimulation } from '../simulation/engine.js';
import { runMonteCarlo } from '../simulation/monte-carlo.js';
import { calculateAllBlocks } from '../simulation/calculations.js';
import type {
  SimulationConfig,
  SimulationResults,
  ValidationReport,
  MonteCarloResults,
} from '../simulation/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface SimulationMetricInputs {
  config: SimulationConfig;
  validationReport: ValidationReport;
  seed?: number;
  defaultsApplied?: Array<Record<string, unknown>>;
}

export async function calculateSimulationMetrics(
  inputs: SimulationMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): Promise<CalculationResult<SimulationResults>> {
  const seed = inputs.seed ?? 42;
  const { metrics, durationSeconds } = await runSimulation(inputs.config, seed);
  const value = calculateAllBlocks(
    inputs.config,
    metrics,
    inputs.validationReport,
    durationSeconds,
    inputs.defaultsApplied,
  );

  return {
    value,
    mode,
    inputsUsed: {
      operationCount: inputs.config.operations.length,
      demandCount: inputs.config.demands.length,
      horizonDays: inputs.config.horizon_days ?? 1,
      demandMode: inputs.config.mode ?? 'demand-driven',
      seed,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}

export interface MonteCarloMetricInputs {
  config: SimulationConfig;
  replications?: number;
  baseSeed?: number;
}

export async function calculateMonteCarloMetrics(
  inputs: MonteCarloMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): Promise<CalculationResult<MonteCarloResults>> {
  // Active hook: when caller omits replications and the assumption bag
  // carries a resolved monte_carlo_default_iterations, use it. This is
  // the canonical Phase 3 demonstration that site_adjusted with overrides
  // produces a different result than standard mode without bag entries.
  const assumedReplications = assumptions['monte_carlo_default_iterations']?.value;
  const replicationsFromAssumption =
    typeof assumedReplications === 'number' && Number.isFinite(assumedReplications)
      ? assumedReplications
      : undefined;
  const replications = inputs.replications ?? replicationsFromAssumption;

  const value = await runMonteCarlo(
    inputs.config,
    replications,
    inputs.baseSeed,
  );

  return {
    value,
    mode,
    inputsUsed: {
      operationCount: inputs.config.operations.length,
      demandCount: inputs.config.demands.length,
      horizonDays: inputs.config.horizon_days ?? 1,
      replications: value.replications,
      baseSeed: inputs.baseSeed ?? 42,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
