# Luna — Engineer Onboarding

**For:** a backend engineer with Node/TypeScript experience but no prior Luna context.
**Outcome after reading:** you can clone, configure, start a local instance, ship a change end-to-end, and find your way around the codebase without asking the original maintainer.
**Status:** rc.95, 2,367 tests across 107 files, 181 .ts files in `src/`.

This document is the answer to "if I get hit by a bus, who runs Luna?" Read it once end-to-end, then keep it as a navigation aid.

---

## 0. The 90-second elevator description

Luna is a personal/team AI-assistant daemon written in TypeScript that bridges messaging platforms (Telegram, Matrix, a built-in web UI) to AI backends (local Ollama via the host, Anthropic Claude via the `claude` CLI subprocess against an OAuth subscription). It runs in Docker. It has its own SQLite persistence (Knex, dialect-portable to MariaDB / Postgres), a memory subsystem, scheduled tasks, voice in/out via a Speaches sidecar, an attendance reconciliation pilot, a small set of manufacturing-engineering tools, and a *domain pack* system that lets each department customize its own behavior without forking the codebase. The Claude path is a flat-rate subscription — no per-call cost. Routing defaults to Ollama; Claude is the escalation path for long-form / document-generation turns.

If that paragraph made sense to you, the rest of this doc is just orientation.

---

## 1. Prerequisites

### Software (host machine)

- **Docker Desktop** ≥ 4.30 with at least 12 GB RAM and 6 CPUs allocated. The Speaches sidecar alone reserves ~3 GB.
- **Node.js** ≥ 20 (only needed if you plan to run unit tests / `npx tsc` outside the container; the bot itself runs inside Docker).
- **Ollama** installed on the host (not inside Docker). Apple Silicon Mac or x86 Linux is fine. Ollama runs on port `11434`; Luna reaches it via `host.docker.internal`.
- **`claude` CLI**, only if you'll use the Claude path: `npm install -g @anthropic-ai/claude-code`.
- **`gh` CLI**, for the GitHub-integration tools to work end-to-end (optional for dev).

### Accounts and tokens

