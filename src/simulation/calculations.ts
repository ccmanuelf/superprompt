/**
 * Production Line Simulation v3.0 — Output Calculations (8 Blocks)
 *
 * Ported from kpi-operations SimPy V2 (calculations.py).
 * All functions are pure — no side effects, no database dependencies.
 * Transforms raw SimulationMetrics into structured result blocks.
 */

import {
  type SimulationConfig,
  type SimulationMetrics,
  type SimulationResults,
  type ValidationReport,
  type WeeklyDemandCapacityRow,
  type DailySummary,
  type StationPerformanceRow,
  type FreeCapacityAnalysis,
  type BundleMetricsRow,
  type PerProductSummaryRow,
  type RebalancingSuggestionRow,
  type AssumptionLog,
  type CoverageStatus,
  applyOperationDefaults,
  getDailyPlannedHours,
} from './models.js';

import {
  ENGINE_VERSION,
  BOTTLENECK_UTILIZATION_THRESHOLD,
  DONOR_UTILIZATION_THRESHOLD,
  COVERAGE_OK_THRESHOLD,
  COVERAGE_TIGHT_THRESHOLD,
  FORMULA_DESCRIPTIONS,
  SIMULATION_LIMITATIONS,
} from './constants.js';

// ── Main Entry Point ─────────────────────────────────────────

/**
 * Calculate all 8 output blocks from simulation metrics.
 * Exported for testing.
 */
export function calculateAllBlocks(
  config: SimulationConfig,
  metrics: SimulationMetrics,
  validationReport: ValidationReport,
  durationSeconds: number,
  defaultsApplied?: Array<Record<string, unknown>>,
): SimulationResults {
  const stationPerformance = calculateBlock3StationPerformance(config, metrics);

  return {
    weekly_demand_capacity: calculateBlock1WeeklyCapacity(config, metrics),
    daily_summary: calculateBlock2DailySummary(config, metrics),
    station_performance: stationPerformance,
    free_capacity: calculateBlock4FreeCapacity(config, metrics, stationPerformance),
    bundle_metrics: calculateBlock5BundleMetrics(config, metrics),
    per_product_summary: calculateBlock6PerProduct(config, metrics),
    rebalancing_suggestions: calculateBlock7Rebalancing(stationPerformance, config),
    assumption_log: calculateBlock8AssumptionLog(config, defaultsApplied),
    validation_report: validationReport,
    simulation_duration_seconds: durationSeconds,
  };
}

// ── Block 1: Weekly Demand vs Capacity ───────────────────────

function calculateBlock1WeeklyCapacity(
  config: SimulationConfig,
  metrics: SimulationMetrics,
): WeeklyDemandCapacityRow[] {
  const horizonDays = config.horizon_days ?? 1;
  const workDays = config.schedule.work_days;
  const rows: WeeklyDemandCapacityRow[] = [];

  for (const demand of config.demands) {
    const throughput = metrics.throughput_by_product.get(demand.product) ?? 0;

    // Scale throughput to weekly
    const dailyThroughput = throughput / horizonDays;
    const weeklyCapacity = Math.round(dailyThroughput * workDays);

    // Calculate weekly demand
    let weeklyDemand: number;
    if (demand.weekly_demand) {
      weeklyDemand = demand.weekly_demand;
    } else if (demand.daily_demand) {
      weeklyDemand = demand.daily_demand * workDays;
    } else if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      weeklyDemand = (config.total_demand * demand.mix_share_pct / 100) * workDays;
    } else {
      weeklyDemand = 0;
    }
    weeklyDemand = Math.round(weeklyDemand);

    const coveragePct = weeklyDemand > 0 ? (weeklyCapacity / weeklyDemand) * 100 : 0;

    let status: CoverageStatus;
    if (coveragePct >= COVERAGE_OK_THRESHOLD) status = 'OK';
    else if (coveragePct >= COVERAGE_TIGHT_THRESHOLD) status = 'Tight';
    else status = 'Shortfall';

    rows.push({
      product: demand.product,
      weekly_demand_pcs: weeklyDemand,
      max_weekly_capacity_pcs: weeklyCapacity,
      demand_coverage_pct: round2(coveragePct),
      status,
    });
  }

  return rows;
}

// ── Block 2: Daily Aggregate Summary ─────────────────────────

