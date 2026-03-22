/**
 * Learning Coach database layer.
 * Tables: learning_plans, learning_topics, learning_sessions, learning_daily_time.
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

// ── Types ───────────────────────────────────────────────────

export type PlanStatus = 'active' | 'paused' | 'completed';
export type TopicStatus = 'pending' | 'in_progress' | 'completed' | 'deferred';
export type SessionType = 'lesson' | 'review' | 'assessment' | 'practice';

export interface LearningPlan {
  id: string;
  chat_id: string;
  subject: string;
  goal: string;
  persona: string;
  preferred_time: string | null;
  schedule_task_id: string | null;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
}

export interface LearningTopic {
  id: string;
  plan_id: string;
  title: string;
  description: string | null;
  sort_order: number;
  difficulty: number;
  estimated_minutes: number;
  status: TopicStatus;
  mastery: number;
  last_reviewed_at: number | null;
  review_count: number;
  created_at: number;
}

export interface LearningSession {
  id: string;
  plan_id: string;
  topic_id: string | null;
  chat_id: string;
  persona: string;
  session_type: SessionType;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number | null;
  questions_asked: number;
  correct_answers: number;
  notes: string | null;
}

export interface DailyTime {
  chat_id: string;
  date: string;
  total_seconds: number;
  session_count: number;
}

// ── Constants ───────────────────────────────────────────────

const MAX_ACTIVE_PLANS = 5;

// ── Initialization ──────────────────────────────────────────

export function initLearningTables(): void {
  const db = getDatabase();

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

    CREATE INDEX IF NOT EXISTS idx_learning_plans_chat
      ON learning_plans(chat_id, status);

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

    CREATE INDEX IF NOT EXISTS idx_learning_topics_plan
      ON learning_topics(plan_id, sort_order);

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

    CREATE INDEX IF NOT EXISTS idx_learning_sessions_chat
      ON learning_sessions(chat_id, started_at);

    CREATE TABLE IF NOT EXISTS learning_daily_time (
      chat_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, date)
    );
  `);

  logger.info('Learning tables initialized');
}

// ── ID Generation ───────────────────────────────────────────

function generateId(): string {
  return randomBytes(6).toString('hex');
}

// ── Plans CRUD ──────────────────────────────────────────────

export function createPlan(
  chatId: string,
  subject: string,
  goal: string,
  persona: string = 'friendly_conversational',
): LearningPlan {
  const db = getDatabase();

  // Enforce max active plans
  const activePlans = getActivePlansByChat(chatId);
  if (activePlans.length >= MAX_ACTIVE_PLANS) {
    throw new Error(
      `You already have ${MAX_ACTIVE_PLANS} active learning plans. ` +
      'Complete or pause an existing plan before starting a new one.',
    );
  }

  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO learning_plans (id, chat_id, subject, goal, persona, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, chatId, subject, goal, persona, now, now);

  return getPlan(id)!;
}

export function getPlan(id: string): LearningPlan | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM learning_plans WHERE id = ?').get(id) as LearningPlan | undefined;
}

export function getPlansByChat(chatId: string): LearningPlan[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_plans WHERE chat_id = ? ORDER BY updated_at DESC',
  ).all(chatId) as LearningPlan[];
}

/** Get all plans across all chats (for web dashboard). */
export function getAllPlans(): LearningPlan[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_plans ORDER BY updated_at DESC',
  ).all() as LearningPlan[];
}

/** Get all daily time records across all chats for the last N days. */
export function getAllWeeklyTime(days: number = 7): DailyTime[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.prepare(
    'SELECT * FROM learning_daily_time WHERE date >= ? ORDER BY date',
  ).all(cutoff) as DailyTime[];
}

/** Get all recent sessions across all chats. */
export function getAllRecentSessions(limit: number = 20): LearningSession[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_sessions ORDER BY started_at DESC LIMIT ?',
  ).all(limit) as LearningSession[];
}

