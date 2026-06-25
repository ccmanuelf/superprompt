# Self-Healing Gate Completion Contract

**Version:** rc.116 (2026-06-24)
**Source of truth:** `src/auto-skills.ts` (`HEAL_GATE`, `healSkill`, `gateHealCandidate`, `planGateCandidate`, `evaluateHealAcceptance`)
**Pinned by:** `tests/heal-gate-contract.test.ts` — if a value in the tunables table changes in source, the contract test fails.

---

## 1. Purpose & Trigger

Skill self-healing is the mechanism by which Luna automatically improves an auto-generated skill's system prompt when the skill is observed to produce a poor-quality response or the user explicitly corrects the approach.

**What it is:** A closed improvement loop — use → detect gap → AI drafts a candidate prompt → gate verifies it against recorded replay cases under a non-regression rule → promote or reject.

**When it fires:** `healSkill` is called from `telegram.ts` and `matrix.ts` at the post-response seam in two conditions:
1. The active skill's response scores below `HEAL_GATE.MIN_QUALITY_SCORE` (70) on the self-monitor.
2. The user's next message matches a correction pattern (EN/ES heuristics in `CORRECTION_PATTERNS`).

Only auto-generated skills are eligible (`skill.id.startsWith('auto-')` and `!skill.is_builtin`).

---

## 2. Inputs

| Input | Type | Description |
|---|---|---|
| `skill` | `Skill` | The active skill record from the `skills` table, including `id`, `name`, `system_prompt`. |
| `candidate` | `string` | AI-drafted replacement system prompt (generated via `router.sendMessage` inside `healSkill`). |
| `issue` | `string` | Description of what went wrong — the low-quality signal or correction text passed from the platform layer. |
| `held_in` cases | `SkillEvalCase[]` | Replay cases with `split = 'held_in'` from `skill_eval_cases`, ordered oldest-first. Used for training signal. |
| `held_out` cases | `SkillEvalCase[]` | Replay cases with `split = 'held_out'` from `skill_eval_cases`. Used as the regression guard. |

Cases are captured by `captureSuccessfulUse` (called from the same post-response seam on high-quality interactions). The first successful use seeds `held_in`; subsequent ones fill `held_out`. Each split is capped at `HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT` (10) with FIFO eviction.

---

## 3. Preconditions / Guards

Two guards are checked at the top of `healSkill` before any draft is generated:

### Guard 1 — Eval coverage required

```
evalCases = getSkillEvalCases(skill.id)
if (evalCases.length === 0) → skip heal silently
```

A candidate cannot be verified without replay cases. The heal is skipped (not rejected) so it does not count toward the reject ceiling. An ungated promotion is impossible by construction.

### Guard 2 — Reject ceiling (`MAX_CONSECUTIVE_REJECTS`)

```
consecutiveRejects = countConsecutiveHealRejections(skill.id)
if (consecutiveRejects >= HEAL_GATE.MAX_CONSECUTIVE_REJECTS) → pause for manual review
```

`countConsecutiveHealRejections` scans `skill_revisions` newest-first and counts contiguous rows whose `revision_note` matches `/^reject/i`, stopping at the first promotion. A skill that has failed `MAX_CONSECUTIVE_REJECTS` (3) consecutive gate attempts is paused — no further draft is generated — and a `warn`-level log entry flags it for manual review.

**Why reject notes must be `reject`-prefixed:** `countConsecutiveHealRejections` uses `/^reject/i` as the detection pattern. Plan-gate failures write `reject: plan-gate (…)`, budget aborts write `reject: aborted — budget exceeded (…)`, and delivery-gate failures write `reject: Δ_in=…, Δ_out=…`. All are counted toward the ceiling. Promotion notes are `promote: …` and break the streak.

---

## 4. Gate Stages

Healing passes through two sequential gates. The plan-gate runs first and is cheap; the delivery-gate is the real safety net and is expensive.

### Stage 1 — Plan-gate (`planGateCandidate`) — **fails open**

A cost-saving pre-filter that rejects obviously-bad candidates before the expensive replay. Implemented in `planGateCandidate(skill, candidate, issue, judge?)`.

**Deterministic checks (always run, blocking — no LLM):**

| Check | Condition | Reject reason |
|---|---|---|
| No-op | `candidate.trim() === skill.system_prompt.trim()` | `no-op (identical to current)` |
| Too short | `candidate.trim().length < 50` | `too short (<50 chars)` |
| Degenerate | starts with apology/refusal, or is a single-line stub <80 chars | `degenerate (apology/truncated)` |

**Optional council judge (flag `HEAL_GATE_PLAN_JUDGE`, default on):**

When `config.HEAL_GATE_PLAN_JUDGE` is `true`, `healSkill` passes `makeDefaultPlanJudge(chatId)` as the `judge` argument. This issues a single `ClaudeProvider` call asking whether the candidate plausibly addresses `issue` without breaking the skill's stated purpose. One call vs. the 40–80 of the delivery gate.

