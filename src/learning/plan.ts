/**
 * Learning plan generation and negotiation.
 * Handles AI-driven curriculum creation, rolling horizon expansion,
 * and plan modification (add/move/remove topics).
 */

import { logger } from '../logger.js';
import {
  createPlan, createTopic, getTopicsByPlan, getPendingTopics, getCompletedTopics,
  getTopicByTitle, reorderTopic, updateTopic,
  type LearningPlan, type LearningTopic,
} from './db.js';
import { selectPersonaForSubject } from './personas.js';
import { getMasterySummary } from './spaced-repetition.js';

// ── Types ───────────────────────────────────────────────────

export interface TopicDefinition {
  title: string;
  description: string;
  difficulty: number;
  estimated_minutes: number;
}

export interface PlanGenerationResult {
  plan: LearningPlan;
  topics: LearningTopic[];
}

export type NegotiationAction = 'add' | 'move' | 'remove';

export interface NegotiationResult {
  success: boolean;
  message: string;
  requiresAssessment?: boolean;
  topicTitle?: string;
}

// ── Plan Generation Prompt ──────────────────────────────────

const PLAN_GENERATION_PROMPT = `You are a curriculum designer. The student wants to learn a subject. Generate a structured learning plan as a JSON array of topics.

RULES:
- Generate 8-15 topics ordered from foundational to advanced
- Each topic should be a focused learning unit (10-20 minutes)
- Include prerequisites as earlier topics
- Cover core concepts before advanced applications
- Be specific: "Basic Mandarin Tones (4 tones + neutral)" not just "Tones"

OUTPUT FORMAT — respond with ONLY a JSON code block, no other text:
\`\`\`json
[
  {"title": "Topic Name", "description": "What the student will learn", "difficulty": 1, "estimated_minutes": 10},
  ...
]
\`\`\`

difficulty: 1 (intro) to 5 (advanced)
estimated_minutes: 5-20 per topic

SUBJECT: {subject}
GOAL: {goal}`;

const EXPAND_CURRICULUM_PROMPT = `You are a curriculum designer expanding an ongoing learning plan. The student has been studying and needs more topics.

COMPLETED TOPICS (do NOT repeat these):
{completed}

CURRENT PENDING TOPICS:
{pending}

RULES:
- Generate 3-5 NEW topics that logically follow the completed material
- Build on what was learned, increasing depth or breadth
- Do NOT repeat or rephrase completed topics
- Keep the progression natural — each topic should feel like the next step

OUTPUT FORMAT — respond with ONLY a JSON code block:
\`\`\`json
[
  {"title": "Topic Name", "description": "What the student will learn", "difficulty": 3, "estimated_minutes": 15},
  ...
]
\`\`\`

SUBJECT: {subject}
GOAL: {goal}`;

const TOPIC_PLACEMENT_PROMPT = `You are a curriculum designer. A student wants to add a new topic to their learning plan.

CURRENT PLAN (in order):
{current_plan}

NEW TOPIC: {new_topic}

Decide where this topic should be placed in the curriculum. Consider prerequisites and logical flow.

OUTPUT FORMAT — respond with ONLY a JSON code block:
\`\`\`json
{"title": "{new_topic}", "description": "What the student will learn", "difficulty": 3, "estimated_minutes": 15, "position": 5}
\`\`\`

position: 0-based index where the topic should be inserted (0 = first, etc.)`;

// ── Subject Extraction ──────────────────────────────────────

/**
 * Extract a clean subject name from a user's goal statement.
 * "I want to learn Mandarin Chinese for traveling" → "Mandarin Chinese"
 * "Learn Python programming" → "Python programming"
 * "Chinese" → "Chinese"
 *
 * Exported for testing.
 */
