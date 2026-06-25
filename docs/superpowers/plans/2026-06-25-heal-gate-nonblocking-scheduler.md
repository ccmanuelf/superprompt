# Non-blocking Heal Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `skillHealingGate` from blocking the Telegram/Matrix message handler by running heals through an in-process scheduler (N=1, per-skill dedup, buffer-and-run), so a correction never freezes the conversation while a heal replays.

**Architecture:** Add a small scheduler to `src/auto-skills.ts` (`enqueueHeal` + an internal pump over a FIFO queue, an in-flight `Set`, and a queued `Map` for O(1) per-skill coalesce). The gate enqueues and returns immediately; the heal's patch-summary reply is sent from the scheduler via an `onResult` callback. Each heal is still budget-capped by the existing `HEAL_GATE.BUDGET_MS`.

**Tech Stack:** TypeScript (ES2022, NodeNext, strict, ESM), vitest, pino logger.

## Global Constraints

- ESM only; import paths end in `.js` (NodeNext). Copied from project Code Conventions.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; do not add new `no-explicit-any` warnings.
- Graceful degradation at service boundaries (Code Convention #6): a heal that throws is logged and swallowed, never crashes the handler.
- Heals are best-effort and in-memory; no persistence across restarts.
- Spec: `docs/superpowers/specs/2026-06-25-heal-gate-nonblocking-scheduler-design.md`.

---

### Task 1: Heal scheduler core in `auto-skills.ts`

**Files:**
- Modify: `src/auto-skills.ts` (add scheduler after `healSkill`, ~line 990)
- Test: `tests/heal-scheduler.test.ts` (create)

**Interfaces:**
- Consumes: `healSkill(skill, issue, conversationContext, router, chatId)` (existing, `src/auto-skills.ts:906`), returns `Promise<{ patched: boolean; summary: string }>`; types `Skill`, `ProviderRouter` (already imported in the module).
- Produces:
  - `export interface HealRequest { skill: Skill; issue: string; rawText: string; router: ProviderRouter; chatId: string; onResult?: (r: { patched: boolean; summary: string }) => void }`
  - `export function enqueueHeal(req: HealRequest): void`
  - `export function __setHealRunnerForTests(fn: (req: HealRequest) => Promise<{ patched: boolean; summary: string }>): void`
  - `export function __resetHealSchedulerForTests(): void`

- [ ] **Step 1: Write the failing tests**

Create `tests/heal-scheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueHeal,
  __setHealRunnerForTests,
  __resetHealSchedulerForTests,
  type HealRequest,
} from '../src/auto-skills.js';

// Minimal Skill-shaped stub; the scheduler only reads `.id`.
function reqFor(skillId: string, over: Partial<HealRequest> = {}): HealRequest {
  return {
    skill: { id: skillId, name: skillId, system_prompt: 'x' } as HealRequest['skill'],
    issue: `issue-${skillId}`,
    rawText: `raw-${skillId}`,
    router: {} as HealRequest['router'],
    chatId: 'chat-1',
    ...over,
  };
}

/** A runner whose completion is controlled by the test via a returned resolver. */
function deferredRunner() {
  const calls: string[] = [];
  const resolvers: Array<(v: { patched: boolean; summary: string }) => void> = [];
  const runner = (req: HealRequest) => {
    calls.push(req.skill.id);
    return new Promise<{ patched: boolean; summary: string }>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return { runner, calls, resolveNext: (r = { patched: false, summary: '' }) => resolvers.shift()!(r) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('heal scheduler', () => {
  beforeEach(() => __resetHealSchedulerForTests());

  it('N=1: a second distinct-skill heal starts only after the first frees its slot', async () => {
    const d = deferredRunner();
    __setHealRunnerForTests(d.runner);

    enqueueHeal(reqFor('skill-a'));
    enqueueHeal(reqFor('skill-b'));
    await tick();

    expect(d.calls).toEqual(['skill-a']); // only first running

    d.resolveNext(); // finish skill-a
    await tick();

    expect(d.calls).toEqual(['skill-a', 'skill-b']); // skill-b now runs
  });

  it('per-skill dedup: corrections for an in-flight skill coalesce into one follow-up with latest context', async () => {
    const d = deferredRunner();
    __setHealRunnerForTests(d.runner);

    enqueueHeal(reqFor('skill-a', { issue: 'first' }));
    await tick();
    enqueueHeal(reqFor('skill-a', { issue: 'second' }));
    enqueueHeal(reqFor('skill-a', { issue: 'third' }));
    await tick();

    expect(d.calls).toEqual(['skill-a']); // still only the first in-flight, no stacking

    d.resolveNext(); // finish first
    await tick();

    expect(d.calls).toEqual(['skill-a', 'skill-a']); // exactly one coalesced follow-up
  });

  it('slot is released even when a heal throws (no deadlock)', async () => {
    const calls: string[] = [];
    __setHealRunnerForTests(async (req) => {
      calls.push(req.skill.id);
      if (req.skill.id === 'boom') throw new Error('heal failed');
      return { patched: false, summary: '' };
    });

    enqueueHeal(reqFor('boom'));
    enqueueHeal(reqFor('skill-ok'));
    await tick();
    await tick();

    expect(calls).toEqual(['boom', 'skill-ok']); // throw freed the slot
  });

  it('onResult fires with the heal result', async () => {
    __setHealRunnerForTests(async () => ({ patched: true, summary: 'done' }));
    const onResult = vi.fn();

    enqueueHeal(reqFor('skill-a', { onResult }));
    await tick();
    await tick();

    expect(onResult).toHaveBeenCalledWith({ patched: true, summary: 'done' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/heal-scheduler.test.ts`
Expected: FAIL — `enqueueHeal` / `__setHealRunnerForTests` / `__resetHealSchedulerForTests` not exported.

- [ ] **Step 3: Implement the scheduler**

In `src/auto-skills.ts`, immediately after the `healSkill` function (ends ~line 991), add:

```ts
// ── Heal scheduler (non-blocking) ────────────────────────────
// The message-gate enqueues a heal and returns immediately; heals run here
// off the request path. Policy: at most HEAL_CONCURRENCY heals at once, at
// most one queued-or-running heal per skill (coalesce duplicates), in-memory
// and best-effort (lost on restart, re-triggers on the next correction).
// Each heal is still budget-capped inside healSkill via HEAL_GATE.BUDGET_MS.

export interface HealRequest {
  skill: Skill;
  issue: string;
  rawText: string;
  router: ProviderRouter;
  chatId: string;
  onResult?: (result: { patched: boolean; summary: string }) => void;
}

const HEAL_CONCURRENCY = 1;
const healQueue: HealRequest[] = [];
const healInFlight = new Set<string>();          // skillIds currently running
const healQueued = new Map<string, HealRequest>(); // skillId -> its single pending request

type HealRunner = (req: HealRequest) => Promise<{ patched: boolean; summary: string }>;
const defaultHealRunner: HealRunner = (req) =>
  healSkill(req.skill, req.issue, req.rawText, req.router, req.chatId);
let healRunner: HealRunner = defaultHealRunner;

/**
 * Schedule a heal without blocking the caller. Coalesces against any
 * queued-or-running heal for the same skill so corrections never stack.
 */
export function enqueueHeal(req: HealRequest): void {
  const id = req.skill.id;
  const queued = healQueued.get(id);
  if (queued) {
    // Already a pending heal for this skill — fold in the newer context.
    queued.issue = req.issue;
    queued.rawText = req.rawText;
    queued.router = req.router;
    queued.chatId = req.chatId;
    queued.onResult = req.onResult;
    return;
  }
  if (healInFlight.has(id)) {
    // Running but nothing queued yet — queue a single follow-up.
    healQueue.push(req);
    healQueued.set(id, req);
    return;
  }
  healQueue.push(req);
  healQueued.set(id, req);
  pumpHeals();
}

function pumpHeals(): void {
  while (healInFlight.size < HEAL_CONCURRENCY && healQueue.length > 0) {
    const req = healQueue.shift()!;
    const id = req.skill.id;
    healQueued.delete(id);
    healInFlight.add(id);
    healRunner(req)
      .then((result) => {
        try {
          req.onResult?.(result);
        } catch (err) {
          logger.debug({ err }, 'Heal onResult callback failed (non-blocking)');
        }
      })
      .catch((err) => logger.debug({ err }, 'Skill self-healing skipped (non-blocking)'))
      .finally(() => {
        healInFlight.delete(id);
        pumpHeals();
      });
  }
}

/** Test seam: override the heal executor. */
export function __setHealRunnerForTests(fn: HealRunner): void {
  healRunner = fn;
}

/** Test seam: clear scheduler state between tests. */
export function __resetHealSchedulerForTests(): void {
  healQueue.length = 0;
  healInFlight.clear();
  healQueued.clear();
  healRunner = defaultHealRunner;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/heal-scheduler.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auto-skills.ts tests/heal-scheduler.test.ts
git commit -m "feat(heal): in-process heal scheduler (N=1, per-skill coalesce)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire scheduler into the facade and make Gate 0b non-blocking

**Files:**
- Modify: `src/core/context.ts` (import + facade type + binding)
- Modify: `src/core/message-gates.ts:101-123` (`skillHealingGate`)
- Test: `tests/telegram-message-flow.test.ts` (update mock + add assertion)

**Interfaces:**
- Consumes: `enqueueHeal` (Task 1), `pc.autoSkills.enqueueHeal`, `pc.skills.getActive`, `pc.autoSkills.detectCorrection`, `io.reply`.
- Produces: a `skillHealingGate` that returns without awaiting the heal.

- [ ] **Step 1: Update the flow test (failing) to assert non-blocking enqueue**

In `tests/telegram-message-flow.test.ts`, add `enqueueHeal` to the `autoSkills` mock block (the one near line 64, alongside `heal: vi.fn(...)`):

```ts
      heal: vi.fn(async () => ({ patched: false, summary: '' })),
      enqueueHeal: vi.fn(),
```

Then add this test (place it after the existing auto-skill/proposal gate tests, e.g. near the end of the file before the final closing brace):

```ts
  it('skillHealingGate enqueues a heal and never awaits it (non-blocking)', async () => {
    const { skillHealingGate } = await import('../src/core/message-gates.js');
    const io = { reply: vi.fn(), replyChunks: vi.fn(), replyPlain: vi.fn() };
    const pc = makePc({
      skills: { getActive: vi.fn(async () => ({ id: 's1', name: 's1', system_prompt: 'p' })) },
      autoSkills: {
        detectCorrection: vi.fn(() => true),
        // heal would hang forever if (wrongly) awaited:
        heal: vi.fn(() => new Promise(() => {})),
        enqueueHeal: vi.fn(),
      },
    });

    // Resolves promptly despite heal never resolving → proves no await on heal.
    await skillHealingGate(pc as never, CHAT_ID, 'no, that is wrong', io as never);

    expect(pc.autoSkills.enqueueHeal).toHaveBeenCalledTimes(1);
    expect(pc.autoSkills.heal).not.toHaveBeenCalled();
  });
```

> Note: `makePc(overrides)` is the existing helper (`tests/telegram-message-flow.test.ts:55`); it per-bag `Object.assign`-merges each override bag into the base mock (line 132), so the nested `skills`/`autoSkills` overrides above merge correctly. `CHAT_ID` is already defined at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/telegram-message-flow.test.ts -t "enqueues a heal"`
Expected: FAIL — `enqueueHeal` not called (gate still calls `heal`).

- [ ] **Step 3: Add `enqueueHeal` to the context facade**

In `src/core/context.ts`:

a) Add `enqueueHeal` to the auto-skills import (line ~71):

