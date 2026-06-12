/**
 * Eval session runner — Phase 1 (rc.98).
 *
 * Validates an EvalSessionRequest against MAX_EVAL_CALLS_PER_RUN, persists
 * the session in 'queued' status, then drives the fan-out of `claude -p`
 * subprocess calls (baselines + graders) with a small concurrency limit.
 *
 * Reuses ClaudeProvider.sendMessage for the actual subprocess work — no
 * duplicate spawn logic. with_skill runs pass the skill's systemPrompt
 * via the standard provider params; without_skill runs omit it.
 *
 * Async by design: the public `startEvalSession` returns the session ID
 * immediately and the orchestration runs in the background. The viewer
 * polls forge_evals.status to see progress.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ClaudeProvider } from '../../providers/claude.js';
import { getSkillByName } from '../../db-core.js';
import { logger } from '../../logger.js';
import {
  createEvalSession,
  createEvalRun,
  updateEvalRun,
  updateEvalSessionStatus,
  insertAssertions,
  computeSessionPassRate,
} from './db.js';
import {
  type EvalSessionRequest,
  type EvalConfiguration,
  type GraderResult,
  DEFAULT_MAX_EVAL_CALLS_PER_RUN,
  DEFAULT_RUNS_PER_CONFIG,
  DEFAULT_RUNNER_CONCURRENCY,
  EVAL_RUN_TIMEOUT_MS,
} from './schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRADER_PROMPT = readFileSync(
  resolve(__dirname, 'prompts/grader-luna.md'),
  'utf-8',
);

/** Read MAX_EVAL_CALLS_PER_RUN from env at validate-time, with sane default. */
function getMaxEvalCalls(): number {
  const v = Number(process.env.MAX_EVAL_CALLS_PER_RUN);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_EVAL_CALLS_PER_RUN;
}

/**
 * Compute the total number of claude -p calls a session will issue:
 * one baseline + one grader call per (prompt × configuration × run_number).
 */
export function computeTotalCalls(
  promptCount: number,
  runsPerConfig: number,
  configurations: EvalConfiguration[],
): number {
  return 2 * promptCount * runsPerConfig * configurations.length;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  total_calls_planned?: number;
  cap?: number;
}

/** Validate request shape + cap before persisting anything. */
export function validateEvalRequest(
  req: EvalSessionRequest,
  configurations: EvalConfiguration[] = ['with_skill', 'without_skill'],
  runs_per_config: number = DEFAULT_RUNS_PER_CONFIG,
): ValidationResult {
  if (!req.skill_name) return { ok: false, reason: 'skill_name is required' };
  if (!req.chat_id) return { ok: false, reason: 'chat_id is required' };
  if (!Array.isArray(req.prompts) || req.prompts.length === 0) {
    return { ok: false, reason: 'at least one prompt is required' };
  }
  if (!Array.isArray(req.expectations) || req.expectations.length === 0) {
    return { ok: false, reason: 'at least one expectation is required' };
  }
  if (runs_per_config < 1) {
    return { ok: false, reason: 'runs_per_config must be >= 1' };
  }
  if (configurations.length === 0) {
    return { ok: false, reason: 'at least one configuration is required' };
  }
  for (const cfg of configurations) {
    if (cfg !== 'with_skill' && cfg !== 'without_skill') {
      return { ok: false, reason: `invalid configuration: ${cfg}` };
    }
  }

  const cap = getMaxEvalCalls();
  const total_calls_planned = computeTotalCalls(req.prompts.length, runs_per_config, configurations);
  if (total_calls_planned > cap) {
    return {
      ok: false,
      reason:
        `requested ${total_calls_planned} claude calls (${req.prompts.length} prompts × ${runs_per_config} runs × ${configurations.length} configurations × 2 [baseline+grader]) `
        + `exceeds cap of ${cap}. Reduce prompts, runs, or configurations, or set MAX_EVAL_CALLS_PER_RUN.`,
      total_calls_planned,
      cap,
    };
  }
  return { ok: true, total_calls_planned, cap };
}

// ── Skill resolution ─────────────────────────────────────────────────

/**
 * Look up a skill's systemPrompt by name. Used for with_skill runs.
 * Returns null if the skill doesn't exist or has an empty prompt
 * (e.g., 'general').
 */
async function getSkillSystemPromptByName(name: string): Promise<string | null> {
  const skill = await getSkillByName(name);
  if (!skill) return null;
  const prompt = skill.system_prompt?.trim();
  return prompt && prompt.length > 0 ? prompt : null;
}

// ── Concurrency ──────────────────────────────────────────────────────