function calculateBlock2DailySummary(
  config: SimulationConfig,
  metrics: SimulationMetrics,
): DailySummary {
  const horizonDays = config.horizon_days ?? 1;
  const dailyPlannedHours = getDailyPlannedHours(config.schedule);

  // Total throughput and demand
  let totalThroughput = 0;
  for (const [, count] of metrics.throughput_by_product) totalThroughput += count;
  const dailyThroughput = Math.round(totalThroughput / horizonDays);

  let dailyDemand = 0;
  for (const demand of config.demands) {
    if (demand.daily_demand) dailyDemand += demand.daily_demand;
    else if (demand.weekly_demand) dailyDemand += demand.weekly_demand / config.schedule.work_days;
    else if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      dailyDemand += config.total_demand * demand.mix_share_pct / 100;
    }
  }
  dailyDemand = Math.round(dailyDemand);

  const coveragePct = dailyDemand > 0 ? (dailyThroughput / dailyDemand) * 100 : 0;

  // Cycle time
  const avgCycleTime = metrics.cycle_times.length > 0
    ? metrics.cycle_times.reduce((s, v) => s + v, 0) / metrics.cycle_times.length
    : 0;

  // WIP
  const avgWip = metrics.wip_samples.length > 0
    ? metrics.wip_samples.reduce((s, v) => s + v, 0) / metrics.wip_samples.length
    : 0;

  // Bundle size summary
  const bundleSizes = config.demands.map((d) => d.bundle_size ?? 1);
  const bundleSizeStr = [...new Set(bundleSizes)].join('/');

  return {
    total_shifts_per_day: config.schedule.shifts_enabled,
    daily_planned_hours: dailyPlannedHours,
    daily_throughput_pcs: dailyThroughput,
    daily_demand_pcs: dailyDemand,
    daily_coverage_pct: round2(coveragePct),
    avg_cycle_time_min: round2(avgCycleTime),
    avg_wip_pcs: round2(avgWip),
    bundles_processed_per_day: Math.round(metrics.bundles_completed / horizonDays),
    bundle_size_pcs: bundleSizeStr,
  };
}

// ── Block 3: Station Performance ─────────────────────────────

function calculateBlock3StationPerformance(
  config: SimulationConfig,
  metrics: SimulationMetrics,
): StationPerformanceRow[] {
  const horizonMinutes = getDailyPlannedHours(config.schedule) * 60 * (config.horizon_days ?? 1);
  const rows: StationPerformanceRow[] = [];

  // Build tool → total operators map for pooled capacity
  const toolOperators = new Map<string, number>();
  for (const op of config.operations) {
    const current = toolOperators.get(op.machine_tool) ?? 0;
    toolOperators.set(op.machine_tool, current + (op.operators ?? 1));
  }

  for (const rawOp of config.operations) {
    const op = applyOperationDefaults(rawOp);
    const busyTime = metrics.station_busy_time.get(op.machine_tool) ?? 0;
    const piecesProcessed = metrics.station_pieces_processed.get(op.machine_tool) ?? 0;
    const queueWaits = metrics.station_queue_waits.get(op.machine_tool) ?? [];

    // Utilization = busy_time / (available_time × pooled_operators)
    const pooledOperators = toolOperators.get(op.machine_tool) ?? 1;
    const availableMinutes = horizonMinutes * pooledOperators;
    const utilPct = availableMinutes > 0 ? (busyTime / availableMinutes) * 100 : 0;

    const avgProcessTime = piecesProcessed > 0 ? busyTime / piecesProcessed : 0;
    const avgQueueWait = queueWaits.length > 0
      ? queueWaits.reduce((s, v) => s + v, 0) / queueWaits.length : 0;

    const isBottleneck = utilPct >= BOTTLENECK_UTILIZATION_THRESHOLD;
    const isDonor = utilPct <= DONOR_UTILIZATION_THRESHOLD && (op.operators ?? 1) > 1;

    rows.push({
      product: op.product,
      step: op.step,
      operation: op.operation,
      machine_tool: op.machine_tool,
      sequence: op.sequence ?? 'Assembly',
      grouping: op.grouping ?? '',
      operators: op.operators ?? 1,
      total_pieces_processed: piecesProcessed,
      total_busy_time_min: round2(busyTime),
      avg_processing_time_min: round2(avgProcessTime),
      util_pct: round2(utilPct),
      queue_wait_time_min: round2(avgQueueWait),
      is_bottleneck: isBottleneck,
      is_donor: isDonor,
    });
  }

  // Sort by utilization descending
  rows.sort((a, b) => b.util_pct - a.util_pct);
  return rows;
}

// ── Block 4: Free Capacity Analysis ──────────────────────────

