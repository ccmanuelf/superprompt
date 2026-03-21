import type { ProviderRouter } from './providers/router.js';
import type { AIResponse } from './providers/types.js';
import { insertEpisode } from './db.js';
import { generateEmbedding } from './embeddings.js';
import { logger } from './logger.js';

/**
 * Multi-step task orchestrator.
 *
 * Detects requests that require sequential steps, decomposes them using AI,
 * executes each step with progress notifications, and combines results.
 *
 * Design principles (from Slate + Superpowers):
 * - Each step gets focused context (not a bloated monolithic prompt)
 * - Progress is visible to the user (not a black box)
 * - Failure at any step is recoverable (previous results preserved)
 * - Intermediate results stored as episodes for future reference
 */

export type ProgressFn = (chatId: string, text: string) => Promise<void>;

/** A single step in a multi-step plan */
export interface TaskStep {
  /** Step number (1-based) */
  step: number;
  /** What this step should accomplish */
  instruction: string;
  /** Whether this step depends on the previous step's output */
  dependsOnPrevious: boolean;
}

/** Result of running a single step. Exported for testing. */
export interface StepResult {
  step: number;
  instruction: string;
  output: string;
  success: boolean;
}

/** Max characters from a previous step's output to pass as context */
const MAX_STEP_CONTEXT_CHARS = 3000;

/** Maximum number of steps allowed (even if AI returns more) */
const MAX_STEPS = 5;

/**
 * Patterns that indicate a multi-step request.
 * Must have at least 2 distinct action clauses connected by sequencing language.
 * Exported for testing.
 */
export const ORCHESTRATION_PATTERNS = [
  // Explicit step markers: "first X, then Y", "step 1: X, step 2: Y"
  /\b(first|to start|initially)\b.{10,}\b(then|next|after that|afterwards|subsequently|finally)\b/i,
  // Sequential "and then" / "and after"
  /\b(and then|and after that|and afterwards|and finally)\b/i,
  // Numbered steps in the request: "1. X 2. Y" or "1) X 2) Y" or "step 1: X step 2: Y"
  /(^|\s)(1[\.\):]|step\s*1\b).{5,}(2[\.\):]|step\s*2\b)/im,
  // Multiple imperatives connected by commas/and: "research X, compare Y, and create Z"
  /\b(research|find|search|look up|gather)\b.{5,}\b(compare|analyze|evaluate|assess)\b.{5,}\b(create|write|draft|generate|build|make|produce)\b/i,
];

/**
 * Detect if a message should be orchestrated as a multi-step task.
 * Returns true only for messages that genuinely need sequential decomposition.
 *
 * Exported for testing.
 */
export function shouldOrchestrate(message: string): boolean {
  // Must be long enough to contain multiple steps
  if (message.length < 60) return false;

  // Don't orchestrate commands
  if (message.startsWith('/') || message.startsWith('!')) return false;

  for (const pattern of ORCHESTRATION_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  return false;
}

/**
 * Build the step message with context from the previous step.
 * Truncates previous output to MAX_STEP_CONTEXT_CHARS to prevent context overflow.
 *
 * Exported for testing.
 */
export function buildStepMessage(
  step: TaskStep,
  previousOutput: string,
): string {
  if (!step.dependsOnPrevious || !previousOutput) {
    return step.instruction;
  }

  // Truncate previous output to prevent context window overflow
  const truncated = previousOutput.length > MAX_STEP_CONTEXT_CHARS
    ? previousOutput.slice(0, MAX_STEP_CONTEXT_CHARS) + '\n...(truncated)'
    : previousOutput;

  return `Context from previous step:\n${truncated}\n\nNow: ${step.instruction}`;
}

/**
 * Validate and cap step count from AI decomposition.
 * Ensures 1-MAX_STEPS steps, renumbers if needed.
 *
 * Exported for testing.
 */
export function validateSteps(steps: unknown): TaskStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Decomposition returned empty or invalid steps');
  }

  // Cap at MAX_STEPS
  const capped = steps.slice(0, MAX_STEPS);

  // Validate and renumber
  return capped.map((s, i) => ({
    step: i + 1,
    instruction: typeof s.instruction === 'string' ? s.instruction : String(s.instruction || `Step ${i + 1}`),
    dependsOnPrevious: i > 0 && Boolean(s.dependsOnPrevious),
  }));
}

