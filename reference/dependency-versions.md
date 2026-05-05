# Dependency Versions (Pinned)

All versions below are confirmed compatible and should be used exactly as specified in `package.json`.

## Runtime Dependencies

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `grammy` | `^1.42.0` | Telegram bot framework | Stable, well-maintained. Supports all Telegram Bot API features. |
| `@vector-im/matrix-bot-sdk` | `0.8.0-element.3` | Matrix bot SDK | Element's maintained fork. Latest stable is a prerelease tag. |
| `better-sqlite3` | `^12.9.0` | SQLite database | Synchronous API, WAL mode support, FTS5 included. |
| `pino` | `^10.3.1` | Structured logger | JSON output, fast, low overhead. |
| `pino-pretty` | `^13.1.3` | Dev log formatter | Human-readable logs during development. |
| `ollama` | `^0.5.18` | Ollama JS SDK | Official SDK. Supports tool calling, streaming, chat API. |
| `openai` | `^4.104.0` | OpenAI-compatible client | Used for Speaches voice API (not for OpenAI itself). |
| `cron-parser` | `^5.5.0` | Cron expression parser | Parses cron strings, computes next run time. |
| `franc-min` | `^6.2.0` | Language detection | Detects text language (ISO 639-3) for TTS voice selection (EN/ES). |
| `sqlite-vec` | `^0.1.9` | Vector similarity search | SQLite extension for vec0 virtual tables. Used for hybrid memory search. |
| `exceljs` | `^4.4.0` | Read/write XLSX | Spreadsheet parsing (Phase B) and generation (Phase C). |
| `mammoth` | `^1.12.0` | Read DOCX | Extracts raw text from Word documents. |
| `pdf-parse` | `^2.4.5` | Read PDF | PDF text extraction with page-level access. |
| `csv-parse` | `^6.2.1` | Read CSV | Parses CSV with auto-detection of delimiters. |
| `adm-zip` | `^0.5.17` | Read PPTX | Zip extraction for PowerPoint slide XML. |
| `docx` | `^9.6.1` | Write DOCX | Programmatic Word document generation. |
| `pdfkit` | `^0.17.2` | Write PDF | Programmatic PDF generation. |
| `chartjs-node-canvas` | `^5.0.0` | Chart rendering | Server-side Chart.js to PNG via canvas. |
| `chart.js` | `^4.5.1` | Charting library | Peer dependency of chartjs-node-canvas. |
| `knex` | `^3.2.10` | Multi-dialect SQL builder | SQLite/MariaDB/PostgreSQL via DB_DRIVER. |
| `mysql2` | `^3.22.3` | MariaDB / MySQL driver | Used by Knex when DB_DRIVER=maria. |
| `puppeteer-core` | `^24.42.0` | Headless browser | Server-side rendering of HTML to PDF / image. |
| `undici` | `^7.25.0` | HTTP client | Used by fetch fallbacks where we need a configured dispatcher. |
| `ws` | `^8.20.0` | WebSocket implementation | Voice and board/learn live channels. |

## Dev Dependencies

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `typescript` | `^5.9.3` | TypeScript compiler | ES2022 target, NodeNext module resolution. |
| `tsx` | `^4.21.0` | TypeScript executor | For running .ts files directly during development. |
| `@types/node` | `^22.19.17` | Node.js type definitions | Matches Node 22 runtime. |
| `@types/better-sqlite3` | `^7.6.13` | SQLite type definitions | |
| `vitest` | `^3.2.4` | Test framework | Fast, ESM-native, compatible with our setup. |
| `@types/pdfkit` | `^0.17.6` | PDFKit type definitions | |
| `@types/adm-zip` | `^0.5.8` | AdmZip type definitions | |
| `@types/pdf-parse` | `^1.1.5` | pdf-parse type definitions | |
| `@types/ws` | `^8.18.1` | WebSocket type definitions | |

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
| Node.js | >= 20.0.0 | Required for ESM, `import.meta.url`, modern APIs. Pinned in `.nvmrc` (`20`). |
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
| `nomic-embed-text` | ~274MB | Embeddings | 768-dim vectors for hybrid memory search |
