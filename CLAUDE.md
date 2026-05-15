# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Repo Is

This is the **build system** for **luna** — a personal AI assistant daemon that bridges messaging platforms (Telegram, Matrix) to AI backends (Claude CLI, Ollama) running on the user's machine. It includes local voice processing, persistent memory, scheduled tasks, and Docker containerization.

The repo contains:
- `PROJECT_PLAN.md` — Master implementation plan with phase checkboxes (read this first)
- `src/db-knex.ts` — Knex configuration (SQLite/MariaDB/PostgreSQL via DB_DRIVER)
- `src/db-core.ts` — All database CRUD (async, Knex query builder)
- `src/db-dialect.ts` — Cross-dialect FTS, vectors, column migrations
- `prompts/` — Modular build prompts, one per phase (see `prompts/00-README.md`)
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
- `npx vitest run` — full test suite (currently 2503 tests / 110 files)
- `npm run smoke` — dist-level ESM smoke (catches `require()`-in-ESM and similar
  runtime mismatches that vitest/tsx hide)
- `docker compose build luna && docker compose up -d luna` — container rebuild
  when the change touches anything Dockerized
- pre-commit hook (`.githooks/pre-commit`) — secret-leak scan; never bypass
  with `--no-verify` unless you can name why the match is a false positive

If a feature is user-facing, the test suite proves correctness, not feature
correctness. Confirm by exercising the feature end-to-end (live message, API
call, UI click) before reporting the task done — `feedback_quality_standard.md`
in memory pins this.

## Shell Tooling: RTK Token Optimization

`rtk` is installed via Homebrew on the host and project-scoped here via
`rtk init`. Its hook transparently rewrites shell commands to compress output
60–90% (`git status` → `rtk git status`, 0 tokens of overhead). Four rules:

**Prefer shell over built-in file tools.** Use `cat`, `rg`, and `find` for
file inspection — rtk compresses their output, the built-in Read/Grep/Glob
tools don't go through it. Fall back to Read/Grep/Glob only when you need an
exact line range, structured match positions, or guaranteed unmodified
content (e.g., editing a file requires Read first).

**Read the tee log on failure.** When a compressed command fails, the full
uncompressed log path is printed at the end of the failure output. Read it
before re-running — re-running blind throws away the diagnosis rtk already
preserved.

**Don't wrap bypassed commands.** These skip rtk by config or by environment,
and manually prefixing `rtk` does nothing useful (or breaks interactive flows):
- Excluded in `.rtk` config: `docker compose exec`, `docker exec`, `curl`
- All test/lint/build/migration commands — they run inside Docker via
  `docker compose exec` against the 4-service stack (`luna-core`,
  `luna-tools`, `luna-parsers`, `speaches`), which bypasses rtk by design
- Ollama subprocess output, `claude setup-token` and any OAuth flow,
  `node --inspect` debug sessions
- Host-only commands: `alembic revision --autogenerate`, `weasyprint`,
  anything calling the Anthropic SDK

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

### Architecture Hardening (SA1-SA5)

- **SA1 — Worker Sandbox**: User-generated code runs in Worker threads (V8 isolate, no shared memory, 64MB limit, adaptive timeout with heartbeat)
- **SA2 — Formal Core**: Application class, typed interfaces (StorageProvider, ToolProvider, MemoryProvider, PackProvider, Platform, Subsystem), PlatformContext facade
- **SA3 — Process Separation**: 3 processes via `child_process.fork()` — core (DB access), tools (network/compute, no DB), parsers (file I/O only, no network)
- **Auto-Skills**: Detection (3+ tools), AI drafting (Hermes-adapted), bilingual proposals, dynamic triggers, skill self-healing
- **SA4 — Policy Engine**: 43 tools classified by risk (3 critical, 16 high, 19 medium, 5 low). Per-user trust memory ("always"/"never"). Confirmation flow across Telegram, Matrix, and voice.
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

### Continuing the build
1. Read `PROJECT_PLAN.md` to find the next incomplete phase
2. Read the corresponding `prompts/XX-*.md` for the full spec
3. Read relevant `reference/*.md` docs for technical details
4. Execute the phase in the target directory

### Editing a prompt
- Each prompt is self-contained. Changes to one prompt should be validated against downstream phases that depend on it.
- The dependency graph is in `prompts/00-README.md`.

### After completing a phase
1. Run the verification steps from the prompt
2. Commit: `feat(phase-N): description`
3. Update the checkbox in `PROJECT_PLAN.md`
4. Push to GitHub

## Reference Documents

| File | Contents |
|------|----------|
| `reference/decisions.md` | All confirmed decisions with rationale |
| `reference/dependency-versions.md` | Pinned package versions |
| `reference/ollama-tools.md` | Tool definitions, agentic loop pattern, model config |
| `reference/matrix-setup.md` | Synapse deployment, bot SDK usage |
| `reference/voice-local.md` | Speaches/Kokoro-82M/Faster-whisper integration with language detection |

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
