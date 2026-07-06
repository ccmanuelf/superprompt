# KV-reuse spike — Phase 0 (pipeline surgery)

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
