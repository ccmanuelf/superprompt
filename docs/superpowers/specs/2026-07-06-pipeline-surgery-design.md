# Pipeline Surgery — Local-Path Prompt Slimming + Hybrid Router

**Date:** 2026-07-06
**Status:** Approved design (brainstormed with user; all sections signed off)
**Scope decision:** one spec, two sequenced phases. Phase 2 activates only after Phase 1's benchmark gate passes.

## Problem

Luna's context builder ships ~27k-token prompts to Ollama every turn (measured on prod:
`truncating input prompt limit=4099 prompt=27480`). At the M1's ~193 tok/s prompt-eval
that is ~2.3 min per agentic iteration; one tool turn measured ~7 min. This forced the
interim `AI_PROVIDER=claude` cutover, which also routes NovaLink prod-data reasoning
through Anthropic — the governance gap this work closes.

Measured composition of a local tool turn today:

| Block | Size | Notes |
|---|---|---|
| Tool schemas | ~48 JSON schemas | 33 builtin + 15 mfg pack; no filtering (`tool-registry.ts:65-69` filters by name only) |
| Static system prose | ~4,300–5,000 tok | persona ~720 (incl. redundant 50-name tool dump, `ollama.ts:73`) + QUALITY_RULES ~1,077 + doc-schema block ~853 (sent even when no document asked) + COMMAND_LIST ~580 + kanban ~324 + capabilities ~600-1,000 |
| Memory context | ≤1,500 tok | already capped (`memory.ts:60`); injected into user message |
| History | ≤40 messages | `MAX_HISTORY_MESSAGES`, oldest shifted |

Volatile blocks (uploads manifest, mfg hint, language override…) are interleaved
mid-prompt (`router.ts:1011-1012`), so the KV-cacheable shared prefix across turns is
short. All of it is re-sent on each of up to 10 agentic iterations.

## Success criteria

- **Gate:** warm same-bucket local turn **< 30s** on ministral-3:3b on the .244 box
  (benchmark script below; today 60-90s+).
- Live Claude path **byte-identical** throughout (snapshot-tested, not promised).
- After Phase 2 flip: NovaLink/manufacturing-data turns answered on-LAN, soft fallback
  to Claude with user-visible disclosure on local failure.

## Constraints (user decisions)

1. **Claude freeze:** all slimming applies to the Ollama branch only. Shared prompt
   blocks get an Ollama-specific variant where they diverge; the Claude branch's
   composed prompt must not change by a byte.
2. **Governance is soft:** local-first for NovaLink data; on failure, retry via Claude
   with a bilingual disclosure prefix. Availability beats hard governance.
3. Existing prod env stays: OLLAMA_THINK=false, KEEP_ALIVE=30m, NUM_CTX=32768,
   ministral-3:3b primary (qwen3.5:4b pulled as alternate).
4. Local path serves zero traffic until the deliberate cutover, so all of this is safe
   to merge dormant.

## Phase 0 — KV-reuse benchmark spike (day one, before any refactor)

`scripts/bench-local-pipeline.mjs`, run on the .244 box over SSH:

- Measure `prompt_eval_count` / `prompt_eval_duration` for (a) byte-identical prefix +
  growing tail vs (b) mutated prefix — proves whether Ollama's KV prefix reuse engages
  under our request shape (`/api/chat`, native `tools` array, num_ctx 32768).
- Measure real per-schema token cost through the model's chat template.
- Record cold turn, warm turn, bucket-switch turn, multi-iteration agentic turn.

Findings committed to `reference/` (they calibrate bucket sizes and set the pre-surgery
baseline). If prefix reuse does NOT engage, Approach A still wins on raw token cut
(~48→15-20 schemas + ~3k prose removed), but bucket-switch hysteresis matters less —
the spike tells us where to spend effort.

## Phase 1 — Slim local assembly

### New unit: `src/providers/local-prompt.ts` (LocalPromptAssembler)

Owned by the Ollama branch; the router's Ollama branch calls it instead of the inline
concatenation at `router.ts:1010`. The Claude branch keeps the existing builder.

**Contract:**
input `{chatId, bucketId, skillPrompt, volatiles {uploadsManifest, mfgHint, deliverableReminder, simulationScaffolding, languageOverride, voiceHint}, history, userTextWithMemory}`
→ output `{system, tools, messages}`.

**Strict three-layer ordering:**

1. **Frozen prefix** (identical bytes across every turn of a conversation): slim Ollama
   persona (~400 tok; the 50-name tool dump is deleted — it duplicates the native
   `tools` array), condensed Ollama variants of quality rules + command list (target
   ~500 tok combined vs ~1,650 today), capabilities summary. Static per process
   lifetime.
2. **Bucket layer:** the intent bucket's tool schemas (native `tools` param — the chat
   template renders these near the prompt head, so set-stability preserves the
   cacheable prefix) + bucket-specific prose. Doc-schema block (~853 tok) ships only in
   the `docs` bucket. Kanban tools are core, so the (condensed) kanban prose lives in
   the frozen prefix, not a bucket.
3. **Volatile tail:** all per-turn blocks move to the END of the system prompt. Memory
   stays prepended to the user message (already at the tail). Nothing volatile ever
   sits above static content.