/**
 * Build the final response from step results.
 * Shows the last successful step's output as the main response,
 * with failure notes if any steps failed.
 *
 * Exported for testing.
 */
export function buildFinalResponse(results: StepResult[]): string {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length === 0) {
    return 'All steps failed. Please try breaking down your request or rephrase it.';
  }

  // Use the last successful step's output as the main response
  const lastResult = successful[successful.length - 1];
  let response = lastResult.output;

  // If there were failures, note them
  if (failed.length > 0) {
    const failNotes = failed
      .map((f) => `• Step ${f.step} (${f.instruction}): ${f.output}`)
      .join('\n');
    response += `\n\n⚠️ **Some steps had issues:**\n${failNotes}`;
  }

  return response;
}

/**
 * Build the episode summary from orchestration results.
 *
 * Exported for testing.
 */
export function buildEpisodeSummary(
  originalRequest: string,
  results: StepResult[],
): { summary: string; keyFacts: string[]; openThreads: string[] } {
  const successful = results.filter((r) => r.success);
  const summary = `Multi-step task: "${originalRequest.slice(0, 100)}${originalRequest.length > 100 ? '...' : ''}". ` +
    `Completed ${successful.length}/${results.length} steps. ` +
    `Steps: ${results.map((r) => `${r.step}. ${r.instruction.slice(0, 50)}`).join('; ')}`;

  const keyFacts = successful.map((r) => `Step ${r.step} completed: ${r.instruction.slice(0, 80)}`);
  const openThreads = results
    .filter((r) => !r.success)
    .map((r) => `Step ${r.step} failed: ${r.instruction.slice(0, 80)} — needs retry`);

  return { summary, keyFacts, openThreads };
}

/**
 * Decompose a complex request into sequential steps using AI.
 * Uses the AI provider to analyze the request and break it into discrete steps.
 *
 * The decomposition call uses skipTools AND a special flag to bypass
 * auto-triggering (we don't want the decomposition prompt itself to
 * trigger debugger/careful skills).
 */
async function decomposeTask(
  router: ProviderRouter,
  chatId: string,
  message: string,
): Promise<TaskStep[]> {
  const decompositionPrompt = `You are a task decomposition system. Break the following user request into 2-5 sequential steps. Each step should be a single, focused instruction.

User request: "${message}"

Respond in this exact JSON format (no markdown, no code fences):
[{"step":1,"instruction":"Clear, specific instruction for step 1","dependsOnPrevious":false},{"step":2,"instruction":"Clear, specific instruction for step 2","dependsOnPrevious":true}]

Rules:
- Each step should be independently executable (given previous step results)
- Set dependsOnPrevious to true if the step needs output from the prior step
- Keep instructions concise and actionable
- 2-5 steps only — don't over-decompose simple tasks
- If the task is actually simple enough for one step, return a single-step array`;

  const response = await router.sendMessage({
    chatId,
    message: decompositionPrompt,
    skipTools: true,
    // System prompt override to prevent skill auto-triggering on the decomposition prompt
    systemPrompt: 'You are a task decomposition system. Return ONLY valid JSON.',
  });

  if (!response.text) {
    throw new Error('AI returned no response for task decomposition');
  }

  // Parse JSON response
  const jsonStr = response.text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const rawSteps = JSON.parse(jsonStr);
    return validateSteps(rawSteps);
  } catch {
    logger.warn({ response: response.text }, 'Task decomposition returned invalid JSON');
    // Fallback: treat the whole request as a single step
    return [{ step: 1, instruction: message, dependsOnPrevious: false }];
  }
}

