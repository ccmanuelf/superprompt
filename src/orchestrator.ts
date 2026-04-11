import type { ProviderRouter } from './providers/router.js';
import type { AIResponse } from './providers/types.js';
import { insertEpisode } from './db-core.js';
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
  /** Optional skill/persona to activate for this step (pack-scoped delegation) */
  suggestedSkill?: string;
}

/** Result of running a single step. Exported for testing. */
export interface StepResult {
  step: number;
  instruction: string;
  output: string;
  success: boolean;
  toolsUsed?: string[];
}

/** Threshold above which previous step output is compressed via Filtration Analysis */
const STEP_CONTEXT_COMPRESS_THRESHOLD = 2000;

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
 * If the previous output exceeds the threshold, it is compressed using
 * Filtration Analysis (AI-powered) rather than blindly truncated.
 *
 * Exported for testing.
 */
export async function buildStepMessage(
  step: TaskStep,
  previousOutput: string,
  router?: ProviderRouter,
  chatId?: string,
): Promise<string> {
  if (!step.dependsOnPrevious || !previousOutput) {
    return step.instruction;
  }

  let context = previousOutput;

  // If output exceeds threshold, compress via Filtration Analysis
  if (previousOutput.length > STEP_CONTEXT_COMPRESS_THRESHOLD && router && chatId) {
    try {
      context = await compressStepContext(previousOutput, step.instruction, router, chatId);
      logger.debug(
        { originalLength: previousOutput.length, compressedLength: context.length },
        'Compressed step context via Filtration Analysis',
      );
    } catch (err) {
      // Fallback: take first + last 1000 chars (preserves beginning and conclusion)
      logger.warn({ err }, 'Filtration Analysis compression failed, using fallback');
      const head = previousOutput.slice(0, 1000);
      const tail = previousOutput.slice(-1000);
      context = `${head}\n...\n${tail}`;
    }
  }

  return `Context from previous step:\n${context}\n\nNow: ${step.instruction}`;
}

/**
 * Compress a step's output using Filtration Analysis.
 * Preserves the essential information (results, conclusions, data)
 * while removing verbose explanations and filler.
 *
 * Exported for testing.
 */
