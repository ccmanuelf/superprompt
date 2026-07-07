# KV-reuse spike — Phase 0 (pipeline surgery)

> **SUPERSEDED by Task 7d** (see bottom of file): the "KV prefix reuse does
> NOT engage" verdict below rests on a metric misread (`prompt_eval_count`
> doesn't change on a cache hit — it's not a valid signal). Corrected verdict:
> reuse DOES engage.

**Date:** 2026-07-06
**Script:** `scripts/bench-local-pipeline.mjs`
**Baseline host:** `192.168.2.244` (`Developers-MacBook-Pro.local`), model `ministral-3:3b`, Ollama at `http://127.0.0.1:11434`
**Mechanical-validation host:** dev Mac (this machine), model `qwen3.5:2b` (ministral-3:3b not pulled locally; brief's default model wasn't available, substituted for the mechanical check only — dev numbers are not the baseline)

## Dev validation run (mechanical check only — NOT the baseline)

```json
{"scenario":"cold_48_tools","prompt_eval_count":6837,"prompt_eval_ms":5837,"total_ms":17273}
{"scenario":"warm_same_prefix","prompt_eval_count":6852,"prompt_eval_ms":976,"total_ms":1216}
{"scenario":"warm_tool_set_changed","prompt_eval_count":6837,"prompt_eval_ms":5727,"total_ms":6104}
{"scenario":"warm_prefix_mutated","prompt_eval_count":6853,"prompt_eval_ms":5758,"total_ms":6022}
{"scenario":"cold_20_tools","prompt_eval_count":3902,"prompt_eval_ms":3258,"total_ms":3655}
```

## .244 baseline run (ministral-3:3b — the real data)

```json
{"scenario":"cold_48_tools","prompt_eval_count":5817,"prompt_eval_ms":34793,"total_ms":41205}
{"scenario":"warm_same_prefix","prompt_eval_count":5825,"prompt_eval_ms":27969,"total_ms":30142}
{"scenario":"warm_tool_set_changed","prompt_eval_count":5817,"prompt_eval_ms":752,"total_ms":2107}
{"scenario":"warm_prefix_mutated","prompt_eval_count":5833,"prompt_eval_ms":35072,"total_ms":37771}
{"scenario":"cold_20_tools","prompt_eval_count":3357,"prompt_eval_ms":9966,"total_ms":12347}
```

## Interpretation

