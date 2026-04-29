/**
 * Eval pipeline schemas — Phase 1 (rc.98).
 *
 * Adapted from skill-creator-v2 (Apache-2.0,
 * https://github.com/olelehmann1337/marketing-os-workshop/tree/main/plugins/marketing-os-workshop/skills/skill-creator-v2).
 * Upstream uses a filesystem-based workflow with separate evals.json,
 * grading.json, metrics.json, timing.json, benchmark.json files. Luna
 * stores everything in SQLite via Knex (cross-dialect, queryable,
 * multi-user-aware) so the schemas here are normalized SQL rows rather
 * than nested JSON files. Field names mirror the upstream where it
 * matters for future Phase 2-4 portability.
 *
 * Phase 1 deliberately omits these upstream-schema concepts:
 *   - claims extraction (grader Step 4)
 *   - user_notes_summary (no user_notes.md in Luna)
 *   - execution_metrics tool_calls breakdown (claude -p doesn't expose
 *     it in stream-json the way Claude Code's Task does)
 *   - benchmark.json mean ± stddev aggregation (Phase 2)
 *   - history.json version progression (Phase 3)
 *   - comparison.json blind A/B (Phase 3)
 *   - analysis.json post-hoc analyzer (Phase 3)
 */

/** Configuration we evaluate the skill against. */
export type EvalConfiguration = 'with_skill' | 'without_skill';

/** Lifecycle of an EvalSession or EvalRun row. */
export type EvalStatus = 'queued' | 'running' | 'completed' | 'failed';

// ── DB row shapes ───────────────────────────────────────────────────

/**
 * One eval session — what the user invoked /skill eval against. Owns
 * a set of test prompts + expectations, fans out into N runs, and
 * carries an aggregate status + pass-rate when complete.
 */
export interface EvalSession {
  id: number;
  chat_id: string;                          // who invoked it (per-chat scoping)
  skill_name: string;                       // skill being evaluated (must exist at session start)
  status: EvalStatus;
  /** JSON-encoded string[] of test prompts. */
  prompts_json: string;
  /** JSON-encoded string[] of expectations to grade against each output. */
  expectations_json: string;
  /** Number of times to repeat each (prompt × configuration). Default 2 in Phase 1. */
  runs_per_config: number;
  /** JSON-encoded EvalConfiguration[]. Default ["with_skill", "without_skill"]. */
  configurations_json: string;
  /** Total number of claude -p calls planned (baselines + grader calls). Capped at MAX_EVAL_CALLS_PER_RUN. */
  total_calls_planned: number;
  /** Aggregate pass rate across all expectations across all runs. Set on completion. */
  pass_rate: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
}

/**
 * One run of one (prompt × configuration × run_number) triple. Captures
 * the raw output, latency, and any subprocess error before grading.
 */
export interface EvalRun {
  id: number;
  session_id: number;
  prompt_idx: number;                       // 0-based index into prompts_json
  configuration: EvalConfiguration;
  run_number: number;                       // 1..runs_per_config
  status: EvalStatus;
  output_text: string | null;
  duration_ms: number | null;
  output_chars: number | null;
  exit_code: number | null;
  errors_encountered: number;               // 0 or 1 typically
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
}

/**
 * One expectation graded against one run's output. Flattening the
 * upstream grading.json `expectations[]` into rows lets us query
 * "which assertions consistently fail across runs" without parsing
 * JSON in SQL.
 */
export interface EvalAssertion {
  id: number;
  run_id: number;
  expectation_text: string;
  passed: boolean;
  evidence: string | null;
  created_at: number;
}

// ── Public request / response types (used by runner + telegram) ─────

/** Parameters the runner accepts for a new eval session. */
export interface EvalSessionRequest {
  chat_id: string;
  skill_name: string;
  prompts: string[];
  expectations: string[];
  runs_per_config?: number;                 // default 2 (Phase 1)
  configurations?: EvalConfiguration[];     // default ['with_skill', 'without_skill']
}

/** Hard cap on total claude -p calls (baselines + grader) per session. */
export const DEFAULT_MAX_EVAL_CALLS_PER_RUN = 40;

/** Default Phase 1 fan-out — keeps a typical session under the cap. */
export const DEFAULT_RUNS_PER_CONFIG = 2;

/** Maximum concurrent claude -p subprocesses during a run. Keeps host load bounded. */
export const DEFAULT_RUNNER_CONCURRENCY = 3;

/** Per-call subprocess hard timeout (ms). Inherits from claude.ts settings but capped here. */
export const EVAL_RUN_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes per run

// ── Grader output shape (Phase 1 subset of upstream grading.json) ───

/**
 * Phase 1 grader-output shape — the subset of upstream grading.json we
 * actually consume. Future phases can extend this with `claims`,
 * `user_notes_summary`, `execution_metrics`, `eval_feedback`.
 */
export interface GraderResult {
  expectations: Array<{
    text: string;
    passed: boolean;
    evidence: string | null;
  }>;
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
  /** Optional Phase 1 carry-forward — the grader's critique of the assertions themselves. */
  eval_feedback?: {
    suggestions?: Array<{
      assertion?: string;
      reason: string;
    }>;
    overall?: string;
  };
}

// ── Aggregate helper shapes (computed, not persisted) ───────────────

/** Per-session pass-rate breakdown returned to the viewer / Telegram. */
export interface SessionSummary {
  session: EvalSession;
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  pass_rate_with_skill: number | null;
  pass_rate_without_skill: number | null;
  /** "+0.20" style delta string when both configurations have data. */
  pass_rate_delta: string | null;
}
