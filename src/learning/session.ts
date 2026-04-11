/**
 * Learning session engine — state machine for active learning sessions.
 * Manages session lifecycle, assessment markers, time tracking, and system prompts.
 */

import { logger } from '../logger.js';
import {
  createSession as createDbSession, updateSession, addDailyTime,
  getTopicsByPlan, getPendingTopics, updateTopic, getPlan,
  type LearningPlan, type LearningTopic, type SessionType,
} from './db.js';
import { buildPersonaPrompt } from './personas.js';
import {
  computeMasteryDelta, selectNextTopic, getMasterySummary, countDueReviews,
} from './spaced-repetition.js';
import { needsExpansion } from './plan.js';

// ── Types ───────────────────────────────────────────────────

export interface ActiveSession {
  sessionId: string;
  planId: string;
  topicId: string | null;
  topicTitle: string;
  subject: string;
  persona: string;
  startedAt: number;
  lastActivityAt: number;
  questionsAsked: number;
  correctAnswers: number;
  type: SessionType;
  assessmentTarget?: string; // topic title being assessed for removal
}

export interface SessionProcessResult {
  correct: number;
  incorrect: number;
  topicComplete: boolean;
  assessmentPassed?: boolean;
  assessmentFailed?: boolean;
  quizStarted: boolean;
}

// ── Session State (in-memory) ───────────────────────────────

const activeSessions = new Map<string, ActiveSession>();

// Timeout cleanup: end sessions with >15 min inactivity
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

/** Exported for testing. */
export function getActiveSessions(): Map<string, ActiveSession> {
  return activeSessions;
}

// ── Session Lifecycle ───────────────────────────────────────

/**
 * Start a new learning session.
 */
export async function startSession(
  chatId: string,
  plan: LearningPlan,
  options?: {
    topicId?: string;
    type?: SessionType;
    assessmentTarget?: string;
  },
): Promise<{ session: ActiveSession; openingPrompt: string }> {
  // End any existing session first
  if (activeSessions.has(chatId)) {
    await endSession(chatId, 'new_session');
  }

  const topics = await getTopicsByPlan(plan.id);
  const type = options?.type ?? 'lesson';

  // Select topic
  let topic: LearningTopic | null = null;
  if (options?.topicId) {
    topic = topics.find((t) => t.id === options.topicId) ?? null;
  } else if (type === 'review') {
    topic = selectNextTopic(topics);
  } else {
    topic = selectNextTopic(topics);
  }

  const topicTitle = topic?.title ?? plan.subject;

  // Create DB record
  const dbSession = await createDbSession(
    plan.id, chatId, plan.persona, type, topic?.id,
  );

  // Mark topic as in_progress if pending
  if (topic && topic.status === 'pending') {
    await updateTopic(topic.id, { status: 'in_progress' });
  }

  const session: ActiveSession = {
    sessionId: dbSession.id,
    planId: plan.id,
    topicId: topic?.id ?? null,
    topicTitle,
    subject: plan.subject,
    persona: plan.persona,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    questionsAsked: 0,
    correctAnswers: 0,
    type,
    assessmentTarget: options?.assessmentTarget,
  };

  activeSessions.set(chatId, session);

  // Build opening prompt
  const openingPrompt = buildOpeningPrompt(session, plan, topic, topics);

  logger.info(
    { chatId, sessionId: dbSession.id, topic: topicTitle, type, persona: plan.persona },
    'Learning session started',
  );

  return { session, openingPrompt };
}

/**
 * Check if a learning session is active for a chat.
 */
export function isSessionActive(chatId: string): boolean {
  return activeSessions.has(chatId);
}

/**
 * Get the active session for a chat.
 */
export function getActiveSession(chatId: string): ActiveSession | undefined {
  return activeSessions.get(chatId);
}

/**
 * Update last activity timestamp (called on each message during session).
 */
export function touchSession(chatId: string): void {
  const session = activeSessions.get(chatId);
  if (session) session.lastActivityAt = Date.now();
}

/**
 * NLP fallback patterns for when the AI doesn't use exact bracket markers.
 * Only triggered when NO bracket markers were found in the response.
 * Exported for testing.
 */
export const FALLBACK_CORRECT_PATTERNS = [
  /\bthat'?s\s+(exactly\s+)?(?:right|correct)\b/i,
  /\b(?:well done|excellent|perfect|great job|exactly right|spot on|nicely done)\b/i,
  /\bcorrect(?:ly)?[.!]\s/i,
  /\byes[,!]?\s+(?:that'?s|you'?re|exactly)/i,
];

