/**
 * Theory of Constraints & WIP Tracking — TypeScript Types
 *
 * Goldratt's TOC methodology: identify constraint, exploit it,
 * subordinate everything else, elevate if needed, repeat.
 */

// ── Enums ────────────────────────────────────────────────────

export type BufferZone = 'green' | 'yellow' | 'red';
export type BufferType = 'time' | 'capacity' | 'stock';
export type WIPStatus = 'ok' | 'warning' | 'critical';

// ── Work Center ──────────────────────────────────────────────

export interface WorkCenter {
  id: string;
  name: string;
  department?: string;
  capacity_units_per_hour: number;  // max throughput rate
  available_hours_per_day: number;  // e.g., 8
  operators: number;
  current_wip: number;              // units currently in queue + processing
  wip_limit?: number;               // max WIP allowed (optional)
  // For utilization tracking
  actual_output_per_hour?: number;  // measured output rate
  planned_load_hours?: number;      // demand hours planned
}

// ── TOC Configuration ────────────────────────────────────────

export interface TOCConfig {
  name: string;
  work_centers: WorkCenter[];
  // Product economics
  selling_price_per_unit: number;
  total_variable_cost_per_unit: number;  // raw material + direct labor
  operating_expense_per_period: number;  // fixed costs (rent, salaries, etc.)
  investment: number;                     // total invested capital
  // Demand
  demand_units_per_day: number;
  available_hours_per_day: number;
  // Buffer settings
  shipping_buffer_hours?: number;   // time buffer before shipping (default: lead time / 3)
  constraint_buffer_hours?: number; // time buffer before constraint
  assembly_buffer_hours?: number;   // time buffer before assembly
}

// ── CCR (Capacity Constraint Resource) ───────────────────────

export interface ConstraintAnalysis {
  ccr_id: string;
  ccr_name: string;
  ccr_utilization_pct: number;
  ccr_load_hours: number;
  ccr_available_hours: number;
  ccr_excess_capacity_hours: number;
  // All work centers ranked by utilization
  work_center_ranking: WorkCenterUtilization[];
  // System throughput limited by CCR
  max_system_throughput_per_day: number;
  demand_coverage_pct: number;
}

export interface WorkCenterUtilization {
  id: string;
  name: string;
  capacity_per_hour: number;
  load_hours: number;
  available_hours: number;
  utilization_pct: number;
  is_ccr: boolean;
  excess_hours: number;
}

// ── Buffer Management ────────────────────────────────────────

export interface BufferConfig {
  id: string;
  name: string;
  buffer_type: BufferType;
  total_size: number;              // total buffer (hours, units, or capacity-hours)
  current_consumption: number;     // how much of buffer is consumed
  unit: string;                    // 'hours', 'units', 'capacity-hours'
}

export interface BufferStatus {
  id: string;
  name: string;
  buffer_type: BufferType;
  total_size: number;
  consumed: number;
  remaining: number;
  consumption_pct: number;
  zone: BufferZone;
  action: string;                  // recommended action
}

// ── Throughput Accounting ────────────────────────────────────

export interface ThroughputAccounting {
  // Per-unit
  selling_price: number;
  tvc: number;                     // Total Variable Cost
  throughput_per_unit: number;     // T = Price - TVC
  // System
  throughput_per_day: number;      // T × units/day
  throughput_per_period: number;   // T × units/period
  operating_expense: number;       // OE
  net_profit: number;              // NP = T - OE
  roi_pct: number;                 // ROI = NP / Investment × 100
  productivity: number;            // T / OE
  investment_turns: number;        // T / Investment
  // Constraint economics
  throughput_per_constraint_minute: number;  // T / constraint minutes per unit
  constraint_utilization_pct: number;
  // What-if
  revenue_lost_per_hour_constraint_down: number;
}

// ── Drum-Buffer-Rope ─────────────────────────────────────────

export interface DBRSchedule {
  drum_rate: number;               // constraint output rate (units/hour)
  drum_work_center: string;
  // Buffers
  shipping_buffer: BufferStatus;
  constraint_buffer: BufferStatus;
  assembly_buffer?: BufferStatus;
  // Rope releases
  rope_releases: RopeRelease[];
  // Summary
  planned_throughput_per_day: number;
  lead_time_hours: number;
}

export interface RopeRelease {
  sequence: number;
  release_time_hours: number;      // hours from start of day
  work_center_id: string;
  work_center_name: string;
  units: number;
  notes: string;
}

// ── WIP Tracking ─────────────────────────────────────────────

export interface WIPGauge {
  work_center_id: string;
  work_center_name: string;
  current_wip: number;
  wip_limit: number;
  utilization_pct: number;
  status: WIPStatus;
  hours_of_work: number;           // WIP / capacity_per_hour
}

export interface WIPSnapshot {
  timestamp: number;
  work_centers: WIPGauge[];
  total_wip: number;
  total_wip_value: number;         // WIP × TVC
}

// ── Throughput Trend ─────────────────────────────────────────

export interface ThroughputDataPoint {
  period: string;                  // date or label
  throughput_units: number;
  throughput_dollars: number;
  constraint_utilization_pct: number;
  wip_units: number;
}

// ── Full TOC Analysis Result ─────────────────────────────────

export interface TOCAnalysis {
  config_name: string;
  timestamp: string;
  constraint: ConstraintAnalysis;
  throughput: ThroughputAccounting;
  dbr: DBRSchedule;
  wip_gauges: WIPGauge[];
  total_wip: number;
  five_focusing_steps: string[];   // Goldratt's 5 focusing steps applied
  warnings: string[];
}

// ── DB Persistence ───────────────────────────────────────────

export interface SavedTOC {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Constants ────────────────────────────────────────────────

export const BUFFER_GREEN_THRESHOLD = 33;   // 0-33% consumed = green
export const BUFFER_YELLOW_THRESHOLD = 67;  // 34-67% = yellow
// >67% = red

export const WIP_WARNING_THRESHOLD = 80;    // % of WIP limit
export const WIP_CRITICAL_THRESHOLD = 95;
