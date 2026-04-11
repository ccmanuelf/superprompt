# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Repo Is

This is the **build system** for **clauded** — a personal AI assistant daemon that bridges messaging platforms (Telegram, Matrix) to AI backends (Claude CLI, Ollama) running on the user's machine. It includes local voice processing, persistent memory, scheduled tasks, and Docker containerization.

The repo contains:
- `PROJECT_PLAN.md` — Master implementation plan with phase checkboxes (read this first)
- `src/db-knex.ts` — Knex configuration (SQLite/MariaDB/PostgreSQL via DB_DRIVER)
- `src/db-core.ts` — All database CRUD (async, Knex query builder)
- `src/db-dialect.ts` — Cross-dialect FTS, vectors, column migrations
- `prompts/` — Modular build prompts, one per phase (see `prompts/00-README.md`)
- `reference/` — Research artifacts and confirmed decisions

## Current Status

Check `PROJECT_PLAN.md` for which phases are complete. Each phase has a checkbox.

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