export async function compressStepContext(
  output: string,
  nextStepInstruction: string,
  router: ProviderRouter,
  chatId: string,
): Promise<string> {
  const compressionPrompt = `Compress the following text into a concise summary that preserves ONLY what the next task needs.

TEXT TO COMPRESS:
${output}

NEXT TASK: "${nextStepInstruction}"

Apply Filtration Analysis:
FILTER 1 — RELEVANCE: Keep only data, results, facts, and conclusions directly needed by the next task.
FILTER 2 — SPECIFICS: Preserve specific names, numbers, URLs, dates, and identifiers — never generalize these.
FILTER 3 — DISCARD: Remove greetings, explanations of methodology, caveats, and filler text.

Return ONLY the compressed text. No preamble. No explanation. Maximum 800 words.`;

  const response = await router.sendMessage({
    chatId,
    message: compressionPrompt,
    skipTools: true,
    systemPrompt: 'You are a text compression system. Return only the compressed output.',
  });

  return response.text || output.slice(0, 2000); // Fallback if AI returns nothing
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
[{"step":1,"instruction":"Clear, specific instruction for step 1","dependsOnPrevious":false,"suggestedSkill":"manufacturing-expert"},{"step":2,"instruction":"Clear, specific instruction for step 2","dependsOnPrevious":true}]

Rules:
- Each step should be independently executable (given previous step results)
- Set dependsOnPrevious to true if the step needs output from the prior step
- Keep instructions concise and actionable
- 2-5 steps only — don't over-decompose simple tasks
- If the task is actually simple enough for one step, return a single-step array
- suggestedSkill is OPTIONAL — only include if the step benefits from a specific persona:
  "manufacturing-expert" for production/quality/lean/engineering analysis
  "analyst" for data analysis and pattern recognition
  "researcher" for academic research and citations
  "careful" for safety-critical operations
  Omit suggestedSkill for general steps`;

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

  // 3. Execute steps — parallel where possible, sequential where dependent
  //
  // Strategy: group steps into batches. Within each batch, all steps are
  // independent (dependsOnPrevious=false) and run with Promise.all().
  // A step with dependsOnPrevious=true starts a new sequential batch.
  //
  // Example: steps [1(ind), 2(ind), 3(dep), 4(ind), 5(dep)]
  // → batch 1: [1, 2] in parallel
  // → batch 2: [3] sequential (depends on batch 1 output)
  // → batch 3: [4] independent
  // → batch 4: [5] sequential (depends on batch 3 output)

  const results: StepResult[] = [];
  let lastStepOutput = '';

  // Helper: execute a single step with optional skill delegation
  async function executeStep(step: TaskStep, contextOutput: string): Promise<StepResult> {
    const stepMessage = await buildStepMessage(step, contextOutput, router, chatId);

    // Pack-scoped delegation: set active skill for this step
    let originalSkillRestored = false;
    if (step.suggestedSkill) {
      try {
        const { getSkillByName, setActiveSkill, getActiveSkill, clearActiveSkill } = await import('./db-core.js');
        const skill = await getSkillByName(step.suggestedSkill);
        if (skill) {
          // Save current skill to restore after step
          const currentSkill = await getActiveSkill(chatId);
          await setActiveSkill(chatId, skill.id);
          logger.debug({ step: step.step, skill: step.suggestedSkill }, 'Pack-scoped delegation: skill activated for step');

          try {
            const response = await router.sendMessage({
              chatId,
              message: stepMessage,
              skipAutoTrigger: true,
            });
            // Restore original skill
            if (currentSkill) {
              await setActiveSkill(chatId, currentSkill.id);
            } else {
              await clearActiveSkill(chatId);
            }
            originalSkillRestored = true;

            return {
              step: step.step,
              instruction: step.instruction,
              output: response.text || '(no output)',
              success: true,
              toolsUsed: response.toolsUsed,
            };
          } catch (err) {
            // Restore skill even on error
            if (!originalSkillRestored) {
              if (currentSkill) await setActiveSkill(chatId, currentSkill.id);
              else await clearActiveSkill(chatId);
            }
            throw err;
          }
        }
      } catch (err) {
        logger.debug({ err, skill: step.suggestedSkill }, 'Skill delegation skipped — skill not found or error');
      }
    }

    // Standard execution (no skill delegation)
    const response = await router.sendMessage({
      chatId,
      message: stepMessage,
      skipAutoTrigger: true,
    });

    return {
      step: step.step,
      instruction: step.instruction,
      output: response.text || '(no output)',
      success: true,
      toolsUsed: response.toolsUsed,
    };
  }

  // Group steps into execution batches
  const batches: TaskStep[][] = [];
  let currentBatch: TaskStep[] = [];

  for (const step of steps) {
    if (step.dependsOnPrevious && currentBatch.length > 0) {
      // Dependent step starts a new batch (must wait for previous)
      batches.push(currentBatch);
      currentBatch = [step];
    } else {
      currentBatch.push(step);
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (const batch of batches) {
    const isParallel = batch.length > 1;

    if (isParallel) {
      // Notify parallel execution
      if (progressFn) {
        const stepNums = batch.map(s => s.step).join(', ');
        await progressFn(
          chatId,
          `⚡ Steps ${stepNums} running in parallel (${batch.length} concurrent)`,
        );
      }

      // Execute batch in parallel (with pack-scoped delegation)
      const batchPromises = batch.map(async (step) => {
        try {
          return await executeStep(step, lastStepOutput);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, chatId, step: step.step }, 'Orchestration step failed');
          return {
            step: step.step,
            instruction: step.instruction,
            output: `Error: ${errorMsg}`,
            success: false,
          } as StepResult;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Use the last successful output as context for the next batch
      const lastSuccess = batchResults.filter(r => r.success).pop();
      lastStepOutput = lastSuccess?.output || '';

      logger.debug(
        { chatId, batchSteps: batch.map(s => s.step), parallel: true },
        'Parallel batch completed',
      );
    } else {
      // Execute single step sequentially (with pack-scoped delegation)
      const step = batch[0];

      if (progressFn) {
        const skillNote = step.suggestedSkill ? ` [${step.suggestedSkill}]` : '';
        await progressFn(
          chatId,
          `⏳ Step ${step.step}/${steps.length}: ${step.instruction}${skillNote}`,
        );
      }

      try {
        const result = await executeStep(step, lastStepOutput);
        lastStepOutput = result.output;
        results.push(result);

        logger.debug(
          { chatId, step: step.step, outputLength: result.output.length, skill: step.suggestedSkill },
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

        if (progressFn) {
          await progressFn(
            chatId,
            `❌ Step ${step.step} failed: ${errorMsg}\nContinuing with remaining steps...`,
          );
        }

        logger.warn({ err, chatId, step: step.step }, 'Orchestration step failed');
        lastStepOutput = '';
      }
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

  // Aggregate all tools used across steps
  const allToolsUsed = [...new Set(results.flatMap((r) => r.toolsUsed ?? []))];

  return {
    text: finalOutput,
    provider: 'ollama',
    toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
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

  await insertEpisode(
    chatId,
    summary,
    keyFacts.length > 0 ? keyFacts : null,
    openThreads.length > 0 ? openThreads : null,
    results.length,
    embedding,
  );
}
