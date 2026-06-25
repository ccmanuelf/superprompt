# Luna — Master Implementation Plan

## Context

We are transforming `REBUILD_PROMPT.md` (a 906-line mega-prompt for "ClaudeClaw") into a modular, deterministic build system for **Luna** (Inge Luna in Spanish) — a personal AI assistant daemon that bridges messaging platforms to AI backends running on the user's machine. Internal slug is `luna`.

### Why This Change
The original prompt has architectural issues discovered through research:
- Uses `@anthropic-ai/claude-agent-sdk` which now **requires API keys** (can't use Claude subscription)
- No Docker sandboxing for `bypassPermissions` mode
- Cloud-dependent voice (ElevenLabs, Groq) instead of local
- WhatsApp integration violates ToS and breaks frequently
- Single 906-line prompt risks context exhaustion and generation errors

### What We're Building
A TypeScript project with:
- **Messaging**: Telegram + Matrix (self-hosted Synapse)
- **AI Providers**: Claude (CLI subprocess, subscription) + Ollama (local, curated tools)
- **Voice**: Fully local via Speaches sidecar (Piper TTS + Faster-whisper STT)
- **Memory**: Full dual-sector (semantic + episodic) with FTS5, salience decay
- **Scheduler**: Cron-based tasks with SQLite persistence
- **Infrastructure**: Docker containerization, background service (launchd/systemd)

### Hardware Target
Apple Silicon Mac, 32GB RAM. Ollama models:
- **Chat mode**: `qwen3:4b` (lightweight, sufficient for chat-only reasoning)
- **Tool mode**: `qwen3:latest` (8B, latest with optimized tool calling)
- Automatic switching: when tools are needed, router uses qwen3:latest; for chat-only, uses qwen3:4b

### Key Decisions (Confirmed)
- Brand: **Luna** (Inge Luna in Spanish). Internal slug `luna`. Earlier names (`ClaudeClaw`, `clauded`) are historical only.
- Auth: Claude subscription via `claude -p` subprocess (NOT the Agent SDK)
- Auth in Docker: `CLAUDE_CODE_OAUTH_TOKEN` env var (generated via `claude setup-token`, valid 1 year)
- Docker: Required for sandboxing `--dangerously-skip-permissions`
- Voice STT: Faster-whisper (`Systran/faster-whisper-small`) via Speaches — auto-detects language
- Voice TTS: Kokoro-82M (`speaches-ai/Kokoro-82M-v1.0-ONNX`) via Speaches — auto-selects voice per language
- Voice language: Auto EN/ES detection via `franc-min` library
- WhatsApp: **Dropped** entirely
- Signal: **Dropped** (operational complexity too high)
- Matrix: Self-hosted Synapse from day one
- Ollama: Curated tool set (8 tools), NOT full Claude Code replica
- Prompt style: Deterministic (no interactive questions, builds full feature set)
- Structure: Modular prompts, one per phase
- Ollama chat model: `qwen3:4b` (lightweight chat)
- Ollama tool model: `qwen3:latest` (optimized tool calling)
- Git: GitHub repo, push after each completed phase

---

## Completion Status

- [x] **Phase 0**: Project Setup — plan, reference docs, CLAUDE.md
- [x] **Phase 1**: Foundation — env, config, logger, db, package.json
- [x] **Phase 2**: AI Providers — claude CLI, ollama with tools, router
- [x] **Phase 3**: Memory — dual-sector FTS5, salience decay
- [x] **Phase 4**: Voice — speaches sidecar, Kokoro-82M TTS, faster-whisper STT, auto language detection
- [x] **Phase 5**: Telegram — grammy bot, formatter, handlers
- [x] **Phase 6**: Matrix — bot-sdk, synapse docker config
- [x] **Phase 7**: Scheduler — cron tasks, CLI management
- [x] **Phase 8**: Media — download, process, cleanup
- [x] **Phase 9**: Docker — containerization, compose orchestration
- [x] **Phase 10**: Service — setup wizard, launchd/systemd, status check
- [x] **Phase 11**: Tests — vitest suite, coverage
- [x] **Phase 12**: Integration — index.ts, e2e validation
- [x] **S10**: Kanban Board — web-based task board
- [x] **S11**: Learning System — spaced repetition, topic mastery
- [x] **S12**: Tool Forge — skill/tool parser, generator, registry, safety scanner
- [x] **S13**: GitHub Tools — repo, issues, PRs, file read
- [x] **S14**: ClawMFG Chat-Native Tools — balance, sigma, inventory, SPC, FMEA, RCA (305 tests)
- [x] **S16**: Manufacturing Simulations — DES engine, Monte Carlo, MiniZinc optimization
- [x] **S15**: ClawMFG Web Apps — 7 manufacturing tools with interactive UIs (252 tests + 102 validation tests)
  - S15.1: Capacity Planning (12-step analysis, Monte Carlo, ROI, scenarios)
  - S15.2: Job Sequence Simulator (6 dispatching rules, GA, Gantt)
  - S15.3: Value Stream Mapping (PCE, TIMWOODS, current/future comparison)
  - S15.4: TOC & WIP Tracking (CCR, Drum-Buffer-Rope, throughput accounting)
  - S15.5: CONWIP & Heijunka (token board, production leveling)
  - S15.6: Design of Experiments (5 design types, ANOVA, desirability, residuals)
  - S15.7: State Machine Simulator (FSM with DES states, PLC export, 4 cross-tool bridges)

---

## File Structure: What Gets Created in This Repo

```
superprompt/
  CLAUDE.md                          ← Updated project guidance (this repo)
  REBUILD_PROMPT.md                  ← Original (kept as reference, not modified)
  PROJECT_PLAN.md                    ← This plan (persistent, survives sessions)

  prompts/                           ← The modular build prompts
    00-README.md                     ← How to use the prompts, ordering, prerequisites
    01-foundation.md                 ← Phase 1: project scaffold, env, config, logger, db
    02-ai-providers.md               ← Phase 2: Claude CLI + Ollama providers + router
    03-memory.md                     ← Phase 3: Full memory system (FTS5, decay, search)
    04-voice.md                      ← Phase 4: Speaches sidecar, STT, TTS
    05-telegram.md                   ← Phase 5: Telegram bot (grammy, formatter, handlers)
    06-matrix.md                     ← Phase 6: Matrix bot (matrix-bot-sdk, Synapse setup)
    07-scheduler.md                  ← Phase 7: Cron scheduler + CLI
    08-media.md                      ← Phase 8: Photo/document/video handling
    09-docker.md                     ← Phase 9: Dockerfile, docker-compose, sandboxing
    10-service.md                    ← Phase 10: Setup wizard, launchd/systemd, status check
    11-tests.md                      ← Phase 11: Vitest test suite
    12-integration.md               ← Phase 12: Wire everything in index.ts, e2e validation

  reference/                         ← Research artifacts for future sessions
    decisions.md                     ← All confirmed decisions with rationale
    ollama-tools.md                  ← Ollama tool calling patterns and model recommendations
    matrix-setup.md                  ← Synapse self-hosting guide and bot SDK patterns
    voice-local.md                   ← Speaches/Piper/Faster-whisper integration patterns
    dependency-versions.md           ← Pinned dependency versions with health notes
```

---

## Phase Breakdown

### Phase 0: Project Setup (this repo)
**Goal**: Create the persistent plan, reference docs, and updated CLAUDE.md so any future session can pick up where we left off.

**Files created:**
- `PROJECT_PLAN.md` — This plan
- `CLAUDE.md` — Rewritten for the build system
- `reference/decisions.md` — All confirmed decisions from research
- `reference/dependency-versions.md` — Pinned versions for all deps
- `reference/ollama-tools.md` — Tool definitions, agentic loop pattern, model config
- `reference/matrix-setup.md` — Synapse deployment, bot SDK usage, E2EE notes
- `reference/voice-local.md` — Speaches docker config, Piper/whisper integration
- `prompts/00-README.md` — How to use the prompt system

---

### Phase 1: Foundation (`prompts/01-foundation.md`)
**Goal**: Scaffold the project. Every subsequent phase depends on this.

**Files the prompt creates (in the target empty directory):**
```
package.json          — pinned deps, scripts, type: module
tsconfig.json         — ES2022, NodeNext, strict
.gitignore
.env.example          — all config keys documented
src/env.ts            — .env parser (no process.env pollution)
src/logger.ts         — pino + pino-pretty
src/config.ts         — named exports for all config, PROJECT_ROOT, STORE_DIR
src/db.ts             — SQLite schema: sessions, memories, memories_fts, scheduled_tasks
                        WAL mode, initDatabase(), all CRUD functions
store/                — runtime data dir (gitignored)
workspace/uploads/    — temp media (gitignored)
```

**Key specs:**
- `readEnvFile()` uses `fileURLToPath(import.meta.url)` — NEVER `.pathname`
- `better-sqlite3` in WAL mode
- Sessions table: `chat_id TEXT PK, session_id TEXT, provider TEXT, updated_at INTEGER`
  - `provider` column tracks whether session is Claude or Ollama
- Memories table: dual-sector with FTS5
- Scheduled tasks table
- DB exports all CRUD functions

**Verification**: `npm install && npm run build && npm run typecheck`

---

### Phase 2: AI Providers (`prompts/02-ai-providers.md`)
**Goal**: Implement both AI backends with a common interface and router.

**Files:**
```
src/providers/types.ts    — AIProvider interface, AIResponse type
src/providers/claude.ts   — Claude CLI subprocess provider
src/providers/ollama.ts   — Ollama provider with curated tool calling
src/providers/router.ts   — Provider selection (config, per-chat, per-message)
src/providers/tools/      — Tool definitions and implementations for Ollama
  index.ts                — tool registry
  web-search.ts           — search via SearXNG or Brave API
  read-file.ts            — read from allowed paths only
  run-command.ts          — execute whitelisted commands in sandbox
  query-memory.ts         — search the memory system
  save-memory.ts          — store a fact
  get-time.ts             — current date/time/timezone
  system-info.ts          — basic system info (uptime, disk, etc.)
  summarize-url.ts        — fetch and summarize a URL
```

**AIProvider interface:**
```typescript
interface AIProvider {
  name: 'claude' | 'ollama';
  sendMessage(params: {
    message: string;
    sessionId?: string;
    chatId: string;
    onTyping?: () => void;
  }): Promise<AIResponse>;
}

interface AIResponse {
  text: string | null;
  newSessionId?: string;
  provider: 'claude' | 'ollama';
  model?: string;
  thinkingContent?: string;
}
```

**Claude provider**: Spawns `claude -p "message" --resume SESSION_ID --output-format stream-json --verbose` inside Docker with `--dangerously-skip-permissions`. Parses stream-json for session ID and result.

**Ollama provider**: Dual-model strategy — chat model for reasoning, tool model for tool calls. Agentic loop with MAX_ITERATIONS=10. Conversation history per chat (last 20 turns).

**Router**: Default from env, per-chat override via `/claude` or `/ollama` commands, stored in sessions table.

**Verification**: Unit tests for tool implementations, mock test for agentic loop

---

### Phase 3: Memory System (`prompts/03-memory.md`)
**Goal**: Full dual-sector memory with FTS5 search and salience decay.

**Files:**
```
src/memory.ts    — buildMemoryContext(), saveConversationTurn(), runDecaySweep()
```

**Spec:**
- `buildMemoryContext(chatId, userMessage)` — FTS5 search + recent fetch, dedupe, touch
- `saveConversationTurn(chatId, userMsg, assistantMsg)` — semantic signal detection, sector classification
- `runDecaySweep()` — 2% daily decay, auto-delete below 0.1 salience
- Memory tools for Ollama (`query-memory` and `save-memory` call these functions)
- `provider` field in memory context prefix

**Verification**: Unit tests for FTS5 search, decay logic, semantic detection

---

### Phase 4: Voice (`prompts/04-voice.md`)
**Goal**: Fully local voice processing via Speaches sidecar.

**Files:**
```
src/voice.ts                  — transcribeAudio(), synthesizeSpeech(), voiceCapabilities()
docker/speaches.yml           — Docker Compose for Speaches sidecar
```

**Spec (updated post-deployment):**
- Speaches image: `ghcr.io/speaches-ai/speaches:latest-cpu` on port 8000 (OpenAI-compatible API)
- STT: `Systran/faster-whisper-small` (~850MB RAM, auto-detects language)
- TTS: `speaches-ai/Kokoro-82M-v1.0-ONNX` with auto language detection via `franc-min`
  - EN → `af_heart` voice, ES → `ef_dora` voice
- Models loaded via POST API (not env vars), auto-preloaded by `docker/entrypoint.sh`
- Uses `openai` npm package pointed at Speaches URL
- Rename `.oga` → `.ogg` before sending
- Graceful degradation if Speaches is down

**Verification**: Manual test with audio file, unit test with mocked HTTP

---

### Phase 5: Telegram Bot (`prompts/05-telegram.md`)
**Goal**: Full Telegram bot with grammy.

**Files:**
```
src/platforms/telegram.ts    — createTelegramBot(), handlers, formatForTelegram()
```

**Spec:**
- grammy framework
- `formatForTelegram(text)` — markdown → HTML conversion with code block protection
- `splitMessage(text, 4096)` — smart splitting on newlines
- Auth check, memory context, provider router, format, send pipeline
- Commands: `/start`, `/chatid`, `/newchat`, `/forget`, `/memory`, `/voice`, `/claude`, `/ollama`, `/schedule`
- Voice handler, photo/document handler, typing indicator refresh every 4s

**Verification**: Mock bot tests, format function unit tests

---

### Phase 6: Matrix Bot (`prompts/06-matrix.md`)
**Goal**: Matrix bot via matrix-bot-sdk with self-hosted Synapse.

**Files:**
```
src/platforms/matrix.ts      — createMatrixBot(), handlers
docker/synapse/              — Synapse config
  homeserver.yaml
  docker-compose.synapse.yml
scripts/setup-matrix.ts      — Synapse setup helper
```

**Spec:**
- `@vector-im/matrix-bot-sdk` (Element's maintained fork)
- No E2EE initially (self-hosted, federation disabled)
- `m.notice` responses to prevent bot loops
- Same command set as Telegram with `!` prefix
- Synapse via Docker with federation disabled

**Verification**: Integration test against local Synapse instance

---

### Phase 7: Scheduler (`prompts/07-scheduler.md`)
**Goal**: Cron-based task scheduler with CLI management.

**Files:**
```
src/scheduler.ts         — initScheduler(), runDueTasks(), computeNextRun()
src/schedule-cli.ts      — CLI for create/list/delete/pause/resume tasks
```

**Spec:**
- Polls SQLite every 60s for due tasks
- `cron-parser` for next run computation
- CLI and in-chat management via `/schedule`

**Verification**: Unit tests for cron parsing, mock scheduler tests

---

### Phase 8: Media Handling (`prompts/08-media.md`)
**Goal**: Download and process photos, documents, video.

**Files:**
```
src/media.ts    — downloadMedia(), buildPhotoMessage(), buildDocumentMessage(), cleanupOldUploads()
```

**Spec:**
- Platform-specific download (Telegram getFile, Matrix mxc://)
- Sanitize filenames: `[a-zA-Z0-9._-]` only
- Save to `workspace/uploads/{timestamp}_{sanitized}`
- `cleanupOldUploads(maxAgeMs = 24h)` on startup
- `fileURLToPath` everywhere

**Verification**: Unit tests for filename sanitization, cleanup logic

---

### Phase 9: Docker (`prompts/09-docker.md`)
**Goal**: Containerize the bot for safe `--dangerously-skip-permissions` usage.

**Files:**
```
Dockerfile
docker-compose.yml
docker/luna.dockerfile
docker/.env.docker
```

**Architecture:**
- `luna` container: Node 22, claude CLI, project code
- `speaches` sidecar: Piper TTS + Faster-whisper STT (port 8000 internal)
- `synapse` container: Matrix homeserver (port 8008 localhost)
- Bot runs non-root, authenticated via `CLAUDE_CODE_OAUTH_TOKEN` env var (no credential mounts needed)

**Verification**: `docker compose up` starts all services

---

### Phase 10: Setup & Service (`prompts/10-service.md`)
**Goal**: Setup wizard, background service installation, status checker.

**Files:**
```
scripts/setup.ts     — interactive setup wizard
scripts/status.ts    — health check
scripts/notify.sh    — send message from shell
LUNA.md           — system prompt template
banner.txt           — ASCII art banner
```

**Verification**: Run setup wizard end-to-end

---

### Phase 11: Tests (`prompts/11-tests.md`)
**Goal**: Comprehensive test suite with Vitest.

**Test files:**
```
tests/
  env.test.ts, db.test.ts, memory.test.ts, format.test.ts,
  router.test.ts, ollama-tools.test.ts, ollama-loop.test.ts,
  scheduler.test.ts, media.test.ts
```

**Coverage**: env/db/memory/formatter >90%, tools >80%

**Verification**: `npm test` passes

---

### Phase 12: Integration (`prompts/12-integration.md`)
**Goal**: Wire everything together in index.ts.

**Startup sequence**: Banner → config check → lock → initDatabase → decay sweep → cleanup → router → bots → scheduler → signal handlers → start

**Verification**: Full E2E validation checklist

---

## Git & GitHub Workflow

### Commit Message Format
```
feat(phase-0): project setup — plan, reference docs, CLAUDE.md
feat(phase-1): foundation — env, config, logger, db, package.json
feat(phase-2): ai providers — claude CLI, ollama with tools, router
feat(phase-3): memory — dual-sector FTS5, salience decay
feat(phase-4): voice — speaches sidecar, piper TTS, faster-whisper STT
feat(phase-5): telegram — grammy bot, formatter, handlers
feat(phase-6): matrix — bot-sdk, synapse docker config
feat(phase-7): scheduler — cron tasks, CLI management
feat(phase-8): media — download, process, cleanup
feat(phase-9): docker — containerization, compose orchestration
feat(phase-10): service — setup wizard, launchd/systemd, status check
feat(phase-11): tests — vitest suite, coverage
feat(phase-12): integration — index.ts, e2e validation
```

### Branch Strategy
- `main` — stable, each phase pushed after verification
- No feature branches needed (sequential phase execution)

---

## Session Continuity Strategy

### How a new session picks up:
1. **CLAUDE.md** (always loaded) points to `PROJECT_PLAN.md` and `reference/` docs
2. **PROJECT_PLAN.md** has full plan with checkboxes for completed phases
3. Each **`prompts/XX-*.md`** is self-contained with prerequisites, specs, verification
4. **`reference/decisions.md`** has all confirmed decisions
5. After each phase, update the checkbox in this file

### If a session ends mid-phase:
- The prompt file has the full spec
- `git status` shows progress
- Next session reads CLAUDE.md → PROJECT_PLAN.md → resumes

### If context compacts:
- CLAUDE.md (always in context) has pointer to PROJECT_PLAN.md
- No critical information lives only in conversation memory

---

## Known Gotchas

1. **Path resolution**: `fileURLToPath(import.meta.url)` — NEVER `.pathname` (breaks on spaces)
2. **process.env pollution**: Never set `process.env` from `.env`. Use `readEnvFile()`.
3. **OGA→OGG rename**: Telegram voice notes are `.oga`, Whisper needs `.ogg`. Same format, different extension.
4. **Telegram typing expiry**: Refresh every 4s via setInterval. Clear immediately after response.
5. **Claude subprocess**: Parse `stream-json` output carefully — session ID comes from init event.
6. **Ollama tool loop**: Always set MAX_ITERATIONS guard. Models can loop indefinitely.
7. **Ollama no tool_choice**: Can't force tool usage. Design prompts to encourage tool use naturally.
8. **Matrix m.notice**: Bot responses should be m.notice (not m.text) to prevent bot-to-bot loops.
9. **Synapse federation**: Disable federation for personal use — prevents metadata leakage.
10. **Docker Claude auth**: Use `CLAUDE_CODE_OAUTH_TOKEN` env var (from `claude setup-token`). Do NOT mount `~/.claude` — OAuth tokens live in macOS Keychain, inaccessible from Docker. The entrypoint creates a minimal `~/.claude.json` with `hasCompletedOnboarding: true`.
11. **FTS5 trigger sync**: The FTS5 virtual table needs manual triggers on INSERT/UPDATE/DELETE.
12. **launchd ThrottleInterval**: Set to >=5s to prevent crash-restart loops.
13. **Speaches model loading**: Models must be loaded via `POST /v1/models/{model_id}` — NOT via env vars. The entrypoint script auto-loads both models. Healthcheck uses `python3` (curl not available in the image). Use `start_period: 120s`.
14. **Qwen 3 thinking tokens**: Thinking mode inflates token usage. Monitor memory for long conversations.
15. **sqlite-vec no triggers**: Unlike FTS5, vec0 tables don't support triggers. Embedding sync must be done programmatically in CRUD functions.
16. **pdf-parse v2 API**: Uses `PDFParse` class with `.getText()` returning `TextResult` — not the v1 callback API.
17. **buildMemoryContext is async**: Changed from sync to async for vector search. All callers must await it.

---

## Enhancement Phases (Post-MVP)

- [x] **Phase A**: Hybrid Memory — sqlite-vec embeddings, hybrid FTS5+vector search
- [x] **Phase B**: File Reading — XLSX, DOCX, PDF, CSV, PPTX, JSON, MD parsing
- [x] **Phase C**: Document Generation — XLSX, DOCX, PDF, CSV output
- [x] **Phase D**: Matrix Parity — schedule commands, photo/file handlers, notifications
- [x] **Phase E**: Skills Infrastructure — registration, routing, per-skill prompts and tools
- [x] **Phase F**: Integration Testing, Validation, Documentation updates
- [x] **Self-Modifying Harness Hardening** — non-regression validation gate on skill self-healing (**rc.116**: held-in/held-out acceptance rule `Δ_in≥0 ∧ Δ_out≥0 ∧ max>0`, `skill_eval_cases`, structured reject notes, reject ceiling) + bounded-loop guards (**rc.117**: wall-clock budget cap `gateHealCandidate` fail-closed, cheap `planGateCandidate` pre-filter, cross-family Claude council judge) + completion contract (`reference/heal-gate-contract.md`) and reusable loop-guard checklist (`reference/loop-guards-checklist.md`). PR #6 (A/B/G) + PR #7. **Proven in production 2026-06-25** (deployed `/app/dist` build, live Claude judge, 9/9 guard checks). **rc.119**: non-blocking heal invocation — Gate 0b (`skillHealingGate`) was awaiting `healSkill` on the message-handler path, so a heal reaching the replay froze the conversation for up to `BUDGET_MS` (~12 min observed live after rc.118 widened the budget). Fix: in-process heal scheduler (`enqueueHeal`, `HEAL_CONCURRENCY=1`, per-skill coalesce, in-memory); the gate enqueues and returns immediately, the patch reply is delivered off-path via `onResult`. Invariant §8.6 added to `reference/heal-gate-contract.md`.

> **Naming clash note:** the "Phase A / Phase B" labels reused below for the
> Attendance pilot are scoped to that pilot only — they are not the same as
> the post-MVP enhancement phases above, which are unrelated and complete.

---

## Active Workstream: Attendance Reconciliation Pilot

The latest active feature, picked up after the production deployment hardening
sprints. Goal: ingest roster + daily badge data, reconcile against shift +
absence policy, and publish exception reports to module supervisors and HR.

Tracked separately from the original Phase 0–12 / SA / S* sprints because the
domain (operations / HR) and the deployment shape (per-customer pilot) don't
fit the earlier phase-replay model.

### External dependencies (gating both phases)

Both phases depend on infrastructure that is **not yet in place** and is
external to engineering:

1. **Time-and-Attendance system access** — a way to read badge punches
   programmatically (API or SFTP drop), so the daily check-in flow doesn't
   require manual CSV uploads forever.
2. **HR database access** — read access to the system of record for the
   employee roster, so it doesn't drift from manual CSVs.

Until those exist, the pilot runs on hand-uploaded CSVs through the admin UI
or Telegram caption flow.

### Phase A — Foundation (in progress, almost complete)

What works today:

- Admin UI at `/attendance/admin` with four tabs:
  - **Ingest CSV** — drag-and-drop CSV upload, runtime column mapping (no
    hardcoded HR schema), per-row accepted/skipped report
  - **Setup** — CRUD for sites, shifts (with breaks), modules, absence codes;
    seeds VP default codes (U/V/DI/PP/P/PT/SI) per site
  - **Operations** — supervisor invitation tokens (one-shot, 24h expiry by
    default), pre-approved future absence filing, role grant/revoke
  - **Reports** — every ingestion's full audit log
- Telegram caption flow: HR peers attach a CSV with caption
  `Roster Data <moduleId>` or `Check-in Data <moduleId> <YYYY-MM-DD>`; reuses
  the column mapping saved in the admin UI.
- `/attendance` Telegram command suite:
  `whoami`, `claim <token>`, `absence <badge> <code> <date> [end] [notes]`.
- Role-based access: `admin / hr / supervisor / manager`, with supervisor
  scoped per module.
- 13-table schema (sites, shifts, breaks, attendance_modules, absence_codes,
  user_roles, attendance_data_sources, attendance_column_mappings,
  attendance_employees, attendance_badge_records, attendance_records,
  attendance_future_absences, attendance_adjustments,
  attendance_report_snapshots, attendance_supervisor_invites,
  attendance_ingestion_reports). Knex dialect-agnostic, FK declared but not
  cascading — lifecycle still being settled.
- Feature-awareness self-enforcing registry (rc.92,
  `src/core/feature-awareness.ts` + `src/<feature>/awareness.ts` +
  `tests/feature-awareness-registry.test.ts`) so Luna can answer questions
  about attendance accurately and CI fails if a future feature ships without
  registering.

Pending in Phase A:
- T&A system integration (replaces CSV uploads)
- HR DB integration (replaces manual roster CSVs)

### Phase B — Reconciliation + Delivery (mostly pending)

What landed (rc.94):

- `src/attendance/reconciliation.ts` — pure-function `reconcile()` that takes
  roster + badge records + filed future absences + absence codes + shift +
  timezone + policy, and returns one classified `ExceptionRow` per roster
  entry. Classification surface: `present | late | early_leave | no_show |
  approved_absence | missing_punch_in | missing_punch_out`. Small policy
  surface (`lateGraceMinutes`, `earlyLeaveGraceMinutes`).
- Convenience helpers: `filterExceptions()`, `tally()`, `codeCountsAsPresent()`.

Pending in Phase B:
- **Wiring**: nothing today calls `reconcile()` from the running system. The
  engine is unit-tested in isolation but not invoked by any scheduler or
  handler.
- **Morning digest** — cron at site-local 8:31am that reconciles the previous
  shift and publishes the exception list to module supervisors via Telegram.
- **Snapshot persistence** — write the published report to
  `attendance_report_snapshots` so the exact content delivered to HR /
  management is always recoverable.
- **Supervisor confirmation flow** — supervisor responds to the exception
  message to resolve each row; writes flow into `attendance_records` /
  `attendance_adjustments`.
- **End-of-shift snapshot** and **HR rollup** for billing-hours
  reconciliation.

Status: **in queue**. Engine will stay unwired until the T&A and HR
dependencies are unblocked, since wiring against CSV-only inputs would be
throwaway work.
