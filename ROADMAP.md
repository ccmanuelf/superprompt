# clauded — Enhancement Roadmap

> Last updated: 2026-03-18
> Previous roadmap (superseded): `memory/roadmap.md` (2026-03-13, 8 sprints)

## Summary

After evaluating 7 external sources against clauded's existing architecture, the original 8-sprint plan was consolidated to **3 development sprints + 1 E2E validation sweep**. Sprint 3 (Cloud Deploy) deferred pending decision on hosting provider.

**Execution order: S1 → S2 → S4. S3 deferred.**

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

## Sprint S3: Cloud Deployment (DEFERRED)

**Status:** Deferred pending user decision on hosting provider.

**Options under evaluation:**
- Oracle Cloud Always Free: 4 ARM cores, 24GB RAM, 200GB storage, free forever. Tight for voice (Speaches needs 2-4GB). Instance reclamation risk.
- Fly.io: Pay-per-use, x86_64, GPU options. More predictable but not free.
- Other paid VPS providers: TBD

**When ready:** Create ARM-compatible docker-compose, deployment scripts, health heartbeat cron.

---

## Sprint S4: Full E2E Validation

**Goal:** One concentrated testing sweep covering all existing and new features.

### Test Scope

| Area | Tests | Source |
|------|-------|--------|
| Tool Forge (Phase 3) | 3.1-3.12 | `scripts/e2e-voice-forge.md` |
| Voice Web Chat (Phase 4) | 4.0-4.4 | `scripts/e2e-voice-forge.md` |
| Cross-Feature Integration (Phase 5) | 5.1-5.6 | `scripts/e2e-voice-forge.md` |
| Episode Compression (S1) | New tests | Verify compression triggers, episode quality, memory context inclusion |
| Auto-Routing (S1) | New tests | Verify heuristics, override behavior, `/auto` toggle |
| Superpowers Skills (S2) | New tests | Verify `debugger`, `brainstormer`, `careful` activation and behavior |
| Anti-Rationalization (S2) | New tests | Verify prompt injection, AI behavior changes |
| Command List in Prompts (S2) | New tests | Verify AI can suggest commands |

---

## Deferred Enhancements (Nice to Have)

| Enhancement | Source | Rationale for Deferral |
|-------------|--------|----------------------|
| Multi-agent routing | openclaw tutorial | Overkill for 2-provider personal assistant |
| Proactive messaging | openclaw tutorial | Useful but not core autonomy — scheduler already handles reminders |
| Composable workflows | Slate + Superpowers | Complex orchestration layer; evaluate after S1-S2 prove value |
| Context budgeting | Slate | Optimization — solve after episode compression proves value |
| Execution sandbox | open-terminal | Ollama already executes tools in-process; no need for HTTP sandbox |

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

## Key Design Decisions (2026-03-18)

1. **Episode compression uses AI summarization** — not just truncation. Ollama preferred, Claude fallback.
2. **Auto-routing is heuristic-based** — no AI call for routing decisions. Fast, predictable.
3. **Provider override is slash-command only** — natural language does NOT override. `/claude`, `/ollama` lock; `/auto` returns to automatic.
4. **Superpowers skills adapted for assistant context** — not direct ports of developer workflows.
5. **Anti-rationalization rules applied globally** — not a switchable skill, always in system prompt.
6. **Testing batched at end** — not phase-by-phase. Reduces bottleneck.
7. **Proactive messaging deferred** — scheduler already handles basic reminders; full proactive system is nice-to-have.

## Real-World Issues Found & Fixed (Sprint S1 review, 2026-03-18)

These issues were identified during a critical review of whether the implementation actually works in real-world usage, not just passes tests:

1. **Compression timing was too late (60 days → 18 days):** Original threshold 0.3 meant memories had to decay for ~60 days before compression. Changed to 0.7 (~18 days). Memories are now compressed while they're still recent enough to have meaningful context.

2. **Ollama down = silent data loss → protected:** If Ollama is unreachable during compression, memories were left to decay below 0.1 and get deleted without ever being compressed. Fix: when compression fails, boost compressible memories' salience to 0.15 to protect them from deletion until the next successful compression.

3. **Auto-routing split conversation context → stickiness added:** In auto mode, messages could ping-pong between Claude and Ollama, breaking conversation history. Fix: once a conversation starts on Claude, it stays on Claude (no downgrade). Ollama → Claude upgrades are allowed when the classifier detects complexity. Stickiness resets on `/newchat` or `/auto` toggle.

4. **`/provider` showed wrong info in auto mode → shows last-used:** In auto mode, `/provider` was showing the fallback provider, not which provider actually processed the last message. Fix: tracks `lastUsedProvider` per chat and displays that in auto mode.

5. **Groups of 1-2 memories never compressed → minimum removed:** Original code required groups of ≥3 memories. Short conversations (1-2 turns) would never be compressed. Fix: removed the minimum group size — even single memories are worth compressing if they've decayed enough.

6. **30-minute grouping too aggressive → 1 hour:** A 30-minute gap split conversations that had natural pauses (user goes to bathroom, gets coffee). Widened to 1 hour.

7. **Memory context formatting:** Episodes now appear first in context (labeled `[Past conversation]`), before individual memories. This gives the AI a clearer hierarchy: high-level episode summaries first, then specific details.
