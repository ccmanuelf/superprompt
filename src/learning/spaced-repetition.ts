/**
 * Spaced repetition engine — pure functions for mastery tracking.
 * Based on forgetting curve from edwinjojie/ai-study-coach.
 *
 * Exported for testing.
 */

import type { LearningTopic } from './db.js';

// ── Constants ───────────────────────────────────────────────

const DEFAULT_DECAY_RATE = 0.15;
const MASTERY_CORRECT_DELTA = 0.05;
const MASTERY_INCORRECT_DELTA = -0.03;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Review interval thresholds: mastery → days until next review. */
const REVIEW_INTERVALS: Array<{ maxMastery: number; days: number }> = [
  { maxMastery: 0.3, days: 1 },
  { maxMastery: 0.6, days: 2 },
  { maxMastery: 0.8, days: 3 },
  { maxMastery: 1.0, days: 7 },
];

// ── Forgetting Curve ────────────────────────────────────────

/**
 * Compute mastery decay using the forgetting curve formula.
 * mastery *= (1 - decay_rate) ^ days_since_review
 */
export function computeMasteryDecay(
  currentMastery: number,
  daysSinceReview: number,
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  if (daysSinceReview <= 0) return currentMastery;
  const decayed = currentMastery * Math.pow(1 - decayRate, daysSinceReview);
  return Math.max(0, Math.round(decayed * 1000) / 1000);
}

/**
 * Compute mastery change after answering a question.
 * +0.05 for correct, -0.03 for incorrect. Clamped to [0, 1].
 */
export function computeMasteryDelta(currentMastery: number, isCorrect: boolean): number {
  const delta = isCorrect ? MASTERY_CORRECT_DELTA : MASTERY_INCORRECT_DELTA;
  const newMastery = currentMastery + delta;
  return Math.max(0, Math.min(1, Math.round(newMastery * 1000) / 1000));
}

// ── Review Scheduling ───────────────────────────────────────

/**
 * Compute days until next review based on current mastery.
 * Lower mastery → shorter interval (more frequent review).
 */
export function computeReviewInterval(mastery: number): number {
  for (const { maxMastery, days } of REVIEW_INTERVALS) {
    if (mastery < maxMastery) return days;
  }
  return 7; // Mastery >= 1.0 — review weekly
}

/**
 * Check if a topic is due for review.
 */
export function isTopicDueForReview(lastReviewedAt: number | null, mastery: number): boolean {
  if (lastReviewedAt === null) return false; // Never reviewed = not yet started
  const daysSince = (Date.now() - lastReviewedAt) / MS_PER_DAY;
  const interval = computeReviewInterval(mastery);
  return daysSince >= interval;
}

/**
 * Compute the effective mastery of a topic accounting for time decay.
 */
export function getEffectiveMastery(topic: LearningTopic): number {
  if (!topic.last_reviewed_at || topic.mastery === 0) return topic.mastery;
  const daysSince = (Date.now() - topic.last_reviewed_at) / MS_PER_DAY;
  return computeMasteryDecay(topic.mastery, daysSince);
}

// ── Topic Selection ─────────────────────────────────────────

/**
 * Select the next topic to study.
 * Priority: 1) Due reviews (by urgency), 2) Next pending topic (by sort_order).
 */
export function selectNextTopic(topics: LearningTopic[]): LearningTopic | null {
  if (topics.length === 0) return null;

  // 1. Find completed topics due for review (sorted by most overdue)
  const dueReviews = topics
    .filter((t) => t.status === 'completed' && isTopicDueForReview(t.last_reviewed_at, t.mastery))
    .sort((a, b) => {
      // Most overdue first (longest since last review relative to interval)
      const aDays = a.last_reviewed_at ? (Date.now() - a.last_reviewed_at) / MS_PER_DAY : 0;
      const bDays = b.last_reviewed_at ? (Date.now() - b.last_reviewed_at) / MS_PER_DAY : 0;
      const aOverdue = aDays - computeReviewInterval(a.mastery);
      const bOverdue = bDays - computeReviewInterval(b.mastery);
      return bOverdue - aOverdue;
    });

  if (dueReviews.length > 0) return dueReviews[0];

  // 2. Find the next in_progress topic
  const inProgress = topics.find((t) => t.status === 'in_progress');
  if (inProgress) return inProgress;

  // 3. Find the next pending topic (lowest sort_order)
  const pending = topics
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.sort_order - b.sort_order);

  return pending.length > 0 ? pending[0] : null;
}

/**
 * Count how many topics are due for review.
 */
export function countDueReviews(topics: LearningTopic[]): number {
  return topics.filter(
    (t) => t.status === 'completed' && isTopicDueForReview(t.last_reviewed_at, t.mastery),
  ).length;
}

/**
 * Get mastery summary for a plan.
 */
export function getMasterySummary(topics: LearningTopic[]): {
  avgMastery: number;
  completedCount: number;
  totalCount: number;
  dueReviews: number;
} {
  const completed = topics.filter((t) => t.status === 'completed');
  const avgMastery = completed.length > 0
    ? completed.reduce((sum, t) => sum + getEffectiveMastery(t), 0) / completed.length
    : 0;

  return {
    avgMastery: Math.round(avgMastery * 100) / 100,
    completedCount: completed.length,
    totalCount: topics.length,
    dueReviews: countDueReviews(topics),
  };
}
