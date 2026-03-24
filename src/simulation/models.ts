/**
 * Production Line Simulation v3.0 — TypeScript Types
 *
 * Ported from kpi-operations SimPy V2 (models.py).
 * All input, output, and internal types for the simulation engine.
 */

// ── Enums ────────────────────────────────────────────────────

export type VariabilityType = 'deterministic' | 'triangular';
export type DemandMode = 'demand-driven' | 'mix-driven';
export type ValidationSeverity = 'error' | 'warning' | 'info';
export type CoverageStatus = 'OK' | 'Tight' | 'Shortfall';
export type RebalanceRole = 'Bottleneck' | 'Donor';

// ── Input Models ─────────────────────────────────────────────

export interface OperationInput {
  product: string;
  step: number;
  operation: string;
  machine_tool: string;
  sam_min: number;
  sequence?: string;       // default: 'Assembly'
  grouping?: string;       // default: ''
  operators?: number;      // default: 1
  variability?: VariabilityType; // default: 'triangular'
  rework_pct?: number;     // default: 0.0
  grade_pct?: number;      // default: 85.0
  fpd_pct?: number;        // default: 15.0
}

export interface ScheduleConfig {
  shifts_enabled: number;  // 1-3
  shift1_hours: number;
  shift2_hours?: number;   // default: 0
  shift3_hours?: number;   // default: 0
  work_days: number;       // 1-7
  ot_enabled?: boolean;
  weekday_ot_hours?: number;
  weekend_ot_days?: number;
  weekend_ot_hours?: number;
}

export interface DemandInput {
  product: string;
  bundle_size?: number;     // default: 1
  daily_demand?: number;
  weekly_demand?: number;
  mix_share_pct?: number;   // for mix-driven mode
}

export interface BreakdownInput {
  machine_tool: string;
  breakdown_pct: number;
}

/** V3 enhancement: changeover time matrix */
export interface ChangeoverConfig {
  from_product: string;
  to_product: string;
  changeover_minutes: number;
}

/** V3 enhancement: configurable breakdown distribution */
export interface BreakdownDistribution {
  machine_tool: string;
  mtbf_minutes: number;    // Mean Time Between Failures
  mttr_minutes: number;    // Mean Time To Repair
}

/** V3 enhancement: WIP limit (kanban) */
export interface WipLimit {
  machine_tool: string;
  max_wip: number;
}

export interface SimulationConfig {
  operations: OperationInput[];
  schedule: ScheduleConfig;
  demands: DemandInput[];
  breakdowns?: BreakdownInput[];
  mode?: DemandMode;       // default: 'demand-driven'
  total_demand?: number;   // required in mix-driven mode
  horizon_days?: number;   // default: 1

  // V3 enhancements (all optional for backward compatibility)
  changeovers?: ChangeoverConfig[];
  breakdown_distributions?: BreakdownDistribution[];
  wip_limits?: WipLimit[];
  enable_breaks?: boolean;
}

// ── Simulation Metrics (internal) ────────────────────────────

export interface SimulationMetrics {
  throughput_by_product: Map<string, number>;
  bundles_completed: number;
  cycle_times: number[];
  cycle_times_by_product: Map<string, number[]>;
  station_busy_time: Map<string, number>;
  station_pieces_processed: Map<string, number>;
  station_queue_waits: Map<string, number[]>;
  wip_samples: number[];
  current_wip: number;
  max_wip: number;
  bundles_by_product: Map<string, number>;
  bundles_in_system_samples: Map<string, number[]>;
  current_bundles_by_product: Map<string, number>;
  rework_count: number;
  rework_by_station: Map<string, number>;
  breakdown_events: number;
  breakdown_time_lost: number;
}

// ── Validation Models ────────────────────────────────────────

export interface ValidationIssue {
  severity: ValidationSeverity;
  category: string;
  message: string;
  field?: string;
  product?: string;
  recommendation?: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  products_count: number;
  operations_count: number;
  machine_tools_count: number;
  is_valid: boolean;
  can_proceed: boolean;
}

// ── Output Models (8 Result Blocks) ──────────────────────────

/** Block 1: Weekly Demand vs Capacity */
export interface WeeklyDemandCapacityRow {
  product: string;
  weekly_demand_pcs: number;
  max_weekly_capacity_pcs: number;
  demand_coverage_pct: number;
  status: CoverageStatus;
}

/** Block 2: Daily Aggregate Summary */
export interface DailySummary {
  total_shifts_per_day: number;
  daily_planned_hours: number;
  daily_throughput_pcs: number;
  daily_demand_pcs: number;
  daily_coverage_pct: number;
  avg_cycle_time_min: number;
  avg_wip_pcs: number;
  bundles_processed_per_day: number;
  bundle_size_pcs: string;
}

/** Block 3: Station/Operation Performance */
export interface StationPerformanceRow {
  product: string;
  step: number;
  operation: string;
  machine_tool: string;
  sequence: string;
  grouping: string;
  operators: number;
  total_pieces_processed: number;
  total_busy_time_min: number;
  avg_processing_time_min: number;
  util_pct: number;
  queue_wait_time_min: number;
  is_bottleneck: boolean;
  is_donor: boolean;
}