/** Calculate study streak: consecutive days meeting the goal (10 min). */
export function calculateStreak(chatId?: string): number {
  const db = getDatabase();
  const rows = db.prepare(
    chatId
      ? 'SELECT date, total_seconds FROM learning_daily_time WHERE chat_id = ? ORDER BY date DESC LIMIT 60'
      : 'SELECT date, SUM(total_seconds) as total_seconds FROM learning_daily_time GROUP BY date ORDER BY date DESC LIMIT 60',
  ).all(...(chatId ? [chatId] : [])) as Array<{ date: string; total_seconds: number }>;

  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = rows.find((r) => r.date === expected);

    // Allow today to be missing (day not over yet) but still count streak
    if (!row && i === 0 && rows[0]?.date !== today) continue;
    if (!row) break;
    if (row.total_seconds < 600) break; // 10 min = 600 seconds goal
    streak++;
  }

  return streak;
}

export function getActivePlansByChat(chatId: string): LearningPlan[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM learning_plans WHERE chat_id = ? AND status = 'active' ORDER BY updated_at DESC",
  ).all(chatId) as LearningPlan[];
}

export function getPlanBySubject(chatId: string, subject: string): LearningPlan | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_plans WHERE chat_id = ? AND LOWER(subject) = LOWER(?) AND status != ?',
  ).get(chatId, subject, 'completed') as LearningPlan | undefined;
}

