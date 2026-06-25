# Self-Healing Gate Contract + Loop-Guard Audit — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Branch:** `feat/heal-gate-contract`

## Background

Luna's skill self-healing (rc.116, commit `0d011df`) gates AI-drafted prompt
rewrites behind a deterministic non-regression replay before promoting them. The
gate lives in `src/auto-skills.ts` (`healSkill`, `gateHealCandidate`,
`evaluateHealAcceptance`, `makeDefaultScorer`) and is already stronger than most
published agent loops: a held-in/held-out split, a formal acceptance rule
(`Δ_in≥0 ∧ Δ_out≥0 ∧ max>0`), a cross-family judge (`ClaudeProvider` judging
generations produced via the router/qwen3.5), and a consecutive-reject ceiling.

This work was prompted by evaluating three external projects (coop, superdense,
looper) during the harness self-improvement initiative. Two ideas were worth
borrowing:

1. **superdense's `gate.md` completion-contract pattern** — a single authoritative
   contract a loop must satisfy to "complete."
2. **looper's termination-guard vocabulary** — iteration cap, revision limit,
   no-progress detection, budget cap, plan-gate vs delivery-gate, and an
   independent (different-family) review council.

Auditing the heal loop against looper's guards surfaced two genuine gaps and
confirmed the rest were already covered.

### Audit result (heal loop vs looper guards)

| Guard | Luna today | Status |
|-------|-----------|--------|
| Iteration cap | Agentic loop tier-based 4/6/10 (`ollama.ts:50–64`); heal is single-shot | n/a (different shape) |
| Revision / reject limit | `MAX_CONSECUTIVE_HEAL_REJECTS = 3` (`auto-skills.ts:724`) | ✅ covered |
| No-progress detection | Rule requires `max(Δ) > 0`; reject-ceiling pauses stuck skills | ⚠️ implicit |
| Budget / wall-clock cap | **None** — replay is 40–80 LLM calls, bounded only by eval-case count | ❌ **gap** |
| Plan-gate (cheap pre-filter) | **None** — only a `≥50` char check before full replay | ❌ **gap** |
| Independent cross-family judge | Generation via router (qwen3.5), judge via `ClaudeProvider` | ✅ covered |

## Goals

1. Formalize the existing gate as a prescriptive **completion contract**
   (`reference/heal-gate-contract.md`) that documents current invariants *and*
   prescribes the two gaps.
2. Close both gaps **in this cycle**: a wall-clock **budget cap** and a cheap
   **plan-gate**, with a consolidated `HEAL_GATE` config block.
3. Produce a **reusable, committed** loop-guard checklist
   (`reference/loop-guards-checklist.md`) with the heal loop audited as example #1.
4. Back every contract clause with a **conformance test** so the contract cannot
   silently drift from the code.

## Non-Goals

- Token/USD budget accounting. Luna's Claude is subscription (no per-token cost);
  wall-clock captures the failure mode that matters (latency/runaway). Deliberate
  YAGNI.
- A multi-candidate heal retry loop. Heal stays single-shot draft → gate; the
  reject-ceiling already governs repetition across triggers.
