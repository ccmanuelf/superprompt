/**
 * Eval pipeline persistence (rc.98 Phase 1).
 *
 * Three normalized tables: forge_evals (session), forge_eval_runs
 * (per-run output + latency), forge_eval_assertions (per-assertion
 * grade). All chat_id scoped at the session level — runs and
 * assertions inherit scoping through their FK chain. Cross-dialect
 * via Knex (SQLite/MariaDB/PostgreSQL).
 *
 * No DELETE CASCADE today — same approach as attendance schema.
 * Lifecycle rules for cleanup will be settled in Phase 2 once we
 * see real eval volumes; until then deletes go through explicit
 * helpers and we keep audit trails intact.
 */
import { getKnex } from '../../db-knex.js';
import { logger } from '../../logger.js';
import type { TableInitializer } from '../../core/interfaces.js';
import type {
  EvalSession,
  EvalRun,
  EvalAssertion,
  EvalSessionRequest,
  EvalConfiguration,
  EvalStatus,
} from './schemas.js';

async function initEvalTables(): Promise<void> {
  const db = getKnex();

  if (!(await db.schema.hasTable('forge_evals'))) {
    await db.schema.createTable('forge_evals', (t) => {
      t.bigIncrements('id').primary();
      t.string('chat_id').notNullable();
      t.string('skill_name').notNullable();
      t.string('status').notNullable().defaultTo('queued');
      t.text('prompts_json').notNullable();
      t.text('expectations_json').notNullable();
      t.integer('runs_per_config').notNullable().defaultTo(2);
      t.text('configurations_json').notNullable();
      t.integer('total_calls_planned').notNullable();
      t.decimal('pass_rate', 5, 4);          // null until completion
      t.bigInteger('created_at').notNullable();
      t.bigInteger('started_at');
      t.bigInteger('completed_at');
      t.text('error_message');
      t.index(['chat_id', 'created_at']);
      t.index(['status']);
      t.index(['skill_name']);
    });
  }

  if (!(await db.schema.hasTable('forge_eval_runs'))) {
    await db.schema.createTable('forge_eval_runs', (t) => {
      t.bigIncrements('id').primary();
      t.bigInteger('session_id').notNullable().references('id').inTable('forge_evals');
      t.integer('prompt_idx').notNullable();
      t.string('configuration').notNullable();   // 'with_skill' | 'without_skill'
      t.integer('run_number').notNullable();     // 1..runs_per_config
      t.string('status').notNullable().defaultTo('queued');
      t.text('output_text');
      t.integer('duration_ms');
      t.integer('output_chars');
      t.integer('exit_code');
      t.integer('errors_encountered').notNullable().defaultTo(0);
      t.bigInteger('started_at');
      t.bigInteger('completed_at');
      t.text('error_message');
      t.index(['session_id']);
      t.index(['session_id', 'configuration']);
    });
  }

  if (!(await db.schema.hasTable('forge_eval_assertions'))) {
    await db.schema.createTable('forge_eval_assertions', (t) => {
      t.bigIncrements('id').primary();
      t.bigInteger('run_id').notNullable().references('id').inTable('forge_eval_runs');
      t.text('expectation_text').notNullable();
      t.boolean('passed').notNullable();
      t.text('evidence');
      t.bigInteger('created_at').notNullable();
      t.index(['run_id']);
      t.index(['run_id', 'passed']);
    });
  }
}

export const evalTableInit: TableInitializer = {
  name: 'forge-eval',
  initTables: initEvalTables,
};

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * Insert a new eval session in 'queued' status. Caller is responsible
 * for computing total_calls_planned and ensuring it fits the cap before
 * invoking this — the runner's validate() handles that.
 */
export async function createEvalSession(
  req: EvalSessionRequest,
  configurations: EvalConfiguration[],
  runs_per_config: number,
  total_calls_planned: number,
): Promise<number> {
  const db = getKnex();
  const now = Date.now();
  const [row] = await db('forge_evals')
    .insert({
      chat_id: req.chat_id,
      skill_name: req.skill_name,
      status: 'queued' as EvalStatus,
      prompts_json: JSON.stringify(req.prompts),
      expectations_json: JSON.stringify(req.expectations),
      runs_per_config,
      configurations_json: JSON.stringify(configurations),
      total_calls_planned,
      created_at: now,
    })
    .returning('id');
  // Knex returning() shape varies by dialect — coerce.
  return typeof row === 'object' ? Number((row as { id: number | string }).id) : Number(row);
}

