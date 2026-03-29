# clauded

A personal AI assistant daemon that bridges messaging platforms to AI backends running on your machine. Docker-containerized with local voice processing, persistent memory, scheduled tasks, a learning coach, and a full suite of manufacturing engineering tools.

## Features

**AI Providers**
- Claude (via CLI subprocess, subscription-based)
- Ollama (local, 49+ builtin tools)
- Automatic provider routing per-message

**Messaging**
- Telegram (grammy) — primary interface
- Matrix (self-hosted Synapse, optional)
- Voice web chat (browser-based, WebSocket)

**Voice** (fully local, no cloud)
- STT: Faster-whisper via Speaches (99 languages, auto-detect)
- TTS: Kokoro-82M via Speaches (English + Spanish)

**Memory**
- Dual-layer: semantic (long-term facts) + episodic (conversation events)
- AI-powered episode compression with salience decay
- Hybrid search: FTS5 + vector embeddings (sqlite-vec)

**Skills & Tools**
- 5 builtin skills with auto-triggering (debugger, careful, brainstormer, analyst, coder)
- Tool Forge: create, upload, auto-generate, and manage custom tools
- Safety scanning for user-created tools

**Productivity**
- Kanban board with conversational task creation
- Cron-based scheduling and reminders
- Proactive messaging (follow-ups, daily/weekly digests)
- Document generation (XLSX, DOCX, PDF, PPTX, CSV) with charts

**Learning**
- Structured learning plans with topic hierarchies
- Micro-sessions using Socratic method
- Spaced repetition with 4-level mastery tracking
- 12 teaching personas

**Manufacturing Engineering** (15 modules)
- Production simulation (DES, Monte Carlo, MiniZinc optimization)
- Capacity planning (12-step analysis, ROI, what-if scenarios)
- Job sequencing (6 dispatching rules, genetic algorithm)
- Six Sigma (Cp/Cpk/Pp/Ppk, DPMO, control charts)
- Line balancing (RPW, yamazumi charts)
- Inventory planning (EOQ, ABC, SES forecast)
- SPC / Control Plans (VOC → CTQ → QFD)
- FMEA (PFMEA/DFMEA, AIAG-VDA, RPN)
- Root Cause Analysis (5 Whys, Fishbone, PDCA, Fault Tree, A3)
- DOE (factorial, Taguchi, Box-Behnken, ANOVA)
- Value Stream Mapping (takt, PCE, TIMWOODS)
- Theory of Constraints (CCR, Drum-Buffer-Rope)
- CONWIP / Heijunka (token board, production leveling)
- State Machine simulator (FSM, PLC Structured Text export)
- 11 interactive web dashboards

**Research**
- Academic paper search (Semantic Scholar + arXiv)
- Citation management (BibTeX, APA, Chicago)

**DevOps**
- GitHub integration (repos, issues, PRs, commits via `gh` CLI)
- Render monitoring (services, deploys, logs)
- Web page screenshots (Puppeteer)

## Quick Start

### Prerequisites

- Docker >= 24.0 with Docker Compose
- Ollama >= 0.5.0 running on the host
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Claude subscription (Max plan) with OAuth token

### Setup

```bash
git clone https://github.com/your-user/superprompt.git
cd superprompt

# Configure
cp .env.example .env
# Edit .env with your tokens (see .env.example for all options)

# Pull Ollama models
ollama pull qwen3.5:latest
ollama pull nomic-embed-text

# Generate Claude OAuth token
claude setup-token
# Copy token into .env as CLAUDE_CODE_OAUTH_TOKEN

# Start
docker compose up -d
```

### Verify

```bash
docker compose logs -f clauded
```

Send `/start` to your Telegram bot.

### Optional: Matrix

```bash
docker compose --profile matrix up -d
```

### Optional: Web UI

Uncomment `VOICE_WEB_PORT` and `VOICE_WEB_TOKEN` in `.env`, then:

```bash
docker compose up -d --build
```

Access at `http://localhost:3030/`.

## Architecture

```
Host Machine
├── Ollama (native, port 11434)
│
└── Docker Compose
    ├── clauded-bot (Node 22, port 3030)
    │   ├── Claude CLI + Ollama + 49+ tools
    │   ├── Telegram + Matrix bots
    │   ├── Web server (11 SPAs)
    │   ├── SQLite (FTS5 + sqlite-vec)
    │   └── Manufacturing modules
    │
    ├── clauded-speaches (voice sidecar)
    │   ├── Faster-whisper STT (~850MB)
    │   └── Kokoro-82M TTS (~200MB)
    │
    └── clauded-synapse (optional)
        └── Matrix homeserver
```

## Documentation

| Document | Description |
|----------|-------------|
| [User Guide](docs/user-guide.md) | Getting started, all features, configuration |
| [Architecture](docs/architecture.md) | Internal design, data flows, security model |
| [Command Reference](docs/commands.md) | All Telegram/Matrix commands and web UIs |
| [Customization Guide](docs/customization-guide.md) | 3-level guide for extending clauded per department |
| [Security Model](docs/security.md) | Threat assessment, mitigations, configuration checklist |
| [Deployment Guide](docs/deployment-guide.md) | Workstation, local server, VPS, InMotion, Oracle Cloud |
| [Department Runbook](docs/deployment-runbook.md) | 30-minute onboarding checklist for new instances |
| [Decisions](reference/decisions.md) | Confirmed architectural decisions |
| [Voice Setup](reference/voice-local.md) | Speaches/Kokoro/Faster-whisper details |
| [Ollama Tools](reference/ollama-tools.md) | Tool definitions and agentic loop |
| [Matrix Setup](reference/matrix-setup.md) | Synapse deployment and bot SDK |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 (ESM, TypeScript ES2022) |
| AI | Claude CLI + Ollama (qwen3.5) |
| Messaging | grammy (Telegram) + matrix-bot-sdk (Matrix) |
| Voice | Speaches (Faster-whisper + Kokoro-82M) |
| Database | SQLite (WAL) + FTS5 + sqlite-vec |
| Web | Express + WebSocket + Vue 3/Vuetify (CDN) |
| Charts | Chart.js + chartjs-node-canvas |
| Documents | ExcelJS, docx, pdfkit, pptxgenjs |
| Container | Docker Compose (3 services) |
| Logging | pino + pino-pretty |

## Commands

39 commands available. See [docs/commands.md](docs/commands.md) for the full reference.

**Quick overview:**

| Category | Key Commands |
|----------|-------------|
| Packs | `/pack list/info/create` |
| Provider | `/claude`, `/ollama`, `/auto`, `/provider` |
| Voice | `/voice`, send voice messages |
| Memory | `/memory` |
| Skills | `/skill list/use/create/off`, `/careful` |
| Tools | `/tool list/show/upload/generate` |
| Tasks | `/schedule create/list`, `/board view/move` |
| Learning | `/learn plan/session/status` |
| Research | `/research`, `/cite` |
| Manufacturing | `/sim`, `/capacity`, `/sequence`, `/sigma`, `/balance`, `/inventory`, `/spc`, `/fmea`, `/rca`, `/doe`, `/vsm`, `/toc`, `/conwip`, `/fsm` |
| Digests | `/digest daily/weekly/now/off` |

## Tests

```bash
npm test           # Run all tests (vitest)
npm run test:watch # Watch mode
npm run typecheck  # TypeScript type checking
```

1410+ tests across 58 files covering all manufacturing modules, memory system, tools, and utilities.

## License

Private project. All rights reserved.
