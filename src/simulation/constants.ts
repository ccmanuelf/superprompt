/**
 * Production Line Simulation v3.0 — Constants and Defaults
 *
 * Ported from kpi-operations SimPy V2 (constants.py).
 * Central location for all default values, thresholds, and configuration limits.
 */

// ── Version ──────────────────────────────────────────────────

export const ENGINE_VERSION = '3.0.0';

// ── Configuration Limits ─────────────────────────────────────

export const MAX_PRODUCTS = 5;
export const MAX_OPERATIONS_PER_PRODUCT = 50;
export const MAX_TOTAL_OPERATIONS = 100;
export const MAX_HORIZON_DAYS = 7;
export const MAX_BUNDLE_SIZE = 100;
export const MAX_OPERATORS_PER_STATION = 20;

// ── Operation Defaults ───────────────────────────────────────

export const DEFAULT_SEQUENCE = 'Assembly';
export const DEFAULT_GROUPING = '';
export const DEFAULT_OPERATORS = 1;
export const DEFAULT_VARIABILITY = 'triangular' as const;
export const DEFAULT_REWORK_PCT = 0.0;
export const DEFAULT_GRADE_PCT = 85.0;
export const DEFAULT_FPD_PCT = 15.0;

// ── Schedule Defaults ────────────────────────────────────────

export const DEFAULT_SHIFTS_ENABLED = 1;
export const DEFAULT_SHIFT_HOURS = 8.0;
export const DEFAULT_WORK_DAYS = 5;
export const DEFAULT_OT_ENABLED = false;

// ── Demand Defaults ──────────────────────────────────────────

export const DEFAULT_BUNDLE_SIZE = 1;
export const DEFAULT_HORIZON_DAYS = 1;

// ── Bottleneck Detection Thresholds ──────────────────────────

/** Utilization >= this is a bottleneck */
export const BOTTLENECK_UTILIZATION_THRESHOLD = 95.0;
/** Utilization <= this (with operators > 1) is a potential donor */
export const DONOR_UTILIZATION_THRESHOLD = 70.0;

// ── Coverage Status Thresholds (Block 1) ─────────────────────

/** Coverage >= this is "OK" (surplus capacity) */
export const COVERAGE_OK_THRESHOLD = 110.0;
/** Coverage >= this and < OK is "Tight" */
export const COVERAGE_TIGHT_THRESHOLD = 90.0;

// ── Bundle Transition Times ──────────────────────────────────

/** Bundles <= this use small transition time */
export const SMALL_BUNDLE_THRESHOLD = 5;
export const SMALL_BUNDLE_TRANSITION_SECONDS = 1.0;
export const LARGE_BUNDLE_TRANSITION_SECONDS = 5.0;

// ── Variability Parameters ───────────────────────────────────

export const TRIANGULAR_VARIABILITY_MIN = -0.10;
export const TRIANGULAR_VARIABILITY_MAX = 0.10;
export const TRIANGULAR_VARIABILITY_MODE = 0.0;

// ── Processing Time ──────────────────────────────────────────

/** Minimum processing time to prevent zero/negative */
export const MIN_PROCESS_TIME_MINUTES = 0.01;

// ── Validation Thresholds ────────────────────────────────────

export const DEMAND_CONSISTENCY_TOLERANCE_PCT = 5.0;
export const MIX_PERCENTAGE_TOLERANCE = 0.1;
export const MACHINE_TOOL_SIMILARITY_THRESHOLD = 0.8;
export const THEORETICAL_CAPACITY_BUFFER = 1.1;

// ── WIP Sampling ─────────────────────────────────────────────

export const WIP_SAMPLE_INTERVAL_MINUTES = 5.0;

// ── Formula Descriptions (Block 8) ───────────────────────────

export const FORMULA_DESCRIPTIONS: Record<string, string> = {
  processing_time: 'SAM × (1 + Variability + FPD_pct/100 + (100-Grade_pct)/100)',
  bundle_transition: `${SMALL_BUNDLE_TRANSITION_SECONDS}s if bundle_size ≤ ${SMALL_BUNDLE_THRESHOLD}, else ${LARGE_BUNDLE_TRANSITION_SECONDS}s`,
  utilization: '(Busy_Time / Available_Time) × 100',
  bottleneck_detection: `Utilization >= ${BOTTLENECK_UTILIZATION_THRESHOLD}%`,
  donor_detection: `Utilization <= ${DONOR_UTILIZATION_THRESHOLD}% AND operators > 1`,
};

// ── Limitations (Block 8) ────────────────────────────────────

export const SIMULATION_LIMITATIONS: string[] = [
  'Single replication run — results represent one possible outcome',
  'Weekly capacity assumes uniform daily production without day-of-week effects',
  'Learning curves and dynamic skill improvements are not modeled',
  'Material availability and supply chain constraints are assumed perfect',
  'Quality costs are included but not second-order effects like operator morale',
  'Bundle rework extracts single pieces; rest of bundle continues forward',
  'Equipment breakdowns add fixed delay; no progressive degradation modeled',
];

// ── Enhancement Constants (V3 additions) ─────────────────────

/** Default breakdown delay in minutes (V2 fixed, V3 uses MTBF/MTTR when configured) */
export const DEFAULT_BREAKDOWN_DELAY_MINUTES = 30.0;

/** Default shift break pattern: 2×15min + 1×30min per 8-hour shift */
export const DEFAULT_BREAK_PATTERN = {
  breaks: [
    { afterMinutes: 120, durationMinutes: 15 },  // 2h into shift
    { afterMinutes: 240, durationMinutes: 30 },  // 4h (lunch)
    { afterMinutes: 360, durationMinutes: 15 },  // 6h into shift
  ],
};

/** Monte Carlo defaults */
export const DEFAULT_MONTE_CARLO_REPLICATIONS = 30;
export const MONTE_CARLO_MAX_REPLICATIONS = 100;