- Making `gate.md` a runtime-parsed artifact. Conformance is enforced by tests,
  not by parsing markdown on the heal hot path (avoids a new failure surface on a
  safety mechanism; respects Code Conventions #2 and #6).

## Design

### Target heal flow (two-gate, bounded)

```
healSkill()
  ├─ pre-guards (exist today): eval-coverage required, reject-ceiling = 3
  ├─ AI draft candidate
  ├─ PLAN-GATE (new, cheap)
  │    deterministic (always run, blocking):
  │      - reject no-op (candidate == current)
  │      - reject too-short (< 50 chars)
  │      - reject degenerate (apology-only / truncated)
  │    optional (flag HEAL_GATE_PLAN_JUDGE, default on):
  │      - ONE council judge call ("plausible fix? y/n") via ClaudeProvider
  │      - judge error → fail-OPEN (proceed; delivery gate is the real net)
  │    fail → reject + log, counts toward reject-ceiling
  ├─ DELIVERY-GATE (existing replay) under BUDGET DEADLINE (new)
  │    non-regression rule: Δ_in≥0 ∧ Δ_out≥0 ∧ max>0
  │    deadline breached → ABORT = reject (fail-CLOSED)
  └─ promote | reject | abort → persist skill_revisions
```

### Component 1 — Budget cap (`gateHealCandidate`)

- **Guard:** wall-clock deadline. `HEAL_GATE.BUDGET_MS` (default `60000`).
- **Mechanism:** capture `deadline = now + BUDGET_MS` at gate entry; check between
  case-scoring batches (current-held-in, current-held-out, candidate-held-in,
  candidate-held-out). On breach, stop scoring and return a reject with reason
  `aborted: budget exceeded (<elapsed>ms)`.
- **Failure stance:** fail-closed. An abort is a reject — never promote on
  uncertainty. The reject is persisted to `skill_revisions`, so it counts toward
  `countConsecutiveHealRejections` and a pathologically slow skill self-pauses at
  the ceiling.
- **Note on `Date.now()`:** production code uses `Date.now()` normally; only
  *workflow scripts* forbid it. The deadline is computed in `auto-skills.ts`
  (regular runtime code), so this is fine.

### Component 2 — Plan-gate (`planGateCandidate`)

New function `planGateCandidate(skill, candidate, issue)` → `{ pass, reason }`,
called by `healSkill` *before* `gateHealCandidate`.

- **Deterministic checks (blocking, no LLM):** `candidate !== current` (no-op),
  `length ≥ 50` (absorbs today's inline check), not degenerate (not an
  apology-only or visibly truncated rewrite).
- **Optional council judge (flag `HEAL_GATE_PLAN_JUDGE`, default on):** one
  `ClaudeProvider` call asking whether the candidate plausibly addresses `issue`
  without breaking the skill's stated purpose. Single call vs the 40–80 of the
  delivery gate.
- **Failure stance:** fail-open on judge error (proceed to delivery gate — the
  plan-gate is a cost optimization, not the safety net). Deterministic checks stay
  blocking.
- **On fail:** return reject, log `reject: plan-gate (<reason>)`, count toward
  ceiling, skip the expensive replay entirely.

### Component 3 — Single source of truth (`HEAL_GATE`)

Consolidate the today-scattered tunables into one documented object in
`auto-skills.ts`:

| Key | Value | Source today |
|-----|-------|--------------|
| `MAX_CONSECUTIVE_REJECTS` | 3 | `MAX_CONSECUTIVE_HEAL_REJECTS` |
| `MAX_EVAL_CASES_PER_SPLIT` | 10 | same name |
| `MIN_QUALITY_SCORE` | 70 | same name |
| `BUDGET_MS` | 60000 | **new** |
| `PLAN_JUDGE` | env `HEAL_GATE_PLAN_JUDGE !== 'false'` | **new** flag in `config.ts` |
| `GRADER` | env `HEAL_GATE_GRADER !== 'false'` | existing `config.ts` |

Existing exported names are preserved (re-exported from `HEAL_GATE`) so callers
and current tests don't break — surgical, no rename churn.

### Component 4 — Contract doc (`reference/heal-gate-contract.md`)

Prescriptive completion contract. Sections: Purpose/Trigger · Inputs · Preconditions
& guards · Gate stages (plan → delivery) · Acceptance rule + truth table · Outcomes
& persistence & rollback · Tunables (the `HEAL_GATE` table with values) · Invariants
(fail-safe to reject; never promote without evidence; every attempt logged;
cross-family judge) · Conformance (each clause → test name). Added to the
`reference/` table in `CLAUDE.md`.

### Component 5 — Reusable checklist (`reference/loop-guards-checklist.md`)

Generic guard vocabulary (6): iteration cap · revision/reject limit · no-progress
detection · budget/wall-clock cap · plan-gate pre-filter · independent cross-family
judge. Each entry: *what it is · why it matters · how to verify*. Then the heal loop
audited against all six (pass/gap/file:line) as the first worked example. Reusable
against the ollama agentic loop and future scheduled tasks. Added to the `reference/`
table in `CLAUDE.md`.

### Component 6 — Conformance tests (`test/heal-gate-contract.test.ts`)

One assertion per contract clause:

- Non-regression rule truth table (`evaluateHealAcceptance`, pure) — promote only
  when `Δ_in≥0 ∧ Δ_out≥0 ∧ max>0`.
- `HEAL_GATE.MAX_CONSECUTIVE_REJECTS === 3`, `HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT
  === 10` (code matches documented contract values).
- Plan-gate rejects no-op / too-short / degenerate candidates **without invoking
  the scorer** (spy asserts the expensive scorer is never called).
- Budget deadline → abort = reject; scorer stops early once the deadline passes.
- Judge path uses `ClaudeProvider` (cross-family) — guards the "model grading its
  own homework" property.

## Data Flow

```
Use → quality check → [low] → healSkill
  → pre-guards → AI draft
  → planGateCandidate (cheap)         ── fail ─→ reject + log (ceiling++)
  → gateHealCandidate (replay, deadline) ─ abort ─→ reject + log (ceiling++)
       → evaluateHealAcceptance
            → promote → update skills.system_prompt + log
            → reject  → log only (no prompt change = rollback-by-default)
```

## Error Handling

- **Plan-gate judge error:** fail-open (proceed to delivery gate). Non-blocking,
  consistent with existing graceful degradation (Code Convention #6).
- **Budget breach:** fail-closed (reject). The guard exists to bound cost.
- **Delivery-gate judge error:** unchanged — already falls back to the self-monitor
  floor (`makeDefaultScorer`).
- **No eval cases:** unchanged — heal is skipped (ungated heal impossible).

## Testing & Verification

- `npx vitest run` — new `test/heal-gate-contract.test.ts` plus existing suite.
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors; no new `no-explicit-any`.
- `npm run build && npm run smoke` — dist-level ESM smoke.
- Manual: trigger a heal with a no-op candidate (plan-gate reject, no replay) and a
  heal with an artificially low `BUDGET_MS` (budget abort → reject), confirm
  `skill_revisions` notes.

## Open Judgment Calls (approved)

- Wall-clock-only budget (no token/call-count cap).
- Plan-gate judge fails open; budget guard fails closed.
- `gate.md` is a doc enforced by tests, not parsed at runtime.
