# luna — Command Reference

Quick reference for all commands across Telegram, Matrix, and the web interface.

**Telegram** uses `/command` syntax. **Matrix** uses `!command` syntax. All commands and subcommands are identical across both platforms.

---

## Platform & Provider

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and feature overview |
| `/help` | Categorized command reference (this list) |
| `/webtoken create [label] [ttl]` | Create a web UI access token (e.g. `/webtoken create laptop 30d`) |
| `/webtoken list` | Show all your web tokens (active, revoked, expired) |
| `/webtoken revoke <prefix>` | Revoke a token by its first 4+ characters |
| `/webtoken revoke-all` | Revoke all your active tokens |
| `/chatid` | Show your current chat ID (useful for `ALLOWED_CHAT_ID`) |
| `/newchat` or `/forget` | Clear conversation history for this chat |
| `/claude` | Switch to Claude provider (manual mode) |
| `/ollama` | Switch to Ollama provider (manual mode) |
| `/auto` | Toggle automatic provider routing |
| `/provider` | Show current provider and routing mode |
| `/models` | List available Ollama models |
| `/model <name>` | Switch Ollama to a specific model |

## Voice

| Command | Description |
|---------|-------------|
| `/voice` | Toggle always-voice mode (reply with audio even to text messages) |
| *(send voice message)* | Auto-transcribed and processed; response returned as voice + text |

## Memory & Context

| Command | Description |
|---------|-------------|
| `/memory` | Show stored memories about you (semantic + episodic) |

## Skills

| Command | Description |
|---------|-------------|
| `/skill list` | List all available skills (builtin + custom) |
| `/skill use <name>` | Activate a skill for this chat |
| `/skill off` | Deactivate the current skill |
| `/skill create` | Create a new custom skill (attach `.md` file or paste inline) |
| `/skill fix <name>` | Auto-fix a broken skill using AI |
| `/skill lock <name>` | Lock a skill to prevent edits |
| `/skill unlock <name>` | Unlock a locked skill |
| `/skill export <name>` | Export skill as Markdown file |
| `/skill upload` | Upload a `.md` file to create/update a skill |
| `/skill delete <name>` | Delete a custom skill |
| `/careful` or `/safe` | Activate the `careful` safety guardrails skill |

### Builtin Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `debugger` | Auto — "debug", error messages, "not working" | Systematic debugging methodology |
| `careful` | Auto — "delete", "drop", destructive ops | Safety guardrails for risky operations |
| `brainstormer` | Suggest — "think through", "pros and cons" | Structured brainstorming |
| `analyst` | Suggest — "analyze", "trend", "pattern" | Data analysis framing |
| `coder` | Suggest — "write function", "refactor" | Code generation assistance |

## Tools (Forge)

| Command | Description |
|---------|-------------|
| `/tool list` | List all registered tools (builtin + custom) |
| `/tool show <name>` | Show tool definition and schema |
| `/tool upload` | Upload a `.md` file to register a new tool |
| `/tool generate <description>` | Auto-generate a tool from a natural language description |
| `/tool fix <name>` | Auto-fix a broken tool using AI |
| `/tool enable <name>` | Enable a disabled tool |
| `/tool disable <name>` | Disable a tool without deleting it |
| `/tool delete <name>` | Delete a custom tool |
| `/reload` | Reload all user tools from database and `forge/` directory |

## Scheduling & Tasks

| Command | Description |
|---------|-------------|
| `/schedule create <cron> <message>` | Create a recurring task (e.g., `/schedule create 0 9 * * 1-5 Good morning briefing`) |
| `/schedule list` | List all scheduled tasks |
| `/schedule pause <id>` | Pause a scheduled task |
| `/schedule resume <id>` | Resume a paused task |
| `/schedule delete <id>` | Delete a scheduled task |

## Kanban Board

| Command | Description |
|---------|-------------|
| `/board` or `/board view` | Show the full kanban board |
| `/board move <id> <status>` | Move a card (`todo`, `doing`, `review`, `done`) |
| `/board assign <id> <who>` | Assign a card (`me`, `bot`, `noted`) |
| `/board priority <id> <level>` | Set priority (`low`, `medium`, `high`, `urgent`) |
| `/board due <id> <date>` | Set due date (ISO format: `2026-04-01`) |
| `/board schedule <id> <cron>` | Attach a recurring schedule to a card |
| `/board cancel <id>` | Cancel a scheduled card |
| `/board delete <id>` | Delete a card |
| `/board show <id>` | Show card details |

