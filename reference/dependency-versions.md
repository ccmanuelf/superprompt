# Dependency Versions (Pinned)

All versions below are confirmed compatible and should be used exactly as specified in `package.json`.

## Runtime Dependencies

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `grammy` | `^1.40.0` | Telegram bot framework | Stable, well-maintained. Supports all Telegram Bot API features. |
| `@vector-im/matrix-bot-sdk` | `0.8.0-element.3` | Matrix bot SDK | Element's maintained fork. Latest stable is a prerelease tag. |
| `better-sqlite3` | `^12.6.0` | SQLite database | Synchronous API, WAL mode support, FTS5 included. |
| `pino` | `^10.3.0` | Structured logger | JSON output, fast, low overhead. |
| `pino-pretty` | `^13.0.0` | Dev log formatter | Human-readable logs during development. |
| `ollama` | `^0.5.0` | Ollama JS SDK | Official SDK. Supports tool calling, streaming, chat API. |
| `openai` | `^4.80.0` | OpenAI-compatible client | Used for Speaches voice API (not for OpenAI itself). |
| `cron-parser` | `^5.5.0` | Cron expression parser | Parses cron strings, computes next run time. |
| `franc-min` | `^6.2.0` | Language detection | Detects text language (ISO 639-3) for TTS voice selection (EN/ES). |

## Dev Dependencies

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `typescript` | `^5.7.0` | TypeScript compiler | ES2022 target, NodeNext module resolution. |
| `tsx` | `^4.19.0` | TypeScript executor | For running .ts files directly during development. |
| `@types/node` | `^22.0.0` | Node.js type definitions | Matches Node 22 runtime. |
| `@types/better-sqlite3` | `^7.6.0` | SQLite type definitions | |
| `vitest` | `^3.0.0` | Test framework | Fast, ESM-native, compatible with our setup. |

## NOT Used (Explicitly Removed)

| Package | Reason |
|---------|--------|
| `@anthropic-ai/claude-agent-sdk` | Requires API key. We use `claude` CLI subprocess instead. |
| `@anthropic-ai/sdk` | Not needed — Claude accessed via CLI, not API. |
| `whatsapp-web.js` | WhatsApp dropped entirely (ToS violation). |
| `@whiskeysockets/baileys` | WhatsApp dropped entirely. |
| `groq-sdk` | Replaced by local Speaches (Faster-whisper) for STT. |
| `elevenlabs` | Replaced by local Speaches (Kokoro-82M) for TTS. |
| `@anthropic-ai/tokenizer` | Not needed for current architecture. |

## System Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20.0.0 | Required for ESM, `import.meta.url`, modern APIs |
| Docker | >= 24.0 | Required for sandboxing and service orchestration |
| Ollama | >= 0.5.0 | Local LLM runtime for the Ollama provider |
| `claude` CLI | Latest | Installed via `npm i -g @anthropic-ai/claude-code` |

## Docker Images

| Image | Purpose | Notes |
|-------|---------|-------|
| `node:22-slim` | Bot container base | Minimal, includes npm |
| `ghcr.io/speaches-ai/speaches:latest-cpu` | Voice sidecar | Bundles Kokoro-82M TTS + Faster-whisper STT. Models loaded via POST API. |
| `matrixdotorg/synapse:latest` | Matrix homeserver | Official Synapse image |

## Ollama Models

| Model | Size | Purpose | Notes |
|-------|------|---------|-------|
| `qwen3:4b` | ~2.5GB | Chat | Lightweight, sufficient for chat-only reasoning |
| `qwen3:latest` | ~4.9GB | Tool calling | Latest Qwen3 with optimized tool support |
