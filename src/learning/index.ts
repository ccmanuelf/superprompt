/**
 * Learning Coach — barrel export.
 */

// Database
export {
  initLearningTables,
  type LearningPlan, type LearningTopic, type LearningSession, type DailyTime,
  type PlanStatus, type TopicStatus, type SessionType,
  createPlan, getPlan, getPlansByChat, getAllPlans, getActivePlansByChat, getPlanBySubject, updatePlan, deletePlan,
  createTopic, getTopic, getTopicsByPlan, getPendingTopics, getCompletedTopics, getTopicByTitle, updateTopic, reorderTopic, deleteTopic,
  createSession as createDbSession, getSession as getDbSession, updateSession as updateDbSession, getSessionsByPlan, getSessionsByChat,
  addDailyTime, getDailyTime, getWeeklyTime,
  getLeastRecentPlan, getMostOverduePlan, getStalePlans,
  getAllWeeklyTime, getAllRecentSessions, getRecentSessionsByChat, calculateStreak,
} from './db.js';

// Spaced Repetition
export {
  computeMasteryDecay, computeMasteryDelta, computeReviewInterval,
  isTopicDueForReview, getEffectiveMastery, selectNextTopic, countDueReviews, getMasterySummary,
} from './spaced-repetition.js';

// Personas
export {
  type Persona,
  getPersona, listPersonas, getDefaultPersonaId,
  selectPersonaForSubject, buildPersonaPrompt,
  GLOBAL_GUIDELINES,
} from './personas.js';

// Plan
export {
  type TopicDefinition, type PlanGenerationResult, type NegotiationResult,
  parsePlanResponse, buildPlanPrompt, createPlanFromTopics,
  needsExpansion, buildExpandPrompt, addExpansionTopics,
  buildAddTopicPrompt, parseTopicPlacement,
  moveTopicBefore, requestTopicRemoval, completeTopicRemoval, rejectTopicRemoval,
  formatPlan, formatPlanList, buildAssessmentPrompt, extractSubject,
} from './plan.js';

// Session
export {
  type ActiveSession, type SessionProcessResult,
  startSession, isSessionActive, getActiveSession, touchSession,
  processSessionResponse, stripMarkers,
  endSession, dismissSession,
  getSessionSystemPrompt, initSessionCleanup, formatSessionSummary,
  getActiveSessions,
  FALLBACK_CORRECT_PATTERNS, FALLBACK_INCORRECT_PATTERNS,
} from './session.js';
