# Manual Verification Checklist

**Companion to:** `scripts/browser-flows.mjs` (automated) and `scripts/browser-smoke.mjs` (anonymous-load smoke).

This document lists every behavior that **cannot** be reliably automated against the running container, with explicit pass criteria for each. Run through it after every release that touches the relevant surface — the automated harness covers the rest.

The two automated harnesses cover:

- `browser-smoke.mjs`: every shipped page loads without CSP violations, page errors, or asset 4xx/5xx (anonymous probe — token-gated XHRs returning 401 are filtered).
- `browser-flows.mjs`: API contract round-trips, authenticated `/docs/assumptions` + `/explain` UIs, voice WebSocket auth + ping/pong + clean close, and doc-aware tools end-to-end.

Anything below is **out of scope** for those harnesses — either because it's time-based (timers measured in hours), depends on a real Telegram client, requires real audio, requires a different browser engine than chromium, or has UI mechanics (drag-drop, role-gated rendering) that puppeteer handles unreliably.

---

## A. Time-based behaviors

### A1. Voice WebSocket — 30-minute idle timeout (rc.106)

**Why manual:** the harness can't sit idle for 30 minutes without burning the cache and blocking CI.

**Steps:**
1. `docker exec luna-bot node /app/scripts/mint-test-token.mjs` (or use any valid web token).
2. Open `wss://<host>:3030/` from a browser DevTools console:
   ```js
   const ws = new WebSocket('wss://your-host:3030/');
   ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: 'TOKEN', mode: 'voice' }));
   ws.onmessage = (e) => console.log(JSON.parse(e.data));
   ```
3. After receiving `{ type: 'ready' }`, do nothing for **30 minutes**.

**Pass criteria:**
- After ~30 min, server emits `{ type: 'session_closing', reason: 'idle', message: 'Session closed after 30 minutes of inactivity. Reconnect to continue.' }` followed by WS close 1000.
- `docker logs luna-bot | grep "Voice web: closing session on lifetime cap"` shows the corresponding entry with `reason: "idle"`.

### A2. Voice WebSocket — 4-hour absolute max (rc.106)

**Why manual:** 4-hour timer.

**Steps:**
- Same setup as A1, but send a `{ type: 'ping' }` every 25 minutes for at least 4 hours. The idle timer resets each time; the absolute max does not.

**Pass criteria:**
- After ~4 hours, server emits `{ type: 'session_closing', reason: 'max-duration', ... }` and closes with WS code 1000 even though the session was active.

### A3. Trust decision 30-day TTL (rc.102)

**Why manual:** 30-day timer.

**Steps:**
1. Use a Telegram tool that requires confirmation (any `riskLevel: 'critical'` tool) and answer "always" / "siempre".
2. Wait 30 days.
3. Re-invoke the same tool.

**Pass criteria:**
- After expiry, Luna asks for confirmation again instead of executing silently.
- `tool_trust` row's `expires_at` was populated and is < `Date.now()` at re-invocation.

---

## B. Real audio / Telegram client surfaces

### B1. Voice STT/TTS round-trip

**Why manual:** synthetic audio inputs don't exercise Speaches' Whisper + Kokoro pipeline the way a real voice note does.

**Steps:**
1. Send a Telegram voice note in English: "What is the current capacity of plant A?"
2. Send another in Spanish: "¿Cuál es la capacidad actual de la planta A?"

**Pass criteria:**
- Bot transcribes correctly (within reason — exact wording can vary).
- Bot replies in the same language as the voice note (rc.95 language detection).
- Reply includes both text and a TTS voice note when `forceVoiceReply` mode is on.
- `docker logs luna-bot | grep -i "transcrib\|whisper\|kokoro"` shows the round-trip with no errors.

### B2. Telegram `--site-adjusted` flag — slash command

**Why manual:** real Telegram client → real bot path. The unit tests cover the parser; this verifies end-to-end.

**Steps:**
1. From a Telegram chat: `/sigma 10.5 9.5 widget --site-adjusted`
2. Compare to the same command without the flag.

**Pass criteria:**
- With the flag, the reply includes a section listing applied assumptions (or notes that none were resolved) along with the `mode: site_adjusted` envelope.
- Without the flag, the reply is the standard textbook computation with no assumption metadata.

### B3. Telegram `--site-adjusted` flag — CSV caption

**Why manual:** caption-driven CSV uploads exercise a different parse path than slash commands.

**Steps:**
1. Upload a roster CSV with caption `Capacity Data plant-A --site-adjusted`.
2. Repeat without the flag.

**Pass criteria:** same as B2.

### B4. Telegram 429 retry (rc.107)

**Why manual:** triggering a real 429 from Telegram requires actually exceeding the global rate limit (~30 msg/sec). Synthetic 429 testing requires a Telegram-API mock.

