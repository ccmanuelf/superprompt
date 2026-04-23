# Luna

A personal AI assistant daemon that bridges messaging platforms to AI backends running on your machine. Docker-containerized with local voice processing, persistent memory, scheduled tasks, a learning coach, and a full suite of manufacturing engineering tools. Extensible with Domain Packs for any department. **v1.0.0-rc.60**

**New here?** Start with the [Department Onboarding Runbook](docs/deployment-runbook.md) — a 30-minute step-by-step guide to get your own instance running.

---

## Features

**AI Providers**
- Claude via `claude` CLI subprocess (Anthropic subscription — fixed monthly fee, no per-token API costs). Auth via `CLAUDE_CODE_OAUTH_TOKEN` env var (generated with `claude setup-token`). The deployed instance runs on the same subscription as the developer — no API consumption metering.
- Ollama (local, no subscription needed) with qwen3.5 for chat+tools
- 49+ builtin tools (web search, file reading, document generation, GitHub, manufacturing)
- Automatic provider routing per-message

**Messaging**
- Telegram (grammy) — primary interface
- Matrix (self-hosted Synapse, optional)
- Voice web chat (browser-based, WebSocket)

**Voice** (fully local, no cloud transcription)
- STT: Faster-whisper via Speaches (99 languages, auto-detect)
- TTS: Kokoro-82M via Speaches (English + Spanish)

**Memory**
- Dual-layer: semantic (long-term facts) + episodic (conversation events)
- AI-powered episode compression with salience decay
- Hybrid search: FTS5 + vector embeddings (sqlite-vec)

**Skills & Tools**
- 5 builtin skills with auto-triggering (debugger, careful, brainstormer, analyst, coder)
- Auto-skills: luna learns from complex tasks and proposes reusable skills (adapts from Hermes Agent concepts)
- Tool Forge: create, upload, auto-generate, and manage custom tools
- Safety scanning for user-created tools

**Domain Packs** (department customization)
- 10 department and client packs: manufacturing, finance, supply-chain, hr, engineering, business-dev, customer-service, warehousing, trade-compliance, client-acme
- Bundled tools + skills + templates + AI context per department
- Three customization levels: Simple (5 min), Domain Pack (1-2 hrs), TypeScript Module (1-2 days)
- Conversational pack builder ("I need a pack for quality engineering" and AI builds it)
- Pack subscription model: any department can enable any pack
- `/pack create` scaffolds new department packs

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

**Manufacturing Engineering** (15 modules, 11 web dashboards)
- Production simulation (DES, Monte Carlo, MiniZinc optimization)
- Capacity planning (12-step analysis, ROI, what-if scenarios)
- Job sequencing (6 dispatching rules, genetic algorithm)
- Six Sigma, Line balancing, Inventory planning
- SPC / Control Plans, FMEA, Root Cause Analysis
- DOE, Value Stream Mapping, Theory of Constraints
- CONWIP / Heijunka, State Machine simulator (PLC export)

**Research & DevOps**
- Academic paper search (Semantic Scholar + arXiv) with citation management
- GitHub integration (repos, issues, PRs, commits)
- Render monitoring (services, deploys, logs)

**Security**
- Docker container isolation with non-root user
- Token-authenticated web UI and API endpoints
- SSRF protection on all URL-fetching tools
- Prompt injection framing on untrusted content (memory, web search, files)
- Log sanitization (credentials redacted from ring buffer)
- 20 threat vectors assessed — see [Security Model](docs/security.md)

## Security Architecture

- **4-layer defense-in-depth**: Policy gate --> Process boundary --> Worker V8 isolate --> SSRF-safe fetch
- **Per-user trust memory**: works like "remember passwords" — once a user is trusted for a tool category, luna never asks again
- **43 tools classified by risk level**: 3 critical, 16 high, 19 medium, 5 low — each risk level gates differently through the policy engine
- **Auto-generated skills with self-healing**: adapts from Hermes Agent concepts — luna learns from failures and proposes corrected skill definitions
- **Circuit breaker for agentic loops** (stagnation, repetition, error detection)
- **Per-user rate limiting** (100 Claude / 200 Ollama calls per hour)
- **Guardrails memory sector** (permanent learned constraints)
- **Context health monitoring** (proactive degradation detection)

## Quick Start

### For Department Teams (E2E Testing)

Follow the [Department Onboarding Runbook](docs/deployment-runbook.md) — 30 minutes from clone to working bot.

### For Developers

**Prerequisites:**
- Docker Desktop >= 24.0
- Ollama >= 0.5.0 running on the host
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Claude subscription (optional — set `AI_PROVIDER=ollama` to use Ollama only)

```bash
git clone https://github.com/ccmanuelf/superprompt.git
cd superprompt
cp .env.example .env       # Edit with your tokens — every variable is documented
ollama pull qwen3.5:latest
ollama pull nomic-embed-text
docker compose up -d
```