```ts
  shouldHealSkill, healSkill, enqueueHeal, detectSkillCorrection, captureSuccessfulUse,
```

b) Add to the facade type block (after `heal: typeof healSkill;`, line ~264):

```ts
    heal: typeof healSkill;
    enqueueHeal: typeof enqueueHeal;
```

c) Add to the facade bindings (after `heal: autoSkillsMod.healSkill,`, line ~534):

```ts
      heal: autoSkillsMod.healSkill,
      enqueueHeal: autoSkillsMod.enqueueHeal,
```

- [ ] **Step 4: Make `skillHealingGate` non-blocking**

Replace `src/core/message-gates.ts:101-123` (the whole `skillHealingGate` function) with:

```ts
export async function skillHealingGate(
  pc: PlatformContext,
  chatId: string,
  rawText: string,
  io: GateIO,
): Promise<void> {
  const activeSkillForHealing = await pc.skills.getActive(chatId);
  if (!activeSkillForHealing || !pc.autoSkills.detectCorrection(rawText)) return;
  // Fire-and-continue: schedule the heal off the request path so a long
  // replay (up to HEAL_GATE.BUDGET_MS) never blocks the message handler.
  pc.autoSkills.enqueueHeal({
    skill: activeSkillForHealing,
    issue: `User corrected the approach: "${rawText}"`,
    rawText,
    router: pc.router,
    chatId,
    onResult: (r) => { if (r.patched) void io.reply(r.summary); },
  });
}
```

