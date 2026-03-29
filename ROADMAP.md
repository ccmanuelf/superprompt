# clauded — Enhancement Roadmap

> Last updated: 2026-03-21
> Previous roadmap versions: `memory/roadmap.md` (2026-03-13), ROADMAP.md (2026-03-18)

## Summary

clauded is evolving from personal AI assistant into a **full AI partner platform ("Jarvis")**. Core autonomy sprints S1-S8 complete. Platform expansion sprints S10-S13 planned.

**Execution order: S1-S8 ✅ → S10 ✅ → S11 ✅ → S12 ✅ → S13 ✅ → S14 ✅ → S16 ✅ → S15 ✅ (ClawMFG Web ×7) → S9 ✅ (Docs) → S4 (E2E) → S3 (Cloud)**

---

## E2E Testing Status (Pre-Sprint)

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 | Voice Prompt Tuning (Telegram) | PASSED 10/10 |
| Phase 2 | Skill Forge (Telegram) | PASSED 13/13 |
| Phase 3 | Tool Forge (Telegram) | SMOKE TEST PASSED (`/tool list`, `/tool show`) — full suite deferred to S4 |
| Phase 4 | Voice Web Chat (Browser) | NOT STARTED — deferred to S4 |
| Phase 5 | Cross-Feature Integration | NOT STARTED — deferred to S4 |

**Decision (2026-03-18):** Sequential phase-by-phase testing was creating a bottleneck. Batch all remaining E2E tests into Sprint S4 after development is complete.

---

## Sprint S1: Autonomy Core — COMPLETED (2026-03-18)

**Goal:** Make clauded's memory smarter and its provider selection automatic.

### Feature 1: Episode Compression

**Problem:** Episodic memories are truncated individual turns (`User: [200 chars] → Assistant: [200 chars]`). They decay and get deleted, losing context. No summarization.

**Solution (inspired by Slate thread weaving + professor.md Filtration Analysis):**

#### 1.1 New `episodes` table (`src/db.ts`)
```sql
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_facts TEXT,          -- JSON array of extracted facts
  open_threads TEXT,       -- JSON array of unresolved topics
  source_count INTEGER,    -- how many memories were compressed
  created_at INTEGER NOT NULL
);
-- Plus episodes_fts (FTS5) and episodes_vec (sqlite-vec 768-dim)
```

#### 1.2 `compressEpisodes()` function (`src/memory.ts`)
- **Trigger:** During `runDecaySweep()`, before memories with salience < 0.2 are deleted
- **Grouping:** Episodic memories from same chat_id within 30 min of each other = one episode
- **Compression prompt** (Filtration Analysis pattern):
  - Filter 1 — **Relevance:** What user facts, preferences, or decisions emerged?
  - Filter 2 — **Outcome:** What was accomplished or resolved?
  - Filter 3 — **Continuity:** What open threads or follow-ups remain?
- **AI provider:** Ollama preferred (local, fast), Claude fallback
- **Result:** Compressed episode stored, original episodic memories deleted, embedding generated

#### 1.3 Modify `buildMemoryContext()` (`src/memory.ts`)
- Add FTS5 + vector search on episodes table
- Include top 2 matching episodes in memory context alongside individual memories
- Episodes labeled as `(episode)` in context output

### Feature 2: Auto-Routing

**Problem:** User must manually switch between `/claude` and `/ollama`. No intelligence about which is better for a given message.

**Solution:**

#### 2.1 Routing classifier (`src/providers/router.ts`)
Heuristic-based (no AI call needed):
- **Route to Ollama:** Short messages (<100 chars), simple factual questions, tool-dependent tasks, vision (photos), active Ollama tools
- **Route to Claude:** Long/complex analysis (>500 chars), creative writing, file generation requests, code review, multi-step reasoning, document analysis
- Configurable via `AUTO_ROUTE=true|false` in `.env` (default: false)

#### 2.2 Override behavior
- **`/auto` command:** Toggles auto-routing ON. Router picks per-message.
- **`/claude` or `/ollama` command:** Explicit lock to that provider. Auto-routing OFF.
- **`/auto` again:** Returns to automatic routing.
- **`/provider` command:** Shows current active provider and routing mode (e.g., "Provider: Claude (manual)" or "Provider: Ollama (auto-routed)").
- **Natural language does NOT override** — only slash commands. Avoids ambiguity.
- Override state stored per-session (same as current `provider` column in sessions table).

#### 2.3 New config (`src/config.ts`, `.env.example`)
```
AUTO_ROUTE=false    # Enable automatic provider routing (true/false)
```

### Files Modified (S1)

| File | Change |
|------|--------|
| `src/db.ts` | Add `episodes` + `episodes_fts` + `episodes_vec` tables |
| `src/memory.ts` | Add `compressEpisodes()`, modify `buildMemoryContext()`, modify `runDecaySweep()` |
| `src/providers/router.ts` | Add auto-routing classifier, `/auto` toggle logic |
| `src/config.ts` | Add `AUTO_ROUTE` config var |
| `.env.example` | Add `AUTO_ROUTE=false` |
| `src/platforms/telegram.ts` | Register `/auto`, `/provider` commands |
| `src/platforms/matrix.ts` | Register `!auto`, `!provider` commands |
| `tests/` | New: `episode-compression.test.ts`, `auto-routing.test.ts` |

---

## Sprint S2: Prompt Intelligence — COMPLETED (2026-03-18)

**Goal:** Make clauded's AI responses higher quality through structured prompting patterns and safety guardrails.

### Feature 1: Superpowers Skills Adaptation

