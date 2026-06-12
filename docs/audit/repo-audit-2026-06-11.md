# Luna Repository Audit — 2026-06-11

Four-phase audit (discovery → evidence-based findings → strategy → task plan). Analysis only; no code was modified. All claims are grounded in file:line citations from rc.112 (`main` @ 62d091c); anything unverifiable is labeled as such. Severity is calibrated to the project's actual maturity: a single-operator personal/departmental assistant in production-like use, not a multi-tenant SaaS.

---

## Executive Summary

**Overall health grade: B−.** The core architecture is genuinely strong — a registry-based Application core, a real (not cosmetic) 3-process isolation model, an honored StorageProvider abstraction, and serious security engineering (worker sandbox, SSRF filters, spawn-array subprocess calls, pre-commit secret scanning) — and 2,705 passing tests is exceptional for a personal project. The grade is dragged down by three systemic gaps rather than any single defect. First, **nothing is enforced automatically**: there is no CI, no linter, and no formatter, so the entire 63k-line codebase across 112 release candidates has been gated only by discipline on one developer machine. Second, **`src/platforms/telegram.ts` (4,475 lines) has become the system's de-facto orchestrator**, absorbing policy confirmation, learning sessions, CSV ingestion, and skill healing — which is why Matrix sits at 31% of Telegram's size with permanent feature lag. Third, **test coverage is inverted relative to risk**: deterministic calculation modules are superbly tested while the concurrent boundary layers (IPC, web API/auth surface, FSM codegen) have effectively zero tests. Top 3 risks: regressions shipping unverified (no CI), an untested web/auth surface exposed via Docker, and 9 known dependency vulnerabilities (1 critical) fixable with `npm audit fix`. Top 3 opportunities: a half-day CI workflow that converts the existing test suite into a real safety net; extracting a platform-agnostic message orchestrator that unblocks Matrix/Web parity; and consolidating the four overlapping deployment guides plus auto-deriving version/test/tool counts so docs stop drifting every RC.

---

## Phase 1 — Repo Map

**Purpose.** Build system and source for **Luna** — a personal AI assistant daemon bridging Telegram/Matrix/web-voice to Claude CLI and Ollama, with local voice (Speaches), dual-sector memory (FTS5 + sqlite-vec), scheduled/proactive tasks, a policy engine for tool risk, user-extensible tools/skills ("Forge"), department Domain Packs, and a full manufacturing-engineering analytics suite (six sigma, line balance, FMEA, RCA, inventory, kanban, CONWIP, TOC, VSM, DOE, simulation).

**Stack.** TypeScript 6 (strict, ES2022, NodeNext ESM), Node 26, better-sqlite3/Knex (SQLite default; MariaDB/PostgreSQL capable), grammy (Telegram), @vector-im/matrix-bot-sdk, pino, vitest (2,705 tests / 128 files), Docker (4-service dev compose; 11+-service production compose with Caddy/MariaDB and per-deployment profiles).

**Architecture sketch.** `src/index.ts` (540 lines) composes an `Application` (src/core/app.ts) by registering a storage provider, 16 table initializers, ~12 subsystems, and 3 platforms (Telegram, Matrix, Web). Platforms receive a `PlatformContext` facade (src/core/context.ts, 591 lines, 24 subsystem bags). AI calls route through `src/providers/router.ts` (1,452 lines) to Claude (spawned `claude -p`) or Ollama. Three OS processes via `fork()`: core (only one with DB access), tools (network/compute), parsers (file I/O only), with env-whitelisting and heartbeat/restart management in src/ipc/.

**Key directories.**

| Path | What it is |
|---|---|
| `src/` (208 files, ~63k lines) | Daemon. `core/` app+context+interfaces; `platforms/` telegram (4,475 ln) + matrix (1,402 ln); `providers/` router + claude/ollama + ~40 tool files; `ipc/` process client/server; `web/` HTTP+WS server, 11 dashboard APIs (~4.8k ln); `forge/` user tool/skill creation + worker sandbox; `learning/`, `fsm/`, `simulation/`, plus large root-level manufacturing modules (sigma.ts 61K, skills.ts 55K, capabilities.ts 44K, balance.ts 37K, rca.ts 35K, db-core.ts 35K) |
| `tests/` (129 files, ~37k lines) | Vitest suite, 2,705 tests |
| `packs/` | 10 department/client Domain Packs (manufacturing, finance, hr, novalink, …) |
| `docs/` (~27 files, ~660K) | Architecture, security model, 4 deployment guides, runbooks, audits |
| `prompts/`, `reference/` | Build-phase scaffolding (now historical) and pinned decisions |
| `docker/`, `scripts/` | Dockerfiles, compose env overrides (no secrets — verified), setup/smoke/health scripts |
| `store/`, `workspace/` | Runtime data, gitignored (only `.gitkeep` tracked — verified via `git ls-files`) |

