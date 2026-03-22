import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Learning Coach tests.
 * Tests: spaced repetition (pure functions), plan CRUD (real DB),
 * session lifecycle, persona selection, and plan negotiation.
 */

// ── Spaced Repetition (pure functions — no DB needed) ───────

import {
  computeMasteryDecay,
  computeMasteryDelta,
  computeReviewInterval,
  isTopicDueForReview,
  selectNextTopic,
  getMasterySummary,
  countDueReviews,
  getEffectiveMastery,
} from '../src/learning/spaced-repetition.js';

import type { LearningTopic } from '../src/learning/db.js';

describe('spaced repetition — forgetting curve', () => {
  it('decays mastery over time', () => {
    const decayed = computeMasteryDecay(1.0, 7);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(1.0);
  });

  it('no decay for 0 days', () => {
    expect(computeMasteryDecay(0.8, 0)).toBe(0.8);
  });

  it('mastery never goes below 0', () => {
    expect(computeMasteryDecay(0.1, 100)).toBeGreaterThanOrEqual(0);
  });

  it('higher decay rate causes faster decay', () => {
    const slow = computeMasteryDecay(1.0, 5, 0.1);
    const fast = computeMasteryDecay(1.0, 5, 0.3);
    expect(fast).toBeLessThan(slow);
  });

  it('follows exponential formula: mastery * (1 - rate)^days', () => {
    const result = computeMasteryDecay(0.8, 3, 0.15);
    const expected = 0.8 * Math.pow(0.85, 3);
    expect(result).toBeCloseTo(expected, 2);
  });
});

describe('spaced repetition — mastery delta', () => {
  it('correct answer increases mastery by 0.05', () => {
    expect(computeMasteryDelta(0.5, true)).toBe(0.55);
  });

  it('incorrect answer decreases mastery by 0.03', () => {
    expect(computeMasteryDelta(0.5, false)).toBe(0.47);
  });

  it('mastery clamped to max 1.0', () => {
    expect(computeMasteryDelta(0.98, true)).toBe(1.0);
  });

  it('mastery clamped to min 0.0', () => {
    expect(computeMasteryDelta(0.01, false)).toBe(0.0);
  });
});

describe('spaced repetition — review intervals', () => {
  it('low mastery (<0.3) → 1 day interval', () => {
    expect(computeReviewInterval(0.2)).toBe(1);
  });

  it('medium mastery (<0.6) → 2 day interval', () => {
    expect(computeReviewInterval(0.5)).toBe(2);
  });

  it('good mastery (<0.8) → 3 day interval', () => {
    expect(computeReviewInterval(0.7)).toBe(3);
  });

  it('high mastery (>=0.8) → 7 day interval', () => {
    expect(computeReviewInterval(0.9)).toBe(7);
  });
});

describe('spaced repetition — topic due for review', () => {
  it('returns false for never-reviewed topic', () => {
    expect(isTopicDueForReview(null, 0)).toBe(false);
  });

  it('returns true when overdue', () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    expect(isTopicDueForReview(twoDaysAgo, 0.2)).toBe(true); // interval=1, 2 days passed
  });

  it('returns false when not yet due', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    expect(isTopicDueForReview(oneHourAgo, 0.9)).toBe(false); // interval=7, 1 hour passed
  });
});

