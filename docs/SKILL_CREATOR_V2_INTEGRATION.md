# skill-creator-v2 — Luna Integration Spec

**Status:** **Phase 1 SHIPPED rc.98 (2026-04-29).** Phases 2-4 pending. The work described here adopts and adapts Anthropic's `skill-creator-v2` (originally upstream of `olelehmann1337/marketing-os-workshop`, Apache-2.0) into Luna's `src/forge/` so Luna can build, eval, benchmark, and iterate skills with measurable quality signals — not just prompt-craft intuition.

| Phase | Status | rc | Brief |
|-------|--------|----|----|
| 1 — Eval runner + grader + viewer | ✅ shipped | rc.98 | `src/forge/eval/` runner+grader+db+schemas+prompts; `/skill eval` Telegram cmd; `/forge/evals` web viewer; 3 DB tables; 25 new tests |
| 2 — Benchmark aggregation | ⏳ pending | **rc.100+** | Mean ± stddev across N runs, sample-size-aware variance, viewer aggregate-stats panel |
| 3 — Description optimizer + blind comparator | ⏳ pending | **rc.101+** | Auto-mutate trigger descriptions; blind A/B comparator with anonymized outputs |
| 4 — Docs polish | ⏳ pending | **rc.102+** | customization-guide + pack-development-guide refreshes; optional SKILL_AUTHORING_PLAYBOOK.md |