**Surprises.** (1) Scope is far beyond the CLAUDE.md description — this is a manufacturing-engineering platform wearing a chatbot's clothes. (2) No CI of any kind despite 112 RCs and 2,705 tests. (3) `prompts/00-README.md` admits the per-phase prompt files "were never authored" — the build system the repo describes itself as is historical fiction. (4) README announces rc.86 while package.json is rc.112; zero git tags exist.

---

## Phase 2 — Audit Report

Findings grouped by dimension, sorted by severity. Each is labeled **FACT** (verified in code) or **JUDGMENT** (assessment). Severities below reflect my calibration after cross-checking the dimension agents' raw reports (several were adjusted down with reasons noted).

### Architecture & Design

- **[HIGH, FACT+JUDGMENT] telegram.ts is the system's real orchestrator (god file).** `src/platforms/telegram.ts` is 4,475 lines (verified `wc -l`). `handleMessageInner` (telegram.ts:156–607, ~451 lines, est. cyclomatic complexity ~35) sequentially handles auto-skill proposals (:167), tool-policy confirmation (:180), skill self-healing (:212), a 145-line learning-session state machine (:231–375), orchestration checks (:377), and the main AI flow with structured actions, file sending, and TTS (:436–598). Five domain CSV ingestion handlers (attendance/FMEA/inventory/sigma/balance, ~:3000–3400) live here too. *Why it matters:* every cross-cutting feature must be re-implemented per platform; bugs in learning/policy surface as "Telegram bugs"; none of these flows can be tested without grammy mocks.
- **[HIGH, FACT] Matrix is permanently behind because of the above.** `src/platforms/matrix.ts` is 1,402 lines (31% of Telegram) and lacks CSV uploads, skill-proposal handling, and full learning flows — direct evidence the shared logic was never extracted.
- **[MEDIUM, JUDGMENT] PlatformContext is a 24-bag facade.** `src/core/context.ts` (591 lines) hands platforms access to ~24 subsystems (router, memory, skills, tools, forge, policyEngine, learning, …). It's typed and compile-safe (a strength), but it makes platform↔subsystem dependencies invisible and lets adapters reach anything.
- **[MEDIUM, FACT] router.ts mixes provider routing with message orchestration.** `src/providers/router.ts` (1,452 lines) handles provider selection, continuity bridging, tool execution, memory seeding, and usage tracking in one class — adding a provider means understanding all of it.
- **[MEDIUM, FACT] SQLite single-writer constraint is real but invisible to operators.** `src/db-knex.ts:90–117` hardcodes `pool {min:1,max:1}` for SQLite with comments about Docker virtiofs WAL issues; no startup warning or migration guidance for write-contention symptoms. *Relevance raised by the owner's deployment decision (2026-06-11): the production target is now a dedicated MacBook Pro running Docker — i.e., Docker Desktop on macOS, exactly the virtiofs environment the code's own comments warn about for WAL sidecar files. The first macOS-server deployment should explicitly verify WAL behavior on a bind-mounted store/ (or use a named volume) before go-live.*
- **[LOW, FACT] In-memory `voiceModeChats` Set (telegram.ts:18)** loses all per-chat voice-mode state on restart.

**Strengths:** Application registry lifecycle is clean and typed (src/core/app.ts:22–289, interfaces.ts); the 3-process separation is *real* — `tools-process.ts` and `parsers-process.ts` import no DB modules, with env whitelisting (src/ipc/env-whitelist.ts), heartbeat (10s/3-miss), exponential-backoff restarts (src/ipc/client.ts:50–394); StorageProvider is honored — no module bypasses Knex to hit better-sqlite3 directly; table initializers invert control so 16 domains register their own schema without a db.ts monolith.

### Code Quality

- **[HIGH, FACT] Dozens of fully silent catch blocks, beyond the "log and continue" convention.** Examples with *zero* logging: `src/packs.ts:171` (`catch { return true; }` — pack defaults to *enabled* on DB error), packs.ts:282 (tuning silently dropped), `src/attendance/sources/selector.ts:123` (sensor init failure → null), `src/memory.ts:67,102,218,287,479`, `src/db-knex.ts:27` (sqlite-vec load failure → vector search silently off), `src/db-core.ts:930–942` (search errors → `[]`, indistinguishable from "no results"), telegram.ts:366,594 (HTML-parse fallback with no debug log). *Why it matters:* Convention #6 says "log and continue"; these continue without logging, so degraded features are undiagnosable.
- **[MEDIUM, FACT] Complexity hotspot:** `handleMessageInner` (above) is the worst; one try/catch at telegram.ts:599 wraps ~450 lines.
- **[MEDIUM, FACT] Type-safety holes are few but clustered:** ~26 `any` usages total; worst cluster is `src/tools-process.ts:58–77` where ~15 tool exec lambdas take `(args: any)`, severing the link between a tool's declared parameters and its implementation. Zero `@ts-ignore` in the codebase (one justified `@ts-expect-error`).
- **[LOW, FACT] formatForTelegram / formatForMatrix are ~95% duplicated** (telegram.ts:36–98 vs matrix.ts:34–80, differing in `<b>` vs `<strong>` and newline handling) — formatting fixes must be applied twice.