**Steps:**
1. Configure a chat to trigger a fanout that sends ≥30 messages in 1 second (e.g., proactive digest with many topics, or a tool that emits many notifications).
2. Watch container logs.

**Pass criteria:**
- `docker logs luna-bot | grep "Telegram 429"` shows `INFO: Telegram 429 — backing off before retry` with `retryAfterSec` populated.
- All messages eventually arrive (no permanent loss).
- Retry count caps at 3 attempts per message.

### B5. Webhook secret rejection at startup (rc.102)

**Why manual:** rebooting the bot with a deliberately broken secret shouldn't happen in production CI; it should be verified once at setup.

**Steps:**
1. Edit `.env` to set `TELEGRAM_WEBHOOK_URL=https://luna.example.com/telegram/webhook` and `TELEGRAM_WEBHOOK_SECRET=` (empty) **OR** `TELEGRAM_WEBHOOK_SECRET="   "` (whitespace).
2. `docker compose up -d --force-recreate luna`.

**Pass criteria:**
- Container exits non-zero (or restart-loops).
- Logs contain `TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is set. An empty secret disables Telegram payload verification…`.
- Restore `.env`, restart, container starts cleanly.

---

## C. Browser engines and form factors

### C1. Cross-browser smoke

**Why manual:** chromium is the only browser packaged in the container. Safari (WebKit) and Firefox (Gecko) have different JS engines and CSS support.

**Steps:**
1. Open each page in Safari, Firefox, and Edge:
   - `/`
   - `/board.html`
   - `/learn.html`
   - `/docs`
   - `/docs/assumptions?token=…`
   - `/explain?token=…`
   - `/sim`, `/capacity`, `/sequence`, `/vsm`, `/toc`, `/conwip`, `/doe`, `/fsm`
   - `/attendance/admin?token=…`
   - `/hub`, `/hub/bom`
2. Open browser DevTools console on each.

**Pass criteria:**
- No JS errors or red console messages on any page in any browser.
- Vue/Vuetify pages render with the same visual layout as Chrome.
- Voice chat WebSocket connects from each browser.

### C2. Mobile responsive

**Why manual:** viewport simulation in puppeteer doesn't catch real iOS/Android behavior (touch events, safe-area insets, font scaling).

**Steps:**
1. Open `/`, `/board.html`, `/sim`, `/capacity`, `/docs/assumptions`, `/explain` on a real iPhone (Safari) and Android (Chrome).

**Pass criteria:**
- All controls are tappable without zooming.
- No horizontal scrollbar on any page.
- Voice chat record button works on both platforms.
- Vuetify dialogs / drawers function with touch.

---

## D. UI mechanics that puppeteer handles unreliably

### D1. `/board` drag-drop

**Why manual:** drag-drop in puppeteer is fragile — it has worked but breaks on small library changes, and the failure mode is "test passes but UI is broken in real browsers."

**Steps:**
1. Open `/board.html?token=…`.
2. Create a card via the "Add card" UI in the Backlog column.
3. Drag the card from Backlog → In Progress.
4. Drag from In Progress → Done.
5. Refresh the page.

**Pass criteria:**
- Card appears in the new column after each drop.
- After refresh, card position is persisted.
- WebSocket logs (`docker logs luna-bot | grep "Board web"`) show `board_move` events with the correct from/to.

### D2. `/learn` plan creation & spaced repetition

**Why manual:** the learning coach has Socratic prompt flows that require human evaluation.

**Steps:**
1. Open `/learn.html?token=…`.
2. Create a learning plan: "Statistical process control fundamentals".
3. Engage in a learning session.
4. Complete a session, return tomorrow, expect a review prompt.

**Pass criteria:**
- Plan persists in the DB (verify via `sqlite3 store/luna.db "SELECT * FROM learning_plans"`).
- Sessions log via `learning_sessions`.
- Spaced-repetition surfaces overdue items the next day (this requires a 24h gap, hence manual).

### D3. `/attendance/admin` role-gated views

**Why manual:** the page renders different controls for admin / hr / supervisor / manager roles. Setting up four parallel role-scoped sessions is heavyweight; a one-time human verification is enough.

**Steps:**
1. Mint four web tokens with different `chat_id`s: `test-admin`, `test-hr`, `test-supervisor-mod1`, `test-manager-mod1`.
2. Insert role assignments into `attendance_role_assignments` for each.
3. Open `/attendance/admin?token=…` for each.

**Pass criteria:**
- Admin sees: site management, shift management, module management, supervisor invitations, role-assignments table, all CSV uploads.
- HR sees: read-only employee data, future-absence approvals, NO role assignments / invitations.
- Supervisor sees: only their assigned module's roster + check-ins, can file future absences for their module only.
- Manager sees: their assigned module's reports, no editing.

### D4. Long-running calc UX

**Why manual:** verifying that a 5-minute Monte Carlo doesn't freeze the browser tab requires real wall-clock time and human eye.