**Fail-open on judge error:** If the council judge throws, the plan-gate logs a debug message and proceeds (`pass: true`). The plan-gate is a cost optimization, not the safety net — a flaky judge must never block a heal.

**On plan-gate reject:** `healSkill` calls `recordHealRevision` with a `reject: plan-gate (…)` note, logs at `info` level, and returns `{ patched: false }`. The expensive delivery-gate replay is skipped entirely. The rejection counts toward `MAX_CONSECUTIVE_REJECTS`.

### Stage 2 — Delivery-gate (`gateHealCandidate`) — **fails closed**

The non-regression replay gate. Runs only if the plan-gate passes.

**Mechanism:**
1. Load all `skill_eval_cases` for the skill.
2. Capture `deadline = now() + HEAL_GATE.BUDGET_MS` (default 60 000 ms).
3. Score four batches in order: current prompt on `held_in`, current on `held_out`, candidate on `held_in`, candidate on `held_out`. Check `now() > deadline` before each batch.
4. Apply `evaluateHealAcceptance` to the four score arrays.
5. If the rule passes: update `skills.system_prompt`, write a `promote: …` revision note.
6. If the rule fails or budget is breached: write a `reject: …` revision note, leave the live prompt untouched.

**Budget breach (fail-closed):** If `now() > deadline` before any batch, that batch returns `null` and the gate aborts. The abort is treated as a reject — it writes a `reject: aborted — budget exceeded (…ms)` note, counts toward `MAX_CONSECUTIVE_REJECTS`, and never promotes on partial evidence. The fail-closed stance is intentional: uncertainty → reject.

---

## 5. Acceptance Rule

### Formula

A candidate is promoted if and only if:

```
Δ_in ≥ 0  ∧  Δ_out ≥ 0  ∧  max(Δ_in, Δ_out) > 0
```

Where `Δ_in = mean(candidate_held_in_scores) − mean(current_held_in_scores)` and `Δ_out` is the equivalent for `held_out`. Implemented in `evaluateHealAcceptance` / `splitDelta`.

**Empty split rule:** If either side of a split (current or candidate) has zero cases, `splitDelta` returns 0. An empty split contributes Δ = 0 — it can neither block nor justify a promotion. An all-zero split means the rule collapses to `max(0, 0) > 0`, which is `false`, so a heal with only one populated split (and the other empty on both sides) cannot be promoted.

### Truth Table

| Δ_in | Δ_out | max(Δ_in, Δ_out) > 0 | Verdict |
|---|---|---|---|
| > 0 | > 0 | true | **promote** |
| > 0 | = 0 | true | **promote** |
| = 0 | > 0 | true | **promote** |
| = 0 | = 0 | false | reject |
| < 0 | any | — | reject (Δ_in < 0 fails) |
| any | < 0 | — | reject (Δ_out < 0 fails) |
| > 0 | < 0 | — | reject (Δ_out < 0 fails) |
| < 0 | > 0 | — | reject (Δ_in < 0 fails) |

The rule implements the Self-Harness non-regression property (paper 2606.09498): the candidate must not regress either split and must improve at least one.

---

## 6. Outcomes & Persistence

Every heal attempt — regardless of outcome — writes one row to `skill_revisions` via `recordHealRevision`. No attempt is lost from the audit trail.

| Outcome | `skills.system_prompt` | `skill_revisions.revision_note` prefix | Counts toward ceiling? |
|---|---|---|---|
| **Promote** | Updated to candidate | `promote: Δ_in=…, Δ_out=…` | No (breaks streak) |
| **Reject** (delivery gate) | Unchanged (rollback-by-default) | `reject: Δ_in=…, Δ_out=…` | Yes |
| **Plan-gate reject** | Unchanged | `reject: plan-gate (…)` | Yes |
| **Budget abort** | Unchanged | `reject: aborted — budget exceeded (…ms)` | Yes |
| **No eval cases** | Unchanged | — (no revision written; heal skipped before gates) | No |
| **Ceiling reached** | Unchanged | — (no revision written; heal paused before draft) | N/A |

**Rollback-by-default:** A rejected candidate is never written to the live `skills.system_prompt`. The previous prompt remains active. There is no rollback step because nothing was changed.

**Promote persistence:** On promotion, `gateHealCandidate` issues `UPDATE skills SET system_prompt = candidatePrompt, updated_at = now()` before writing the revision note.

---

## 7. Tunables

### `HEAL_GATE` constants (source: `src/auto-skills.ts`)