/** Block 4: Free Capacity Analysis */
export interface FreeCapacityAnalysis {
  daily_demand_pcs: number;
  daily_max_capacity_pcs: number;
  demand_usage_pct: number;
  free_line_hours_per_day: number;
  free_operator_hours_at_bottleneck_per_day: number;
  equivalent_free_operators_full_shift: number;
}

/** Block 5: Bundle Metrics */
export interface BundleMetricsRow {
  product: string;
  bundle_size_pcs: number;
  bundles_arriving_per_day: number;
  avg_bundles_in_system: number | null;
  max_bundles_in_system: number | null;
  avg_bundle_cycle_time_min: number | null;
}

/** Block 6: Per-Product Summary */
export interface PerProductSummaryRow {
  product: string;
  bundle_size_pcs: number;
  mix_share_pct: number | null;
  daily_demand_pcs: number;
  daily_throughput_pcs: number;
  daily_coverage_pct: number;
  weekly_demand_pcs: number;
  weekly_throughput_pcs: number;
  weekly_coverage_pct: number;
}

/** Block 7: Rebalancing Suggestions */
export interface RebalancingSuggestionRow {
  product: string;
  step: number;
  operation: string;
  machine_tool: string;
  grouping: string;
  operators_before: number;
  operators_after: number;
  util_before_pct: number;
  util_after_pct: number;
  role: RebalanceRole;
  comment: string;
}

/** Block 8: Assumption Log */
export interface AssumptionLog {
  timestamp: string;
  simulation_engine_version: string;
  configuration_mode: string;
  schedule: Record<string, unknown>;
  products: Array<Record<string, unknown>>;
  operations_defaults_applied: Array<Record<string, unknown>>;
  breakdowns_configuration: Record<string, unknown>;
  formula_implementations: Record<string, string>;
  limitations_and_caveats: string[];
}

/** Complete Results Container */
export interface SimulationResults {
  weekly_demand_capacity: WeeklyDemandCapacityRow[];
  daily_summary: DailySummary;
  station_performance: StationPerformanceRow[];
  free_capacity: FreeCapacityAnalysis;
  bundle_metrics: BundleMetricsRow[];
  per_product_summary: PerProductSummaryRow[];
  rebalancing_suggestions: RebalancingSuggestionRow[];
  assumption_log: AssumptionLog;
  validation_report: ValidationReport;
  simulation_duration_seconds: number;
}

// ── Monte Carlo Types ────────────────────────────────────────

export interface MonteCarloResults {
  replications: number;
  throughput: DistributionStats;
  cycle_time: DistributionStats;
  max_wip: DistributionStats;
  utilization_by_station: Map<string, DistributionStats>;
  demand_met_pct: number;  // % of replications where throughput >= demand
  per_replication: SimulationResults[];
}

export interface DistributionStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

// ── API Models ───────────────────────────────────────────────

export interface SimulationRequest {
  config: SimulationConfig;
}

export interface SimulationResponse {
  success: boolean;
  results?: SimulationResults;
  validation_report: ValidationReport;
  message: string;
}

// ── Scenario Persistence ─────────────────────────────────────

export interface SimScenario {
  id: string;
  name: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

export interface SimResultRow {
  id: string;
  scenario_id: string;
  result_type: string; // 'single' | 'monte_carlo'
  result_json: string;
  created_at: number;
}

// ── Helper: apply defaults to OperationInput ─────────────────

export function applyOperationDefaults(op: OperationInput): Required<Omit<OperationInput, never>> & OperationInput {
  return {
    ...op,
    sequence: op.sequence ?? 'Assembly',
    grouping: op.grouping ?? '',
    operators: op.operators ?? 1,
    variability: op.variability ?? 'triangular',
    rework_pct: op.rework_pct ?? 0.0,
    grade_pct: op.grade_pct ?? 85.0,
    fpd_pct: op.fpd_pct ?? 15.0,
  };
}

// ── Helper: schedule computed properties ─────────────────────

export function getDailyPlannedHours(schedule: ScheduleConfig): number {
  let hours = schedule.shift1_hours;
  if (schedule.shifts_enabled >= 2) hours += (schedule.shift2_hours ?? 0);
  if (schedule.shifts_enabled >= 3) hours += (schedule.shift3_hours ?? 0);
  return hours;
}

export function getWeeklyBaseHours(schedule: ScheduleConfig): number {
  return getDailyPlannedHours(schedule) * schedule.work_days;
}

export function getWeeklyTotalHours(schedule: ScheduleConfig): number {
  let total = getWeeklyBaseHours(schedule);
  if (schedule.ot_enabled) {
    total += (schedule.weekday_ot_hours ?? 0) * schedule.work_days;
    total += (schedule.weekend_ot_hours ?? 0) * (schedule.weekend_ot_days ?? 0);
  }
  return total;
}

// ── Helper: create empty metrics ─────────────────────────────

export function createEmptyMetrics(): SimulationMetrics {
  return {
    throughput_by_product: new Map(),
    bundles_completed: 0,
    cycle_times: [],
    cycle_times_by_product: new Map(),
    station_busy_time: new Map(),
    station_pieces_processed: new Map(),
    station_queue_waits: new Map(),
    wip_samples: [],
    current_wip: 0,
    max_wip: 0,
    bundles_by_product: new Map(),
    bundles_in_system_samples: new Map(),
    current_bundles_by_product: new Map(),
    rework_count: 0,
    rework_by_station: new Map(),
    breakdown_events: 0,
    breakdown_time_lost: 0,
  };
}