**Strengths:** strict TS respected; no `console.*` in daemon code (pino throughout, with trace IDs via src/trace.ts); process-level unhandledRejection/uncaughtException handlers (src/core/app.ts:279–286); no critical floating promises found in sampled hot paths.

### Security

- **[HIGH, FACT] 9 known dependency vulnerabilities; fix available.** `npm audit` (run 2026-06-11): 1 critical (sanitize-html 2.17.3, XSS via `<xmp>`, GHSA-rpr9-rxv7-x643 — transitive, not directly imported), 1 high (tmp <0.2.6 path traversal, GHSA-ph9p-34f9-6g65 — transitive), 7 moderate (incl. ws 8.x uninitialized memory disclosure, GHSA-58qx-3vcg-4xpx — ws *is* directly used for voice WebSockets in src/web/). All marked "fix available via `npm audit fix`". (Note: one sub-report rated ws "critical" and cited an express/qs issue; npm classifies ws as *moderate* and express is not a dependency — corrected here.)
- **[MEDIUM, FACT] DDL built by string interpolation in db-dialect.ts.** `createFullTextSearch()`/`createVectorTable()` interpolate table/column names into `db.raw()` (src/db-dialect.ts:66–128, 237–238). All current callers pass hardcoded names (db-core.ts:213, 332, 353–354), so this is **not exploitable today** — it's a latent footgun. A one-regex identifier whitelist removes the class of risk.
- **[WITHDRAWN 2026-06-11 — finding was wrong]** ~~Empty `VOICE_WEB_TOKEN` would authenticate anyone.~~ Re-verified during remediation: the legacy-token branch at src/web/server.ts:252 is guarded by `config.VOICE_WEB_TOKEN &&` (empty string is falsy, branch never runs), and an empty candidate token is rejected with 401 earlier at server.ts:237. No bypass exists. Replaced with a real hardening: startup now rejects a configured legacy token shorter than 16 chars (brute-forceable past the rate limiter) — src/index.ts config validation.
- **[MEDIUM, FACT] FTS5 MATCH accepts unbounded user query strings** (src/db-dialect.ts:156–162). Parameterized (no injection), but FTS5 operator abuse (`*`, nested OR) can cause expensive queries — no length/complexity cap.
- **[LOW, FACT] Unregistered tools default to `medium` risk, no confirmation** (src/policy-engine.ts DEFAULT_POLICY). All built-ins have explicit policies, so this only bites future additions.
- **[LOW, FACT] Web rate limiter keys on raw socket IP** (src/web/server.ts:102–142) — behind the documented Caddy reverse proxy every client is one IP; mitigated by the default 127.0.0.1:3030 bind.
- **[LOW, JUDGMENT] Claude subprocess env is blacklist- not whitelist-based** (src/providers/claude.ts:36–44 strips the three ANTHROPIC_* vars but passes everything else).
- **Verified clean:** no secrets in any tracked file — `docker/.env.docker` contains only internal Docker URLs; pre-commit hook (.githooks/pre-commit) scans a broad key-pattern set and is installed via `core.hooksPath`; `claude` is spawned with an args array, never shell-interpolated (claude.ts:60–92); path traversal blocked by resolve-then-prefix-whitelist in file tools; dual independent SSRF filters (src/forge/worker-entry.ts `isBlockedUrl()`, src/providers/tools/summarize-url.ts) cover RFC-1918, link-local, cloud metadata, and `file://`; worker sandbox enforces 64MB memory, adaptive heartbeat timeout, and strict-mode `new Function` isolation; all DML is parameterized via Knex; web server sets CSP, X-Frame-Options DENY, nosniff, Permissions-Policy, and two-tier auth-failure rate limiting.

### Testing

