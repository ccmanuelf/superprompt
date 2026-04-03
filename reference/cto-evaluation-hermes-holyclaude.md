# CTO Evaluation: clauded vs Hermes Agent vs HolyClaude

> Prepared 2026-04-03 | For executive review
> References: github.com/nousresearch/hermes-agent | github.com/CoderLuii/HolyClaude

---

## Executive Summary

Three fundamentally different tools solving different problems:

| Tool | What It Is | Primary Audience | Core Value |
|------|-----------|-----------------|-----------|
| **clauded** | Conversational AI operations platform | Manufacturing, Engineering, cross-department | Domain-specific tools + dashboards + multi-user operations hub |
| **Hermes Agent** | Self-improving AI coding agent | Software developers + AI researchers | Auto-learning skills + multi-model + terminal-native |
| **HolyClaude** | Pre-configured Claude Code Docker image | DevOps / dev teams needing containerized Claude | Zero-config Docker setup for Claude Code (50+ dev tools pre-installed) |

**Key insight:** These are not competing products. They occupy different layers:
- **HolyClaude** = infrastructure (how to run Claude in Docker)
- **Hermes Agent** = developer productivity (AI coding assistant)
- **clauded** = business operations platform (AI operations partner for non-dev teams)

---

## Detailed Comparison

### Architecture

| Dimension | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Language | TypeScript / Node.js | Python | Shell + Docker |
| Deployment | Docker Compose (3 services) | pip install + terminal | Docker Compose (1 service) |
| AI Models | Claude CLI + Ollama (local) | 200+ via OpenRouter, any provider | Claude Code only (subscription) |
| Local/offline capable | Yes (Ollama) | No (requires cloud model API) | No (requires Anthropic API) |
| Process management | Node.js + PID file | Python async | s6-overlay |
| Container size | ~2 GB (Node + Chromium + MiniZinc) | N/A (pip package) | ~2-3 GB (Chromium + 50 tools) |

### User Interface

| Dimension | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Primary interface | Telegram / Matrix chat | Terminal (Rich TUI) | Web browser (CloudCLI) |
| Web dashboards | 11 interactive SPAs + docs viewer | None | Web terminal only |
| Voice I/O | Full local STT/TTS (99 languages) | None | None |
| Mobile access | Yes (Telegram app) | No | Browser on any device |
| Multi-user | Yes (per-chat isolation) | Single user | Single user |

### Memory & Learning