export function extractSubject(goal: string): string {
  const cleaned = goal.trim();

  // Try to extract subject after common prefixes
  const prefixPatterns = [
    /^(?:i\s+want\s+to\s+)?learn(?:\s+about)?\s+(.+?)(?:\s+(?:for|to|so|because|in order)\b.*)?$/i,
    /^(?:teach\s+me|help\s+me\s+learn|study)\s+(.+?)(?:\s+(?:for|to|so|because)\b.*)?$/i,
    /^(?:i\s+(?:want|need)\s+to\s+(?:understand|master|get\s+into))\s+(.+?)(?:\s+(?:for|to|so|because)\b.*)?$/i,
  ];

  for (const pattern of prefixPatterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  // No prefix matched — use the full goal, but cap at 50 chars for display
  return cleaned.length > 50 ? cleaned.slice(0, 50).replace(/\s+\S*$/, '') : cleaned;
}

// ── Plan Generation ─────────────────────────────────────────

/**
 * Parse a JSON array of topics from an AI response.
 * Handles markdown code blocks with ```json``` fences.
 */
export function parsePlanResponse(aiResponse: string): TopicDefinition[] {
  // Extract JSON from code block
  const codeBlockMatch = aiResponse.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : aiResponse.trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      logger.warn('Plan response is not an array');
      return [];
    }

    return parsed
      .filter((item: Record<string, unknown>) => item && typeof item.title === 'string' && item.title.trim())
      .map((item: Record<string, unknown>) => ({
        title: String(item.title).trim(),
        description: String(item.description || '').trim(),
        difficulty: Math.max(1, Math.min(5, Number(item.difficulty) || 3)),
        estimated_minutes: Math.max(5, Math.min(30, Number(item.estimated_minutes) || 10)),
      }));
  } catch (err) {
    logger.warn({ err, response: aiResponse.slice(0, 200) }, 'Failed to parse plan JSON');
    return [];
  }
}

/**
 * Build the prompt for initial plan generation.
 */
export function buildPlanPrompt(subject: string, goal: string): string {
  return PLAN_GENERATION_PROMPT
    .replace('{subject}', subject)
    .replace('{goal}', goal);
}

/**
 * Create a plan from parsed topic definitions.
 * This is the DB-only step (AI call happens in the command handler).
 */
export async function createPlanFromTopics(
  chatId: string,
  subject: string,
  goal: string,
  topics: TopicDefinition[],
): Promise<PlanGenerationResult> {
  const persona = selectPersonaForSubject(subject);
  const plan = await createPlan(chatId, subject, goal, persona);

  const createdTopics: LearningTopic[] = [];
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const topic = await createTopic(plan.id, t.title, {
      description: t.description,
      sortOrder: i,
      difficulty: t.difficulty,
      estimatedMinutes: t.estimated_minutes,
    });
    createdTopics.push(topic);
  }

  logger.info(
    { planId: plan.id, subject, topicCount: topics.length, persona },
    'Created learning plan',
  );

  return { plan, topics: createdTopics };
}

// ── Rolling Horizon ─────────────────────────────────────────

const PENDING_THRESHOLD = 2; // Expand when ≤2 pending topics remain

/**
 * Check if a plan needs curriculum expansion.
 */
export async function needsExpansion(planId: string): Promise<boolean> {
  const pending = await getPendingTopics(planId);
  return pending.length <= PENDING_THRESHOLD;
}

/**
 * Build the prompt for curriculum expansion.
 */
export async function buildExpandPrompt(plan: LearningPlan): Promise<string> {
  const completed = await getCompletedTopics(plan.id);
  const pending = await getPendingTopics(plan.id);

  const completedList = completed.map((t) => `- ${t.title}`).join('\n') || '(none yet)';
  const pendingList = pending.map((t) => `- ${t.title}`).join('\n') || '(none)';

  return EXPAND_CURRICULUM_PROMPT
    .replace('{completed}', completedList)
    .replace('{pending}', pendingList)
    .replace('{subject}', plan.subject)
    .replace('{goal}', plan.goal);
}

/**
 * Add new topics from expansion to the plan.
 */
