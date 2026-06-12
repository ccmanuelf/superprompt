import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

/**
 * Learning Coach — behavioral pins for the spaced-repetition math.
 *
 * Audit task 3.6: tests/learning.test.ts verifies the functions run; this file
 * pins the MATH as characterization tests. Expected values are hand-computed
 * from the constants in src/learning/spaced-repetition.ts:
 *   MASTERY_CORRECT_DELTA   = +0.05
 *   MASTERY_INCORRECT_DELTA = -0.03
 *   DEFAULT_DECAY_RATE      = 0.15  (mastery *= 0.85^days, rounded to 3 dp)
 *   REVIEW_INTERVALS: <0.3 → 1d, <0.6 → 2d, <0.8 → 3d, <1.0 → 7d, else 7d
 * and from calculateStreak in src/learning/db.ts (600s daily goal, today
 * forgiven only when absent).
 *
 * If the algorithm is intentionally changed, these pins must be updated in the
 * same commit — that is their purpose.
 */

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  computeMasteryDecay,
  computeMasteryDelta,
  computeReviewInterval,
  isTopicDueForReview,
  getEffectiveMastery,
} from '../src/learning/spaced-repetition.js';
import { initLearningTables, calculateStreak } from '../src/learning/db.js';
import type { LearningTopic } from '../src/learning/db.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Fixed mid-day UTC instant so date-string math never straddles midnight.
const FIXED_NOW = new Date('2026-06-10T12:00:00.000Z').getTime();

function makeTopic(overrides: Partial<LearningTopic> = {}): LearningTopic {
  return {
    id: 't', plan_id: 'p', title: 'T', description: null,
    sort_order: 0, difficulty: 3, estimated_minutes: 10,
    status: 'completed', mastery: 0, last_reviewed_at: null,
    review_count: 0, created_at: FIXED_NOW,
    ...overrides,
  };
}

function useFakeNow(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
}

afterEach(() => { vi.useRealTimers(); });

// ── Review interval progression ─────────────────────────────

describe('review interval progression (characterization)', () => {
  it('pins the exact interval schedule across 20 consecutive correct answers from zero mastery', () => {
    // Mastery grows +0.05 per correct answer; the interval is derived purely
    // from mastery thresholds (NOT from repetition count, unlike SM-2).
    // Tier graduations: 6th correct → 2d, 12th → 3d, 16th → 7d.
    let mastery = 0;
    const intervals: number[] = [];
    for (let n = 0; n < 20; n++) {
      mastery = computeMasteryDelta(mastery, true);
      intervals.push(computeReviewInterval(mastery));
    }
    expect(mastery).toBe(1.0); // 20 × 0.05, clamped ceiling reached exactly
    expect(intervals).toEqual([
      1, 1, 1, 1, 1,          // mastery 0.05–0.25
      2, 2, 2, 2, 2, 2,       // mastery 0.30–0.55
      3, 3, 3, 3,             // mastery 0.60–0.75
      7, 7, 7, 7, 7,          // mastery 0.80–1.00
    ]);
  });

  it('threshold boundaries are half-open: mastery exactly at a threshold falls to the next (longer) tier', () => {
    expect(computeReviewInterval(0)).toBe(1);
    expect(computeReviewInterval(0.3)).toBe(2);  // 0.3 < 0.3 is false → next tier
    expect(computeReviewInterval(0.6)).toBe(3);
    expect(computeReviewInterval(0.8)).toBe(7);
    expect(computeReviewInterval(1.0)).toBe(7);  // falls through loop → weekly fallback
    expect(computeReviewInterval(1.5)).toBe(7);  // out-of-range input still weekly
  });

  it('next review becomes due exactly when the interval elapses (>= comparison, ms precision)', () => {
    useFakeNow();
    const mastery = 0.5; // interval = 2 days
    const dueAt = FIXED_NOW - 2 * MS_PER_DAY;
    expect(isTopicDueForReview(dueAt + 1, mastery)).toBe(false); // 1ms short of 2 days
    expect(isTopicDueForReview(dueAt, mastery)).toBe(true);      // exactly 2 days
  });
});

// ── Incorrect answers ───────────────────────────────────────

describe('incorrect answers shorten the schedule', () => {
  it('one incorrect answer steps mastery down by exactly 0.03 and can demote the interval tier', () => {
    const before = 0.61;
    expect(computeReviewInterval(before)).toBe(3);
    const after = computeMasteryDelta(before, false);
    expect(after).toBe(0.58);
    expect(computeReviewInterval(after)).toBe(2); // crossed the 0.6 threshold → shorter interval
  });

  it('incorrect answers are linear (-0.03 each), not an SM-2 style reset to the shortest interval', () => {
    // From 0.9 (7-day tier): one miss keeps the 7-day interval; it takes 4
    // misses to demote to the 3-day tier, and the 1-day tier is never reached.
    let mastery = 0.9;
    mastery = computeMasteryDelta(mastery, false);
    expect(mastery).toBe(0.87);
    expect(computeReviewInterval(mastery)).toBe(7);
    mastery = computeMasteryDelta(mastery, false); // 0.84
    mastery = computeMasteryDelta(mastery, false); // 0.81
    mastery = computeMasteryDelta(mastery, false); // 0.78
    expect(mastery).toBe(0.78);
    expect(computeReviewInterval(mastery)).toBe(3);
  });

  it('asymmetric deltas: one miss erases less than one correct gains (net +0.02 per correct/miss pair)', () => {
    const up = computeMasteryDelta(0.5, true);
    expect(up).toBe(0.55);
    const net = computeMasteryDelta(up, false);
    expect(net).toBe(0.52);
  });
});