- [ ] **Step 5: Run the updated flow test to verify it passes**

Run: `npx vitest run tests/telegram-message-flow.test.ts`
Expected: PASS (including the new "enqueues a heal" test; suite stays green).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/context.ts src/core/message-gates.ts tests/telegram-message-flow.test.ts
git commit -m "fix(heal): make Gate 0b non-blocking via heal scheduler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Full verification, docs, rc bump, PR

**Files:**
- Modify: `package.json` (+ `package-lock.json`) — rc bump
- Modify: `reference/heal-gate-contract.md` (if it references gate-invocation timing)
- Modify: `PROJECT_PLAN.md` (note the fix under the relevant section, if a changelog/notes area exists)

- [ ] **Step 1: Full static + unit verification**

```bash
npx tsc --noEmit
npm run lint
npx vitest run
```
Expected: tsc clean; lint 0 errors (no new `no-explicit-any` warnings); all tests pass.

- [ ] **Step 2: Build + ESM smoke**

```bash
npm run build
npm run smoke
```
Expected: build succeeds; smoke passes (no ESM/runtime mismatch).

- [ ] **Step 3: Update the heal-gate contract doc if needed**

Open `reference/heal-gate-contract.md`. If it states or implies the gate awaits/blocks on the heal, add one line under the invariants: "Gate 0b invocation is non-blocking — heals run via the in-process scheduler (`enqueueHeal`), N=1 with per-skill coalesce; the handler never awaits a heal." If the doc does not discuss invocation timing, skip this step (note it as skipped).

