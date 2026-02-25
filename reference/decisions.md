# Confirmed Decisions

All decisions below were researched and confirmed during planning. They should NOT be re-discussed in future sessions.

---

## Naming & Identity

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Project name | **clauded** | Daemon naming convention (like `sshd`, `httpd`). "ClaudeClaw" was the prototype name. |
| Repo | `superprompt/` | Retains existing repo, REBUILD_PROMPT.md kept as reference |

---

## AI Providers

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Claude integration | **CLI subprocess** (`claude -p`) | The Agent SDK (`@anthropic-ai/claude-agent-sdk`) now requires API keys. CLI subprocess uses the Claude subscription directly — no extra cost. |
| Claude permissions | `--dangerously-skip-permissions` inside Docker | Required for autonomous operation. Docker sandboxing prevents damage. |
| Ollama chat model | `bazobehram/qwen3-14b-claude-4.5-opus-high-reasoning` | 9GB Q4_K_M, fine-tuned for Claude-style reasoning, 40k context. Best reasoning quality for chat. |
| Ollama tool model | `qwen3:14b` (official) | Confirmed tool calling support. Official model has better tool compliance than fine-tunes. |
| Ollama dual-model | Auto-switch based on message intent | Chat-only → fine-tuned model (better reasoning). Tool-needed → official model (better compliance). |
| Ollama tool set | 8 curated tools | NOT a full Claude Code replica. Focused, predictable, testable. |
| Agent SDK | **NOT USED** | Removed entirely. Requires API key, breaks subscription model. |

---

## Messaging Platforms

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Telegram | **Yes** (grammy) | Primary platform, well-tested, stable API |
| Matrix | **Yes** (self-hosted Synapse) | Self-hosted = full data control, no ToS issues, federation disabled |
| Matrix SDK | `@vector-im/matrix-bot-sdk` | Element's maintained fork, active development |
| Matrix E2EE | **Not initially** | Self-hosted + no federation = data is already private. E2EE adds complexity. |
| WhatsApp | **Dropped** | Violates Meta ToS, unofficial bridges break frequently, legal risk |
| Signal | **Dropped** | Requires linked device or signal-cli daemon, operational complexity too high |
| Discord | **Dropped** | Not in requirements, Telegram + Matrix covers all use cases |
| iMessage | **Dropped** | Requires macOS-specific hacks, fragile |

---

## Voice

| Decision | Choice | Rationale |
|----------|--------|-----------|
| STT engine | **Faster-whisper** via Speaches | Fully local, no API keys, no cloud dependency. Comparable quality to Groq's whisper. |
| TTS engine | **Piper** via Speaches | Fully local, ~500ms synthesis, natural voice quality. No ElevenLabs cost/dependency. |
| Voice sidecar | **Speaches** Docker container | Single container wraps both Piper and Faster-whisper behind OpenAI-compatible API. |
| Whisper model | `whisper-small` | ~850MB RAM, 3-6s for 30s audio. Good balance for 32GB Mac. |
| Piper voice | `en_US-lessac-medium` | ~63MB model, natural English voice, fast synthesis. |

---

## Infrastructure

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Docker | **Required** | Sandboxes `--dangerously-skip-permissions`, isolates services |
| Background service | launchd (macOS) / systemd (Linux) | Native process management, auto-restart, log integration |
| Database | **SQLite** (better-sqlite3) in WAL mode | Embedded, zero-config, sufficient for personal use. WAL for concurrent reads. |
| Memory system | **Full dual-sector** (semantic + episodic) | FTS5 search, salience decay, auto-cleanup. No "simple" mode — always full. |

---

## Build System

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Prompt style | **Deterministic** | No interactive questions. Each prompt builds its full feature set. |
| Structure | **Modular prompts** (one per phase) | Prevents context exhaustion, allows resumption, each phase is self-contained. |
| Phase count | **12 phases** (0-12) | Logical separation of concerns, each phase builds on previous ones. |
| Session continuity | CLAUDE.md → PROJECT_PLAN.md → prompts/ | Any new session can find its place and continue. |

---

## Code Conventions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Path resolution | `fileURLToPath(import.meta.url)` | `.pathname` breaks on paths with spaces. This is a known Node.js gotcha. |
| Env loading | Custom `readEnvFile()` | Never pollute `process.env`. Explicit dependency injection of config values. |
| Module system | ESM (`type: "module"`) | Modern Node.js standard. `import.meta.url` required for path resolution. |
| TypeScript target | ES2022 + NodeNext | Matches Node 22 capabilities. |
| Logging | pino + pino-pretty | Structured JSON logs in production, human-readable in dev. |