Cards can also be created conversationally — the AI detects task-like requests and offers to create cards.

## Learning Coach

| Command | Description |
|---------|-------------|
| `/learn plan <subject>` | Create a structured learning plan |
| `/learn session <subject>` | Start a micro-learning session (Socratic method) |
| `/learn add <subject> > <topic>` | Add a topic to an existing plan |
| `/learn remove <subject> > <topic>` | Remove a topic from a plan |
| `/learn move <subject> > <topic> before <other>` | Reorder topics |
| `/learn pause <subject>` | Pause a learning plan |
| `/learn resume <subject>` | Resume a paused plan |
| `/learn status` | Show all plans with progress and mastery |
| `/learn delete <subject>` | Delete a learning plan |
| `/learn persona [list\|<name>]` | List or select teaching personas |
| `/learn proactive [on\|off]` | Toggle proactive session reminders |

### Teaching Personas

12 personas matched automatically to subject and difficulty level. Examples: Socratic Guide, Lab Partner, Drill Sergeant, Storyteller, Code Coach.

## Research & Citations

| Command | Description |
|---------|-------------|
| `/research <query>` | Search academic papers (Semantic Scholar + arXiv) |
| `/cite` | View all citations from current session |
| `/cite export <format>` | Export citations (`bibtex`, `apa`, `chicago`) |
| `/cite clear` | Clear all tracked citations |

## Proactive Messaging

| Command | Description |
|---------|-------------|
| `/digest daily` | Enable daily conversation digests |
| `/digest weekly` | Enable weekly digests |
| `/digest now` | Generate a digest right now |
| `/digest off` | Disable proactive digests |

Digests include conversation summaries, key facts, open threads, and task updates. Follow-up messages are sent automatically 24 hours after conversations with unresolved topics.

## Manufacturing Engineering

### Interactive Web Dashboards

These commands open browser-based dashboards. Each also works as a chat tool (the AI uses them automatically when relevant).

| Command | Web Dashboard | Description |
|---------|--------------|-------------|
| `/sim` | `http://localhost:3030/sim` | Production line simulation (DES engine, Monte Carlo, MiniZinc optimization) |
| `/capacity` | `http://localhost:3030/capacity` | Capacity planning (12-step analysis, ROI, what-if scenarios) |
| `/sequence` | `http://localhost:3030/sequence` | Job sequencing (6 dispatching rules, genetic algorithm, Gantt charts) |
| `/vsm` | `http://localhost:3030/vsm` | Value Stream Mapping (takt time, PCE, TIMWOODS waste analysis) |
| `/toc` | `http://localhost:3030/toc` | Theory of Constraints (CCR, Drum-Buffer-Rope, throughput accounting) |
| `/conwip` | `http://localhost:3030/conwip` | CONWIP token board + Heijunka production leveling |
| `/doe` | `http://localhost:3030/doe` | Design of Experiments (factorial, Taguchi, Box-Behnken, ANOVA) |
| `/fsm` | `http://localhost:3030/fsm` | State Machine simulator (FSM design, DES states, PLC Structured Text export) |

### Chat-Only Manufacturing Tools

These work through conversation — send data via messages or files.

| Command | Description |
|---------|-------------|
| `/sigma <USL> <LSL> <project> [target=X]` | Six Sigma capability analysis (Cp/Cpk/Pp/Ppk, DPMO, control charts) |
| `/balance <takt_seconds> <project>` | Assembly line balancing (RPW heuristic, yamazumi + Gantt charts) |
| `/inventory <project>` | Inventory planning (EOQ, safety stock, ABC classification, SES forecast) |
| `/spc` | SPC / Control Plan setup (VOC → CTQ → QFD pipeline) |
| `/fmea` | FMEA management (PFMEA/DFMEA, AIAG-VDA Action Priority, RPN tracking) |
| `/rca` | Root Cause Analysis (5 Whys, Ishikawa/Fishbone, PDCA, Fault Tree, A3 Report) |

## Domain Packs

