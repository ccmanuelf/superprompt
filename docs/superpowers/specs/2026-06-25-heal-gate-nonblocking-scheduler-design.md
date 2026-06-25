# Design: Non-blocking skill-heal scheduler (Gate 0b fix)

**Date:** 2026-06-25
**Branch:** `fix/heal-gate-nonblocking`
**Status:** Approved (brainstorming) → pending implementation plan

## Problem

`skillHealingGate` (Gate 0b) is documented as *"Fire-and-continue: never blocks
the pipeline"* (`src/core/message-gates.ts:98`), but the implementation
**blocks** the message handler:

- `src/core/message-gates.ts:110` — the gate `await`s the full `heal()`.
- `src/platforms/telegram.ts:226` — the handler `await`s the gate.

So when a user corrects an active skill and the heal reaches the replay stage,
the handler is frozen for the **entire heal** (candidate drafting + the replay,
which is capped by `HEAL_GATE.BUDGET_MS = 300_000` / 5 min). The user's reply is
delayed by minutes and (depending on the platform concurrency model) other
messages in that conversation are starved.

### How it was found

Live Telegram sanity check, 2026-06-25. A correction sent at 17:45:28 did not
get a reply until 17:57:20 — **~12 minutes** — because the awaited heal drafted
a candidate and then ran the replay until the 5-min budget aborted
(`reject: aborted — budget exceeded (300000ms)`), all while holding the handler.

### Why it stayed latent

The consecutive-reject ceiling (`HEAL_GATE.MAX_CONSECUTIVE_REJECTS = 3`) pauses
healing for a skill with 3 rejects at the head of its revision log. A paused
heal returns instantly, so the handler never blocks. The bug only surfaces when
a heal actually runs to replay. rc.118 raising the budget from 60s to 5 min
widened the block ~5x, turning a tolerable stall into a multi-minute freeze.

### Confirmation it is one blocked handler, not a re-delivery loop

Each top-level handler invocation generates a fresh `generateTraceId()`
(`src/platforms/telegram.ts:208`). During the incident all internal
`router.sendMessage` calls shared **one** traceId — they were the heal's
replay-scorer generations under a single handler invocation, not repeated
handler entries. The 5-min budget aborted the heal correctly and the handler
then completed; there was no infinite loop. (rc.118's budget cap is verified
working — it aborted at exactly `300000ms`.)

## Goals

1. The message handler never blocks on a heal — honor the documented
   fire-and-continue contract.
2. Bound the local-model (qwen3.5) load that heals impose, so a heal (or several
   corrections) cannot contend with the user's own response generation.
3. Stay idiomatic to the existing loop-guard philosophy (budget cap, reject
   ceiling, fail-closed gate — see `reference/heal-gate-contract.md`). No new
   persistent infrastructure, no failure modes that can starve healing
   indefinitely.

## Non-goals

- Persisting heals across process restarts. Heals are best-effort and
  re-trigger on the next correction; the daemon restarts routinely.
- Changing the heal gate's *decision* logic (plan-gate, delivery-gate, budget,
  reject ceiling) — only *when/how* the heal is invoked.

## Design

A small in-process **heal scheduler** in `src/auto-skills.ts`. The gate enqueues
a heal request and returns immediately; the scheduler runs heals off the request
path under a strict concurrency and dedup policy.

### Scheduler properties

- **Concurrency N = 1.** At most one heal runs at a time. Heals are best-effort
  and qwen3.5 is the single bottleneck; one-at-a-time keeps heal load off the
  user's response path. The value is a named constant so it can be raised later
  if measured.
- **Per-skill dedup / coalesce.** At most one heal per `skillId` is
  queued-or-running. A correction for a skill that already has a queued/running
  heal coalesces into the existing entry (latest correction context wins) rather
  than stacking a second heal. This bounds the queue depth to the number of
  distinct skills (small) and prevents stale pile-up.
- **Buffer-and-run (the C policy).** Excess heals beyond N wait in the queue and
  run when a slot frees, rather than being dropped. Safe because (a) per-skill
  dedup bounds queue depth and (b) each heal is budget-capped at 5 min, so
  head-of-line wait is bounded.
- **In-memory, best-effort.** Queue + running-set live in process memory; lost
  on restart by design. No schema, no persistence, no recovery code.
- **Each heal stays budget-capped** by the existing `HEAL_GATE.BUDGET_MS`.

### Data structures (in `auto-skills.ts`)

- `healQueue: HealRequest[]` — FIFO of pending requests.
- `healInFlight: Set<string>` — `skillId`s currently running (size ≤ N).
- `healQueued: Map<string, HealRequest>` — `skillId` → its pending request, for
  O(1) dedup/coalesce.

`HealRequest` carries everything `heal()` needs: `skill`, `reason`, `rawText`,
`router`, `chatId`, and an optional `onResult(healResult)` callback (used by the
gate to send the patch summary).

### Entry point

```ts
export function enqueueHeal(req: HealRequest): void
```

- If `healInFlight.has(skillId)` or `healQueued.has(skillId)` → coalesce: replace
  the stored request's mutable fields (reason/rawText/onResult) with the newer
  ones; do not enqueue a duplicate.
- Else push to `healQueue`, record in `healQueued`, and call `pumpHeals()`.

