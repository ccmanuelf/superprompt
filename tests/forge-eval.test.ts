/**
 * Forge eval pipeline — Phase 1 (rc.98).
 *
 * Tests cover the units that have deterministic behavior:
 *   - Schema / table init (idempotent, dialect-agnostic)
 *   - Cap math (computeTotalCalls + validateEvalRequest enforcement)
 *   - Grader response parsing (with/without code-fence wrapping, malformed)
 *   - Grader user-message construction (verbatim shape consumers depend on)
 *   - DB CRUD (createEvalSession + assertion aggregation)
 *
 * The runner's subprocess fan-out itself isn't unit-tested here — that's
 * an integration concern (real `claude -p` calls). Live verification
 * happens in the rc.98 deployment step against a small synthetic
 * prompt set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-forge-eval-'));
  const dbPath = join(storeDir, 'test.db');
  const dbKnex = await import('../src/db-knex.js');
  db = dbKnex.initKnex({ driver: 'sqlite', sqliteFilename: dbPath });

  // Forge eval tables
  const { evalTableInit } = await import('../src/forge/eval/index.js');
  await evalTableInit.initTables();

  // Skills table — needed by getSkillSystemPromptByName and createEvalSession
  // doesn't hit it but the runner's pre-validation does. Mirror the shape
  // from src/db-core.ts so tests don't depend on initBuiltinSkills().
  await db.schema.createTable('skills', (t) => {
    t.string('id').primary();
    t.string('name').notNullable().unique();
    t.string('description').notNullable();
    t.text('system_prompt').notNullable();
    t.text('allowed_tools');
    t.boolean('is_builtin').notNullable().defaultTo(false);
    t.boolean('locked').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
});

afterAll(async () => {
  const dbKnex = await import('../src/db-knex.js');
  await dbKnex.destroyKnex();
  rmSync(storeDir, { recursive: true, force: true });
});

describe('forge_eval schema (rc.98 Phase 1)', () => {
  it('creates the three forge_eval tables', async () => {
    expect(await db.schema.hasTable('forge_evals')).toBe(true);
    expect(await db.schema.hasTable('forge_eval_runs')).toBe(true);
    expect(await db.schema.hasTable('forge_eval_assertions')).toBe(true);
  });

  it('initTables is idempotent', async () => {
    const { evalTableInit } = await import('../src/forge/eval/index.js');
    await expect(evalTableInit.initTables()).resolves.not.toThrow();
  });
});

describe('cap math — computeTotalCalls (rc.98)', () => {
  it('returns 2 × prompts × runs × configurations (baselines + grader)', async () => {
    const { computeTotalCalls } = await import('../src/forge/eval/runner.js');
    expect(computeTotalCalls(5, 2, ['with_skill', 'without_skill'])).toBe(40);
    expect(computeTotalCalls(10, 1, ['with_skill', 'without_skill'])).toBe(40);
    expect(computeTotalCalls(3, 2, ['with_skill', 'without_skill'])).toBe(24);
    expect(computeTotalCalls(1, 1, ['with_skill'])).toBe(2);
  });
});

describe('validateEvalRequest (rc.98)', () => {
  it('accepts a default-shape request that fits the cap', async () => {
    const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
    const r = validateEvalRequest({
      chat_id: 'c1',
      skill_name: 'antislop',
      prompts: ['p1', 'p2', 'p3', 'p4', 'p5'],
      expectations: ['e1'],
    });
    expect(r.ok).toBe(true);
    expect(r.total_calls_planned).toBe(40);   // exactly at default cap
  });

  it('refuses requests that exceed the cap', async () => {
    const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
    const r = validateEvalRequest({
      chat_id: 'c1',
      skill_name: 'antislop',
      prompts: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],   // 6 prompts × 2 runs × 2 configs × 2 (baseline+grader) = 48
      expectations: ['e1'],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds cap/);
    expect(r.reason).toMatch(/48.*40/);
  });

  it('refuses missing/empty fields', async () => {
    const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
    expect(validateEvalRequest({ chat_id: 'c1', skill_name: '', prompts: ['p'], expectations: ['e'] }).ok).toBe(false);
    expect(validateEvalRequest({ chat_id: '', skill_name: 's', prompts: ['p'], expectations: ['e'] }).ok).toBe(false);
    expect(validateEvalRequest({ chat_id: 'c1', skill_name: 's', prompts: [], expectations: ['e'] }).ok).toBe(false);
    expect(validateEvalRequest({ chat_id: 'c1', skill_name: 's', prompts: ['p'], expectations: [] }).ok).toBe(false);
  });

  it('respects MAX_EVAL_CALLS_PER_RUN env override', async () => {
    const prev = process.env.MAX_EVAL_CALLS_PER_RUN;
    process.env.MAX_EVAL_CALLS_PER_RUN = '8';
    try {
      const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
      const r = validateEvalRequest({
        chat_id: 'c1',
        skill_name: 's',
        prompts: ['p1', 'p2', 'p3'],   // 3 × 2 × 2 × 2 = 24, exceeds 8
        expectations: ['e'],
      });
      expect(r.ok).toBe(false);
      expect(r.cap).toBe(8);
    } finally {
      if (prev === undefined) delete process.env.MAX_EVAL_CALLS_PER_RUN;
      else process.env.MAX_EVAL_CALLS_PER_RUN = prev;
    }
  });

  it('refuses runs_per_config < 1', async () => {
    const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
    const r = validateEvalRequest(
      { chat_id: 'c1', skill_name: 's', prompts: ['p'], expectations: ['e'] },
      ['with_skill', 'without_skill'],
      0,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/runs_per_config/);
  });

  it('refuses unknown configuration values', async () => {
    const { validateEvalRequest } = await import('../src/forge/eval/runner.js');
    const r = validateEvalRequest(
      { chat_id: 'c1', skill_name: 's', prompts: ['p'], expectations: ['e'] },
      // @ts-expect-error testing invalid input
      ['with_skill', 'wrong'],
    );
    expect(r.ok).toBe(false);
  });
});

describe('parseGraderResponse (rc.98)', () => {
  it('parses raw JSON', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const r = parseGraderResponse(JSON.stringify({
      expectations: [{ text: 'e1', passed: true, evidence: 'because' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1.0 },
    }));
    expect(r).not.toBeNull();
    expect(r!.expectations).toHaveLength(1);
    expect(r!.expectations[0].passed).toBe(true);
    expect(r!.summary.pass_rate).toBe(1.0);
  });

  it('strips ```json fence wrapping', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const wrapped = '```json\n' + JSON.stringify({
      expectations: [{ text: 'e1', passed: false, evidence: null }],
      summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
    }) + '\n```';
    const r = parseGraderResponse(wrapped);
    expect(r).not.toBeNull();
    expect(r!.expectations[0].passed).toBe(false);
  });

  it('strips ``` fence (no language tag)', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const wrapped = '```\n{"expectations":[{"text":"e1","passed":true,"evidence":"e"}],"summary":{"passed":1,"failed":0,"total":1,"pass_rate":1}}\n```';
    const r = parseGraderResponse(wrapped);
    expect(r).not.toBeNull();
  });

  it('returns null on empty input', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    expect(parseGraderResponse('')).toBeNull();
    expect(parseGraderResponse('   ')).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    expect(parseGraderResponse('not JSON')).toBeNull();
    expect(parseGraderResponse('{broken')).toBeNull();
  });

  it('returns null on JSON missing expectations field', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const noExpectations = parseGraderResponse('{"summary":{"passed":0,"failed":0,"total":0,"pass_rate":0}}');
    expect(noExpectations).toBeNull();
  });

  it('returns null on JSON missing summary field', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const noSummary = parseGraderResponse('{"expectations":[]}');
    expect(noSummary).toBeNull();
  });

  it('preserves eval_feedback when present', async () => {
    const { parseGraderResponse } = await import('../src/forge/eval/runner.js');
    const r = parseGraderResponse(JSON.stringify({
      expectations: [{ text: 'e1', passed: true, evidence: 'e' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1.0 },
      eval_feedback: { suggestions: [{ reason: 'too easy' }], overall: 'weak' },
    }));
    expect(r!.eval_feedback?.overall).toBe('weak');
    expect(r!.eval_feedback?.suggestions?.[0].reason).toBe('too easy');
  });
});

describe('buildGraderUserMessage (rc.98)', () => {
  it('embeds skill, configuration, prompt, output, and numbered expectations', async () => {
    const { buildGraderUserMessage } = await import('../src/forge/eval/runner.js');
    const msg = buildGraderUserMessage({
      skill_name: 'antislop',
      configuration: 'with_skill',
      prompt: 'Clean this up: foo',
      output: 'cleaned bar',
      expectations: ['no banned phrases', 'specific numbers used'],
    });
    expect(msg).toMatch(/Skill: antislop/);
    expect(msg).toMatch(/Configuration: with_skill/);
    expect(msg).toMatch(/── Eval prompt ──/);
    expect(msg).toMatch(/Clean this up: foo/);
    expect(msg).toMatch(/── Output to grade ──/);
    expect(msg).toMatch(/cleaned bar/);
    expect(msg).toMatch(/1\. no banned phrases/);
    expect(msg).toMatch(/2\. specific numbers used/);
    expect(msg).toMatch(/Reply with JSON only/);
  });
});

describe('forge eval DB CRUD (rc.98)', () => {
  // We seed a skill so createEvalSession + getEvalSession + assertion aggregation
  // can run without depending on the production initBuiltinSkills() flow.
  const TEST_SKILL = 'test-eval-skill';
  let sessionId: number;

  beforeAll(async () => {
    const now = Date.now();
    await db('skills').insert({
      id: 'test-eval-skill-id',
      name: TEST_SKILL,
      description: 'test',
      system_prompt: 'You are a test.',
      allowed_tools: null,
      is_builtin: false,
      locked: false,
      created_at: now,
      updated_at: now,
    });
  });

  it('createEvalSession persists the session and returns its id', async () => {
    const { createEvalSession } = await import('../src/forge/eval/db.js');
    sessionId = await createEvalSession(
      {
        chat_id: 'chat-1',
        skill_name: TEST_SKILL,
        prompts: ['p1', 'p2'],
        expectations: ['e1', 'e2'],
      },
      ['with_skill', 'without_skill'],
      2,
      16,
    );
    expect(sessionId).toBeGreaterThan(0);

    const { getEvalSession } = await import('../src/forge/eval/index.js');
    const s = await getEvalSession(sessionId);
    expect(s).not.toBeNull();
    expect(s!.skill_name).toBe(TEST_SKILL);
    expect(s!.status).toBe('queued');
    expect(s!.total_calls_planned).toBe(16);
    const prompts = JSON.parse(s!.prompts_json) as string[];
    expect(prompts).toEqual(['p1', 'p2']);
  });

  it('listEvalSessions returns sessions for that chat only', async () => {
    const { createEvalSession, listEvalSessions } = await import('../src/forge/eval/db.js');
    await createEvalSession(
      {
        chat_id: 'chat-2',
        skill_name: TEST_SKILL,
        prompts: ['p'],
        expectations: ['e'],
      },
      ['with_skill'],
      1,
      2,
    );
    const chat1Sessions = await listEvalSessions('chat-1');
    const chat2Sessions = await listEvalSessions('chat-2');
    expect(chat1Sessions.every((s) => s.chat_id === 'chat-1')).toBe(true);
    expect(chat2Sessions.every((s) => s.chat_id === 'chat-2')).toBe(true);
    expect(chat1Sessions.length).toBeGreaterThan(0);
    expect(chat2Sessions.length).toBeGreaterThan(0);
  });

  it('aggregates pass rate per configuration after assertions are inserted', async () => {
    const { createEvalRun, insertAssertions, computeSessionPassRate } = await import('../src/forge/eval/db.js');

    // Add some runs to the session and grade them.
    const r1 = await createEvalRun(sessionId, 0, 'with_skill', 1);
    const r2 = await createEvalRun(sessionId, 0, 'without_skill', 1);

    // with_skill: 2/2 passed
    await insertAssertions(r1, [
      { expectation_text: 'e1', passed: true, evidence: 'ok' },
      { expectation_text: 'e2', passed: true, evidence: 'ok' },
    ]);
    // without_skill: 0/2 passed
    await insertAssertions(r2, [
      { expectation_text: 'e1', passed: false, evidence: 'no' },
      { expectation_text: 'e2', passed: false, evidence: 'no' },
    ]);

    const rates = await computeSessionPassRate(sessionId);
    expect(rates.with_skill).toBe(1.0);
    expect(rates.without_skill).toBe(0.0);
    expect(rates.overall).toBe(0.5);
  });

  it('handles updateEvalSessionStatus transitions cleanly', async () => {
    const { updateEvalSessionStatus, getEvalSession } = await import('../src/forge/eval/db.js');
    await updateEvalSessionStatus(sessionId, 'running', { started_at: 1000 });
    let s = await getEvalSession(sessionId);
    expect(s!.status).toBe('running');
    expect(Number(s!.started_at)).toBe(1000);

    await updateEvalSessionStatus(sessionId, 'completed', { completed_at: 2000, pass_rate: 0.5 });
    s = await getEvalSession(sessionId);
    expect(s!.status).toBe('completed');
    expect(Number(s!.completed_at)).toBe(2000);
    expect(Number(s!.pass_rate)).toBe(0.5);
  });
});

describe('attribution headers — Apache 2.0 compliance (rc.98)', () => {
  it('schemas.ts cites skill-creator-v2 + Apache-2.0', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    const text = fs.readFileSync(path.resolve(here, '../src/forge/eval/schemas.ts'), 'utf-8');
    expect(text).toMatch(/skill-creator-v2/);
    expect(text).toMatch(/Apache-2\.0/);
    expect(text).toMatch(/marketing-os-workshop/);
  });

  it('grader-upstream.md is preserved verbatim with attribution header', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    const text = fs.readFileSync(path.resolve(here, '../src/forge/eval/prompts/grader-upstream.md'), 'utf-8');
    expect(text).toMatch(/PRESERVED VERBATIM from skill-creator-v2/);
    expect(text).toMatch(/Apache-2\.0|License: Apache 2\.0/);
    // The body of the upstream prompt has these section headings — confirms no truncation.
    expect(text).toMatch(/# Grader Agent/);
    expect(text).toMatch(/## Process/);
    expect(text).toMatch(/Step 3: Evaluate Each Assertion/);
  });

  it('grader-luna.md cites lineage + adaptation rationale', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    const text = fs.readFileSync(path.resolve(here, '../src/forge/eval/prompts/grader-luna.md'), 'utf-8');
    expect(text).toMatch(/skill-creator-v2/);
    expect(text).toMatch(/Apache-2\.0/);
    expect(text).toMatch(/Reply with \*\*JSON only\*\*|Reply with JSON only/);
    expect(text).toMatch(/expectations/);
    expect(text).toMatch(/summary/);
  });
});
