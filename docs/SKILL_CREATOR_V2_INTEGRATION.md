# skill-creator-v2 — Luna Integration Spec

**Status:** PLANNED. Not yet integrated. The work described here adopts and adapts Anthropic's `skill-creator-v2` (originally upstream of `olelehmann1337/marketing-os-workshop`, Apache-2.0) into Luna's `src/forge/` so Luna can build, eval, benchmark, and iterate skills with measurable quality signals — not just prompt-craft intuition.

**Scope:** all Luna deployments. Skill-engineering tooling is generic; it has zero domain coupling. Lives under `src/forge/eval/` (new submodule alongside the existing forge surface).

**Companion:** rc.97 ships the upstream pure-prompt skills `antislop` and `council` from the same workshop. This doc is the plan for the heavier code-bearing skill from that suite.

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

The work breaks into 4 phases. Each is independently shippable; later phases compound on earlier ones.

### Phase 1 — Eval runner + grader + viewer (rc.X)

The minimum that delivers user-visible value. After this rc, a user can write a Luna skill, define test prompts, run with-skill vs baseline, see graded results in a web viewer.

- `src/forge/eval/runner.ts` — fan out via `claude -p` subprocess with per-run isolation (separate session IDs, fresh memory)
- `src/forge/eval/grader.ts` — invoke the upstream grader prompt against each run's assertions; persist grades to DB
- `src/forge/eval/schemas.ts` — TS port of the upstream JSON schemas (`assertions`, `grading`, `benchmark`)
- `src/forge/eval/prompts/grader.md` — verbatim from upstream
- New DB tables: `forge_evals` (run_id, skill_id, created_at, status), `forge_eval_runs` (run_id, prompt_idx, with_skill, output, latency_ms, tokens), `forge_eval_assertions` (run_id, assertion_text, passed, evidence)
- New web routes: `GET /forge/evals` (list), `GET /forge/evals/:id` (detail with side-by-side outputs)
- New Telegram subcommand: `/skill eval <skill-name> --prompts <file or inline>`
- Tests: subprocess spawning, schema validation, grader prompt correctness, viewer routing

**Ships when:** running `/skill eval debugger --prompts tests/forge/debugger-prompts.md` produces graded results visible in the web viewer.

### Phase 2 — Benchmark aggregation (rc.X+1)

- `src/forge/eval/benchmark.ts` — aggregate per-run grades into pass_rate/latency/tokens with mean±stddev across N runs (the upstream uses ≥3 runs per prompt to surface variance)
- Extension to viewer: aggregate-stats panel + delta vs baseline highlighted
- New Telegram subcommand: `/skill benchmark <skill-name> --runs 5`
- Tests: benchmark math (especially stddev correctness on small N), aggregate rendering

### Phase 3 — Description optimizer + blind comparison (rc.X+2)

- `src/forge/eval/description-optimizer.ts` — trigger-eval loop: mutate the skill's description text, re-score against trigger fixtures, keep mutations that improve trigger accuracy
- `src/forge/eval/comparator.ts` — blind A/B between two skill versions (independent grader sees outputs without labels, picks winner)
- `src/forge/eval/prompts/comparator.md` + `analyzer.md` — verbatim from upstream
- Telegram: `/skill optimize-description <skill-name>` and `/skill compare <skill-a> <skill-b>`
- Viewer: third page for compare view

### Phase 4 — Polish + docs (rc.X+3)

- Refresh `docs/customization-guide.md` with a "Measuring skill quality" section that uses the eval pipeline as the reference workflow
- Refresh `docs/pack-development-guide.md` to mention `/skill eval` as the way to validate pack tools and skills
- Maybe a `docs/SKILL_AUTHORING_PLAYBOOK.md` that walks through "create → write test prompts → eval → iterate → optimize description → ship" as a concrete worked example. Optional.

---

## 6. Open questions

1. **Python or TypeScript for the eval scripts?** I argued for TS in §3 (one runtime, native types, integration with forge). Counter-argument: Python port costs 1-2 days to recreate work that's already done. I'd still prefer TS for long-term maintenance, but if you'd rather move fast in Phase 1 and revisit, that's defensible.
2. **Fan-out scale.** The original spawns ~3-5 with-skill + 3-5 baseline runs per prompt. At 10 prompts × 10 runs × 2 versions = 200 `claude -p` calls per benchmark. That's significant subscription rate-limit pressure. **Decision needed:** cap at 3 runs per prompt by default (faster, less rate pressure, slightly less robust stddev), with a `--runs N` override for users who really want it.
3. **Storage retention.** Eval runs include full prompt + full output text. Multiplied across versions over time, this could grow `store/luna.db` substantially. **Decision needed:** retention policy. Options: (a) keep last N runs per skill, (b) auto-prune runs older than 90 days, (c) keep forever and let the user vacuum. Probably (a) with N=10 as default.
4. **Authentication on the viewer.** Eval results contain the full text of test prompts and outputs. These could include sensitive content (manufacturing data, attendance records, etc.) depending on what users put in test prompts. **Decision:** webtoken-gated like every other Luna web route, with the additional rule that a user can only see eval runs they triggered (chat_id scoping, same as kanban).
5. **Original Python `eval-viewer/`.** It's well-built and produces a good UX. Tempting to vendor it under `src/web/public/forge/eval-viewer/` and call it from Python invoked via the container. Trade-off: we keep the upstream maintainability win, lose the integration with Luna's auth + DB model. I lean against vendoring; recreate the views in Luna's existing HTML/CSS pattern (same look-and-feel as `/board`, `/learn`, `/sim` pages).
6. **License compatibility.** Apache 2.0 (skill-creator-v2) is compatible with whatever license Luna uses (the repo doesn't currently ship a top-level LICENSE — worth fixing while we're touching legal). Attribution at the top of each ported file: "Adapted from skill-creator-v2 (Apache 2.0). Original behavior preserved; mechanism adapted for Luna's runtime."
7. **What's the trigger to start?** Phase 1 takes ~3-5 days of focused work. Worth scheduling once: (a) the NovaLink bridge sprint completes (rc.97-99), (b) the attendance pilot Phase B wiring lands, or (c) at any point either of those slips. I'd argue start when there's a real Luna skill we want to measure quality on — likely the attendance digest delivery skill once Phase B ships.

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

## 9. Decision asked

This doc is the plan, not the implementation. Two decisions for the user:

1. **Approve the phased structure** as described, or push back on phasing (e.g., "ship phase 1 only and reassess").
2. **Sequence:** do you want this scheduled before/after specific other work? My default is "after rc.97 ships and the attendance Phase B wiring lands" — pick this up when there's a non-trivial Luna skill worth measuring quality on.

No code written from this doc. Next action: at any time, say "start Phase 1 of skill-creator-v2 integration" and I'll come back with a concrete rc proposal scoped to the runner + grader + viewer slice.
