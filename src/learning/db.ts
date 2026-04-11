/**
 * Learning Coach database layer.
 * Tables: learning_plans, learning_topics, learning_sessions, learning_daily_time.
 */

import { randomBytes } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import { logger } from '../logger.js';
import type { TableInitializer } from '../core/interfaces.js';

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

export async function initLearningTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('learning_plans'))) {
    await db.schema.createTable('learning_plans', (t) => {
      t.string('id').primary();
      t.string('chat_id').notNullable();
      t.string('subject').notNullable();
      t.text('goal').notNullable();
      t.string('persona').notNullable().defaultTo('friendly_conversational');
      t.string('preferred_time').nullable();
      t.string('schedule_task_id').nullable();
      t.string('status').notNullable().defaultTo('active');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['chat_id', 'status']);
    });
  }

  if (!(await db.schema.hasTable('learning_topics'))) {
    await db.schema.createTable('learning_topics', (t) => {
      t.string('id').primary();
      t.string('plan_id').notNullable();
      t.string('title').notNullable();
      t.text('description').nullable();
      t.integer('sort_order').notNullable();
      t.integer('difficulty').notNullable().defaultTo(3);
      t.integer('estimated_minutes').notNullable().defaultTo(10);
      t.string('status').notNullable().defaultTo('pending');
      t.float('mastery').notNullable().defaultTo(0.0);
      t.bigInteger('last_reviewed_at').nullable();
      t.integer('review_count').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
      t.foreign('plan_id').references('learning_plans.id').onDelete('CASCADE');
      t.index(['plan_id', 'sort_order']);
    });
  }

  if (!(await db.schema.hasTable('learning_sessions'))) {
    await db.schema.createTable('learning_sessions', (t) => {
      t.string('id').primary();
      t.string('plan_id').notNullable();
      t.string('topic_id').nullable();
      t.string('chat_id').notNullable();
      t.string('persona').notNullable();
      t.string('session_type').notNullable().defaultTo('lesson');
      t.bigInteger('started_at').notNullable();
      t.bigInteger('ended_at').nullable();
      t.integer('duration_seconds').nullable();
      t.integer('questions_asked').notNullable().defaultTo(0);
      t.integer('correct_answers').notNullable().defaultTo(0);
      t.text('notes').nullable();
      t.foreign('plan_id').references('learning_plans.id').onDelete('CASCADE');
      t.foreign('topic_id').references('learning_topics.id').onDelete('SET NULL');
      t.index(['chat_id', 'started_at']);
    });
  }

  if (!(await db.schema.hasTable('learning_daily_time'))) {
    await db.schema.createTable('learning_daily_time', (t) => {
      t.string('chat_id').notNullable();
      t.string('date').notNullable();
      t.integer('total_seconds').notNullable().defaultTo(0);
      t.integer('session_count').notNullable().defaultTo(0);
      t.primary(['chat_id', 'date']);
    });
  }

  logger.info('Learning tables initialized');
}

export const learningTableInit: TableInitializer = { name: 'learning', initTables: initLearningTables };

// ── ID Generation ───────────────────────────────────────────

function generateId(): string {
  return randomBytes(6).toString('hex');
}

// ── Plans CRUD ──────────────────────────────────────────────

export async function createPlan(
  chatId: string,
  subject: string,
  goal: string,
  persona: string = 'friendly_conversational',
): Promise<LearningPlan> {
  const db = getKnex();

  // Enforce max active plans
  const activePlans = await getActivePlansByChat(chatId);
  if (activePlans.length >= MAX_ACTIVE_PLANS) {
    throw new Error(
      `You already have ${MAX_ACTIVE_PLANS} active learning plans. ` +
      'Complete or pause an existing plan before starting a new one.',
    );
  }

  const id = generateId();
  const now = Date.now();

  await db('learning_plans').insert({
    id, chat_id: chatId, subject, goal, persona,
    status: 'active', created_at: now, updated_at: now,
  });

  return (await getPlan(id))!;
}

export async function getPlan(id: string): Promise<LearningPlan | undefined> {
  const db = getKnex();
  return db('learning_plans').where({ id }).first();
}

export async function getPlansByChat(chatId: string): Promise<LearningPlan[]> {
  const db = getKnex();
  return db('learning_plans').where({ chat_id: chatId }).orderBy('updated_at', 'desc');
}

