# Self-Healing Effectiveness — Evaluation Plan & Evidence Log

**Decision date:** 2026-06-26
**Scheduled review:** ~2026-09-26 (3 months) — or earlier if the trigger thresholds below are met.
**Status:** OPEN — gathering evidence, no action.

## The decision

Leave skill self-heal **drafting on the local qwen3.5 model**. Do **not** route
heal drafting to Claude (`claude -p`) yet. Gather evidence from production logs
first, then decide whether Luna's self-improvement loop is (a) actually valuable
in real use and (b) bottlenecked by local-model drafting quality.

This is a deferred, reversible call — not a conclusion that self-healing is or
isn't worth it.

## Why we're waiting (rationale)

- **Asymmetry favors waiting.** Leaving it as-is costs only *missed upside*
  (skills don't auto-improve); it never *harms* — the non-regression gates reject
  bad candidates, so nothing degrades. Acting now spends a standing resource on
  an unproven payoff.
- **We're at N≈1.** One auto-skill, a handful of heal attempts. Not enough to
  know if self-improvement matters for Luna's real traffic, let alone whether
  drafting quality is the limiter.
- **"Make candidates pass the gates" is the wrong goal.** The aim is *real* skill
  improvement. If qwen3.5 candidates fail, that may be the gate correctly saying
  "these aren't improvements." A better drafter only helps if genuine
  improvements are being missed.
- **Cost is capacity, not tokens.** `claude -p` runs on the Anthropic
  *subscription* (fixed fee, no per-token cost), and Claude is *already* in every
  heal as the plan-gate + delivery-gate judge. Routing drafting to Claude too
  would be **incremental**, but it draws **shared subscription capacity** that
  real user conversations need. That is the real cost to avoid spending blind.

## What to measure (instrumentation already exists)

Every heal attempt is logged in the `skill_revisions` table with a structured
"why" note (heal-gate contract §6/A3). The reject *reason* prefix tells us which
world we're in — no new instrumentation needed.

Run these at review time against the live DB (`store/luna.db`):

```sql
-- 1. How many heal-eligible (auto-) skills exist now?
SELECT COUNT(*) AS auto_skills FROM skills WHERE id LIKE 'auto-%';

-- 2. Every heal attempt for auto- skills, newest first.
SELECT id, skill_id, revision_note, created_at
FROM skill_revisions
WHERE skill_id LIKE 'auto-%'
ORDER BY id DESC;

-- 3. Outcome mix: promotions vs reject reasons.
--    Promotions have a non-'reject', non-'Auto-generated' note.
SELECT
  CASE
    WHEN revision_note LIKE 'reject: aborted%budget%' THEN 'reject:budget'
    WHEN revision_note LIKE 'reject: plan-gate%'      THEN 'reject:plan-gate(implausible)'
    WHEN revision_note LIKE 'reject:%=0%'             THEN 'reject:no-improvement(Δ=0)'
    WHEN revision_note LIKE 'reject:%'                THEN 'reject:other'
    WHEN revision_note LIKE 'Auto-generated%'         THEN 'base'
    WHEN revision_note LIKE 'Auto-imported%'          THEN 'imported'
    ELSE 'promote'
  END AS outcome,
  COUNT(*) AS n
FROM skill_revisions
WHERE skill_id LIKE 'auto-%'
GROUP BY outcome ORDER BY n DESC;
```

Also worth a glance: `grep -iE "heal|gate|paused|budget" ` over `docker logs
luna-bot` for frequency of correction-/quality-triggered heals in real chats.

## How to interpret — the decision criterion

Classify the reject mix from query 3:

- **Mostly `reject:no-improvement(Δ=0)` or `reject:plan-gate(implausible)`** →
  qwen3.5 had nothing real to improve, or the corrections aren't
  improvement-shaped. **Claude drafting will NOT help.** Keep local; question
  whether the self-heal path earns its keep at all.
- **Mostly `reject:budget` or "plausible candidate, poorly drafted"** → drafting
  quality / local-model speed is the bottleneck. **Then** routing drafting to
  Claude is justified — implement it as a **config flag defaulting to local**
  (mirror `HEAL_GATE_GRADER`) or a **fallback** (Claude drafts only after N local
  failures), so the capacity draw stays bounded, never standing.
- **Any promotions at all** → self-improvement is working on the free path;
  strongly prefer leaving it local.

## Review trigger

Revisit when **either**:
- the calendar reaches **~2026-09-26**, OR
- **both** of: ≥5 real auto-skills exist AND ≥~12 genuine heal attempts from real
  user corrections/low-quality events have accumulated (query 1 + query 2).

## Baseline snapshot — 2026-06-26 (rc.119)

- **Auto-skills:** 1 — `auto-system-time-nodejs-version` (the rc.116 demo skill;
  kept as a real usable skill). Skills 1–6 in the table are pack/forge *imports*,
  not heal-eligible (`shouldHealSkill` only heals `auto-` ids).
- **Heal attempts on the auto- skill (current audit trail):**
  - id 7 — base (`Auto-generated from workflow`)
  - id 11 — `reject: aborted — budget exceeded (300000ms)` (correction smoke, 2026-06-25)
  - id 12 — `reject: aborted — budget exceeded (300000ms)` (rc.119 live re-smoke heal, completed in background)
- **Consecutive rejects at head:** 2 (ceiling = 3 → not yet paused).
- **Caveat — audit trail was reset:** on 2026-06-25 the reject revisions ids 8,9,10
  for this skill were **deleted** (a deliberate, user-approved reset to re-run the
  smoke after rc.118). Those 3 (a delivery-gate Δ=0 no-op, a pre-rc.118 60s budget
  abort, a plan-gate implausible-fix) are gone from the table. So pre-2026-06-25
  attempt history for this skill is incomplete — count real attempts from id 11
  onward.
- **Early signal (not yet conclusive):** both post-fix heals (id 11, id 12)
  aborted on the **5-min replay budget** — i.e. the local qwen3.5 replay is too
  slow to finish even at `BUDGET_MS=300000` for this skill. This points toward a
  *replay-time / local-model-speed* limit, which is adjacent to (but not the same
  as) drafting quality. One skill, two data points — keep watching before drawing
  conclusions.

## Evidence log (append observations over time — newest first)

<!-- date | what was observed (queries 1-3 results, notable heal events, real-usage frequency) | running interpretation -->

- _2026-06-26_ — Decision recorded. Baseline as above: 1 auto-skill, 2 post-rc.119
  heal attempts, both budget-aborts. No promotions yet. Too early to judge. Next:
  let real use accumulate; re-query at the review trigger.

## Related

- `reference/heal-gate-contract.md` — the gate this evaluates (esp. §7 tunables,
  §8 invariants, §8.6 non-blocking).
- `reference/loop-guards-checklist.md` — guard vocabulary.
- The rc.116→rc.119 self-modifying-harness arc (PRs #6, #7, #9, #10).