Send `/start` to your Telegram bot. Send `/help` for all commands.

**Enable Web UI** (dashboards, docs, voice chat):
```bash
# Generate a secure token and add both lines to .env:
# VOICE_WEB_PORT=3030
# VOICE_WEB_TOKEN=$(openssl rand -hex 32)
# Then restart:
docker compose restart luna
```

Access at `http://localhost:3030/`. Documentation at `http://localhost:3030/docs`.

## Architecture

3-process architecture with V8 isolation for untrusted code:

```mermaid
graph LR
    subgraph Host
        Ollama["Ollama<br/>qwen3.5 + nomic-embed-text"]
    end

    subgraph Docker["Docker Compose"]
        subgraph Core["Process 1: luna-core"]
            Router["Provider Router"]
            Memory["Memory + SQLite"]
            Skills["Skills + Auto-Skills"]
            Packs["Domain Packs (9)"]
            Scheduler["Scheduler"]
            Platforms["Telegram + Matrix"]
            DB["SQLite (WAL + FTS5)"]
        end

        subgraph Tools["Process 2: luna-tools"]
            Worker["Worker Sandbox<br/>(V8 isolate)"]
            WebTools["Web tools"]
            GitHub["GitHub integration"]
            Screenshots["Screenshots"]
        end

        subgraph Parsers["Process 3: luna-parsers"]
            PDF["PDF parsing"]
            XLSX["XLSX parsing"]
            DOCX["DOCX parsing"]
            NoNet["No network / No DB"]
        end

        Voice["Speaches sidecar<br/>STT + TTS"]
        Matrix["luna-synapse<br/>(optional)"]
    end

    TG["Telegram"] --> Core
    MX["Matrix"] --> Matrix --> Core
    BR["Browser"] --> Core
    Core --> Tools
    Core --> Parsers
    Core --> Ollama
    Core --> Voice
```

## Documentation

| Document | Description |
|----------|-------------|
| [Department Runbook](docs/deployment-runbook.md) | **Start here** — 30-minute onboarding checklist |
| [User Guide](docs/user-guide.md) | Complete feature guide, configuration scope, env var reference |
| [Command Reference](docs/commands.md) | All 39+ Telegram/Matrix commands, web UIs, Ollama tools |
| [Customization Guide](docs/customization-guide.md) | 3-level guide for extending luna per department |
| [Deployment Guide](docs/deployment-guide.md) | Workstation, local server, VPS, InMotion, Oracle Cloud |
| [Architecture](docs/architecture.md) | Internal design with Mermaid diagrams |
| [Security Model](docs/security.md) | 20 threat vectors assessed, mitigations, config checklist |
| [Decisions](reference/decisions.md) | Confirmed architectural decisions |
| [Voice Setup](reference/voice-local.md) | Speaches/Kokoro/Faster-whisper details |
| [Ollama Tools](reference/ollama-tools.md) | Tool definitions and agentic loop |
| [Matrix Setup](reference/matrix-setup.md) | Synapse deployment and bot SDK |

All documentation is also available in-browser at `http://localhost:3030/docs` (7 tabs with Mermaid diagram rendering).

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 (ESM, TypeScript ES2022) |
| AI | Claude CLI (subscription) + Ollama (qwen3.5) |
| Process isolation | child_process.fork() (3-process architecture) |
| Worker sandbox | Node.js Worker threads (V8 isolation for user-generated code) |
| Policy engine | Risk classification (critical/high/medium/low) with trust memory |
| Messaging | grammy (Telegram) + matrix-bot-sdk (Matrix) |
| Voice | Speaches (Faster-whisper + Kokoro-82M) |
| Database | SQLite (WAL) + FTS5 + sqlite-vec |
| Web | Express + WebSocket + Vue 3/Vuetify (CDN) |
| Charts | Chart.js + chartjs-node-canvas |
| Documents | ExcelJS, docx, pdfkit, pptxgenjs |
| Container | Docker Compose (4 services) |
| Logging | pino + pino-pretty |

## Commands

39+ commands available. See [docs/commands.md](docs/commands.md) for the full reference, or type `/help` in the bot.

| Category | Key Commands |
|----------|-------------|
| Packs | `/pack list/info/create/templates` |
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
| Help | `/help` — categorized command reference |

## Tests

```bash
npm test           # Run all tests (vitest)
npm run test:watch # Watch mode
npm run typecheck  # TypeScript type checking
```

2003 tests across 80+ files covering domain packs, manufacturing modules, memory system, tools, security architecture, Knex database layer, event triggers, parallel orchestration, and utilities.

## E2E Testing

93 end-to-end test cases in [scripts/e2e-test.md](scripts/e2e-test.md) covering:
- Core features (messaging, voice, memory, skills, tools)
- S9 additions (packs, /help, /docs, API auth, CORS, SSRF, prompt injection framing)
- Department onboarding smoke test

## License

Private project. All rights reserved.
