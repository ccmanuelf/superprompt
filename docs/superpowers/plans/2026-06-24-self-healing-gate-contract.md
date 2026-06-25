# Self-Healing Gate Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize Luna's rc.116 skill self-healing gate as a prescriptive completion contract, close two audited gaps (wall-clock budget cap + cheap plan-gate), and ship a reusable loop-guard checklist — every contract clause backed by a conformance test.

**Architecture:** Add a two-stage gate to the existing single-stage heal flow in `src/auto-skills.ts`. A cheap **plan-gate** (`planGateCandidate`) runs deterministic checks (+ an optional cross-family council judge) before the existing expensive **delivery-gate** (`gateHealCandidate`), which now runs under a wall-clock **budget deadline**. Numeric tunables consolidate into one `HEAL_GATE` object that the contract doc documents and a conformance test pins. Plan-gate fails open (delivery gate is the real safety net); the budget cap fails closed (reject on uncertainty).

**Tech Stack:** TypeScript (ES2022, NodeNext, strict ESM), Knex (SQLite test DB via `createTestKnex`), Vitest, pino logger, `ClaudeProvider` as the cross-family judge.

## Global Constraints

- ESM only; `type: "module"`. Imports use `.js` extensions (NodeNext). — verbatim from Code Conventions #3.
- Path resolution via `fileURLToPath(import.meta.url)`, never `.pathname`. (No new path code here, but honor it.)
- Never set `process.env` from `.env`; env via the existing `config`/`readEnvFile()` layer only.
- Graceful degradation at service boundaries (Code Convention #6): a failing judge/provider logs and continues, never crashes the heal.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors and **no new `no-explicit-any`**; `npx vitest run` green; `npm run build && npm run smoke` clean.
- Vitest test glob is `tests/**/*.test.ts` (from `vitest.config.ts:6`).
- Conventional commits; bump the rc version in `package.json` on ship.
- Pre-commit secret-scan hook must pass; never `--no-verify`.

---

### Task 1: `HEAL_GATE` config block + `HEAL_GATE_PLAN_JUDGE` flag

Consolidate the scattered heal tunables into one documented object (single source of truth) and add the plan-judge feature flag. Existing exported constant names are preserved by re-pointing them at `HEAL_GATE`, so no caller churn.

**Files:**
- Modify: `src/auto-skills.ts` (Constants block ~lines 48–63; `MIN_QUALITY_SCORE:57`; `MAX_EVAL_CASES_PER_SPLIT` ~line 139; `MAX_CONSECUTIVE_HEAL_REJECTS:724`)
- Modify: `src/config.ts:45` (next to `HEAL_GATE_GRADER`)
- Test: `tests/heal-gate-contract.test.ts` (new)

**Interfaces:**
- Produces: `export const HEAL_GATE` with readonly numeric keys `MAX_CONSECUTIVE_REJECTS`, `MAX_EVAL_CASES_PER_SPLIT`, `MIN_QUALITY_SCORE`, `BUDGET_MS`. `config.HEAL_GATE_PLAN_JUDGE: boolean`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/heal-gate-contract.test.ts`:

```typescript
/**
 * Conformance pins for reference/heal-gate-contract.md. Each test maps to a
 * clause of the completion contract so the code cannot silently drift from the
 * documented values and invariants. Pure where possible; DB-backed where the
 * clause is about runtime behavior.
 */
import { describe, it, expect } from 'vitest';
import { HEAL_GATE, MAX_CONSECUTIVE_HEAL_REJECTS, MAX_EVAL_CASES_PER_SPLIT } from '../src/auto-skills.js';

describe('HEAL_GATE contract values', () => {
  it('pins the documented tunables', () => {
    expect(HEAL_GATE.MAX_CONSECUTIVE_REJECTS).toBe(3);
    expect(HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT).toBe(10);
    expect(HEAL_GATE.MIN_QUALITY_SCORE).toBe(70);
    expect(HEAL_GATE.BUDGET_MS).toBe(60_000);
  });

  it('keeps the legacy exported names pointed at the single source of truth', () => {
    expect(MAX_CONSECUTIVE_HEAL_REJECTS).toBe(HEAL_GATE.MAX_CONSECUTIVE_REJECTS);
    expect(MAX_EVAL_CASES_PER_SPLIT).toBe(HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/heal-gate-contract.test.ts`
Expected: FAIL — `HEAL_GATE` is not exported (import error / undefined).

- [ ] **Step 3: Add the `HEAL_GATE` block and re-point existing constants**

In `src/auto-skills.ts`, in the `// ── Constants ──` block (before `MIN_QUALITY_SCORE`), add:

```typescript
/**
 * Single source of truth for the self-healing gate's numeric tunables.
 * Documented in reference/heal-gate-contract.md and pinned by
 * tests/heal-gate-contract.test.ts — change a value here, change the contract.
 */
export const HEAL_GATE = {
  /** Consecutive gate rejections before auto-healing pauses for manual review. */
  MAX_CONSECUTIVE_REJECTS: 3,
  /** Replay cases retained per split (FIFO eviction). */
  MAX_EVAL_CASES_PER_SPLIT: 10,
  /** Min self-monitor score to capture a use as an eval case. */
  MIN_QUALITY_SCORE: 70,
  /** Wall-clock ceiling for one delivery-gate replay; breach → reject (fail-closed). */
  BUDGET_MS: 60_000,
} as const;
```

Then re-point the existing declarations:
- Line 57 `const MIN_QUALITY_SCORE = 70;` → `const MIN_QUALITY_SCORE = HEAL_GATE.MIN_QUALITY_SCORE;`
- `export const MAX_EVAL_CASES_PER_SPLIT = 10;` → `export const MAX_EVAL_CASES_PER_SPLIT = HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT;`
- Line 724 `export const MAX_CONSECUTIVE_HEAL_REJECTS = 3;` → `export const MAX_CONSECUTIVE_HEAL_REJECTS = HEAL_GATE.MAX_CONSECUTIVE_REJECTS;`

(Leave the existing doc-comments above each constant in place.)

- [ ] **Step 4: Add the plan-judge flag to config**

In `src/config.ts`, immediately after the `HEAL_GATE_GRADER` line (45):

```typescript
  // Plan-gate council judge: when on (default), a single cross-family Claude
  // call vets a heal candidate for plausibility BEFORE the expensive replay.
  // Fails open (defers to the delivery gate). Set HEAL_GATE_PLAN_JUDGE=false to
  // gate on the deterministic plan-gate checks alone (zero LLM cost).
  HEAL_GATE_PLAN_JUDGE: env.HEAL_GATE_PLAN_JUDGE !== 'false',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/heal-gate-contract.test.ts`
Expected: PASS (both `describe` blocks).

- [ ] **Step 6: Commit**

```bash
git add src/auto-skills.ts src/config.ts tests/heal-gate-contract.test.ts
git commit -m "feat(heal): consolidate gate tunables into HEAL_GATE + plan-judge flag"
```

---

### Task 2: `recordHealRevision` helper + wall-clock budget cap

Add a wall-clock deadline to the delivery gate. On breach it stops scoring and returns a reject (fail-closed), recording a `reject: aborted — budget exceeded` note so it counts toward the reject ceiling. Extract the `skill_revisions` insert into a small helper shared by the gate and (next task) the plan-gate.

**Files:**
- Modify: `src/auto-skills.ts` (`gateHealCandidate:684–721`)
- Test: `tests/heal-gate-budget.test.ts` (new)

**Interfaces:**
- Consumes: `HEAL_GATE.BUDGET_MS` (Task 1); existing `evaluateHealAcceptance`, `scoreCases`, `getSkillEvalCases`, `getKnex`.
- Produces: `async function recordHealRevision(skillId: string, systemPrompt: string, note: string): Promise<void>` (module-private). `gateHealCandidate` gains a 5th param `opts: { budgetMs?: number; now?: () => number } = {}`. Return type unchanged (`HealGateResult`).

- [ ] **Step 1: Write the failing test**

Create `tests/heal-gate-budget.test.ts` (reuses the DB scaffold pattern from `tests/skill-heal-apply.test.ts`):

```typescript
/**
 * Budget cap on the delivery gate. A wall-clock breach must ABORT scoring and
 * return a reject (fail-closed) that leaves the live skill untouched and counts
 * toward the reject ceiling. Deterministic via an injected clock + a scorer that
 * advances it, so no real time passes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  initAutoSkillsTables, recordSkillEvalCase, gateHealCandidate, type ReplayScorer,
} from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';

const OLD = 'OLD PROMPT';
const NEW = 'NEW PROMPT THAT IS LONG ENOUGH TO BE A REAL REWRITE';
function makeSkill(): Skill {
  return { id: 'auto-demo', name: 'demo', description: 'd', system_prompt: OLD,
    allowed_tools: null, is_builtin: 0, source_file: null, locked: 0,
    created_at: Date.now(), updated_at: Date.now() } as Skill;
}

async function createTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await testKnex.schema.createTable('skills', (t) => {
    t.text('id').primary(); t.text('name').notNullable().unique();
    t.text('description').notNullable(); t.text('system_prompt').notNullable();
    t.text('allowed_tools'); t.integer('is_builtin').notNullable().defaultTo(0);
    t.text('source_file'); t.integer('locked').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable(); t.bigInteger('updated_at').notNullable();
  });
  await testKnex.schema.createTable('skill_revisions', (t) => {
    t.increments('id').primary();
    t.text('skill_id').notNullable().references('id').inTable('skills').onDelete('CASCADE');
    t.text('system_prompt').notNullable(); t.text('revision_note'); t.bigInteger('created_at').notNullable();
  });
  await initAutoSkillsTables();
  await testKnex('skills').insert({ id: 'auto-demo', name: 'demo', description: 'd',
    system_prompt: OLD, is_builtin: 0, locked: 0, created_at: Date.now(), updated_at: Date.now() });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-in', contextSummary: '', qualityScore: 50, split: 'held_in' });
  await recordSkillEvalCase({ skillId: 'auto-demo', userMessage: 'u-out', contextSummary: '', qualityScore: 50, split: 'held_out' });
}

describe('gateHealCandidate budget cap', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('aborts as a reject when the wall-clock deadline is exceeded mid-replay', async () => {
    let t = 1000;
    let calls = 0;
    const clock = () => t;
    // Manual counter (repo style — see routerCalls in skill-heal-apply.test.ts).
    const slowScorer: ReplayScorer = async () => { calls++; t += 1000; return 90; };
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue', slowScorer, { budgetMs: 500, now: clock });
    expect(result.promote).toBe(false);
    expect(result.acceptance.reason).toMatch(/budget/i);
    // Stopped early: only the first batch (held_in, 1 case) scored before abort.
    expect(calls).toBe(1);
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD); // untouched
    const note = (await testKnex('skill_revisions').where({ skill_id: 'auto-demo' }).first()).revision_note;
    expect(note).toMatch(/^reject/i); // counts toward the ceiling
  });

  it('completes normally under a generous budget', async () => {
    const scorer: ReplayScorer = async (prompt) => (prompt === NEW ? 90 : 50);
    const result = await gateHealCandidate(makeSkill(), NEW, 'issue', scorer, { budgetMs: 60_000 });
    expect(result.promote).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/heal-gate-budget.test.ts`
Expected: FAIL — `gateHealCandidate` ignores `opts`; no abort, scorer called 4 times, or a type error on the 5th arg.

- [ ] **Step 3: Add the helper and budget guard**

In `src/auto-skills.ts`, add the helper just above `gateHealCandidate`:

```typescript
/** Insert one skill_revisions row (promote or reject). Shared by both gates. */
async function recordHealRevision(skillId: string, systemPrompt: string, note: string): Promise<void> {
  await getKnex()('skill_revisions').insert({
    skill_id: skillId, system_prompt: systemPrompt, revision_note: note, created_at: Date.now(),
  });
}
```

Replace the body of `gateHealCandidate` (684–721) with the budgeted version:

```typescript
export async function gateHealCandidate(
  skill: Skill,
  candidatePrompt: string,
  issue: string,
  scorer: ReplayScorer,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<HealGateResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? HEAL_GATE.BUDGET_MS);
  const overBudget = (): boolean => now() > deadline;

  const cases = await getSkillEvalCases(skill.id);
  if (cases.length === 0) {
    return {
      promote: false,
      acceptance: { promote: false, deltaIn: 0, deltaOut: 0, reason: 'reject: no eval cases — heal cannot be verified (ungated)' },
    };
  }
  const heldIn = cases.filter((c) => c.split === 'held_in');
  const heldOut = cases.filter((c) => c.split === 'held_out');

  // Delivery gate under a wall-clock deadline. Check before each batch; a breach
  // is fail-closed — abort as a reject rather than promote on partial evidence.
  const batch = async (prompt: string, b: SkillEvalCase[]): Promise<number[] | null> =>
    overBudget() ? null : scoreCases(prompt, b, scorer);
  const cIn = await batch(skill.system_prompt, heldIn);
  const cOut = cIn === null ? null : await batch(skill.system_prompt, heldOut);
  const nIn = cOut === null ? null : await batch(candidatePrompt, heldIn);
  const nOut = nIn === null ? null : await batch(candidatePrompt, heldOut);

  if (cIn === null || cOut === null || nIn === null || nOut === null) {
    const reason = `reject: aborted — budget exceeded (${opts.budgetMs ?? HEAL_GATE.BUDGET_MS}ms)`;
    await recordHealRevision(skill.id, skill.system_prompt, `${reason} | issue: ${issue.slice(0, 160)}`);
    return { promote: false, acceptance: { promote: false, deltaIn: 0, deltaOut: 0, reason } };
  }

  const acceptance = evaluateHealAcceptance({ heldIn: cIn, heldOut: cOut }, { heldIn: nIn, heldOut: nOut });
  if (acceptance.promote) {
    await getKnex()('skills').where({ id: skill.id }).update({ system_prompt: candidatePrompt, updated_at: Date.now() });
  }
  await recordHealRevision(skill.id, acceptance.promote ? candidatePrompt : skill.system_prompt,
    `${acceptance.reason} | issue: ${issue.slice(0, 160)}`);
  return { promote: acceptance.promote, acceptance };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/heal-gate-budget.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run the existing gate tests for no regression**

Run: `npx vitest run tests/skill-heal-apply.test.ts tests/skill-heal-gate.test.ts`
Expected: PASS — the 4-arg call sites still work (`opts` defaults to `{}`), promote/reject/no-coverage behavior unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/auto-skills.ts tests/heal-gate-budget.test.ts
git commit -m "feat(heal): wall-clock budget cap on the delivery gate (fail-closed)"
```

---

### Task 3: `planGateCandidate` + `makeDefaultPlanJudge`

The cheap pre-filter. Deterministic checks always run (blocking); the optional council judge is one cross-family `ClaudeProvider` call and fails open.

**Files:**
- Modify: `src/auto-skills.ts` (add near the gate functions, after `makeDefaultScorer`)
- Test: `tests/heal-plan-gate.test.ts` (new)

**Interfaces:**
- Consumes: existing `ClaudeProvider` import, `Skill` type.
- Produces:
  - `export interface PlanGateResult { pass: boolean; reason: string; }`
  - `export async function planGateCandidate(skill: Skill, candidate: string, issue: string, judge?: (issue: string, candidate: string) => Promise<boolean>): Promise<PlanGateResult>`
  - `export function makeDefaultPlanJudge(chatId: string): (issue: string, candidate: string) => Promise<boolean>`

- [ ] **Step 1: Confirm the `ClaudeProvider` import path**

Run: `grep -n "import.*ClaudeProvider" src/auto-skills.ts`
Note the exact module specifier (expected `../src/providers/claude.js` from a test's view → in source it's `'./providers/claude.js'`). Use it in the test mock in Step 2.

- [ ] **Step 2: Write the failing test**

Create `tests/heal-plan-gate.test.ts`:

```typescript
/**
 * Plan-gate: the cheap pre-filter that rejects obviously-bad candidates before
 * the expensive replay. Deterministic checks are blocking; the council judge is
 * one cross-family Claude call that fails OPEN.
 */
import { describe, it, expect, vi } from 'vitest';

// Pin the cross-family judge: makeDefaultPlanJudge must construct ClaudeProvider,
// not the local router. (Update the path to match Step 1 if different.)
const claudeCtor = vi.fn().mockImplementation(() => ({
  sendMessage: async () => ({ text: '{"plausible": true}', provider: 'claude' }),
}));
vi.mock('../src/providers/claude.js', () => ({ ClaudeProvider: claudeCtor }));
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { planGateCandidate, makeDefaultPlanJudge } from '../src/auto-skills.js';
import type { Skill } from '../src/db-core.js';

const skill = { id: 'auto-demo', name: 'demo', system_prompt: 'A working skill prompt that is sufficiently long.' } as Skill;
const GOOD = 'A clearly different and sufficiently long rewritten skill prompt that addresses the issue.';

describe('planGateCandidate deterministic checks', () => {
  it('rejects a no-op (identical to current)', async () => {
    const r = await planGateCandidate(skill, skill.system_prompt, 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no-op/i);
  });
  it('rejects a too-short candidate', async () => {
    const r = await planGateCandidate(skill, 'too short', 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/short/i);
  });
  it('rejects a degenerate apology candidate', async () => {
    const r = await planGateCandidate(skill, "Sorry, I can't help with rewriting this skill prompt right now.", 'issue');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/degenerate/i);
  });
  it('passes a plausible candidate when no judge is supplied', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue');
    expect(r.pass).toBe(true);
  });
});

describe('planGateCandidate council judge', () => {
  it('rejects when the judge says implausible', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue', async () => false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/judge/i);
  });
  it('fails OPEN when the judge throws (defers to the delivery gate)', async () => {
    const r = await planGateCandidate(skill, GOOD, 'issue', async () => { throw new Error('judge down'); });
    expect(r.pass).toBe(true);
  });
});

describe('makeDefaultPlanJudge cross-family', () => {
  it('uses ClaudeProvider, not the local router', async () => {
    const judge = makeDefaultPlanJudge('chat-1');
    const verdict = await judge('issue', GOOD);
    expect(claudeCtor).toHaveBeenCalled();
    expect(verdict).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/heal-plan-gate.test.ts`
Expected: FAIL — `planGateCandidate` / `makeDefaultPlanJudge` not exported.

- [ ] **Step 4: Implement plan-gate**

In `src/auto-skills.ts`, after `makeDefaultScorer` (~line 803), add:

```typescript
export interface PlanGateResult { pass: boolean; reason: string; }

/** Apology/refusal/truncation heuristic for a degenerate rewrite. */
function isDegenerateRewrite(text: string): boolean {
  const t = text.trim();
  if (/^(sorry|i'?m sorry|i (can'?t|cannot|am unable|won'?t)\b)/i.test(t)) return true;
  if (!t.includes('\n') && t.length < 80) return true; // single-line stub — likely truncated
  return false;
}

/**
 * Cheap plan-gate: reject obviously-bad candidates BEFORE the expensive replay.
 * Deterministic checks always run (blocking). The optional council judge (one
 * cross-family Claude call) is gated by HEAL_GATE_PLAN_JUDGE upstream and fails
 * OPEN — the delivery gate is the real safety net, so a flaky judge must never
 * block a heal.
 */
export async function planGateCandidate(
  skill: Skill,
  candidate: string,
  issue: string,
  judge?: (issue: string, candidate: string) => Promise<boolean>,
): Promise<PlanGateResult> {
  const c = candidate.trim();
  if (c === skill.system_prompt.trim()) return { pass: false, reason: 'no-op (identical to current)' };
  if (c.length < 50) return { pass: false, reason: 'too short (<50 chars)' };
  if (isDegenerateRewrite(c)) return { pass: false, reason: 'degenerate (apology/truncated)' };
  if (judge) {
    try {
      if (!(await judge(issue, c))) return { pass: false, reason: 'council judge: implausible fix' };
    } catch (err) {
      logger.debug({ err, skillId: skill.id }, 'Plan-gate judge failed — deferring to delivery gate');
      // fail-open
    }
  }
  return { pass: true, reason: 'plan-gate passed' };
}

const PLAN_JUDGE_SYSTEM =
  'You are reviewing a proposed rewrite of an assistant skill prompt meant to fix a reported issue. '
  + 'Answer ONLY with JSON {"plausible": true|false}: true if the rewrite plausibly addresses the issue '
  + "without obviously breaking the skill's purpose; false if it is off-topic, empty of substance, or harmful.";

/** Cross-family council judge for the plan-gate (Claude, not the local router). */
export function makeDefaultPlanJudge(chatId: string): (issue: string, candidate: string) => Promise<boolean> {
  const judge = new ClaudeProvider();
  return async (issue: string, candidate: string): Promise<boolean> => {
    const res = await judge.sendMessage({
      message: `ISSUE:\n${issue}\n\nPROPOSED REWRITE:\n${candidate}`,
      chatId, systemPrompt: PLAN_JUDGE_SYSTEM, skipTools: true,
    });
    const body = (res.text ?? '').trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    try { return (JSON.parse(body) as { plausible?: unknown }).plausible === true; }
    catch { return true; } // unparseable → fail-open
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/heal-plan-gate.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 6: Commit**

```bash
git add src/auto-skills.ts tests/heal-plan-gate.test.ts
git commit -m "feat(heal): cheap plan-gate with cross-family council judge (fail-open)"
```

---

### Task 4: Wire the plan-gate into `healSkill`

Insert the plan-gate between drafting and the delivery gate. A plan-gate reject is persisted (counts toward the ceiling) and short-circuits before the expensive replay.

**Files:**
- Modify: `src/auto-skills.ts` (`healSkill:812–890`)
- Test: `tests/heal-plan-gate-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `planGateCandidate`, `makeDefaultPlanJudge`, `recordHealRevision` (Tasks 2–3); `config.HEAL_GATE_PLAN_JUDGE` (Task 1).
- Produces: `healSkill` gains a 7th optional param `planJudge?: (issue: string, candidate: string) => Promise<boolean>` (test seam, mirrors `scorer?`). Behavior: a no-op/short/degenerate/implausible candidate → `{ patched: false, summary: '' }` and a `reject: plan-gate (...)` revision, **without** calling `gateHealCandidate`/the scorer.

- [ ] **Step 1: Write the failing test**

Create `tests/heal-plan-gate-wiring.test.ts` (DB scaffold as in Task 2; only the differing parts shown — copy `createTestDb`, `makeSkill`, the two `vi.mock` blocks, and imports from `tests/skill-heal-apply.test.ts`, adding `healSkill` and `type ReplayScorer` to the import):

```typescript
// ... same vi.mock(db-knex), vi.mock(logger), createTestDb(), makeSkill(), OLD ...
import { initAutoSkillsTables, recordSkillEvalCase, healSkill, type ReplayScorer } from '../src/auto-skills.js';
import type { ProviderRouter } from '../src/providers/router.js';

describe('healSkill plan-gate wiring', () => {
  beforeEach(async () => { await createTestDb(); });
  afterEach(async () => { if (testKnex) await testKnex.destroy(); });

  it('rejects a no-op candidate at the plan-gate without running the delivery scorer', async () => {
    let scorerCalls = 0;
    const scorer: ReplayScorer = async () => { scorerCalls++; return 99; }; // would PROMOTE if ever reached
    const noopRouter = { sendMessage: async () => ({ text: OLD, provider: 'ollama' }) } as unknown as ProviderRouter;
    // planJudge stub avoids constructing a real ClaudeProvider; no-op rejects before it anyway.
    const result = await healSkill(makeSkill(), 'issue', 'ctx', noopRouter, 'auto-demo', scorer, async () => true);

    expect(result.patched).toBe(false);
    expect(scorerCalls).toBe(0);                     // delivery gate never ran
    const live = await testKnex('skills').where({ id: 'auto-demo' }).first();
    expect(live.system_prompt).toBe(OLD);            // untouched
    const note = (await testKnex('skill_revisions').where({ skill_id: 'auto-demo' }).first()).revision_note;
    expect(note).toMatch(/plan-gate/i);              // recorded → counts toward the ceiling
  });

  it('proceeds to the delivery gate for a plausible, non-trivial candidate', async () => {
    const NEW = 'A clearly different and sufficiently long rewritten skill prompt that fixes the reported issue.';
    let scorerCalls = 0;
    const scorer: ReplayScorer = async (prompt) => { scorerCalls++; return prompt === NEW ? 90 : 50; };
    const router = { sendMessage: async () => ({ text: NEW, provider: 'ollama' }) } as unknown as ProviderRouter;
    const result = await healSkill(makeSkill(), 'issue', 'ctx', router, 'auto-demo', scorer, async () => true);

    expect(scorerCalls).toBeGreaterThan(0);          // delivery gate ran
    expect(result.patched).toBe(true);               // promoted
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/heal-plan-gate-wiring.test.ts`
Expected: FAIL — `healSkill` has no `planJudge` param and runs no plan-gate, so the no-op candidate reaches the scorer (or a type error on the 7th arg).

- [ ] **Step 3: Wire it in**

In `src/auto-skills.ts`, change the `healSkill` signature to add the 7th param:

```typescript
export async function healSkill(
  skill: Skill,
  issue: string,
  conversationContext: string,
  router: ProviderRouter,
  chatId: string,
  scorer?: ReplayScorer,
  planJudge?: (issue: string, candidate: string) => Promise<boolean>,
): Promise<{ patched: boolean; summary: string }> {
```

Inside the `try` block, replace the current draft-and-gate section (the `if (!response.text || response.text.length < 50) { ... }` check, the `const newPrompt = response.text.trim();` line, and the `gateHealCandidate` call) with:

```typescript
    const newPrompt = (response.text ?? '').trim();

    // Plan-gate (cheap): reject obvious non-fixes before the expensive replay.
    const effectiveJudge = config.HEAL_GATE_PLAN_JUDGE ? (planJudge ?? makeDefaultPlanJudge(chatId)) : planJudge;
    const plan = await planGateCandidate(skill, newPrompt, issue, effectiveJudge);
    if (!plan.pass) {
      const reason = `reject: plan-gate (${plan.reason})`;
      await recordHealRevision(skill.id, skill.system_prompt, `${reason} | issue: ${issue.slice(0, 160)}`);
      logger.info({ skillId: skill.id, skillName: skill.name, reason: plan.reason }, 'Heal candidate rejected by plan-gate');
      return { patched: false, summary: '' };
    }

    // Delivery gate (expensive): replay recorded cases under the non-regression rule.
    const gate = await gateHealCandidate(skill, newPrompt, issue, scorer ?? makeDefaultScorer(router, chatId));
```

(Leave the subsequent `logger.info(... gate.promote ...)`, the `if (!gate.promote)` reject, and the success-summary return exactly as they are.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/heal-plan-gate-wiring.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full heal suite for no regression**

Run: `npx vitest run tests/skill-heal-apply.test.ts tests/skill-heal-gate.test.ts tests/auto-skills.test.ts`
Expected: PASS. (The ceiling/no-coverage `healSkill` tests early-return before drafting, so the new plan-gate path is not exercised there.)

- [ ] **Step 6: Verify no other test asserted the removed summary string**

Run: `grep -rn "could not generate a meaningful patch" tests/ src/`
Expected: no matches (the string is gone; rejects are silent per the contract). If any match exists, update that assertion to expect `{ patched: false, summary: '' }`.

- [ ] **Step 7: Commit**

```bash
git add src/auto-skills.ts tests/heal-plan-gate-wiring.test.ts
git commit -m "feat(heal): run plan-gate before delivery gate in healSkill"
```

---

### Task 5: Completion contract doc — `reference/heal-gate-contract.md`

The prescriptive contract the code now satisfies. No code; pure documentation that the conformance tests pin.

**Files:**
- Create: `reference/heal-gate-contract.md`

- [ ] **Step 1: Write the contract**

Create `reference/heal-gate-contract.md` with these sections (fill each from the implemented behavior — no placeholders):

1. **Purpose & trigger** — what self-healing is; fired from `telegram.ts`/`matrix.ts` on a low quality score or a detected user correction against the active skill.
2. **Inputs** — `skill`, drafted `candidate` prompt, `issue`, recorded `skill_eval_cases` split into `held_in`/`held_out`.
3. **Preconditions / guards** — eval coverage required (no cases → heal skipped); reject ceiling `HEAL_GATE.MAX_CONSECUTIVE_REJECTS` (paused for manual review at the ceiling).
4. **Gate stages** — Plan-gate (cheap: no-op, `<50` chars, degenerate, optional council judge; **fails open**) → Delivery-gate (replay under `HEAL_GATE.BUDGET_MS` wall-clock deadline; **fails closed**).
5. **Acceptance rule** — `Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0`; empty split ⇒ Δ = 0. Include the truth table.
6. **Outcomes & persistence** — promote updates `skills.system_prompt`; every attempt (promote / reject / plan-gate reject / budget abort) writes a `skill_revisions` note prefixed `promote`/`reject`. Reject = rollback-by-default (live prompt untouched).
7. **Tunables** — the `HEAL_GATE` table with values, plus the `HEAL_GATE_GRADER` and `HEAL_GATE_PLAN_JUDGE` env flags.
8. **Invariants** — fail-safe to reject on uncertainty; never promote without eval evidence; every attempt logged; the judge is a different model family than generation (`ClaudeProvider` vs router/qwen3.5).
9. **Conformance** — map each clause to its test: `tests/heal-gate-contract.test.ts` (values), `tests/skill-heal-gate.test.ts` (rule), `tests/heal-gate-budget.test.ts` (budget), `tests/heal-plan-gate.test.ts` + `tests/heal-plan-gate-wiring.test.ts` (plan-gate + cross-family judge), `tests/skill-heal-apply.test.ts` (promote/reject/coverage/ceiling).

- [ ] **Step 2: Verify cross-references resolve**

Run: `grep -n "BUDGET_MS\|MAX_CONSECUTIVE_REJECTS\|HEAL_GATE_PLAN_JUDGE" reference/heal-gate-contract.md src/auto-skills.ts src/config.ts`
Expected: the names appear in both the doc and the code (no typo'd identifiers).

- [ ] **Step 3: Commit**

```bash
git add reference/heal-gate-contract.md
git commit -m "docs(reference): self-healing gate completion contract"
```

---

### Task 6: Reusable loop-guard checklist + CLAUDE.md index

A generic, reusable guard checklist with the heal loop audited as worked example #1.

**Files:**
- Create: `reference/loop-guards-checklist.md`
- Modify: `CLAUDE.md` (the `## Reference Documents` table)

- [ ] **Step 1: Write the checklist**

Create `reference/loop-guards-checklist.md`:

- Intro: a reusable audit for any repeatable agent loop in Luna (heal loop, ollama agentic loop, future scheduled tasks).
- The six guards, each as `### <guard>` with *What it is · Why it matters · How to verify*:
  1. **Iteration cap** — a hard ceiling on loop turns.
  2. **Revision / reject limit** — a ceiling on repeated failed attempts before pausing for a human.
  3. **No-progress detection** — stop when successive attempts stop improving.
  4. **Budget / wall-clock cap** — bound cost/latency; fail-closed on breach.
  5. **Plan-gate (cheap pre-filter)** — reject obviously-bad work before expensive verification.
  6. **Independent cross-family judge** — verification by a different model than the one being judged.
- **Worked example: the skill self-healing loop** — a table auditing each guard: status (✅/⚠️/n-a) + evidence (`file:line` / contract clause):
  - Iteration cap — n/a (heal is single-shot; the ollama agentic loop has tier caps at `ollama.ts:50–64`).
  - Revision/reject limit — ✅ `HEAL_GATE.MAX_CONSECUTIVE_REJECTS=3`, `countConsecutiveHealRejections` (`auto-skills.ts`).
  - No-progress — ✅ acceptance rule requires `max(Δ)>0`; ceiling pauses stuck skills.
  - Budget cap — ✅ `HEAL_GATE.BUDGET_MS`, delivery-gate deadline (Task 2).
  - Plan-gate — ✅ `planGateCandidate` (Task 3–4).
  - Cross-family judge — ✅ `ClaudeProvider` judge vs router/qwen3.5 generation.

- [ ] **Step 2: Add both docs to the CLAUDE.md reference table**

In `CLAUDE.md`, under `## Reference Documents`, add two rows:

```markdown
| `reference/heal-gate-contract.md` | Self-healing gate completion contract (invariants, tunables, conformance) |
| `reference/loop-guards-checklist.md` | Reusable agent-loop guard checklist + heal-loop audit |
```

- [ ] **Step 3: Commit**

```bash
git add reference/loop-guards-checklist.md CLAUDE.md
git commit -m "docs(reference): reusable loop-guard checklist + index both contract docs"
```

---

### Task 7: Full verification sweep + version bump

**Files:**
- Modify: `package.json` (rc bump), `PROJECT_PLAN.md` (if a checkbox applies)

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors; no new `no-explicit-any` warnings beyond the existing ratchet.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all green, including the four new test files.

- [ ] **Step 4: Build + ESM smoke**

Run: `npm run build && npm run smoke`
Expected: clean — catches `require()`-in-ESM / runtime mismatches.

- [ ] **Step 5: Bump rc version**

Edit `package.json` to bump the rc (and `package-lock.json` version field to match). Tick any applicable `PROJECT_PLAN.md` checkbox for the harness self-improvement (A) gate work.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json PROJECT_PLAN.md
git commit -m "chore: bump rc for self-healing gate contract (budget cap + plan-gate)"
```

- [ ] **Step 7: Push and open PR**

```bash
git push -u origin feat/heal-gate-contract
gh pr create --fill
```