| Key | Value | Meaning |
|---|---|---|
| `MAX_CONSECUTIVE_REJECTS` | `3` | Consecutive gate rejections before heal pauses for manual review. |
| `MAX_EVAL_CASES_PER_SPLIT` | `10` | Replay cases retained per split per skill (FIFO eviction). |
| `MIN_QUALITY_SCORE` | `70` | Minimum self-monitor score to capture a use as an eval case, and to trigger a heal. |
| `BUDGET_MS` | `60000` | Wall-clock ceiling (ms) for one delivery-gate replay; breach → fail-closed reject. |

These are exported as `HEAL_GATE` and also individually re-exported (`MAX_EVAL_CASES_PER_SPLIT`, `MAX_CONSECUTIVE_HEAL_REJECTS`) for backwards compatibility. The `HEAL_GATE` object is the single authoritative source; callers should prefer it. `tests/heal-gate-contract.test.ts` pins every value — a value change in source breaks the contract test immediately.

### Environment flags (source: `src/config.ts`)

| Flag | Default | Effect when `false` |
|---|---|---|
| `HEAL_GATE_GRADER` | `true` (on) | Delivery-gate scorer uses self-monitor floor only; no `ClaudeProvider` judge call. Zero LLM cost for grading. |
| `HEAL_GATE_PLAN_JUDGE` | `true` (on) | Plan-gate skips the council judge; only deterministic checks run. Zero LLM cost for plan-gate. |

Both flags default on (`!== 'false'`). Setting either to `false` in `.env` degrades gracefully — the gate still operates on its remaining signals (self-monitor floor for the grader; deterministic checks for the plan-gate). Neither flag bypasses the delivery-gate replay or the acceptance rule.

---

## 8. Invariants

The following properties are guaranteed by the implementation and must hold across all future changes:

1. **Fail-safe to reject on uncertainty.** Every ambiguous or error case — budget breach, judge error in the delivery gate, empty case set detected after gate entry — resolves to reject, never promote. The only path to promotion is a clean, on-budget replay that satisfies the acceptance rule.

2. **Never promote without eval evidence.** If `evalCases.length === 0` at entry to `gateHealCandidate`, the gate returns a reject with `reason: 'reject: no eval cases — heal cannot be verified (ungated)'`. An ungated promotion is structurally impossible.

3. **Every attempt is logged.** `recordHealRevision` is called on every gate exit: delivery-gate promote, delivery-gate reject, budget abort, and plan-gate reject. The only cases that do not write a revision are pre-gate skips (no eval cases) and ceiling pauses — neither of which constitutes an attempt. The `skill_revisions` table is therefore a complete audit trail of all gate decisions.

4. **The judge is a different model family than generation.** Response generation inside `makeDefaultScorer` goes through `router.sendMessage` (which routes to the local qwen3.5 model by default). Both the delivery-gate judge and the plan-gate council judge use `ClaudeProvider` directly, bypassing the router. This cross-family separation ensures the judge cannot be the same model that produced the response it is grading — preventing a model from ratifying its own output.

5. **Reject notes are `reject`-prefixed.** All rejection paths write a `revision_note` that begins with `reject` (lowercase). This is required for `countConsecutiveHealRejections` (which uses `/^reject/i`) to correctly detect and count them toward `MAX_CONSECUTIVE_REJECTS`. New reject paths added in future must follow this convention.

---

## 9. Conformance

Each clause of this contract is covered by at least one automated test. The mapping below is authoritative — if a test is removed or renamed, the corresponding contract clause loses its enforcement.

| Contract clause | Test file | What is tested |
|---|---|---|
| `HEAL_GATE` values match this document | `tests/heal-gate-contract.test.ts` | Asserts each constant in `HEAL_GATE` equals the value documented in §7. A value change in source fails immediately. |
| Acceptance rule + truth table (§5) | `tests/skill-heal-gate.test.ts` | Exercises `evaluateHealAcceptance` across all truth-table rows: promote cases, reject cases (regression, both-zero, cross-sign). |
| Budget cap → fail-closed abort (§4 Stage 2) | `tests/heal-gate-budget.test.ts` | Injects a mock `now()` that crosses the deadline; asserts the gate returns `promote: false` with `aborted` reason and writes a `reject`-prefixed revision note. |
| Plan-gate checks + cross-family judge (§4 Stage 1) | `tests/heal-plan-gate.test.ts` | Tests no-op, too-short, degenerate checks; verifies the council judge uses `ClaudeProvider` (not the router); verifies judge failure fails open. |
| `healSkill` wiring (plan-gate before delivery-gate) | `tests/heal-plan-gate-wiring.test.ts` | Stubs `planGateCandidate` to reject and asserts the delivery-gate scorer is never called; then stubs it to pass and asserts the scorer is called. |
| Promote/reject persistence, coverage guard, reject ceiling (§3, §6) | `tests/skill-heal-apply.test.ts` | Exercises full `healSkill` flow: promote writes `system_prompt`; reject leaves it unchanged; no-cases guard skips; ceiling pauses at `MAX_CONSECUTIVE_REJECTS`. |
