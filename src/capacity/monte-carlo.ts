/**
 * Capacity Planning — Monte Carlo Analysis
 *
 * Runs N replications of the 12-step capacity analysis with stochastic
 * variation on efficiency, absenteeism, and demand. Reports confidence
 * intervals and bottleneck probabilities.
 */

import { analyzeCapacity } from './analysis.js';
import type {
  CapacityPlanConfig,
  MonteCarloCapacityConfig,
  MonteCarloCapacityResults,
  CapacityDistributionStats,
  DistributionConfig,
  CapacityAnalysisResult,
} from './models.js';
import { DEFAULT_REPLICATIONS } from './models.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Run Monte Carlo capacity analysis with N replications.
 */
export function runCapacityMonteCarlo(
  config: MonteCarloCapacityConfig,
): MonteCarloCapacityResults {
  const n = config.replications || DEFAULT_REPLICATIONS;

  // Collect per-replication metrics
  const overallUtils: number[] = [];
  const totalCaps: number[] = [];
  const totalDems: number[] = [];
  let bottleneckRuns = 0;
  const lineUtils = new Map<string, number[]>();
  const lineBottleneckCounts = new Map<string, number>();

  // Initialize line tracking
  for (const line of config.base_config.lines) {
    lineUtils.set(line.id, []);
    lineBottleneckCounts.set(line.id, 0);
  }

  // Run replications
  for (let i = 0; i < n; i++) {
    const perturbedConfig = perturbConfig(config);
    const result = analyzeCapacity(perturbedConfig);

    overallUtils.push(result.overall_utilization_pct);
    totalCaps.push(result.total_capacity_hours);
    totalDems.push(result.total_demand_hours);

    if (result.bottleneck_count > 0) bottleneckRuns++;

    for (const line of result.lines) {
      lineUtils.get(line.line_id)?.push(line.utilization_pct);
      if (line.is_bottleneck) {
        lineBottleneckCounts.set(
          line.line_id,
          (lineBottleneckCounts.get(line.line_id) ?? 0) + 1,
        );
      }
    }
  }

  // Compute statistics
  const overall_utilization = computeStats(overallUtils);
  const total_capacity_hours = computeStats(totalCaps);
  const total_demand_hours = computeStats(totalDems);

  const per_line_utilization: Record<string, CapacityDistributionStats> = {};
  const per_line_bottleneck_probability: Record<string, number> = {};

  for (const line of config.base_config.lines) {
    const utils = lineUtils.get(line.id) ?? [];
    per_line_utilization[line.id] = computeStats(utils);
    per_line_bottleneck_probability[line.id] =
      ((lineBottleneckCounts.get(line.id) ?? 0) / n) * 100;
  }

  return {
    replications: n,
    overall_utilization,
    total_capacity_hours,
    total_demand_hours,
    bottleneck_probability: (bottleneckRuns / n) * 100,
    per_line_utilization,
    per_line_bottleneck_probability,
    confidence_90: {
      lower: percentile(overallUtils, 5),
      upper: percentile(overallUtils, 95),
    },
    confidence_95: {
      lower: percentile(overallUtils, 2.5),
      upper: percentile(overallUtils, 97.5),
    },
    confidence_99: {
      lower: percentile(overallUtils, 0.5),
      upper: percentile(overallUtils, 99.5),
    },
  };
}

// ── Config Perturbation ──────────────────────────────────────

function perturbConfig(mc: MonteCarloCapacityConfig): CapacityPlanConfig {
  const base = mc.base_config;

  // Perturb efficiency per line
  const lines = base.lines.map((line) => {
    let efficiency = line.efficiency_factor;
    let absenteeism = line.absenteeism_factor;

    if (mc.efficiency_distribution) {
      efficiency = clamp(
        sampleDistribution(mc.efficiency_distribution, efficiency),
        0.01,
        1.0,
      );
    } else {
      // Default: normal with 5% stddev of the mean
      efficiency = clamp(
        efficiency + normalRandom() * efficiency * 0.05,
        0.01,
        1.0,
      );
    }

    if (mc.absenteeism_distribution) {
      absenteeism = clamp(
        sampleDistribution(mc.absenteeism_distribution, absenteeism),
        0,
        0.5,
      );
    } else {
      // Default: normal with 20% stddev of the mean
      absenteeism = clamp(
        absenteeism + normalRandom() * absenteeism * 0.20,
        0,
        0.5,
      );
    }

    return { ...line, efficiency_factor: efficiency, absenteeism_factor: absenteeism };
  });

  // Perturb demand
  const demands = base.demands.map((d) => {
    let quantity = d.quantity;
    let hours = d.hours;

    if (mc.demand_distribution) {
      const factor = sampleDistribution(mc.demand_distribution, 1.0);
      quantity = Math.max(0, Math.round(quantity * factor));
      if (hours != null) hours = Math.max(0, hours * factor);
    } else {
      // Default: normal with 10% stddev
      const factor = 1 + normalRandom() * 0.10;
      quantity = Math.max(0, Math.round(quantity * factor));
      if (hours != null) hours = Math.max(0, hours * factor);
    }

    return { ...d, quantity, hours };
  });

  return { ...base, lines, demands };
}

// ── Distribution Sampling ────────────────────────────────────

function sampleDistribution(config: DistributionConfig, baseValue: number): number {
  switch (config.type) {
    case 'normal': {
      const mean = config.mean ?? baseValue;
      const stddev = config.stddev ?? baseValue * 0.05;
      return mean + normalRandom() * stddev;
    }
    case 'triangular': {
      const min = config.min ?? baseValue * 0.8;
      const max = config.max ?? baseValue * 1.2;
      const mode = config.mode ?? baseValue;
      return triangularRandom(min, mode, max);
    }
    case 'uniform': {
      const min = config.min ?? baseValue * 0.9;
      const max = config.max ?? baseValue * 1.1;
      return min + Math.random() * (max - min);
    }
    default:
      return baseValue;
  }
}

// ── Statistics ───────────────────────────────────────────────

export function computeStats(values: number[]): CapacityDistributionStats {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;

  return {
    mean: round2(mean),
    stddev: round2(Math.sqrt(variance)),
    min: round2(sorted[0]),
    max: round2(sorted[n - 1]),
    p5: round2(percentile(sorted, 5)),
    p10: round2(percentile(sorted, 10)),
    p25: round2(percentile(sorted, 25)),
    p50: round2(percentile(sorted, 50)),
    p75: round2(percentile(sorted, 75)),
    p90: round2(percentile(sorted, 90)),
    p95: round2(percentile(sorted, 95)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = (p / 100) * (arr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return arr[lower];
  const frac = idx - lower;
  return arr[lower] * (1 - frac) + arr[upper] * frac;
}

// ── Random Number Generators ─────────────────────────────────

/** Box-Muller transform for normal distribution */
function normalRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

/** Triangular distribution sampling */
function triangularRandom(min: number, mode: number, max: number): number {
  const u = Math.random();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
