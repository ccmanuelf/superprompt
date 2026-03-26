/**
 * Job Sequencing — TypeScript Types
 *
 * Job-shop scheduling with dispatching rules and genetic algorithm optimization.
 * Works at the JOB level — decides WHICH ORDER to process jobs on machines.
 */

// ── Enums ────────────────────────────────────────────────────

export type DispatchRule = 'FIFO' | 'SPT' | 'LPT' | 'EDD' | 'CR' | 'SLACK';

export type ObjectiveType = 'makespan' | 'lateness' | 'setup_time' | 'weighted';

export type JobStatus = 'pending' | 'in_progress' | 'completed';

// ── Input Models ─────────────────────────────────────────────

export interface Job {
  id: string;
  name: string;
  product: string;
  quantity: number;
  processing_minutes: number;      // total processing time
  due_date?: string;               // ISO date string
  priority?: number;               // 1=highest
  arrival_time?: number;           // minutes from start (default 0)
  machine_id?: string;             // specific machine requirement (null = any)
  status?: JobStatus;
  started_at?: number;             // actual start (minutes)
  completed_at?: number;           // actual completion (minutes)
}

export interface Machine {
  id: string;
  name: string;
  capacity_hours_per_day?: number; // default 8
  efficiency?: number;             // 0-1 (default 1.0)
}

export interface SetupEntry {
  from_product: string;
  to_product: string;
  setup_minutes: number;
}

export interface SequencerConfig {
  name: string;
  jobs: Job[];
  machines: Machine[];
  setup_matrix?: SetupEntry[];
  horizon_minutes?: number;        // planning horizon (auto-calculated if not set)
  planning_start_date?: string;    // ISO date for due-date reference (default: today)
  working_hours_per_day?: number;  // default: 8
}

// ── Schedule Output ──────────────────────────────────────────

export interface ScheduleEntry {
  job_id: string;
  job_name: string;
  product: string;
  machine_id: string;
  machine_name: string;
  start_time: number;              // minutes from horizon start
  end_time: number;                // minutes
  processing_time: number;         // actual processing minutes
  setup_time: number;              // changeover minutes before this job
  due_date_minutes?: number;       // due date in minutes from start
  is_late: boolean;
  lateness_minutes: number;        // max(0, end_time - due_date)
  sequence_position: number;       // 1-based position in machine sequence
}

export interface ScheduleResult {
  rule_or_method: string;          // e.g. "SPT", "GA", "MiniZinc"
  entries: ScheduleEntry[];
  metrics: ScheduleMetrics;
  computation_ms: number;
  warnings?: string[];
}

export interface ScheduleMetrics {
  makespan: number;                // time to complete all jobs
  total_flow_time: number;         // sum of completion times
  avg_flow_time: number;           // mean completion time
  total_lateness: number;          // sum of lateness (only late jobs)
  max_lateness: number;            // worst lateness
  num_late_jobs: number;
  on_time_pct: number;             // % of jobs completed on/before due date
  total_setup_time: number;        // total changeover time
  avg_utilization_pct: number;     // avg machine utilization
  total_idle_time: number;         // total machine idle time
}

// ── GA Configuration ─────────────────────────────────────────

export interface GAConfig {
  population_size: number;         // default 100
  generations: number;             // default 200
  crossover_rate: number;          // default 0.8
  mutation_rate: number;           // default 0.15
  elitism_count: number;           // default 2
  tournament_size: number;         // default 5
  objective: ObjectiveType;        // default 'makespan'
  // Weighted objective weights (sum to 1.0)
  weight_makespan?: number;        // default 0.4
  weight_lateness?: number;        // default 0.3
  weight_setup?: number;           // default 0.3
}

export interface GAResult extends ScheduleResult {
  best_fitness: number;
  fitness_history: number[];       // best fitness per generation
  convergence_generation: number;  // generation where improvement stopped
}

// ── Comparison ───────────────────────────────────────────────

export interface RuleComparison {
  config_name: string;
  rules: ScheduleResult[];
  best_makespan: string;           // rule name
  best_lateness: string;           // rule name
  best_setup: string;              // rule name
  best_overall: string;            // rule name (balanced)
  recommendation: string;
}

// ── Gantt Chart Data ─────────────────────────────────────────

export interface GanttBar {
  machine_id: string;
  machine_name: string;
  job_id: string;
  job_name: string;
  product: string;
  start: number;
  end: number;
  is_setup: boolean;               // true = changeover bar
  is_late: boolean;
  color: string;
}

export interface GanttData {
  bars: GanttBar[];
  machines: string[];              // machine names (Y axis)
  horizon: number;                 // total time span
  due_date_markers: Array<{ job_id: string; time: number }>;
}

// ── DB Persistence ───────────────────────────────────────────

export interface SavedSchedule {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Defaults ─────────────────────────────────────────────────

export const DEFAULT_GA_CONFIG: GAConfig = {
  population_size: 100,
  generations: 200,
  crossover_rate: 0.8,
  mutation_rate: 0.15,
  elitism_count: 2,
  tournament_size: 5,
  objective: 'makespan',
  weight_makespan: 0.4,
  weight_lateness: 0.3,
  weight_setup: 0.3,
};

export const ALL_RULES: DispatchRule[] = ['FIFO', 'SPT', 'LPT', 'EDD', 'CR', 'SLACK'];

// Product colors for Gantt chart (deterministic by product name hash)
export function productColor(product: string): string {
  const COLORS = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
    '#86bcb6', '#8cd17d', '#b6992d', '#499894', '#e15759',
  ];
  let hash = 0;
  for (let i = 0; i < product.length; i++) {
    hash = ((hash << 5) - hash + product.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}