`pumpHeals()` — while `healInFlight.size < N` and the queue is non-empty: shift a
request, move it from `healQueued` to `healInFlight`, and run:

```ts
heal(...)
  .then(r => req.onResult?.(r))
  .catch(err => logger.debug({ err }, 'Skill self-healing skipped (non-blocking)'))
  .finally(() => { healInFlight.delete(skillId); pumpHeals(); });
```

The `finally` guarantees the slot is released even if a heal throws, so the
scheduler cannot deadlock.

### Gate change (the actual bug fix)

`src/core/message-gates.ts` `skillHealingGate` becomes synchronous-return after
the cheap lookups:

```ts
export async function skillHealingGate(pc, chatId, rawText, io): Promise<void> {
  const activeSkillForHealing = await pc.skills.getActive(chatId);
  if (!activeSkillForHealing || !pc.autoSkills.detectCorrection(rawText)) return;
  pc.autoSkills.enqueueHeal({
    skill: activeSkillForHealing,
    reason: `User corrected the approach: "${rawText}"`,
    rawText,
    router: pc.router,
    chatId,
    onResult: (r) => { if (r.patched) void io.reply(r.summary); },
  });
}
```

`getActive` (a quick DB read) and `detectCorrection` (sync regex) stay on the
path; only the expensive `heal()` is deferred. The handler returns promptly.

`enqueueHeal` is exposed on the `PlatformContext.autoSkills` facade
(`src/core/context.ts`) alongside the existing `heal`/`shouldHeal` bindings.

## Data flow

```
user correction
  → handleMessageInner
    → skillHealingGate                     (returns immediately)
        → autoSkills.enqueueHeal           (coalesce or enqueue + pump)
    → ... rest of handler (generate reply, send)   ← no longer blocked
                                                    
scheduler (off-path):
  pumpHeals → heal() [budget-capped]
            → onResult → io.reply(summary) [if patched]
            → finally → release slot → pumpHeals
```

## Error handling

- A heal that throws is caught (debug-logged, non-blocking) and its slot is
  released in `finally` — consistent with the current gate's catch.
- `onResult` reply failures are swallowed (`void io.reply(...)`), matching the
  existing fire-and-forget reply idiom elsewhere in the gates.
- Budget breach inside `heal()` is unchanged (fail-closed reject, persisted).

## Testing

**New unit tests (scheduler, `tests/`):**
- N=1 serializes: two distinct-skill heals run one at a time (second starts only
  after the first's slot releases).
- Per-skill dedup coalesces: two corrections for the same skill while one is
  in-flight result in at most one queued follow-up, carrying the latest context.
- Slot release on throw: a heal that rejects still frees its slot and lets the
  next run (no deadlock).
- `onResult` fires with the heal result; patch → summary callback invoked.

**Updated behavior test:**
- `tests/telegram-message-flow.test.ts` — assert `skillHealingGate` returns
  without awaiting heal completion (e.g. heal stub never resolves, gate still
  resolves; enqueue observed). Keep the suite green per its contract note.

## Verification (repo workflow)

`npx tsc --noEmit` · `npm run lint` (0 errors) · `npx vitest run` ·
`npm run build && npm run smoke` · `docker compose build luna && up -d luna`,
then re-run the Telegram smoke: a correction to an active skill must get its
normal reply promptly (seconds, not minutes) while the heal runs in the
background.

## Rollout

- rc bump in `package.json` (+ lockfile).
- Update `reference/heal-gate-contract.md` if the contract text references gate
  invocation timing.
- Conventional commit (`fix:`), PR to main.

## Resolved flags (no deferrals)

Both items raised at spec review are resolved here rather than parked.

### Interim freeze window → resolved by shipping the fix

The smoke left `auto-system-time-nodejs-version` at 1 consecutive reject
(un-paused), so until the fix lands a correction to an active skill could still
freeze the handler. **Resolution: ship the permanent fix now** rather than
band-aid. Re-pausing via hand-inserted reject rows was considered and rejected —
synthetic audit-log rows would be throwaway debt requiring later cleanup, and a
per-skill re-pause would not protect *other* active skills anyway. The code fix
makes every skill freeze-proof; the window is closed at deploy. No corrections
are exercised against active skills in the interim.

### Deliverable-retry path (16:45 incident) → investigated, no defect

The `Deliverable retry FAILED — surfacing hard error to user` event at 16:45
(`src/providers/router.ts:1103`) is **graceful degradation working as designed**
(Code Convention #6), not a bug:

- Bounded to exactly one retry; on failure it surfaces a clear bilingual
  user-facing message (`retryToolsUsed: []`), it does not crash.
- The 16:46 restart was a **clean manual shutdown** (`Shutting down Luna...` →
  orderly subsystem stops → `Luna stopped. Goodbye.`), ~45s later — not a crash
  caused by the retry.

No change required.

## Related observation (separate scope)

For `auto-system-time-nodejs-version`, every heal candidate has been rejected
(delivery-gate no-op, plan-gate implausible, budget abort) — the local qwen3.5
cannot draft a candidate that passes the gates for this skill. This is a heal
*effectiveness* limitation of the local model, not a correctness defect of this
change, and improving local-model heal-candidate quality is a distinct,
larger effort. Tracked here so it is not lost; explicitly out of scope for the
blocking-gate fix.
