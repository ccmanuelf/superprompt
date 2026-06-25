# Reusable Agent-Loop Guard Checklist

A generic audit for any repeatable agent loop in Luna — the skill self-healing
loop, the Ollama agentic loop, future scheduled tasks, or any pattern where an
LLM acts iteratively on feedback until a condition is met.

For each loop, run through the six guards below and fill in the worked-example
table at the end of this file as a model.

---

## The Six Guards

### 1. Iteration Cap

**What it is.** A hard numeric ceiling on the number of loop turns. The loop
exits (or the task aborts) when the counter reaches the cap, regardless of
whether the goal was met.

**Why it matters.** Without a cap, a stuck or confused model burns compute and
wall-clock time indefinitely. A small model that spirals for ten iterations does
more damage than a two-billion-parameter model completing in two. Tier-based
caps (smaller model → tighter cap) scale the safety net to the risk surface.

**How to verify.**
- Locate the loop condition and confirm there is a variable or constant that
  limits iterations (e.g., `while (iterations < tier.maxIterations)`).
- Confirm the counter is incremented unconditionally inside the loop body, not
  only on success paths.
- Write a test that drives the loop to exhaustion and asserts the correct
  termination message or return value.

---

### 2. Revision / Reject Limit

**What it is.** A ceiling on the number of consecutive failed attempts (rejected
candidates, failed tool calls, rejected revisions) before the loop pauses and
surfaces a human-review signal rather than retrying indefinitely.

**Why it matters.** Iteration caps bound a single run. Reject limits bound
repeated re-entry into the loop across multiple invocations. A skill that is
healed, fails gate, is re-healed, fails again, and so on without limit wastes
compute and degrades the skill's revision log with noise. The ceiling enforces a
"stop, a human should look at this" invariant.

**How to verify.**
- Confirm a named constant defines the limit (e.g., `MAX_CONSECUTIVE_REJECTS`).
- Confirm there is a query/function that counts consecutive failures from the
  revision log and that the loop checks it before each re-entry (not only at
  the end).
- Confirm the check fires before an expensive LLM call, not after.

---

### 3. No-Progress Detection

**What it is.** A rule that stops the loop when successive attempts stop
improving the measured outcome. "No improvement" is defined formally: the
candidate must not regress any held split and must improve at least one
(`Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0`).

**Why it matters.** A loop can satisfy the iteration cap and the reject limit
yet still be stuck: each attempt scores the same as the last. Without a
progress rule, the system promotes a sideways move (same score) and then heals
again on the next failure, cycling forever at the same quality level. The
`max(Δ) > 0` requirement ensures at least one split actually improved.

**How to verify.**
- Locate the acceptance function and confirm both "no regression" (both deltas
  ≥ 0) and "at least one improvement" (max > 0) are enforced as a conjunction.
- Confirm a tied result (both deltas = 0) yields a rejection, not a promotion.
- Check what happens when one split is empty: it should contribute Δ = 0 (no
  block, no justification), not be ignored entirely.

---

### 4. Budget / Wall-Clock Cap

**What it is.** A maximum elapsed-time (or cost) allowance for one loop
execution. If the deadline is exceeded mid-run, the loop aborts fail-closed: it
returns a rejection, not a promotion on partial evidence.

**Why it matters.** Replay-heavy verification steps (re-scoring held cases
under a new prompt) can take tens of seconds per case. Without a deadline, a
large eval set or a slow model can hold a message thread open for minutes or
exceed per-turn latency SLOs. Fail-closed on breach is critical: partial
evidence (e.g., only held-in cases scored, held-out skipped) must not be
treated as a pass.

**How to verify.**
- Locate the deadline calculation (`now() + budgetMs`).
- Confirm the overBudget check runs before each expensive batch, not only at
  the start.
- Confirm a breach returns a structured rejection (not a partial result) and
  that the rejection counts toward the reject limit.
- Write a test that injects a synthetic `now()` that jumps past the deadline
  after the first batch and asserts the gate returns `promote: false`.

---

### 5. Plan-Gate (Cheap Pre-Filter)

**What it is.** A fast, cheap check that rejects obviously-bad candidates
before the expensive verification step (replay scoring, full eval suite,
model-in-the-loop judge). Deterministic checks (no-op, too-short, degenerate
rewrite) always run; an optional LLM council check runs gated by config.

**Why it matters.** Expensive verification (re-scoring n eval cases with an LLM
judge) costs latency and compute. If the candidate is identical to the current
prompt, shorter than 50 characters, or an apology ("sorry, I can't do that"),
there is no value in running the full gate. The plan-gate filters these at
near-zero cost, so the expensive gate only runs on plausible candidates.
The optional LLM judge fails open — it must never block a heal when the judge
is flaky, because the delivery gate is the real safety net.