/** Get all plans across all chats (for web dashboard). */
export async function getAllPlans(): Promise<LearningPlan[]> {
  const db = getKnex();
  return db('learning_plans').orderBy('updated_at', 'desc');
}

/** Get all daily time records across all chats for the last N days. */
export async function getAllWeeklyTime(days: number = 7): Promise<DailyTime[]> {
  const db = getKnex();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db('learning_daily_time').where('date', '>=', cutoff).orderBy('date');
}

/** Get all recent sessions across all chats. */
export async function getAllRecentSessions(limit: number = 20): Promise<LearningSession[]> {
  const db = getKnex();
  return db('learning_sessions').orderBy('started_at', 'desc').limit(limit);
}

/** Get recent sessions for a specific chat. */
export async function getRecentSessionsByChat(chatId: string, limit: number = 20): Promise<LearningSession[]> {
  const db = getKnex();
  return db('learning_sessions').where({ chat_id: chatId }).orderBy('started_at', 'desc').limit(limit);
}

/** Calculate study streak: consecutive days meeting the goal (10 min). */
export async function calculateStreak(chatId?: string): Promise<number> {
  const db = getKnex();
  let rows: Array<{ date: string; total_seconds: number }>;

  if (chatId) {
    rows = await db('learning_daily_time')
      .where({ chat_id: chatId })
      .orderBy('date', 'desc')
      .limit(60)
      .select('date', 'total_seconds');
  } else {
    rows = await db('learning_daily_time')
      .select('date')
      .sum('total_seconds as total_seconds')
      .groupBy('date')
      .orderBy('date', 'desc')
      .limit(60) as Array<{ date: string; total_seconds: number }>;
  }

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

export async function getActivePlansByChat(chatId: string): Promise<LearningPlan[]> {
  const db = getKnex();
  return db('learning_plans')
    .where({ chat_id: chatId, status: 'active' })
    .orderBy('updated_at', 'desc');
}

export async function getPlanBySubject(chatId: string, subject: string): Promise<LearningPlan | undefined> {
  const db = getKnex();
  return db('learning_plans')
    .where({ chat_id: chatId })
    .whereRaw('LOWER(subject) = LOWER(?)', [subject])
    .whereNot({ status: 'completed' })
    .first();
}

export async function updatePlan(
  id: string,
  updates: Partial<Pick<LearningPlan, 'persona' | 'preferred_time' | 'schedule_task_id' | 'status'>>,
): Promise<LearningPlan | undefined> {
  const db = getKnex();
  const plan = await getPlan(id);
  if (!plan) return undefined;

  const data: Record<string, unknown> = { updated_at: Date.now() };
  if (updates.persona !== undefined) data.persona = updates.persona;
  if (updates.preferred_time !== undefined) data.preferred_time = updates.preferred_time;
  if (updates.schedule_task_id !== undefined) data.schedule_task_id = updates.schedule_task_id;
  if (updates.status !== undefined) data.status = updates.status;

  if (Object.keys(data).length <= 1) return plan; // only updated_at

  await db('learning_plans').where({ id }).update(data);
  return getPlan(id);
}

export async function deletePlan(id: string): Promise<boolean> {
  const db = getKnex();
  const count = await db('learning_plans').where({ id }).del();
  return count > 0;
}

// ── Topics CRUD ─────────────────────────────────────────────

export async function createTopic(
  planId: string,
  title: string,
  options?: {
    description?: string;
    sortOrder?: number;
    difficulty?: number;
    estimatedMinutes?: number;
  },
): Promise<LearningTopic> {
  const db = getKnex();
  const id = generateId();
  const now = Date.now();

  // Auto-assign sort_order if not specified: append after last topic
  let sortOrder = options?.sortOrder;
  if (sortOrder === undefined) {
    const last = await db('learning_topics')
      .where({ plan_id: planId })
      .max('sort_order as max_order')
      .first() as { max_order: number | null } | undefined;
    sortOrder = (last?.max_order ?? -1) + 1;
  }

  await db('learning_topics').insert({
    id, plan_id: planId, title,
    description: options?.description ?? null,
    sort_order: sortOrder,
    difficulty: options?.difficulty ?? 3,
    estimated_minutes: options?.estimatedMinutes ?? 10,
    status: 'pending', mastery: 0.0, review_count: 0, created_at: now,
  });

  return (await getTopic(id))!;
}

export async function getTopic(id: string): Promise<LearningTopic | undefined> {
  const db = getKnex();
  return db('learning_topics').where({ id }).first();
}

export async function getTopicsByPlan(planId: string): Promise<LearningTopic[]> {
  const db = getKnex();
  return db('learning_topics').where({ plan_id: planId }).orderBy('sort_order');
}

export async function getPendingTopics(planId: string): Promise<LearningTopic[]> {
  const db = getKnex();
  return db('learning_topics')
    .where({ plan_id: planId })
    .whereIn('status', ['pending', 'in_progress'])
    .orderBy('sort_order');
}

export async function getCompletedTopics(planId: string): Promise<LearningTopic[]> {
  const db = getKnex();
  return db('learning_topics')
    .where({ plan_id: planId, status: 'completed' })
    .orderBy('sort_order');
}

export async function getTopicByTitle(planId: string, title: string): Promise<LearningTopic | undefined> {
  const db = getKnex();
  return db('learning_topics')
    .where({ plan_id: planId })
    .whereRaw('LOWER(title) = LOWER(?)', [title])
    .first();
}

export async function updateTopic(
  id: string,
  updates: Partial<Pick<LearningTopic, 'status' | 'mastery' | 'last_reviewed_at' | 'review_count' | 'sort_order' | 'description'>>,
): Promise<LearningTopic | undefined> {
  const db = getKnex();
  const topic = await getTopic(id);
  if (!topic) return undefined;

  const data: Record<string, unknown> = {};
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.mastery !== undefined) data.mastery = updates.mastery;
  if (updates.last_reviewed_at !== undefined) data.last_reviewed_at = updates.last_reviewed_at;
  if (updates.review_count !== undefined) data.review_count = updates.review_count;
  if (updates.sort_order !== undefined) data.sort_order = updates.sort_order;
  if (updates.description !== undefined) data.description = updates.description;

  if (Object.keys(data).length === 0) return topic;

  await db('learning_topics').where({ id }).update(data);
  return getTopic(id);
}

