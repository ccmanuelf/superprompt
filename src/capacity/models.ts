/**
 * Capacity Planning — TypeScript Types
 *
 * 12-step capacity calculation methodology adapted from kpi-operations.
 * Works at the LINE level (not operation level like S16 simulation).
 */

// ── Enums ────────────────────────────────────────────────────

export type ScenarioType =
  | 'overtime'
  | 'setup_reduction'
  | 'new_line'
  | 'three_shift'
  | 'absenteeism_spike'
  | 'efficiency_improvement'
  | 'subcontract'
  | 'multi_constraint';

export type DistributionType = 'normal' | 'triangular' | 'uniform';

export type BottleneckSeverity = 'critical' | 'warning' | 'ok';

// ── Input Models ─────────────────────────────────────────────

export interface CapacityLine {
  id: string;
  code: string;
  name: string;
  department?: string;
  max_operators: number;
  efficiency_factor: number;       // 0-1 (e.g., 0.85 = 85%)
  absenteeism_factor: number;      // 0-1 (e.g., 0.05 = 5%)
  standard_capacity_uph?: number;  // units per hour (optional reference)
  calendar_override?: CalendarConfig; // per-line calendar (overrides plan-level calendar)
}

export interface CalendarConfig {
  working_days: number;            // days in planning period
  shifts_per_day: number;          // 1-3
  hours_per_shift: number;         // typical 8.0
}

export interface DemandEntry {
  product: string;
  line_id: string;
  quantity: number;                // total units demanded
  sam_minutes?: number;            // Standard Allowed Minutes per unit
  hours?: number;                  // direct demand hours (if SAM not available)
  priority?: number;               // 1=highest
  required_date?: string;          // ISO date
}

export interface CapacityPlanConfig {
  name: string;
  period_label: string;            // e.g., "Week 13 - 2026" or "March 2026"
  period_start: string;            // ISO date
  period_end: string;              // ISO date
  lines: CapacityLine[];
  calendar: CalendarConfig;
  demands: DemandEntry[];
}

// ── 12-Step Analysis Results ─────────────────────────────────

export interface LineCapacityResult {
  line_id: string;
  line_code: string;
  line_name: string;
  department?: string;
  // Step inputs
  working_days: number;
  shifts_per_day: number;
  hours_per_shift: number;
  operators_available: number;
  efficiency_factor: number;
  absenteeism_factor: number;
  // Calculated (12-step)
  gross_hours: number;             // days × shifts × hours
  net_hours: number;               // gross × efficiency × (1 - absenteeism)
  capacity_hours: number;          // net × operators
  demand_hours: number;            // sum of demand for this line
  demand_units: number;            // total units demanded
  // Results
  utilization_pct: number;         // demand / capacity × 100
  available_hours: number;         // max(0, capacity - demand)
  over_capacity_hours: number;     // max(0, demand - capacity)
  is_bottleneck: boolean;
  bottleneck_severity: BottleneckSeverity;
  // Units-based throughput (if standard_capacity_uph is set)
  capacity_units?: number;         // capacity_hours × standard_capacity_uph
  throughput_rate_uph?: number;    // effective units per hour
}

export interface CapacityAnalysisResult {
  plan_name: string;
  period_label: string;
  period_start: string;
  period_end: string;
  analysis_timestamp: string;
  // Aggregates
  lines_analyzed: number;
  total_capacity_hours: number;
  total_demand_hours: number;
  overall_utilization_pct: number;
  bottleneck_count: number;
  // Per-line detail
  lines: LineCapacityResult[];
  // Ranked bottlenecks (sorted by utilization desc)
  constraint_ranking: ConstraintRank[];
  // Warnings for the user
  warnings: string[];
}

export interface ConstraintRank {
  rank: number;
  line_id: string;
  line_code: string;
  line_name: string;
  utilization_pct: number;
  over_capacity_hours: number;
  severity: BottleneckSeverity;
  recommendation: string;
}

// ── Scenario Models ──────────────────────────────────────────

export interface ScenarioParams {
  type: ScenarioType;
  name: string;
  description: string;
  // Type-specific params
  overtime_pct?: number;           // % increase in hours
  overtime_cost_per_hour?: number;
  setup_reduction_pct?: number;
  new_line?: Partial<CapacityLine>;
  target_shifts?: number;
  night_shift_efficiency?: number;
  absenteeism_new_pct?: number;
  efficiency_new_pct?: number;
  subcontract_pct?: number;
  subcontract_cost_per_unit?: number;
  affected_line_ids?: string[];    // empty = all lines
  // Multi-constraint: array of sub-scenarios
  sub_scenarios?: ScenarioParams[];
}

export interface ScenarioResult {
  scenario: ScenarioParams;
  baseline: CapacityAnalysisResult;
  projected: CapacityAnalysisResult;
  delta: ScenarioDelta;
}

export interface ScenarioDelta {
  capacity_hours_change: number;
  capacity_hours_change_pct: number;
  utilization_change_pct: number;
  bottlenecks_resolved: number;
  bottlenecks_remaining: number;
  additional_cost: number;
  additional_throughput_units: number;
  cost_per_additional_unit: number;
}