/**
 * Tiny semaphore — limits concurrent claude -p subprocesses so the host
 * doesn't get overwhelmed. No external dep needed.
 */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((res) => this.queue.push(res));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── Session orchestration ────────────────────────────────────────────

/**
 * Public entry point. Validates the request, persists the session,
 * kicks off the background run, returns the session ID immediately.
 *
 * The session ID is what the viewer / Telegram reply uses to poll status.
 */
export async function startEvalSession(req: EvalSessionRequest): Promise<{
  ok: true;
  session_id: number;
  total_calls_planned: number;
} | {
  ok: false;
  reason: string;
}> {
  const configurations: EvalConfiguration[] = req.configurations ?? ['with_skill', 'without_skill'];
  const runs_per_config = req.runs_per_config ?? DEFAULT_RUNS_PER_CONFIG;

  const validation = validateEvalRequest(req, configurations, runs_per_config);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason ?? 'invalid request' };
  }

  // Skill must exist before we can do with_skill runs. Resolve early so the
  // request fails fast rather than after spawning baselines.
  if (configurations.includes('with_skill')) {
    const skillPrompt = await getSkillSystemPromptByName(req.skill_name);
    if (!skillPrompt) {
      return {
        ok: false,
        reason:
          `skill "${req.skill_name}" not found or has empty system prompt. `
          + `Run /skill list to see available skills.`,
      };
    }
  }

  const session_id = await createEvalSession(
    req,
    configurations,
    runs_per_config,
    validation.total_calls_planned!,
  );

  // Fire-and-forget background runner. Errors are caught + persisted so
  // they show up in the viewer rather than crashing the process.
  void runSessionInBackground(session_id, req, configurations, runs_per_config).catch((err) => {
    logger.error({ err, session_id }, 'eval session crashed');
    void updateEvalSessionStatus(session_id, 'failed', {
      completed_at: Date.now(),
      error_message: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true, session_id, total_calls_planned: validation.total_calls_planned! };
}

async function runSessionInBackground(
  session_id: number,
  req: EvalSessionRequest,
  configurations: EvalConfiguration[],
  runs_per_config: number,
): Promise<void> {
  const startedAt = Date.now();
  await updateEvalSessionStatus(session_id, 'running', { started_at: startedAt });
  logger.info(
    { session_id, skill: req.skill_name, prompts: req.prompts.length, configurations, runs_per_config },
    'eval session started',
  );

  const skillPrompt = await getSkillSystemPromptByName(req.skill_name);
  // skillPrompt is required for with_skill runs but optional otherwise. We
  // already validated upfront if with_skill was requested.

  const claude = new ClaudeProvider();
  const sem = new Semaphore(DEFAULT_RUNNER_CONCURRENCY);

  // Plan all run rows. Each row will execute the baseline + grader.
  type Plan = { run_id: number; prompt_idx: number; configuration: EvalConfiguration; run_number: number };
  const plan: Plan[] = [];
  for (let p = 0; p < req.prompts.length; p++) {
    for (const cfg of configurations) {
      for (let r = 1; r <= runs_per_config; r++) {
        const run_id = await createEvalRun(session_id, p, cfg, r);
        plan.push({ run_id, prompt_idx: p, configuration: cfg, run_number: r });
      }
    }
  }

  // Execute all runs (baseline + grader per run) under the semaphore.
  await Promise.all(plan.map(async (item) => {
    await sem.acquire();
    try {
      await executeOneRun(claude, item, req, skillPrompt);
    } finally {
      sem.release();
    }
  }));

  // Compute aggregate pass rate; mark session complete.
  const rates = await computeSessionPassRate(session_id);
  await updateEvalSessionStatus(session_id, 'completed', {
    completed_at: Date.now(),
    pass_rate: rates.overall,
  });
  logger.info(
    { session_id, duration_ms: Date.now() - startedAt, pass_rate: rates.overall },
    'eval session completed',
  );
}

async function executeOneRun(
  claude: ClaudeProvider,
  plan: { run_id: number; prompt_idx: number; configuration: EvalConfiguration; run_number: number },
  req: EvalSessionRequest,
  skillPrompt: string | null,
): Promise<void> {
  const userPrompt = req.prompts[plan.prompt_idx];
  const startedAt = Date.now();
  await updateEvalRun(plan.run_id, { status: 'running', started_at: startedAt });

  // ── Step 1: baseline run — execute the user prompt with or without the skill ──
  let baselineOutput = '';
  let exit_code = 0;
  let errorMessage: string | null = null;
  try {
    const r = await Promise.race([
      claude.sendMessage({
        message: userPrompt,
        chatId: `__eval_${plan.run_id}__`,            // synthetic chat_id, isolated from user history
        systemPrompt: plan.configuration === 'with_skill' ? skillPrompt ?? undefined : undefined,
        skipTools: true,                              // grading targets prose output, not tool side effects
        skipTurnLog: true,                            // not part of any user conversation
        skipAutoTrigger: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`run timed out after ${EVAL_RUN_TIMEOUT_MS}ms`)), EVAL_RUN_TIMEOUT_MS),
      ),
    ]);
    baselineOutput = (r.text ?? '').trim();
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    exit_code = 1;
  }

  const baseline_completed = Date.now();
  const duration_ms = baseline_completed - startedAt;

  // Persist the baseline run row (status pending grading).
  await updateEvalRun(plan.run_id, {
    output_text: baselineOutput || null,
    duration_ms,
    output_chars: baselineOutput.length,
    exit_code,
    errors_encountered: exit_code === 0 ? 0 : 1,
    error_message: errorMessage,
  });

  // If the baseline failed, no point grading. Mark the run failed and bail.
  if (exit_code !== 0 || !baselineOutput) {
    await updateEvalRun(plan.run_id, { status: 'failed', completed_at: Date.now() });
    logger.warn({ run_id: plan.run_id, errorMessage }, 'eval run baseline failed; skipping grading');
    return;
  }

  // ── Step 2: grader call — score the baseline output against expectations ──
  const expectations = req.expectations;
  const graderUserMessage = buildGraderUserMessage({
    skill_name: req.skill_name,
    configuration: plan.configuration,
    prompt: userPrompt,
    output: baselineOutput,
    expectations,
  });

  let graderResult: GraderResult | null = null;
  let graderError: string | null = null;
  try {
    const r = await Promise.race([
      claude.sendMessage({
        message: graderUserMessage,
        chatId: `__eval_grader_${plan.run_id}__`,
        systemPrompt: GRADER_PROMPT,
        skipTools: true,
        skipTurnLog: true,
        skipAutoTrigger: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`grader timed out after ${EVAL_RUN_TIMEOUT_MS}ms`)), EVAL_RUN_TIMEOUT_MS),
      ),
    ]);
    graderResult = parseGraderResponse(r.text ?? '');
  } catch (err) {
    graderError = err instanceof Error ? err.message : String(err);
  }

  if (!graderResult) {
    await updateEvalRun(plan.run_id, {
      status: 'failed',
      completed_at: Date.now(),
      error_message: graderError ?? 'grader returned unparseable output',
    });
    logger.warn({ run_id: plan.run_id, graderError }, 'eval grader failed');
    return;
  }

  // ── Step 3: persist assertions ──
  await insertAssertions(
    plan.run_id,
    graderResult.expectations.map((e) => ({
      expectation_text: e.text,
      passed: e.passed,
      evidence: e.evidence,
    })),
  );

  await updateEvalRun(plan.run_id, { status: 'completed', completed_at: Date.now() });
  logger.debug(
    { run_id: plan.run_id, passed: graderResult.summary.passed, total: graderResult.summary.total },
    'eval run graded',
  );
}

