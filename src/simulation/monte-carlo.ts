/**
 * Production Line Simulation v3.0 — Monte Carlo Wrapper
 *
 * Runs N replications of the simulation engine with different random seeds,
 * aggregates statistics, and produces confidence intervals.
 */

import { ProductionLineSimulator } from './engine.js';
import {
  type SimulationConfig,
  type SimulationMetrics,
  type MonteCarloResults,
  type DistributionStats,
  type SimulationResults,
} from './models.js';
import { calculateAllBlocks } from './calculations.js';
import { validateSimulationConfig } from './validation.js';
import { DEFAULT_MONTE_CARLO_REPLICATIONS, MONTE_CARLO_MAX_REPLICATIONS } from './constants.js';

/**
 * Run Monte Carlo simulation with N replications.
 * Returns aggregated statistics with confidence intervals.
 * Exported for testing.
 */
export async function runMonteCarlo(
  config: SimulationConfig,
  replications: number = DEFAULT_MONTE_CARLO_REPLICATIONS,
  baseSeed: number = 42,
): Promise<MonteCarloResults> {
  const n = Math.min(Math.max(replications, 2), MONTE_CARLO_MAX_REPLICATIONS);

  const validationReport = validateSimulationConfig(config);
  const allResults: SimulationResults[] = [];
  const throughputs: number[] = [];
  const cycleTimes: number[] = [];
  const maxWips: number[] = [];
  const stationUtils = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const seed = baseSeed + i * 7919; // Use prime spacing for seed diversity
    const simulator = new ProductionLineSimulator(config, seed);
    const metrics = await simulator.run();

    const results = calculateAllBlocks(config, metrics, validationReport, 0);
    allResults.push(results);

    // Collect aggregate metrics
    let totalThroughput = 0;
    for (const [, count] of metrics.throughput_by_product) totalThroughput += count;
    throughputs.push(totalThroughput);

    const avgCt = metrics.cycle_times.length > 0
      ? metrics.cycle_times.reduce((s, v) => s + v, 0) / metrics.cycle_times.length : 0;
    cycleTimes.push(avgCt);
    maxWips.push(metrics.max_wip);

    // Station utilizations
    for (const row of results.station_performance) {
      const key = `${row.machine_tool}`;
      const utils = stationUtils.get(key) ?? [];
      utils.push(row.util_pct);
      stationUtils.set(key, utils);
    }
  }

  // Calculate daily demand for comparison
  let dailyDemand = 0;
  for (const demand of config.demands) {
    if (demand.daily_demand) dailyDemand += demand.daily_demand;
    else if (demand.weekly_demand) dailyDemand += demand.weekly_demand / config.schedule.work_days;
    else if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      dailyDemand += config.total_demand * demand.mix_share_pct / 100;
    }
  }
  const horizonDays = config.horizon_days ?? 1;
  const totalDemand = dailyDemand * horizonDays;

  // Demand met percentage
  const demandMetCount = throughputs.filter((t) => t >= totalDemand).length;
  const demandMetPct = (demandMetCount / n) * 100;

  // Build utilization stats per station
  const utilizationByStation = new Map<string, DistributionStats>();
  for (const [station, utils] of stationUtils) {
    utilizationByStation.set(station, computeStats(utils));
  }

  return {
    replications: n,
    throughput: computeStats(throughputs),
    cycle_time: computeStats(cycleTimes),
    max_wip: computeStats(maxWips),
    utilization_by_station: utilizationByStation,
    demand_met_pct: Math.round(demandMetPct * 100) / 100,
    per_replication: allResults,
  };
}

/**
 * Compute distribution statistics from a sample.
 * Exported for testing.
 */
export function computeStats(values: number[]): DistributionStats {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;

  let variance = 0;
  for (const v of sorted) variance += (v - mean) ** 2;
  const stddev = n > 1 ? Math.sqrt(variance / (n - 1)) : 0;

  return {
    mean: round2(mean),
    stddev: round2(stddev),
    min: round2(sorted[0]),
    max: round2(sorted[n - 1]),
    p5: round2(percentile(sorted, 5)),
    p25: round2(percentile(sorted, 25)),
    p50: round2(percentile(sorted, 50)),
    p75: round2(percentile(sorted, 75)),
    p95: round2(percentile(sorted, 95)),
  };
}

function percentile(sorted: number[], pct: number): number {
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