function calculateBlock4FreeCapacity(
  config: SimulationConfig,
  metrics: SimulationMetrics,
  stationPerformance: StationPerformanceRow[],
): FreeCapacityAnalysis {
  const horizonDays = config.horizon_days ?? 1;
  const dailyPlannedHours = getDailyPlannedHours(config.schedule);

  let totalThroughput = 0;
  for (const [, count] of metrics.throughput_by_product) totalThroughput += count;
  const dailyThroughput = Math.round(totalThroughput / horizonDays);

  let dailyDemand = 0;
  for (const demand of config.demands) {
    if (demand.daily_demand) dailyDemand += demand.daily_demand;
    else if (demand.weekly_demand) dailyDemand += demand.weekly_demand / config.schedule.work_days;
    else if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      dailyDemand += config.total_demand * demand.mix_share_pct / 100;
    }
  }

  const maxCapacity = dailyThroughput; // Based on actual simulation
  const usagePct = maxCapacity > 0 ? (dailyDemand / maxCapacity) * 100 : 0;

  // Find bottleneck utilization
  const bottleneck = stationPerformance.find((s) => s.is_bottleneck);
  const bottleneckUtil = bottleneck ? bottleneck.util_pct : (stationPerformance[0]?.util_pct ?? 0);

  const freeLinePct = Math.max(0, 100 - bottleneckUtil);
  const freeLineHours = (freeLinePct / 100) * dailyPlannedHours;

  const bottleneckOperators = bottleneck ? bottleneck.operators : 1;
  const freeOperatorHours = freeLineHours * bottleneckOperators;
  const shift1Hours = config.schedule.shift1_hours;
  const equivalentFreeOperators = shift1Hours > 0 ? freeOperatorHours / shift1Hours : 0;

  return {
    daily_demand_pcs: Math.round(dailyDemand),
    daily_max_capacity_pcs: maxCapacity,
    demand_usage_pct: round2(usagePct),
    free_line_hours_per_day: round2(freeLineHours),
    free_operator_hours_at_bottleneck_per_day: round2(freeOperatorHours),
    equivalent_free_operators_full_shift: round2(equivalentFreeOperators),
  };
}

// ── Block 5: Bundle Metrics ──────────────────────────────────

function calculateBlock5BundleMetrics(
  config: SimulationConfig,
  metrics: SimulationMetrics,
): BundleMetricsRow[] {
  const horizonDays = config.horizon_days ?? 1;
  const rows: BundleMetricsRow[] = [];

  for (const demand of config.demands) {
    const bundleSize = demand.bundle_size ?? 1;
    const bundlesCompleted = metrics.bundles_by_product.get(demand.product) ?? 0;
    const bundlesPerDay = Math.round(bundlesCompleted / horizonDays);

    const bundleSamples = metrics.bundles_in_system_samples.get(demand.product) ?? [];
    const avgBundlesInSystem = bundleSamples.length > 0
      ? bundleSamples.reduce((s, v) => s + v, 0) / bundleSamples.length : null;
    const maxBundlesInSystem = bundleSamples.length > 0
      ? Math.max(...bundleSamples) : null;

    const productCycleTimes = metrics.cycle_times_by_product.get(demand.product) ?? [];
    const avgCycleTime = productCycleTimes.length > 0
      ? productCycleTimes.reduce((s, v) => s + v, 0) / productCycleTimes.length : null;

    rows.push({
      product: demand.product,
      bundle_size_pcs: bundleSize,
      bundles_arriving_per_day: bundlesPerDay,
      avg_bundles_in_system: avgBundlesInSystem !== null ? round2(avgBundlesInSystem) : null,
      max_bundles_in_system: maxBundlesInSystem,
      avg_bundle_cycle_time_min: avgCycleTime !== null ? round2(avgCycleTime) : null,
    });
  }

  return rows;
}

// ── Block 6: Per-Product Summary ─────────────────────────────

function calculateBlock6PerProduct(
  config: SimulationConfig,
  metrics: SimulationMetrics,
): PerProductSummaryRow[] {
  const horizonDays = config.horizon_days ?? 1;
  const workDays = config.schedule.work_days;
  const rows: PerProductSummaryRow[] = [];

  for (const demand of config.demands) {
    const throughput = metrics.throughput_by_product.get(demand.product) ?? 0;
    const dailyThroughput = Math.round(throughput / horizonDays);
    const weeklyThroughput = Math.round(dailyThroughput * workDays);

    let dailyDemand = demand.daily_demand ?? 0;
    if (!dailyDemand && demand.weekly_demand) dailyDemand = demand.weekly_demand / workDays;
    if (config.mode === 'mix-driven' && config.total_demand && demand.mix_share_pct) {
      dailyDemand = config.total_demand * demand.mix_share_pct / 100;
    }
    dailyDemand = Math.round(dailyDemand);
    const weeklyDemand = Math.round(dailyDemand * workDays);

    const dailyCoverage = dailyDemand > 0 ? (dailyThroughput / dailyDemand) * 100 : 0;
    const weeklyCoverage = weeklyDemand > 0 ? (weeklyThroughput / weeklyDemand) * 100 : 0;

    rows.push({
      product: demand.product,
      bundle_size_pcs: demand.bundle_size ?? 1,
      mix_share_pct: demand.mix_share_pct ?? null,
      daily_demand_pcs: dailyDemand,
      daily_throughput_pcs: dailyThroughput,
      daily_coverage_pct: round2(dailyCoverage),
      weekly_demand_pcs: weeklyDemand,
      weekly_throughput_pcs: weeklyThroughput,
      weekly_coverage_pct: round2(weeklyCoverage),
    });
  }

  return rows;
}