/**
 * Execute a multi-step task with progress notifications.
 *
 * Flow:
 * 1. Decompose request into steps (via AI)
 * 2. Notify user of the plan
 * 3. Execute each step sequentially
 * 4. Pass previous step results as context to dependent steps (truncated)
 * 5. Notify user after each step completes
 * 6. Store the combined result as an episode
 * 7. Return the final combined response
 */
export async function orchestrateTask(
  router: ProviderRouter,
  chatId: string,
  message: string,
  progressFn?: ProgressFn,
): Promise<AIResponse> {
  logger.info({ chatId, messageLength: message.length }, 'Starting multi-step orchestration');

  // 1. Decompose
  let steps: TaskStep[];
  try {
    steps = await decomposeTask(router, chatId, message);
  } catch (err) {
    logger.warn({ err }, 'Task decomposition failed, falling back to single-step');
    // Fall back to normal processing
    return router.sendMessage({ chatId, message });
  }

  // If AI decided it's a single step, just run it normally
  if (steps.length <= 1) {
    return router.sendMessage({ chatId, message });
  }

  // 2. Notify user of the plan
  const planLines = steps.map((s) => `${s.step}. ${s.instruction}`).join('\n');
  if (progressFn) {
    await progressFn(
      chatId,
      `📋 **Breaking this into ${steps.length} steps:**\n${planLines}`,
    );
  }

  // 3. Execute each step
  const results: StepResult[] = [];
  let lastStepOutput = '';

  for (const step of steps) {
    const stepMessage = buildStepMessage(step, lastStepOutput);

    // Notify progress
    if (progressFn) {
      await progressFn(
        chatId,
        `⏳ Step ${step.step}/${steps.length}: ${step.instruction}`,
      );
    }

    try {
      const response = await router.sendMessage({
        chatId,
        message: stepMessage,
      });

      const output = response.text || '(no output)';
      lastStepOutput = output;

      results.push({
        step: step.step,
        instruction: step.instruction,
        output,
        success: true,
      });

      logger.debug(
        { chatId, step: step.step, outputLength: output.length },
        'Orchestration step completed',
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        step: step.step,
        instruction: step.instruction,
        output: `Error: ${errorMsg}`,
        success: false,
      });

      // Notify user of step failure
      if (progressFn) {
        await progressFn(
          chatId,
          `❌ Step ${step.step} failed: ${errorMsg}\nContinuing with remaining steps...`,
        );
      }

      logger.warn(
        { err, chatId, step: step.step },
        'Orchestration step failed',
      );

      // Don't pass failed output as context
      lastStepOutput = '';
    }
  }

  // 4. Build final combined response
  const successCount = results.filter((r) => r.success).length;
  const finalOutput = buildFinalResponse(results);

  // 5. Store as episode for future reference
  storeOrchestrationEpisode(chatId, message, results).catch((err) =>
    logger.warn({ err }, 'Failed to store orchestration episode'),
  );

  // 6. Notify completion
  if (progressFn) {
    await progressFn(
      chatId,
      `✅ Completed ${successCount}/${steps.length} steps.`,
    );
  }

  logger.info(
    { chatId, totalSteps: steps.length, successCount },
    'Multi-step orchestration completed',
  );

  return {
    text: finalOutput,
    provider: 'ollama',
  };
}

/**
 * Store the orchestration run as an episode for future reference.
 */
async function storeOrchestrationEpisode(
  chatId: string,
  originalRequest: string,
  results: StepResult[],
): Promise<void> {
  const { summary, keyFacts, openThreads } = buildEpisodeSummary(originalRequest, results);

  let embedding: number[] | undefined;
  try {
    const emb = await generateEmbedding(summary);
    if (emb) embedding = emb;
  } catch { /* non-critical */ }

  insertEpisode(
    chatId,
    summary,
    keyFacts.length > 0 ? keyFacts : null,
    openThreads.length > 0 ? openThreads : null,
    results.length,
    embedding,
  );
}