| Dimension | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Persistent memory | Dual-layer (semantic + episodic) + vector search | FTS5 sessions + dialectic user model + memory files | Claude Code's built-in memory only |
| Memory search | FTS5 + sqlite-vec embeddings | FTS5 + LLM summarization | None (relies on Claude's context) |
| Episode compression | AI-summarized with open threads → follow-ups | Session summaries | None |
| Auto-decay | Yes (salience-based, ~60 day lifecycle) | Nudge-based consolidation | None |
| **Auto-generated skills** | **No — manually created** | **Yes — learns from experience** | **No** |
| Skill sharing standard | Domain Packs (local) | agentskills.io (community) | None |

### Skills & Tools

| Dimension | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Builtin skills | 5 (debugger, careful, brainstormer, analyst, coder) | Auto-generated from tasks | None (raw Claude Code) |
| Custom skills | Yes (markdown + forge system) | Yes (Python + auto-generated) | Claude Code's native skills |
| Manufacturing tools | 15 modules, 11 web dashboards | None | None |
| Code execution | Docker-sandboxed run_command (whitelist) | 6 backends (local, Docker, SSH, cloud, HPC) | Full container access |
| GitHub integration | gh CLI tools (clone, PR, commit, diff) | Full terminal access | Full terminal access |
| Web browsing | URL summary + screenshots | Full browsing | Full browsing (Playwright) |
| File parsing | PDF, XLSX, DOCX, CSV, PPTX, images | File system access | File system access |
| Document generation | XLSX, DOCX, PDF, PPTX, CSV with charts | Via code execution | Via Claude Code |

### Security

| Dimension | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Security audit | 20 threat vectors assessed + documented | Inherits from OpenClaw (had CVEs) | SYS_ADMIN capability required |
| API auth on endpoints | Token-authenticated | N/A (local CLI) | Web UI auth |
| SSRF protection | Yes (blocklist on URL-fetching tools) | No | No |
| Prompt injection mitigation | Protective framing on all untrusted content | None documented | None (relies on Claude's defaults) |
| Log sanitization | Yes (credentials redacted) | Not documented | Not documented |
| Container isolation | Non-root user, minimal mounts | Varies by backend | SYS_ADMIN + seccomp=unconfined |
| Data locality | All data stays local (SQLite) | Depends on model provider | Credentials local, data local |

### Operations & Manufacturing Capabilities

| Capability | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Production simulation (DES) | Yes + Monte Carlo + MiniZinc | No | No |
| Capacity planning | 12-step + ROI + what-if | No | No |
| Six Sigma / SPC | Cp/Cpk + control charts | No | No |
| FMEA / RCA | Yes (5 Whys, Fishbone, A3) | No | No |
| Line balancing | RPW + yamazumi | No | No |
| DOE | Factorial, Taguchi, ANOVA | No | No |
| Value Stream Mapping | PCE, takt, TIMWOODS | No | No |
| Job sequencing | 6 rules + genetic algorithm | No | No |
| Inventory planning | EOQ, ABC, SES | No | No |
| Kanban board | Built-in with conversational creation | No | No |
| Learning coach | Spaced repetition, 12 personas | No | No |
| Proactive messaging | Follow-ups, digests, reminders | No | No |
| Domain packs | Department customization (Finance, HR, etc.) | No | No |
| Production Hub (planned) | S17/S18: orders, BOM, shortage intelligence | No | No |

### Developer Capabilities

| Capability | clauded | Hermes Agent | HolyClaude |
|-----------|---------|-------------|------------|
| Terminal-native interface | No (chat-based) | Yes (Rich TUI) | Yes (web terminal) |
| Code execution backends | Docker only | 6 backends (local, Docker, SSH, Daytona, Modal, Singularity) | Full container |
| Auto-generated skills | No | Yes (learns from coding tasks) | No |
| Multi-model support | 2 (Claude + Ollama) | 200+ (any provider) | 1 (Claude only) |
| Research/training data | No | Yes (trajectory generation, RL environments) | No |
| Pre-installed dev tools | gh CLI, Chromium, MiniZinc | pip-managed | 50+ (TypeScript, Python, DB clients, etc.) |
| Serverless hibernation | No | Yes (Daytona, Modal) | No |
| Browser automation | Puppeteer (screenshots) | Full browsing | Playwright (full testing) |

---

## Strategic Assessment

### What Each Tool Is Best At

**clauded excels at:**
- Non-developer teams using AI through familiar interfaces (Telegram, web)
- Manufacturing and operations with purpose-built tools and dashboards
- Multi-user, multi-department deployment with isolation
- Bilingual (EN/ES) operations
- Security-hardened deployment with full audit trail
- Department customization via Domain Packs (no code required)

**Hermes Agent excels at:**
- Software developers who live in the terminal
- Tasks that benefit from auto-learning (repeated coding patterns → reusable skills)
- Multi-model flexibility (switch providers without code changes)
- Research and AI training data collection
- Cloud-native execution (serverless, SSH to remote machines)

**HolyClaude excels at:**
- Getting Claude Code running in Docker in 30 seconds
- Teams that already use Claude Code and want containerized deployment
- Pre-configured development environments (50+ tools ready)
- Cross-platform consistency (same container on Linux, Mac, Windows, NAS)

### What Each Tool Cannot Do

| Cannot Do | clauded | Hermes Agent | HolyClaude |
|-----------|:---:|:---:|:---:|
| Manufacturing engineering | — | Cannot | Cannot |
| Web dashboards for non-devs | — | Cannot | Cannot |
| Voice processing | — | Cannot | Cannot |
| Multi-user isolation | — | Cannot | Cannot |
| Auto-learn from experience | Cannot | — | Cannot |
| Switch AI models on the fly | Cannot | — | Cannot |
| Run code on remote servers | Cannot | — | Partial |
| 50+ pre-installed dev tools | Partial | Partial | — |
| Research data collection | Cannot | — | Cannot |

---

## Recommendation

### For the organization as a whole:

**Continue with clauded as the primary platform.** No other tool addresses the manufacturing, operations, multi-department, and bilingual requirements. Neither Hermes nor HolyClaude can replicate the 15 manufacturing modules, 11 dashboards, domain pack system, or the planned S17/S18 Production Hub.

### For the Software Development team specifically:

**Option A (recommended): Software Development domain pack for clauded**
- Add dev-focused tools and skills via `packs/software-dev/`
- Developers use the same Telegram interface as everyone else
- GitHub integration already exists (clone, PR, commit, diff)
- Zero new infrastructure, consistent with organization-wide deployment
- Timeline: days

**Option B: Run HolyClaude alongside clauded for devs who need terminal access**
- HolyClaude is purely infrastructure — pre-configured Claude Code in Docker
- No overlap or conflict with clauded (different purpose entirely)
- Developers who prefer terminal-native Claude Code get it in 30 seconds
- No learning system, no memory, no dashboards — just a well-packaged Claude Code
- Timeline: hours to deploy, but adds infrastructure to maintain

**Option C: Evaluate auto-generated skills (from Hermes) as a future clauded feature**
- The most valuable Hermes concept for clauded users
- When a user solves a complex task, clauded could automatically create a reusable skill from the successful workflow
- Applicable to ALL departments, not just developers
- Manufacturing engineer solves a complex balance → skill auto-created for next time
- Finance analyst builds a budget workflow → skill auto-created
- Timeline: future sprint (S19+), requires design work

### Not recommended:

**Running Hermes Agent as a parallel platform.** It's Python-based (different tech stack), single-user, no web dashboards, no manufacturing tools, and inherits OpenClaw's security profile. The auto-skill-generation concept is valuable but better implemented natively in clauded than by running a separate platform.

---

## Auto-Generated Skills — Feasibility Assessment

This is the single most valuable concept from the Hermes Agent evaluation. Here's how it could work in clauded:

### Current State
- Skills are created manually (`/skill create` or `forge/skills/*.md`)
- The AI does not learn from successful task completions
- Each complex task starts from scratch

### Proposed Enhancement
After a user completes a complex multi-step task successfully, clauded would:

1. **Detect** the task was complex (multi-tool, multi-step, or orchestrated)
2. **Extract** the workflow pattern (what tools were called, in what order, with what parameters)
3. **Draft** a skill definition capturing the pattern
4. **Ask** the user: "That worked well. Want me to save this as a reusable skill for next time?"
5. **If approved:** Store as a user skill with auto-trigger patterns derived from the original request

### Example
```
User: "Whenever a client sends a new order, parse the CSV, validate
       part numbers, check inventory, and flag any shortages."

(User does this manually 3 times with clauded's help)

clauded: "I notice you've done this workflow 3 times. Want me to save
          it as a skill called 'order_intake_check'? Next time you can
          just upload the CSV and I'll run the full workflow."

User: "Yes"

(Skill auto-created with trigger pattern matching CSV uploads
 mentioning orders/parts/inventory)
```

### Feasibility: HIGH
- Skill system already exists (create, store, activate, trigger)
- Tool execution is already logged (activity log)
- Pattern detection could use the same intent scoring infrastructure
- The approval step preserves the "AI doesn't decide" principle
- Would benefit every department, not just developers

### Effort Estimate
- New sprint (S19), 1-2 weeks
- Requires: task completion detection, workflow extraction, skill draft generation, approval UI
- Builds on: existing skill system, tool registry, activity logging

---

## Summary for CTO

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Primary platform | **clauded** | Only tool that addresses manufacturing, multi-department, dashboards, bilingual, security |
| Developer team needs | **Domain pack (Option A)** first | Fastest, no new infrastructure, consistent experience |
| Terminal Claude Code | **HolyClaude (Option B)** if devs specifically request it | Zero conflict with clauded, 30-second setup, purely infrastructure |
| Auto-generated skills | **Future sprint (Option C)** | Most valuable Hermes concept, benefits all departments, feasible to build |
| agentskills.io standard | **Nice-to-have, defer** | Community skill sharing — evaluate after auto-generation is built |
| Replace clauded with Hermes | **Not recommended** | Different tool for different problem; would lose all manufacturing/operations capability |