1. **Decision metric per spec:** compare `warm_same_prefix.prompt_eval_count` (5825) to `cold_48_tools.prompt_eval_count` (5817) — these are roughly equal (within 0.1%), not a small fraction of each other.
2. **Verdict: KV prefix reuse does NOT engage** for this request shape (system prompt + 48 tool schemas via `/api/chat`, non-streaming, `keep_alive: 30m`). Ollama re-evaluates the full prompt token count on every call regardless of whether the system prefix and tool set are byte-identical to the previous turn.
3. Schema cost is real and linear-ish: 48 tools cost 5817 prompt tokens vs 3357 for 20 tools. **Tokens per tool: (5817 − 3357) / (48 − 20) = 2460 / 28 ≈ 88 tokens/tool** for this synthetic schema (dev run: ~105/tool with qwen3.5:2b). Trimming the tool set directly cuts prompt-eval token count.
4. `prompt_eval_ms` on .244 is noisy and does not track `prompt_eval_count` consistently (e.g. `warm_tool_set_changed` at 752ms vs `cold_48_tools` at 34793ms for near-identical token counts). This looks like Metal/llama.cpp warm-up or scheduling variance on Apple Silicon, not content-aware caching — the spec's own decision rule is based on `prompt_eval_count`, not `prompt_eval_ms`, and is not affected by this noise.
5. **Implication for later tasks (4/7):** since prefix reuse is not free, priority is *raw token reduction* (fewer/smaller tool schemas, shorter static prefix) rather than *prefix stability engineering* (keeping a byte-identical KV-cacheable prefix won't pay off on this stack).

## Caveats

The benchmark scenarios run sequentially against shared server state, so individual scenarios are not clean isolated A/B tests. The verdict rests on uniform non-engagement across all of them (no scenario showed KV cache activation).

## Phase 1 post-surgery benchmark (Task 7)

> **SUPERSEDED by Task 7d** (see bottom of file): the "KV reuse still does not
> engage" verdict and the resulting gate **FAIL** below both rest on the same
> `prompt_eval_count` misread. Corrected gate verdict: **PASS**.

**Date:** 2026-07-06
**Method:** throwaway scripts (`.superpowers/sdd/bench-pipe*.ts`, not committed) importing the REAL production modules — `registerBuiltinTools()` + manufacturing pack registration, `resolveLocalTurnConfig()`, `buildLocalSystemPrompt()`, and `OllamaProvider.sendMessage()` (agentic loop, `assembledSystemPrompt: true`, exactly as the router wires it) — driven against **.244's Ollama 0.31.1** via SSH tunnel (`127.0.0.1:11435 → 192.168.2.244:11434`). Model `ministral-3:3b`, `num_ctx` 32768, `think: false` (the model 400s on thinking). `prompt_eval_count` captured by intercepting the `/api/chat` responses in-process. No bot/poller was started; the prod luna-bot container was untouched.

### Numbers

| Turn | Bucket | Wall-clock | prompt_eval_count | Tool schemas | Sys-prompt est. tokens |
|------|--------|-----------:|------------------:|-------------:|-----------------------:|
| (a) cold manufacturing | manufacturing | 191.0s / 104.3s / 241.8s (3 runs) | 15,195 | 22 | 9,571 |
| (b) warm same-bucket | manufacturing | **650s (timeout)** / **140.6s** / **145.7s** (3 runs) | 15,443–15,688 | 22 | 9,571 |
| (c) bucket switch → docs | docs | 32.3s | 12,866 | 18 | 10,416 |
| (d) agentic tool turn (get_time) | core | 24.9s | 10,767 + 10,824 (2 iters) | 10 | 9,571 |

Turn (d) called `get_time` correctly and answered with the real time — the agentic path works end-to-end through the slimmed pipe.

### GATE: warm same-bucket turn < 30s → **FAIL**

Warm same-bucket measured 140.6s and 145.7s on two clean reruns; the first attempt stalled past the 600s provider timeout entirely (memory-pressure stall — the stall also killed the SSH tunnel). ~4.7–4.9× over the 30s target.

### Interpretation

1. **The token diet itself worked.** Composed system prompt is ~9.6–10.4k estimated tokens (vs ~27k pre-surgery) and 10–22 schemas per turn (vs 48). Total per-turn prompt is now ~15.2k actual tokens on the manufacturing bucket (schemas ≈ 245 real tokens each), roughly half the pre-surgery load.
2. **KV reuse still does not engage** (consistent with the Phase 0 verdict): warm-turn `prompt_eval_count` (15,443–15,688) ≈ cold (15,195). Every turn re-evaluates the full prompt.
3. **.244's prompt-eval throughput is the binding constraint.** At ~100–150 tok/s effective prompt eval on this host/model, a 15k-token prompt alone costs ~100–150s — the <30s gate is unreachable at this prompt size without either KV reuse engaging, a much smaller prompt (~3–4k tokens total), or a faster eval path. Only the leanest core-bucket turn (10.8k tokens, warm model) came in under 30s (24.9s, and that was TWO chat calls).
4. **Wall-clock variance is large** (cold: 104–242s across runs) and one warm turn stalled >600s — the 16 GB host runs the model (4.3 GB at 32k ctx) plus the Docker stack; memory is tight (≈6.2 GB wired with the model resident).

### Decision points for Phase 2 (per the task-7 brief: STOP and consult)

Options named in the brief: switch to qwen3.5:4b, smaller buckets (prompt closer to ~4k tokens), or change the threshold. Additional levers observed here: `num_ctx` reduction (32k KV allocation strains the host), and the model's verbose clarifying-question responses inflating decode time.

## Task 7b re-gate (capabilities diet + num_ctx 16384)

> **SUPERSEDED by Task 7d** (see bottom of file): the "KV-cache reuse still
> does not engage" verdict and the resulting gate **FAIL** (60.2s) below both
> rest on the same `prompt_eval_count` misread. Corrected gate verdict:
> **PASS** (5.7s), and the capabilities/schema diet in this section is
> real and still stands — it's the verdict interpretation that was wrong,
> not the measured token/wall-clock reductions themselves.

**Date:** 2026-07-06
**Change under test:** `buildLocalCapabilitiesPrompt()` (`src/capabilities.ts`) — a condensed, information-dense replacement for the ~5–8k-token verbatim `fullCapabilities` block, used ONLY in the Ollama arm's `buildLocalSystemPrompt()` input (`src/providers/router.ts`). The Claude arm's `fullCapabilities` composition is untouched (`composeClaudeSystemPrompt` — guarded by `tests/claude-prompt-freeze.test.ts`, still green and unmodified). Plus: `config.OLLAMA_NUM_CTX` forced to 16384 for the bench run (down from Task 7's 32768).
**Method:** same as Task 7 — throwaway script `.superpowers/sdd/bench-pipe-7b.ts` (not committed) imports the real production modules (`registerBuiltinTools()` + manufacturing pack registration, `loadAllPacks()` for real pack metadata, `resolveLocalTurnConfig()`, `buildLocalSystemPrompt()`, `OllamaProvider.sendMessage()` with `assembledSystemPrompt: true`), driven against **.244's Ollama 0.31.1** via SSH tunnel (`127.0.0.1:11435 → 192.168.2.244:11434`). Model `ministral-3:3b`, `think: false`. `prompt_eval_count` captured by intercepting `/api/chat` responses in-process. Only 3 turns per the amended brief (cold mfg / warm same-bucket mfg / core agentic) — the docs bucket-switch turn from Task 7 was dropped, it isn't part of the gate. No bot/poller started; prod `luna-bot` verified `Up 2 days (healthy)` before and after; SSH tunnel killed at the end (`pkill -f 'ssh -f -N -L 11435'`, confirmed down via curl).

**Note on `OLLAMA_NUM_CTX` and env vars:** `config.ts` reads `OLLAMA_NUM_CTX` from `readEnvFile()` (a custom `.env`-file reader), **not** `process.env` (Code Convention #2 — never pollute `process.env`). A shell-exported `OLLAMA_NUM_CTX=16384` before `npx tsx` does **nothing** to `config.OLLAMA_NUM_CTX`. The bench script sets `config.OLLAMA_NUM_CTX = 16384` directly on the imported config object (same pattern already used for `OLLAMA_HOST`/`OLLAMA_TOOL_MODEL`/`OLLAMA_THINK`). **For the prod flip, the correct mechanism is different: add `OLLAMA_NUM_CTX=16384` to .244's `.env` file** (not attempted here — prod `.env` was not touched, per the no-prod-changes constraint).

### Side finding fixed in this task: YAML folded-scalar bug

Building `buildLocalCapabilitiesPrompt()`'s dynamic pack-list section (one line per enabled pack, from the same `getLoadedPacks()` data `getAggregatedCapabilities()` reads) surfaced a pre-existing bug: `parsePackYaml()` in `src/packs.ts` only handled the YAML literal block scalar (`key: |`), not the folded block scalar (`key: >`). Three pack.yaml files (`manufacturing`, `client-acme`, `operations-hub`) use `description: >` — their parsed `description` came out as the literal string `">"`, silently dropping the rest of the block. This is already user-facing today via `/pack info <name>` on Telegram (`src/platforms/telegram.ts:3734`) and Matrix (`src/platforms/matrix.ts:1181`). Fixed `parsePackYaml()` to fold wrapped lines with a space (YAML folding semantics) and added a regression test (`tests/packs.test.ts` — "parses a folded block scalar (description: >) into joined prose, not the literal \">\"" ). Confirmed RED before the fix, GREEN after.

### Numbers — Task 7 vs Task 7b

| Turn | Task 7 (verbatim caps, num_ctx 32768) | Task 7b (condensed caps, num_ctx 16384) |
|------|---------------------------------------|-------------------------------------------|
| Sys-prompt est. tokens | 9,571 | **1,428** |
| (a) cold manufacturing — wall-clock | 191.0s / 104.3s / 241.8s (3 runs) | **66.8s** |
| (a) cold manufacturing — prompt_eval_count | 15,195 | **7,395** |
| (b) warm same-bucket — wall-clock | 650s (timeout) / 140.6s / 145.7s | **60.2s** |
| (b) warm same-bucket — prompt_eval_count | 15,443–15,688 | **7,592** |
| (c) agentic tool turn — wall-clock | 24.9s | **59.5s** |
| (c) agentic tool turn — prompt_eval_count | 10,767 + 10,824 (2 iters) | **7,781 + 7,838 (2 iters)** |
| Tool schemas (manufacturing bucket) | 22 | 22 (unchanged — schema diet was Task 3/4, not in scope here) |

`buildLocalCapabilitiesPrompt()` itself: 2,760 chars / ~690 estimated tokens with all 12 currently-enabled packs listed (business-dev, client-acme, customer-service, engineering, finance, hr, manufacturing, novalink, operations-hub, supply-chain, trade-compliance, warehousing) — under the 800-token hard budget with margin. `developer` pack contributes nothing to either the old or new capabilities prompt (its `capabilities:` field is a YAML list the parser doesn't aggregate into a string — pre-existing behavior, unrelated to this task, out of scope).

Turn (c) called `get_time` correctly and answered with the real time (America/Matamoros) — the agentic tool-calling path still works end-to-end.

### GATE: warm same-bucket turn < 30s → **FAIL** (60.2s)

### Interpretation

1. **The capabilities diet worked as designed.** System-prompt tokens dropped 9,571 → 1,428 (−85%); actual prompt_eval_count roughly halved (15.2–15.7k → 7.4–7.8k) — the remaining prompt is dominated by the 22 tool schemas (unchanged, out of this task's scope) plus the frozen persona/rules/kanban prefix.
2. **Wall-clock roughly halved in lockstep with tokens** (140.6–145.7s → 60.2s for the warm turn), consistent with Task 7's finding that .244's prompt-eval throughput (~120–150 tok/s effective) is the binding constraint, not KV-cache reuse.
3. **KV-cache reuse still does not engage.** Warm `prompt_eval_count` (7,592) ≈ cold (7,395) — the full prompt is re-evaluated every turn regardless of `num_ctx`. This confirms `num_ctx` 16384 vs 32768 did not change this behavior; the wall-clock improvement here is entirely attributable to the capabilities diet (fewer tokens to evaluate), not to `num_ctx`.
4. **Remaining gap to gate:** at ~120–150 tok/s, hitting <30s needs the total prompt under ~3.6–4.5k tokens. Current manufacturing-bucket prompt is ~7.5–7.8k tokens (22 schemas ≈ 245 tok each ≈ 5.4k of that). The capabilities block is no longer the whale — the tool-schema count is now the largest remaining lever, followed by switching to a faster model/host path or engaging KV reuse (neither achieved by any surgery to date).

### Decision point (per the task-7b brief: gate still fails → consult, no further fixes)

This ships DONE_WITH_CONCERNS. The user/controller should decide the next lever: (a) shrink the manufacturing bucket's tool schema set further (currently 22, largest remaining prompt cost), (b) switch to `qwen3.5:4b` or a faster host, (c) accept a relaxed threshold given the diet's real (if insufficient) improvement, or (d) revisit whether KV-cache reuse can be forced (e.g. Ollama flags, `/api/generate` context param reuse) since neither Task 7 nor 7b's `num_ctx` change engaged it.

## Deliberate Claude-prompt delta (user-approved)

Task 7b review flagged the `parsePackYaml()` folded-scalar fix (above) as an
unreviewed change to what Claude actually receives, since
`getAggregatedCapabilities()` feeds `fullCapabilities` on **both** provider
paths, not just the condensed local one this task set out to change. User
call (2026-07-06): **the fix stays** — it corrects real data corruption, not
a behavior change that needs gating.

- **Before:** `manufacturing/pack.yaml`'s `capabilities: >` (folded block
  scalar) parsed to the literal 1-character string `">"` — `parsePackYaml()`
  only recognized `|` (literal block scalar), so the entire capabilities
  block silently vanished from both prompts.
- **After:** parses to real prose — verified 999 characters covering line
  balancing, Six Sigma SPC, FMEA, RCA, DES, capacity planning, VSM, TOC,
  CONWIP/Heijunka, DOE, and the manufacturing web dashboards (measured via
  `parsePackYaml()` against the live `packs/manufacturing/pack.yaml`
  fixture; see `tests/packs.test.ts`).
- **Affects both providers:** Claude gets it via `fullCapabilities` →
  `getAggregatedCapabilities()`; Ollama gets it via the same source through
  `buildLocalCapabilitiesPrompt()`'s per-pack one-phrase summaries. Neither
  path was excluded — this was a bug in shared data, not a Task-7b-local
  change, so `tests/claude-prompt-freeze.test.ts` (which freezes prompt
  *composition*, not upstream pack data) correctly did not catch it and
  correctly does not need updating for it.
- **Approved:** 2026-07-06, by the user, as an accepted delta to the Claude
  prompt (governing call for the Task 7b review findings).
- **Test coverage:** `tests/packs.test.ts` — regression tests pin
  `capabilities: >` and `self_description: >` parsing against the real
  manufacturing fixture (in addition to the pre-existing `description: >`
  test). Verified failing against the pre-fix parser (commit `8cd8e75`,
  extracted via `git show 8cd8e75:src/packs.ts` into a scratch module and
  run against the same fixture — both fields parsed to `">"` there) and
  passing against the current parser.

**Reviewer note (minor, cheap to fix later, not blocking):**
`buildLocalCapabilitiesPrompt()`'s `LOCAL_CAPABILITIES_HEADER`
(`src/capabilities.ts`) hardcodes the dashboard list as a literal string
(core: `/ /board /learn /docs`; mfg: `/sim /capacity /sequence /vsm /toc
/conwip /doe /fsm`; ops: `/hub /hub/bom`) instead of calling
`getAggregatedWebApps()` / `buildWebAppsPrompt()` the way the Claude/full
path does. A future pack that adds new `intent_patterns[].web_apps` entries
will auto-appear in the Claude prompt (dynamic) but **not** in the LOCAL
(Ollama) prompt (static) until this header is hand-edited. Full/Claude
prompt is unaffected — this is local-path-only.

## Task 7d — corrected methodology and verdict

**Date:** 2026-07-06

### What was wrong

Every prior verdict in this file ("KV prefix reuse does NOT engage" — Phase 0,
Task 7, Task 7b) was decided by comparing `warm.prompt_eval_count` to
`cold.prompt_eval_count` and finding them roughly equal. That comparison is
invalid: Ollama's `/api/chat` response field `prompt_eval_count` **always
reports the total prompt token count**, not the number of tokens actually
re-evaluated — it does not change between a cold miss and a hot cache hit.
This was proven by a controlled probe in Task 7c
(`.superpowers/sdd/task-7c-report.md`): two byte-identical back-to-back
requests both reported `prompt_eval_count: 15645`, but the first (cold load)
took `prompt_eval_duration: 153.4s` and the second (warm) took `0.116s`
(server log: `sim_best = 1.000`, only 1 token evaluated). The valid signal is
`prompt_eval_duration` (API field, nanoseconds) or the server log's
`prompt eval time = X ms / N tokens` line — both reflect actual work done.

### Corrected re-measurement (real pipe, real gate)

Re-ran the Phase 1 gate using the same production building blocks as Task
7/7b (`registerBuiltinTools()` + manufacturing pack, `resolveLocalTurnConfig()`,
`buildLocalSystemPrompt()` with the Task 7b condensed capabilities,
`OllamaProvider.sendMessage()`'s real agentic path, `num_ctx` 16384), but as
**one persistent process driving one multi-turn conversation** (same `chatId`,
sequential turns) so the KV prefix persists server-side the way a real
Telegram conversation does — the prior scripts used single isolated calls
per scenario. Script: `.superpowers/sdd/bench-pipe-7d.ts` (not committed).
Reached `.244`'s Ollama 0.31.1 via the same SSH tunnel pattern
(`127.0.0.1:11435 → 192.168.2.244:11434`), model `ministral-3:3b`. Model was
confirmed unloaded (`ollama ps` empty) before turn 1, so turn 1 is a genuine
cold load. Prod `luna-bot`/`luna-caddy`/`luna-speaches`/`luna-searxng`
confirmed `Up`/`healthy` before and after; tunnel killed at the end
(confirmed via a refused `curl` afterward).

| Turn | Message intent | Bucket | Wall-clock | prompt tokens (count) | prompt-eval time | newly-evaluated tokens (server log) | generation time / tokens |
|---|---|---|---|---:|---:|---:|---:|
| 1 — cold mfg | "what capacity tools do you have" | manufacturing | 15.25s | 1,513 | 6.646s | 1,513 (full, cold load) | 6.712s / 118 |
| 2 — **GATE** warm same-bucket | mfg follow-up ("spot a bottleneck on line 3") | manufacturing | **5.69s** | 1,648 | **0.742s** | **136** (sim_best 0.917) | 4.573s / 80 |
| 3 — warm same-bucket | mfg follow-up ("run a capacity check… using your tools") | manufacturing | 5.41s | 1,745 | 0.600s | 98 (sim_best 0.944) | 4.532s / 79 |
| 4 — bucket switch → docs | "generate a PDF summary" | docs | 42.37s | 5,388 | 31.460s | 5,376 (full miss — LRU slot pick, no LCP match) | 10.599s / 138 |

Cross-checked directly against `.244`'s server log
(`/opt/homebrew/var/log/ollama.log`), which independently confirms the API
field values above (e.g. task 120: `prompt eval time = 741.98 ms / 136
tokens`, matching turn 2's `prompt_eval_duration`).

### GATE: turn 2 (warm same-bucket) wall-clock < 30s → **PASS** (5.69s)

Breakdown: prompt-eval 0.742s (only 136 of 1,648 prompt tokens newly
evaluated — a cache **hit**, `sim_best = 0.917`) + generation 4.573s (80
tokens) + overhead ≈ 5.69s total. Extrapolating turn 1's cold per-token rate
(4.39 ms/token) to a full 1,648-token re-eval would cost ~7.2s on prompt-eval
alone — turn 2 measured 10x less, which is only explainable by KV-prefix
reuse, not by prompt size.

### Interpretation

1. **KV-prefix reuse does engage on the real production pipe**, confirmed by
   both the API's `prompt_eval_duration` and the server log's `sim_best`/
   newly-evaluated-token counts for turns 2 and 3 (same-bucket warm turns):
   only the conversational delta (136 and 98 tokens respectively) was
   re-evaluated each turn, not the full prompt.
2. **A bucket switch (turn 4) caused a full cache miss here** (5,376 of
   5,388 tokens re-evaluated, slot picked by LRU with no LCP match at all) —
   worse than Task 7c's synthetic bucket-switch probe (~970/15,227 partial
   re-eval). Plausible cause: this is a real, growing multi-turn conversation
   plus an actual tool-schema-set change, so the shared prefix before the
   divergence point is smaller than in 7c's isolated single-turn synthetic
   test. Bucket switches remain the expensive case; same-bucket turns are
   cheap.
3. **Caveat — not every turn actually attached tool schemas.**
   `OllamaProvider.sendMessage()` has its own independent heuristic
   (`shouldUseTools()`) deciding whether to send the `tools` array at all,
   separate from bucket selection. Turns 1–3 logged `useTools: false` (plain
   chat turn, no schemas sent over the wire at all — this is why their
   prompt sizes are ~1.5–1.7k tokens, not the ~7.5k seen in Task 7b's
   always-tools-on synthetic scenarios). Turn 4 logged `useTools: true`
   (schemas attached, prompt jumped to 5,388 tokens). None of the 4 turns
   actually invoked a tool (`resp.toolsUsed` was empty every turn) — turn 4's
   model asked a clarifying question instead of calling `generate_document`.
   This means the GATE turn measured here reflects a common
   no-tool-needed conversational follow-up, which is realistic Telegram
   traffic, but a same-bucket warm turn that *does* attach tool schemas
   (`useTools: true`, no bucket switch) was not isolated in this run and
   would be the more conservative case to re-check if a future gate audit
   wants that combination specifically.
4. **The Task 7b capabilities/schema diet numbers stand.** The corrected
   verdict is about the *interpretation* of `prompt_eval_count`, not about
   walking back the real token/wall-clock reductions Task 7b measured from
   the condensed-capabilities change — those were genuine, independent of
   this metric bug.

### Revised recommendation

Do not reopen Phase 2 (model swap to `qwen3.5:4b`, further schema trimming,
or threshold relaxation) on the basis of the old FAIL verdicts — the gate
passes with the current Phase 1 surgery (condensed capabilities +
`num_ctx` 16384 + KV-cache reuse, which was already engaging, just
mismeasured). Recommended follow-ups, not gating: (a) re-run turn 2's exact
scenario with `useTools: true` forced (a same-bucket, tool-schema-attached,
no-switch turn) to get the conservative-case number; (b) treat bucket
switches as a known, real cost (30–45s) that should be minimized by
avoiding oscillation, not by trying to make it as cheap as same-bucket
turns; (c) stop using `prompt_eval_count` anywhere in this codebase's
benchmarking for cache-engagement judgments — use `prompt_eval_duration` or
server-log `prompt eval time` only.

## Pre-flip conservative bench (useTools:true)

Checklist item 1 before the AUTO_ROUTE flip: isolate the case Task 7d
flagged but didn't measure — a warm same-bucket manufacturing follow-up
with tool schemas actually **attached** (`useTools: true`, 22 mfg-bucket
schemas on the wire), not a plain no-tool conversational follow-up.

**Method:** same real-pipe building blocks as 7d, one persistent process/
`chatId`, three sequential turns, `.244`'s Ollama 0.31.1 via the same SSH
tunnel (`127.0.0.1:11435 → 192.168.2.244:11434`), `ministral-3:3b`,
`num_ctx` 16384. Script: `.superpowers/sdd/bench-pipe-preflip.ts` (not
committed). Messages were phrased to deliberately trip `shouldUseTools()`
(contains "generate") while also tripping the manufacturing bucket regex
(contains "balance"), confirmed by dry-running both regexes before the
live call. Prod `luna-bot` containers untouched; tunnel killed after,
confirmed via a refused `curl` afterward.

| Turn | Intent | Bucket | useTools | Tool called | Wall-clock | prompt tokens | prompt-eval time (server `sim_best`) | gen time / tokens |
|---|---|---|---|---|---:|---:|---:|---:|
| 1 — cold mfg, tools attached | "Generate the line balance for 4 stations…" | manufacturing | true | yes (`line_balance`, malformed-input clarification; 3-call agentic loop) | 142.32s | 7,413→8,139 (grew across loop) | 49.28s cold (sim n/a) + 4.14s (sim_best 0.946) + 3.09s (sim_best 0.962) | 30.02s/345 + 19.35s/222 + 31.04s/357 |
| 2 — **THE NUMBER**, warm same-bucket, tools attached | "Now generate the line balance again with a 35s target takt…" | manufacturing | true | no (described approach in prose, no call) | **108.82s** | 7,788 | **46.63s** (sim_best **0.179**, f_keep 0.164 — 6,395 of 7,788 tokens re-evaluated) | 61.65s / 708 |
| 3 — warm, no tool need | "Summarize what we found…" | manufacturing | false | n/a | 34.55s | 2,632 | 12.53s (sim 0.005 — near-full miss, structurally different prompt with schemas dropped) | 21.55s / 340 |

Cross-checked against `.244`'s server log (`/opt/homebrew/var/log/ollama.log`):
task 934 (turn 2) — `slot get_availabl: selected slot by LCP similarity,
sim_best = 0.179 (> 0.100 thold), f_keep = 0.164` then `prompt eval time =
46634.82 ms / 6395 tokens`, matching the API's `prompt_eval_duration`
exactly.

### Verdict vs the 30s gate: **FAIL** (108.82s, ~3.6x over)

Turn 2 — the conservative warm-same-bucket-with-tools case — does **not**
meet the 30s gate, in sharp contrast to Task 7d's no-tools warm gate
(5.69s, sim_best 0.917). Root cause is visible directly in the server log:
attaching tool schemas plus the tool-call/tool-result messages that turn 1's
agentic loop appended to history collapses next-turn KV-prefix similarity
from ~0.92–0.96 (no-tools case) to **0.179** — i.e. the "same bucket, same
tools, next turn" prompt no longer shares a long common prefix with the
cached state, forcing an almost-full re-evaluation (6,395 of 7,788 tokens).
Turn 3 (dropping tools again) also misses (sim 0.005) because the
tools-attached vs. tools-free prompt shapes are structurally different from
each other, not just longer/shorter.

### Anomalies

- Turn 2 did not actually call the tool despite having schemas and history
  showing the model's own turn-1 attempt — it produced a prose plan
  instead. Turn 1 did call `line_balance` but the input was malformed
  (model didn't supply the tool's expected CSV/column format), producing a
  clarifying-question response rather than a computed result. Neither turn
  demonstrates a clean tool-call round trip; both burn the very expensive
  "cold-shaped" prompt-eval cost anyway, since KV reuse fails regardless of
  whether a call happens.
- Generation speed itself also degraded turn-over-turn (11.4–11.5 tok/s in
  turn 2 vs. ~15.8 tok/s turn 3, vs. much faster per-token rates in 7d's
  smaller-prompt turns) — consistent with a much larger active context
  (7,788–8,139 tokens vs. 7d's ~1.5–1.7k) rather than any server-side
  contention; no other load was on the box.

### Implication for the AUTO_ROUTE flip

This is the conservative case the flip checklist asked for, and it fails
the gate by a wide margin. The failure mode is specific and diagnosable —
tool-call/tool-result messages appended mid-conversation break KV-prefix
stability for the *next* turn even within the same bucket — so before
flipping AUTO_ROUTE for manufacturing-bucket traffic that actually invokes
tools, either (a) confirm the flip's fallback/threshold treats this as an
expected slow path rather than a routing bug, or (b) scope a follow-up fix
(e.g. trimming/normalizing tool-call round-trip messages out of history
before the next turn's prompt is assembled, to restore prefix stability) —
this should not gate the current benchmark item, but should not be silently
absorbed into "flip and see" either.

## Qwen3.5:4b full-pipe re-bench (flip decision)

Re-runs the exact pre-flip conservative bench above with `OLLAMA_TOOL_MODEL`/
`OLLAMA_CHAT_MODEL` swapped from `ministral-3:3b` to `qwen3.5:4b` — same real
pipe, same three turns/wording, same `.244` box via the same SSH tunnel,
`num_ctx` 16384, `OLLAMA_THINK=false` (matches .244's deployed prod `.env`).
Script: `.superpowers/sdd/bench-pipe-qwen4b.ts` (not committed). Prod
`luna-bot`/`luna-caddy`/`luna-speaches`/`luna-searxng` confirmed healthy
before the run; tunnel killed after.

Purpose: confirm/refute that qwen3.5:4b's chat template is KV-prefix-stable
across tool-call/tool-result turns, where ministral-3:3b's was not
(sim_best collapsed to 0.179 above).

| Turn | Wall-clock | Sub-calls (agentic loop) | newly-eval tokens (sum) | prompt-eval time (sum) | sim_best range | gen time / tokens (sum) | tool called |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 cold mfg, tools attached | 131.6s | 4 | ~1,464+1,568+1,572 (+cold) | ~39.3s | 0.966–0.987 | ~51.1s / 619 | yes, errored (see anomalies) |
| 2 **THE NUMBER**, warm same-bucket, tools attached | **87.8s** | 4 | 1,309+1,507+1,720+1,933 = 6,469 | 43.13s | **0.966–0.976** | 43.34s / 452 | yes, errored every attempt |
| 3 warm, no tool need | 27.7s | 1 (full miss, schema shape changed) | 1,891 | 9.81s (192.8 tok/s) | n/a (full re-process, no checkpoint match) | 17.46s / 235 | n/a |

Cross-checked against `.244`'s Ollama server log — every turn-2 sub-call
selected its slot "by LCP similarity" with `sim_best` 0.966–0.976
(`f_keep` 0.909–0.997), i.e. ~90%+ of the KV prefix reused each time,
matching ministral's own *no-tools* warm case (0.917–0.962) and nowhere
near ministral's *with-tools* collapse (0.179). **KV-prefix-stability claim
for qwen3.5:4b: CONFIRMED** — tool-call/tool-result history does not break
its cache reuse the way it broke ministral-3:3b's.

### GATE: turn 2 wall-clock < 30s → **FAIL** (87.8s, ~2.9x over)

Despite confirmed cache reuse, the gate still fails — for a different
reason than ministral's. qwen3.5:4b's `line_balance` tool call never
succeeded: turn 1 hit "Knex not initialized" (the bench harness never calls
`initKnex()`, and every `line_balance` action — `run`/`list`/etc. —
requires DB-backed project storage) for its first 3 attempts, then a
correctly-formatted-CSV attempt on iteration 4 that also failed for the
same DB reason, tripping the circuit breaker (HALF_OPEN after 3 errors);
turn 2 then made 4 fresh attempts, first two rejected for CSV formatting
(semicolon-delimited instead of comma, missing header), before the circuit
breaker went OPEN after 4 consecutive errors and the loop returned the
injected retry-guidance stub as "the answer" rather than a model-authored
response. Each of those 4 sub-calls in turn 2 still costs ~19–24s
(prompt-eval + generation), and 4 × ~22s ≈ 87.8s — the gate fails on
**iteration count**, not KV-cache misses.

### Anomaly: tier misresolution

The task brief assumed qwen3.5:4b lands in the medium tier (maxIterations
6 / numPredict 1024 / temp 0.3). It does not. Ollama reports this model's
`parameter_size` as **4.7B** (confirmed via `/api/tags`), and
`resolveModelTier()` (`src/providers/ollama.ts:55-63`) only grants the
medium tier at `paramsInBillions <= 4` — 4.7 falls through to
`DEFAULT_TIER` (maxIterations 10, no numPredict cap, temp 0.7). Confirmed
directly in the bench log: `"Agentic loop circuit breaker opened" ...
maxIterations: 10`. So this bench ran qwen3.5:4b under the *unrestricted*
tier, not the tuned small-model tier the flip brief expected — the model
was allowed up to 10 retries (circuit breaker cut it off at 4) and an
uncapped `num_predict`. If the medium tier is meant to cover "4B-class"
models by their marketing name rather than Ollama's reported
`parameter_size`, the `<= 4` boundary in `resolveModelTier` needs
revisiting (e.g. a small epsilon, or a name-based override) — flagged as a
finding, not fixed here.

### Answer quality

Turn 3's final answer (produced after the tool never executed, using the
model's own domain reasoning) was directionally correct: it identified that
a 35s target takt is infeasible because one task requires 45s, correctly
naming the bottleneck-task-vs-takt relationship that underlies line
balancing. So despite zero successful tool calls in this bench, qwen3.5:4b's
unaided reasoning about the manufacturing problem was sound.

### Ministral-3:3b vs qwen3.5:4b comparison

| | ministral-3:3b (pre-flip) | qwen3.5:4b (this bench) |
|---|---:|---:|
| Turn 2 wall-clock | 108.82s | 87.8s |
| Turn 2 sim_best | 0.179 (cache broken) | 0.966–0.976 (cache stable) |
| Turn 2 tokens re-evaluated | 6,395 / 7,788 | 6,469 total across 4 calls, each only ~1.3–1.9k new (mostly reused) |
| Gate | FAIL | FAIL |
| Root cause | KV-prefix collapse from tool-turn history | Tool-call formatting failures → circuit-breaker retries (DEFAULT tier, not medium) |

**Net:** the KV-prefix-stability hypothesis for qwen3.5:4b is validated —
switching models does fix the specific cache-collapse failure mode found
with ministral-3:3b. It does **not**, by itself, clear the 30s gate in this
run, because a second, independent bottleneck (repeated tool-call-argument
formatting errors, compounded by the model landing in the unrestricted
DEFAULT tier instead of the intended medium tier) drove the wall-clock over
budget instead. The bench harness's missing `initKnex()` call also means no
`line_balance` call could have succeeded regardless of model, which further
confounds "did tool-calling actually work" — a follow-up bench with a real
DB wired in is needed before drawing conclusions about qwen3.5:4b's
tool-call success rate in production.

## Decisive re-bench: qwen3.5:4b + tier fix + working tools

**Date:** 2026-07-07
**Branch/commit:** `fix/model-tier-boundary` @ `5b05d56` (medium tier now
covers 4.7B-class — `resolveModelTier` boundary raised from ≤4 to ≤5).
**Script:** `.superpowers/sdd/bench-pipe-decisive.ts` (not committed) —
same real pipe, same three turns/wording as the two failed attempts above,
with BOTH prior defects fixed:
1. **Tier fix active and verified in-run:** the script resolves the tier
   through the real `OllamaProvider.getModelTier()` against `.244`'s
   `/api/tags` before any turn, and hard-stops if it still says 10.
   Confirmed: `Resolved tier for qwen3.5:4b:
   {"maxIterations":6,"numPredict":1024,"temperature":0.3}` — **medium**.
2. **DB bootstrapped:** `initKnex({driver:'sqlite',
   sqliteFilename:':memory:'})` sets the real singleton (same intent as
   `createTestKnex()` in `tests/router-pinned-turns.test.ts`, but via the
   production `initKnex` since a plain tsx script can't vi.mock), then
   `initBalanceTables()`, then a direct non-LLM preflight
   (`line_balance {action:"list"}`) proved the DB path returns no error
   before any model time was spent.

Same `.244` box via the same SSH tunnel (`127.0.0.1:11435 →
192.168.2.244:11434`), Ollama 0.31.1, `num_ctx` 16384, `OLLAMA_THINK=false`,
model confirmed unloaded (`/api/ps` empty) before turn 1. Prod
`luna-bot`/`luna-caddy`/`luna-speaches`/`luna-searxng` confirmed healthy
before and after; tunnel killed after (curl refused, no ssh process).

### Numbers

| Turn | Wall-clock | Sub-calls | prompt-eval per call (server log: newly-eval tokens, sim_best) | gen per call (tokens / time) | tool result | iterations used (max 6) |
|---|---:|---:|---|---|---|---:|
| 1 cold mfg, tools | 127.9s | 3 | 46.78s (8,114 full cold) → 8.28s (1,246, 0.973) → 12.89s (1,926, 0.924) | 118/11.1s → 216/20.6s → 250/24.3s | **SUCCEEDED** (2nd call: efficiency 86.1%, SI 8.41, 4 stations; 1st call domain-errored — model passed takt=30 < longest task 45s, then self-corrected) | 3 |
| 2 **THE NUMBER**, warm same-bucket, tools | **41.4s** | 2 | 8.67s (1,300, 0.967) → 10.15s (1,531, 0.973) | 127/12.0s → 103/9.8s | executed cleanly; returned the domain-correct infeasibility error (takt 35s < longest task 45s — mathematically unbalanceable); model explained it correctly in one retry-free pass | 2 |
| 3 warm, no tools | 22.7s | 1 | 10.03s (1,936 full re-eval, LRU slot — schema-free prompt shape differs, consistent with all prior benches) | 168/12.2s | n/a | 1 |

Server log cross-check: every duration above matches
`/opt/homebrew/var/log/ollama.log` to the hundredth of a ms (e.g. turn 1
call 1 `46775.09 ms / 8114 tokens` = API `prompt_eval_duration`
46775093000 ns).

### GATE: turn 2 wall-clock < 30s → **FAIL** (41.4s, ~1.4x over)

### Comparison to the two failed attempts

| | ministral-3:3b (pre-flip) | qwen3.5:4b, broken harness | **qwen3.5:4b, this run** |
|---|---:|---:|---:|
| Turn 2 wall-clock | 108.8s | 87.8s | **41.4s** |
| Turn 2 sub-calls | 1 (huge re-eval) | 4 (all tool errors) | **2** (clean round trip) |
| Turn 2 sim_best | 0.179 (cache broken) | 0.966–0.976 | **0.967–0.973** |
| Tier | n/a | DEFAULT (10 iters) | **medium (6 iters, 1024 cap)** |
| line_balance ever succeeded | no (malformed input) | no (Knex not initialized) | **YES** (real computed result, turn 1) |
| Gate | FAIL | FAIL | FAIL |

### Verdict

Both prior defects are confirmed fixed and both prior failure modes are
gone: KV reuse holds across tool turns (sim 0.92–0.97 everywhere except
the expected schema-drop re-eval in turn 3), and tool calls execute against
a real DB — turn 1 produced a genuine computed line balance, and turn 2's
"error" was the tool giving the mathematically correct infeasibility
answer, not a harness fault. What remains is a **structural floor**: turn 2
is a 2-call agentic round trip (model → tool → model), and at this
host/model's speeds — ~150 tok/s incremental prompt-eval and **~10.5 tok/s
generation** — two calls cost ~18.8s prompt-eval + ~21.9s generation ≈
41s. The gate is no longer failing on retries, cache misses, or broken
tools; it's failing on raw generation throughput for a 4B model on the
16 GB M1 doing 2 sequential inference calls. A single-call turn passes
(turn 3: 22.7s); any tool-using turn structurally cannot fit 30s at
~10.5 tok/s unless responses are capped much tighter than 1024
(`num_predict`) or generation gets faster. Levers if the gate must pass
as-written: lower `num_predict` for tool-loop iterations (the 216–250-token
intermediate responses in turn 1 are pure overhead), prompt the model to
skip prose between tool calls, or relax the gate to distinguish "tool-turn"
(2-call floor ≈ 40s) from "chat-turn" (<30s, passes today).

### Anomalies

- Turn 1's first tool call passed `takt_time: 30` (misread "cycle times
  30,45,38,42" as a 30s takt) — a domain error, self-corrected on the next
  iteration. Small-model arg-mapping remains imperfect even when the call
  format is valid.
- The `.244` server log shows two additional full cold-load sequences
  (8,114 tokens each) before this run's — earlier bench attempts that were
  auto-backgrounded by the runner and died silently mid-run DID reach the
  server first. Bench runs on this project must be foreground/detached-
  with-polling; backgrounded `npx tsx` invocations die without a trace.
- Turn 2's tool "error" is semantically correct behavior (35s takt is
  infeasible with a 45s task, as the pre-flip ministral bench's turn 3
  answer also concluded) — the bench message wording bakes in an
  infeasible request, so no turn-2 run of this scenario can ever produce a
  `success: true` tool result. A future re-bench wanting a clean turn-2
  success should use a feasible takt (≥45s).