// ── Mastery decay (forgetting curve) ────────────────────────

describe('mastery decay — exact forgetting-curve pins', () => {
  it('pins decay of 0.8 mastery at 1, 2, and 7 days with the default 0.15 rate', () => {
    expect(computeMasteryDecay(0.8, 1)).toBe(0.68);   // 0.8 × 0.85
    expect(computeMasteryDecay(0.8, 2)).toBe(0.578);  // 0.8 × 0.85²
    expect(computeMasteryDecay(0.8, 7)).toBe(0.256);  // 0.8 × 0.85⁷, rounded to 3 dp
  });

  it('getEffectiveMastery applies continuous (fractional-day) decay anchored on Date.now()', () => {
    useFakeNow();
    const halfDay = makeTopic({ mastery: 0.8, last_reviewed_at: FIXED_NOW - MS_PER_DAY / 2 });
    expect(getEffectiveMastery(halfDay)).toBe(0.738); // 0.8 × 0.85^0.5 — decay is not day-quantized
    const twoDays = makeTopic({ mastery: 0.8, last_reviewed_at: FIXED_NOW - 2 * MS_PER_DAY });
    expect(getEffectiveMastery(twoDays)).toBe(0.578);
  });

  it('boundary cases: never-reviewed and zero-mastery topics pass through; long decay floors at exactly 0', () => {
    useFakeNow();
    // Never reviewed → raw mastery, no decay applied
    expect(getEffectiveMastery(makeTopic({ mastery: 0.7, last_reviewed_at: null }))).toBe(0.7);
    // Zero mastery short-circuits even with an ancient review timestamp
    expect(getEffectiveMastery(makeTopic({ mastery: 0, last_reviewed_at: FIXED_NOW - 100 * MS_PER_DAY }))).toBe(0);
    // 3-decimal rounding floors tiny residuals to exactly 0 (0.1 × 0.85¹⁰⁰ ≈ 8.7e-9)
    expect(computeMasteryDecay(0.1, 100)).toBe(0);
  });
});

// ── Streak calculation (real DB) ────────────────────────────

describe('calculateStreak (real DB)', () => {
  function dateStr(daysAgo: number): string {
    return new Date(FIXED_NOW - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
  }

  async function insertDay(chatId: string, daysAgo: number, seconds: number): Promise<void> {
    await testKnex('learning_daily_time').insert({
      chat_id: chatId, date: dateStr(daysAgo), total_seconds: seconds, session_count: 1,
    });
  }

  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await initLearningTables();
    useFakeNow(); // freeze "today" AFTER schema setup so knex init uses real timers
  });

  afterAll(async () => { if (testKnex) await testKnex.destroy(); });

  it('counts consecutive qualifying days ending today; exactly 600s qualifies, 599s breaks', async () => {
    await insertDay('c1', 0, 700);
    await insertDay('c1', 1, 900);
    await insertDay('c1', 2, 600); // boundary: goal check is `< 600` breaks, so 600 counts
    await insertDay('c1', 3, 599); // below goal → streak stops here
    expect(await calculateStreak('c1')).toBe(3);
  });

  it('counts the full streak when today has no session yet (rc.115 off-by-one fix)', async () => {
    // Today is forgiven (day not over), and every prior qualifying day
    // counts. Before rc.115 the `i < rows.length` bound burned one
    // iteration on the forgiven day, undercounting by exactly one.
    await insertDay('c1', 1, 800);
    await insertDay('c1', 2, 700);
    expect(await calculateStreak('c1')).toBe(2);

    await insertDay('c1', 3, 700);
    expect(await calculateStreak('c1')).toBe(3);
  });

  it('a one-day gap breaks the streak: today counts, days beyond the gap do not', async () => {
    await insertDay('c1', 0, 900);
    // day 1 missing
    await insertDay('c1', 2, 900);
    await insertDay('c1', 3, 900);
    expect(await calculateStreak('c1')).toBe(1);
  });

  it('pins current behavior; possible bug: a below-goal session today zeroes the streak instead of being forgiven like a missing today', async () => {
    // 300s logged today (< 600 goal) breaks at i=0, so qualifying prior days
    // are never counted — yet logging NOTHING today would have yielded 2.
    // Studying a little today is punished harder than not studying at all.
    await insertDay('c1', 0, 300);
    await insertDay('c1', 1, 900);
    await insertDay('c1', 2, 900);
    expect(await calculateStreak('c1')).toBe(0);
  });

  it('without a chatId the goal is checked against the summed time across chats; per-chat it is not', async () => {
    await insertDay('chatA', 0, 400);
    await insertDay('chatB', 0, 300);
    expect(await calculateStreak()).toBe(1);        // 400 + 300 = 700 ≥ 600
    expect(await calculateStreak('chatA')).toBe(0); // 400 < 600
  });
});
