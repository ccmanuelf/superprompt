/**
 * Job Sequencing — Dispatching Rules
 *
 * 6 classic dispatching rules for job-shop scheduling:
 * - FIFO: First In, First Out (by arrival time)
 * - SPT: Shortest Processing Time
 * - LPT: Longest Processing Time
 * - EDD: Earliest Due Date
 * - CR: Critical Ratio (time remaining / processing time)
 * - SLACK: Minimum Slack (due date - current time - processing time)
 *
 * Each rule sorts jobs and builds a schedule using the evaluation module.
 */

import type {
  DispatchRule,
  Job,
  SequencerConfig,
  ScheduleResult,
  RuleComparison,
} from './models.js';
import { ALL_RULES } from './models.js';
import {
  buildSingleMachineSchedule,
  computeMetrics,
} from './evaluation.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Run a single dispatching rule and return the schedule.
 */
export function dispatch(
  config: SequencerConfig,
  rule: DispatchRule,
): ScheduleResult {
  const start = performance.now();
  const warnings: string[] = [];
  for (const job of config.jobs) {
    if (job.processing_minutes <= 0) {
      warnings.push(`Job "${job.name}" has 0 processing time — it will appear as a zero-duration entry.`);
    }
  }
  const orderedJobIds = sortJobsByRule(config.jobs, rule, config);
  const entries = buildSingleMachineSchedule(orderedJobIds, config);
  const metrics = computeMetrics(entries, config);
  const computationMs = performance.now() - start;

  return {
    rule_or_method: rule,
    entries,
    metrics,
    computation_ms: Math.round(computationMs * 100) / 100,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Compare all dispatching rules side-by-side.
 */
export function compareAllRules(config: SequencerConfig): RuleComparison {
  const results: ScheduleResult[] = [];

  for (const rule of ALL_RULES) {
    results.push(dispatch(config, rule));
  }

  // Find best by each metric
  let bestMakespan = results[0];
  let bestLateness = results[0];
  let bestSetup = results[0];

  for (const r of results) {
    if (r.metrics.makespan < bestMakespan.metrics.makespan) bestMakespan = r;
    if (r.metrics.total_lateness < bestLateness.metrics.total_lateness) bestLateness = r;
    if (r.metrics.total_setup_time < bestSetup.metrics.total_setup_time) bestSetup = r;
  }

  // Best overall: weighted score (lower is better)
  let bestOverall = results[0];
  let bestScore = Infinity;
  for (const r of results) {
    const score = normalizedScore(r, results);
    if (score < bestScore) {
      bestScore = score;
      bestOverall = r;
    }
  }

  const recommendation = generateRecommendation(results, bestOverall);

  return {
    config_name: config.name,
    rules: results,
    best_makespan: bestMakespan.rule_or_method,
    best_lateness: bestLateness.rule_or_method,
    best_setup: bestSetup.rule_or_method,
    best_overall: bestOverall.rule_or_method,
    recommendation,
  };
}

// ── Rule Implementations ─────────────────────────────────────

function sortJobsByRule(
  jobs: Job[],
  rule: DispatchRule,
  config: SequencerConfig,
): string[] {
  const sorted = [...jobs];

  switch (rule) {
    case 'FIFO':
      sorted.sort((a, b) => (a.arrival_time ?? 0) - (b.arrival_time ?? 0));
      break;

    case 'SPT':
      sorted.sort((a, b) => a.processing_minutes - b.processing_minutes);
      break;

    case 'LPT':
      sorted.sort((a, b) => b.processing_minutes - a.processing_minutes);
      break;

    case 'EDD':
      sorted.sort((a, b) => {
        const aDue = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const bDue = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return aDue - bDue;
      });
      break;

    case 'CR': {
      // Critical Ratio = time remaining until due / processing time
      // Lower CR = more urgent (should be scheduled first)
      // Use start-of-today for deterministic results within a day
      const todayCR = new Date(); todayCR.setHours(0, 0, 0, 0);
      const nowCR = todayCR.getTime();
      sorted.sort((a, b) => {
        const aRemaining = a.due_date
          ? Math.max(0, (new Date(a.due_date).getTime() - nowCR) / 60000)
          : Infinity;
        const bRemaining = b.due_date
          ? Math.max(0, (new Date(b.due_date).getTime() - nowCR) / 60000)
          : Infinity;
        const aCR = a.processing_minutes > 0 ? aRemaining / a.processing_minutes : Infinity;
        const bCR = b.processing_minutes > 0 ? bRemaining / b.processing_minutes : Infinity;
        return aCR - bCR;
      });
      break;
    }

    case 'SLACK': {
      // Slack = time until due date - processing time remaining
      // Lower slack = more urgent
      const todaySL = new Date(); todaySL.setHours(0, 0, 0, 0);
      const nowSL = todaySL.getTime();
      sorted.sort((a, b) => {
        const aRemaining = a.due_date
          ? (new Date(a.due_date).getTime() - nowSL) / 60000
          : Infinity;
        const bRemaining = b.due_date
          ? (new Date(b.due_date).getTime() - nowSL) / 60000
          : Infinity;
        const aSlack = aRemaining - a.processing_minutes;
        const bSlack = bRemaining - b.processing_minutes;
        return aSlack - bSlack;
      });
      break;
    }
  }

  return sorted.map((j) => j.id);
}

// ── Scoring & Recommendations ────────────────────────────────

function normalizedScore(
  result: ScheduleResult,
  allResults: ScheduleResult[],
): number {
  const maxMakespan = Math.max(...allResults.map((r) => r.metrics.makespan)) || 1;
  const maxLateness = Math.max(...allResults.map((r) => r.metrics.total_lateness)) || 1;
  const maxSetup = Math.max(...allResults.map((r) => r.metrics.total_setup_time)) || 1;

  // Weighted normalized score (lower is better)
  return (
    0.4 * (result.metrics.makespan / maxMakespan) +
    0.35 * (result.metrics.total_lateness / maxLateness) +
    0.25 * (result.metrics.total_setup_time / maxSetup)
  );
}

function generateRecommendation(
  results: ScheduleResult[],
  best: ScheduleResult,
): string {
  const hasLateness = results.some((r) => r.metrics.total_lateness > 0);
  const hasSetup = results.some((r) => r.metrics.total_setup_time > 0);

  const parts: string[] = [
    `Best overall rule: ${best.rule_or_method} (makespan: ${best.metrics.makespan.toFixed(0)}min`,
  ];

  if (hasLateness) {
    parts[0] += `, on-time: ${best.metrics.on_time_pct.toFixed(0)}%`;
  }
  if (hasSetup) {
    parts[0] += `, setup: ${best.metrics.total_setup_time.toFixed(0)}min`;
  }
  parts[0] += ').';

  if (best.rule_or_method === 'SPT') {
    parts.push('SPT minimizes average flow time — good for reducing WIP.');
  } else if (best.rule_or_method === 'EDD') {
    parts.push('EDD minimizes maximum lateness — best for meeting due dates.');
  } else if (best.rule_or_method === 'CR') {
    parts.push('CR balances urgency with processing time — dynamic priority.');
  }

  if (hasLateness && best.metrics.num_late_jobs > 0) {
    parts.push(`${best.metrics.num_late_jobs} job(s) still late — consider GA optimization or adding capacity.`);
  }

  return parts.join(' ');
}
