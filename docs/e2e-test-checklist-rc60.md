# Luna — E2E Test Checklist

**Version:** v1.0.0-rc.60 | April 2026
**Coverage:** All features including WS1 (Security), WS2 (Multi-Agent), WS4 (Database Abstraction)
**Automated tests:** 2003 (84 files, 86 integration tests)

---

## How to Use This Checklist

Each section has manual verification steps. Checkboxes track completion.
Run automated tests first: `npx vitest run` (should show 2003 passing).
Then walk through manual checks in order.

---

## 1. Platform Startup

- [ ] `docker compose up -d` — all 3 services start (luna-bot, luna-searxng, luna-speaches)
- [ ] `docker compose ps` — all services show "healthy"
- [ ] Telegram bot responds to `/start`
- [ ] Startup logs show: "Knex database initialized", "Event trigger system initialized", "Background task queue initialized"
- [ ] No FATAL or ERROR entries in logs

## 2. AI Providers

### Claude
- [ ] `/claude` → switches to Claude provider
- [ ] Send a message → receives response
- [ ] Response language matches message language (EN→EN, ES→ES)
- [ ] `/provider` → shows "claude" in manual mode

### Ollama
- [ ] `/ollama` → switches to Ollama provider
- [ ] Send a message → receives response (may be slower)
- [ ] Tool calls work (e.g., "what time is it" → calls get_time)
- [ ] `/models` → lists available models
- [ ] `/model <name>` → switches model

### Auto-routing
- [ ] `/auto` → enables auto-routing
- [ ] Short message → routes to Ollama
- [ ] "Write me a detailed report about..." → routes to Claude
- [ ] "Run a simulation" → routes to Ollama (tool-intent pattern)
- [ ] `/provider` → shows "auto" mode

## 3. Web Tokens & Web UI

- [ ] `/webtoken create laptop` → shows 64-char token
- [ ] `/webtoken list` → shows token with label and status
- [ ] Open `https://domain/board` → login screen shows "Generate in Telegram: /webtoken create"
- [ ] Paste token → board loads, shows user's cards
- [ ] Open `https://domain/learn` → login works with same token
- [ ] Open `https://domain/` → voice chat login works
- [ ] `/webtoken create phone 30d` → shows token with expiry
- [ ] `/webtoken revoke <prefix>` → token revoked, web session disconnected
- [ ] Revoked token → login rejected
- [ ] Different user's token → shows different user's board data

## 4. Kanban Board

- [ ] `/board add "Test card"` → card created
- [ ] `/board` → shows card in backlog
- [ ] `/board move <id> in_progress` → card moves
- [ ] `/board assign <id> bot` → card assigned
- [ ] `/board priority <id> 1` → priority changed
- [ ] `/board delete <id>` → card deleted
- [ ] Web board (via token) shows same cards as Telegram `/board`
- [ ] Card created in Telegram appears in web board (refresh)
- [ ] Card created in web board appears in Telegram `/board`

## 5. Web Search (SearXNG)