**How to verify.**
- Confirm all deterministic checks (identity, length, degenerate-text) run
  synchronously, without any LLM call.
- Confirm the optional judge is gated by a config flag and that a judge error
  (network failure, timeout) results in a pass-through, not a block.
- Confirm plan-gate rejections are logged and recorded in the revision log so
  they count toward the reject limit.

---

### 6. Independent Cross-Family Judge

**What it is.** The verification step uses a model from a different family than
the model being evaluated. The generator (local Ollama / qwen3.5) produces the
candidate; the judge (Claude, via `ClaudeProvider`) scores it. The generator
cannot grade its own output.

**Why it matters.** A model grades its own output favorably even when that
output is wrong. Self-judgment inflates scores and defeats the purpose of
independent verification. Cross-family judgment (different weights, different
training, different provider) provides a genuine second opinion. It also
separates failure modes: if the generator is broken in a systematic way, the
judge is unlikely to share the same blind spot.

**How to verify.**
- Confirm the scorer's generation call goes through the router (which selects
  the local model) while the judge call explicitly instantiates the remote
  provider (`new ClaudeProvider()`).
- Confirm there is no code path where the same provider instance handles both
  generation and judgment for the same candidate.
- Confirm the judge is gated by config (`HEAL_GATE_GRADER`) and fails gracefully
  (falls back to self-monitor score) rather than crashing when the remote
  provider is unavailable.

---

## Worked Example: the Skill Self-Healing Loop

Luna's skill self-healing loop (`healSkill` in `src/auto-skills.ts`) is a
single-shot heal-draft-then-gate pattern: one Ollama call generates a candidate
prompt, the plan-gate pre-filters it, and the delivery gate (`gateHealCandidate`)
replays held eval cases under both the current and candidate prompts to decide
whether to promote. "Single-shot" means one candidate per invocation; the
iteration concept applies at the outer re-entry level (how many times `healSkill`
is called for the same skill), not inside a single call.

| Guard | Status | Evidence |
|---|---|---|
| Iteration cap | n/a (outer) / ✅ (Ollama loop) | Heal is single-shot per invocation — no inner loop to cap. The Ollama agentic loop (which generates the candidate) is capped by `resolveModelTier` / `tier.maxIterations` at `src/providers/ollama.ts:56–64` (4 / 6 / 10 iters by model size) and enforced at `ollama.ts:482`. |
| Revision / reject limit | ✅ | `HEAL_GATE.MAX_CONSECUTIVE_REJECTS = 3` (`auto-skills.ts:57`); `countConsecutiveHealRejections` (`auto-skills.ts:765`) scans the revision log; `healSkill` checks the count before drafting a candidate (`auto-skills.ts:918–925`). |
| No-progress detection | ✅ | `evaluateHealAcceptance` (`auto-skills.ts:668`) enforces `Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0` (`auto-skills.ts:671`). A tied result (both deltas = 0) is a reject. Empty splits contribute Δ = 0 and cannot justify promotion. A skill whose candidates keep losing is paused by the reject limit (guard 2). |
| Budget / wall-clock cap | ✅ | `HEAL_GATE.BUDGET_MS = 60_000` (`auto-skills.ts:63`); deadline set at `gateHealCandidate` entry (`auto-skills.ts:719`); `overBudget()` checked before each scoring batch (`auto-skills.ts:734–744`); breach returns `promote: false` fail-closed and the rejection counts toward the stop ceiling. |
| Plan-gate (cheap pre-filter) | ✅ | `planGateCandidate` (`auto-skills.ts:855`) runs deterministic checks (identity, length < 50, degenerate text) synchronously; optional Claude council judge gated by `HEAL_GATE_PLAN_JUDGE` config (`auto-skills.ts:958`), fails open on error (`auto-skills.ts:869`). Rejections recorded in revision log. |
| Cross-family judge | ✅ | `makeDefaultScorer` (`auto-skills.ts:809`): generation via `router.sendMessage` (routes to local qwen3.5); judgment via `new ClaudeProvider()` (`auto-skills.ts:810`). `makeDefaultPlanJudge` (`auto-skills.ts:882`) uses `new ClaudeProvider()` (`auto-skills.ts:883`) for plan-gate council check. Both judges are gated and fail gracefully. |

### Contract references

The full set of invariants, tunables, and conformance rules for the heal gate
are in `reference/heal-gate-contract.md`.