// ── Grader I/O helpers ───────────────────────────────────────────────

/**
 * Build the user-side message the grader sees. The grader's system
 * prompt (grader-luna.md) tells it to reply with JSON; this provides
 * the inputs inline.
 */
export function buildGraderUserMessage(args: {
  skill_name: string;
  configuration: EvalConfiguration;
  prompt: string;
  output: string;
  expectations: string[];
}): string {
  return [
    'EVAL CONTEXT:',
    `- Skill: ${args.skill_name}`,
    `- Configuration: ${args.configuration}`,
    '',
    '── Eval prompt ──',
    args.prompt,
    '',
    '── Output to grade ──',
    args.output,
    '',
    '── Expectations ──',
    ...args.expectations.map((e, i) => `${i + 1}. ${e}`),
    '',
    'Reply with JSON only, matching the schema in your system prompt.',
  ].join('\n');
}

/**
 * Parse the grader's response. Models occasionally wrap the JSON in
 * triple-backtick fences despite the "JSON only" instruction; tolerate
 * that. Returns null on parse failure so the caller can mark the run failed.
 */
export function parseGraderResponse(text: string): GraderResult | null {
  if (!text) return null;
  let body = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fencing if present.
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) body = fence[1].trim();

  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null
      && 'expectations' in parsed
      && Array.isArray((parsed as { expectations: unknown }).expectations)
      && 'summary' in parsed
      && typeof (parsed as { summary: unknown }).summary === 'object'
    ) {
      return parsed as GraderResult;
    }
    return null;
  } catch {
    return null;
  }
}

// Re-export for tests
export { getMaxEvalCalls, getSkillSystemPromptByName };
