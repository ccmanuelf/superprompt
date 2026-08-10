# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Repo Is

This is the **build system** for **luna** — a personal AI assistant daemon that bridges messaging platforms (Telegram, Matrix) to AI backends (Claude CLI, Ollama) running on the user's machine. It includes local voice processing, persistent memory, scheduled tasks, and Docker containerization.

The repo contains:
- `PROJECT_PLAN.md` — Master implementation plan with phase checkboxes (read this first)
- `src/db-knex.ts` — Knex configuration (SQLite/MariaDB/PostgreSQL via DB_DRIVER)
- `src/db-core.ts` — All database CRUD (async, Knex query builder)
- `src/db-dialect.ts` — Cross-dialect FTS, vectors, column migrations
- `prompts/` — **Historical scaffolding only.** The per-phase prompt files were never authored (see `prompts/00-README.md`); `PROJECT_PLAN.md` is the source of truth
- `reference/` — Research artifacts and confirmed decisions

## Current Status

Check `PROJECT_PLAN.md` for which phases are complete. Each phase has a checkbox.

## Agent Behavior Defaults

Behavior rules for working in this repo. Project specifics in the rest of this file
override these whenever they conflict; otherwise these are the defaults.

**Think before coding.** State assumptions explicitly. If multiple interpretations
exist, present them — don't pick silently. If something is unclear, ask before
implementing. Surface tradeoffs, especially when the simpler path is being skipped.

**Simplicity first.** Write the minimum code that satisfies the requirement.
No abstractions for single-use code, no "flexibility" knobs that weren't asked
for, no error handling for impossible scenarios. Code Convention #6 (graceful
degradation at service boundaries) is the exception — that's project policy,
not speculative defense.

**Surgical changes.** Every changed line should trace to the user's request or
the agreed-upon scope (a bundled rc sweep counts as "agreed scope"; an unrelated
refactor on the same branch does not). Match existing style. Don't reformat
adjacent code. Bumping `package.json` + `package-lock.json` and ticking the
`PROJECT_PLAN.md` checkbox alongside a feature is part of the ship, not unrelated.

**Self-audit findings stay in scope.** When a sanity sweep, pressure test, or
pre-ship review surfaces an issue — even pre-existing, even outside the immediate
change, even in code I didn't write — it becomes part of the scope and must be
fixed before the work is presented. No technical debt rides alongside the ship.
This refines "Surgical changes": unrelated refactors stay out, but findings
produced *by* the audit in flight are no longer "unrelated." If a finding is
genuinely too large for the current ship, name it explicitly with a remediation
plan and get a call before deferring — never quietly leave it.

**Define success criteria before editing.** Translate the task into something
verifiable: a failing test that should pass, a smoke check that should stop
erroring, a `tsc --noEmit` that should stay clean. Vague goals ("make it work")
make the loop dependent on the user; concrete criteria let the agent self-verify.

