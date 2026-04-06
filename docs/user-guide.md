# clauded User Guide

clauded is a personal AI assistant daemon that bridges messaging platforms to AI backends running on your machine. It connects Telegram and Matrix to Claude and Ollama, with local voice processing, persistent memory, scheduled tasks, a learning coach, manufacturing engineering tools, and Docker containerization.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [AI Providers](#ai-providers)
3. [Messaging Platforms](#messaging-platforms)
4. [Voice Features](#voice-features)
5. [Memory System](#memory-system)
6. [Skills](#skills)
7. [Tool Forge](#tool-forge)
8. [Scheduling & Tasks](#scheduling--tasks)
9. [Kanban Board](#kanban-board)
10. [Learning Coach](#learning-coach)
11. [Research & Citations](#research--citations)
12. [Proactive Messaging](#proactive-messaging)
13. [Document Generation](#document-generation)
14. [Manufacturing Engineering](#manufacturing-engineering)
15. [Web Dashboards](#web-dashboards)
16. [Tips & Tricks](#tips--tricks)

---

## Getting Started

### Prerequisites

**Hardware (check first — under-spec machines will hang or respond very slowly):**
- **RAM**: 32 GB recommended, 16 GB minimum. See [Deployment Runbook — Hardware Requirements](deployment-runbook.md#hardware-requirements) for detailed breakdown.
- **CPU**: Apple Silicon (M1+) or Intel i7 8th gen+
- **Disk**: 20 GB free minimum

**Software:**
- **Docker Desktop** >= 24.0 with memory set to 8 GB+ (Settings → Resources)
- **Ollama** >= 0.5.0 installed and running on the host machine
- A **Telegram bot token** (from [@BotFather](https://t.me/BotFather))
- A **Claude subscription** (Max plan) — optional, for Claude provider. Ollama works without any subscription.

### Step 1: Clone and Create Your Configuration

```bash
git clone https://github.com/your-user/superprompt.git
cd superprompt
cp .env.example .env
```

Open `.env` in your editor. The file is heavily commented — every variable explains its purpose, how to get the value, and what happens if it's missing. Below is the minimum you need to set.

### Step 2: Set Your Telegram Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. Paste it into `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

**Leave `ALLOWED_CHAT_ID` empty for now** — you'll set it in Step 7.

### Step 3: Install and Configure Ollama

```bash
# Install Ollama (if not already installed): https://ollama.ai
# Pull the required models:
ollama pull qwen3.5:latest      # Chat and tool-calling model
ollama pull nomic-embed-text    # Memory embedding model
```

Verify Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

If you see a JSON response listing models, Ollama is ready. If connection is refused, start Ollama first.

### Step 4: Generate Claude OAuth Token

```bash
# Install Claude CLI if needed:
npm install -g @anthropic-ai/claude-code

# Generate the token:
claude setup-token
```

This opens a browser for authentication. After completing the flow, a long-lived token is displayed (valid ~1 year). Copy it into `.env`:

```bash
CLAUDE_CODE_OAUTH_TOKEN=your-token-from-setup-token
```

**If you don't have a Claude subscription**: Set `AI_PROVIDER=ollama` in `.env` and skip this step. clauded works with Ollama alone — Claude is optional.

### Step 5: Start with Docker Compose

```bash
docker compose up -d
```

This starts two containers:

| Container | Purpose | Status |
|-----------|---------|--------|
| `clauded-bot` | Main bot — AI, messaging, memory, tools | Required |
| `clauded-speaches` | Voice sidecar — STT + TTS | Required (starts automatically) |

On first start, the entrypoint script automatically:
- Sets up Claude CLI onboarding flags
- Pre-loads Speaches STT/TTS models in the background (~30 seconds)
- Pulls the `nomic-embed-text` embedding model from Ollama

### Step 6: Verify Startup

```bash
docker compose logs -f clauded
```

Look for these messages (in order):
```
[clauded] Database initialized
[clauded] Telegram bot started
[entrypoint] STT model (faster-whisper-small) loaded
[entrypoint] TTS model (Kokoro-82M) loaded
```

If you see errors:
- `"ECONNREFUSED"` → Ollama is not running on the host
- `"401 Unauthorized"` → Invalid Telegram bot token
- `"No messaging platform configured"` → `TELEGRAM_BOT_TOKEN` is empty

### Step 7: Secure Your Bot

Send `/chatid` to your bot on Telegram. It replies with your numeric chat ID. Add it to `.env`:

```bash
ALLOWED_CHAT_ID=123456789
```

Restart to apply:
```bash
docker compose restart clauded
```

**Why this matters**: Without `ALLOWED_CHAT_ID`, your bot accepts messages from ANY Telegram user who finds it. Setting this restricts access to only your chat ID. For multiple users, comma-separate: `ALLOWED_CHAT_ID=123456789,987654321`.

Send `/start` to verify everything works.

### Step 8 (Optional): Enable Web UI

The web UI provides voice chat, manufacturing dashboards, kanban board, learning coach, and documentation. It is **disabled by default** and requires explicit configuration.

1. Generate a secure token:
```bash
openssl rand -hex 32
```

2. Add both lines to `.env` (both are required — the server refuses to start if the port is set but the token is empty):
```bash
VOICE_WEB_PORT=3030
VOICE_WEB_TOKEN=paste-your-generated-token-here
```

3. Restart:
```bash
docker compose restart clauded
```

4. Open `http://localhost:3030/` in your browser. You'll need the token to connect.

**Security notes**:
- The token protects all web UI connections. Choose a strong random string (32+ characters).
- Failed authentication attempts are rate-limited (5 per minute per IP).
- If accessing from a remote machine (not localhost), you MUST also configure TLS — browsers require HTTPS for microphone access on non-localhost domains. See the TLS section in `.env.example`.

### Step 9 (Optional): Enable Matrix

```bash
docker compose --profile matrix up -d
```

This adds the `clauded-synapse` container (self-hosted Matrix homeserver). See `reference/matrix-setup.md` for the full setup guide including bot account creation.

**Security note**: Set `MATRIX_ALLOWED_USERS` in `.env` after setup — same principle as `ALLOWED_CHAT_ID`. If empty, any Matrix user can message the bot.

### Docker Architecture

```
Host Machine
├── Ollama (native, port 11434)
│   ├── qwen3.5:latest (chat + tools)
│   └── nomic-embed-text (embeddings)
│
└── Docker Compose
    ├── clauded-bot (Node 22, port 3030)
    │   ├── Claude CLI (subprocess)
    │   ├── Telegram bot (grammy)
    │   ├── Matrix bot (optional)
    │   ├── Web server (Express + WebSocket)
    │   ├── SQLite database (./store/)
    │   └── Manufacturing tools
    │
    ├── clauded-speaches (Python, internal)
    │   ├── Faster-whisper STT (~850MB RAM)
    │   └── Kokoro-82M TTS (~200MB RAM)
    │
    └── clauded-synapse (optional, port 8008)
        └── Matrix homeserver
```

### Persistent Data

| Host Path | Container Path | Contents |
|-----------|---------------|----------|
| `./store/` | `/app/store/` | SQLite database, memories, episodes, skills, tools |
| `./workspace/` | `/app/workspace/` | Temp uploads, generated documents, screenshots |
| `./packs/` | `/app/packs/` | Domain packs (editable on host, restart to reload) |
| `./forge/` | `/app/forge/` | User tools & skills (auto-imported at startup) |
| `./docs/` | `/app/docs/` | Documentation (served via web UI, read-only) |
| `speaches-models` (volume) | `/root/.cache/` | Cached STT/TTS models |

### Rebuilding

After code changes:
```bash
docker compose up -d --build
```

### Viewing Logs

```bash
docker compose logs -f clauded      # Bot logs
docker compose logs -f speaches     # Voice service logs
docker compose logs -f synapse      # Matrix logs (if enabled)
```

---

## AI Providers

clauded supports two AI backends that can be used independently or together.

### Claude (via CLI)

- Uses the Claude CLI (`claude -p`) as a subprocess
- Authenticated via `CLAUDE_CODE_OAUTH_TOKEN` (long-lived OAuth token)
- Runs with `--dangerously-skip-permissions` inside Docker (sandboxed by container)
- Supports session resumption for multi-turn conversations
- Best for: complex reasoning, nuanced conversation, long-form generation

### Ollama (Local)

- Connects to Ollama running on the host machine
- Chat model (`OLLAMA_CHAT_MODEL`): General conversation and reasoning
- Tool model (`OLLAMA_TOOL_MODEL`): Tool-calling with agentic loop (max 10 iterations)
- 49+ builtin tools available (web search, file reading, memory, document generation, manufacturing, GitHub, Render)
- Best for: tool-heavy tasks, private/offline usage, quick queries

### Switching Providers

```
/claude          → Switch to Claude (manual mode)
/ollama          → Switch to Ollama (manual mode)
/auto            → Toggle automatic routing
/provider        → Show current provider & mode
```

### Auto-Routing

When `/auto` is enabled, clauded analyzes each message and routes to the best provider:

- **Claude**: Complex reasoning, creative writing, nuanced conversation
- **Ollama**: Tool usage (search, files, memory), system tasks, manufacturing analysis

Override anytime with `/claude` or `/ollama` to return to manual mode.

---

## Messaging Platforms

### Telegram

The primary interface. Supports:
- Text messages with Markdown/HTML formatting
- Voice messages (auto-transcribed, auto-replied with voice)
- File uploads (PDF, XLSX, DOCX, CSV, PPTX, images)
- Document generation (AI creates and sends files)
- Photo analysis (send an image, get a description)
- Inline commands with `/` prefix

### Matrix

Self-hosted via Synapse. Same features as Telegram:
- Commands use `!` prefix instead of `/`
- Messages sent as `m.notice` to prevent bot-to-bot loops
- File uploads via `mxc://` URLs
- Federation disabled by default (private, single-user)

### Voice Web Chat

Browser-based voice interface at `http://localhost:3030/`:
- Push-to-talk or continuous VAD (voice activity detection)
- WebSocket for real-time communication
- Requires `VOICE_WEB_TOKEN` for authentication
- Supports TLS for non-localhost deployment

### Multi-User Support

A single clauded instance supports multiple concurrent users. Each user has a private, isolated experience:

**How to add users:** Set comma-separated Telegram chat IDs in `.env`:
```bash
ALLOWED_CHAT_ID=123456789,987654321,555555555
```
Each user sends `/chatid` to get their ID. Restart after updating `.env`.

**What each user gets (isolated):**
- Their own conversation history — other users can't see it
- Their own memories — personal facts and preferences stay private
- Their own active skill, learning plans, scheduled tasks
- Their own voice transcription and replies

**What's shared across all users:**
- Kanban board (all users see the same board)
- Manufacturing dashboard data (simulation scenarios, capacity plans, etc.)
- Domain packs and tools (same tools available to everyone)

**Practical example:** Three engineers share one bot. Engineer A asks about capacity planning, Engineer B discusses a FMEA, Engineer C practices Spanish with the learning coach — all simultaneously, without any cross-talk.

**Web UI users** each create their own access tokens via `/webtoken create` in Telegram. Each token is scoped to the user's data — board cards, learning plans, memory, and schedules are all isolated per user. The legacy `VOICE_WEB_TOKEN` env var is supported as a fallback for backward compatibility.

---

## Voice Features

clauded processes voice locally — no cloud transcription services.

### How It Works

1. **STT (Speech-to-Text)**: Speaches sidecar using Faster-whisper, auto-detects language (99 languages supported)
2. **TTS (Text-to-Speech)**: Kokoro-82M model, auto-selects voice based on detected language:
   - English: `af_heart`
   - Spanish: `ef_dora`
3. **Language detection**: Uses `franc-min` library for text-based detection

### Usage

- **Send a voice message** on Telegram/Matrix: Auto-transcribed, processed, and replied with voice + text
- **Toggle always-voice mode**: `/voice` — all responses include audio, even for text messages
- **Web chat**: Push-to-talk or VAD mode at `http://localhost:3030/`

### Performance

- STT latency: ~1-3 seconds for typical messages
- TTS latency: ~200-300ms synthesis time
- Cold start: ~30 seconds on first request (models loading)
- Memory: ~1-1.5GB total (Faster-whisper ~850MB + Kokoro-82M ~200MB)

---

## Memory System

clauded has a dual-layer memory system that persists across conversations.

### Semantic Memory

Long-term facts about you — preferences, identity, work context, decisions.

- Automatically saved when you share personal information ("I am...", "I prefer...", "I work at...")
- Low decay rate — retained for months
- Searched before every response to provide personalized context

### Episodic Memory

Conversation events, decisions, interactions.

- Saved from each conversation turn
- Higher decay rate — fades over ~3-4 weeks
- Compressed into "episodes" via AI summarization when fading

### Episode Compression

When episodic memories fade below a salience threshold (0.7), they're grouped by time proximity and AI-compressed into structured episodes containing:

- **Summary**: 1-paragraph overview
- **Key facts**: Actionable information extracted
- **Open threads**: Unresolved topics (triggers follow-up messages)

### Viewing Your Memories

```
/memory    → Show all stored memories about you
```

### How Memory Search Works

When you send a message, clauded searches:
1. FTS5 keyword match (top 3 memories + 2 episodes)
2. Vector similarity via embeddings (top 3 memories + 2 episodes)
3. Recently accessed memories (top 5)
4. Results are deduplicated, ranked, and prepended to your message as context

---

## Skills

Skills modify the AI's behavior by injecting a specialized system prompt.

### Using Skills

```
/skill list              → List all skills
/skill use debugger      → Activate a skill
/skill off               → Deactivate current skill
/careful                 → Quick-activate safety guardrails
```

### Builtin Skills

| Skill | Auto-Triggers On | What It Does |
|-------|-----------------|--------------|
| `debugger` | Error messages, "not working", "debug" | Systematic debugging: reproduce, isolate, hypothesize, verify |
| `careful` | "delete", "drop", "rm -rf", destructive ops | Safety guardrails: confirm before destructive actions |
| `brainstormer` | "think through", "pros and cons" | Structured brainstorming with multiple perspectives |
| `analyst` | "analyze", "trend", "pattern" | Data analysis framing and methodology |
| `coder` | "write function", "refactor" | Code generation with best practices |

### Creating Custom Skills

```
/skill create
```

Then paste or attach a Markdown file:

```markdown
---
name: reviewer
purpose: Code review with security focus
---

You are a security-focused code reviewer. For every code snippet:
1. Check for OWASP top 10 vulnerabilities
2. Verify input validation
3. Check for injection risks
4. Suggest improvements
```

Skills can also be placed as `.md` files in the `forge/skills/` directory for auto-import.

---

## Tool Forge

Create, manage, and share custom tools that extend the AI's capabilities.

### Managing Tools

```
/tool list                → List all tools (builtin + custom)
/tool show web_search     → Show tool schema and description
/tool upload              → Upload a .md tool definition
/tool generate "check if a website is up"  → Auto-generate a tool
/tool fix my_tool         → Auto-fix a broken tool
/tool enable/disable name → Toggle without deleting
/tool delete name         → Delete a custom tool
/reload                   → Reload all tools
```

### Creating Tools

Tools are defined in Markdown format. Example:

```markdown
---
name: coin_flip
description: Flip a coin and return heads or tails
---

## Input
None required.

## Code
\`\`\`javascript
return { result: Math.random() < 0.5 ? 'heads' : 'tails' };
\`\`\`
```

### Safety

All uploaded tools are scanned for security issues before registration. The safety scanner checks for:
- File system access outside allowed paths
- Network requests to unauthorized destinations
- Shell command injection
- Environment variable access

---

## Scheduling & Tasks

### Cron-Based Scheduling

```
/schedule create 0 9 * * 1-5 Daily standup briefing
/schedule list
/schedule pause 3
/schedule resume 3
/schedule delete 3
```

Cron syntax: `minute hour day-of-month month day-of-week`

Examples:
- `0 9 * * 1-5` — Weekdays at 9 AM
- `0 */4 * * *` — Every 4 hours
- `30 8 1 * *` — 8:30 AM on the 1st of each month

### AI-Created Reminders

The AI can create scheduled tasks through conversation:

> "Remind me to review the deployment logs every Monday at 10 AM"

The AI uses the `create_reminder` tool to set this up automatically.

---

## Kanban Board

A built-in task board for personal project tracking.

### Commands

```
/board              → View the full board
/board move T3 done → Move card T3 to done
/board assign T3 me → Assign to yourself
/board priority T3 high
/board due T3 2026-04-15
/board delete T3
```

### Statuses

`todo` → `doing` → `review` → `done`

### Assignees

- `me` — Assigned to you
- `bot` — Assigned to clauded (AI will act on it)
- `noted` — Visible but unassigned

### Web Board

Access the visual kanban board at `http://localhost:3030/board`.

### Conversational Task Creation

The AI detects task-like statements and offers to create cards:

> "I need to fix the login bug by Friday"
> → clauded creates a card: "Fix login bug" | priority: medium | due: 2026-04-04

---

## Learning Coach

A personalized learning system with structured plans, micro-sessions, and spaced repetition.

### Creating a Learning Plan

```
/learn plan Rust programming
```

The AI creates a structured topic hierarchy tailored to your current knowledge level (checked against memory).

### Starting a Session

```
/learn session Rust programming
```

Micro-sessions use the Socratic method — one question at a time, building understanding progressively. Sessions are short (5-15 minutes) and track your mastery.

### Mastery Levels

1. **Needs work** — Just started
2. **Familiar** — Basic understanding
3. **Solid** — Can apply independently
4. **Mastered** — Deep understanding, can teach others

### Spaced Repetition

Topics are reviewed at increasing intervals based on mastery. The system schedules reviews automatically and can send proactive reminders.

### Teaching Personas

12 personas matched to subject and difficulty: Socratic Guide, Lab Partner, Drill Sergeant, Storyteller, Code Coach, and more. The system selects the best persona automatically, or you can choose:

```
/learn persona list
/learn persona "Drill Sergeant"
```

### Web Dashboard

`http://localhost:3030/learn` — Visual overview of plans, progress, streaks, and mastery.

---

## Research & Citations

### Academic Search

```
/research machine learning for manufacturing defect detection
```

Searches Semantic Scholar and arXiv, returns papers with titles, authors, abstracts, and links.

### Citation Management

```
/cite              → View all citations
/cite export bibtex → Export as BibTeX
/cite export apa    → Export as APA format
/cite export chicago → Export as Chicago format
/cite clear         → Clear all citations
```

Citations are tracked automatically when the AI references papers or sources.

---

## Proactive Messaging

clauded sends messages on its own when relevant.

### Follow-Ups

24 hours after a conversation with unresolved topics (captured in episode `open_threads`), clauded sends a follow-up:

> "Follow-up from previous conversation: You mentioned wanting to investigate the memory leak in the worker process. Any progress on that?"

### Digests

```
/digest daily    → Enable daily conversation summaries
/digest weekly   → Enable weekly summaries
/digest now      → Generate a digest immediately
/digest off      → Disable digests
```

Digests compile conversation summaries, key facts, task updates, and open threads.

### Bot-Initiated Tasks

When the AI identifies actionable items during conversation, it can create kanban cards and assign them to itself or flag them for your attention.

---

## Document Generation

The AI generates documents when appropriate — request them conversationally.

### Examples

> "Create an Excel report of our Q1 production metrics"
> "Generate a PDF summary of the capacity analysis"
> "Make a PowerPoint deck with the simulation results"

### Supported Formats

| Format | Features |
|--------|----------|
| **XLSX** | Multi-sheet, formulas, 8 chart types (bar, line, pie, scatter, radar, bubble, polar area, doughnut) |
| **CSV** | Simple tabular export |
| **DOCX** | Sections, tables, bullets, styled text |
| **PDF** | Full layout with tables and charts |
| **PPTX** | Slides with charts, tables, speaker notes |

### File Processing

Send files to clauded for analysis:

| Format | Supported |
|--------|-----------|
| PDF, DOCX, XLSX, CSV, PPTX | Full text extraction |
| Images (PNG, JPG) | Visual analysis (with Claude) |
| JSON, TXT | Direct reading |

---

## Manufacturing Engineering

clauded includes a comprehensive suite of manufacturing engineering tools, usable through chat or interactive web dashboards.

### Production Simulation (`/sim`)

Discrete Event Simulation (DES) engine for production lines:
- Operation-level modeling with breakdowns, changeovers, shift breaks
- Monte Carlo analysis (N replications with P5/P50/P95 confidence intervals)
- MiniZinc optimization (operator assignment, sequencing, scheduling, rebalancing)
- Parallel/branch routing with predecessor-based DAG
- Learning curves, WIP limits, material supply constraints

**Web dashboard**: `http://localhost:3030/sim`

### Capacity Planning (`/capacity`)

12-step capacity calculation methodology:
- Gross → net → capacity → utilization → bottleneck identification
- 8 what-if scenarios (overtime, 3-shift, efficiency, subcontract, etc.)
- Monte Carlo with stochastic variation on efficiency/absenteeism/demand
- Investment ROI calculator (payback, NPV, IRR, break-even)
- Bridge to simulation for validation

**Web dashboard**: `http://localhost:3030/capacity`

### Job Sequencing (`/sequence`)

Job-shop scheduling:
- 6 dispatching rules: FIFO, SPT, LPT, EDD, CR, SLACK
- Genetic algorithm optimizer (PMX crossover, swap mutation, tournament selection)
- Interactive Gantt charts with due date markers
- Setup time matrix support

**Web dashboard**: `http://localhost:3030/sequence`

### Six Sigma (`/sigma`)

Statistical quality analysis:
- Capability indices: Cp, Cpk, Pp, Ppk, DPMO
- Control charts: I-MR, X-bar/R, X-bar/S
- SPC charts: p, np, c, u, CUSUM, EWMA
- Trend regression analysis

### Line Balancing (`/balance`)

Assembly line optimization:
- RPW (Ranked Positional Weight) heuristic
- Yamazumi (stacked bar) charts
- Gantt chart visualization
- Station efficiency and balance delay metrics

### Inventory Planning (`/inventory`)

Stock management:
- EOQ (Economic Order Quantity)
- Safety stock calculation
- ABC classification (Pareto)
- SES (Single Exponential Smoothing) demand forecasting

### SPC / Control Plan (`/spc`)

Quality management pipeline:
- VOC → CTQ → QFD (Voice of Customer to Critical-to-Quality)
- Control plan generation with measurement systems
- Ties into Six Sigma charts

### FMEA (`/fmea`)

Failure Mode and Effects Analysis:
- PFMEA (Process) and DFMEA (Design)
- RPN scoring and AIAG-VDA Action Priority
- Action tracking and verification

### Root Cause Analysis (`/rca`)

Multiple RCA methodologies:
- 5 Whys analysis
- Ishikawa / Fishbone diagrams
- PDCA cycle tracking
- Fault Tree Analysis (FTA)
- Mind Maps
- A3 Report generation

### Value Stream Mapping (`/vsm`)

Lean manufacturing analysis:
- VA/NVA/BNVA activity classification
- Takt time and PCE (Process Cycle Efficiency)
- Lead time waterfall breakdown
- TIMWOODS waste identification with improvement suggestions
- Current vs future state comparison

**Web dashboard**: `http://localhost:3030/vsm`

### Theory of Constraints (`/toc`)

Goldratt's methodology:
- CCR (Capacity Constraint Resource) identification
- Drum-Buffer-Rope scheduling
- Throughput Accounting (T, NP, ROI)
- Buffer management (green/yellow/red zones)
- Goldratt's 5 Focusing Steps

**Web dashboard**: `http://localhost:3030/toc`

### CONWIP / Heijunka (`/conwip`)

Production flow control:
- CONWIP token board with proportional allocation
- Heijunka (production leveling) with interleaving patterns
- Little's Law WIP validation
- Changeover analysis and shift plan generation

**Web dashboard**: `http://localhost:3030/conwip`

### Design of Experiments (`/doe`)

Statistical experimental design:
- Full and fractional factorial designs
- Taguchi orthogonal arrays (L4, L8, L9, L16)
- Box-Behnken response surface designs
- ANOVA analysis, effects plots, residuals
- Desirability optimization for multi-response

**Web dashboard**: `http://localhost:3030/doe`

### State Machine Simulator (`/fsm`)

Finite State Machine design and simulation:
- Visual FSM editor with states and transitions
- Guard conditions on transitions
- 9 DES production states (idle, processing, breakdown, changeover, starved, blocked, setup, warmup, maintenance)
- PLC Structured Text code export
- Bridge to other manufacturing tools

**Web dashboard**: `http://localhost:3030/fsm`

---

## Web Dashboards

All web UIs are served from a single port (default: 3030) with per-user token authentication.

### Setup

1. Set the web port in `.env`:
```bash
VOICE_WEB_PORT=3030
```

2. Each user creates their own token via Telegram:
```
/webtoken create laptop
/webtoken create phone 30d
```

3. Use the token to log into any web dashboard (board, learn, voice, etc.)

**Legacy fallback:** The `VOICE_WEB_TOKEN` env var is still supported for backward compatibility. Per-user tokens are recommended for multi-user deployments.

### Available Dashboards

| URL Path | Application |
|----------|-------------|
| `/` | Voice web chat |
| `/docs` | Documentation viewer |
| `/board` | Kanban board |
| `/learn` | Learning coach |
| `/sim` | Production simulation |
| `/sim/guide` | Simulation guide |
| `/capacity` | Capacity planning |
| `/sequence` | Job sequencer |
| `/vsm` | Value Stream Map |
| `/toc` | Theory of Constraints |
| `/conwip` | CONWIP / Heijunka |
| `/doe` | Design of Experiments |
| `/fsm` | State Machine |

### TLS / HTTPS

For non-localhost access (required for microphone access in browsers):

```bash
VOICE_WEB_TLS_CERT=/path/to/cert.pem
VOICE_WEB_TLS_KEY=/path/to/key.pem
```

---

## Domain Packs — Customizing for Your Department

clauded can be extended with domain-specific capabilities for any department using Domain Packs.

### What is a Domain Pack?

A pack bundles tools, skills, data templates, and AI context for a specific domain (Finance, HR, Marketing, Procurement, etc.). When installed, the AI automatically knows about your department's tools, uses your terminology, and suggests the right tools when relevant topics come up.

### Quick Start

```
/pack list                              → See installed packs
/pack info finance                      → Details on the finance pack
/pack create procurement "Vendor eval"  → Create a new pack
/pack templates finance                 → Get example data files
```

A complete Finance example pack ships with clauded — try it with:

> "Calculate the NPV with 10% discount rate, $200,000 investment, and cash flows of 50000, 60000, 70000, 80000, 90000"

### Three Customization Levels

| Level | Who | What You Get |
|-------|-----|-------------|
| **Simple** | Any user | `/tool generate "description"` — single tool, 5 minutes |
| **Domain Pack** | Power user | Bundled tools + skills + templates + AI context, 1-2 hours |
| **TypeScript Module** | Developer | Web dashboards + custom DB + charts, 1-2 days |

See `docs/customization-guide.md` for complete step-by-step procedures at each level, with worked examples for Finance, HR, Marketing, and Procurement.

### Persistent Data

Pack files live in `packs/` on the host and are mounted into the Docker container. You can edit packs directly on the host and restart clauded to pick up changes:

```bash
docker compose restart clauded
```

---

## Configuration Scope — What You Can Change and How

Not all settings work the same way. Some you change by talking to clauded, some require editing files on the server, and some clauded can advise you on even though it can't change them directly.

### Conversational — Change from inside a chat session

These settings take effect immediately. No restart needed.

| Setting | Command | What It Does |
|---------|---------|-------------|
| AI Provider | `/claude`, `/ollama` | Switch between Claude and Ollama |
| Auto-routing | `/auto` | Toggle automatic provider selection |
| Ollama model | `/model <name>` | Switch to a different Ollama model |
| Voice replies | `/voice` | Toggle audio responses on text messages |
| Active skill | `/skill use <name>`, `/skill off` | Activate or deactivate an AI persona |
| Safety mode | `/careful` | Enable safety guardrails skill |
| Digest frequency | `/digest daily/weekly/off` | Change proactive digest schedule |
| Conversation | `/newchat` | Clear conversation history (memory persists) |
| Learning | `/learn plan/session/pause/resume` | Manage learning plans and sessions |
| Board | `/board move/assign/priority/due` | Manage kanban cards |
| Schedules | `/schedule create/pause/resume/delete` | Manage recurring tasks |
| Tools | `/tool enable/disable/delete` | Enable or disable individual tools |
| Pack scaffold | `/pack create <name> "desc"` | Create a new pack directory structure |

### Manual — Requires editing `.env` and restarting

These settings are read once at startup. After changing them in `.env`, restart with `docker compose restart clauded`.

| Setting | Variable | Why It Can't Be Conversational |
|---------|----------|-------------------------------|
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | Authenticates the bot with Telegram's API at startup |
| Authorized users | `ALLOWED_CHAT_ID` | Security boundary — must be set before any user access |
| Claude token | `CLAUDE_CODE_OAUTH_TOKEN` | CLI authentication credential loaded at process start |
| Default AI provider | `AI_PROVIDER` | Initial provider before any user interaction |
| Ollama host URL | `OLLAMA_HOST` | Connection established at startup |
| Ollama model defaults | `OLLAMA_CHAT_MODEL`, `OLLAMA_TOOL_MODEL` | Model loaded at first inference |
| Web UI port | `VOICE_WEB_PORT` | Server binds to port at startup |
| Web UI token | `VOICE_WEB_TOKEN` | Authentication secret loaded at startup |
| TLS certificates | `VOICE_WEB_TLS_CERT/KEY` | Read and bound to HTTPS server at startup |
| File access paths | `OLLAMA_ALLOWED_PATHS` | Security boundary — evaluated per tool call |
| Search backend | `SEARXNG_URL`, `BRAVE_API_KEY` | Service URL/key used by search tool |
| GitHub token | `GH_TOKEN` | Credential for gh CLI authentication |
| Render API key | `RENDER_API_KEY` | Credential for Render API |
| Matrix config | `MATRIX_HOMESERVER`, etc. | Connection established at startup |
| Log level | `LOG_LEVEL` | Logging framework initialized at startup |

### Guided — clauded can help you decide, even though it can't change the setting

For any manual configuration, you can ask clauded for guidance. Examples:

| Question you can ask clauded | What it can help with |
|------------------------------|----------------------|
| "Should I use Claude or Ollama as my default?" | Explains trade-offs: Claude for reasoning, Ollama for tools and privacy |
| "How do I get a GitHub token?" | Walks you through github.com/settings/tokens step by step |
| "Do I need TLS for the web UI?" | Explains when HTTPS is required (remote access, microphone) |
| "What Ollama model should I use?" | Compares available models for your use case |
| "How do I set up SearXNG?" | Explains Docker setup for private search |
| "What should OLLAMA_ALLOWED_PATHS include?" | Helps you decide which directories to expose |
| "How do I create a Matrix bot account?" | Walks through the Synapse registration process |
| "What's a good VOICE_WEB_TOKEN?" | Suggests `openssl rand -hex 32` and explains why |
| "How do I set up a domain pack for my department?" | Full guided walkthrough of Level 2 customization |

clauded knows its own configuration because its capabilities prompt includes this information. It cannot edit `.env` or restart itself, but it can explain every setting, recommend values, and troubleshoot issues.

**To ask for setup help**, just message clauded naturally:

> "Help me configure the web UI"
> "I want to enable GitHub integration"
> "What do I need to set up for Matrix?"

---

## Tips & Tricks

### First-Time Setup

1. Start without `ALLOWED_CHAT_ID` set — the bot accepts any chat
2. Send `/chatid` to get your Telegram chat ID
3. Add it to `.env` as `ALLOWED_CHAT_ID`
4. Restart: `docker compose restart clauded`

### Provider Selection

- Use **Claude** for complex reasoning, creative writing, nuanced conversations
- Use **Ollama** for tool-heavy tasks, quick lookups, manufacturing analysis
- Use **Auto** mode to let clauded decide per-message

### Voice Tips

- Voice messages get shorter, more concise responses (optimized for listening)
- Text messages get full-length responses with formatting
- Toggle `/voice` to hear all responses as audio

### Memory Tips

- clauded automatically remembers facts you share ("I work at...", "I prefer...")
- Ask "What do you remember about me?" to see your memory profile
- Memory influences all responses — the AI adapts to your preferences over time

### Manufacturing Workflow

1. Start with data — send a CSV/Excel file with your production data
2. The AI detects the domain and suggests the right tool
3. Use chat commands for quick analysis, web dashboards for interactive exploration
4. Results can be exported as documents (Excel, PDF, PowerPoint)

### Conversation Management

- `/newchat` clears history (memory persists — only conversation context resets)
- Long conversations are automatically trimmed via context budgeting (priority-based, not just truncation)

### Docker Management

```bash
docker compose up -d                    # Start all services
docker compose up -d --build            # Rebuild and start
docker compose logs -f clauded          # Follow bot logs
docker compose restart clauded          # Restart bot (picks up pack changes)
docker compose --profile matrix up -d   # Start with Matrix
docker compose down                     # Stop all services
```

### Environment Variable Reference

Every variable is documented in detail in `.env.example` with purpose, format, how to obtain values, and what happens when missing. Below is a summary:

| Variable | Required? | What Happens If Missing |
|----------|-----------|------------------------|
| `TELEGRAM_BOT_TOKEN` | Yes* | Telegram bot doesn't start. If Matrix also missing, clauded refuses to start. |
| `ALLOWED_CHAT_ID` | **Strongly recommended** | Bot accepts messages from ANY Telegram user (first-run mode). |
| `CLAUDE_CODE_OAUTH_TOKEN` | Only if using Claude | Claude provider unavailable. Set `AI_PROVIDER=ollama` to use Ollama only. |
| `AI_PROVIDER` | No | Defaults to `claude`. Set to `ollama` if no Claude subscription. |
| `AUTO_ROUTE` | No | Defaults to `false` (manual provider selection). |
| `OLLAMA_HOST` | No | Defaults to `http://localhost:11434`. |
| `OLLAMA_CHAT_MODEL` | No | Defaults to `qwen3.5:latest`. |
| `OLLAMA_TOOL_MODEL` | No | Defaults to `qwen3.5:latest`. |
| `OLLAMA_EMBED_MODEL` | No | Defaults to `nomic-embed-text`. |
| `SPEACHES_URL` | No | Defaults to `http://localhost:8000/v1`. Auto-overridden in Docker. |
| `VOICE_WEB_PORT` | No | Web UI disabled. Dashboards and docs not available. |
| `VOICE_WEB_TOKEN` | No | Optional legacy fallback. Users can create per-user tokens via `/webtoken` instead. |
| `VOICE_WEB_TLS_CERT` | If remote access | Web server disabled with error log if file not found. |
| `VOICE_WEB_TLS_KEY` | If remote access | Same — web server disabled if file not found. |
| `VOICE_WEB_ORIGIN` | If remote access | Only localhost allowed (secure default). |
| `OLLAMA_ALLOWED_PATHS` | No | File reading completely blocked (secure default). |
| `SEARXNG_URL` | No | Web search tool shows "No search backend available". |
| `BRAVE_API_KEY` | No | Fallback if SearXNG not set. Both missing = search unavailable. |
| `GH_TOKEN` | No | GitHub tools show "gh CLI not authenticated" error. |
| `RENDER_API_KEY` | No | Render tools show "RENDER_API_KEY not set" error. |
| `MATRIX_HOMESERVER` | No | Matrix bot doesn't start. |
| `MATRIX_ACCESS_TOKEN` | If Matrix used | Matrix bot doesn't start. |
| `MATRIX_ALLOWED_USERS` | **Strongly recommended** | Any Matrix user can message the bot. |
| `LOG_LEVEL` | No | Defaults to `info`. Valid: `debug`, `info`, `warn`, `error`. |

*At least one of `TELEGRAM_BOT_TOKEN` or `MATRIX_HOMESERVER` must be set.

### Docker-Internal Overrides

The file `docker/.env.docker` provides automatic overrides for container networking:

| Variable | Host Value | Docker Override |
|----------|-----------|-----------------|
| `OLLAMA_HOST` | `http://localhost:11434` | `http://host.docker.internal:11434` |
| `SPEACHES_URL` | `http://localhost:8000/v1` | `http://speaches:8000/v1` |
| `MATRIX_HOMESERVER` | `http://localhost:8008` | `http://synapse:8008` |
| `STORE_DIR` | `./store` | `/app/store` |
| `WORKSPACE_DIR` | `./workspace` | `/app/workspace` |

You don't need to edit `docker/.env.docker` — it's applied automatically when running in Docker.
