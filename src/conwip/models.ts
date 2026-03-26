/**
 * CONWIP & Heijunka Production Leveling — Types
 *
 * CONWIP: Constant Work-In-Process — pull system with fixed WIP tokens.
 * Heijunka: Production leveling — smooth product mix across time slots.
 */

// ── Enums ────────────────────────────────────────────────────

export type StageStatus = 'idle' | 'active' | 'blocked';
export type SlotStatus = 'empty' | 'assigned' | 'completed';

// ── CONWIP ───────────────────────────────────────────────────

export interface ProductionStage {
  id: string;
  name: string;
  sequence: number;
  cycle_time_minutes: number;
  capacity_per_hour: number;
}

export interface CONWIPConfig {
  name: string;
  stages: ProductionStage[];
  wip_limit: number;               // total tokens in system
  products: ProductType[];
  available_minutes_per_day: number;
  demand_per_day: number;
}

export interface ProductType {
  id: string;
  name: string;
  mix_pct: number;                  // % of total demand
  cycle_time_minutes: number;       // avg across stages
  changeover_minutes: number;       // setup when switching to this product
  color?: string;
}

export interface CONWIPToken {
  id: string;
  product_id: string;
  product_name: string;
  current_stage_id: string;
  current_stage_name: string;
  entered_at: number;               // minutes from start
  status: 'queued' | 'processing' | 'done';
}

export interface CONWIPAnalysis {
  config_name: string;
  wip_limit: number;
  tokens: CONWIPToken[];
  stage_utilization: StageUtilization[];
  throughput_per_hour: number;
  avg_cycle_time: number;
  wip_turns_per_day: number;
  recommendations: string[];
}

export interface StageUtilization {
  stage_id: string;
  stage_name: string;
  wip_count: number;
  utilization_pct: number;
  is_bottleneck: boolean;
}

export interface TokenFlowSnapshot {
  time_minutes: number;
  stage_wip: Record<string, number>;   // stage_id → WIP count at this time
  total_wip: number;
  completed_units: number;
}

export interface TokenFlowTimeSeries {
  snapshots: TokenFlowSnapshot[];
  total_completed: number;
  interval_minutes: number;
}

// ── Heijunka ─────────────────────────────────────────────────

export interface HeijunkaConfig {
  name: string;
  products: ProductType[];
  takt_time_minutes: number;
  pitch_minutes: number;            // takt × pack-out quantity
  pack_out_quantity: number;
  slots_per_shift: number;          // how many pitch intervals per shift
  shifts_per_day: number;
  demand_per_day: number;
}

export interface HeijunkaSlot {
  shift: number;
  slot: number;                     // 1-based within shift
  product_id: string;
  product_name: string;
  quantity: number;
  color: string;
  status: SlotStatus;
}

export interface HeijunkaBox {
  products: string[];               // product names (rows)
  slots: string[];                  // time slot labels (columns)
  cells: HeijunkaSlot[];
  shifts: number;
}

export interface HeijunkaAnalysis {
  config_name: string;
  takt_time: number;
  pitch: number;
  heijunka_box: HeijunkaBox;
  leveling_score: number;           // 0-100 (100=perfectly level)
  ideal_mix: ProductMix[];
  actual_mix: ProductMix[];
  changeover_count: number;
  total_changeover_minutes: number;
  changeover_suggestions: string[];
  shift_plans: ShiftPlan[];
}

export interface ProductMix {
  product_id: string;
  product_name: string;
  target_pct: number;
  actual_pct: number;
  deviation_pct: number;
}

export interface ShiftPlan {
  shift: number;
  slots: HeijunkaSlot[];
  total_quantity: number;
  changeovers: number;
  changeover_minutes: number;
}

// ── Combined Config ──────────────────────────────────────────

export interface ConwipHeijunkaConfig {
  name: string;
  conwip?: CONWIPConfig;
  heijunka?: HeijunkaConfig;
}

// ── DB ───────────────────────────────────────────────────────

export interface SavedConwip {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Constants ────────────────────────────────────────────────

export const PRODUCT_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
];
