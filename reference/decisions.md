# Confirmed Decisions

All decisions below were researched and confirmed during planning. They should NOT be re-discussed in future sessions.

---

## Naming & Identity

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Product display brand | **Luna** (English) / **Inge Luna** (Spanish) | Current user-facing name (rc.85 rebrand from the former "clauded"). "Inge" is the Spanish short for "Ingeniera" (female engineer). |
| Internal slug | **luna** | Used in hostnames, container names, env vars, DB filename. Lowercase and hostname-safe. Daemon naming convention (like `sshd`, `httpd`). |
| Repo | `superprompt/` | Retains existing repo, REBUILD_PROMPT.md kept as reference |
| Prior names | `clauded` (prior product brand, renamed rc.85), `ClaudeClaw` (pre-repo prototype) | Historical only — both fully removed from the active codebase. |

---

## AI Providers

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Claude integration | **CLI subprocess** (`claude -p`) | The Agent SDK (`@anthropic-ai/claude-agent-sdk`) now requires API keys. CLI subprocess uses the Claude subscription directly — no extra cost. |
| Claude permissions | `--dangerously-skip-permissions` inside Docker | Required for autonomous operation. Docker sandboxing prevents damage. |
| Ollama chat model | `qwen3:4b` | Lightweight, sufficient for chat-only reasoning on 32GB Mac. Originally planned 14B but switched for memory headroom. |
| Ollama tool model | `qwen3:latest` (8B) | Latest Qwen3 with optimized tool calling support. |
| Ollama dual-model | Auto-switch based on message intent | Chat-only → qwen3:4b (fast). Tool-needed → qwen3:latest (better tool compliance). |
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
| STT engine | **Faster-whisper** via Speaches | Model: `Systran/faster-whisper-small`. Auto-detects language (99 langs). Fully local. |
| TTS engine | **Kokoro-82M** via Speaches | Model: `speaches-ai/Kokoro-82M-v1.0-ONNX`. Ranked #1 in TTS Arena. Replaces Piper (much more natural). |
| TTS voices | `af_heart` (EN), `ef_dora` (ES) | Auto-selected via `franc-min` language detection on the response text. |
| Voice sidecar | **Speaches** Docker container (`ghcr.io/speaches-ai/speaches:latest-cpu`) | Models loaded via POST API on startup (entrypoint.sh), cached in named volume. |
| Claude auth in Docker | `CLAUDE_CODE_OAUTH_TOKEN` env var | Generated via `claude setup-token` (valid 1 year). Replaces mounting `~/.claude` (Keychain inaccessible from Docker). |

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