- **[CORRECTED 2026-06-11 — overstated; real gap is narrower]** ~~The IPC layer has zero tests.~~ tests/sa3-integration.test.ts and tests/combined-sa-integration.test.ts fork *real* child processes and cover spawn/ready, IPC tool round-trips, concurrency, clean shutdown, cross-process tool rejection, and env-whitelist isolation. The genuine gaps were crash→restart/backoff, heartbeat-miss handling, and pending-request timeout — closed during remediation (tests/ipc-resilience.test.ts).
- **[CORRECTED 2026-06-11 — overstated; real gap is narrower]** ~~The web API/auth surface has zero direct tests.~~ tests/voice-web.test.ts (53 tests: session flows, WS handler states) and tests/web-tokens.test.ts (token CRUD/validation/revocation/TTL) existed. The genuine gap was the HTTP-level request contract — 401 behavior, legacy-token path, auth-failure rate limiting/ban, Origin validation — closed during remediation (tests/web-auth.test.ts).
- **[HIGH, FACT] vitest coverage config references a file that no longer exists.** vitest.config.ts:13 includes `'src/db.ts'`; the file was split into db-core/db-knex/db-dialect (verified: `src/db.ts` does not exist). db-dialect.ts (the cross-dialect SQL layer) is consequently outside the coverage manifest.
- **[MEDIUM, FACT] FSM codegen untested.** src/fsm/codegen.ts (293 lines) generates TypeScript; no test validates the generated code compiles or matches the FSM definition.
- **[MEDIUM, FACT] Real-timer sleeps in async tests.** Hardcoded `setTimeout` waits in tests/ws-integration.test.ts:389–434, tests/worker-sandbox.test.ts:91–169, tests/background-tasks.test.ts:40–97 — brittle on slow runners (and will matter the day CI exists).
- **[MEDIUM, JUDGMENT] Learning-module tests assert "doesn't throw" more than behavior** (tests/learning.test.ts, 76 cases, heavy mocking) — spaced-repetition interval math is not directly validated.

**Strengths:** db-core/db-knex tests run against real SQLite with real assertions (tests/db-core.test.ts, 608 lines); the calculation suite (balance, sigma, capacity, conwip, doe, inventory, sequencer) validates math end-to-end from CSV to output; policy-engine tests use real DB state across 150+ assertions; consistent `vi.hoisted` mock strategy with reliable per-test isolation; 2,705 tests is a real asset — the problem is *where* they aren't, not their quality where they exist.

### Performance

(Calibrated for a single-operator daemon — none of these are incidents today.)

- **[MEDIUM, FACT] Per-memory UPDATE loop on the hot message path.** src/memory.ts:140–147 issues one salience-bump UPDATE per retrieved memory (up to 5 round-trips per message); trivially batchable into one `WHERE id IN`.
- **[MEDIUM, FACT] Missing indexes on queried FK columns:** `chat_skills.skill_id` (db-core.ts:256–263) and `skill_revisions.skill_id` (db-core.ts:275–283; queried at :832) have foreign keys but no index — table scans, cheap to fix.
- **[LOW, FACT] `readFileSync` per generated file on the reply path** (telegram.ts:563) blocks the event loop while sending AI-generated files; `Promise.all` + `fs.promises` is a drop-in fix.
- **[LOW, FACT] Decay sweep iterates chats sequentially** (memory.ts:333–369) — fine at current scale, runs on a 24h background interval.

### Dependencies

- **[MEDIUM, FACT] The vulnerable set above** is the only urgent item; everything is transitive and auto-fixable.
- **[LOW, FACT] Override rationale is undated.** package.json `overrides` pins tough-cookie/form-data/qs/uuid; reference/dependency-versions.md:10 mentions "neutralize the CVE chain" from matrix-bot-sdk but cites no CVE IDs or dates — impossible to know when the pins can be dropped.
- **[LOW, FACT] Dead weight, deliberate trade-offs:** `openai` (~3MB) is used only as the Speaches client (src/voice.ts:1); both mysql2 *and* pg ship while SQLite is default. Reasonable for a server-side daemon; not worth churn.
- **[LOW, FACT] reference/dependency-versions.md says Node ≥20**; package.json and .nvmrc say 26 — stale.

### DevEx & Operations