export interface ScenarioComparison {
  baseline: CapacityAnalysisResult;
  scenarios: ScenarioResult[];
  best_scenario: string;           // name of best scenario by cost-effectiveness
  recommendation: string;
}

// ── Monte Carlo Models ───────────────────────────────────────

export interface MonteCarloCapacityConfig {
  base_config: CapacityPlanConfig;
  replications: number;            // default 1000
  // Distribution overrides per parameter
  efficiency_distribution?: DistributionConfig;
  absenteeism_distribution?: DistributionConfig;
  demand_distribution?: DistributionConfig;
}

export interface DistributionConfig {
  type: DistributionType;
  // Normal: mean, stddev
  mean?: number;
  stddev?: number;
  // Triangular: min, mode, max
  min?: number;
  mode?: number;
  max?: number;
}

export interface CapacityDistributionStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface MonteCarloCapacityResults {
  replications: number;
  overall_utilization: CapacityDistributionStats;
  total_capacity_hours: CapacityDistributionStats;
  total_demand_hours: CapacityDistributionStats;
  bottleneck_probability: number;         // % of runs with at least 1 bottleneck
  per_line_utilization: Record<string, CapacityDistributionStats>;
  per_line_bottleneck_probability: Record<string, number>;
  // Confidence intervals
  confidence_90: { lower: number; upper: number };
  confidence_95: { lower: number; upper: number };
  confidence_99: { lower: number; upper: number };
}

// ── ROI Models ───────────────────────────────────────────────

export interface ROIInput {
  scenario_name: string;
  investment_cost: number;         // total investment $
  monthly_operating_cost?: number; // ongoing monthly cost $
  capacity_gain_hours: number;     // additional capacity hours gained
  revenue_per_unit?: number;       // $ per unit produced
  units_per_hour?: number;         // throughput rate
  discount_rate?: number;          // annual % for NPV (default 10%)
  analysis_months?: number;        // horizon (default 24)
}

export interface ROIResult {
  scenario_name: string;
  investment_cost: number;
  monthly_operating_cost: number;
  // Capacity impact
  capacity_gain_hours: number;
  additional_units_per_month: number;
  additional_revenue_per_month: number;
  // Financial metrics
  monthly_net_benefit: number;
  payback_months: number;
  npv: number;
  roi_pct: number;
  irr_pct: number | null;         // null if cannot compute
  // Break-even
  break_even_utilization_pct: number;
  cost_per_additional_unit: number;
  // Summary
  recommendation: string;
}

// ── Heatmap Data ─────────────────────────────────────────────

export interface HeatmapCell {
  line_id: string;
  line_code: string;
  period: string;                  // e.g., "Day 1", "Week 1", "Shift 1"
  utilization_pct: number;
  severity: BottleneckSeverity;
}

export interface UtilizationHeatmap {
  rows: string[];                  // line codes
  columns: string[];               // period labels
  cells: HeatmapCell[];
}

// ── DB Persistence Models ────────────────────────────────────

export interface CapacityPlan {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Defaults & Constants ─────────────────────────────────────

export const BOTTLENECK_THRESHOLD_CRITICAL = 95;
export const BOTTLENECK_THRESHOLD_WARNING = 80;
export const DEFAULT_EFFICIENCY = 0.85;
export const DEFAULT_ABSENTEEISM = 0.05;
export const DEFAULT_REPLICATIONS = 1000;
export const DEFAULT_DISCOUNT_RATE = 0.10;
export const DEFAULT_ANALYSIS_MONTHS = 24;

export const SCENARIO_DEFAULTS: Record<ScenarioType, Partial<ScenarioParams>> = {
  overtime: {
    name: 'Overtime +20%',
    description: 'Add 20% overtime to increase available hours',
    overtime_pct: 20,
    overtime_cost_per_hour: 15,
  },
  setup_reduction: {
    name: 'Setup Time Reduction -30%',
    description: 'Reduce setup/changeover times by 30% via process improvement',
    setup_reduction_pct: 30,
  },
  new_line: {
    name: 'Add Production Line',
    description: 'Add a new production line to increase capacity',
    new_line: {
      code: 'NEW_LINE',
      name: 'New Production Line',
      max_operators: 10,
      efficiency_factor: 0.75,
      absenteeism_factor: 0.05,
    },
  },
  three_shift: {
    name: '3-Shift Operation',
    description: 'Enable 3-shift operation across affected lines',
    target_shifts: 3,
    night_shift_efficiency: 0.80,
  },
  absenteeism_spike: {
    name: 'Absenteeism Spike 15%',
    description: 'Simulate 15% absenteeism spike scenario',
    absenteeism_new_pct: 0.15,
  },
  efficiency_improvement: {
    name: 'Efficiency +10%',
    description: 'Improve line efficiency by 10 percentage points',
    efficiency_new_pct: 0.10,
  },
  subcontract: {
    name: 'Subcontract 40%',
    description: 'Subcontract 40% of demand to external supplier',
    subcontract_pct: 40,
    subcontract_cost_per_unit: 2.50,
  },
  multi_constraint: {
    name: 'Combined Scenario',
    description: 'Apply multiple constraints simultaneously',
    sub_scenarios: [],
  },
};