- [ ] With Ollama: "search the web for lean manufacturing" → returns results
- [ ] Results show titles, URLs, snippets from multiple engines
- [ ] Spanish query: "busca en internet manufactura esbelta" → returns Spanish results
- [ ] With Claude: web search works (Claude's built-in)
- [ ] SearXNG health: `docker exec luna-bot wget -q -O- http://searxng:8080/healthz` returns OK

## 6. Manufacturing Tools (with Ollama)

For each tool, switch to `/ollama` first:

### Simulation (/sim)
- [ ] Web dashboard loads at `/sim`
- [ ] Upload CSV or enter data → run simulation → results display
- [ ] Save scenario → scenario appears in list
- [ ] Scenario scoped to user (other user doesn't see it)

### Capacity Planning (/capacity)
- [ ] Dashboard loads, input form works
- [ ] Run analysis → results with charts

### Sequencer (/sequence)
- [ ] Dashboard loads
- [ ] Enter jobs → run sequencing → Gantt chart displays

### VSM (/vsm)
- [ ] Dashboard loads
- [ ] Enter process steps → value stream map renders

### TOC (/toc)
- [ ] Dashboard loads
- [ ] Enter work centers → bottleneck identified

### CONWIP (/conwip)
- [ ] Dashboard loads
- [ ] Configure WIP limits → token board renders

### DOE (/doe)
- [ ] Dashboard loads
- [ ] Define factors → experiment design generated

### FSM (/fsm)
- [ ] Dashboard loads
- [ ] Define states → state machine visualized

## 7. Quality Tools (Telegram, Ollama)

- [ ] Six Sigma: "analyze these measurements: 10.1, 10.3, 9.8, 10.0, 10.2" → Cp/Cpk analysis
- [ ] Line Balance: "balance a line with takt time 60 seconds" → assignment results
- [ ] FMEA: create FMEA document → add failure modes → RPN calculated
- [ ] RCA: "do a root cause analysis for defect X" → 5 Whys or Fishbone
- [ ] SPC: create control plan → VOC/CTQ workflow
- [ ] Inventory: EOQ/safety stock calculation

## 8. Learning Coach

- [ ] `/learn start "Lean Manufacturing"` → plan created
- [ ] `/learn session` → Socratic micro-session starts
- [ ] Answer questions → mastery tracked
- [ ] `/learn review` → review session with spaced repetition
- [ ] Web learning dashboard (`/learn`) → shows plans and progress
- [ ] Learning data scoped to user (different users, different plans)

## 9. Memory & Knowledge

- [ ] "Remember that I prefer data in metric units" → saved to memory
- [ ] `/memory` → shows stored memories
- [ ] In new chat (`/newchat`), ask "what units do I prefer?" → retrieves memory
- [ ] Memory scoped to user (user A's memories invisible to user B)

## 10. Skills & Personas

- [ ] `/skill list` → shows builtin skills
- [ ] `/skill use debugger` → activates debugger persona
- [ ] Send message → response follows debugger methodology
- [ ] `/skill off` → deactivates
- [ ] Auto-trigger: send "this is not working, I get an error..." → debugger auto-activates

## 11. Document Generation

- [ ] "Create a spreadsheet with columns A, B, C and 5 rows of data" → XLSX file sent
- [ ] "Generate a PDF report about lean principles" → PDF file sent
- [ ] "Create a presentation about quality metrics" → PPTX file sent

## 12. Scheduled Tasks

- [ ] `/schedule add "daily status check" "0 9 * * *"` → task created
- [ ] `/schedule list` → shows active task
- [ ] `/schedule pause <id>` → task paused
- [ ] `/schedule resume <id>` → task resumed
- [ ] `/schedule delete <id>` → task removed

## 13. Voice

- [ ] Send voice message in Telegram → transcribed and responded
- [ ] `/voice` → enables voice replies on text messages
- [ ] Web voice chat (`/` URL) → push-to-talk works
- [ ] Voice works in English and Spanish

## 14. Event Triggers (WS2)

- [ ] Create trigger via code/API: "When critical card created, notify"
- [ ] Create a priority 1 card → trigger fires → notification received
- [ ] Cooldown works: rapid card creation doesn't fire trigger repeatedly
- [ ] Trigger can be disabled/enabled

## 15. Background Tasks (WS2)

- [ ] Submit long-running task → immediate acknowledgment
- [ ] Continue chatting during execution
- [ ] Receive notification when task completes
- [ ] Bilingual notification (EN/ES)

## 16. Parallel Orchestration (WS2)

- [ ] Send multi-step request: "First research X, then compare Y, then create a report"
- [ ] Bot shows "Breaking into N steps / Dividiendo en N pasos"
- [ ] Independent steps show "running in parallel"
- [ ] Final response combines all step results

## 17. Security (WS1)

### Rate Limiting
- [ ] Enter wrong token 3 times quickly → rate limited message
- [ ] After 15 failures in an hour → IP banned for 1 hour

### Audit Logging
- [ ] Trigger a tool call (e.g., web search) → check logs for AUDIT entry
- [ ] Log entry includes: tool name, chatId, action, durationMs

### HTTPS (Production)
- [ ] `docker compose --profile production up -d` → Caddy starts
- [ ] HTTPS certificate obtained (check Caddy logs)
- [ ] HTTP redirects to HTTPS

### Webhook (Production)
- [ ] Set TELEGRAM_WEBHOOK_URL → restart → bot responds via webhook
- [ ] Verify with: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`

## 18. Database (WS4)

- [ ] Application starts with DB_DRIVER=sqlite (default)
- [ ] All tables created automatically
- [ ] CRUD operations work (verify via /board, /memory, /skill)
- [ ] Migration script: `npx tsx scripts/migrate-database.ts --dry-run` → shows all 53 tables

## 19. Multi-Deployment (WS3)

- [ ] `scripts/add-deployment.sh 2 "Team B"` → creates config
- [ ] Start deployment 2 → separate bot responds
- [ ] Shared DB mode: both bots see same data
- [ ] Isolated DB mode (DB_NAME override): data separated

## 20. Packs

- [ ] `/pack list` → shows available packs
- [ ] `/pack info manufacturing` → shows pack details
- [ ] Pack tools work when pack is enabled
- [ ] Different departments can enable different packs

---

## Automated Test Summary

| Category | Test File | Tests |
|----------|-----------|-------|
| Platform integration | platform-integration.test.ts | 59 |
| WS integration | ws-integration.test.ts | 27 |
| Web tokens | web-tokens.test.ts | 32 |
| Event triggers | event-triggers.test.ts | 15 |
| Background tasks | background-tasks.test.ts | 5 |
| Knex config | db-knex.test.ts | 12 |
| DB dialect | db-dialect.test.ts | 4 |
| DB core | db-core.test.ts | 36 |
| Orchestrator | orchestrator.test.ts | 32 |
| Auto-routing | auto-routing.test.ts | 16 |
| + 74 other test files | Various | 1765 |
| **Total** | **84 files** | **2003** |

---

## Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| CTO | | | |
| IT Lead | | | |
| QA Lead | | | |
| Department Champion | | | |

---

*luna v1.0.0-rc.60 — E2E Test Checklist*