export function updatePlan(
  id: string,
  updates: Partial<Pick<LearningPlan, 'persona' | 'preferred_time' | 'schedule_task_id' | 'status'>>,
): LearningPlan | undefined {
  const db = getDatabase();
  const plan = getPlan(id);
  if (!plan) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.persona !== undefined) { fields.push('persona = ?'); values.push(updates.persona); }
  if (updates.preferred_time !== undefined) { fields.push('preferred_time = ?'); values.push(updates.preferred_time); }
  if (updates.schedule_task_id !== undefined) { fields.push('schedule_task_id = ?'); values.push(updates.schedule_task_id); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return plan;

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.prepare(`UPDATE learning_plans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getPlan(id);
}

export function deletePlan(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM learning_plans WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Topics CRUD ─────────────────────────────────────────────

export function createTopic(
  planId: string,
  title: string,
  options?: {
    description?: string;
    sortOrder?: number;
    difficulty?: number;
    estimatedMinutes?: number;
  },
): LearningTopic {
  const db = getDatabase();
  const id = generateId();
  const now = Date.now();

  // Auto-assign sort_order if not specified: append after last topic
  let sortOrder = options?.sortOrder;
  if (sortOrder === undefined) {
    const last = db.prepare(
      'SELECT MAX(sort_order) as max_order FROM learning_topics WHERE plan_id = ?',
    ).get(planId) as { max_order: number | null } | undefined;
    sortOrder = (last?.max_order ?? -1) + 1;
  }

  db.prepare(
    `INSERT INTO learning_topics (id, plan_id, title, description, sort_order, difficulty, estimated_minutes, status, mastery, review_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0.0, 0, ?)`,
  ).run(
    id, planId, title,
    options?.description ?? null,
    sortOrder,
    options?.difficulty ?? 3,
    options?.estimatedMinutes ?? 10,
    now,
  );

  return getTopic(id)!;
}

export function getTopic(id: string): LearningTopic | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM learning_topics WHERE id = ?').get(id) as LearningTopic | undefined;
}

export function getTopicsByPlan(planId: string): LearningTopic[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_topics WHERE plan_id = ? ORDER BY sort_order',
  ).all(planId) as LearningTopic[];
}

export function getPendingTopics(planId: string): LearningTopic[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM learning_topics WHERE plan_id = ? AND status IN ('pending', 'in_progress') ORDER BY sort_order",
  ).all(planId) as LearningTopic[];
}

export function getCompletedTopics(planId: string): LearningTopic[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM learning_topics WHERE plan_id = ? AND status = 'completed' ORDER BY sort_order",
  ).all(planId) as LearningTopic[];
}

export function getTopicByTitle(planId: string, title: string): LearningTopic | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_topics WHERE plan_id = ? AND LOWER(title) = LOWER(?)',
  ).get(planId, title) as LearningTopic | undefined;
}

export function updateTopic(
  id: string,
  updates: Partial<Pick<LearningTopic, 'status' | 'mastery' | 'last_reviewed_at' | 'review_count' | 'sort_order' | 'description'>>,
): LearningTopic | undefined {
  const db = getDatabase();
  const topic = getTopic(id);
  if (!topic) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.mastery !== undefined) { fields.push('mastery = ?'); values.push(updates.mastery); }
  if (updates.last_reviewed_at !== undefined) { fields.push('last_reviewed_at = ?'); values.push(updates.last_reviewed_at); }
  if (updates.review_count !== undefined) { fields.push('review_count = ?'); values.push(updates.review_count); }
  if (updates.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(updates.sort_order); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }

  if (fields.length === 0) return topic;

  values.push(id);
  db.prepare(`UPDATE learning_topics SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTopic(id);
}

/** Reorder: move topic to a new position, shifting others. */
export function reorderTopic(topicId: string, newPosition: number): boolean {
  const db = getDatabase();
  const topic = getTopic(topicId);
  if (!topic) return false;

  const allTopics = getTopicsByPlan(topic.plan_id);
  const oldPosition = topic.sort_order;

  if (newPosition === oldPosition) return true;
  if (newPosition < 0 || newPosition >= allTopics.length) return false;

  // Shift topics between old and new position
  if (newPosition < oldPosition) {
    // Moving up: shift topics in [newPosition, oldPosition) down by 1
    db.prepare(
      'UPDATE learning_topics SET sort_order = sort_order + 1 WHERE plan_id = ? AND sort_order >= ? AND sort_order < ?',
    ).run(topic.plan_id, newPosition, oldPosition);
  } else {
    // Moving down: shift topics in (oldPosition, newPosition] up by 1
    db.prepare(
      'UPDATE learning_topics SET sort_order = sort_order - 1 WHERE plan_id = ? AND sort_order > ? AND sort_order <= ?',
    ).run(topic.plan_id, oldPosition, newPosition);
  }

  // Set the topic to its new position
  db.prepare('UPDATE learning_topics SET sort_order = ? WHERE id = ?').run(newPosition, topicId);
  return true;
}

export function deleteTopic(id: string): boolean {
  const db = getDatabase();
  const topic = getTopic(id);
  if (!topic) return false;

  db.prepare('DELETE FROM learning_topics WHERE id = ?').run(id);

  // Re-number remaining topics to close the gap
  const remaining = getTopicsByPlan(topic.plan_id);
  const reorder = db.prepare('UPDATE learning_topics SET sort_order = ? WHERE id = ?');
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].sort_order !== i) {
      reorder.run(i, remaining[i].id);
    }
  }
  return true;
}

// ── Sessions CRUD ───────────────────────────────────────────

export function createSession(
  planId: string,
  chatId: string,
  persona: string,
  sessionType: SessionType = 'lesson',
  topicId?: string,
): LearningSession {
  const db = getDatabase();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO learning_sessions (id, plan_id, topic_id, chat_id, persona, session_type, started_at, questions_asked, correct_answers)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(id, planId, topicId ?? null, chatId, persona, sessionType, now);

  return getSession(id)!;
}

export function getSession(id: string): LearningSession | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM learning_sessions WHERE id = ?').get(id) as LearningSession | undefined;
}

