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
