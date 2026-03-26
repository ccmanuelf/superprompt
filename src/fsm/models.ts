/**
 * State Machine Visual Simulator — Types
 *
 * Manufacturing-focused FSMs for DES visualization.
 * Each resource (machine, product, AGV) is modeled as an FSM with
 * explicit states that map to the implicit states in the S16 DES engine.
 *
 * DES Connection: DES models change system state only at event times
 * (job finishes, transfer completes, failure occurs) — which is exactly
 * how FSM transitions work. Representing each resource as an FSM
 * makes behavior explicit, visual, and testable.
 */

// ── Enums ────────────────────────────────────────────────────

export type SimMode = 'manual' | 'auto' | 'step' | 'fast_forward';

export type ValidationSeverity = 'error' | 'warning' | 'info';

// ── Manufacturing State Types ────────────────────────────────
// These mirror the 9 implicit states from the S16 DES engine

export type MfgStateType =
  | 'idle'
  | 'processing'
  | 'queued'
  | 'changeover'
  | 'broken_down'
  | 'starved'
  | 'blocked'
  | 'on_break'
  | 'warmup'
  | 'custom';

export const MFG_STATE_COLORS: Record<MfgStateType, string> = {
  idle: '#76b7b2',
  processing: '#59a14f',
  queued: '#f28e2b',
  changeover: '#edc949',
  broken_down: '#e15759',
  starved: '#ff9da7',
  blocked: '#af7aa1',
  on_break: '#bab0ac',
  warmup: '#9c755f',
  custom: '#4e79a7',
};

export const MFG_STATE_LABELS: Record<MfgStateType, string> = {
  idle: 'Idle',
  processing: 'Processing',
  queued: 'Queued / Waiting',
  changeover: 'Changeover / Setup',
  broken_down: 'Breakdown',
  starved: 'Starved (no material)',
  blocked: 'Blocked (WIP limit)',
  on_break: 'Shift Break',
  warmup: 'Warmup',
  custom: 'Custom State',
};

// ── Core FSM Models ──────────────────────────────────────────

export interface FSMState {
  id: string;
  name: string;
  mfg_type: MfgStateType;
  is_initial: boolean;
  is_final: boolean;
  // Visual positioning (for canvas)
  x: number;
  y: number;
  // Actions
  entry_action?: string;           // e.g., "Start timer", "Increment WIP"
  exit_action?: string;
  // Timing (for simulation)
  min_duration?: number;           // min time in this state (minutes)
  max_duration?: number;           // max time
  avg_duration?: number;           // expected time
}

export interface FSMTransition {
  id: string;
  from_state_id: string;
  to_state_id: string;
  event: string;                   // trigger event (e.g., "job_arrives", "processing_complete")
  guard?: string;                  // condition (e.g., "wip < limit", "material_available")
  action?: string;                 // action on transition (e.g., "release_resource")
  probability?: number;            // 0-1 (for stochastic transitions)
  priority?: number;               // for conflicting transitions (lower = higher priority)
}

export interface FSMDefinition {
  id: string;
  name: string;
  description?: string;
  template?: string;               // template name (e.g., "cnc_machine", "conveyor")
  states: FSMState[];
  transitions: FSMTransition[];
  // Metadata
  resource_type?: string;          // "machine", "product", "agv", "operator"
}

// ── FSM Configuration ────────────────────────────────────────

export interface FSMConfig {
  name: string;
  machines: FSMDefinition[];       // one FSM per resource
  // Simulation settings
  sim_duration_minutes: number;
  event_queue?: FSMEvent[];        // pre-loaded events for replay
  auto_speed_ms?: number;          // delay between auto steps (default 500)
}

// ── Simulation Events ────────────────────────────────────────

export interface FSMEvent {
  id: string;
  time: number;                    // minutes from start
  machine_id: string;
  event_name: string;              // matches transition.event
  data?: Record<string, unknown>;
}

// ── Simulation State ─────────────────────────────────────────

export interface FSMSimulationState {
  time: number;
  machines: MachineState[];
  event_log: EventLogEntry[];
  pending_events: FSMEvent[];
  completed: boolean;
}

export interface MachineState {
  machine_id: string;
  machine_name: string;
  current_state_id: string;
  current_state_name: string;
  current_mfg_type: MfgStateType;
  entered_at: number;
  state_history: StateHistoryEntry[];
}

export interface StateHistoryEntry {
  state_id: string;
  state_name: string;
  mfg_type: MfgStateType;
  entered_at: number;
  exited_at: number;
  duration: number;
  trigger_event: string;
}

export interface EventLogEntry {
  time: number;
  machine_id: string;
  machine_name: string;
  event: string;
  from_state: string;
  to_state: string;
  guard_result?: boolean;
}

// ── Analysis Results ─────────────────────────────────────────

export interface FSMAnalysis {
  config_name: string;
  total_time: number;
  machines: MachineAnalysis[];
  system_metrics: SystemMetrics;
  validation: ValidationResult;
}

export interface MachineAnalysis {
  machine_id: string;
  machine_name: string;
  state_residence: StateResidence[];
  transition_count: number;
  total_processing_time: number;
  total_idle_time: number;
  total_breakdown_time: number;
  utilization_pct: number;         // processing / total × 100
  availability_pct: number;        // (total - breakdown) / total × 100
  states_visited: number;
}

export interface StateResidence {
  state_id: string;
  state_name: string;
  mfg_type: MfgStateType;
  total_time: number;
  pct_of_total: number;
  visit_count: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
}

export interface SystemMetrics {
  total_transitions: number;
  avg_utilization_pct: number;
  avg_availability_pct: number;
  bottleneck_machine?: string;     // lowest utilization
  most_breakdowns_machine?: string;
}

// ── Validation ───────────────────────────────────────────────

export interface ValidationIssue {
  severity: ValidationSeverity;
  machine_id: string;
  message: string;
}

export interface ValidationResult {
  is_valid: boolean;
  issues: ValidationIssue[];
  reachability: Record<string, string[]>;  // machine_id → unreachable state IDs
  deadlock_states: Record<string, string[]>; // machine_id → deadlock state IDs (no outgoing transitions)
  has_initial_states: boolean;
}

// ── Templates ────────────────────────────────────────────────

export interface FSMTemplate {
  name: string;
  label: string;
  description: string;
  resource_type: string;
  definition: Omit<FSMDefinition, 'id' | 'name'>;
}

// ── S16 Bridge ───────────────────────────────────────────────

export interface S16BridgeResult {
  machine_id: string;
  machine_name: string;
  // State times derived from S16 simulation metrics
  processing_minutes: number;
  idle_minutes: number;
  queued_minutes: number;
  breakdown_minutes: number;
  changeover_minutes: number;
  utilization_pct: number;
  // Mapped state residence
  state_residence: StateResidence[];
}

// ── DB ───────────────────────────────────────────────────────

export interface SavedFSM {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}