### Tool buckets (Approach A: core + one intent bucket per turn)

Defined declaratively from existing registry metadata (`packName`, `scopes`) plus one
explicit map:

| Bucket | Contents | ~Count |
|---|---|---|
| `core` (always on) | memory ops, web search, kanban basics, time/misc | 10-12 |
| `docs` | parse_file, read_file, generate_document + parser tools | ~5 |
| `manufacturing` | 15-tool mfg pack + 3 novalink tools | 18 |
| `simulation` | simulation tools | 6 |

Per turn: core + one bucket ⇒ ~15-20 schemas instead of 48.

**Selector:** the router's existing regexes (`OLLAMA_TOOL_PATTERNS`,
`classifyDeliverableIntent`, mfg patterns) mapped to bucket IDs, with **hysteresis** —
a conversation stays in its bucket until a different bucket matches explicitly. New
conversations start in `core`. No new classifier.

**Mid-loop tool miss:** if the model calls a registered-but-unsent tool, the assembler
swaps in that tool's bucket, logs at `info` (signal for bucket-definition drift), and
continues the loop — one deliberate re-eval instead of a failed turn. Unknown tools
keep today's error behavior.

### Budget backstop

Wire the dormant `context-budget.ts` (`trimToBudget`) as the final gate: target input
≤ ~10-12k tokens. Overflow trims history oldest-first, logs what was dropped; never
trims the frozen prefix or bucket schemas. Pathological overflow proceeds (Ollama
truncates, as today) but logged instead of silent.

## Phase 2 — Hybrid router

- **New first-priority class `novalink-data`** in `classifyMessage()`: EN+ES regexes
  (company/BOM/shortage/PO/production-hub vocabulary, novalink tool names) plus the
  Phase 1 manufacturing-bucket signal. A match pins the turn to the LOCAL provider
  regardless of length or Claude patterns. All other classes keep today's heuristics.
- **Pinning overrides stickiness:** `getProviderForChat()`'s no-downgrade rule
  (`router.ts:849-853`) yields to governance pinning. Cross-provider history handoff
  uses the existing chat_log re-seeding (`router.ts:30-77`) — no new plumbing.
- **Soft fallback with disclosure:** on local failure (unreachable, timeout, circuit
  breaker open, agentic loop death) retry the same turn via Claude; prefix the reply
  with a bilingual notice ("⚠️ answered via cloud fallback — local AI unavailable /
  respondido vía nube — IA local no disponible"). Log at `warn` with the failure
  reason so silent drift to cloud is visible.
- **Config gating:**
  - `AI_PROVIDER=claude` + `AUTO_ROUTE=false` — today's prod state; merging this code
    changes nothing.
  - `AUTO_ROUTE=true` — re-enables heuristic routing including pinning.
  - `NOVALINK_PIN_LOCAL` (new; default true when AUTO_ROUTE on) — kill switch for just
    the pinning.

## Error handling

- Selector miss → stay in current bucket (recoverable via mid-loop swap; wrong bucket
  degrades to one re-eval, never a failed turn).
- Every new failure path logs and continues (Code Convention #6); nothing in the
  assembler or selector can crash a turn.
- Fallback events and budget trims are logged with reasons — observability over
  silence.

## Testing

- **Unit:** bucket selection (EN+ES fixtures, hysteresis, miss→stay); assembler layer
  ordering with a **byte-stability snapshot test** (two consecutive same-bucket turns →
  identical prefix bytes) — the regression guard for the KV strategy; budget trimming
  order; router pinning-over-stickiness; fallback disclosure prefix.
- **Claude-freeze proof:** snapshot test asserting the Claude branch's composed system
  prompt is byte-identical before/after the refactor.
- **Repo workflow:** `npx tsc --noEmit`, `npm run lint` (0 errors, no new `any`
  warnings), `npx vitest run`, `npm run build && npm run smoke`, Docker rebuild.
- **Live benchmark:** `scripts/bench-local-pipeline.mjs` on the .244 box — cold, warm
  same-bucket, bucket-switch, 6-iteration agentic — pre vs post. **Gate: warm
  same-bucket < 30s on ministral-3:3b.**
- **End-to-end:** real Telegram exchange on the dev stack's local path (poller disabled
  or test bot token — never double-poll prod) before claiming done.

## Rollout

1. Phase 0 spike → findings to `reference/`.
2. Phase 1 PR(s): assembler + buckets + prose diet + budget. Auto-merge on green CI
   (standing rule). rc bump per ship.
3. Benchmark on .244. If gate fails: decision point (qwen3.5:4b? smaller buckets?
   higher threshold?) — not a silent grind.
4. Phase 2 PR: router pinning + fallback (dormant behind `AUTO_ROUTE=false`; safe to
   auto-merge).
5. **User flips `AUTO_ROUTE=true` on prod** — deliberate, user-confirmed final step;
   explicitly outside the auto-merge rule.

## Out of scope

- Model swaps (spike data may motivate qwen3.5:4b later; separate decision).
- Any change to the Claude path's prompt content.
- Semantic/embedding tool selection (rejected as Approach B: busts KV cache per turn,
  can starve the agentic loop).
- Heal-loop / self-improvement work (`reference/heal-self-improvement-evaluation.md`
  stays on its own track, review ~2026-09-26).