export async function addExpansionTopics(planId: string, topics: TopicDefinition[]): Promise<LearningTopic[]> {
  const created: LearningTopic[] = [];
  for (const t of topics) {
    const topic = await createTopic(planId, t.title, {
      description: t.description,
      difficulty: t.difficulty,
      estimatedMinutes: t.estimated_minutes,
    });
    created.push(topic);
  }

  logger.info(
    { planId, newTopics: topics.length },
    'Expanded curriculum with new topics',
  );

  return created;
}

// ── Plan Negotiation ────────────────────────────────────────

/**
 * Handle a topic add request.
 * Returns the prompt for the AI to generate topic details + placement.
 */
export async function buildAddTopicPrompt(plan: LearningPlan, topicTitle: string): Promise<string> {
  const topics = await getTopicsByPlan(plan.id);
  const planList = topics.map((t, i) => `${i}. ${t.title} [${t.status}]`).join('\n');

  return TOPIC_PLACEMENT_PROMPT
    .replace('{current_plan}', planList)
    .replace(/\{new_topic\}/g, topicTitle);
}

/**
 * Parse topic placement response from AI.
 */
export function parseTopicPlacement(aiResponse: string): (TopicDefinition & { position: number }) | null {
  const codeBlockMatch = aiResponse.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : aiResponse.trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || !parsed.title) return null;

    return {
      title: String(parsed.title).trim(),
      description: String(parsed.description || '').trim(),
      difficulty: Math.max(1, Math.min(5, Number(parsed.difficulty) || 3)),
      estimated_minutes: Math.max(5, Math.min(30, Number(parsed.estimated_minutes) || 10)),
      position: Math.max(0, Number(parsed.position) || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Move a topic before another topic.
 */
export async function moveTopicBefore(planId: string, topicTitle: string, beforeTitle: string): Promise<NegotiationResult> {
  const topic = await getTopicByTitle(planId, topicTitle);
  if (!topic) return { success: false, message: `Topic "${topicTitle}" not found in this plan.` };

  const beforeTopic = await getTopicByTitle(planId, beforeTitle);
  if (!beforeTopic) return { success: false, message: `Topic "${beforeTitle}" not found in this plan.` };

  const targetPosition = beforeTopic.sort_order;
  const success = await reorderTopic(topic.id, targetPosition);

  if (!success) return { success: false, message: 'Failed to reorder topics.' };

  return {
    success: true,
    message: `Moved **${topic.title}** before **${beforeTopic.title}**.`,
  };
}

/**
 * Handle a topic removal request.
 * Returns requiresAssessment=true — the caller must run an assessment quiz.
 */
export async function requestTopicRemoval(planId: string, topicTitle: string): Promise<NegotiationResult> {
  const topic = await getTopicByTitle(planId, topicTitle);
  if (!topic) return { success: false, message: `Topic "${topicTitle}" not found in this plan.` };

  if (topic.status === 'deferred') {
    return { success: false, message: `"${topicTitle}" is already deferred.` };
  }

  if (topic.status === 'completed' && topic.mastery >= 0.8) {
    // Already demonstrated competence — allow direct deferral
    await updateTopic(topic.id, { status: 'deferred' });
    return {
      success: true,
      message: `**${topic.title}** deferred — you've already demonstrated mastery (${Math.round(topic.mastery * 100)}%).`,
    };
  }

  // Requires assessment
  return {
    success: false,
    requiresAssessment: true,
    topicTitle: topic.title,
    message: `To skip **${topic.title}**, I need to verify you already know this material. Let me prepare a quick assessment (3-5 questions).`,
  };
}

/**
 * Complete topic removal after successful assessment.
 */
export async function completeTopicRemoval(planId: string, topicTitle: string): Promise<NegotiationResult> {
  const topic = await getTopicByTitle(planId, topicTitle);
  if (!topic) return { success: false, message: `Topic "${topicTitle}" not found.` };

  await updateTopic(topic.id, { status: 'deferred', mastery: 0.8 });
  return {
    success: true,
    message: `**${topic.title}** deferred — assessment passed. You've demonstrated sufficient knowledge.`,
  };
}

/**
 * Reject topic removal after failed assessment.
 */
export function rejectTopicRemoval(topicTitle: string): string {
  return `Assessment for **${topicTitle}** shows gaps in understanding. This topic stays in your plan — it will help strengthen your foundation. We'll cover it when we get there.`;
}

// ── Plan Formatting ─────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  pending: ' ',
  in_progress: '>>',
  completed: 'OK',
  deferred: '--',
};

const MASTERY_BAR_LENGTH = 10;

function masteryBar(mastery: number): string {
  const filled = Math.round(mastery * MASTERY_BAR_LENGTH);
  return '[' + '#'.repeat(filled) + '.'.repeat(MASTERY_BAR_LENGTH - filled) + ']';
}

/**
 * Format a learning plan for display.
 */
export function formatPlan(plan: LearningPlan, topics: LearningTopic[]): string {
  const summary = getMasterySummary(topics);
  const lines: string[] = [];

  lines.push(`**Learning Plan: ${plan.subject}**`);
  lines.push(`Goal: ${plan.goal}`);
  lines.push(`Status: ${plan.status} | Persona: ${plan.persona}`);
  lines.push(`Progress: ${summary.completedCount}/${summary.totalCount} topics | Avg mastery: ${Math.round(summary.avgMastery * 100)}%`);

  if (summary.dueReviews > 0) {
    lines.push(`Reviews due: ${summary.dueReviews} topic(s)`);
  }

  lines.push('');
  lines.push('**Curriculum:**');

  for (const t of topics) {
    const icon = STATUS_ICONS[t.status] || ' ';
    const mastery = t.status === 'completed' ? ` ${masteryBar(t.mastery)} ${Math.round(t.mastery * 100)}%` : '';
    const difficulty = '*'.repeat(t.difficulty);
    lines.push(`[${icon}] ${t.sort_order + 1}. ${t.title} (${difficulty})${mastery}`);
  }

  lines.push('');
  lines.push('Legend: [OK]=completed [>>]=in progress [ ]=pending [--]=deferred | *=difficulty');

  return lines.join('\n');
}

/**
 * Format a compact plan list (for /learn plans).
 */
export async function formatPlanList(plans: LearningPlan[]): Promise<string> {
  if (plans.length === 0) return 'No learning plans yet. Start one with `/learn start <goal>`.';

  const lines = ['**Your Learning Plans:**', ''];
  for (const p of plans) {
    const topics = await getTopicsByPlan(p.id);
    const summary = getMasterySummary(topics);
    const statusIcon = p.status === 'active' ? 'ACTIVE' : p.status === 'paused' ? 'PAUSED' : 'DONE';
    lines.push(`[${statusIcon}] **${p.subject}** — ${summary.completedCount}/${summary.totalCount} topics, ${Math.round(summary.avgMastery * 100)}% mastery (id: ${p.id})`);
  }

  return lines.join('\n');
}

/**
 * Build assessment prompt for topic removal.
 */
export function buildAssessmentPrompt(subject: string, topicTitle: string, topicDescription: string | null): string {
  return `You are assessing whether a student can skip the topic "${topicTitle}" in their ${subject} learning plan.

${topicDescription ? `Topic description: ${topicDescription}` : ''}

ASSESSMENT RULES:
- Ask exactly 5 questions that test core understanding of this topic
- Mix question types: 2 factual/recall, 2 application/understanding, 1 analysis/synthesis
- Ask ONE question at a time, then WAIT for the student's answer before proceeding
- After the student answers, evaluate with [CORRECT] or [INCORRECT] and briefly explain why
- Then ask the next question
- After all 5 questions, provide a summary with the score
- If 4+ correct (80%+): include [ASSESSMENT_PASSED]
- If fewer than 4 correct: include [ASSESSMENT_FAILED]

Start now with your first question. Only ask ONE question in this message.

[QUIZ_START]`;
}