- **Telegram bot token** via [BotFather](https://t.me/BotFather). One-time, free.
- **Anthropic Claude subscription** (Max plan) for the Claude path. Generate the OAuth token with `claude setup-token` — valid ~1 year.
- **GitHub PAT** (`gh auth token` will produce one) — only needed if you'll exercise GitHub tools.
- **Brave Search API key** — only needed if you want the Ollama path to do web search and you don't have SearXNG configured. Free tier exists.

### Repository access

- Clone access to `superprompt` (this repo).
- Clone access to `novalink-bridge` (a separate repo that hosts the NovaLink-only data-access bridge — currently a Replit prototype, target is a same-VM sidecar). Only relevant for NovaLink deployments.

---

## 2. First-hour code tour

Read these files in this order. Together they take ~60–90 minutes and answer "how does Luna work?" without you needing to read the rest of `src/`.

| Order | File | Why |
|---|---|---|
| 1 | `CLAUDE.md` (repo root) | Instructions for AI agents working on this codebase. Reading it as a human tells you the constraints, the verification workflow, and the known gotchas the maintainer keeps tripping over. |
| 2 | `PROJECT_PLAN.md` (repo root) | Sprint history with checkboxes. Tells you what's done and what's in flight (currently the attendance pilot). |
| 3 | `ROADMAP.md` (repo root) | rc-by-rc changelog from rc.62 → rc.95 + forward roadmap. Read the rc.66-76 reliability sprint section especially — it captures most of the load-bearing operational learning. |
| 4 | `reference/decisions.md` | The "why" of the architecture. If you're tempted to rewrite something, read this first. |
| 5 | `src/index.ts` | The startup orchestrator. ~250 lines. Shows you what subsystems exist and the order they boot in. |
| 6 | `src/core/interfaces.ts` | TypeScript interfaces for every subsystem (`AIProvider`, `Platform`, `ToolProvider`, `MemoryProvider`, `PackProvider`, `StorageProvider`). The contract surface. |
| 7 | `src/providers/router.ts` | The central message router (~1,460 lines). Most-edited file in the repo. Auto-routing classifier (`classifyMessage`, line 668), provider switching, deliverable-intent detection, continuity bridge between providers, rc.95 usage observability. If you understand this file you understand 60% of Luna. |
| 8 | `src/db-core.ts` + `src/db-knex.ts` + `src/db-dialect.ts` | All database CRUD via Knex. Cross-dialect (SQLite / MariaDB / Postgres). |
| 9 | `src/platforms/telegram.ts` | The main user-facing platform. Every slash command is a `bot.command(...)` call here. `/help` is the index. |
| 10 | `docs/architecture.md` | This repo's full architecture reference. By the time you read it, you'll have context for every section. |

Don't read `src/web/`, `src/forge/`, `src/learning/`, or any of the manufacturing modules (`src/capacity/`, `src/sequencer/`, etc.) on day one — they're peripheral to the core message-handling path.

---

## 3. First-time setup from zero

```bash
# 1. Clone
git clone <repo-url> superprompt && cd superprompt

# 2. Copy env template — DO NOT commit the resulting .env
cp .env.example .env

# 3. Edit .env — fill in TELEGRAM_BOT_TOKEN at minimum.
#    Leave CLAUDE_CODE_OAUTH_TOKEN empty if you only want the Ollama path.
#    AI_PROVIDER=ollama and AUTO_ROUTE=true are the rc.95 defaults.
${EDITOR:-nano} .env

# 4. Pull Ollama models on the host (not in Docker)
ollama pull qwen3.5:latest
ollama pull nomic-embed-text

# 5. Build and start
docker compose build luna
docker compose up -d

# 6. Verify
docker compose ps                                    # all 3 services healthy
docker compose logs luna --tail=30 | grep "running"  # "Luna is running"
```

In a Telegram chat with your bot, send `/start`. If it replies, you're done. If not, the runbook (`docs/deployment-runbook.md`) covers the common causes.

---

## 4. Day-1 / Week-1 / Month-1 plan

### Day 1 (≈4 hours)

- Complete the first-hour code tour (§2).
- Stand up the local instance (§3).
- Send 5–10 messages: a question, a command (`/help`, `/usage`, `/provider`), a follow-up that exercises memory, a request for a deliverable (`make me a CSV with these rows…`).
- Read `npx vitest run --reporter=dot 2>&1 | tail -5` to confirm 2,367+ tests pass in your env.

### Week 1

- Ship the worked-example skill from §6. Open the PR. Make all 2,367 tests + `npx tsc --noEmit` + `npm run smoke` pass before requesting review.
- Read `docs/security.md` end-to-end. Important — the threat model matters.
- Read `docs/customization-guide.md`. It's longer than this onboarding doc; you don't need it on day 1, but you will reference it in the first month.
- Get your name added to `CODEOWNERS` (file doesn't exist yet — create it as part of your first PR if you want).

### Month 1

- Ship a tool (worked example §7) and a domain pack (worked example §8).
- Read all `feedback_*.md` memory files (under `~/.claude/projects/.../memory/`) — these capture the maintainer's accumulated preferences. Treat them as binding for your work.
- Be the on-call for one real incident. Use the runbook. Update the runbook when you find a gap.
- Pair with the previous maintainer (or read their session transcripts) on one rc bump end-to-end. Watch the diagnose → scope → ship → verify loop in `feedback_iterative_rc_workflow.md`.

---

## 5. Where the load-bearing decisions live

Before changing something that looks weird, check whether it's deliberate.

| If you're tempted to… | Read first |
|---|---|
| …rewrite the `claude` provider as the SDK | `reference/decisions.md` (line 22 area). The CLI subprocess is intentional — the SDK requires per-call API costs, the CLI uses the subscription. |
| …change `fileURLToPath(import.meta.url)` to `new URL(...).pathname` | `CLAUDE.md` Code Convention #1. The .pathname form breaks on paths with spaces. Several hours of debugging shaped this. |
| …add a keyword router on top of `classifyMessage()` | rc.95 commit message and the rc.66-76 reliability-sprint memory. Auto-routing already exists with stickiness, deliverable-intent, and provider-aware tool gating. Keyword lists drift. |
| …amend `--no-verify` on a pre-commit failure | `CLAUDE.md` "Verify with the existing workflow" — investigate the underlying secret-leak flag, don't bypass. |
| …turn off the memory decay sweep "because old memories aren't worth deleting" | `reference/decisions.md` and `feedback_memory_preservation.md` — decay + episode compression is the storage-budget mechanism. Removing it makes the DB grow unboundedly. |
| …skip the live container rebuild after a code change | `feedback_iterative_rc_workflow.md`. The container runs from `dist/`, not bind-mounted source. Code changes that aren't rebuilt do not take effect, and you will spend hours diagnosing a "fix that didn't fix anything." |
| …read the user's `.env` to check a setting | Use `sed -i '' 's/^FOO=.*/FOO=new/' .env` instead. Reading puts secrets in tool-output context; `sed` doesn't. |

---

## 6. Worked example — add a built-in skill

Skills are pre-defined system-prompt overlays + tool allowlists. They activate per-chat via `/skill use <name>` or auto-trigger when the user's message matches a pattern.

We'll add a skill called `concise` that constrains the model to ≤3 sentences.

**File: `src/skills.ts`** — find the `BUILTIN_SKILLS` array. Add a new entry:

```typescript
{
  name: 'concise',
  description: 'Short, terse replies — at most 3 sentences. No preambles.',
  systemPrompt:
    'Reply in at most 3 sentences. No preamble ("Sure!", "Of course!"), no '
    + 'closing offer ("Let me know if you need anything else"). Answer the '
    + 'question, stop. If the user asks a yes/no question, lead with yes or no.',
  allowedTools: undefined,  // inherit defaults
  autoTrigger: {
    patterns: [/\b(briefly|tldr|in one (sentence|line)|short answer)\b/i],
    mode: 'suggest',  // never silently activate
  },
}
```

**Test:** add to `tests/skills.test.ts`:

```typescript
it('concise skill is registered with auto-trigger and short-reply prompt', async () => {
  const { BUILTIN_SKILLS } = await import('../src/skills.js');
  const concise = BUILTIN_SKILLS.find((s) => s.name === 'concise');
  expect(concise).toBeDefined();
  expect(concise!.systemPrompt).toMatch(/at most 3 sentences/);
  expect(concise!.autoTrigger?.patterns?.[0].test('briefly explain X')).toBe(true);
});
```

**Verify:**

```bash
npx vitest run tests/skills.test.ts
npx tsc --noEmit
docker compose build luna && docker compose up -d luna
```

Then in a Telegram chat: `/skill use concise`, ask a question, confirm replies are ≤3 sentences. Then `/skill off` to revert.

**What you've practiced:** the registration → test → typecheck → rebuild → live-verify loop. This is the standard rc workflow described in `feedback_iterative_rc_workflow.md`.

---

## 7. Worked example — add an Ollama tool

Tools are functions the Ollama agentic loop can call (Claude has its own built-in tools and we don't ship to it directly — see §10 gotcha #5). We'll add `get_week_number` that returns the ISO week.

**New file: `src/providers/tools/get-week-number.ts`**

```typescript
import type { ToolDefinition } from './types.js';

export const getWeekNumberTool: ToolDefinition = {
  name: 'get_week_number',
  description: 'Returns the ISO 8601 week number for a given date (default: today).',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'ISO date (YYYY-MM-DD). Defaults to today if omitted.',
      },
    },
  },
  riskLevel: 'low',
  async execute(args: { date?: string }) {
    const d = args.date ? new Date(args.date) : new Date();
    if (isNaN(d.getTime())) return { error: 'invalid date' };
    // ISO 8601: week starts Monday, week 1 contains Jan 4
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return { iso_week: week, year: target.getUTCFullYear() };
  },
};
```

**Register: `src/providers/tools/index.ts`** — add the import and push into the tool registry.

**Test: `tests/get-week-number.test.ts`** — assert output for 3 known dates (Jan 4, Dec 28 of a year that has 53 weeks, today).

**Policy classification:** `riskLevel: 'low'` means no confirmation prompt, no audit log entry beyond the standard. If your tool reads files, hits the network, or mutates state, see `src/policy-engine.ts` for the higher-risk patterns.

**Verify:** typecheck, tests, container rebuild. In Telegram, ask "what week of the year is it?" — Ollama should call `get_week_number` and reply with the answer.

---

## 8. Worked example — create a domain pack

Domain packs let each deployment add its own tools, system-prompt context, and intent scoring without forking. They live under `packs/`.

**Scaffold:** `/pack create example-pack "Example pack for the onboarding doc"` in Telegram. Or copy `packs/_template/` to `packs/example-pack/`.

**Pack structure:**

```
packs/example-pack/
├── manifest.json          # name, version, description, intent keywords
├── index.ts               # entry point — exports tableInit, capability prompt
├── prompts/               # system-prompt fragments
│   └── capability.md
├── tools/                 # pack-specific Ollama tools
│   └── example-tool.ts
└── tests/                 # pack-scoped tests
    └── example-pack.test.ts
```

**`packs/example-pack/manifest.json`**:

```json
{
  "name": "example-pack",
  "version": "0.1.0",
  "description": "Example pack",
  "intent_keywords": ["example", "demo"],
  "level": 2
}
```

`level` is the build complexity tier (1 = pure prompt, 2 = prompt + tools, 3 = prompt + tools + custom DB tables + web UI). Manufacturing is the only level-3 pack today.

**Activate:** `/pack subscribe example-pack` in a Telegram chat. The pack's `capability.md` is now appended to the system prompt for that chat, and its tools are available to Ollama.

For the full pack development guide see `docs/customization-guide.md` and `docs/pack-development-guide.md`.

---

## 9. Running the test suite

```bash
# Full run (~25 seconds)
npx vitest run

# Watch a single file while iterating
npx vitest tests/your-feature.test.ts

# Typecheck only (no test run)
npx tsc --noEmit

# Dist-level smoke (catches ESM-runtime issues that vitest/tsx hide)
npm run smoke
```

The full run must show `2,367 passed (2,367)` — or whatever the post-rc count is. **A green typecheck and a green vitest run together are necessary but not sufficient** — `npm run smoke` exists because vitest uses `tsx` which papers over `require()`-in-ESM bugs that crash production. Always run all three before declaring a change done.

For UI / web-app changes, also exercise the feature in a browser. The runbook explains how to surface CSP errors and Vite issues.

---

## 10. Deploying an update without downtime

Luna runs as a single Docker service. There is no rolling deployment today (the project is pre-clustering). The procedure is:

```bash
git pull origin main
docker compose build luna           # ~30s if dependencies are cached, ~3min if not
docker compose up -d luna            # recreates the container in place
docker compose logs luna --tail=30   # confirm "Luna is running" + correct rc.X
```

Downtime: ~6–10 seconds (the time between container stop and the new one passing its healthcheck). Telegram messages sent during that window are buffered by Telegram and delivered when polling resumes.

If your change touches the docker image but you can't afford a restart of the *speaches* or *searxng* sidecars (you almost never need to), `docker compose up -d luna` only recreates `luna`. Sidecars stay up.

For production-like deployments where ~10s downtime matters, see `docs/inmotion-deployment-guide.md` for the dual-instance blue/green approach.

---

## 11. Common gotchas

These are bugs that have been hit at least twice. Each one cost ≥1 hour the first time.

| Gotcha | Symptom | File / Reference |
|---|---|---|
| **Forgot to rebuild the container** | Code change didn't take effect | `feedback_iterative_rc_workflow.md`. Container runs `dist/`, not source. `docker compose build luna && docker compose up -d luna` after every change. |
| **`new URL(import.meta.url).pathname` breaks on paths with spaces** | Path lookups fail when the project is under `~/Documents/Programming/My Project/` | `CLAUDE.md` Code Convention #1. Always `fileURLToPath(import.meta.url)`. |
| **`process.env` set from `.env`** | Production accidentally inherits dev secrets | `CLAUDE.md` Code Convention #2. Use `readEnvFile()`, never assign to `process.env`. |
| **Telegram voice notes have `.oga` extension, Whisper wants `.ogg`** | STT fails silently with a 400 | Same codec, different extension. `src/voice.ts` renames before posting. |
| **Claude CLI cannot call Ollama-style tools** | Tool calls "vanish" when the user is on the Claude provider | Claude has its own built-in tools; our `kanban_manage`, `query_memory`, etc. are Ollama-only. The router intercepts `DocGenRequest` and `kanban_action` JSON blocks from Claude responses. |
| **FTS5 virtual table desync** | Memory search returns nothing for recent entries | `src/db-dialect.ts`. INSERT/UPDATE/DELETE need the manual triggers. |
| **`sqlite-vec` doesn't support triggers** | Vector search drifts from FTS5 | `src/embeddings.ts` syncs programmatically in CRUD. Don't try to use triggers. |
| **`buildMemoryContext` is async** | `TypeError: ... is not a function` after edits | rc.7 changed it from sync to async. All callers must `await`. |
| **rc bump without `package.json` + `package-lock.json` update** | Smoke check shows stale version on disk | Both files have `"version"` fields. Bump together. |
| **Pre-commit hook flagging a "false positive"** | Commit blocked, tempted to use `--no-verify` | Don't. `CLAUDE.md` is explicit. The hook is stricter than perfect, but a real leak getting through is much worse than a 5-minute audit of why a string matched. |
| **AUTO_ROUTE=false explicitly set in `.env`** | New default-true behavior doesn't take effect | `feedback_iterative_rc_workflow.md` and the rc.95 deployment note. Env values override config defaults. Edit `.env` to engage the new posture. |
| **Ollama running inside Docker** | Cold-start every request, model thrash | Ollama runs on the host, reached via `host.docker.internal:11434`. The Dockerfile does not include Ollama. |
| **AS_DB / IM_DB credentials in test runs** | Bridge integration tests fail in CI | The bridge has its own repo and test isolation. Luna's tests do not exercise the bridge — they use `nock`-style mocks of the Luna-side adapter. See `docs/NOVALINK_BRIDGE_INTEGRATION.md`. |

---

## 12. Where to ask for help (in priority order)

1. **`reference/decisions.md`** — if you're about to change something that looks intentional.
2. **`docs/architecture.md`** — system-level "how does X work."
3. **`docs/security.md`** — threat-model questions.
4. **`docs/deployment-runbook.md`** — when the bot is misbehaving.
5. **`memory/feedback_*.md`** files — accumulated preferences from prior sessions; treat as binding.
6. **The maintainer's open PRs / recent commits** — `git log --since="2 weeks ago"` shows the active-rc cadence and the kind of changes that just shipped. Match that style.

If after all of those you're still stuck, **the right move is to write up what you've tried and what you're seeing, then ask** — not to invent a workaround. Inventions become tribal knowledge that the next engineer can't find.

---

## 13. The single-maintainer-risk safety check

You can use this checklist as the formal "I can run Luna alone now" signoff:

- [ ] Luna instance running locally, healthy, responsive on Telegram.
- [ ] `npx vitest run` green, `npx tsc --noEmit` silent, `npm run smoke` green.
- [ ] One PR shipped that touches `src/` and ships through the full rc workflow (typecheck + tests + smoke + docker rebuild + live verify).
- [ ] Read `reference/decisions.md` end-to-end and asked questions about anything unclear.
- [ ] Read `docs/security.md` and can name 3 threat vectors and their mitigations.
- [ ] Walked through the deployment runbook with a deliberately-broken instance (e.g., revoke the Telegram bot token, follow the recovery procedure).
- [ ] Know where the `.env` lives, how to rotate each secret in it, and how to recreate the container without secrets touching the conversation transcript or git.
- [ ] Read `feedback_iterative_rc_workflow.md` and `feedback_quality_standard.md`. Can articulate the diagnose → scope → ship → verify cadence.
- [ ] Understand the NovaLink bridge is a separate product (PLANNED integration, see `docs/NOVALINK_BRIDGE_INTEGRATION.md`), not part of Luna's core.

If all eight are checked, Luna is no longer a single-maintainer-risk for you.
