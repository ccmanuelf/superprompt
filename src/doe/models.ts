/**
 * Design of Experiments — TypeScript Types
 *
 * Supports: 2^k full factorial, 2^(k-p) fractional factorial,
 * Taguchi L-arrays, Box-Behnken, Central Composite designs.
 * ANOVA, main effects, interactions, response surface.
 */

// ── Enums ────────────────────────────────────────────────────

export type DesignType = 'full_factorial' | 'fractional' | 'taguchi' | 'box_behnken' | 'central_composite';
export type FactorType = 'numeric' | 'categorical';

// ── Input Models ─────────────────────────────────────────────

export interface Factor {
  id: string;
  name: string;
  type: FactorType;
  levels: number[];                // numeric values for each level
  level_labels?: string[];         // optional labels (e.g., ["Low","High"])
  unit?: string;
}

export interface ResponseVar {
  id: string;
  name: string;
  unit?: string;
  target?: number;                 // target value for desirability
  minimize?: boolean;              // true = lower is better, false = higher is better
  weight?: number;                 // weight for multi-response desirability (default 1)
}

export interface DOEConfig {
  name: string;
  design_type: DesignType;
  factors: Factor[];
  responses: ResponseVar[];
  replicates?: number;             // replications per run (default 1)
  randomize?: boolean;             // randomize run order (default true)
  blocks?: number;                 // number of blocks (default 1)
  // Fractional factorial
  resolution?: number;             // III, IV, V (for fractional)
  // Central Composite
  alpha?: number;                  // axial distance (default: sqrt(k) for rotatable)
  center_points?: number;          // center point runs (default: 3-5)
}

// ── Experiment Matrix ────────────────────────────────────────

export interface ExperimentRun {
  run_order: number;               // randomized order
  standard_order: number;          // standard (systematic) order
  block: number;
  factor_levels: Record<string, number>;  // factor_id → level value
  factor_coded: Record<string, number>;   // factor_id → coded value (-1, 0, +1)
  responses: Record<string, number | null>;  // response_id → measured value
  is_center_point: boolean;
  is_axial_point: boolean;
}

export interface ExperimentMatrix {
  runs: ExperimentRun[];
  total_runs: number;
  factors: string[];               // factor names
  responses: string[];             // response names
  design_type: DesignType;
  design_label: string;            // e.g., "2^3 Full Factorial"
}

// ── ANOVA Results ────────────────────────────────────────────

export interface ANOVARow {
  source: string;                  // factor name or interaction
  sum_of_squares: number;
  df: number;                      // degrees of freedom
  mean_square: number;
  f_value: number;
  p_value: number;
  contribution_pct: number;        // % contribution to total SS
  significant: boolean;            // p < 0.05
}

export interface ANOVATable {
  response_name: string;
  rows: ANOVARow[];
  total_ss: number;
  residual_ss: number;
  residual_df: number;
  r_squared: number;
  adj_r_squared: number;
  model_significant: boolean;
}

// ── Effects ──────────────────────────────────────────────────

export interface MainEffect {
  factor_id: string;
  factor_name: string;
  levels: number[];
  mean_responses: number[];        // mean response at each level
  effect_size: number;             // difference between high and low means
}

export interface InteractionEffect {
  factor_a: string;
  factor_b: string;
  factor_a_name: string;
  factor_b_name: string;
  // Matrix: mean response for each combination of levels
  combinations: Array<{
    level_a: number;
    level_b: number;
    mean_response: number;
  }>;
  interaction_strength: number;
}

// ── Desirability ─────────────────────────────────────────────

export interface DesirabilityResult {
  overall_desirability: number;    // 0-1 (geometric mean)
  per_response: Array<{
    response_name: string;
    desirability: number;
    predicted_value: number;
    target: number;
  }>;
  optimal_factors: Record<string, number>;  // factor_id → optimal level
}

// ── Full Analysis ────────────────────────────────────────────

export interface ResidualEntry {
  run_order: number;
  response_id: string;
  actual: number;
  predicted: number;
  residual: number;                  // actual - predicted
  std_residual: number;              // residual / residual_stddev
}

export interface DOEAnalysis {
  config_name: string;
  matrix: ExperimentMatrix;
  anova: ANOVATable[];             // one per response
  main_effects: MainEffect[];
  interactions: InteractionEffect[];
  residuals: ResidualEntry[];      // for residual plots (predicted vs actual)
  desirability?: DesirabilityResult;
  confirmation_runs: ConfirmationRun[];
  warnings: string[];
}

export interface ConfirmationRun {
  id: string;
  factor_levels: Record<string, number>;
  predicted: Record<string, number>;
  actual: Record<string, number | null>;
  status: 'pending' | 'completed';
}

// ── DB ───────────────────────────────────────────────────────

export interface SavedDOE {
  id: string;
  name: string;
  config_json: string;
  result_json?: string;
  created_at: number;
  updated_at: number;
}

// ── Constants ────────────────────────────────────────────────

export const DESIGN_LABELS: Record<DesignType, string> = {
  full_factorial: 'Full Factorial (2^k)',
  fractional: 'Fractional Factorial (2^(k-p))',
  taguchi: 'Taguchi L-Array',
  box_behnken: 'Box-Behnken',
  central_composite: 'Central Composite Design (CCD)',
};

// Standard Taguchi L-arrays
export const TAGUCHI_ARRAYS: Record<string, { factors: number; levels: number; runs: number; matrix: number[][] }> = {
  L4: { factors: 3, levels: 2, runs: 4, matrix: [
    [1,1,1],[1,2,2],[2,1,2],[2,2,1],
  ]},
  L8: { factors: 7, levels: 2, runs: 8, matrix: [
    [1,1,1,1,1,1,1],[1,1,1,2,2,2,2],[1,2,2,1,1,2,2],[1,2,2,2,2,1,1],
    [2,1,2,1,2,1,2],[2,1,2,2,1,2,1],[2,2,1,1,2,2,1],[2,2,1,2,1,1,2],
  ]},
  L9: { factors: 4, levels: 3, runs: 9, matrix: [
    [1,1,1,1],[1,2,2,2],[1,3,3,3],[2,1,2,3],[2,2,3,1],[2,3,1,2],
    [3,1,3,2],[3,2,1,3],[3,3,2,1],
  ]},
  L16: { factors: 15, levels: 2, runs: 16, matrix: [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,2,2,2,2,2,2,2,2],
    [1,1,1,2,2,2,2,1,1,1,1,2,2,2,2],[1,1,1,2,2,2,2,2,2,2,2,1,1,1,1],
    [1,2,2,1,1,2,2,1,1,2,2,1,1,2,2],[1,2,2,1,1,2,2,2,2,1,1,2,2,1,1],
    [1,2,2,2,2,1,1,1,1,2,2,2,2,1,1],[1,2,2,2,2,1,1,2,2,1,1,1,1,2,2],
    [2,1,2,1,2,1,2,1,2,1,2,1,2,1,2],[2,1,2,1,2,1,2,2,1,2,1,2,1,2,1],
    [2,1,2,2,1,2,1,1,2,1,2,2,1,2,1],[2,1,2,2,1,2,1,2,1,2,1,1,2,1,2],
    [2,2,1,1,2,2,1,1,2,2,1,1,2,2,1],[2,2,1,1,2,2,1,2,1,1,2,2,1,1,2],
    [2,2,1,2,1,1,2,1,2,2,1,2,1,1,2],[2,2,1,2,1,1,2,2,1,1,2,1,2,2,1],
  ]},
};