**rc.99 update (2026-04-29):** rc.99 was used for the standalone `interviewer` built-in skill (clean-room adaptation of Lehmann's `the-interviewer` pattern, scoped to maquiladora + shelter operations). Skill-creator-v2 Phases 2-4 shift one slot down. The integration doc's rc labels above reflect this shift; further shifts may occur if NovaLink bridge / attendance Phase B / other priority work lands before Phase 2 starts.

**Trigger condition for Phase 2:** wait until antislop + council (shipped rc.97 on 2026-04-28) have ≥2 weeks of real production usage. Earliest viable Phase 2 start: **2026-05-13**. A reminder agent fires 2026-05-09 to surface the readiness check (`trig_01QTwcxnJgkxjUqdajsgaLrG`).

**rc numbers may shift.** If NovaLink bridge integration, attendance Phase B wiring, or other priority work lands in slots 99/100/101, treat the rc labels above as ordered slots, not absolute pins.

**Scope:** all Luna deployments. Skill-engineering tooling is generic; it has zero domain coupling. Lives under `src/forge/eval/` alongside the existing forge surface.

**Companion:** rc.97 shipped the upstream pure-prompt skills `antislop` and `council` from the same workshop. They are the prime guinea pigs for Phase 2 once usage data exists.

---

## 1. Why this is worth a sprint

Luna's `src/forge/` already does skill creation: users say `/skill create <name>` or describe a workflow, the AI drafts a skill, the user accepts. **What's missing is measurable quality.** Today there is no answer to questions like:

- "Did adding this skill actually improve responses, or just make them longer?"
- "Which of these two skill versions is better?"
- "When does the auto-trigger fire on the wrong messages?"
- "How does this skill perform on 20 real test prompts vs. baseline?"

`skill-creator-v2` answers all of those. It runs **with-skill vs without-skill** prompt pairs, grades each output against assertions, aggregates pass-rate / time / token deltas with mean±stddev, generates an HTML viewer for human review, and runs a description-optimization loop that mutates trigger phrasing to maximize trigger accuracy. Production-grade skill engineering, not prompt-craft theater.

**The core value transfers cleanly to Luna.** Domain coupling: zero. The original skill works equally for marketing skills, manufacturing skills, attendance skills, NovaLink skills.

**The mechanism does not transfer cleanly** — that's what this sprint is for.

---

## 2. What `skill-creator-v2` actually is

| Aspect | Detail |
|--------|--------|
| License | Apache 2.0 (stock boilerplate, no named copyright holder — almost certainly the upstream Anthropic-published reference skill, dropped into Lehmann's MIT repo unchanged) |
| Files | 18 total / ~244 KB |
| Footprint | `SKILL.md` (32 KB), `LICENSE.txt`, plus 5 directories: `agents/` (3 sub-agent prompts: grader, comparator, analyzer), `assets/` (HTML for description review), `eval-viewer/` (HTML + Python report generator), `references/` (schemas, descriptions, packaging guidance), `scripts/` (9 Python scripts) |
| Python scripts | `run_loop.py`, `run_eval.py`, `aggregate_benchmark.py`, `package_skill.py`, `quick_validate.py`, `improve_description.py`, `generate_report.py`, `utils.py`, `__init__.py` |
| Python script runtime expectations | Python 3, `claude` CLI, browser (or `--static` headless fallback), filesystem write, sub-agent spawning via `Task` |
| Process at a high level | (1) intent capture → interview → SKILL.md draft → (2) test prompts → spawn N with-skill + N baseline runs in parallel → (3) draft assertions → (4) grade per-run via grader sub-agent + assertion scripts → (5) aggregate benchmark → (6) HTML report → (7) human review → (8) iterate the SKILL.md → (9) optional description-optimization loop with trigger-eval scoring → (10) optional blind A/B comparison via comparator + analyzer sub-agents |

The depth of craft is genuinely high — separation of subjective vs objectively-verifiable assertions, headless mode for Claude Cowork environments, the description optimizer that shells out to `claude -p` to mutate descriptions and re-score — but the design assumes Claude Code's tool surface and a single-user developer workstation. Luna runs as a daemon serving multiple chats with no terminal attached. The translation is real work.

---

## 3. Mechanism translation — what changes between original and Luna port

| Original (Claude Code) | Luna port | Why the change |
|------|------|------|
| Sub-agent spawning via `Task` tool for parallel eval runs | Either (a) sequential runs in the same Luna chat, or (b) parallel via `claude -p` subprocess fan-out | Luna has no `Task` tool. (b) is preferred: Luna already shells out to `claude -p` for the Claude provider, so the machinery exists |
| Python scripts called from the skill's instructions | TypeScript modules under `src/forge/eval/` | Keeping Python would mean adding Python to the Luna container and managing an interop layer. TS port is ~1k LOC and gets us native types, integration with existing forge, and one runtime |
| HTML viewer file opened in browser | Luna web route under `/forge/evals/:runId` (rendered server-side from the same JSON schemas) | Luna already has a web server on port 3030. Replicating "open an HTML file in browser" means publishing files to disk; a route is cleaner and authenticates per-user via the existing webtoken system |
| `claude -p` description-optimization loop | Same — Luna re-uses its existing Claude provider for this | One area where the original maps almost 1:1 |
| `feedback.log` style progressive learning (in some adjacent skills) | Persist eval history in SQLite (`forge_evals` table) so future iterations can compare against prior runs | Luna can't do append-to-file from a skill, but it can persist via DB. Strictly better — queryable, multi-user-aware |
| Skill output format = `SKILL.md` | Skill output format = TypeScript `BuiltinSkillDef` entry OR `pack.yaml` for pack-scoped skills | Luna's runtime doesn't load `SKILL.md` files. The skill creator builds Luna-format output. (Future: optional dual-output mode if Luna ever consumes Claude Code skills directly) |
| Grader / comparator / analyzer as sub-agent prompts | Same prompts, invoked via `claude -p` subprocess (one call per grade) OR via Luna's existing Ollama agentic loop | The prompts themselves transfer verbatim; only the dispatch mechanism changes |
| Assertion scoring against subjective vs objective criteria | Same logic, ported as TS | Logic transfers as-is |

**One simplification:** the original distinguishes Claude Code / Claude.ai / Claude Cowork environments and adapts behavior. Luna is one environment. We can drop the env-detection branching.

---

## 4. Proposed Luna-side architecture

```
src/forge/                          (existing — skill + tool registry, safety scanner)
├── eval/                           (NEW)
│   ├── runner.ts                   ← spawn N with-skill + N baseline runs via claude -p
│   ├── grader.ts                   ← prompt the grader against each run's assertions
│   ├── benchmark.ts                ← aggregate pass-rate / latency / tokens with mean±stddev
│   ├── description-optimizer.ts    ← trigger-eval loop, mutates descriptions, re-scores
│   ├── comparator.ts               ← blind A/B comparison (no telling which is which)
│   ├── prompts/
│   │   ├── grader.md               ← agents/grader.md from upstream, verbatim
│   │   ├── comparator.md           ← agents/comparator.md verbatim
│   │   └── analyzer.md             ← agents/analyzer.md verbatim
│   └── schemas.ts                  ← TS types for evals.json / grading.json / benchmark.json
│
src/web/public/forge/               (NEW — eval viewer)
├── evals.html                      ← list view of recent eval runs
├── eval-detail.html                ← per-run detail with assertions + outputs side-by-side
└── eval-compare.html               ← two-version comparison view
src/web/server.ts                   ← register /forge/evals/* routes (auth via existing webtoken)
src/db-core.ts                      ← new tables forge_evals, forge_eval_runs, forge_eval_assertions
src/platforms/telegram.ts           ← extend /skill command with `eval`, `benchmark`, `optimize-description` subcommands
docs/customization-guide.md         ← Level 1/2/3 framework gains a §"Measuring skill quality"
```

**Estimated new code:** ~1500-2500 LOC TypeScript + ~3 prompt files (verbatim from upstream, ~5 KB each) + ~3 HTML pages for the viewer. No Python in Luna's runtime.

**Estimated tests:** ~30-50 new tests covering schema validation, runner subprocess management, grader prompt invocation, benchmark math (mean±stddev correctness), and description-optimizer convergence on a known fixture.

---

## 5. Phased sprint plan

The work breaks into 4 phases. Each is independently shippable; later phases compound on earlier ones. Phase 1 is the source of truth for the patterns the next three phases extend — read its source files (`src/forge/eval/`) before scoping the next phase.

### Phase 1 — Eval runner + grader + viewer ✅ SHIPPED rc.98

Shipped 2026-04-29 (commits `ab89006` + `224815f`). The minimum that delivers user-visible value: a Luna skill author can define test prompts + assertions, run with-skill vs baseline, see graded results in a web viewer.

**Files created (the surface Phase 2-4 will extend):**

| File | LOC | Phase 1 role | Phase 2-4 extension points |
|------|-----|--------------|----------------------------|
| `src/forge/eval/schemas.ts` | 156 | TS types (`EvalSession`, `EvalRun`, `EvalAssertion`, `EvalSessionRequest`, `GraderResult`, `SessionSummary`) + constants (`DEFAULT_MAX_EVAL_CALLS_PER_RUN=40`, `DEFAULT_RUNS_PER_CONFIG=2`, `DEFAULT_RUNNER_CONCURRENCY=3`) | Phase 2 adds `BenchmarkSummary` and `RunStatistics`. Phase 3 adds `ComparisonResult` and `DescriptionOptimization` |
| `src/forge/eval/db.ts` | 252 | TableInitializer + CRUD: `createEvalSession`, `getEvalSession`, `listEvalSessions`, `updateEvalSessionStatus`, `createEvalRun`, `updateEvalRun`, `listEvalRuns`, `insertAssertions`, `listAssertionsForRun`, `computeSessionPassRate` | Phase 2 adds `computeBenchmarkStats` (mean/stddev). Phase 3 adds tables for comparisons + optimizations |
| `src/forge/eval/runner.ts` | 459 | `validateEvalRequest`, `computeTotalCalls`, `startEvalSession`, `buildGraderUserMessage`, `parseGraderResponse`, internal `executeOneRun` + `Semaphore` | Phase 2 raises default `runs_per_config` 2→5 and adds `runBenchmark`. Phase 3 reuses `Semaphore` for the optimizer's mutation fan-out |
| `src/forge/eval/prompts/grader-upstream.md` | 238 | Apache-2.0 verbatim port for attribution | Phase 3 adds `comparator-upstream.md` + `analyzer-upstream.md` (already fetched in `/tmp/skill-source/`) |
| `src/forge/eval/prompts/grader-luna.md` | ~110 | Runtime-used adaptation: inline inputs replace upstream's filesystem paths; output JSON only | Phase 3 adds `comparator-luna.md` + `analyzer-luna.md` adapted the same way |
| `src/forge/eval/index.ts` | 30 | Public-API barrel | Phase 2-4 add their public exports here |
| `src/web/forge-evals-api.ts` | 75 | JSON endpoints `/api/forge/evals` (list) + `/api/forge/evals/:id` (detail) with per-chat scoping (cross-chat → 404 not 403) | Phase 2 adds `/api/forge/evals/:id/benchmark`. Phase 3 adds `/api/forge/comparisons/:id` and `/api/forge/optimizations/:id` |
| `src/web/public/forge/evals.html` | 308 | Single-page viewer; `?id=N` for detail; webtoken auth via localStorage | Phase 2 adds aggregate-stats panel. Phase 3 adds compare view (likely `?compare=a,b`) and optimization view |
| `tests/forge-eval.test.ts` | 280 | 25 tests: schemas/idempotency, cap math, validation enforcement, grader response parsing, DB CRUD, attribution headers | Phase 2 adds ≥10 benchmark math tests (stddev on small N is the trap). Phase 3 adds comparator + optimizer tests |
| `docker/luna.dockerfile:62-65` | 4 | `COPY src/forge/eval/prompts/ ./dist/forge/eval/prompts/` — ships .md files into dist (tsc only emits .js) | **See §5.5 — same pattern needed for any new prompt files in Phase 2-4** |

**DB tables created (Knex, dialect-agnostic):** `forge_evals`, `forge_eval_runs`, `forge_eval_assertions`. Per-chat scoping at session level; runs and assertions inherit through FK chain. No CASCADE deletes (audit-trail preservation, same approach as `attendance_*` tables).

**Cap enforcement:** `MAX_EVAL_CALLS_PER_RUN=40` env var (default 40). Total calls = 2 × prompts × runs × configs (one baseline + one grader call each). Default config (2 runs × 5 prompts × 2 configs) hits exactly 40. Sessions exceeding the cap are refused at `validateEvalRequest` before any subprocess spawn.

**Subprocess pattern:** `runner.ts` reuses `ClaudeProvider.sendMessage` rather than duplicating spawn logic. Concurrency limited to 3 in-flight via a tiny homegrown semaphore. Fan-out is async — `startEvalSession()` returns the session ID immediately and the work runs in the background; failures are persisted to `forge_evals.error_message` rather than crashing the daemon.

---

### 5.5. Lessons from Phase 1 — read before starting Phase 2

These cost real time on Phase 1 and will cost the same time again on Phase 2-4 if not anticipated.

1. **`tsc` does not emit non-`.ts` files.** The grader prompt files (`grader-upstream.md`, `grader-luna.md`) are loaded at module load time via `readFileSync(resolve(__dirname, 'prompts/...'))`. In dev mode (`tsx`), this resolves to `src/forge/eval/prompts/`, which exists. In production (Docker, runs from `dist/`), it resolves to `dist/forge/eval/prompts/`, which does NOT exist by default — `tsc` only emits `.js`. **Phase 1 deploy went into a restart loop on first boot** until I added `COPY src/forge/eval/prompts/ ./dist/forge/eval/prompts/` to `docker/luna.dockerfile`. **Phase 2-4 must extend that COPY line** (or add new ones) for any new prompt files. Look at `src/web/public/` for the same pattern — that's the precedent.

2. **`runs_per_config: 2` is the most you can fit at default cap with 5 prompts × 2 configs.** Phase 2 raises the default to 5 runs (the variance threshold the upstream uses). At 5 prompts × 5 runs × 2 configs × 2 (baseline+grader) = 100 calls — exceeds the cap. Phase 2 must either (a) lower the default prompt count to 4 (5×4×5×2 = 200, also too many) → actually 2 prompts × 5 runs × 2 configs × 2 = 40, exactly at cap; or (b) raise `MAX_EVAL_CALLS_PER_RUN` env default. Document the tradeoff.

3. **Knex `returning()` shape varies by dialect.** SQLite returns `[id]`; MySQL/MariaDB returns `[{ id }]`; PostgreSQL returns `[{ id }]`. Phase 1 code coerces with `typeof row === 'object' ? Number(row.id) : Number(row)`. Phase 2-4 inserts must repeat this pattern.

4. **Per-chat scoping is enforced inside the API handler, not at the route layer.** Cross-chat access returns **404, not 403**, to avoid leaking session existence. Phase 2-4 endpoints must follow the same pattern.

5. **`claude -p` does not produce tool-call breakdown in stream-json.** The upstream `grading.json` schema includes `execution_metrics.tool_calls` (Claude Code's Task-tool telemetry). Luna can capture `output_chars`, `duration_ms`, `exit_code` — but not per-tool counts. Don't write Phase 2 code that relies on it.

6. **Concurrency limit is tunable but currently hard-coded at 3.** If Phase 2 benchmark sessions take too long, raise `DEFAULT_RUNNER_CONCURRENCY` in `schemas.ts`. The host can comfortably handle 5 concurrent `claude -p` subprocesses; 10 starts to thrash.

7. **The `Semaphore` class in `runner.ts` is reusable.** Phase 3's description optimizer fans out mutations the same way; lift the class into `src/forge/eval/concurrency.ts` if Phase 2-3 each grow their own runner files.

---

### Phase 2 — Benchmark aggregation (rc.99+)

**Goal:** when the user runs `/skill benchmark <name>`, fan out N runs per (prompt × configuration), aggregate pass-rate / latency / output-chars into mean ± stddev, and show variance + delta-vs-baseline in the viewer. Variance is the core unlock — Phase 1's single-run results can't tell signal from noise.

#### 5.A. Files to add / extend

| File | Action | Detail |
|------|--------|--------|
| `src/forge/eval/benchmark.ts` | **NEW** ~250 LOC | `computeBenchmark(session_id)` reads all `forge_eval_runs` + `forge_eval_assertions` for the session, groups by `(prompt_idx, configuration)`, computes per-(prompt × config) pass_rate stats and overall per-config aggregates. Returns `BenchmarkSummary`. Mean is straightforward; **stddev on small N (≤5) needs Bessel's correction (`/(n-1)` not `/n`)** — that's the math test trap |
| `src/forge/eval/schemas.ts` | extend | Add `BenchmarkSummary` + `RunStatistics` types. `RunStatistics = { mean: number; stddev: number; min: number; max: number; n: number }`. `BenchmarkSummary = { metadata: ...; per_prompt: Record<number, { with_skill: RunStatistics; without_skill: RunStatistics }>; overall: { with_skill: ...; without_skill: ...; delta: { pass_rate: string; duration_ms: string; output_chars: string }} }`. Mirrors upstream `benchmark.json` schema names exactly so a future export-to-upstream-format converter is trivial |
| `src/forge/eval/runner.ts` | extend | Raise `DEFAULT_RUNS_PER_CONFIG` 2→5. Add `runBenchmark()` as a thin wrapper around `startEvalSession()` that defaults to 5 runs/config and (per §5.5 #2) limits to 2 prompts unless `MAX_EVAL_CALLS_PER_RUN` is bumped |
| `src/forge/eval/db.ts` | extend | Add `getBenchmarkData(session_id)` → returns the joined runs/assertions data shaped for `computeBenchmark()`. Single query is preferable to N+1; use Knex `.join()` |
| `src/web/forge-evals-api.ts` | extend | Add `GET /api/forge/evals/:id/benchmark` returning `BenchmarkSummary` JSON. Per-chat scoping inherited from session check (already in place) |
| `src/web/public/forge/evals.html` | extend | Detail view (`?id=N`) gains an "Aggregate stats" panel above the per-run breakdown showing per-config mean ± stddev, delta-vs-baseline highlighted in green/red, + a "high uncertainty" badge when stddev > 30% of mean (sample-size flag) |
| `src/platforms/telegram.ts` | extend | New subcommand: `/skill benchmark <skill-name>` — same multi-line syntax as `/skill eval` (prompts → `---` → expectations) but with `runs_per_config: 5` default. Reuses the `eval` validator and runner |
| `tests/forge-eval-benchmark.test.ts` | **NEW** ~15 tests | Stddev correctness on N=2/3/5/10 (use Bessel's correction); zero-variance case (all runs identical → stddev=0); mean accuracy with float precision; delta string formatting (`+0.50`, `-0.10`, `±0.00`); high-uncertainty flag threshold; aggregate over multiple prompts; division-by-zero protection when N=0 or N=1 (stddev undefined for N<2 — what does the schema say? upstream uses 0; mirror that) |

#### 5.B. New TS interfaces (sketch)

```typescript
// src/forge/eval/schemas.ts (additions)
export interface RunStatistics {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  n: number;
}
export interface BenchmarkSummary {
  session_id: number;
  skill_name: string;
  generated_at: number;
  per_prompt: Record<number, {                                  // keyed by prompt_idx
    with_skill: RunStatistics;
    without_skill: RunStatistics;
  }>;
  overall: {
    with_skill: { pass_rate: RunStatistics; duration_ms: RunStatistics; output_chars: RunStatistics };
    without_skill: { pass_rate: RunStatistics; duration_ms: RunStatistics; output_chars: RunStatistics };
    delta: {
      pass_rate: string;          // e.g. "+0.50"
      duration_ms: string;
      output_chars: string;
    };
  };
}
```

#### 5.C. Open questions for Phase 2

- **Default `runs_per_config`: 5 (variance) or 3 (cap-friendly)?** Upstream uses ≥3 to surface variance. 5 is more robust but cap-tight. Lean 3 default, with 5 as the "I really want stddev" override.
- **Stddev when N<2:** undefined mathematically. Upstream returns 0; mirror that, but flag the result with `n: 1` so the viewer can show "single-run, no variance signal."
- **Retention.** Phase 1 deferred this. Phase 2 makes it more pressing because benchmark sessions accumulate quickly. Decision needed — see §6 Open Questions #1.
- **Concurrency raise (3→5)?** Phase 1 ran fine at 3. Phase 2's higher fan-out per session would benefit from 5 to keep wall-clock time reasonable, but adds host load. Recommend: keep 3 for individual sessions; if/when CI pipeline adds eval gates (out-of-scope for Phase 2), revisit.

**Estimated new code:** ~400 LOC TS + 15 tests + ~80 LOC HTML/CSS extension. **~2-3 working days.**

**Ships when:** `/skill benchmark antislop` runs 5 runs/prompt × 2 configs against a 2-prompt fixture, the viewer shows mean ± stddev for each, and the delta panel displays the with-skill-vs-baseline delta in human-readable form.

---

### Phase 3 — Description optimizer + blind comparator (rc.100+)

Two sub-features. They share infrastructure (the `Semaphore` from runner.ts, the `claude -p` subprocess pattern) but ship as distinct user-facing surfaces. Either can be done first; comparator is slightly simpler so consider that order.

#### 5.D. Sub-feature A — Blind comparator

**Goal:** given two versions of a skill (or one skill + a baseline), produce blind A/B judgments where an independent grader picks the winner without knowing which version produced which output.

**Files to add:**

| File | Action | Detail |
|------|--------|--------|
| `src/forge/eval/comparator.ts` | **NEW** ~300 LOC | `runComparison({ skill_a_name, skill_b_name, prompts, expectations, runs_per_pair })` orchestrator. For each prompt × run, generates outputs A and B, anonymizes them (random A/B mapping per pair), invokes the comparator prompt, parses the JSON winner verdict, persists |
| `src/forge/eval/prompts/comparator-upstream.md` | **NEW** verbatim | Apache-2.0 verbatim port of `agents/comparator.md` (already fetched in `/tmp/skill-source/comparator.md`, 202 lines). Same attribution header pattern as `grader-upstream.md` |
| `src/forge/eval/prompts/comparator-luna.md` | **NEW** ~150 lines | Runtime-used adaptation: inline outputs in user message instead of `output_a_path` / `output_b_path` filesystem paths. Same JSON-only output contract as grader-luna |
| `src/forge/eval/db.ts` | extend | New tables: `forge_comparisons` (session-level), `forge_comparison_pairs` (per-pair winner + reasoning + anonymization map). Same FK pattern as `forge_eval_*` |
| `src/web/forge-evals-api.ts` | extend | `GET /api/forge/comparisons` (list) + `GET /api/forge/comparisons/:id` (detail with anonymization revealed for the maintainer's view) |
| `src/web/public/forge/evals.html` | extend | New mode `?compare=N` shows comparison detail — paired outputs with the winner badge, comparator's reasoning, win-rate aggregate across pairs |
| `src/platforms/telegram.ts` | extend | `/skill compare <skill-a> <skill-b>` subcommand. Multi-line syntax for prompts + expectations |
| `tests/forge-eval-comparator.test.ts` | **NEW** ~12 tests | Anonymization correctness (no positional bias — random A/B mapping per pair, recorded for unblinding); winner JSON parsing (with `output_quality.A.score` / `output_quality.B.score` shape from upstream `comparison.json`); win-rate aggregation across N pairs; tie handling (upstream allows `winner: "tie"`); per-chat scoping on the new endpoints |

**Anonymization protocol (critical for unbiased results):**
- For each (prompt, run) pair, randomly map `(skill_a, skill_b)` → `(A, B)` or `(B, A)` with 50/50 probability.
- Pass outputs to the comparator labeled only as A and B.
- Persist the mapping in `forge_comparison_pairs.anonymization_map` so the maintainer's view can unblind for analysis.
- The comparator never sees the original skill names. Verify this with a test that grep-searches the comparator's input.

**Comparator output schema (Phase 3 subset of upstream `comparison.json`):**
```typescript
export interface ComparisonResult {
  winner: 'A' | 'B' | 'tie';
  reasoning: string;
  output_quality: {
    A: { score: number; strengths: string[]; weaknesses: string[] };
    B: { score: number; strengths: string[]; weaknesses: string[] };
  };
  // Phase 3 omits the upstream `rubric` (5-axis scoring) — adds complexity
  // without proportional value for our use case. Re-add if/when needed.
}
```

#### 5.E. Sub-feature B — Description optimizer

**Goal:** given a skill, mutate its `description` field (the auto-trigger description), score each mutation against a fixture set of "should fire on these messages / should not fire on those messages," keep mutations that improve trigger accuracy. The output is a proposed new description.

**Files to add:**

| File | Action | Detail |
|------|--------|--------|
| `src/forge/eval/description-optimizer.ts` | **NEW** ~350 LOC | `optimizeDescription({ skill_name, positive_fixtures, negative_fixtures, max_iterations, max_calls })`. Loop: (1) score current description against fixtures (each fixture is a message; positive = should trigger, negative = should not). Score = positive_match_rate × (1 - negative_match_rate). (2) Generate K mutations via `claude -p` with a "rewrite this description to be more discriminating" meta-prompt. (3) Score each mutation. (4) Keep best, repeat until convergence or max_iterations |
| `src/forge/eval/db.ts` | extend | New table: `forge_optimizations` (skill_name, baseline_score, final_score, baseline_description, final_description, iteration_count, total_calls). `forge_optimization_iterations` (per-iteration mutations + scores) |
| `src/forge/eval/prompts/description-mutator.md` | **NEW** ~80 lines | The meta-prompt instructing Claude to mutate a skill description. **No upstream verbatim port** — upstream's `improve_description.py` is procedural Python, not a prompt. Write fresh; cite the lineage in a header |
| `src/web/public/forge/evals.html` | extend | New mode `?optimize=N` shows optimization run — baseline vs final description side-by-side, iteration history, score-trajectory line chart |
| `src/platforms/telegram.ts` | extend | `/skill optimize-description <skill-name>` subcommand. Reads positive/negative fixtures from a multi-line message |
| `tests/forge-eval-optimizer.test.ts` | **NEW** ~10 tests | Score function correctness (positive match × (1 - negative match)); convergence detection (when do we stop?); cap enforcement (max_calls limits the iteration loop); mutation parsing from `claude -p` output (handle non-JSON responses gracefully — mutator returns text, not JSON); regression test: a known-bad description for `antislop` should be improved by ≥1 iteration |

**Score function (open for refinement during implementation):**
```
score(description) = (
  fraction_of_positives_correctly_matched   // ideally 1.0
  × (1 - fraction_of_negatives_incorrectly_matched)   // ideally 1.0
)
```
Range: [0, 1]. A description that fires on every positive AND no negatives = 1.0. A description that fires on no positives OR every negative = 0.0.

**Mutator constraint:** the mutated description must be ≤200 characters (Telegram-friendly) and must not change the skill's `name` or `id`. Test the constraint.

#### 5.F. Open questions for Phase 3

- **Comparator: how many runs per pair?** Upstream is silent. 1 is the minimum. 3 lets us aggregate "won 2/3" which is more robust. Each adds calls. Recommend: 1 for first ship, raise to 3 once we know how often comparator results agree across runs.
- **Optimizer: K mutations per iteration?** 3 is reasonable (small enough to be cheap, large enough to surface variation). Make it configurable; default 3.
- **Optimizer: max_iterations default?** Upstream is silent. 5 with early-stop on convergence (no improvement for 2 iterations) feels right. Cap-friendly: 5 iterations × 3 mutations × scoring = ≤30 calls per optimization run. Fits the 40-call cap.
- **Score-function tuning:** the multiplicative form penalizes false positives heavily. Some skills (like `careful`) want this. Others (like `brainstormer`, which suggests rather than auto-activates) might prefer a more lenient score. Per-skill score-function override? Defer to implementation; ship with the multiplicative default.
- **Description optimizer scope:** does it only touch `description` (the auto-trigger field) or also `systemPrompt`? Upstream's optimizer touches description only. Keep that scope; system-prompt mutation is what the comparator + benchmark loop is for (compare v1 vs v2 of the prompt manually).

**Estimated new code:** Comparator ~500 LOC + Optimizer ~600 LOC = ~1100 LOC TS + ~25 tests + ~150 LOC viewer extension. **~5-7 working days** total for both sub-features.

**Comparator ships when:** `/skill compare antislop council` (or two versions of the same skill) runs 3 prompt-pairs through the blind comparator and shows winners + reasoning + win-rate in the viewer.

**Optimizer ships when:** `/skill optimize-description antislop` runs 3 iterations, surfaces a candidate description that improves trigger-fixture score by ≥0.1 on a known-bad baseline, and shows the trajectory in the viewer.

---

### Phase 4 — Docs polish (rc.101+)

Pure documentation; no code change. Lands the eval pipeline as a first-class authoring concern in Luna's user-facing docs so pack authors and skill authors discover and use it.

#### 5.G. Files to refresh

| File | Section to add | Word count target |
|------|----------------|-------------------|
| `docs/customization-guide.md` | New § "Measuring skill quality" between current §"Documented Boundaries" and §"Troubleshooting". Walks through: define test prompts, define expectations, run `/skill eval`, read the viewer, iterate on the prompt. Concrete worked example using `antislop` against ~5 typical inputs. Mentions Phase 2 `/skill benchmark` for variance and Phase 3 `/skill compare` for v1-vs-v2 | ~800 words |
| `docs/pack-development-guide.md` | New § "Validating your pack" before § "Examples". Pack authors should `/skill eval` their pack's tools as they ship them. Same eval pipeline; pack-scoped skills work the same way as built-ins. Mentions the `/skill optimize-description` once Phase 3 ships | ~500 words |
| `docs/architecture.md` | Update existing § "Skill System" to mention the eval pipeline (cross-reference to customization-guide for usage; this doc covers the architecture only). One sub-section: "The forge_eval tables" with the 3-table relationship sketch | ~200 words |
| `docs/SKILL_AUTHORING_PLAYBOOK.md` | **NEW (optional)** | A walkthrough doc that takes a real authoring task (e.g., "I want a skill that summarizes meeting transcripts in <100 words") from blank slate → SKILL.md → test prompts → eval → iterate → optimize-description → ship. Same shape as ONBOARDING.md's worked examples. Skip if customization-guide gets thorough enough; revisit if pack authors ask for it | ~1500 words |

#### 5.H. Open questions for Phase 4

- **Is `SKILL_AUTHORING_PLAYBOOK.md` worth creating, or does the customization-guide refresh cover the same ground?** Lean toward "include the worked example INSIDE customization-guide §"Measuring skill quality" rather than spinning up a new top-level doc." Revisit if the section grows past ~1200 words.
- **Cross-reference density:** how aggressive to be about linking from architecture.md → customization-guide → SKILL_CREATOR_V2_INTEGRATION.md? Default: each doc links to the others' relevant section once at top, not throughout.
- **Cite Lehmann + Anthropic in the user-facing docs?** Phase 1 commit messages do this. The customization-guide is user-facing; lighter attribution (one sentence in the section opener: "The eval pipeline is adapted from Anthropic's skill-creator-v2 reference skill") feels right. Keep the heavy attribution in the source files and this integration doc.

**Estimated effort:** ~1-2 working days. Pure prose. No tests.

**Ships when:** customization-guide and pack-development-guide both have a "Measuring skill quality" / "Validating your pack" section; architecture.md mentions the eval pipeline; pre-commit + rebrand audit pass.

---

## 6. Open questions

Most of the original open questions were answered by Phase 1 actually shipping. The current open list:

### Resolved by Phase 1 (kept here for traceability)

- ~~**Python or TypeScript for eval scripts?**~~ Resolved: **TypeScript.** Phase 1 deploy confirmed Python is not in the Luna container (`docker compose exec luna which python3` returned nothing), so a TS port wasn't a preference but a hard requirement.
- ~~**Authentication on the viewer.**~~ Resolved: **webtoken-gated, per-chat scoped.** Cross-chat access returns 404 (not 403) to avoid leaking session existence. See `src/web/forge-evals-api.ts`.
- ~~**Original Python `eval-viewer/` — vendor or recreate?**~~ Resolved: **recreated in Luna's existing HTML/CSS pattern.** `src/web/public/forge/evals.html` is single-page vanilla JS, matches `/board` + `/learn` aesthetic.
- ~~**License compatibility.**~~ Resolved: Apache 2.0 verbatim attribution preserved in `prompts/grader-upstream.md`; adapted version (`grader-luna.md`) cites the lineage. Attribution headers in each ported `.ts` file. **The repo still doesn't ship a top-level LICENSE — open lift, see #4 below.**
- ~~**What's the trigger to start Phase 1?**~~ Resolved: shipped 2026-04-29 ahead of NovaLink bridge / attendance Phase B because both slipped beyond Phase 1's natural window.

### Still open — affect Phase 2-4 scope

1. **Storage retention policy.** Phase 1 made this more pressing than Phase 0 anticipated; Phase 2 makes it acute (benchmark sessions accumulate quickly). Decision still needed. Options:
   - (a) Keep last N runs per skill (default N=10) — bounded growth, predictable
   - (b) Auto-prune runs older than 90 days — calendar-bounded, simpler to explain
   - (c) Keep forever, ship a `/skill eval prune` admin command — defers the policy to the maintainer
   Recommendation: **(a) with N=10** as the rc.99 default; revisit when actual usage data shows whether the cap is hit.

2. **Fan-out scale at Phase 2.** Default `runs_per_config` raises 2→5 (or 3?) — see §5.C and §5.5 #2. The 40-call cap forces a runs-vs-prompts tradeoff. Decision needed before Phase 2 ships:
   - 5 runs × 2 prompts × 2 configs × 2 = 40 (cap-tight, robust stddev, only 2 prompts)
   - 3 runs × 4 prompts × 2 configs × 2 = 48 (over cap unless `MAX_EVAL_CALLS_PER_RUN` is bumped)
   - 3 runs × 3 prompts × 2 configs × 2 = 36 (under cap, less robust stddev)
   Recommendation: **default 3 runs × 3 prompts**; raise `MAX_EVAL_CALLS_PER_RUN` env in production deployments where benchmarks are run weekly (rate-limit headroom permitting).

3. **Concurrency raise (3→5)?** Phase 1 ran fine at 3. Phase 2's higher fan-out per session would benefit from 5 to keep wall-clock time reasonable. But host load matters — `claude -p` subprocess has non-trivial CPU + memory footprint. Recommendation: **keep 3 unless wall-clock complaints surface.**

4. **Top-level LICENSE.** The Luna repo doesn't have a `LICENSE` file at the root. We've shipped Apache 2.0 attribution in source files for skill-creator-v2 ports, but the repo's own license isn't declared. **Worth fixing in Phase 4 (or sooner)** — pick a license, drop a `LICENSE` file at the root, and audit dependency licenses for compatibility.

5. **CI integration.** Hooking the eval pipeline into pre-commit / pre-push / GitHub Actions so skill changes can't ship without passing benchmarks. Out of scope for Phase 2-4 as scoped here, but worth flagging as the natural Phase 5+ item once we have a stable corpus of test prompts.

6. **Eval prompt corpus management.** A shared library of test prompts for common skill categories (debugger prompts, summarizer prompts, brainstormer prompts, etc.) so authors don't have to invent their own from scratch every time. Worth doing once we have ≥3 skills with documented eval test sets. Defer.

7. **Multi-model evaluation.** Upstream's Karpathy methodology dispatches to multiple model providers. Luna has Claude + Ollama; Phase 1 grades only with Claude (via `claude -p`). A future phase could add Ollama-as-grader for cost-free evals against a less-capable but always-available local model. Not blocking; revisit when Claude rate-limit headroom becomes a real constraint.

---

## 7. Out of scope (intentionally deferred)

- **Multi-model evaluation.** The original Karpathy methodology dispatches to multiple model providers. Luna only has Claude + Ollama; the eval runner can be extended to grade both providers but the initial port focuses on Claude self-comparison.
- **CI integration.** Hooking the eval pipeline into pre-commit / pre-push so skill changes can't ship without passing benchmarks. Possible later; would require lower-cost evals (cached runs, fewer models) to be tolerable in CI.
- **Eval prompt corpus management.** A shared library of test prompts for common skill categories (debugger prompts, summarizer prompts, etc.). Worth doing once we have ≥3 skills under eval.
- **The `assets/` HTML description-review UI.** Could be ported but adds 2-3 days of UI work for a feature that's only used during description optimization. Defer to Phase 3 polish.

---

## 8. References

- Upstream: https://github.com/olelehmann1337/marketing-os-workshop/tree/main/plugins/marketing-os-workshop/skills/skill-creator-v2 (Apache 2.0)
- Upstream is itself adapted from Anthropic's reference `skill-creator` skill
- Companion ports (rc.97): `antislop` and `council` (`src/skills.ts` BUILTIN_SKILLS)
- Existing Luna forge surface: `src/forge/` (skill registry, safety scanner)
- Luna provider invocation pattern: `src/providers/claude.ts` (`claude -p` subprocess), `src/providers/ollama.ts` (agentic loop)
- Web auth pattern this would inherit: `src/web/web-tokens.ts`
- Prior PLANNED-doc precedent: `docs/NOVALINK_BRIDGE_INTEGRATION.md` (rc.96)

---

## 9. Sprint sequencing — current state

Phase 1 shipped 2026-04-29 (rc.98). The team approved the full 4-phase commitment: rc.99 = Phase 2, rc.100 = Phase 3, rc.101 = Phase 4. **rc numbers may shift** if NovaLink bridge integration, attendance Phase B wiring, or other priority work consumes those slots in the meantime — treat them as ordered phase slots, not absolute pins.

**Scheduled reminder:** `trig_01QTwcxnJgkxjUqdajsgaLrG` fires 2026-05-09T15:00:00Z (= 9am America/Mexico_City) to surface a "what was pending when you set this" reminder. The reminder agent does NOT do the readiness check itself — the human + a fresh Claude Code session do that on the day, with `/usage` data + this doc in hand.

**Earliest viable Phase 2 start:** 2026-05-13 (rc.97 antislop + council shipped 2026-04-28 + 2 weeks of usage data). Earlier is possible but produces a synthetic test corpus rather than a usage-grounded one.

### How to start Phase 2 (or any subsequent phase)

The pattern that worked for Phase 1:

1. **Read this doc** — specifically §5 for the phase you're starting, §5.5 for the Phase 1 lessons, §6 for open questions you'll need to resolve.
2. **Re-grep Phase 1 source** — `src/forge/eval/`, `src/web/forge-evals-api.ts`, `tests/forge-eval.test.ts` are the patterns the new phase extends. Don't invent a new pattern unless the doc explicitly says to.
3. **Surface scope confirmation to the user before coding** — propose the phase's file list, OQ resolutions, and rc number. Get explicit approval per `feedback_iterative_rc_workflow`.
4. **Ship per the standard rc cadence** — typecheck → vitest → smoke → commit → push → docker rebuild → recreate → live verify. Don't skip the docker rebuild; the container runs from `dist/`.
5. **Update this doc** when the phase ships — flip its status from `⏳ pending` to `✅ shipped rc.X` with a one-line summary, and crystallize any newly-resolved open questions into "Resolved" entries in §6.

### What stays out of scope

See §7. The big ones: multi-model eval, CI gating, shared test-prompt corpus, top-level LICENSE file. None of these block Phase 2-4; revisit once Phase 4 ships and the eval pipeline has actual usage data.