/** Reorder: move topic to a new position, shifting others. */
export async function reorderTopic(topicId: string, newPosition: number): Promise<boolean> {
  const db = getKnex();
  const topic = await getTopic(topicId);
  if (!topic) return false;

  const allTopics = await getTopicsByPlan(topic.plan_id);
  const oldPosition = topic.sort_order;

  if (newPosition === oldPosition) return true;
  if (newPosition < 0 || newPosition >= allTopics.length) return false;

  // Shift topics between old and new position
  if (newPosition < oldPosition) {
    // Moving up: shift topics in [newPosition, oldPosition) down by 1
    await db('learning_topics')
      .where({ plan_id: topic.plan_id })
      .where('sort_order', '>=', newPosition)
      .where('sort_order', '<', oldPosition)
      .update({ sort_order: db.raw('sort_order + 1') });
  } else {
    // Moving down: shift topics in (oldPosition, newPosition] up by 1
    await db('learning_topics')
      .where({ plan_id: topic.plan_id })
      .where('sort_order', '>', oldPosition)
      .where('sort_order', '<=', newPosition)
      .update({ sort_order: db.raw('sort_order - 1') });
  }

  // Set the topic to its new position
  await db('learning_topics').where({ id: topicId }).update({ sort_order: newPosition });
  return true;
}

export async function deleteTopic(id: string): Promise<boolean> {
  const db = getKnex();
  const topic = await getTopic(id);
  if (!topic) return false;

  await db('learning_topics').where({ id }).del();

  // Re-number remaining topics to close the gap
  const remaining = await getTopicsByPlan(topic.plan_id);
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].sort_order !== i) {
      await db('learning_topics').where({ id: remaining[i].id }).update({ sort_order: i });
    }
  }
  return true;
}

// ── Sessions CRUD ───────────────────────────────────────────

export async function createSession(
  planId: string,
  chatId: string,
  persona: string,
  sessionType: SessionType = 'lesson',
  topicId?: string,
): Promise<LearningSession> {
  const db = getKnex();
  const id = generateId();
  const now = Date.now();

  await db('learning_sessions').insert({
    id, plan_id: planId, topic_id: topicId ?? null,
    chat_id: chatId, persona, session_type: sessionType,
    started_at: now, questions_asked: 0, correct_answers: 0,
  });

  return (await getSession(id))!;
}

export async function getSession(id: string): Promise<LearningSession | undefined> {
  const db = getKnex();
  return db('learning_sessions').where({ id }).first();
}