- [ ] **Step 4: Bump rc version**

Edit `package.json` `version` to the next rc (current `1.0.0-rc.118` → `1.0.0-rc.119`), then sync the lockfile:

```bash
npm install --package-lock-only
```
Expected: `package-lock.json` version line updated to match.

- [ ] **Step 5: Commit docs + version**

```bash
git add package.json package-lock.json reference/heal-gate-contract.md PROJECT_PLAN.md
git commit -m "chore(heal): rc.119 — non-blocking Gate 0b + contract note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Rebuild the container and live re-smoke**

```bash
docker compose build luna && docker compose up -d luna
```
Then, with the running daemon: send a correction to an active skill via Telegram and confirm the **normal reply arrives in seconds** (not minutes), while heal activity continues in the background in `docker logs luna-bot`. Confirm logs show the response path completing independently of the heal (distinct from the 17:45→17:57 freeze observed pre-fix).

- [ ] **Step 7: Push and open PR**

```bash
git push -u origin fix/heal-gate-nonblocking
gh pr create --title "fix(heal): non-blocking Gate 0b heal scheduler (rc.119)" --body "$(cat <<'EOF'
## Summary
Gate 0b (`skillHealingGate`) awaited the full heal, freezing the message handler for the entire replay (up to the 5-min budget; ~12 min observed live on 2026-06-25). rc.118's longer budget widened the freeze; the consecutive-reject pause normally masked it.

Fix: an in-process heal scheduler (N=1, per-skill coalesce, buffer-and-run, in-memory). The gate enqueues and returns immediately; the patch-summary reply is sent from the scheduler. Each heal stays budget-capped.

Spec: `docs/superpowers/specs/2026-06-25-heal-gate-nonblocking-scheduler-design.md`
Plan: `docs/superpowers/plans/2026-06-25-heal-gate-nonblocking-scheduler.md`

## Verification
- `tsc --noEmit`, `lint` (0 errors), `vitest run`, `build`, `smoke` all green
- New `tests/heal-scheduler.test.ts` (N=1, dedup/coalesce, slot-release-on-throw, onResult)
- Updated `tests/telegram-message-flow.test.ts` asserts the gate never awaits the heal
- Live re-smoke: correction reply arrives in seconds; heal runs in background

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Non-blocking gate → Task 2 (gate rewrite + facade + flow test). ✓
- Scheduler N=1 / per-skill dedup / buffer-and-run / in-memory → Task 1. ✓
- Budget cap unchanged → heal runs through existing `healSkill` (Task 1 default runner). ✓
- Tests (scheduler unit + flow-test update) → Tasks 1 & 2. ✓
- Verification workflow + rc bump + contract doc + PR → Task 3. ✓
- Resolved flags (no band-aid, deliverable-retry no-defect) → documented in spec; no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Step 3 of Task 3 is conditional (contract doc) with an explicit skip path — acceptable.

**Type consistency:** `HealRequest` fields (`skill`, `issue`, `rawText`, `router`, `chatId`, `onResult`) are identical across the scheduler (Task 1), the facade type (Task 2 uses `typeof enqueueHeal`), and the gate call (Task 2). `healSkill` arg order `(skill, issue, rawText, router, chatId)` matches `defaultHealRunner`. Return shape `{ patched, summary }` consistent throughout.