- **[CRITICAL, FACT] No CI of any kind.** No .github/, .gitlab-ci.yml, or .circleci (verified). 2,705 tests, typecheck, and the dist smoke run only when a developer remembers to. Zero git tags across 112 RCs. *This is the single highest-leverage gap in the repo* — the safety net already exists, it's just not wired to anything.
- **[HIGH, FACT] No lint/format enforcement.** No eslint/prettier/biome config anywhere; the only gate is the secret-scanning pre-commit hook. 63k lines and growing with style held together by habit.
- **[MEDIUM, JUDGMENT] Deployment is runbook-driven, not scripted.** scripts/add-deployment.sh only scaffolds dirs/env; the actual InMotion procedure is a 40K human-readable doc. Error-prone per-instance drift.
- **[MEDIUM, FACT] Startup config validation is minimal.** .env.example is 449 lines; src/index.ts validates only the platform-token essentials, so most misconfiguration surfaces at runtime, not startup.
- **[LOW, FACT] Observability is local-only:** healthcheck endpoint + Docker log rotation exist (good); no alerting hook for restarts/error-rate (acceptable at this maturity; note it, don't build it yet).

### Documentation

- **[HIGH, FACT] Version/metric drift across the corpus.** README.md:3 says rc.86; package.json says rc.112; ONBOARDING.md says rc.95; CLAUDE.md says 2,704 tests/128 files; architecture.md and ONBOARDING say 2,367/107; actual is 2,705/128. Tool counts *appear* to disagree (README "49+", CLAUDE.md "43 classified", ~33 in the tools-process registry) — **resolved with the owner 2026-06-11: 49+ is correct** and refers to all builtin tool definitions (48 `*Definition` exports in src/providers/tools/ alone, plus pack tools); 33 counts only the tools-process subset and 43 was the risk-classified count when SA4 was written. Remaining fix: each doc should say *which subset* it counts.
- **[HIGH, FACT] Four overlapping deployment guides** (deployment-guide.md, deployment-runbook.md, inmotion-deployment-guide.md, deployment-checklist.md ≈ 97K combined) repeat database setup three times with diverging defaults — sync burden guarantees future contradictions.
- **[MEDIUM, FACT] prompts/ is self-declared fiction.** prompts/00-README.md states the phase files "were never authored", yet CLAUDE.md still instructs contributors to "read the corresponding prompts/XX-*.md". Onboarding dead-end.
- **[LOW, JUDGMENT] CLAUDE.md's RTK section describes the author's machine-local tooling** — correct for this user (rtk genuinely is installed here), but misleading for anyone else cloning the repo.

**Strengths:** the docs corpus is extraordinary for a personal project — a real threat model (docs/security.md), ADRs, competitive assessment, per-platform runbooks; PROJECT_PLAN.md's checkbox-per-phase discipline made a 26-phase build tractable; reference/decisions.md prevents relitigating settled choices.

### The ugly parts, named plainly

1. **No CI** — everything else on this list is partially excused by maturity; this isn't, because the tests already exist.
2. **telegram.ts** — 4,475 lines, six subsystems' worth of orchestration inside a platform adapter, the root cause of Matrix lag and the hardest-to-test code in the repo.
3. **Untested IPC + web/auth layers** — the two places concurrency bugs and security regressions actually live.
4. **Doc drift on autopilot** — three different test counts and three different tool counts are live in the repo right now.

---

## Phase 3 — Improvement Strategy

**Theme 1: Verification exists but isn't enforced.** (Explains: no-CI, no-lint, stale coverage path, untagged releases, doc metric drift.) *Target state:* every push runs typecheck + tests + smoke in CI; releases are tagged; derived numbers (version, test count) are generated, not hand-written. *Principle:* a safety net you must remember to use is not a safety net.

**Theme 2: The platform adapter became the application.** (Explains: telegram.ts god file, Matrix feature lag, formatter duplication, CSV handlers locked to one platform, PlatformContext over-breadth.) *Target state:* a platform-agnostic message orchestrator owns policy confirmation, learning sessions, auto-skill flows, and CSV ingestion; platforms shrink to transport + formatting. *Principle:* platforms are I/O adapters; anything two platforms need is not platform code.

**Theme 3: Tests follow ease, not risk.** (Explains: superb calc coverage vs. zero IPC/web/codegen coverage, sleep-based async tests.) *Target state:* the network-exposed and concurrent layers have at least contract-level tests (auth outcomes, status codes, IPC round-trip, restart behavior). *Principle:* test where production incidents come from, not where assertions are cheapest.

**Theme 4: Silent degradation without a logging contract.** (Explains: the unlogged catch blocks, invisible vector-search disablement, empty-result-vs-error ambiguity.) *Target state:* every graceful-degradation catch logs at debug/warn with a stable message; "feature silently off" becomes impossible. *Principle:* graceful degradation is only graceful if someone can find out it happened.

**Explicitly NOT recommending:** migrating off SQLite (the Knex abstraction already holds the door open; single-writer is fine at this scale); replacing matrix-bot-sdk (the `request`-chain risk is fenced by overrides and the internal Docker network — revisit only if audit-fix can't clear it); adding Sentry/Datadog-class observability (a single operator with Docker logs and a health endpoint doesn't need it); a wholesale `any` purge or router.ts rewrite (real cost, marginal payoff); enterprise deployment automation like Terraform (a deploy *script* is enough for N≈2 instances).

**Definition of done — measurable signals:**
- CI fails the build on typecheck, test, or smoke failure; visible on every PR.
- `npm audit` reports 0 critical/high.
- telegram.ts < 2,000 lines; the same CSV upload works on Matrix (proof the orchestrator extraction is real, not cosmetic).
- src/ipc/ and src/web/server.ts auth paths each have a dedicated test file; vitest coverage include-list contains no nonexistent paths.
- `rg "catch \{\s*(return|continue|})" src` hits only sites with an adjacent logger call (or a `// silent-ok:` annotation).
- Exactly one deployment doc tree; README version sourced from package.json.

---

## Phase 4 — Task Plan

Effort: S < 2h · M ≈ half-day · L = 1–2 days · XL = needs breakdown.

### Milestone 0 — Safety net (before touching anything)

| # | Task | Files/areas | Acceptance criteria | Effort | Risk | Deps |
|---|------|-------------|--------------------|--------|------|------|
| 0.1 | **Add CI workflow** running `npm run typecheck`, `npx vitest run`, `npm run smoke` on push/PR | `.github/workflows/ci.yml` | Red X on a deliberately broken PR; green on main | M | Low | — |
| 0.2 | Fix vitest coverage manifest: drop `src/db.ts`, add db-dialect/ipc/web | vitest.config.ts | Coverage list contains only existing paths | S | None | — |
| 0.3 | `npm audit fix` + record CVE IDs/dates next to the `overrides` block | package.json, package-lock.json, reference/dependency-versions.md | `npm audit`: 0 critical/high; suite still green | S | Low | 0.1 helps verify |
| 0.4 | Characterization tests pinning `handleMessageInner` branch behavior (policy confirm, learning gates, auto-skill proposal) before refactor | tests/ (new), telegram.ts read-only | Each major branch has ≥1 behavior-asserting test | L | Low | 0.1 |

### Milestone 1 — Critical fixes (security & correctness)

| # | Task | Files/areas | Acceptance criteria | Effort | Risk | Deps |
|---|------|-------------|--------------------|--------|------|------|
| 1.1 | Identifier whitelist (`/^[A-Za-z_][A-Za-z0-9_]*$/`) on all interpolated DDL names | src/db-dialect.ts:66–128, 237 | Invalid identifier throws; existing dialect tests green | S | Low | 0.1 |
| 1.2 | Reject empty `VOICE_WEB_TOKEN` (and validate other security-relevant vars) at startup | src/config.ts, src/web/server.ts:251 | Startup fails fast with clear message on empty token | S | Low | — |
| 1.3 | Cap FTS query length (~100 chars) and strip exotic operators | src/db-dialect.ts:156, src/memory.ts | Over-长 query returns clean error, not a slow scan | S | Low | — |
| 1.4 | Add logging to every silent catch (debug for expected degradation, warn for fallback-to-default); annotate the deliberate ones | packs.ts:171,282; memory.ts ×6; db-knex.ts:27; db-core.ts:930; attendance/sources/selector.ts:123; telegram.ts:366,594; matrix.ts:200,281 | Grep signal from "done" criteria passes | M | Low | — |
| 1.5 | Indexes on `chat_skills.skill_id`, `skill_revisions.skill_id` (+ migration for existing DBs) | src/db-core.ts:256,275 | Index present in fresh and migrated schema | S | Low–Med (migration) | — |
| 1.6 | Persist voice-mode state to DB | telegram.ts:18, db-core.ts | Voice mode survives restart (test) | S | Low | — |
| 1.7 | Flip unregistered-tool default policy to `high` + requiresConfirmation | src/policy-engine.ts | Policy-engine test asserts the new default | S | Low | — |

### Milestone 2 — High-leverage improvements

| # | Task | Files/areas | Acceptance criteria | Effort | Risk | Deps |
|---|------|-------------|--------------------|--------|------|------|
| 2.1 | **Extract MessageOrchestrator** from telegram.ts (policy confirm, learning session, auto-skills, healing); Telegram keeps transport/format only. *Owner decision 2026-06-11: Matrix/Web parity is an ideal, not a priority — the primary motivation is testability and containment of telegram.ts; wiring Matrix to the orchestrator (step d of the sketch) is optional/deferrable* | new src/core/orchestration (or fold into router), telegram.ts, matrix.ts | telegram.ts < 2,000 ln; characterization tests (0.4) still green; orchestrator flows testable without grammy mocks (Matrix parity = stretch goal, not gate) | XL → break down: (a) policy confirm, (b) learning gate, (c) auto-skills, (d) CSV ingestion | Med–High | 0.1, 0.4 |
| 2.2 | Extract shared CSV ingestion service + shared markdown formatter | telegram.ts ~:3000–3400, matrix.ts:34–80 | Same CSV upload works on Matrix; one formatter, two option sets | M | Med | 2.1a–c not required, can go first |
| 2.3 | IPC integration tests: spawn real child, round-trip execute_tool, kill child → assert restart/backoff, pending-request timeout | tests/ipc-*.test.ts, src/ipc/ | The 4 behaviors asserted; runs in CI | M | Low | 0.1 |
| 2.4 | Web API contract tests: auth (valid/invalid/missing/empty token), status codes, one happy+sad path per dashboard API | tests/web-*.test.ts, src/web/ | server.ts auth paths covered; runs in CI | L | Low | 0.1, 1.2 |
| 2.5 | Minimal ESLint (flat config) + Prettier, wired into CI; format-on-touch policy, no big-bang reformat | eslint.config.js, .prettierrc, .github/workflows | CI fails on lint errors in changed files | M | Low | 0.1 |
| 2.6 | Type the tool registry (`ToolHandler<T>` generic) to remove the `args: any` cluster | src/tools-process.ts:58–77, provider defs | tsc enforces def↔exec parameter agreement | M | Low | — |

### Milestone 3 — Quality & polish

| # | Task | Files/areas | Acceptance criteria | Effort | Risk | Deps |
|---|------|-------------|--------------------|--------|------|------|
| 3.1 | Restructure deployment docs around the *actual* target. Owner context (2026-06-11): Linux-VM and InMotion plans are dead; the current plan is a dedicated MacBook Pro server, **not yet exercised and undocumented**. Write `docs/deployment/macos-server.md` as the canonical guide (Docker Desktop specifics, Ollama on host via host.docker.internal, launchd/autorestart, power/sleep settings); archive inmotion-deployment-guide.md with a "superseded — not approved" banner; fold the generic guide + checklist into the new tree | docs/ | One canonical macOS-server guide exists; rejected-path docs are clearly archived; duplicated DB-setup sections deleted | M–L | None | Ideally after the MacBook deployment is first exercised |
| 3.2 | Kill doc drift: README version from package.json; test/tool counts generated at release; fix CLAUDE.md/ONBOARDING numbers; archive prompts/ with a pointer | README, CLAUDE.md, ONBOARDING.md, prompts/ | No hand-written derived numbers remain | S–M | None | 0.1 |
| 3.3 | FSM codegen tests (generate → tsc-compile → execute sample) | src/fsm/codegen.ts, tests/ | Generated code provably compiles | M | Low | 0.1 |
| 3.4 | Replace hardcoded sleeps with fake timers / event-driven waits in ws-integration, worker-sandbox, background-tasks tests | tests/ | No bare `setTimeout(r, N)` waits in those files | M | Low | 0.1 |
| 3.5 | Batch memory salience updates; async file reads on reply path | src/memory.ts:140, telegram.ts:563 | One UPDATE per message; no readFileSync on reply path | S | Low | — |
| 3.6 | Behavioral assertions for spaced-repetition intervals | tests/learning.test.ts, src/learning/ | Interval math asserted against known cases | M | Low | — |
| 3.7 | Git tags + minimal release notes per RC going forward | repo process | rc.113 is tagged | S | None | — |

### Quick wins (high impact, S effort — do immediately)

0.2 (coverage path), 0.3 (`npm audit fix`), 1.1 (DDL whitelist), 1.2 (empty-token check), 1.3 (FTS cap), 1.5 (indexes), 1.7 (policy default), 3.2 partial (README version line), 3.7 (start tagging).

### Implementation sketches — top 3 tasks

**0.1 CI workflow.** Single `.github/workflows/ci.yml`, `on: [push, pull_request]`, Node 26 (`actions/setup-node` with `node-version-file: .nvmrc`, npm cache), steps: `npm ci` → `npm run typecheck` → `npx vitest run` → `npm run build` → `npm run smoke` (smoke needs dist/, hence after build). Gotchas: better-sqlite3/sqlite-vec need native build tools (ubuntu-latest has them; add `python3 make g++` only if prebuilds miss); the suite uses real SQLite temp files — confirm no test assumes macOS paths; budget ~5–10 min runtime, parallelize typecheck/test as two jobs if slow; do **not** gate on the sleep-based tests being flaky — if they flake in CI, that fast-tracks task 3.4 rather than disabling CI.

**2.1 MessageOrchestrator extraction.** Approach: strangler pattern, one concern per PR, behind the characterization tests from 0.4. (a) Define a platform-neutral `IncomingMessage`/`OutgoingReply` pair (chatId, userId, text, attachments, reply(), sendFile()) — the formatter stays platform-side. (b) Move the pending-confirmation check (telegram.ts:180–210) into the orchestrator as step 1; Telegram passes the neutral message in, asserts identical behavior. (c) Repeat for learning gate (:231–375), then auto-skill proposal/healing, then the main flow. (d) Wire Matrix to the orchestrator — feature parity arrives for free, which is also the proof of correctness. Gotchas: grammy-specific affordances (inline keyboards for confirmations) need a capability flag (`supportsButtons`) with a text-reply fallback (Matrix already answers in text); the typing-indicator refresh (4s gotcha) stays in the platform; do CSV extraction (2.2) as its own track — it shares no state with the message pipeline.

**2.4 Web API contract tests.** Approach: export the server factory from src/web/server.ts (it likely already takes config + PlatformContext; if it self-starts, extract a `createServer()` that returns the http.Server without listening — minimal, mechanical change). Tests boot it on port 0 with an in-memory SQLite StorageProvider and fetch against `127.0.0.1:${port}`. Matrix of cases: no token → 401; malformed token → 401 + rate-limit counter increments; valid per-user token → 200; empty legacy token configured → server refuses to start (locks in 1.2). Then one happy + one malformed-body case per dashboard API file. Gotchas: WebSocket upgrade tests need `ws` client + origin header variants (cover `isOriginAllowed`, server.ts:149–162); keep PlatformContext fakes minimal — these are contract tests of the HTTP layer, not subsystem tests.

---

## Open Questions

Answered by the owner (2026-06-11):

1. ~~**Tool count source of truth**~~ — **Answered: 49+ is correct** (all builtin tool definitions; 48 `*Definition` exports in src/providers/tools/ plus pack tools). The ~33 figure counts only the tools-process registry; 43 was the SA4-era risk-classified count. Doc fix: state which subset each doc counts.
2. ~~**Is multi-platform parity a goal?**~~ — **Answered: parity is an ideal, not a priority.** Task 2.1 is re-scoped: extraction is justified by testability/containment; Matrix wiring is a deferrable stretch goal.

Still open:

3. **Is the SaaS trajectory live?** reference/saas-trajectory.md exists. If multi-tenant is real within ~6 months, several Medium performance findings (N+1 salience updates, sequential decay sweep, SQLite single-writer) escalate to High and Postgres-by-default should be planned now.
4. ~~**Which deployment guide is canonical?**~~ — **Answered: none of them.** The owner clarified (2026-06-11) that the deployment target has been a moving target: (a) internal Linux VM — abandoned (no GPU); (b) InMotion dedicated server — abandoned (additional cost, not approved by management); (c) **current valid plan: a dedicated MacBook Pro as server — not yet exercised.** So the four guides are sediment from superseded plans: the 40K InMotion guide documents a rejected path, and the *actually chosen* target (macOS server) has **no guide at all**. Task 3.1 is re-scoped accordingly (see below).
5. **Release policy** — are the 112 RCs ever converging on a tagged 1.0.0, or is rc.N the permanent versioning scheme? Affects how 3.2/3.7 are implemented.
7. **Domain-intent questions surfaced by the rc.113 dead-code sweep** (each was computed-but-unused; the computation was removed without behavior change, but a human should decide whether an output was originally intended): (a) `src/capacity/index.ts` — p25/p75 utilization percentiles were computed but never rendered (histogram subtitle shows only P5|P50|P95); (b) `src/doe/analysis.ts` `createConfirmationRun` — per-factor main-effect prediction was computed then discarded; the "prediction" falls back to the overall mean, ignoring chosen factor levels (looks like unfinished effects-based prediction); (c) `src/sequencer/evaluation.ts` `generateGanttData` — residual idle gaps after a setup bar are never rendered as Idle; (d) `src/providers/tools/balance.ts` export action — recomputes the balance instead of exporting the stored `assignments_json` of the latest run; (e) `tests/simulation.test.ts` — a `noWarmup` baseline run suggests a forgotten warmup-comparison assertion.
6. **prompts/ and the phase-build framing** — archive entirely, or keep as historical record with a banner? CLAUDE.md's "How To Work On This Repo" section currently describes a workflow that can't be followed.

---

## Method note

Discovery and verification were done directly; the eight audit dimensions were swept by six parallel read-only agents whose findings I cross-checked — corrections applied: ws CVE severity is moderate (not critical), there is no express/qs exposure (express isn't a dependency), docker/.env.docker contains no secrets, and the "33 vs 43 vs 49" tool count was reconciled with the owner: 49+ is correct (different docs count different subsets). Lightly reviewed (lower confidence): packs/ pack content, src/simulation/ internals, voice/Speaches integration, Matrix event-handling details, the manufacturing analytics math itself (well-tested, so deferred to the suite), and docs/audit/ prior audit artifacts.