**Verify with the existing workflow.** This repo has real commands — use them
before claiming done:
- `npx tsc --noEmit` — type check
- `npm run lint` — ESLint (must be 0 errors; `no-explicit-any` warnings are a ratchet, don't add new ones)
- `npx vitest run` — full test suite (don't hardcode the count in docs; it drifts)
- `npm run smoke` — dist-level ESM smoke (catches `require()`-in-ESM and similar
  runtime mismatches that vitest/tsx hide; run `npm run build` first)
- `docker compose build luna && docker compose up -d luna` — container rebuild
  when the change touches anything Dockerized
- pre-commit hook (`.githooks/pre-commit`) — secret-leak scan; never bypass
  with `--no-verify` unless you can name why the match is a false positive

If a feature is user-facing, the test suite proves correctness, not feature
correctness. Confirm by exercising the feature end-to-end (live message, API
call, UI click) before reporting the task done — `feedback_quality_standard.md`
in memory pins this.

## Shell Tooling: RTK Token Optimization

`rtk` is installed via Homebrew on the host. `rtk init` registered a
`rtk hook claude` entry in this project's `.claude/settings.json`; the
filter rules live in `~/Library/Application Support/rtk/config.toml`
(user-global, not project-local). The hook transparently rewrites shell
commands to compress output 60–90% — `git status` → `rtk git status`,
`cat file` → `rtk read file`, `rg foo` → `rtk grep foo`, `find . -name x`
→ `rtk find . -name x`. Run `rtk verify` to confirm hook health. Four rules:

**Prefer shell over built-in file tools.** Use `cat`, `rg`, and `find` for
file inspection — rtk compresses their output, the built-in Read/Grep/Glob
tools don't go through it. Fall back to Read/Grep/Glob only when you need an
exact line range, structured match positions, or guaranteed unmodified
content (e.g., editing a file requires Read first).

**Read the tee log on failure.** When a compressed command fails, the full
uncompressed log path is printed at the end of the failure output. Read it
before re-running — re-running blind throws away the diagnosis rtk already
preserved.

**Don't wrap bypassed commands.** Some commands skip the hook by config,
others by structure; either way, prefixing `rtk` manually does nothing
useful (or breaks interactive flows). The exclude list lives in
`~/Library/Application Support/rtk/config.toml` under
`[hooks].exclude_commands`:
- `curl `, `docker exec`, `docker logs`, `docker compose logs`
- `pytest`, `npm install`, `npx playwright test`, `next build`
- `alembic revision`, `weasyprint`, `ollama`, `claude setup-token`,
  `node --inspect`

`docker compose exec <svc> <inner>` is bypassed by rtk's **hardcoded
internal logic**, not by the user's `exclude_commands` — the comment on
the `docker exec` line in `config.toml` says so explicitly (`# bare form;
\`docker compose exec\` is hardcoded in rtk`). The same built-in carve-out
covers `docker compose run`, `up`, `down`, `restart`, and `exec`
(mutation/execution subcommands); `docker compose ps` and
`docker compose build` *do* have rtk wrappers and get rewritten. So
test/lint/build/migration runs inside the 4-service stack (`luna-core`,
`luna-tools`, `luna-parsers`, `speaches`) pass through unchanged regardless
of the inner command.

The Anthropic SDK is a library, not a CLI — it only enters rtk's view via
whatever interpreter invokes a script. As of rtk 0.39.0: no wrapper for
`python`, `node`, `bun`, or direct `tsx`, and `claude -p` (Luna's actual
AI subprocess path) is unwrapped despite `claude setup-token` being in
`exclude_commands`. `npx tsx <script>` IS rewritten to `rtk npx tsx
<script>`, but `rtk npx` only applies specialized filters for
`tsc`/`eslint`/`prisma`; for `tsx` it's a verified byte-identical
passthrough (empirically tested 2026-05-15). Re-probe with `rtk rewrite --`
after rtk version bumps in case a new wrapper appears for any of these.

**Watch for cross-boundary output.** rtk compresses linear stdout/stderr, but
traces that span process or sandbox boundaries can mis-stitch — V8 worker
isolate errors (SA1 sandbox, stack frames cross processes), security-critical
traces (SSRF, prompt-injection framing tests), Telegram/grammy connection
errors, FTS5 + sqlite-vec memory query failures. If compressed output looks
truncated or out of order, fall back to the tee log.

Meta commands: `rtk gain` for current savings, `rtk gain --history` for
per-command history, `rtk discover` to analyze Claude Code history for missed
opportunities, `rtk proxy <cmd>` to bypass filtering when debugging rtk itself.

## Key Architecture Decisions

All decisions are documented in `reference/decisions.md`. Do NOT re-discuss them. Summary:

- **AI**: Claude via `claude -p` subprocess (**subscription — fixed monthly fee, no per-token API cost**) + Ollama (local, curated tool set)
- **Claude auth**: `CLAUDE_CODE_OAUTH_TOKEN` env var (generated via `claude setup-token`). The deployed version uses the same Anthropic subscription as the demo — no API consumption required.
- **Ollama models**: `qwen3.5:latest` (chat + tools)
- **Messaging**: Telegram (grammy) + Matrix (matrix-bot-sdk, self-hosted Synapse)
- **Voice**: Fully local via Speaches Docker sidecar (Kokoro-82M TTS + Faster-whisper STT, auto language detection EN/ES)
- **Database**: SQLite (better-sqlite3) in WAL mode with FTS5. StorageProvider abstraction ready for MariaDB/PostgreSQL migration.
- **Memory**: Full dual-sector (semantic + episodic) with salience decay
- **Infra**: Docker required (sandboxes `--dangerously-skip-permissions`)
- **Dropped**: WhatsApp, Signal, Discord, iMessage, Agent SDK, ElevenLabs, Groq
- **NovaLink Bridge**: read-only prod-data access via the `novalink` pack (`novalink_list_queries` / `novalink_query` / `novalink_health`, tools process). Config: `NOVALINK_BRIDGE_URL` + `NOVALINK_BRIDGE_API_KEY` (.env, whitelisted to the tools process). Tools call the internal bridge directly (intentional internal call, not the declarative-HTTP SSRF path).
- **NovaLink SAM**: full read-write access to the SAM analysis system (quoting/per-piece billing) via the `sam` pack (7 `sam_*` tools, tools process). Config: `NOVALINK_SAM_URL` + `NOVALINK_SAM_API_KEY` (.env, whitelisted to the tools process). Writes + `sam_generate` require SA4 confirmation; `sam_generate` carries a 450 s IPC budget (`ToolEntry.timeoutMs`). SAM's AI legs run on the subscription backend (`claude -p`), so a generate takes ~2–6 min; the timeout ladder is curl `--max-time` 420 s < bash/IPC 450 s < `CLAUDE_TIMEOUT_MS` 900 s — raise them together or not at all. The top rung covers the WHOLE turn (read files → generate → compose), not just the slowest call. `generate`/`generate-mm` strip the 20-section `full_json` from what the model sees (same rule as `sam get`); a `persist:false` draft is exempt — it has no id to re-fetch. Handoff: `reference/novalink-sam-handoff.md` (v1.1). Phase-2 analytics (review/balance/cells/estimate/calc-library) are Claude-path only via the `sam` wrapper.

### Architecture Hardening (SA1-SA5)

- **SA1 — Worker Sandbox**: User-generated code runs in Worker threads (V8 isolate, no shared memory, 64MB limit, adaptive timeout with heartbeat)
- **SA2 — Formal Core**: Application class, typed interfaces (StorageProvider, ToolProvider, MemoryProvider, PackProvider, Platform, Subsystem), PlatformContext facade
- **SA3 — Process Separation**: 3 processes via `child_process.fork()` — core (DB access), tools (network/compute, no DB), parsers (file I/O only, no network)
- **Auto-Skills**: Detection (3+ tools), AI drafting (Hermes-adapted), bilingual proposals, dynamic triggers, skill self-healing
- **SA4 — Policy Engine**: every builtin tool carries a risk classification (critical/high/medium/low; authoritative registry in `src/providers/tools/index.ts` — don't hardcode counts here, they drift). Unclassified tools default to high risk + confirmation (rc.113). Per-user trust memory ("always"/"never"). Confirmation flow across Telegram, Matrix, and voice.
- **SA5 — Everything as Packs**: Manufacturing extracted to Level 3 pack. 9 department starter packs. Subscription model (any department enables any pack). Conversational builder + guide.

## Code Conventions

These apply to ALL generated code across ALL phases:

1. **Path resolution**: Always `fileURLToPath(import.meta.url)` — NEVER `new URL(import.meta.url).pathname` (breaks on spaces in paths)
2. **Environment**: Custom `readEnvFile()` — NEVER set `process.env` from `.env`
3. **Module system**: ESM (`type: "module"` in package.json), `import.meta.url` for paths
4. **TypeScript**: ES2022 target, NodeNext module resolution, strict mode
5. **Logging**: pino + pino-pretty (structured JSON in prod, human-readable in dev)
6. **Error handling**: Graceful degradation — if a service is down, log and continue, don't crash
7. **Dependencies**: Pinned versions in `reference/dependency-versions.md`

## How To Work On This Repo

### Working on the repo
All 26 build phases in `PROJECT_PLAN.md` are complete — the phase-prompt
workflow below is retired (the `prompts/XX-*.md` files were never authored;
`prompts/` is historical scaffolding). For new work:
1. Read `PROJECT_PLAN.md` § Known Gotchas and `reference/decisions.md` first
2. Read relevant `reference/*.md` docs for technical details
3. Make the change; verify with the workflow commands above
4. Commit conventionally (`feat:`/`fix:`/`docs:` …), bump the rc version in
   `package.json` when shipping, push to GitHub

## Reference Documents

| File | Contents |
|------|----------|
| `reference/decisions.md` | All confirmed decisions with rationale |
| `reference/dependency-versions.md` | Pinned package versions |
| `reference/ollama-tools.md` | Tool definitions, agentic loop pattern, model config |
| `reference/matrix-setup.md` | Synapse deployment, bot SDK usage |
| `reference/voice-local.md` | Speaches/Kokoro-82M/Faster-whisper integration with language detection |
| `reference/heal-gate-contract.md` | Self-healing gate completion contract (invariants, tunables, conformance) |
| `reference/loop-guards-checklist.md` | Reusable agent-loop guard checklist + heal-loop audit |
| `reference/heal-self-improvement-evaluation.md` | Deferred decision (2026-06-26): keep heal drafting local vs route to Claude — evidence-collection plan + log, review ~2026-09-26 |

## Secret Leak Prevention

A pre-commit hook (`.githooks/pre-commit`) scans all staged files for:
- API keys (OpenAI, Anthropic, Slack, GitHub, AWS, Telegram)
- Private keys (RSA, EC, PGP, OpenSSH)
- Secrets assigned to variables (password=, token=, etc.)
- `.env` files that should never be committed

The hook is configured via `git config core.hooksPath .githooks`. It automatically runs on every commit. If a false positive blocks a commit, review it carefully — only bypass with `--no-verify` if you're certain it's safe.

All phases must ensure:
- Secrets go in `.env` (gitignored), never hardcoded
- `.env.example` contains placeholder values only (e.g., `your-token-here`)
- No test fixtures contain real credentials

## Known Gotchas

See `PROJECT_PLAN.md` § "Known Gotchas" for the full list (14 items). Critical ones:

1. `fileURLToPath` not `.pathname` (paths with spaces break)
2. Never pollute `process.env` (use `readEnvFile()`)
3. Rename `.oga` → `.ogg` for Whisper (same codec, different extension)
4. Telegram typing indicator expires — refresh every 4s
5. Ollama agentic loop needs MAX_ITERATIONS=10 guard
6. Matrix bot responses must be `m.notice` (not `m.text`) to prevent loops
7. FTS5 virtual table needs manual INSERT/UPDATE/DELETE triggers