// ── Block 7: Rebalancing Suggestions ─────────────────────────

function calculateBlock7Rebalancing(
  stationPerformance: StationPerformanceRow[],
  _config: SimulationConfig,
): RebalancingSuggestionRow[] {
  const suggestions: RebalancingSuggestionRow[] = [];

  const bottlenecks = stationPerformance.filter((s) => s.is_bottleneck);
  const donors = stationPerformance.filter((s) => s.is_donor);

  for (const bn of bottlenecks) {
    const newOps = bn.operators + 1;
    const newUtil = bn.util_pct * (bn.operators / newOps);

    suggestions.push({
      product: bn.product,
      step: bn.step,
      operation: bn.operation,
      machine_tool: bn.machine_tool,
      grouping: bn.grouping,
      operators_before: bn.operators,
      operators_after: newOps,
      util_before_pct: bn.util_pct,
      util_after_pct: round2(newUtil),
      role: 'Bottleneck',
      comment: `Add 1 operator to reduce utilization from ${bn.util_pct.toFixed(0)}% to ~${newUtil.toFixed(0)}%`,
    });

    // Try to match with a donor
    if (donors.length > 0) {
      const donor = donors[0];
      const donorNewOps = donor.operators - 1;
      const donorNewUtil = donorNewOps > 0 ? donor.util_pct * (donor.operators / donorNewOps) : 0;

      suggestions.push({
        product: donor.product,
        step: donor.step,
        operation: donor.operation,
        machine_tool: donor.machine_tool,
        grouping: donor.grouping,
        operators_before: donor.operators,
        operators_after: donorNewOps,
        util_before_pct: donor.util_pct,
        util_after_pct: round2(donorNewUtil),
        role: 'Donor',
        comment: `Remove 1 operator (utilization ${donor.util_pct.toFixed(0)}% → ~${donorNewUtil.toFixed(0)}%)`,
      });

      // Remove used donor
      donors.shift();
    }
  }

  return suggestions;
}

// ── Block 8: Assumption Log ──────────────────────────────────

function calculateBlock8AssumptionLog(
  config: SimulationConfig,
  defaultsApplied?: Array<Record<string, unknown>>,
): AssumptionLog {
  const products = [...new Set(config.operations.map((op) => op.product))];

  return {
    timestamp: new Date().toISOString(),
    simulation_engine_version: ENGINE_VERSION,
    configuration_mode: config.mode ?? 'demand-driven',
    schedule: {
      shifts_enabled: config.schedule.shifts_enabled,
      shift1_hours: config.schedule.shift1_hours,
      shift2_hours: config.schedule.shift2_hours ?? 0,
      shift3_hours: config.schedule.shift3_hours ?? 0,
      work_days: config.schedule.work_days,
      ot_enabled: config.schedule.ot_enabled ?? false,
      daily_planned_hours: getDailyPlannedHours(config.schedule),
    },
    products: products.map((p) => {
      const demand = config.demands.find((d) => d.product === p);
      return {
        product: p,
        bundle_size: demand?.bundle_size ?? 1,
        daily_demand: demand?.daily_demand ?? null,
        weekly_demand: demand?.weekly_demand ?? null,
        mix_share_pct: demand?.mix_share_pct ?? null,
      };
    }),
    operations_defaults_applied: defaultsApplied ?? [],
    breakdowns_configuration: {
      enabled: (config.breakdowns ?? []).length > 0,
      rules: (config.breakdowns ?? []).map((b) => ({
        machine_tool: b.machine_tool,
        breakdown_pct: b.breakdown_pct,
      })),
    },
    formula_implementations: FORMULA_DESCRIPTIONS,
    limitations_and_caveats: SIMULATION_LIMITATIONS,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