export async function getEvalSession(id: number): Promise<EvalSession | null> {
  const db = getKnex();
  const row = (await db('forge_evals').where({ id }).first()) as EvalSession | undefined;
  return row ?? null;
}

export async function listEvalSessions(
  chat_id: string,
  limit = 50,
): Promise<EvalSession[]> {
  const db = getKnex();
  return (await db('forge_evals')
    .where({ chat_id })
    .orderBy('created_at', 'desc')
    .limit(limit)) as EvalSession[];
}

export async function updateEvalSessionStatus(
  id: number,
  status: EvalStatus,
  patch: Partial<Pick<EvalSession, 'started_at' | 'completed_at' | 'pass_rate' | 'error_message'>> = {},
): Promise<void> {
  const db = getKnex();
  await db('forge_evals').where({ id }).update({ status, ...patch });
}

export async function createEvalRun(
  session_id: number,
  prompt_idx: number,
  configuration: EvalConfiguration,
  run_number: number,
): Promise<number> {
  const db = getKnex();
  const [row] = await db('forge_eval_runs')
    .insert({
      session_id,
      prompt_idx,
      configuration,
      run_number,
      status: 'queued' as EvalStatus,
      errors_encountered: 0,
    })
    .returning('id');
  return typeof row === 'object' ? Number((row as { id: number | string }).id) : Number(row);
}

export async function updateEvalRun(
  id: number,
  patch: Partial<EvalRun>,
): Promise<void> {
  const db = getKnex();
  await db('forge_eval_runs').where({ id }).update(patch);
}

export async function listEvalRuns(session_id: number): Promise<EvalRun[]> {
  const db = getKnex();
  return (await db('forge_eval_runs')
    .where({ session_id })
    .orderBy(['prompt_idx', 'configuration', 'run_number'])) as EvalRun[];
}

export async function insertAssertions(
  run_id: number,
  rows: Array<{ expectation_text: string; passed: boolean; evidence: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = getKnex();
  const now = Date.now();
  await db('forge_eval_assertions').insert(
    rows.map((r) => ({
      run_id,
      expectation_text: r.expectation_text,
      passed: r.passed,
      evidence: r.evidence,
      created_at: now,
    })),
  );
}

export async function listAssertionsForRun(run_id: number): Promise<EvalAssertion[]> {
  const db = getKnex();
  return (await db('forge_eval_assertions').where({ run_id })) as EvalAssertion[];
}

/**
 * Compute aggregate pass-rate across all assertions for a session,
 * grouped by configuration. Used by the viewer and to set the session's
 * top-level pass_rate column on completion.
 */
export async function computeSessionPassRate(session_id: number): Promise<{
  with_skill: number | null;
  without_skill: number | null;
  overall: number | null;
}> {
  const db = getKnex();

  // Count passed/total assertions joined to runs of each configuration.
  const rows = (await db('forge_eval_assertions as a')
    .join('forge_eval_runs as r', 'r.id', 'a.run_id')
    .where('r.session_id', session_id)
    .select('r.configuration')
    .count<{ configuration: string; n: number | string }[]>('* as n')
    .sum<{ configuration: string; passed_n: number | string }[]>({ passed_n: 'a.passed' })
    .groupBy('r.configuration')) as Array<{
      configuration: string;
      n: number | string;
      passed_n: number | string;
    }>;

  const acc = { with_skill: null as number | null, without_skill: null as number | null };
  let totalPassed = 0;
  let totalCount = 0;
  for (const r of rows) {
    const n = Number(r.n);
    const passed = Number(r.passed_n);
    if (n === 0) continue;
    const rate = passed / n;
    if (r.configuration === 'with_skill') acc.with_skill = rate;
    if (r.configuration === 'without_skill') acc.without_skill = rate;
    totalPassed += passed;
    totalCount += n;
  }
  return {
    ...acc,
    overall: totalCount > 0 ? totalPassed / totalCount : null,
  };
}

logger.debug('forge/eval/db.ts loaded');