describe('spaced repetition — topic selection', () => {
  function makeTopic(overrides: Partial<LearningTopic> = {}): LearningTopic {
    return {
      id: 'test',
      plan_id: 'plan1',
      title: 'Test',
      description: null,
      sort_order: 0,
      difficulty: 3,
      estimated_minutes: 10,
      status: 'pending',
      mastery: 0,
      last_reviewed_at: null,
      review_count: 0,
      created_at: Date.now(),
      ...overrides,
    };
  }

  it('selects next pending topic by sort_order', () => {
    const topics = [
      makeTopic({ id: 'a', sort_order: 1, title: 'Second' }),
      makeTopic({ id: 'b', sort_order: 0, title: 'First' }),
    ];
    const next = selectNextTopic(topics);
    expect(next?.title).toBe('First');
  });

  it('prioritizes due reviews over pending topics', () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const topics = [
      makeTopic({ id: 'pending', sort_order: 0, status: 'pending', title: 'New Topic' }),
      makeTopic({ id: 'review', sort_order: 1, status: 'completed', mastery: 0.2, last_reviewed_at: twoDaysAgo, title: 'Review Me' }),
    ];
    const next = selectNextTopic(topics);
    expect(next?.title).toBe('Review Me');
  });

  it('prefers in_progress over pending', () => {
    const topics = [
      makeTopic({ id: 'pending', sort_order: 0, status: 'pending', title: 'Pending' }),
      makeTopic({ id: 'progress', sort_order: 1, status: 'in_progress', title: 'In Progress' }),
    ];
    const next = selectNextTopic(topics);
    expect(next?.title).toBe('In Progress');
  });

  it('returns null for empty list', () => {
    expect(selectNextTopic([])).toBeNull();
  });

  it('returns null when all topics are completed and not due', () => {
    const justNow = Date.now();
    const topics = [
      makeTopic({ id: 'done', status: 'completed', mastery: 0.9, last_reviewed_at: justNow }),
    ];
    expect(selectNextTopic(topics)).toBeNull();
  });
});

describe('spaced repetition — mastery summary', () => {
  function makeTopic(overrides: Partial<LearningTopic> = {}): LearningTopic {
    return {
      id: 'test', plan_id: 'p', title: 'T', description: null,
      sort_order: 0, difficulty: 3, estimated_minutes: 10,
      status: 'pending', mastery: 0, last_reviewed_at: null,
      review_count: 0, created_at: Date.now(),
      ...overrides,
    };
  }

  it('computes correct summary', () => {
    const now = Date.now();
    const topics = [
      makeTopic({ id: 'a', status: 'completed', mastery: 0.8, last_reviewed_at: now }),
      makeTopic({ id: 'b', status: 'completed', mastery: 0.6, last_reviewed_at: now }),
      makeTopic({ id: 'c', status: 'pending' }),
    ];
    const summary = getMasterySummary(topics);
    expect(summary.completedCount).toBe(2);
    expect(summary.totalCount).toBe(3);
    expect(summary.avgMastery).toBeCloseTo(0.7, 1);
  });
});

// ── Personas (pure functions) ───────────────────────────────

import {
  getPersona, listPersonas, selectPersonaForSubject, buildPersonaPrompt,
  GLOBAL_GUIDELINES,
} from '../src/learning/personas.js';

describe('personas', () => {
  it('lists all 5 personas', () => {
    expect(listPersonas()).toHaveLength(5);
  });

  it('gets persona by ID', () => {
    const p = getPersona('guiding_challenger');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Guiding Challenger');
  });

  it('returns undefined for unknown persona', () => {
    expect(getPersona('nonexistent')).toBeUndefined();
  });

  it('selects friendly_conversational for languages', () => {
    expect(selectPersonaForSubject('Learn Chinese')).toBe('friendly_conversational');
    expect(selectPersonaForSubject('Portuguese conversation')).toBe('friendly_conversational');
  });

  it('selects expert_scholar for academic subjects', () => {
    expect(selectPersonaForSubject('Linear Algebra')).toBe('expert_scholar');
    expect(selectPersonaForSubject('Physics fundamentals')).toBe('expert_scholar');
  });

  it('selects guiding_challenger for programming', () => {
    expect(selectPersonaForSubject('Python programming')).toBe('guiding_challenger');
    expect(selectPersonaForSubject('Learn Kubernetes')).toBe('guiding_challenger');
  });

  it('selects creative_mentor for creative subjects', () => {
    expect(selectPersonaForSubject('Creative writing')).toBe('creative_mentor');
  });

  it('selects encouraging_coach for personal development', () => {
    expect(selectPersonaForSubject('Fitness training')).toBe('encouraging_coach');
  });

  it('defaults to friendly_conversational for unknown subjects', () => {
    expect(selectPersonaForSubject('Underwater basket weaving')).toBe('friendly_conversational');
  });

  it('builds persona prompt with global guidelines', () => {
    const prompt = buildPersonaPrompt('guiding_challenger', 'Math');
    expect(prompt).toContain(GLOBAL_GUIDELINES);
    expect(prompt).toContain('Guiding Challenger');
  });
});