**Steps:**
1. Open `/sim`.
2. Set up a scenario with `N = 10000` Monte Carlo iterations.
3. Click run.

**Pass criteria:**
- Page shows a spinner / progress indicator during the run.
- The browser tab remains responsive (other tabs in the same browser don't freeze).
- Results render when the run completes (≤2 min on default container resources).
- `docker logs luna-bot | grep "Slow database query"` does NOT show any queries from this run (calc shouldn't be query-bound).

---

## E. Operational / pre-flight

### E1. Pre-commit hook secret detection (rc.102)

**Why manual:** trying to commit a fake secret is destructive to the working tree if it doesn't get blocked.

**Steps (use a scratch branch):**
1. `git checkout -b test-precommit-XYZ`
2. Add a fake key to a tracked file: `echo 'API_KEY=sk-ant-1234567890abcdef1234567890abcdef' > /tmp/fake-secret.ts`
3. `cp /tmp/fake-secret.ts src/scratch-test.ts && git add src/scratch-test.ts`
4. `git commit -m "test"` — expect rejection.
5. Repeat for each pattern: `rnd_…` (Render), `syt_…` (Synapse), `ghp_…` (GitHub), `xoxb-…` (Slack), `AKIA…` (AWS), and a private-key block.

**Pass criteria:**
- Each commit attempt fails with the corresponding pattern shown in red.
- `git log` shows none of the test commits made it in.
- After cleanup (`rm src/scratch-test.ts && git checkout main && git branch -D test-precommit-XYZ`), the working tree is clean.

### E2. Graceful shutdown — SIGTERM checkpoint (rc.106)

**Why manual:** verifying the WAL-checkpoint-on-shutdown path requires watching the container stop and inspecting the WAL state.

**Steps:**
1. While the bot is running, write some memory: send a Telegram message, wait for it to be saved.
2. `docker compose stop luna`
3. Inspect `store/luna.db-wal` size before and after stop.

**Pass criteria:**
- `docker logs luna-bot | grep "SQLite WAL checkpointed and truncated on shutdown"` appears in the final lines before stop.
- `store/luna.db-wal` is zero or near-zero bytes after the stop.
- `docker compose start luna` brings the bot back up with the latest message intact.

### E3. Container memory cap enforcement (rc.106)

**Why manual:** triggering OOM intentionally requires a runaway process.

**Steps:**
1. Either run a 100k-iteration Monte Carlo (`/sim` with N=100000) or invoke a forge tool with a known memory-pig payload.
2. Watch `docker stats luna-bot`.

**Pass criteria:**
- Memory tops out at ~4G (the rc.106 `mem_limit`).
- The runaway operation fails with a clear error (forge sandbox surfaces `Tool ran out of memory (64MB limit)…`; sim should surface a 500).
- The container itself does not crash — the limit hits the offending operation, not the bot.

### E4. Token revocation immediate disconnect

**Why manual:** verifying that revoking an active token immediately closes the WebSocket session.

**Steps:**
1. Open the voice chat with a valid token (browser DevTools `WebSocket` flow).
2. From Telegram, run `/webtoken revoke <prefix>`.

**Pass criteria:**
- WebSocket closes within 60 seconds (the re-validation interval) with code 4001 or similar.
- Browser shows the disconnect.
- New WS connection with the revoked token is rejected at the auth handshake.

---

## F. What is **NOT** in this checklist (and why)

These behaviors are NOT included because they're already covered elsewhere or because they're implementation details verified by tests:

| Item | Where it's verified |
|---|---|
| Calc wrappers (balance/sigma/inventory/capacity/etc.) | Unit tests `tests/calculations-*.test.ts` (60+ tests) |
| Assumption resolver precedence (user/pack/global/default) | Unit tests `tests/assumptions.test.ts` (19 tests) |
| Doc manifest filter rules | Unit tests `tests/doc-awareness.test.ts` (24 tests) |
| CSP allowlist drift | Unit tests `tests/csp-allowlist.test.ts` (14 tests) |
| Path-traversal rejection in read_documentation | Unit + dist-smoke |
| Telegram message HTML escaping | Unit tests + production usage |
| Knex slow-query log | Operational — appears in container logs under load |
| Scheduler duration log | Operational — appears in container logs |
| Background queue depth caps | Unit tests `tests/background-tasks.test.ts` |
| Telegram orchestrator caption parsing | Unit tests |

---

## Recommended cadence

- **Every release that touches a manual-checklist surface:** run the relevant section.
- **Quarterly:** run sections C (cross-browser, mobile) and E (operational) end-to-end.
- **Yearly:** run section A (time-based) — combine with annual disaster-recovery exercise.
- **After any user-reported issue with a UI:** D1, D2, D3 as relevant.

The automated harnesses (`browser-smoke.mjs`, `browser-flows.mjs`) should be run on every release as part of `npm run smoke` — they catch regressions in the surfaces they cover within seconds.
