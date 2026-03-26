/**
 * Value Stream Mapping — TypeScript Types
 *
 * Models for VSM process flow analysis with VA/NVA classification,
 * TIMWOODS waste categorization, and current/future state comparison.
 */

// ── Enums ────────────────────────────────────────────────────

export type TimeCategory = 'VA' | 'NVA' | 'BNVA';  // Value-Add, Non-Value-Add, Business-NVA (required but no value)

export type WasteType =
  | 'transport'
  | 'inventory'
  | 'motion'
  | 'waiting'
  | 'overproduction'
  | 'overprocessing'
  | 'defects'
  | 'skills';

export type FlowType = 'material' | 'information' | 'electronic';

export type KaizenPriority = 'high' | 'medium' | 'low';

// ── Process Step ─────────────────────────────────────────────

export interface ProcessStep {
  id: string;
  name: string;
  description?: string;
  sequence: number;              // order in the flow (1-based)
  // Time breakdown (minutes)
  cycle_time: number;            // actual processing time per unit
  changeover_time: number;       // setup/changeover between batches
  uptime_pct: number;            // machine availability % (default 100)
  // Classification
  category: TimeCategory;        // VA, NVA, or BNVA
  waste_types?: WasteType[];     // applicable waste categories
  // Capacity
  operators: number;             // headcount at this step
  batch_size?: number;           // units per batch (default 1)
  wip_before?: number;           // WIP inventory before this step (units)
  // Timing (for lead time calc)
  wait_time?: number;            // queue/wait time before step (minutes)
  transport_time?: number;       // transport time to next step (minutes)
}

// ── Inventory Point ──────────────────────────────────────────

export interface InventoryPoint {
  id: string;
  name: string;
  after_step_id: string;         // placed after this process step
  quantity: number;              // units of WIP/inventory
  days_of_supply?: number;       // DOS = qty / daily demand
  value?: number;                // $ value of inventory
}

// ── Information Flow ─────────────────────────────────────────

export interface InformationFlow {
  id: string;
  from_id: string;               // step or entity ID
  to_id: string;
  label: string;
  flow_type: FlowType;
  frequency?: string;            // e.g., "daily", "weekly", "per shift"
}

// ── Kaizen Burst ─────────────────────────────────────────────

export interface KaizenBurst {
  id: string;
  step_id: string;               // attached to this step
  description: string;
  priority: KaizenPriority;
  expected_improvement?: string;  // e.g., "Reduce cycle time 30%"
  owner?: string;
  target_date?: string;          // ISO date
}

// ── VSM Configuration ────────────────────────────────────────

export interface VSMConfig {
  name: string;
  product_family: string;
  customer_demand_per_day: number;
  available_minutes_per_day: number;  // working time (e.g., 460 = 8h - breaks)
  state: 'current' | 'future';
  steps: ProcessStep[];
  inventory_points?: InventoryPoint[];
  information_flows?: InformationFlow[];
  kaizen_bursts?: KaizenBurst[];
  // Supplier/Customer info
  supplier_name?: string;
  supplier_lead_time_days?: number;
  customer_name?: string;
  shipping_frequency?: string;
}

// ── Analysis Results ─────────────────────────────────────────

export interface LeadTimeBreakdown {
  step_id: string;
  step_name: string;
  category: TimeCategory;
  cycle_time: number;
  wait_time: number;
  transport_time: number;
  changeover_per_unit: number;   // changeover / batch_size
  total_step_time: number;       // sum of above
}

export interface TimewoodsBreakdown {
  waste_type: WasteType;
  label: string;
  total_minutes: number;
  pct_of_lead_time: number;
  contributing_steps: string[];  // step names
  suggestion: string;
}

export interface VSMAnalysis {
  map_name: string;
  state: 'current' | 'future';
  // Takt time
  takt_time: number;             // available_minutes / demand
  // Lead time
  total_lead_time: number;       // total time from raw material to shipment
  total_va_time: number;         // sum of VA cycle times
  total_nva_time: number;        // sum of NVA times
  total_bnva_time: number;       // sum of BNVA times
  total_wait_time: number;       // sum of queue/wait times
  total_transport_time: number;
  total_changeover_time: number;
  // PCE
  pce_pct: number;               // Process Cycle Efficiency = VA / lead time × 100
  // Lead time in different units
  lead_time_hours: number;
  lead_time_days: number;          // assuming 8h working day
  // Inventory
  total_wip_units: number;
  total_wip_days: number;        // total days of supply
  // Capacity
  total_operators: number;
  bottleneck_step: string;       // step with highest cycle time
  bottleneck_cycle_time: number;
  // Takt vs Bottleneck
  meets_takt: boolean;             // true if bottleneck C/T <= takt time
  takt_gap_minutes: number;        // takt - bottleneck C/T (positive = OK, negative = cannot meet demand)
  // Per-step breakdown
  lead_time_breakdown: LeadTimeBreakdown[];
  // TIMWOODS
  timwoods: TimewoodsBreakdown[];
  // Waterfall data (for chart)
  waterfall: WaterfallEntry[];
  // Warnings
  warnings: string[];
}

export interface WaterfallEntry {
  label: string;
  va_minutes: number;
  nva_minutes: number;
  wait_minutes: number;
  transport_minutes: number;
  cumulative: number;
}

// ── Comparison ───────────────────────────────────────────────

export interface VSMComparison {
  current: VSMAnalysis;
  future: VSMAnalysis;
  improvements: ImprovementMetric[];
  summary: string;
}

export interface ImprovementMetric {
  metric: string;
  current_value: number;
  future_value: number;
  change: number;
  change_pct: number;
  unit: string;
}

// ── DB Persistence ───────────────────────────────────────────

export interface SavedVSM {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Constants ────────────────────────────────────────────────

export const TIMWOODS_LABELS: Record<WasteType, string> = {
  transport: 'Transportation',
  inventory: 'Inventory',
  motion: 'Motion',
  waiting: 'Waiting',
  overproduction: 'Overproduction',
  overprocessing: 'Over-processing',
  defects: 'Defects',
  skills: 'Skills (underutilized)',
};

export const TIMWOODS_SUGGESTIONS: Record<WasteType, string> = {
  transport: 'Optimize layout to reduce material movement distance.',
  inventory: 'Implement pull system / kanban to reduce WIP.',
  motion: 'Apply 5S and ergonomic workstation design.',
  waiting: 'Balance line, reduce batch sizes, implement flow.',
  overproduction: 'Produce to takt time, use kanban signals.',
  overprocessing: 'Review specifications, simplify process steps.',
  defects: 'Implement poka-yoke, improve SPC, root cause analysis.',
  skills: 'Cross-train operators, involve team in kaizen.',
};