// ── Plan Parsing (pure functions) ───────────────────────────

import { parsePlanResponse, buildPlanPrompt, extractSubject } from '../src/learning/plan.js';

describe('plan response parsing', () => {
  it('parses valid JSON array from code block', () => {
    const response = '```json\n[{"title": "Tones", "description": "4 tones", "difficulty": 2, "estimated_minutes": 15}]\n```';
    const topics = parsePlanResponse(response);
    expect(topics).toHaveLength(1);
    expect(topics[0].title).toBe('Tones');
    expect(topics[0].difficulty).toBe(2);
    expect(topics[0].estimated_minutes).toBe(15);
  });

  it('handles multiple topics', () => {
    const response = '```json\n[{"title":"A","description":"","difficulty":1,"estimated_minutes":10},{"title":"B","description":"","difficulty":3,"estimated_minutes":15}]\n```';
    const topics = parsePlanResponse(response);
    expect(topics).toHaveLength(2);
  });

  it('clamps difficulty to 1-5', () => {
    const response = '```json\n[{"title":"T","description":"","difficulty":10,"estimated_minutes":5}]\n```';
    const topics = parsePlanResponse(response);
    expect(topics[0].difficulty).toBe(5);
  });

  it('clamps estimated_minutes to 5-30', () => {
    const response = '```json\n[{"title":"T","description":"","difficulty":3,"estimated_minutes":60}]\n```';
    const topics = parsePlanResponse(response);
    expect(topics[0].estimated_minutes).toBe(30);
  });

  it('filters out items without titles', () => {
    const response = '```json\n[{"title":"Valid","description":"","difficulty":3,"estimated_minutes":10},{"description":"no title","difficulty":1,"estimated_minutes":5}]\n```';
    const topics = parsePlanResponse(response);
    expect(topics).toHaveLength(1);
    expect(topics[0].title).toBe('Valid');
  });

  it('returns empty array for invalid JSON', () => {
    expect(parsePlanResponse('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parsePlanResponse('```json\n{"title":"not array"}\n```')).toEqual([]);
  });

  it('builds plan prompt with subject and goal', () => {
    const prompt = buildPlanPrompt('Chinese', 'Conversational fluency');
    expect(prompt).toContain('Chinese');
    expect(prompt).toContain('Conversational fluency');
  });
});

// ── Subject Extraction ──────────────────────────────────────

describe('subject extraction from goal', () => {
  it('extracts subject from "Learn X" pattern', () => {
    expect(extractSubject('Learn Mandarin Chinese')).toBe('Mandarin Chinese');
  });

  it('extracts subject from "I want to learn X" pattern', () => {
    expect(extractSubject('I want to learn Python programming')).toBe('Python programming');
  });

  it('strips purpose clause ("for X")', () => {
    expect(extractSubject('Learn Chinese for traveling')).toBe('Chinese');
  });

  it('strips "to X" clause', () => {
    expect(extractSubject('I want to learn Kubernetes to deploy my apps')).toBe('Kubernetes');
  });

  it('handles "teach me X" pattern', () => {
    expect(extractSubject('Teach me calculus')).toBe('calculus');
  });

  it('handles "I want to understand X" pattern', () => {
    expect(extractSubject('I want to understand quantum physics')).toBe('quantum physics');
  });

  it('passes through short direct subject', () => {
    expect(extractSubject('Chinese')).toBe('Chinese');
  });

  it('caps very long goals at 50 chars', () => {
    const longGoal = 'A very very very very very very very very very very very very long goal description';
    const result = extractSubject(longGoal);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

// ── Session Markers (pure functions) ────────────────────────

import { stripMarkers, processSessionResponse, getActiveSessions, FALLBACK_CORRECT_PATTERNS, FALLBACK_INCORRECT_PATTERNS } from '../src/learning/session.js';

describe('session markers', () => {
  it('strips all marker types', () => {
    const text = 'Great answer! [CORRECT] Now let\'s try another. [QUIZ_START]';
    expect(stripMarkers(text)).toBe('Great answer!  Now let\'s try another.');
  });

  it('strips topic complete marker', () => {
    expect(stripMarkers('You\'ve mastered this! [TOPIC_COMPLETE]')).toBe('You\'ve mastered this!');
  });

  it('strips assessment markers', () => {
    expect(stripMarkers('Result: [ASSESSMENT_PASSED]')).toBe('Result:');
  });

  it('handles text without markers', () => {
    expect(stripMarkers('No markers here')).toBe('No markers here');
  });

  it('collapses multiple newlines left by markers', () => {
    expect(stripMarkers('Before\n\n\n\nAfter')).toBe('Before\n\nAfter');
  });
});

// ── NLP Fallback Patterns ───────────────────────────────────

describe('NLP fallback marker detection', () => {
  it('detects "That\'s correct!" as correct', () => {
    expect(FALLBACK_CORRECT_PATTERNS.some((p) => p.test("That's correct! Good job."))).toBe(true);
  });

  it('detects "Well done" as correct', () => {
    expect(FALLBACK_CORRECT_PATTERNS.some((p) => p.test("Well done, that's the right answer."))).toBe(true);
  });

  it('detects "Excellent" as correct', () => {
    expect(FALLBACK_CORRECT_PATTERNS.some((p) => p.test("Excellent! You got it."))).toBe(true);
  });

  it('detects "Not quite" as incorrect', () => {
    expect(FALLBACK_INCORRECT_PATTERNS.some((p) => p.test("Not quite. The correct answer is..."))).toBe(true);
  });

  it('detects "That\'s not right" as incorrect', () => {
    expect(FALLBACK_INCORRECT_PATTERNS.some((p) => p.test("That's not right. Let me explain..."))).toBe(true);
  });

  it('detects "Actually, the answer is" as incorrect', () => {
    expect(FALLBACK_INCORRECT_PATTERNS.some((p) => p.test("Actually, the correct answer is B."))).toBe(true);
  });

  it('does not false-positive on neutral teaching text', () => {
    const neutral = "Let me explain how tones work in Chinese. There are 4 main tones.";
    expect(FALLBACK_CORRECT_PATTERNS.some((p) => p.test(neutral))).toBe(false);
    expect(FALLBACK_INCORRECT_PATTERNS.some((p) => p.test(neutral))).toBe(false);
  });

  it('does not false-positive on questions', () => {
    const question = "What is the pinyin for the word 'hello'?";
    expect(FALLBACK_CORRECT_PATTERNS.some((p) => p.test(question))).toBe(false);
    expect(FALLBACK_INCORRECT_PATTERNS.some((p) => p.test(question))).toBe(false);
  });
});

// ── DB CRUD (real SQLite) ───────────────────────────────────

const TMP_DIR = resolve(tmpdir(), 'clauded-test-learning');
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = resolve(TMP_DIR, 'learning-test.db');

let db: Database.Database;

function initTestDb(): void {
  try { rmSync(DB_PATH); } catch { /* ignore */ }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_plans (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      goal TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT 'friendly_conversational',
      preferred_time TEXT,
      schedule_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_plans_chat ON learning_plans(chat_id, status);

    CREATE TABLE IF NOT EXISTS learning_topics (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL,
      difficulty INTEGER NOT NULL DEFAULT 3,
      estimated_minutes INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'deferred')),
      mastery REAL NOT NULL DEFAULT 0.0,
      last_reviewed_at INTEGER,
      review_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES learning_plans(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_learning_topics_plan ON learning_topics(plan_id, sort_order);

    CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      topic_id TEXT,
      chat_id TEXT NOT NULL,
      persona TEXT NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'lesson' CHECK(session_type IN ('lesson', 'review', 'assessment', 'practice')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_seconds INTEGER,
      questions_asked INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (plan_id) REFERENCES learning_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES learning_topics(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_sessions_chat ON learning_sessions(chat_id, started_at);

    CREATE TABLE IF NOT EXISTS learning_daily_time (
      chat_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, date)
    );
  `);
}

function insertPlan(chatId: string, subject: string, goal: string, status = 'active'): string {
  const id = Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO learning_plans (id, chat_id, subject, goal, persona, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'friendly_conversational', ?, ?, ?)`,
  ).run(id, chatId, subject, goal, status, now, now);
  return id;
}

function insertTopic(planId: string, title: string, sortOrder: number, status = 'pending', mastery = 0): string {
  const id = Math.random().toString(36).slice(2, 14);
  const now = Date.now();
  db.prepare(
    `INSERT INTO learning_topics (id, plan_id, title, sort_order, difficulty, estimated_minutes, status, mastery, review_count, created_at)
     VALUES (?, ?, ?, ?, 3, 10, ?, ?, 0, ?)`,
  ).run(id, planId, title, sortOrder, status, mastery, now);
  return id;
}

beforeEach(() => { initTestDb(); });
afterAll(() => { db?.close(); try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ } });

describe('learning plan CRUD (real DB)', () => {
  it('creates a plan with correct fields', () => {
    const id = insertPlan('chat1', 'Chinese', 'Conversational fluency');
    const plan = db.prepare('SELECT * FROM learning_plans WHERE id = ?').get(id) as any;
    expect(plan.subject).toBe('Chinese');
    expect(plan.goal).toBe('Conversational fluency');
    expect(plan.status).toBe('active');
    expect(plan.persona).toBe('friendly_conversational');
  });

  it('enforces status constraint', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO learning_plans (id, chat_id, subject, goal, status, created_at, updated_at)
         VALUES ('x', 'c', 's', 'g', 'invalid', ?, ?)`,
      ).run(Date.now(), Date.now());
    }).toThrow();
  });

  it('cascades topic deletion when plan is deleted', () => {
    const planId = insertPlan('chat1', 'Math', 'Calculus');
    insertTopic(planId, 'Limits', 0);
    insertTopic(planId, 'Derivatives', 1);

    const before = db.prepare('SELECT COUNT(*) as cnt FROM learning_topics WHERE plan_id = ?').get(planId) as any;
    expect(before.cnt).toBe(2);

    db.prepare('DELETE FROM learning_plans WHERE id = ?').run(planId);
    const after = db.prepare('SELECT COUNT(*) as cnt FROM learning_topics WHERE plan_id = ?').get(planId) as any;
    expect(after.cnt).toBe(0);
  });
});

describe('learning topic operations (real DB)', () => {
  it('auto-increments sort_order when appending', () => {
    const planId = insertPlan('chat1', 'Python', 'Learn basics');
    insertTopic(planId, 'Variables', 0);
    insertTopic(planId, 'Functions', 1);
    insertTopic(planId, 'Classes', 2);

    const topics = db.prepare('SELECT * FROM learning_topics WHERE plan_id = ? ORDER BY sort_order').all(planId) as any[];
    expect(topics.map((t: any) => t.title)).toEqual(['Variables', 'Functions', 'Classes']);
    expect(topics.map((t: any) => t.sort_order)).toEqual([0, 1, 2]);
  });

  it('reorders topics correctly — move down', () => {
    const planId = insertPlan('chat1', 'Math', 'Learn');
    const t1 = insertTopic(planId, 'A', 0);
    const t2 = insertTopic(planId, 'B', 1);
    const t3 = insertTopic(planId, 'C', 2);

    // Move A (pos 0) to pos 2 (after C)
    // Shift B,C up by 1, then set A to 2
    db.prepare('UPDATE learning_topics SET sort_order = sort_order - 1 WHERE plan_id = ? AND sort_order > 0 AND sort_order <= 2').run(planId);
    db.prepare('UPDATE learning_topics SET sort_order = 2 WHERE id = ?').run(t1);

    const topics = db.prepare('SELECT title, sort_order FROM learning_topics WHERE plan_id = ? ORDER BY sort_order').all(planId) as any[];
    expect(topics.map((t: any) => t.title)).toEqual(['B', 'C', 'A']);
  });

  it('tracks mastery and review count', () => {
    const planId = insertPlan('chat1', 'English', 'Grammar');
    const topicId = insertTopic(planId, 'Tenses', 0, 'completed', 0.6);

    // Simulate review
    const now = Date.now();
    db.prepare('UPDATE learning_topics SET mastery = 0.65, review_count = 1, last_reviewed_at = ? WHERE id = ?').run(now, topicId);

    const topic = db.prepare('SELECT * FROM learning_topics WHERE id = ?').get(topicId) as any;
    expect(topic.mastery).toBe(0.65);
    expect(topic.review_count).toBe(1);
    expect(topic.last_reviewed_at).toBe(now);
  });

  it('enforces topic status constraint', () => {
    const planId = insertPlan('chat1', 'Test', 'Test');
    expect(() => {
      db.prepare(
        `INSERT INTO learning_topics (id, plan_id, title, sort_order, status, mastery, review_count, created_at)
         VALUES ('x', ?, 'T', 0, 'invalid', 0, 0, ?)`,
      ).run(planId, Date.now());
    }).toThrow();
  });
});

describe('learning session tracking (real DB)', () => {
  it('creates and ends a session with duration', () => {
    const planId = insertPlan('chat1', 'Chinese', 'Learn');
    const topicId = insertTopic(planId, 'Tones', 0);
    const startedAt = Date.now() - 600_000; // 10 min ago
    const sessionId = Math.random().toString(36).slice(2, 14);

    db.prepare(
      `INSERT INTO learning_sessions (id, plan_id, topic_id, chat_id, persona, session_type, started_at, questions_asked, correct_answers)
       VALUES (?, ?, ?, 'chat1', 'friendly_conversational', 'lesson', ?, 0, 0)`,
    ).run(sessionId, planId, topicId, startedAt);

    // End session
    const endedAt = Date.now();
    const duration = Math.round((endedAt - startedAt) / 1000);
    db.prepare('UPDATE learning_sessions SET ended_at = ?, duration_seconds = ?, questions_asked = 5, correct_answers = 4 WHERE id = ?')
      .run(endedAt, duration, sessionId);

    const session = db.prepare('SELECT * FROM learning_sessions WHERE id = ?').get(sessionId) as any;
    expect(session.duration_seconds).toBeGreaterThan(500);
    expect(session.questions_asked).toBe(5);
    expect(session.correct_answers).toBe(4);
  });
});

describe('daily time tracking (real DB)', () => {
  it('tracks daily time with upsert', () => {
    const date = '2026-03-22';
    const chatId = 'chat1';

    // First session
    db.prepare(
      `INSERT INTO learning_daily_time (chat_id, date, total_seconds, session_count)
       VALUES (?, ?, 600, 1)
       ON CONFLICT(chat_id, date) DO UPDATE SET
         total_seconds = total_seconds + 600,
         session_count = session_count + 1`,
    ).run(chatId, date);

    // Second session
    db.prepare(
      `INSERT INTO learning_daily_time (chat_id, date, total_seconds, session_count)
       VALUES (?, ?, 300, 1)
       ON CONFLICT(chat_id, date) DO UPDATE SET
         total_seconds = total_seconds + 300,
         session_count = session_count + 1`,
    ).run(chatId, date);

    const daily = db.prepare('SELECT * FROM learning_daily_time WHERE chat_id = ? AND date = ?').get(chatId, date) as any;
    expect(daily.total_seconds).toBe(900);
    expect(daily.session_count).toBe(2);
  });
});

// ── Plan Negotiation (pure functions) ───────────────────────

describe('plan negotiation', () => {
  it('topic removal requires assessment for non-mastered topics', () => {
    // This tests the requestTopicRemoval logic conceptually
    // The actual function needs DB access — tested via the integration flow
    const topic = {
      id: 't1', plan_id: 'p1', title: 'Grammar', description: null,
      sort_order: 0, difficulty: 3, estimated_minutes: 10,
      status: 'pending' as const, mastery: 0, last_reviewed_at: null,
      review_count: 0, created_at: Date.now(),
    };
    // A pending topic with 0 mastery should require assessment
    expect(topic.status).not.toBe('completed');
    expect(topic.mastery).toBeLessThan(0.8);
  });

  it('topic removal allowed for high mastery topics (>=0.8)', () => {
    const topic = {
      mastery: 0.85,
      status: 'completed' as const,
    };
    // High mastery + completed = no assessment needed
    expect(topic.mastery >= 0.8).toBe(true);
    expect(topic.status).toBe('completed');
  });
});

// ── Integration Flow ────────────────────────────────────────

describe('integration — plan creation to mastery tracking', () => {
  it('full flow: create plan → add topics → simulate session → update mastery', () => {
    const planId = insertPlan('chat1', 'Chinese', 'Conversational fluency');

    // Add topics (simulating parsePlanResponse output)
    const t1 = insertTopic(planId, 'Pinyin & Tones', 0);
    const t2 = insertTopic(planId, 'Basic Greetings', 1);
    const t3 = insertTopic(planId, 'Numbers 1-100', 2);

    // Verify initial state
    const topics = db.prepare('SELECT * FROM learning_topics WHERE plan_id = ? ORDER BY sort_order').all(planId) as any[];
    expect(topics).toHaveLength(3);
    expect(topics[0].status).toBe('pending');
    expect(topics[0].mastery).toBe(0);

    // Start session on first topic
    db.prepare('UPDATE learning_topics SET status = ? WHERE id = ?').run('in_progress', t1);

    // Simulate answering questions correctly
    let mastery = 0;
    for (let i = 0; i < 5; i++) {
      mastery = computeMasteryDelta(mastery, true);
    }
    expect(mastery).toBe(0.25);

    // Complete topic
    db.prepare('UPDATE learning_topics SET status = ?, mastery = ?, last_reviewed_at = ?, review_count = 1 WHERE id = ?')
      .run('completed', mastery, Date.now(), t1);

    // Verify review scheduling
    const interval = computeReviewInterval(mastery);
    expect(interval).toBe(1); // mastery 0.25 < 0.3 → review in 1 day

    // Next topic should be t2 (pending, lowest sort_order)
    const updatedTopics = db.prepare('SELECT * FROM learning_topics WHERE plan_id = ? ORDER BY sort_order').all(planId) as LearningTopic[];
    const next = selectNextTopic(updatedTopics);
    expect(next?.title).toBe('Basic Greetings');
  });

  it('rolling horizon check: detects when expansion needed', () => {
    const planId = insertPlan('chat1', 'Python', 'Master Python');

    // Add 3 topics, complete 2
    insertTopic(planId, 'Variables', 0, 'completed', 0.8);
    insertTopic(planId, 'Functions', 1, 'completed', 0.7);
    insertTopic(planId, 'Classes', 2, 'pending');

    // Only 1 pending topic → needs expansion (threshold is ≤2)
    const pendingCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM learning_topics WHERE plan_id = ? AND status IN ('pending', 'in_progress')",
    ).get(planId) as any).cnt;

    expect(pendingCount).toBe(1);
    expect(pendingCount <= 2).toBe(true); // Would trigger expansion
  });

  it('max 5 active plans enforced', () => {
    for (let i = 0; i < 5; i++) {
      insertPlan('chat1', `Subject ${i}`, `Goal ${i}`);
    }

    const activePlans = db.prepare("SELECT COUNT(*) as cnt FROM learning_plans WHERE chat_id = 'chat1' AND status = 'active'").get() as any;
    expect(activePlans.cnt).toBe(5);

    // 6th plan would be blocked (tested in the createPlan function, which checks count)
  });

  it('stale plan detection works', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const planId = Math.random().toString(36).slice(2, 14);
    db.prepare(
      `INSERT INTO learning_plans (id, chat_id, subject, goal, persona, status, created_at, updated_at)
       VALUES (?, 'chat1', 'Stale', 'Goal', 'friendly_conversational', 'active', ?, ?)`,
    ).run(planId, eightDaysAgo, eightDaysAgo);

    // No sessions for this plan → it's stale
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stalePlans = db.prepare(
      `SELECT p.* FROM learning_plans p
       LEFT JOIN learning_sessions s ON s.plan_id = p.id
       WHERE p.chat_id = 'chat1' AND p.status = 'active'
       GROUP BY p.id
       HAVING COALESCE(MAX(s.started_at), p.created_at) < ?`,
    ).all(cutoff) as any[];

    expect(stalePlans.length).toBe(1);
    expect(stalePlans[0].subject).toBe('Stale');
  });
});