Adapt 4 skills from [Superpowers](https://github.com/obra/superpowers) for personal assistant context:

| Superpowers Skill | clauded Adaptation | Type | Implementation |
|-------------------|--------------------|------|----------------|
| **Systematic Debugging** | `debugger` — structured root-cause analysis | Built-in skill | 4-phase process: investigate → analyze patterns → hypothesize/test → implement. Circuit breaker: 3+ failed approaches = escalate to architectural review |
| **Brainstorming** | `brainstormer` — design-first thinking | Built-in skill | One-question-at-a-time, YAGNI, explore before implementing. Adapted from dev workflow to research/analysis workflow |
| **Verification Before Completion** | `verifier` — evidence before claims | System prompt enhancement | "Before claiming X, show evidence of X." Applied globally, not as a switchable skill |
| **Subagent-Driven Development** | `orchestrator` — multi-step task decomposition | Built-in skill + future tool | Break complex requests into focused subtasks. Two-stage review: intent match + quality |

Skills NOT adapted (and why):
- **TDD** — Developer-focused, not applicable to assistant context
- **Writing Skills** — Meta-skill for creating skills; document as guidelines in CLAUDE.md instead

### Feature 2: Anti-Rationalization Prompting

Add to both Claude and Ollama system prompts:

```
QUALITY RULES:
- Never say "should work" or "probably" — verify or state uncertainty
- Never skip steps in multi-step tasks — complete each before proceeding
- If you've attempted 3+ approaches without success, stop and re-analyze the problem
- Before claiming completion, show evidence (output, result, confirmation)
```

### Feature 3: Safety Guardrails (from gstack)

New built-in skill: `careful`
- Activated via `/careful` or `/safe`
- Adds caution layer to system prompt: warn before destructive operations, confirm before external calls, flag irreversible actions
- Auto-deactivates after session ends (not persistent)

### Feature 4: Bot Command List in System Prompts

Add the full `/help` command list to both Claude and Ollama system prompts so the AI knows what commands exist and can suggest them to users.

**Already documented as TODO in MEMORY.md** — execute during this sprint.

### Files Modified (S2)

| File | Change |
|------|--------|
| `src/skills.ts` | Add `debugger`, `brainstormer`, `careful` built-in skills |
| `src/providers/claude.ts` | Add anti-rationalization rules + command list to system prompt |
| `src/providers/ollama.ts` | Add anti-rationalization rules + command list to system prompt |
| `src/platforms/telegram.ts` | Register `/careful`, `/safe` commands |
| `src/platforms/matrix.ts` | Register `!careful`, `!safe` commands |
| `tests/` | New: `skills-superpowers.test.ts`, `anti-rationalization.test.ts` |

---

## Sprint S5: Proactive Messaging — COMPLETED (2026-03-18)

**Goal:** Make clauded initiate conversations — follow-ups, reminders, digests, task completions.

The bot should reach out to the user, not just respond. This is the single biggest differentiator between a chatbot and an assistant. Builds on existing scheduler infrastructure.

### Planned Features

#### 5.1 Follow-up system
- When an episode has `open_threads`, schedule a follow-up check (e.g., 24-48h later)
- Bot sends: "Hey, you mentioned wanting to revisit [topic]. Want to pick that up?"
- Uses episode data from S1 — `open_threads` JSON field

#### 5.2 Task completion notifications
- When a scheduled task completes, notify the user with the result
- Currently: results are stored in `last_result` but user must check via `/schedule list`
- New: proactively send result when ready

#### 5.3 Digest messages
- Daily/weekly summary of what happened: episodes created, tasks completed, memories stored
- Optional: user configures via `/digest daily|weekly|off`

#### 5.4 Smart reminders from conversation
- Detect "remind me" or "follow up on" in natural language
- Auto-create a scheduled task without requiring `/schedule` syntax
- Bot confirms: "I'll remind you about [X] on [date]"

### Files to Modify

| File | Change |
|------|--------|
| `src/scheduler.ts` | Add proactive message dispatch, follow-up scheduling |
| `src/memory.ts` | Export open_threads from episodes for follow-up scheduling |
| `src/platforms/telegram.ts` | Proactive send function, `/digest` command |
| `src/platforms/matrix.ts` | Proactive send function, `!digest` command |
| `src/providers/router.ts` | Add natural language reminder detection to COMMAND_LIST |
| `tests/` | New: `proactive-messaging.test.ts` |

---

## Sprint S6: Skill Auto-Triggering — NOT STARTED

**Goal:** AI detects when a skill should activate instead of requiring `/skill use <name>`.

### Planned Features

#### 6.1 Intent-based skill activation
- Pattern match on message content to suggest or auto-activate skills
- Examples:
  - User describes a bug → auto-suggest or activate `debugger`
  - User says "let's think about..." → auto-activate `brainstormer`
  - User is about to do something destructive → auto-activate `careful`
- User can override: "don't use debugger mode" → stays in general

#### 6.2 Skill suggestion vs auto-activation
- For ambiguous cases: suggest the skill instead of forcing it
  - "This sounds like a debugging problem. Want me to switch to systematic debugging mode? (use /skill use debugger)"
- For clear cases (e.g., "careful" when destructive action detected): auto-activate

### Files to Modify

| File | Change |
|------|--------|
| `src/skills.ts` | Add `shouldAutoTrigger(message)` function per skill |
| `src/providers/router.ts` | Check skill triggers before sending message |
| `src/platforms/telegram.ts` | Notify user when skill auto-activates |
| `tests/` | New: `skill-auto-trigger.test.ts` |

---

## Sprint S7: Multi-Step Task Orchestration — NOT STARTED

**Goal:** Break complex requests ("research X, compare with Y, draft a report") into subtasks and execute sequentially.

### Planned Features

#### 7.1 Task decomposition
- Detect multi-step requests in natural language
- Decompose into ordered subtasks with dependencies
- Execute each subtask, passing results to the next

#### 7.2 Progress tracking
- Inform user of progress: "Step 1/3: Researching X... done. Step 2/3: Comparing with Y..."
- Store intermediate results in episodes

#### 7.3 Failure handling
- If a subtask fails, inform user and offer to retry or skip
- Apply circuit breaker from debugger skill (3+ failures → re-analyze)

### Inspiration
- Slate thread weaving: bounded worker threads producing episodes
- Superpowers subagent-driven development: task decomposition with review gates

### Files to Modify

| File | Change |
|------|--------|
| `src/orchestrator.ts` | NEW — task decomposition, execution pipeline, progress tracking |
| `src/providers/router.ts` | Detect multi-step requests, route to orchestrator |
| `src/memory.ts` | Store intermediate results as episodes |
| `tests/` | New: `orchestrator.test.ts` |

---

## Sprint S8: Context Budgeting + Self-Monitoring — COMPLETED (2026-03-21)

**Goal:** Intelligently manage context window usage and detect/correct AI failures.

### Planned Features

#### 8.1 Context budgeting
- Track token usage per message (system prompt + memories + episodes + user message)
- When approaching limits: summarize older context, drop low-relevance memories
- Priority: system prompt > recent memories > episodes > old memories

#### 8.2 Self-monitoring
- Detect tool execution failures and retry with adjusted parameters
- Detect when AI response is low-quality (too short, repetitive, off-topic)
- Log quality metrics for post-hoc analysis

### Inspiration
- Slate context-as-RAM: treat context window as scarce resource to manage
- Superpowers verification-before-completion: evidence-based quality checks

### Files to Modify

| File | Change |
|------|--------|
| `src/context-budget.ts` | NEW — token estimation, context trimming, priority ranking |
| `src/memory.ts` | Budget-aware memory context building |
| `src/providers/router.ts` | Pre-send context budget check |
| `src/self-monitor.ts` | NEW — response quality checks, failure detection, retry logic |
| `tests/` | New: `context-budget.test.ts`, `self-monitor.test.ts` |

---

## Sprint S9: User Documentation — AFTER S8, BEFORE E2E

**Goal:** Comprehensive documentation of the finished product before validation.

Positioned after all engineering sprints are complete so we document a stable, complete system — not a moving target. Writing docs doubles as an implicit feature walkthrough that feeds into S4 (E2E).

### Deliverables

| Document | Contents |
|----------|----------|
| `docs/user-guide.md` | Complete user guide: getting started, all commands with examples, skills explained, tool usage, voice features, proactive messaging, auto-routing, digests, tips & tricks |
| `docs/architecture.md` | Internal architecture: provider routing, memory lifecycle, episode compression, tool registry, auto-triggering, orchestration, context budgeting |
| `docs/commands.md` | Quick reference card — all Telegram + Matrix commands in one place |
| `README.md` update | Project overview, feature list, setup instructions, links to docs |
| In-bot `/help` | Categorized command display (grouped by function, not a flat list) |

### Design Principle

> Document the *finished* product. The hard engineering comes first — documentation follows when the system is stable and complete. This discipline ensures docs reflect reality, not aspirations.

---

## Sprint S4: Full E2E Validation — AFTER S9

**Goal:** One concentrated testing sweep covering ALL features from all sprints.

### Test Scope

| Area | Tests | Source |
|------|-------|--------|
| Tool Forge (Phase 3) | 3.1-3.12 | `scripts/e2e-voice-forge.md` |
| Voice Web Chat (Phase 4) | 4.0-4.4 | `scripts/e2e-voice-forge.md` |
| Cross-Feature Integration (Phase 5) | 5.1-5.6 | `scripts/e2e-voice-forge.md` |
| Episode Compression (S1) | Verify compression triggers, episode quality, memory context inclusion |
| Auto-Routing (S1) | Verify heuristics, override behavior, `/auto` toggle |
| Superpowers Skills (S2) | Verify `debugger`, `brainstormer`, `careful` activation and behavior |
| Proactive Messaging (S5) | Verify follow-ups, digests, task notifications, smart reminders |
| Skill Auto-Triggering (S6) | Verify intent detection, auto-activation, user override |
| Multi-Step Orchestration (S7) | Verify task decomposition, progress tracking, failure handling |
| Context Budgeting (S8) | Verify token estimation, context trimming, self-monitoring |
| Documentation (S9) | Verify docs match actual behavior, commands reference is complete |

---

## Sprint S3: Cloud Deployment — LAST

**Status:** Deferred pending user decision on hosting provider.

**Options under evaluation:**
- Oracle Cloud Always Free: 4 ARM cores, 24GB RAM, 200GB storage, free forever. Tight for voice (Speaches needs 2-4GB). Instance reclamation risk.
- Fly.io: Pay-per-use, x86_64, GPU options. More predictable but not free.
- Other paid VPS providers: TBD

**When ready:** Create ARM-compatible docker-compose, deployment scripts, health heartbeat cron.

---

## Sprint S10: GitHub + Render + Screenshots — COMPLETED (2026-03-21)

**Goal:** Full development workflow from Telegram — code repos, deploy, verify visually.

### Architecture: Hybrid MCP + Ollama Tools

Both providers get GitHub/Render access, each using their native mechanism:

| Provider | GitHub Access | Render Access | Screenshots |
|----------|-------------|---------------|-------------|
| **Claude** | GitHub MCP server (full API — repos, issues, PRs, code search, diffs, commits) | Render MCP server (already registered — deploys, logs, services) | Puppeteer tool (shared) |
| **Ollama** | `gh` CLI wrapper tools (clone, read, commit, push, create PR, list issues) | Lightweight Render status tools wrapping API | Puppeteer tool (shared) |

**Why hybrid:** Claude gets the richer MCP interface for complex code review, deep diffs, and multi-file operations. Ollama gets basic `gh` CLI tools for simple operations. Auto-routing (S1) sends complex GitHub tasks to Claude, simple ones to Ollama.

### Features

#### 10.1 Infrastructure
- **Persistent workspace**: Docker volume mounted at `/workspace` for project files that survive restarts
- **`gh` CLI in Docker**: Install in Dockerfile, authenticate via `GH_TOKEN` env var
- **Puppeteer in Docker**: Headless Chromium for screenshots (~400MB image increase)

#### 10.2 GitHub MCP Server (Claude)
- Install `@modelcontextprotocol/server-github` (or equivalent)
- Configure in Claude Code MCP settings
- Provides: repo contents, file read/write, issue CRUD, PR CRUD, code search, commit history, branch management
- No custom code needed — pre-built MCP server

#### 10.3 GitHub Ollama Tools
- `github_clone_repo(owner, repo)` — clone to persistent workspace
- `github_read_file(owner, repo, path)` — read file from repo via `gh api`
- `github_list_issues(owner, repo, state)` — list issues
- `github_list_prs(owner, repo, state)` — list pull requests
- `github_create_branch(repo, branch, base)` — create branch
- `github_commit_push(repo, message, files)` — stage, commit, push
- `github_create_pr(repo, title, body, head, base)` — open PR
- `github_diff(repo)` — show `git diff` formatted for Telegram

#### 10.4 Render Integration
- Wire up existing Render MCP tools for Claude (already registered as deferred)
- Add Ollama tools: `render_deploy_status(service)`, `render_list_services()`, `render_get_logs(service)`
- Deploy verification: after push, poll deploy status until complete

#### 10.5 Screenshots
- New shared tool: `take_screenshot(url, selector?)` — Puppeteer captures page
- Returns image sent via Telegram `sendPhoto` / Matrix file upload
- Optional CSS selector for capturing specific elements
- Diff preview: `git diff` formatted as code block before committing

### Files to Create/Modify

| File | Change |
|------|--------|
| `Dockerfile` | Add `gh` CLI, Puppeteer, persistent workspace volume |
| `docker-compose.yml` | Mount `/workspace` volume |
| `.env.example` | Add `GH_TOKEN`, MCP config paths |
| `src/providers/tools/github-*.ts` | New Ollama GitHub tools (6-8 files) |
| `src/providers/tools/render-status.ts` | New Ollama Render tools |
| `src/providers/tools/screenshot.ts` | Puppeteer screenshot tool |
| `src/providers/tools/index.ts` | Register new tools |
| MCP config | GitHub + Render MCP server configuration for Claude |
| `tests/` | New: `github-tools.test.ts`, `screenshot.test.ts` |

---

## Sprint S11: Kanban Collaboration Layer — COMPLETED (2026-03-21)

**Goal:** Shared project board where both human and bot track, assign, and manage work.

### Features
- **Web Kanban board**: Columns (Backlog → In Progress → Review → Done → Deferred → Cancelled)
- **Card model**: title, description, assignee (me/bot/collaborative/noted), priority, due date, labels
- **Proactive card creation**: Bot detects opportunities in conversation → auto-creates Backlog cards
- **Assignment workflow**: User assigns cards via web UI or Telegram (`/board assign <id> bot`)
- **Bot-assigned execution**: Scheduler picks up bot-assigned cards, works on them, moves to Review
- **Notification**: Bot notifies when bot-assigned tasks complete or when blocked on collaborative tasks
- **Telegram commands**: `/board list`, `/board add`, `/board move`, `/board assign`

### Design principle
> "Like working with a partner and distributing the workload"

---

## Sprint S12: Learning Coach — COMPLETED (2026-03-22)

**Goal:** Structured micro-learning sessions with AI-driven curriculum, spaced repetition, and 5 teaching personas.

### Implemented
- **`src/learning/`** directory: db.ts, spaced-repetition.ts, personas.ts, plan.ts, session.ts, index.ts
- **Plan generation**: AI creates 8-15 topic curriculum from user goal, rolling horizon expands when ≤2 pending
- **5 teaching personas**: Guiding Challenger, Encouraging Coach, Friendly Conversationalist, Expert Scholar, Creative Mentor (from ai-language-tutor-app/personas/)
- **Spaced repetition**: Forgetting curve (`mastery * (1-0.15)^days`), review intervals (1/2/3/7 days), mastery delta (+0.05/-0.03)
- **Session engine**: In-memory state machine, assessment markers ([CORRECT]/[INCORRECT]/[TOPIC_COMPLETE]), timeout cleanup (15 min)
- **Plan negotiation**: Add/move/remove topics. Removal requires assessment quiz (80%+ to pass). Coach has final curriculum authority
- **Max 5 concurrent plans**: Completion encouragement, anti-boredom nudges for stale plans (7+ days), session rotation
- **Daily time tracking**: 10 min/day goal, weekly breakdown
- **`/learn` command**: 16 subcommands (start, plan, plans, session, review, move, add, remove, persona, time, set-time, complete, pause, resume, done, delete)
- **`learning-coach` builtin skill**: Auto-suggest trigger for "quiz me", "teach me", "learn about"
- **Session gate in handleMessage**: Active sessions route through learning handler before orchestration
- **Assessment-gated removal**: Coach runs 5-question quiz to verify competence before deferring a topic
- **Rolling horizon**: Auto-generates next 3-5 topics when ≤2 pending remain
- **Graduation**: `/learn complete` with coach challenge if weak areas remain

### Files Modified
| File | Change |
|------|--------|
| `src/learning/db.ts` | 4 tables, CRUD, smart queries (least-recent, most-overdue, stale plans) |
| `src/learning/spaced-repetition.ts` | Pure functions: decay, delta, intervals, topic selection |
| `src/learning/personas.ts` | 5 personas + global guidelines, subject heuristic |
| `src/learning/plan.ts` | AI plan generation, parsing, expansion, negotiation, assessment |
| `src/learning/session.ts` | State machine, markers, system prompts, timeout cleanup |
| `src/learning/index.ts` | Barrel export |
| `src/skills.ts` | Added `builtin-learning-coach` + suggest trigger |
| `src/platforms/telegram.ts` | `/learn` command (16 subcommands) + session gate in handleMessage |
| `src/providers/router.ts` | Added `/learn` to COMMAND_LIST |
| `src/db.ts` | Wire `initLearningTables()` |
| `src/index.ts` | Wire `initSessionCleanup()` |
| `tests/learning.test.ts` | 60 tests (spaced repetition, personas, plan parsing, DB CRUD, integration) |

### Test Results
- 39 test files, 666 tests, all passing (60 new)

### Resources evaluated
- edwinjojie/ai-study-coach: Adopted forgetting curve algorithm, mastery tracking
- ShubhamMahajan880/studyAlpha-Ai-Agent: Adopted weakness prediction concept
- Harshal-Bsys27/ai-study-planner: Adopted DB schema pattern

---

## Sprint S13: Research & Reporting Tools — COMPLETED (2026-03-22)

**Goal:** Professional research and reporting tools for academic work, presentations, and document generation.

### Implemented
- **PPTX generation**: `pptxgenjs` via `generatePptx()` in `src/docgen.ts`. 6 slide layouts: title, bullets, two-column, chart, image, blank. Dark professional theme, speaker notes, chart integration.
- **Citation tracking**: `src/citations.ts` — DB table, CRUD, deduplication, export as BibTeX/APA/Chicago. `/cite list`, `/cite export`, `/cite clear` commands.
- **Paper search**: `src/providers/tools/research.ts` — Semantic Scholar API + arXiv API. `search_papers` tool with year filtering, source selection, auto-save as citations. `/research <query>` Telegram command with `--arxiv`, `--scholar`, `--year` flags.
- **Report review**: `review_report` tool — parses uploaded docs, generates structured review prompts (gaps, clarity, data_quality, full).
- **Citation management**: `manage_citations` tool — list, export, clear via AI tool calls.
- **Domain skills**: `researcher` (academic rigor, citation discipline, hypothesis framing) + `manufacturing-expert` (Lean/Six Sigma, DMAIC, TIMWOODS, process thinking).
- **AI prompt updates**: PPTX format added to CLAUDE_DOCUMENT_PROMPT. Citation awareness added. Tool list updated in Ollama system prompt.

### Files
| File | Change |
|------|--------|
| `src/docgen.ts` | PPTX format + `generatePptx()` + type guards for content discrimination |
| `src/citations.ts` | **NEW** — citation DB, CRUD, BibTeX/APA/Chicago export |
| `src/providers/tools/research.ts` | **NEW** — search_papers, manage_citations, review_report |
| `src/providers/tools/index.ts` | Registered 3 new tools (26 total) |
| `src/skills.ts` | Added `researcher` + `manufacturing-expert` skills (11 builtin) |
| `src/platforms/telegram.ts` | `/cite` + `/research` commands |
| `src/providers/router.ts` | PPTX in CLAUDE_DOCUMENT_PROMPT, COMMAND_LIST updated |
| `src/providers/ollama.ts` | Tool list updated in system prompt |
| `src/db.ts` | Wire `initCitationTable()` |
| `tests/research.test.ts` | **NEW** — 24 tests (citations, exports, arXiv parsing, PPTX generation) |

### Test Results
- 40 test files, 706 tests, all passing (24 new)

### What S13 Does NOT Include
- SimPy/MiniZinc simulations (moved to S16)
- ClawMFG manufacturing tools (S14-S15)

---

## Sprint S14: ClawMFG Chat-Native Tools — NOT STARTED

**Goal:** 6 manufacturing optimization tools implemented as clauded Ollama tools + skills. Each tool accepts CSV/JSON input via Telegram, executes core algorithms locally, and returns results + visualizations.

**Source specs:** Google Drive `ClawMFG_Suite_Implementation_Plan` (18 documents, evaluated 2026-03-22). Evaluation: `memory/project_clawmfg_evaluation.md`.

**Design principle:** FULL FUNCTIONALITY, not simplified versions. These must produce results a manufacturing engineer would trust for production decisions. No toy implementations.

### S14.1: Assembly Line Balance Tool
**Algorithm:** Ranked Positional Weight (RPW) heuristic with precedence constraint handling.
**Input:** CSV with columns: task_id, task_name, time_seconds, predecessors (comma-separated), station_requirement (optional). Plus takt_time parameter.
**Processing:**
- Calculate positional weights: PW(i) = task_time(i) + sum(all successor weights)
- Topological sort respecting precedence
- Greedy station assignment: assign highest-weight unassigned task that fits remaining station time
- Handle constraints: zone restrictions, operator skill requirements, equipment dependencies
**Output:**
- Station assignments with load percentages
- Balance efficiency: `(sum of task times) / (num_stations × cycle_time) × 100`
- Smoothness index: `sqrt(sum((max_station_time - station_time_i)²) / num_stations)`
- Idle time per station
- Gantt chart (PNG via chart library)
- CSV export of assignments
**Commands:** `/balance <attach CSV>`, `/balance-compare`, `/balance-status`
**DB tables:** `balance_projects`, `balance_tasks`, `balance_results`, `station_assignments`

### S14.2: Six Sigma KPI Tracking
**Algorithms:** Process capability (Cp, Cpk, Pp, Ppk), DPMO, sigma level, rolled throughput yield.
**Input:** CSV with measurement data + spec limits (USL, LSL, target).
**Processing:**
- Capability indices: `Cp = (USL - LSL) / 6σ`, `Cpk = min((USL - μ) / 3σ, (μ - LSL) / 3σ)`
- DPMO: `(defects / (units × opportunities)) × 1,000,000`
- Sigma level from DPMO lookup table
- Control chart generation: X-bar, R, p, c, u charts
- Western Electric rules (all 8) for out-of-control detection
- Pareto analysis of defect types
**Output:**
- Capability report with indices and interpretation
- Control charts (PNG)
- Violation alerts with rule identification
- DMAIC project tracking status
**Commands:** `/sigma-capability <attach CSV>`, `/sigma-chart`, `/sigma-pareto`
**DB tables:** `sigma_projects`, `measurements`, `control_limits`, `violations`, `improvement_projects`

### S14.3: Inventory Planning & Replenishment
**Algorithms:** EOQ, reorder point, safety stock, ABC classification, exponential smoothing.
**Input:** CSV with item data: item_id, description, annual_demand, unit_cost, order_cost, holding_cost_pct, lead_time_days, service_level.
**Processing:**
- EOQ: `Q* = sqrt(2DS/H)` where D=annual demand, S=order cost, H=holding cost per unit
- Reorder point: `ROP = (daily_demand × lead_time) + safety_stock`
- Safety stock: `SS = Z × σ_demand × sqrt(lead_time)` (Z from service level)
- ABC classification: sort by annual dollar volume, classify top 80% as A, next 15% as B, rest as C
- Demand forecast: single/double/triple exponential smoothing with auto-selected alpha
**Output:**
- Replenishment plan per item (order quantity, reorder point, safety stock)
- ABC classification matrix
- Total inventory investment and carrying cost
- Forecast vs actual chart (PNG)
- Stockout risk alerts
**Commands:** `/inventory-plan <attach CSV>`, `/inventory-abc`, `/inventory-forecast`
**DB tables:** `inventory_items`, `demand_history`, `replenishment_orders`, `abc_classification`

### S14.4: SPC & Trend Detection
**Algorithms:** CUSUM, EWMA, Nelson rules, Western Electric rules, trend regression.
**Input:** CSV with time-series measurements: timestamp, value, (optional: subgroup_id, spec_limits).
**Processing:**
- Control limits: `UCL/LCL = μ ± 3σ` (calculated from baseline period)
- CUSUM: `C⁺ᵢ = max(0, Cᵢ₋₁ + xᵢ - μ₀ - k)`, `C⁻ᵢ = max(0, Cᵢ₋₁ - xᵢ + μ₀ - k)` with decision interval h
- EWMA: `Zᵢ = λxᵢ + (1-λ)Zᵢ₋₁` with control limits `μ₀ ± L × σ × sqrt(λ/(2-λ) × (1-(1-λ)²ⁱ))`
- All 8 Nelson rules checked per data point
- Trend detection via linear regression on sliding window
- Capability study: Cp, Cpk with confidence intervals
**Output:**
- Control chart with violations highlighted (PNG)
- CUSUM/EWMA charts (PNG)
- Rule violation report with timestamps and rule IDs
- Trend alerts with slope, R², predicted out-of-spec date
- Capability summary
**Commands:** `/spc-chart <attach CSV>`, `/spc-cusum`, `/spc-ewma`, `/spc-capability`
**DB tables:** `spc_projects`, `measurements`, `control_limits`, `rule_violations`, `capability_studies`

### S14.5: FMEA (PFMEA & DFMEA)
**Algorithm:** Risk Priority Number with structured failure mode cataloging.
**Input:** Conversational or CSV: process_step, failure_mode, effect, severity(1-10), cause, occurrence(1-10), detection_method, detection(1-10).
**Processing:**
- RPN = Severity × Occurrence × Detection
- Risk threshold: RPN > 100 → action required
- Alternative priority: Action Priority (AP) per AIAG-VDA FMEA (severity-first)
- Pareto of failure modes by RPN
- Action tracking with RPN before/after comparison
**Output:**
- FMEA worksheet (formatted table)
- Risk matrix heatmap (severity × occurrence)
- Top-10 risks by RPN
- Action plan with owners and deadlines
- RPN reduction trend chart
- Export as CSV or PDF
**Commands:** `/fmea-create`, `/fmea-add <step> <failure> <effect>`, `/fmea-risk`, `/fmea-actions`, `/fmea-report`
**DB tables:** `fmea_documents`, `failure_modes`, `effects`, `causes`, `controls`, `action_items`, `rpn_history`

### S14.6: Root Cause Analysis
**Algorithms:** 5 Whys (iterative questioning), Ishikawa/Fishbone (6M categorization), Pareto analysis.
**Input:** Problem statement (conversational). Supporting data optional (CSV with defect counts, timestamps).
**Processing:**
- 5 Whys: AI-guided iterative questioning (up to 5 levels deep). Each "why" validated for logical causality. Branching when multiple causes exist.
- Fishbone: Categorize causes into 6M (Man, Machine, Method, Material, Measurement, Mother Nature/Environment). AI assists with brainstorming causes per category.
- Pareto: Sort contributing factors by frequency/impact. Identify vital few (80/20).
- Correlation: If data provided, calculate correlation between suspected causes and defect occurrence.
**Output:**
- 5 Whys tree (text + Mermaid diagram)
- Fishbone diagram (Mermaid)
- Pareto chart (PNG)
- Root cause summary with confidence level
- Corrective action plan with verification criteria
- Export as PDF report
**Commands:** `/rca-start <problem>`, `/rca-why <answer>`, `/rca-fishbone`, `/rca-pareto <attach CSV>`, `/rca-actions`
**DB tables:** `rca_investigations`, `problems`, `causes`, `fishbone_branches`, `corrective_actions`, `verification_data`

---

## Sprint S15: ClawMFG Web Apps — COMPLETE ✅

**Goal:** 7 manufacturing tools requiring interactive web UIs, implemented as dedicated dashboards served from clauded's web server (same pattern as board.html, learn.html). Each tool gets its own HTML page with WebSocket data flow.

**Design principle:** These are REAL engineering tools, not demos. Interactive visualizations, real-time updates, drag-and-drop where appropriate. A plant manager or IE should be able to use these for daily decisions.

**Architecture:** Each tool = `src/web/public/mfg-<name>.html` + WebSocket handlers in `src/web/server.ts` + algorithm module in `src/mfg/<name>/`. Same auth, same dark theme, same security headers.

### S15.1: Capacity Planning & Simulation
- Monte Carlo engine (1000+ iterations) with configurable distributions (normal, Poisson, triangular)
- Interactive resource utilization heatmaps (machines × time periods)
- Scenario builder: current state vs proposed changes (add shift, add machine, change mix)
- Bottleneck identification with constraint ranking
- Investment ROI calculator: "If we add machine X, throughput increases Y%, payback in Z months"
- Confidence interval reporting (90%, 95%, 99%)
- Drag timeline to adjust planning horizon

### S15.2: Sequence Simulator
- Genetic algorithm for job sequencing with configurable objectives (minimize makespan, minimize lateness, minimize setup time)
- Dispatching rule comparison: SPT, EDD, CR, FIFO side-by-side
- Interactive Gantt chart: drag jobs to reassign, click to see details
- Setup time matrix visualization
- Real-time progress tracking (mark jobs as started/completed)
- Due date adherence dashboard
- Export schedule as CSV/PDF

### S15.3: Value Stream Mapping
- Visual process flow editor (drag-and-drop process steps, inventory triangles, information flows)
- Automatic TIMWOODS waste classification
- Lead time waterfall chart (VA vs NVA time breakdown)
- Process Cycle Efficiency calculation: `PCE = VA time / total lead time`
- Current state → Future state side-by-side comparison
- Kaizen burst annotations
- Export as SVG/PNG/PDF

### S15.4: TOC & WIP Tracking
- Constraint identification dashboard (CCR highlighted)
- Drum-Buffer-Rope visualization
- Buffer management: red/yellow/green status bars for time buffers, capacity buffers, stock buffers
- Throughput accounting: Revenue - TVC = Throughput, ROI = (T - OE) / I
- Real-time WIP level gauges per work center
- Historical throughput trend charts
- Rope release schedule

### S15.5: CONWIP & Heijunka Production Leveling
- CONWIP token board: visual cards circulating through production stages
- Heijunka box: grid of product types × time slots, drag to level
- Pitch calculation: takt time × pack-out quantity
- Leveling score visualization: deviation from ideal mix
- WIP limit enforcement with alerts
- Changeover time optimization suggestions
- Shift-by-shift production plan export

### S15.6: Design of Experiments
- Design wizard: select factors, levels, response variables → auto-generate experiment matrix
- Support for 2^k full factorial, 2^(k-p) fractional, Taguchi L-arrays, Box-Behnken, Central Composite
- ANOVA table with F-test, p-values, contribution percentages
- Main effects plots and interaction plots (interactive)
- Response surface contour plots (3D rotatable)
- Desirability function for multi-response optimization
- Confirmation run tracker
- Randomization and blocking support

### S15.7: State Machine Visual Simulators
- Interactive canvas with drag-and-drop state nodes and transition arrows
- Property editors for states (entry/exit actions, color coding) and transitions (events, guards, actions, timing)
- Simulation modes: automatic, manual (click events), step-through, breakpoint, fast-forward
- Visual feedback: current state highlighted, active transition animated, event queue displayed
- Validation engine: reachability analysis, deadlock detection, completeness check, guard contradiction detection
- Code generation: export as PLC Structured Text, Python, JavaScript
- Templates: CNC Machine, Conveyor System, AGV Navigation, Order Processing
- Version comparison (diff two machine versions)
- Auto-generate test cases from state machine structure

---

## Sprint S16: Manufacturing Simulations — COMPLETE ✅

**Goal:** Discrete-event simulation (SimPy) and constraint optimization (MiniZinc) engines integrated into clauded for production modeling and optimal scheduling.

### SimPy Integration
- Python-based discrete-event simulation via subprocess execution in Docker
- Pre-built simulation templates: single-server queue, multi-server queue, production line with buffers, job shop with breakdowns
- Input: process parameters (cycle times, MTBF, MTTR, batch sizes, shift patterns) via CSV or conversation
- Output: utilization statistics, queue lengths, throughput, WIP over time, bottleneck identification
- Visualization: time-series charts of simulation results (PNG export)
- Monte Carlo wrapper: run N simulations with parameter distributions, report confidence intervals
- Integration with S14/S15: feed simulation results into capacity planning (S15.1) or compare with SPC data (S14.4)

### MiniZinc Integration
- Constraint satisfaction and optimization via MiniZinc solver (installed in Docker)
- Pre-built models: job scheduling (minimize makespan), resource allocation (maximize utilization), production planning (minimize cost), facility layout (minimize material flow)
- Input: decision variables, constraints, objective function — defined conversationally or via structured JSON
- Output: optimal solution with variable assignments, objective value, solve time
- Sensitivity analysis: how does the optimum change as constraints relax?
- Integration with S14: feed optimal schedules into sequence simulator (S14/S15.2)

### Skill
- `simulation-expert` built-in skill: helps user formulate problems, select appropriate simulation/optimization approach, interpret results

---

## Sprint S9: User Documentation — COMPLETED (2026-03-29)

**Goal:** Comprehensive user documentation for all clauded features.

### Deliverables
- `docs/user-guide.md` — Complete user guide (getting started with Docker, all features, configuration, tips)
- `docs/architecture.md` — Internal architecture (provider routing, memory lifecycle, episode compression, context budgeting, Docker deployment, security model)
- `docs/commands.md` — Quick reference card (all 35 Telegram/Matrix commands, web UIs, tools)
- `README.md` — Project overview, Docker setup, feature list, tech stack, doc links
- In-bot `/help` command — Categorized command display (Telegram + Matrix), grouped by function

---

## Sprint S4: Full E2E Validation — NOT STARTED (after S9)

**Goal:** End-to-end testing of all features across all sprints in production environment.

---

## Sprint S3: Cloud Deployment — NOT STARTED (after S4)

**Goal:** Deploy clauded to cloud infrastructure (Render or Oracle Cloud).

---

## Deferred Enhancements

| Enhancement | Source | Rationale for Deferral |
|-------------|--------|----------------------|
| Multi-agent routing | openclaw tutorial | Telegram Forum Topics (S11) solves this differently |
| Execution sandbox | open-terminal | Persistent workspace (S10) addresses this need |
| Telegram Forum Topics | OpenClaw architecture | Evaluate after S11 Kanban — may combine or sequence |

---

## External Source Evaluations (2026-03-18)

Comprehensive evaluation of 7 external sources against clauded's architecture:

### 1. Slate (Random Labs) — Thread Weaving & Episodes
- **Paper:** https://randomlabs.ai/blog/slate (33 pages, read in full)
- **Key concept:** Threads as bounded worker units producing compressed "episodes." Episodes compose back into orchestrator context. Solves working memory degradation, strategy/tactics balance, context synchronization.
- **Adopted:** Episode compression concept for memory system (S1)
- **Not adopted:** Full thread weaving architecture (clauded is a chatbot, not a coding agent — threads are overkill)
- **Connection to existing work:** Maps to professor.md Filtration Analysis framework (relevance → feasibility → impact filters)

### 2. gstack (Garry Tan) — 21 Structured Skills for Claude Code
- **Repo:** https://github.com/garrytan/gstack (31.1k stars, MIT)
- **Key concept:** Sprint-based workflow with safety guardrails (`/careful`, `/freeze`, `/guard`)
- **Adopted:** Safety guardrails pattern only (S2 — `careful` skill)
- **Not adopted:** Developer workflow skills (plan, review, QA, ship) — different problem space

### 3. open-terminal (Open WebUI) — Execution Sandbox
- **Repo:** https://github.com/open-webui/open-terminal (2k stars, MIT)
- **Key concept:** REST API-accessible shell for AI agents
- **Not adopted:** Clauded already has execution via Claude CLI subprocess and Ollama in-process tools. Adding HTTP sandbox would increase complexity without clear benefit.
- **Revisit if:** Ollama needs sandboxed arbitrary code execution in the future

### 4. Superpowers (obra) — Composable Skills for AI Agents
- **Repo:** https://github.com/obra/superpowers (v5.0.5, MIT)
- **Key concepts:** Anti-rationalization tables, TDD enforcement, systematic debugging, subagent orchestration, verification gates
- **Adopted:** 4 skills adapted for assistant context (S2 — debugger, brainstormer, verifier, orchestrator). Anti-rationalization prompting applied globally.
- **Not adopted:** TDD (developer-specific), git worktrees, code review workflows
- **Top priority** alongside Slate for the user

### 5. build-your-own-openclaw — AI Agent Tutorial
- **Repo:** https://github.com/czl9707/build-your-own-openclaw (425 stars)
- **Key concept:** 18-step tutorial building an AI agent (skills, tools, persistence, channels, scheduling)
- **Not adopted:** Clauded already implements 90%+ of this tutorial's scope
- **Noted:** Multi-agent routing and proactive messaging as nice-to-have (deferred)

### 6. HiClaw (Alibaba) — Multi-Agent OS
- **Repo:** https://github.com/alibaba/hiclaw (2.7k stars, Apache 2.0)
- **Key concept:** Matrix-based multi-agent orchestration with Manager-Workers pattern, MinIO file sharing, Higress API gateway
- **Not adopted:** Enterprise-scale infrastructure, overkill for personal assistant

### 7. Oracle Cloud Always Free — Deployment
- **Article:** https://pub.towardsai.net/how-to-run-your-own-ai-assistant-for-free-openclaw-on-oracle-cloud-with-ollama-dead8ae62726
- **Specs:** 4 ARM cores, 24GB RAM, 200GB storage, free forever
- **Assessment:** Feasible for clauded + Ollama. Voice (Speaches) tight on RAM. ARM image compatibility needs verification. Instance reclamation risk.
- **Status:** Deferred (S3) — user evaluating paid alternatives

---

## Architecture References

| Source | Concepts Used | Where Applied |
|--------|--------------|---------------|
| Slate | Episode compression, Filtration Analysis | S1: memory.ts |
| Slate | Strategy vs tactics distinction | S1: auto-routing heuristics |
| Superpowers | Systematic debugging methodology | S2: debugger skill |
| Superpowers | Anti-rationalization tables | S2: global system prompt rules |
| Superpowers | Verification before completion | S2: verifier system prompt |
| gstack | Safety guardrails | S2: careful skill |
| professor.md | Filtration Analysis framework | S1: episode compression prompt |

---

## Key Design Decisions (2026-03-18, updated 2026-03-22)

1. **Episode compression uses AI summarization** — not just truncation. Ollama preferred, Claude fallback.
2. **Auto-routing is heuristic-based** — no AI call for routing decisions. Fast, predictable.
3. **Provider override is slash-command only** — natural language does NOT override. `/claude`, `/ollama` lock; `/auto` returns to automatic.
4. **Superpowers skills adapted for assistant context** — not direct ports of developer workflows.
5. **Anti-rationalization rules applied globally** — not a switchable skill, always in system prompt.
6. **Full E2E validation batched at end (S4)** — after all development sprints complete. Quick smoke tests after each sprint.
7. **Sprint order prioritizes autonomy impact** — proactive messaging → skill auto-triggering → orchestration → optimization → E2E → deploy.
8. **Implementation quality standard (2026-03-22)** — Goal is FULL FUNCTIONALITY, not "good enough" or simplified versions. Manufacturing tools must produce results an IE would trust for production decisions. No toy implementations. No complexity-driven scope reductions. If the algorithm requires Monte Carlo with 1000 iterations, run 1000 iterations. If ANOVA needs proper F-test with p-values, compute them correctly. The user's bar is a real engineering partner, not a demo.
9. **ClawMFG split: chat vs web (2026-03-22)** — 6 tools are chat-native (CSV→algorithm→results, S14). 7 tools need interactive web UIs (S15). This is a scope decision, not a quality compromise. Both tiers get full implementations.
10. **Security is cloud-ready from day one (2026-03-22)** — First-message WebSocket auth (no tokens in URLs), Origin validation, CSP headers, rate limiting. Every web UI built for eventual cloud deployment, not just localhost.

## Testing Policy (enforced from S1 onward)

**All tests MUST verify real-world functionality, not mocked behavior:**

1. **No mocked data** — Tests use real SQLite databases (in-memory or temp files) with the same schema as production. No fake objects that bypass actual DB behavior.
2. **No duplicated logic** — Tests import actual functions from source code. Never copy-paste patterns or classifiers into test files — if the source changes, tests must break.
3. **Real-world scenarios** — Tests must verify the feature solves the user's actual need. An "insert + select" test is not enough — test the full flow (e.g., "insert memories → decay → compress → verify episode is searchable").
4. **Edge cases and failure modes** — Test what happens when dependencies are unavailable (Ollama down, empty data, threshold boundaries). Verify graceful degradation.
5. **Exported for testing** — Functions that need testing should be exported from source modules, not reimplemented in test files. Mark with `/** Exported for testing. */` comment.
6. **Integration over isolation** — Prefer end-to-end flow tests that exercise multiple components together. Unit tests are fine for pure functions, but the real value is in integration tests that prove the feature works as a whole.

## Real-World Issues Found & Fixed (Sprint S1 review, 2026-03-18)

These issues were identified during a critical review of whether the implementation actually works in real-world usage, not just passes tests:

1. **Compression timing was too late (60 days → 18 days):** Original threshold 0.3 meant memories had to decay for ~60 days before compression. Changed to 0.7 (~18 days). Memories are now compressed while they're still recent enough to have meaningful context.

2. **Ollama down = silent data loss → protected:** If Ollama is unreachable during compression, memories were left to decay below 0.1 and get deleted without ever being compressed. Fix: when compression fails, boost compressible memories' salience to 0.15 to protect them from deletion until the next successful compression.

3. **Auto-routing split conversation context → stickiness added:** In auto mode, messages could ping-pong between Claude and Ollama, breaking conversation history. Fix: once a conversation starts on Claude, it stays on Claude (no downgrade). Ollama → Claude upgrades are allowed when the classifier detects complexity. Stickiness resets on `/newchat` or `/auto` toggle.

4. **`/provider` showed wrong info in auto mode → shows last-used:** In auto mode, `/provider` was showing the fallback provider, not which provider actually processed the last message. Fix: tracks `lastUsedProvider` per chat and displays that in auto mode.

5. **Groups of 1-2 memories never compressed → minimum removed:** Original code required groups of ≥3 memories. Short conversations (1-2 turns) would never be compressed. Fix: removed the minimum group size — even single memories are worth compressing if they've decayed enough.

6. **30-minute grouping too aggressive → 1 hour:** A 30-minute gap split conversations that had natural pauses (user goes to bathroom, gets coffee). Widened to 1 hour.

7. **Memory context formatting:** Episodes now appear first in context (labeled `[Past conversation]`), before individual memories. This gives the AI a clearer hierarchy: high-level episode summaries first, then specific details.
