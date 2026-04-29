/**
 * Eval pipeline — public surface.
 *
 * Phase 1 (rc.98): runner + grader + persistence + table init. Phases
 * 2-4 (rc.99-101) extend with benchmark aggregation, description
 * optimizer, blind comparator, and docs.
 *
 * Adapted from skill-creator-v2 (Apache-2.0); see schemas.ts and
 * prompts/grader-upstream.md for attribution.
 */

export { evalTableInit } from './db.js';
export {
  getEvalSession,
  listEvalSessions,
  listEvalRuns,
  listAssertionsForRun,
  computeSessionPassRate,
} from './db.js';
export { startEvalSession, validateEvalRequest, computeTotalCalls } from './runner.js';
export type {
  EvalSession,
  EvalRun,
  EvalAssertion,
  EvalSessionRequest,
  EvalConfiguration,
  EvalStatus,
  GraderResult,
  SessionSummary,
} from './schemas.js';
export {
  DEFAULT_MAX_EVAL_CALLS_PER_RUN,
  DEFAULT_RUNS_PER_CONFIG,
} from './schemas.js';