export async function updateSession(
  id: string,
  updates: Partial<Pick<LearningSession, 'ended_at' | 'duration_seconds' | 'questions_asked' | 'correct_answers' | 'notes' | 'topic_id'>>,
): Promise<LearningSession | undefined> {
  const db = getKnex();
  const data: Record<string, unknown> = {};

  if (updates.ended_at !== undefined) data.ended_at = updates.ended_at;
  if (updates.duration_seconds !== undefined) data.duration_seconds = updates.duration_seconds;
  if (updates.questions_asked !== undefined) data.questions_asked = updates.questions_asked;
  if (updates.correct_answers !== undefined) data.correct_answers = updates.correct_answers;
  if (updates.notes !== undefined) data.notes = updates.notes;
  if (updates.topic_id !== undefined) data.topic_id = updates.topic_id;

  if (Object.keys(data).length === 0) return getSession(id);

  await db('learning_sessions').where({ id }).update(data);
  return getSession(id);
}

export async function getSessionsByPlan(planId: string, limit: number = 20): Promise<LearningSession[]> {
  const db = getKnex();
  return db('learning_sessions').where({ plan_id: planId }).orderBy('started_at', 'desc').limit(limit);
}

export async function getSessionsByChat(chatId: string, limit: number = 20): Promise<LearningSession[]> {
  const db = getKnex();
  return db('learning_sessions').where({ chat_id: chatId }).orderBy('started_at', 'desc').limit(limit);
}

// ── Daily Time Tracking ─────────────────────────────────────

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function addDailyTime(chatId: string, seconds: number): Promise<DailyTime> {
  const db = getKnex();
  const date = todayDateString();

  await db('learning_daily_time')
    .insert({ chat_id: chatId, date, total_seconds: seconds, session_count: 1 })
    .onConflict(['chat_id', 'date'])
    .merge({
      total_seconds: db.raw('learning_daily_time.total_seconds + ?', [seconds]),
      session_count: db.raw('learning_daily_time.session_count + 1'),
    });

  return (await getDailyTime(chatId, date))!;
}

export async function getDailyTime(chatId: string, date?: string): Promise<DailyTime | undefined> {
  const db = getKnex();
  const d = date ?? todayDateString();
  return db('learning_daily_time').where({ chat_id: chatId, date: d }).first();
}

export async function getWeeklyTime(chatId: string): Promise<DailyTime[]> {
  const db = getKnex();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db('learning_daily_time')
    .where({ chat_id: chatId })
    .where('date', '>=', sevenDaysAgo)
    .orderBy('date');
}

/** Get least-recently-studied active plan for session rotation. */
export async function getLeastRecentPlan(chatId: string): Promise<LearningPlan | undefined> {
  const db = getKnex();
  return db('learning_plans as p')
    .leftJoin('learning_sessions as s', 's.plan_id', 'p.id')
    .where({ 'p.chat_id': chatId, 'p.status': 'active' })
    .groupBy('p.id')
    .orderByRaw('COALESCE(MAX(s.started_at), 0) ASC')
    .select('p.*')
    .first();
}

/** Get plan with most overdue review topics. */
export async function getMostOverduePlan(chatId: string): Promise<(LearningPlan & { overdue_count: number }) | undefined> {
  const db = getKnex();
  const now = Date.now();
  return db('learning_plans as p')
    .join('learning_topics as t', 't.plan_id', 'p.id')
    .where({ 'p.chat_id': chatId, 'p.status': 'active', 't.status': 'completed' })
    .whereNotNull('t.last_reviewed_at')
    .where('t.last_reviewed_at', '<', now - 24 * 60 * 60 * 1000)
    .groupBy('p.id')
    .orderBy('overdue_count', 'desc')
    .select('p.*', db.raw('COUNT(t.id) as overdue_count'))
    .first() as unknown as (LearningPlan & { overdue_count: number }) | undefined;
}

/** Get plans that haven't had a session in the given number of days. */
export async function getStalePlans(chatId: string, staleDays: number = 7): Promise<LearningPlan[]> {
  const db = getKnex();
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  return db('learning_plans as p')
    .leftJoin('learning_sessions as s', 's.plan_id', 'p.id')
    .where({ 'p.chat_id': chatId, 'p.status': 'active' })
    .groupBy('p.id')
    .havingRaw('COALESCE(MAX(s.started_at), p.created_at) < ?', [cutoff])
    .select('p.*');
}