export const FALLBACK_INCORRECT_PATTERNS = [
  /\b(?:not quite|not exactly|that'?s not|incorrect|wrong)\b/i,
  /\b(?:actually|unfortunately),?\s+(?:that|the|no)\b/i,
  /\b(?:close|almost),?\s+but\b/i,
  /\bnot\s+(?:right|correct)\b/i,
];

/**
 * Process AI response during a learning session.
 * Detects assessment markers (exact or fuzzy) and updates mastery.
 */
export async function processSessionResponse(chatId: string, aiResponse: string): Promise<SessionProcessResult> {
  const session = activeSessions.get(chatId);
  const result: SessionProcessResult = {
    correct: 0,
    incorrect: 0,
    topicComplete: false,
    quizStarted: false,
  };

  if (!session) return result;

  // Count exact bracket markers first
  const correctMatches = aiResponse.match(/\[CORRECT\]/gi);
  const incorrectMatches = aiResponse.match(/\[INCORRECT\]/gi);
  const topicComplete = /\[TOPIC_COMPLETE\]/i.test(aiResponse);
  const assessmentPassed = /\[ASSESSMENT_PASSED\]/i.test(aiResponse);
  const assessmentFailed = /\[ASSESSMENT_FAILED\]/i.test(aiResponse);
  const quizStarted = /\[QUIZ_START\]/i.test(aiResponse);

  result.correct = correctMatches?.length ?? 0;
  result.incorrect = incorrectMatches?.length ?? 0;

  // NLP fallback: if no bracket markers found but session has had questions,
  // use fuzzy pattern matching to detect correct/incorrect answers
  if (result.correct === 0 && result.incorrect === 0 && session.questionsAsked > 0) {
    const hasCorrect = FALLBACK_CORRECT_PATTERNS.some((p) => p.test(aiResponse));
    const hasIncorrect = FALLBACK_INCORRECT_PATTERNS.some((p) => p.test(aiResponse));
    if (hasCorrect && !hasIncorrect) result.correct = 1;
    else if (hasIncorrect && !hasCorrect) result.incorrect = 1;
    // If both or neither match, don't guess — skip this turn
  }

  result.topicComplete = topicComplete;
  result.assessmentPassed = assessmentPassed || undefined;
  result.assessmentFailed = assessmentFailed || undefined;
  result.quizStarted = quizStarted;

  // Update session stats
  session.questionsAsked += result.correct + result.incorrect;
  session.correctAnswers += result.correct;

  // Update topic mastery for each answer
  if (session.topicId && (result.correct > 0 || result.incorrect > 0)) {
    const topics = await getTopicsByPlan(session.planId);
    const topic = topics.find((t) => t.id === session.topicId);
    if (topic) {
      let mastery = topic.mastery;
      for (let i = 0; i < result.correct; i++) mastery = computeMasteryDelta(mastery, true);
      for (let i = 0; i < result.incorrect; i++) mastery = computeMasteryDelta(mastery, false);

      await updateTopic(topic.id, {
        mastery,
        last_reviewed_at: Date.now(),
        review_count: topic.review_count + 1,
      });
    }
  }

  // Handle topic completion
  if (topicComplete && session.topicId) {
    await updateTopic(session.topicId, { status: 'completed' });
  }

  return result;
}

/**
 * Strip assessment markers from AI response before sending to user.
 */
export function stripMarkers(text: string): string {
  return text
    .replace(/\[CORRECT\]/gi, '')
    .replace(/\[INCORRECT\]/gi, '')
    .replace(/\[TOPIC_COMPLETE\]/gi, '')
    .replace(/\[ASSESSMENT_PASSED\]/gi, '')
    .replace(/\[ASSESSMENT_FAILED\]/gi, '')
    .replace(/\[QUIZ_START\]/gi, '')
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines left by markers
    .trim();
}

/**
 * End a learning session.
 * Returns whether curriculum expansion is needed.
 */
export async function endSession(chatId: string, reason: string): Promise<{ needsExpand: boolean; durationSeconds: number }> {
  const session = activeSessions.get(chatId);
  if (!session) return { needsExpand: false, durationSeconds: 0 };

  const now = Date.now();
  const durationSeconds = Math.round((now - session.startedAt) / 1000);

  // Update DB session record
  await updateSession(session.sessionId, {
    ended_at: now,
    duration_seconds: durationSeconds,
    questions_asked: session.questionsAsked,
    correct_answers: session.correctAnswers,
  });

  // Track daily time
  if (durationSeconds > 0) {
    await addDailyTime(chatId, durationSeconds);
  }

  // Remove from active sessions
  activeSessions.delete(chatId);

  // Check rolling horizon
  const shouldExpand = await needsExpansion(session.planId);

  logger.info(
    {
      chatId, sessionId: session.sessionId,
      duration: durationSeconds, questions: session.questionsAsked,
      correct: session.correctAnswers, reason, needsExpand: shouldExpand,
    },
    'Learning session ended',
  );

  return { needsExpand: shouldExpand, durationSeconds };
}

/**
 * Dismiss a session without recording stats (snooze).
 */
export async function dismissSession(chatId: string): Promise<void> {
  const session = activeSessions.get(chatId);
  if (!session) return;

  // Still record the session in DB but with minimal data
  await updateSession(session.sessionId, {
    ended_at: Date.now(),
    duration_seconds: 0,
    notes: 'dismissed',
  });

  activeSessions.delete(chatId);
  logger.info({ chatId, sessionId: session.sessionId }, 'Learning session dismissed');
}

// ── System Prompt Building ──────────────────────────────────

/**
 * Build the session-aware system prompt for the AI provider.
 */
export async function getSessionSystemPrompt(chatId: string): Promise<string | null> {
  const session = activeSessions.get(chatId);
  if (!session) return null;

  const plan = await getPlan(session.planId);
  if (!plan) return null;

  const topics = await getTopicsByPlan(session.planId);
  const topic = topics.find((t) => t.id === session.topicId);
  const summary = getMasterySummary(topics);

  // Base persona prompt
  const personaPrompt = buildPersonaPrompt(session.persona, session.subject);

  // Session context
  const parts = [personaPrompt];

  parts.push(`## Active Learning Session
Subject: ${session.subject}
Current Topic: ${session.topicTitle}${topic?.description ? `\nTopic Details: ${topic.description}` : ''}
Session Type: ${session.type}
Progress: ${summary.completedCount}/${summary.totalCount} topics completed, ${Math.round(summary.avgMastery * 100)}% avg mastery
Questions So Far: ${session.questionsAsked} asked, ${session.correctAnswers} correct`);

  if (session.type === 'assessment' && session.assessmentTarget) {
    parts.push(`## Assessment Mode
You are assessing whether the student can skip "${session.assessmentTarget}".
Ask 3-5 questions testing core understanding. After each answer, mark [CORRECT] or [INCORRECT].
After all questions, give [ASSESSMENT_PASSED] (if 80%+ correct) or [ASSESSMENT_FAILED].`);
  } else {
    parts.push(`## Session Instructions
You are the curriculum authority (Master). The student is the Padawan.
- Stay focused on the current topic. Teach, then verify understanding.
- Include [CORRECT] or [INCORRECT] after evaluating student answers.
- When the student demonstrates solid understanding, include [TOPIC_COMPLETE].
- Keep responses concise (3-5 sentences for teaching, 1-2 for questions).
- If the student says "done", "stop", or "enough" — end the session gracefully.
- Encourage completion and discipline. Do not make it easy to abandon learning.`);
  }

  return parts.join('\n\n');
}

// ── Opening Prompt ──────────────────────────────────────────

function buildOpeningPrompt(
  session: ActiveSession,
  plan: LearningPlan,
  topic: LearningTopic | null,
  allTopics: LearningTopic[],
): string {
  const summary = getMasterySummary(allTopics);
  const dueReviews = countDueReviews(allTopics);

  if (session.type === 'assessment') {
    return `Assess whether I can skip the topic "${session.assessmentTarget}" in my ${plan.subject} plan. Ask me 3-5 questions to test my understanding.`;
  }

  const parts: string[] = [];

  if (session.type === 'review' && dueReviews > 0) {
    parts.push(`Time for a review session! You have ${dueReviews} topic(s) due for review.`);
  }

  if (topic) {
    parts.push(`Let's work on: **${topic.title}**`);
    if (topic.description) parts.push(topic.description);

    if (topic.status === 'completed') {
      parts.push(`(Review — current mastery: ${Math.round(topic.mastery * 100)}%)`);
    }
  } else {
    parts.push(`Continue learning ${plan.subject}.`);
  }

  parts.push(`Progress: ${summary.completedCount}/${summary.totalCount} topics, ${Math.round(summary.avgMastery * 100)}% avg mastery.`);

  return parts.join('\n');
}

// ── Timeout Cleanup ─────────────────────────────────────────

async function cleanupStaleSessions(): Promise<void> {
  const now = Date.now();
  for (const [chatId, session] of activeSessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      logger.info({ chatId, sessionId: session.sessionId }, 'Session timed out (15 min inactivity)');
      await endSession(chatId, 'timeout');
    }
  }
}

export function initSessionCleanup(): () => void {
  cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
  return () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  };
}

/**
 * Format session end summary.
 */
export function formatSessionSummary(durationSeconds: number, questionsAsked: number, correctAnswers: number): string {
  const mins = Math.round(durationSeconds / 60);
  const accuracy = questionsAsked > 0 ? Math.round((correctAnswers / questionsAsked) * 100) : 0;

  const lines = ['**Session Complete**'];
  lines.push(`Duration: ${mins} min`);
  if (questionsAsked > 0) {
    lines.push(`Questions: ${correctAnswers}/${questionsAsked} correct (${accuracy}%)`);
  }
  return lines.join('\n');
}