export function updateSession(
  id: string,
  updates: Partial<Pick<LearningSession, 'ended_at' | 'duration_seconds' | 'questions_asked' | 'correct_answers' | 'notes' | 'topic_id'>>,
): LearningSession | undefined {
  const db = getDatabase();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.ended_at !== undefined) { fields.push('ended_at = ?'); values.push(updates.ended_at); }
  if (updates.duration_seconds !== undefined) { fields.push('duration_seconds = ?'); values.push(updates.duration_seconds); }
  if (updates.questions_asked !== undefined) { fields.push('questions_asked = ?'); values.push(updates.questions_asked); }
  if (updates.correct_answers !== undefined) { fields.push('correct_answers = ?'); values.push(updates.correct_answers); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
  if (updates.topic_id !== undefined) { fields.push('topic_id = ?'); values.push(updates.topic_id); }

  if (fields.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE learning_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function getSessionsByPlan(planId: string, limit: number = 20): LearningSession[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_sessions WHERE plan_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(planId, limit) as LearningSession[];
}

export function getSessionsByChat(chatId: string, limit: number = 20): LearningSession[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM learning_sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(chatId, limit) as LearningSession[];
}

// ── Daily Time Tracking ─────────────────────────────────────

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDailyTime(chatId: string, seconds: number): DailyTime {
  const db = getDatabase();
  const date = todayDateString();

  db.prepare(
    `INSERT INTO learning_daily_time (chat_id, date, total_seconds, session_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(chat_id, date) DO UPDATE SET
       total_seconds = total_seconds + ?,
       session_count = session_count + 1`,
  ).run(chatId, date, seconds, seconds);

  return getDailyTime(chatId, date)!;
}

export function getDailyTime(chatId: string, date?: string): DailyTime | undefined {
  const db = getDatabase();
  const d = date ?? todayDateString();
  return db.prepare(
    'SELECT * FROM learning_daily_time WHERE chat_id = ? AND date = ?',
  ).get(chatId, d) as DailyTime | undefined;
}

export function getWeeklyTime(chatId: string): DailyTime[] {
  const db = getDatabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.prepare(
    'SELECT * FROM learning_daily_time WHERE chat_id = ? AND date >= ? ORDER BY date',
  ).all(chatId, sevenDaysAgo) as DailyTime[];
}

/** Get least-recently-studied active plan for session rotation. */
export function getLeastRecentPlan(chatId: string): LearningPlan | undefined {
  const db = getDatabase();
  return db.prepare(
    `SELECT p.* FROM learning_plans p
     LEFT JOIN learning_sessions s ON s.plan_id = p.id
     WHERE p.chat_id = ? AND p.status = 'active'
     GROUP BY p.id
     ORDER BY COALESCE(MAX(s.started_at), 0) ASC
     LIMIT 1`,
  ).get(chatId) as LearningPlan | undefined;
}

/** Get plan with most overdue review topics. */
export function getMostOverduePlan(chatId: string): LearningPlan | undefined {
  const db = getDatabase();
  const now = Date.now();
  return db.prepare(
    `SELECT p.*, COUNT(t.id) as overdue_count FROM learning_plans p
     JOIN learning_topics t ON t.plan_id = p.id
     WHERE p.chat_id = ? AND p.status = 'active'
       AND t.status = 'completed'
       AND t.last_reviewed_at IS NOT NULL
       AND t.last_reviewed_at < ?
     GROUP BY p.id
     ORDER BY overdue_count DESC
     LIMIT 1`,
  ).get(chatId, now - 24 * 60 * 60 * 1000) as (LearningPlan & { overdue_count: number }) | undefined;
}

/** Get plans that haven't had a session in the given number of days. */
export function getStalePlans(chatId: string, staleDays: number = 7): LearningPlan[] {
  const db = getDatabase();
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  return db.prepare(
    `SELECT p.* FROM learning_plans p
     LEFT JOIN learning_sessions s ON s.plan_id = p.id
     WHERE p.chat_id = ? AND p.status = 'active'
     GROUP BY p.id
     HAVING COALESCE(MAX(s.started_at), p.created_at) < ?`,
  ).all(chatId, cutoff) as LearningPlan[];
}