| Command | Description |
|---------|-------------|
| `/pack` or `/pack help` | Show pack management help and customization levels |
| `/pack list` | List all installed domain packs with tool/skill counts |
| `/pack info <name>` | Show pack details (description, tools, skills, templates, intent patterns) |
| `/pack create <name> "description"` | Scaffold a new pack directory with starter files |
| `/pack templates <name>` | Send all template files from a pack |

### Pack Management (SA5)

| Command | Description |
|---------|-------------|
| `/pack enable <name>` | Enable a pack for this chat |
| `/pack disable <name>` | Disable a pack for this chat |
| `/pack guide` | Show bilingual pack development guide |

### Trust Management (SA4 Policy Engine)

| Command | Description |
|---------|-------------|
| `/trust list` | Show stored trust decisions for your account |
| `/trust revoke <tool>` | Revoke trust for a specific tool |
| `/trust clear` | Clear all trust decisions |

See `docs/customization-guide.md` for the full guide on creating packs.

## Web Interfaces

All web UIs are served from port `3030` (configurable via `VOICE_WEB_PORT`). Authentication uses per-user tokens generated via `/webtoken create [label] [ttl]` in Telegram. Each token is scoped to the user's `chat_id`, so users only see their own board cards, learning plans, memory, and schedules. The legacy `VOICE_WEB_TOKEN` env var is still supported as a shared fallback.

### Web Token Management

| Command | Description |
|---------|-------------|
| `/webtoken create [label] [ttl]` | Generate a per-user web token (max 5 per user). Optional TTL: `24h`, `7d`, `30d`. |
| `/webtoken list` | List your active tokens with labels and expiry |
| `/webtoken revoke <id>` | Revoke a token immediately (disconnects active sessions) |

| URL | Description |
|-----|-------------|
| `http://localhost:3030/` | Voice web chat (WebSocket-based, push-to-talk + VAD) |
| `http://localhost:3030/board` | Kanban board (drag-and-drop) |
| `http://localhost:3030/learn` | Learning coach dashboard |
| `http://localhost:3030/sim` | Production simulation dashboard |
| `http://localhost:3030/sim/guide` | Simulation user guide |
| `http://localhost:3030/capacity` | Capacity planning dashboard |
| `http://localhost:3030/sequence` | Job sequencer (Gantt + dispatching) |
| `http://localhost:3030/vsm` | Value Stream Map editor |
| `http://localhost:3030/toc` | Theory of Constraints tracker |
| `http://localhost:3030/conwip` | CONWIP / Heijunka board |
| `http://localhost:3030/doe` | Design of Experiments analyzer |
| `http://localhost:3030/fsm` | State Machine simulator |
| `http://localhost:3030/docs` | Documentation viewer (all guides with Mermaid diagrams) |

## Document Generation

The AI generates documents automatically when appropriate. Supported output formats:

| Format | Capabilities |
|--------|-------------|
| **XLSX** | Multi-sheet spreadsheets with formulas, charts (bar, line, pie, scatter, radar, bubble, polar area, doughnut) |
| **CSV** | Simple tabular data export |
| **DOCX** | Sections, tables, bullet lists, styled text |
| **PDF** | Full document layout with tables and charts |
| **PPTX** | Slide decks with charts, tables, speaker notes |

## Ollama Tools (AI-Invoked)

These 49+ tools are used by the AI automatically — you don't call them directly. The AI decides when to use each tool based on your request.

**Core:** `web_search`, `read_file`, `run_command`, `query_memory`, `save_memory`, `get_time`, `system_info`, `summarize_url`, `parse_file`, `generate_document`, `read_bot_logs`, `take_screenshot`, `create_reminder`

**GitHub:** `github_list_repos`, `github_read_file`, `github_list_issues`, `github_list_prs`, `github_clone_repo`, `github_diff`, `github_commit_push`, `github_create_pr`

**Render:** `render_list_services`, `render_deploy_status`, `render_get_logs`

**Tasks:** `kanban_manage`, `search_papers`

**Manufacturing:** `capacity_planning`, `job_sequencer`, `production_simulation`, `minizinc_optimize`, `line_balance`, `sigma_analysis`, `inventory_plan`, `spc_setup`, `fmea_manage`, `rca_manage`, `design_of_experiments`, `value_stream_map`, `toc_analysis`, `conwip_heijunka`, `state_machine_simulator`
