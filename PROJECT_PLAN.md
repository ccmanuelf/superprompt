# clauded — Master Implementation Plan

## Context

We are transforming `REBUILD_PROMPT.md` (a 906-line mega-prompt for "ClaudeClaw") into a modular, deterministic build system for **clauded** — a personal AI assistant daemon that bridges messaging platforms to AI backends running on the user's machine.

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
- **Chat mode**: `bazobehram/qwen3-14b-claude-4.5-opus-high-reasoning` (9GB Q4_K_M, fine-tuned for Claude-style reasoning, 40k context)
- **Tool mode**: `qwen3:14b` (official, confirmed tool calling support)
- Automatic switching: when tools are needed, router uses official qwen3:14b; for chat-only, uses the fine-tuned variant

### Key Decisions (Confirmed)
- Rename: ClaudeClaw → **clauded**
- Auth: Claude subscription via `claude -p` subprocess (NOT the Agent SDK)
- Docker: Required for sandboxing `--dangerously-skip-permissions`
- Voice STT: Faster-whisper via Speaches (local) — NOT Groq
- Voice TTS: Piper via Speaches (local) — NOT ElevenLabs
- WhatsApp: **Dropped** entirely
- Signal: **Dropped** (operational complexity too high)
- Matrix: Self-hosted Synapse from day one
- Ollama: Curated tool set (8 tools), NOT full Claude Code replica
- Prompt style: Deterministic (no interactive questions, builds full feature set)
- Structure: Modular prompts, one per phase
- Ollama chat model: `bazobehram/qwen3-14b-claude-4.5-opus-high-reasoning` (fine-tuned for reasoning)
- Ollama tool model: `qwen3:14b` (official, confirmed tool support)
- Git: GitHub repo, push after each completed phase

---

## Completion Status

- [x] **Phase 0**: Project Setup — plan, reference docs, CLAUDE.md
- [ ] **Phase 1**: Foundation — env, config, logger, db, package.json
- [ ] **Phase 2**: AI Providers — claude CLI, ollama with tools, router
- [ ] **Phase 3**: Memory — dual-sector FTS5, salience decay
- [ ] **Phase 4**: Voice — speaches sidecar, piper TTS, faster-whisper STT
- [ ] **Phase 5**: Telegram — grammy bot, formatter, handlers
- [ ] **Phase 6**: Matrix — bot-sdk, synapse docker config
- [ ] **Phase 7**: Scheduler — cron tasks, CLI management
- [ ] **Phase 8**: Media — download, process, cleanup
- [ ] **Phase 9**: Docker — containerization, compose orchestration
- [ ] **Phase 10**: Service — setup wizard, launchd/systemd, status check
- [ ] **Phase 11**: Tests — vitest suite, coverage
- [ ] **Phase 12**: Integration — index.ts, e2e validation

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

**Spec:**
- Speaches runs as Docker container on port 8000 (OpenAI-compatible API)
- STT: `whisper-small` (~850MB RAM, ~3-6s for 30s audio)
- TTS: `piper` with `en_US-lessac-medium` (~63MB, ~500ms synthesis)
- Uses `openai` npm package pointed at `http://localhost:8000/v1`
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
docker/clauded.dockerfile
docker/.env.docker
```

**Architecture:**
- `clauded` container: Node 22, claude CLI, project code
- `speaches` sidecar: Piper TTS + Faster-whisper STT (port 8000 internal)
- `synapse` container: Matrix homeserver (port 8008 localhost)
- Bot runs non-root, `~/.claude` mounted read-only

**Verification**: `docker compose up` starts all services

---

### Phase 10: Setup & Service (`prompts/10-service.md`)
**Goal**: Setup wizard, background service installation, status checker.

**Files:**
```
scripts/setup.ts     — interactive setup wizard
scripts/status.ts    — health check
scripts/notify.sh    — send message from shell
CLAUDED.md           — system prompt template
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
10. **Docker credential mounts**: Mount `~/.claude` as read-only. Never mount `~/.ssh`, `~/.aws`, etc.
11. **FTS5 trigger sync**: The FTS5 virtual table needs manual triggers on INSERT/UPDATE/DELETE.
12. **launchd ThrottleInterval**: Set to >=5s to prevent crash-restart loops.
13. **Speaches cold start**: First request after container start takes longer (model loading). Add health check.
14. **Qwen 3 thinking tokens**: Thinking mode inflates token usage. Monitor memory for long conversations.
