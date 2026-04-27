# Luna v1.0.0-rc.95 — Department Onboarding & Recovery Runbook

Get your own Luna instance running in 45-60 minutes. This guide is for team members receiving the repository who need to set up their own independent instance, and for on-call engineers diagnosing a misbehaving deployment.

**Refreshed:** 2026-04-27. Earlier revisions (rc.60) covered onboarding only; this revision adds the §"Recovery Procedures" section at the end for the seven most common failure modes.

**What you'll have when done:** Your own autonomous AI assistant on Telegram with:
- **Local-first by default (rc.95)** — `AI_PROVIDER=ollama` and `AUTO_ROUTE=true`. Claude is the escalation path for long-form / document-gen turns. Use `/usage` to see the per-provider call distribution.
- Voice processing (EN/ES auto-detect), 10+ department packs (manufacturing, finance, HR, engineering, etc.) plus the attendance-reconciliation pilot (rc.88+).
- 43+ tools with 4-layer security (policy engine → process isolation → Worker sandbox → SSRF protection)
- Auto-skill learning (Luna gets smarter from complex tasks)
- Web dashboards (`/sim`, `/capacity`, `/sequence`, `/vsm`, `/toc`, `/conwip`, `/doe`, `/fsm`, `/board`, `/learn`, `/attendance/admin`)
- Document generation (Excel, PDF, Word, CSV, PowerPoint)
- Circuit breaker, rate limiting, guardrails memory, context health monitoring, self-tuning pack weights
- Feature-awareness self-enforcing registry (rc.92) — every shipping feature is automatically taught to Luna, with CI enforcement

**Architecture:** 3-process model (core + tools + parsers) with per-user trust memory. The NovaLink bridge integration (PLANNED) adds two more containers when it lands; see [`NOVALINK_BRIDGE_INTEGRATION.md`](./NOVALINK_BRIDGE_INTEGRATION.md).

**Claude subscription:** Uses `claude` CLI with a fixed monthly Anthropic subscription — no per-token API costs. The deployed version runs on the same subscription as the demo. Local-first routing is to protect rate-limit headroom, not to save money (because there is no per-call money to save).

**After deployment:** Run the [E2E Test Guide](e2e-test-guide.md) to validate all 17 sections (65+ test cases).

---

## Hardware Requirements

**Check your machine BEFORE starting setup.** Luna runs AI models locally — this requires significant RAM and a modern processor. Running on under-spec hardware will cause the machine to hang or responses to take minutes instead of seconds.

### Minimum (functional but slow)

| Resource | Minimum | How to Check (macOS) |
|----------|---------|---------------------|
| **RAM** | **16 GB** | Apple menu → About This Mac |
| **CPU** | Apple M1 or Intel i7 (8th gen+) | Apple menu → About This Mac |
| **Free disk** | 20 GB | Finder → About This Mac → Storage |
| **macOS** | 12 Monterey+ | Apple menu → About This Mac |

### Recommended (responsive, comfortable)

| Resource | Recommended |
|----------|-------------|
| **RAM** | **32 GB** |
| **CPU** | Apple M1 Pro/Max/Ultra or M2+ |
| **Free disk** | 50 GB SSD |

### What Uses the RAM

| Process | RAM Usage | Notes |
|---------|-----------|-------|
| Ollama (qwen3.5 model loaded) | 6-8 GB | Largest consumer — loads the AI model into memory |
| Ollama (nomic-embed-text) | 0.5 GB | Memory search embeddings |
| Speaches (voice STT + TTS) | 1.0-1.5 GB | Loads on first voice message |
| Docker + Luna Node.js | 0.5-1.0 GB | Application + container overhead |
| macOS + other apps | 4-6 GB | Operating system baseline |
| **Total active** | **12-17 GB** | |

### What Happens on Under-Spec Hardware

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| **Machine hangs/freezes during `docker compose up`** | Not enough RAM for Docker build + Ollama | Close ALL other apps. If 8GB machine: not viable — need 16GB minimum. |
| **Telegram responses take 1-2+ minutes** | Ollama is swapping to disk (RAM exhausted) | Close Chrome, Slack, and other memory-heavy apps. Check `docker stats` for memory usage. |
| **Voice messages never get a reply** | Speaches can't load models (RAM) | Disable voice: don't send voice messages. Text still works. |
| **"Killed" in Docker logs** | Linux OOM killer terminated a process | Increase Docker Desktop memory limit: Settings → Resources → Memory → set to 8GB+ |

### Docker Desktop Memory Settings

Docker Desktop has its OWN memory limit separate from system RAM. By default it may be set too low.

1. Open Docker Desktop
2. Go to **Settings** (gear icon) → **Resources**
3. Set **Memory** to at least **8 GB** (10 GB recommended)
4. Set **Disk image size** to at least **30 GB**
5. Click **Apply & restart**

### "My machine only has 16GB — will it work?"

Yes, but close memory-heavy applications before starting luna:
- Close Chrome/Firefox (can use 2-4 GB)
- Close Slack/Teams (500 MB-1 GB each)
- Close VS Code/IDEs (500 MB-1 GB)
- Don't run multiple Docker projects simultaneously

With 16 GB and other apps closed, response times should be 5-15 seconds. With 32 GB, you can keep your normal apps open and Luna responds in 3-8 seconds.

### "My machine only has 8GB — can I use it?"

**Not recommended.** The AI model alone needs 6-8 GB. With 8 GB total RAM, the system will constantly swap to disk, causing:
- 1-5 minute response times
- Machine freezes during inference
- Docker build failures

If 8 GB is your only option: use a smaller Ollama model. In `.env`:
```bash
OLLAMA_CHAT_MODEL=qwen3:1.7b
OLLAMA_TOOL_MODEL=qwen3:1.7b
```
Then pull it: `ollama pull qwen3:1.7b` (uses ~2 GB RAM instead of 6-8 GB). Responses will be faster but less capable.

---

## Before You Start

Verify you have:

- [ ] Machine meets hardware requirements above (16 GB RAM minimum, 32 GB recommended)
- [ ] Docker Desktop installed, running, and memory set to 8 GB+ (see above)
- [ ] Ollama installed and running (check: `ollama list`)
- [ ] The superprompt repository cloned: `git clone https://github.com/ccmanuelf/superprompt.git`
- [ ] A Telegram account on your phone

**Time estimate:** 45-60 minutes for first setup (Docker build, model downloads, configuration of 3-process architecture + 10 packs). Add 60-75 minutes if running the full E2E validation (`docs/e2e-test-guide.md`).

---

## Step 1: Create Your Telegram Bot (5 minutes)

1. Open Telegram on your phone
2. Search for **@BotFather** and start a conversation
3. Send `/newbot`
4. Choose a name (e.g., "Engineering luna") and a username (e.g., `eng_luna_bot`)
5. BotFather gives you a token like: `7123456789:AAFxxx...`
6. **Save this token** — you'll need it in Step 3

## Step 2: Pull Ollama Models (5 minutes)

```bash
ollama pull qwen3.5:latest
ollama pull nomic-embed-text
```

Verify:
```bash
ollama list
# Should show qwen3.5:latest and nomic-embed-text
```

## Step 3: Configure Your Instance (5 minutes)

```bash
cd superprompt
cp .env.example .env
```

Open `.env` in your editor. You need to set two or three values — everything else can stay as defaults.

**Value 1 — Telegram bot token** (from Step 1):
```bash
TELEGRAM_BOT_TOKEN=7123456789:AAFxxx...
```

**Value 2 — Leave ALLOWED_CHAT_ID empty for now** (you'll fill it in Step 6):
```bash
ALLOWED_CHAT_ID=
```

**Value 3 — AI provider** (choose ONE of the two options below):

**Option A: Use Ollama only (recommended for E2E testing — no subscription needed)**
```bash
AI_PROVIDER=ollama
# Leave CLAUDE_CODE_OAUTH_TOKEN empty or commented out
```
Ollama runs locally on your machine. It's already installed (Step 2). No account, subscription, or API key required. This is the simplest path.

**Option B: Use Claude (requires a Claude subscription)**
```bash
AI_PROVIDER=claude
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

Claude is a cloud AI from Anthropic. It works differently from platforms that use API keys:
- It requires a **Claude Max subscription** ($100/month from anthropic.com)
- The token is NOT an API key — it's a long-lived OAuth token generated on YOUR machine
- **You generate it yourself** by running `claude setup-token` in your terminal
- This opens a browser, you log in to your Anthropic account, and the token is printed in the terminal
- Copy that token into `.env`
- The token is valid for approximately 1 year

**If you're unsure, use Option A (Ollama).** You can switch to Claude later by generating a token and changing `AI_PROVIDER=claude`. Both providers can be used on the same instance — users can switch between them with `/claude`, `/ollama`, or `/auto` in the chat.

**Optional — enable the web UI** (dashboards, docs, voice chat):

```bash
# Uncomment the port to enable the web server:
VOICE_WEB_PORT=3030
# VOICE_WEB_TOKEN is now optional. Users generate their own per-user tokens
# via /webtoken create [label] [ttl] in Telegram. Per-user tokens scope
# board cards, learning plans, memory, and schedules to individual users.
# If you still want a shared fallback token, uncomment and set:
# VOICE_WEB_TOKEN=paste-your-random-token-here
```

After starting luna, each user generates their own web token:
```
/webtoken create my-laptop 30d
```

## Step 4: Start Luna (5 minutes)

```bash
docker compose up -d
```

This starts the bot, Speaches voice sidecar, and SearXNG web search engine. SearXNG is auto-configured as a Docker service — no setup needed.

**For production deployments with HTTPS**, add the Caddy reverse proxy:
```bash
# Set your domain first in .env:
# CADDY_DOMAIN=luna.example.com
docker compose --profile production up -d
```
Caddy provides automatic HTTPS via Let's Encrypt, HTTP-to-HTTPS redirect, security headers, and WebSocket proxying. See `.env.example` for details.

**For Telegram webhook mode** (production, optional):
```bash
# In .env:
# TELEGRAM_WEBHOOK_URL=https://luna.example.com/telegram/webhook
# TELEGRAM_WEBHOOK_SECRET=generate-with-openssl-rand-hex-32
```
Webhook mode is more efficient than the default long-polling on public servers. Requires Caddy or another HTTPS reverse proxy.

First run takes 3-5 minutes (building the Docker image, downloading voice models). Watch progress:

```bash
docker compose logs -f luna
```

**What to look for:**
```
[luna] Database initialized
[luna] Provider router initialized
[luna] Telegram bot started
[entrypoint] Speaches is ready, loading models...
[entrypoint] STT model (faster-whisper-small) loaded
[entrypoint] TTS model (Kokoro-82M) loaded
```

**If you see errors:**
| Error | Fix |
|-------|-----|
| `ECONNREFUSED 11434` | Ollama isn't running. Start it: `ollama serve` |
| `401 Unauthorized` | Telegram bot token is wrong. Check `.env` |
| `No messaging platform configured` | `TELEGRAM_BOT_TOKEN` is empty in `.env` |

Press `Ctrl+C` to stop following logs (the bot keeps running in the background).

## Step 5: Send Your First Message (1 minute)

> **IMPORTANT — First-run mode:** Because `ALLOWED_CHAT_ID` is empty right now, the bot accepts messages from anyone. This is intentional — you need to message it first to get your chat ID. You'll lock it down in Step 6.

1. Open Telegram on your phone
2. Search for your bot's username (e.g., `@eng_luna_bot`) — it works like any Telegram contact
3. Tap **Start** (or send `/start`)
4. You should see a welcome message with all available commands

**If the bot doesn't respond:**
- Check that `ALLOWED_CHAT_ID` is empty in `.env` (not set to someone else's ID)
- Check logs: `docker compose logs -f luna`
- Make sure you're messaging the right bot (check the username matches)

Try:
- Send a text message: "What can you do?"
- Send a voice message: Ask anything — it should transcribe and respond
- Type `/help` for the full command list

## Step 6: Add Your Team (5 minutes)

Luna supports multiple users on one instance. Each user gets their own private conversation — they cannot see each other's messages, memories, or learning progress.

### Single user

1. Send `/chatid` to your bot — it replies with a number like `123456789`
2. Open `.env` and set:
```bash
ALLOWED_CHAT_ID=123456789
```
3. Restart:
```bash
docker compose restart Luna
```

### Multiple users (recommended for E2E testing)

Have each team member message the bot and send `/chatid`. Collect all IDs, then set them comma-separated:

```bash
ALLOWED_CHAT_ID=123456789,987654321,555555555
```

Restart once:
```bash
docker compose restart Luna
```

All users can now message the bot independently.

### What's shared vs. isolated

| Feature | Per-user (isolated) | Shared |
|---------|:---:|:---:|
| Telegram conversations | Yes | — |
| Memories (semantic + episodic) | Yes | — |
| Active skills | Yes | — |
| Learning plans and sessions | Yes | — |
| Voice transcription/replies | Yes | — |
| Scheduled tasks | Yes | — |
| Kanban board | — | Yes (all users see the same board) |
| Web dashboards (sim, capacity, etc.) | — | Yes (shared scenarios and data) |
| Web voice chat | Yes (separate WebSocket sessions) | — |
| Domain packs and tools | — | Yes (same tools available to all users) |

**In practice for E2E:** 3 users per department can test different features simultaneously. User A tests voice, User B tests manufacturing tools, User C tests learning — they won't interfere with each other.

**Security:** Without `ALLOWED_CHAT_ID`, the bot accepts messages from ANY Telegram user. Always set this in production.

## Step 7: Verify Everything Works (5 minutes)

Run through this quick checklist:

| Test | Command / Action | Expected |
|------|-----------------|----------|
| Bot responds | Send "Hello" | AI response |
| Help works | `/help` | Categorized command list |
| Voice works | Send a voice message | Transcription + voice reply |
| Memory works | "My name is [your name]" → later "What's my name?" | Recalls your name |
| Provider info | `/provider` | Shows current provider and routing mode |
| Web UI (if enabled) | Open `http://localhost:3030/` | Voice chat page loads |
| Docs (if enabled) | Open `http://localhost:3030/docs` | Documentation viewer loads |
| Packs loaded | `/pack list` | Shows "Finance & Accounting" pack |

## Step 8: Set Up Your Department Pack (Optional, 10 minutes)

If your department has specific tools or terminology:

```
/pack create engineering "Engineering analysis and project tools"
```

Then edit the generated files in `packs/engineering/` — see `docs/customization-guide.md` for the complete guide.

The pre-installed Finance pack demonstrates the pattern:
```
/pack info finance
/pack templates finance    → sends you the budget template CSV
```

---

## Daily Operations

### Starting and Stopping

```bash
docker compose up -d                      # Start (runs in background)
docker compose --profile production up -d  # Start with Caddy HTTPS (production)
docker compose down                        # Stop
docker compose restart Luna             # Restart after .env changes
docker compose logs -f luna             # View live logs
```

### Updating

When the repository is updated with new features:

```bash
cd superprompt
git pull origin main
docker compose up -d --build   # Rebuild with new code
```

Your `.env`, database (`store/`), workspace, and domain packs are preserved across updates — they're mounted as volumes, not baked into the image.

### Troubleshooting

| Problem | Check |
|---------|-------|
| Bot not responding | `docker compose logs luna` — look for errors |
| Voice not working | `docker compose logs speaches` — model loading status |
| Ollama errors | Is Ollama running? `curl http://localhost:11434/api/tags` |
| Out of memory | Close other apps. Check: `docker stats` |
| Container won't start | `docker compose down && docker compose up -d --build` |

### Getting Help

Ask Luna itself: "How do I configure [feature]?" — it knows its own setup and can walk you through any configuration.

For setup questions the bot can't answer (because they require file edits), see:
- `.env.example` — every variable documented with step-by-step instructions
- `docs/user-guide.md` — complete feature guide
- `docs/customization-guide.md` — creating department-specific tools and skills
- `docs/security.md` — security model and configuration checklist

---

## Quick Reference Card

| What | How |
|------|-----|
| Switch AI provider | `/claude`, `/ollama`, `/auto` |
| Voice replies on text | `/voice` (toggle) |
| See all commands | `/help` |
| See your memories | `/memory` |
| Clear conversation | `/newchat` |
| Your chat ID | `/chatid` |
| Installed packs | `/pack list` |
| Create a pack | `/pack create name "description"` |
| Manufacturing tools | `/sim`, `/capacity`, `/sequence`, `/vsm`, `/toc`, `/conwip`, `/doe`, `/fsm` |
| Quality tools | `/sigma`, `/balance`, `/inventory`, `/spc`, `/fmea`, `/rca` |
| Task board | `/board` |
| Learning coach | `/learn plan <subject>` |
| Schedule a reminder | `/schedule create <cron> <message>` |
| Web dashboards | `http://localhost:3030/` |
| Documentation | `http://localhost:3030/docs` |

---

## Frequently Asked Questions

### "I messaged the bot but it doesn't respond"

**Most common cause:** `ALLOWED_CHAT_ID` in `.env` is set to someone else's ID, or is set incorrectly.

**Fix:**
1. If this is first-time setup: make sure `ALLOWED_CHAT_ID=` is **empty** (not set to any value). The bot accepts all users when this is empty.
2. Send `/chatid` to the bot. If you get a response, the bot is working — proceed to Step 6.
3. If you get NO response at all, check the logs: `docker compose logs -f luna`
4. After getting your chat ID, add it to `.env` and restart.

If **multiple people** are already configured and a **new person** can't get in: add their chat ID to the comma-separated list, then restart.

### "How do users join the bot? Do they need BotFather?"

**No.** Only one person (the department admin) creates the bot via BotFather. Everyone else just searches for the bot's username in Telegram and taps Start — exactly like adding a regular contact.

The process:
1. **Admin** creates bot once → gets username like `@eng_luna_bot`
2. **Admin** shares the username with the team (text message, email, Slack — any way)
3. **Each team member** opens Telegram → searches `@eng_luna_bot` → taps Start → sends `/chatid`
4. **Each team member** sends their chat ID number back to the admin
5. **Admin** adds all IDs to `.env`: `ALLOWED_CHAT_ID=111,222,333` → restarts once

After restart, all team members can use the bot independently.

### "Where do I get the Claude token? Who provides it?"

**You generate it yourself** — it's not provided by anyone else.

Luna uses two AI providers. You only need one:

| Provider | What It Is | Cost | How to Get |
|----------|-----------|------|-----------|
| **Ollama** (recommended for E2E) | AI that runs locally on your machine | Free | Already installed if you followed Step 2 |
| **Claude** (optional) | Cloud AI from Anthropic | $100/month subscription | You sign up, then generate a token yourself |

**If you just want to get started:** Set `AI_PROVIDER=ollama` in `.env` and skip the Claude token entirely. Ollama handles everything locally — no account, no subscription, no API key.

**If you want Claude:** You need a Claude Max subscription from [anthropic.com](https://anthropic.com). After subscribing:
1. Install Claude CLI: `npm install -g @anthropic-ai/claude-code`
2. Run: `claude setup-token`
3. A browser opens — log in to your Anthropic account
4. The token prints in your terminal — copy it into `.env`

This is different from platforms that use API keys. Claude uses a subscription + OAuth token model, not a pay-per-request API key.

### "Can multiple people use the bot at the same time?"

**Yes.** Each person gets their own private conversation. They can't see each other's messages, memories, or learning progress. See the shared-vs-isolated table in Step 6.

### "Do we need one bot per person, or one bot per department?"

**One bot per department.** All team members share the same bot but have isolated conversations. You do NOT need to create a separate bot for each person.

### "The bot responded at first but stopped working after someone edited .env"

After any `.env` change, you must restart:
```bash
docker compose restart Luna
```
If `ALLOWED_CHAT_ID` was changed to only include some IDs, users whose IDs were removed will no longer get responses.

### "What's the difference between this and ChatGPT / other AI chatbots?"

Luna runs **on your own machine** — your conversations, data, and files never leave your workstation. It also has specialized capabilities that general-purpose chatbots don't:

| Feature | General Chatbots | Luna |
|---------|:---:|:---:|
| Manufacturing engineering tools | No | 15 modules with web dashboards |
| Persistent memory across conversations | Limited | Full dual-layer with AI compression |
| Voice processing | Cloud-based | Fully local (99 languages) |
| Custom department tools (Domain Packs) | No | Yes — any department can add their own |
| File generation (Excel, PDF, PPTX) | Limited | Full document generation with charts |
| Your data stays on your machine | No | Yes — Docker on your workstation |
| Works without internet | No | Yes (with Ollama) |

---

## Recovery Procedures

Each procedure is a four-step playbook: **symptom** (what you'll observe), **diagnosis** (commands to run to confirm cause), **fix** (commands to resolve), **verification** (how you know it's working). Run procedures top-to-bottom; if the diagnosis doesn't match, move to the next plausible procedure rather than guessing.

### 1. Telegram bot stops responding

**Symptom:** Messages sent to the bot in Telegram receive no reply. Other users on the same bot also see no response (rules out a per-user issue).

**Diagnosis:**
```bash
docker compose ps                                    # is luna-bot healthy?
docker compose logs luna --tail=50                   # any error / restart loop?
docker compose logs luna --tail=200 | grep -iE "error|crash|exit"
```

Three common root causes, distinguish from the logs:

- **Bad / revoked Telegram token.** Logs show `401 Unauthorized` or `Telegram Bot API`. The token in `.env` no longer works.
- **Polling stuck after a long pause.** Logs show no recent `Telegram bot started` and no message-receipt entries for >5 minutes.
- **Container itself is unhealthy or crashed.** `docker compose ps` shows `unhealthy` or `Exited` status.

**Fix:**
- For bad token: `sed -i '' 's/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=NEW_TOKEN/' .env` (use `sed` to keep the secret out of any scrollback) → `docker compose up -d --force-recreate luna`.
- For stuck polling or unhealthy container: `docker compose restart luna`. If still failing, `docker compose up -d --force-recreate luna`.

**Verification:**
```bash
docker compose logs luna --tail=20 | grep "Telegram bot started"   # should appear
docker compose ps | grep luna-bot                                  # should be Up (healthy)
```
Then send `/start` from Telegram. If the bot replies, you're done.

### 2. Claude API returns 401 / 429

**Symptom:** Conversations on `/claude` provider show errors like "Claude request failed" or "authentication error" or "rate limit exceeded." Ollama-path turns continue to work normally.

**Diagnosis:**
```bash
docker compose logs luna --tail=100 | grep -iE "claude.*(401|429|auth|rate)"
```

- **401:** the OAuth token is expired or revoked.
- **429:** subscription rate limit hit. The flat-rate Anthropic Max plan still has per-window caps.

**Fix:**
- For **401:** generate a fresh token: `claude setup-token` on a host with the subscription logged in → `sed -i '' 's/^CLAUDE_CODE_OAUTH_TOKEN=.*/CLAUDE_CODE_OAUTH_TOKEN=NEW_TOKEN/' .env` → `docker compose up -d --force-recreate luna`. Tokens are valid ~1 year; rotation is normal maintenance, not an incident.
- For **429:** confirm with `/usage` in Telegram that Claude calls are unusually high this month. If they are, lock the offending chats to Ollama: `/ollama` per chat. The rc.95 default is local-first; if you find yourself hitting 429 regularly, audit whether `AI_PROVIDER` was overridden to `claude` or whether `AUTO_ROUTE` was set to `false` in `.env`.

**Verification:**
```bash
# Send a test message in a Telegram chat after running:
/claude
"hello, can you confirm you're awake?"
```
A clean reply means the Claude path is restored. If it still fails, re-check `docker compose logs luna --tail=20`.

### 3. Ollama model not found

**Symptom:** Ollama-path turns reply with "model not found" or "model qwen3.5:latest is not loaded." Claude path (if configured) still works.

**Diagnosis:**
```bash
ollama list                                                  # on the HOST, not inside Docker
ollama ps                                                    # what's loaded right now
# from inside the container, confirm reachability:
docker compose exec luna sh -c 'curl -s http://host.docker.internal:11434/api/tags | head -50'
```

Two root causes:
- **Model never pulled:** `ollama list` doesn't show `qwen3.5:latest` (or whatever `OLLAMA_CHAT_MODEL` is set to) or `nomic-embed-text` (for `OLLAMA_EMBED_MODEL`).
- **Ollama service not running on the host:** `ollama list` itself errors with connection refused.

**Fix:**
- For missing model: `ollama pull qwen3.5:latest && ollama pull nomic-embed-text`. Wait for the download to complete.
- For Ollama not running: macOS — open Ollama.app from Applications. Linux — `systemctl --user start ollama` (or your distro's equivalent).

**Verification:**
```bash
ollama list | grep -E "qwen3.5|nomic-embed-text"   # both should appear
```
Then in any Telegram chat, send a question. The Ollama path should respond within ~5s.

### 4. SQLite database locked or corrupted

**Symptom:** Logs show `SQLITE_BUSY`, `database is locked`, or `database disk image is malformed`. Bot replies are slow / time out / fail with internal errors.

**Diagnosis:**
```bash
docker compose logs luna --tail=200 | grep -iE "sqlite|locked|malformed|busy"
ls -lah store/luna.db                                # file size sanity-check
docker compose exec luna node -e "
import('better-sqlite3').then(({default: D}) => {
  try {
    const db = new D('/app/store/luna.db', { readonly: true });
    const r = db.prepare('PRAGMA integrity_check').get();
    console.log('integrity:', r);
    db.close();
  } catch (e) { console.error('open failed:', e.message); }
});"
```

- **Locked:** another process holds the WAL lock. Usually transient — a previous container's writer didn't release.
- **Malformed:** disk corruption. Rare; usually means the host had a power event or the volume was unmounted mid-write.

**Fix:**
- For locked: `docker compose stop luna` → `ls -la store/luna.db*` (look for stale `.db-wal` or `.db-shm` files older than the current container) → `docker compose up -d luna` (the bot will recover the WAL on startup).
- For malformed: stop the container → restore from the most recent backup in `store/backups/` (or the `cron`-driven backup you set up per the §Backup section). If no backup exists, `sqlite3 store/luna.db ".recover" > recovered.sql` (run in a Node throw-away shell since the alpine image lacks `sqlite3`) is a last resort.

**Verification:**
```bash
# After fix:
docker compose logs luna --tail=20 | grep "Application started"
docker compose exec luna node -e "
import('better-sqlite3').then(({default: D}) => {
  const db = new D('/app/store/luna.db', { readonly: true });
  console.log('rows:', db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n);
  db.close();
});"
```
The integrity check should print `{ integrity_check: 'ok' }` and the session count should be reasonable.

### 5. Docker container crashed

**Symptom:** `docker compose ps` shows `luna-bot` in `Exited` state, or the container is in a restart loop (`Restarting (1)` repeating).

**Diagnosis:**
```bash
docker compose logs luna --tail=100 | tail -60        # what was the last thing logged before exit?
docker compose ps                                     # current state
docker inspect luna-bot --format '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Error}}'
```

Common causes:
- **OOM kill:** `OOMKilled = true`. Container hit the Docker Desktop memory limit. Increase memory in Docker Desktop → Settings → Resources, or reduce concurrent Ollama-loaded models.
- **Uncaught exception on startup:** logs show a stack trace right before exit. Usually a config error (bad `.env` value, missing required env var, malformed JSON in a custom skill).
- **Healthcheck failure during start period:** logs show the bot starting normally but the container reports unhealthy after a few minutes. `docker inspect luna-bot --format '{{json .State.Health}}'` shows the recent healthcheck output.

**Fix:**
- For OOM: bump Docker Desktop memory to ≥12 GB (the runbook §Hardware Requirements section explains why), restart Docker Desktop, then `docker compose up -d luna`.
- For startup exception: read the stack trace, identify the config field, fix in `.env` (via `sed`), `docker compose up -d --force-recreate luna`.
- For healthcheck failure: inspect what the healthcheck is testing. Often it's the web server on port 3030 — confirm `VOICE_WEB_PORT=3030` is set, or set it to `0` if you don't want the web server (the healthcheck will then fall back to the process check).

**Verification:**
```bash
docker compose ps | grep luna-bot                     # Up (healthy)
docker compose logs luna --tail=20 | grep "Luna is running"
```

### 6. Memory database grows too large

**Symptom:** `store/luna.db` is multiple GB; Luna's startup is slow (>20s) and memory queries (`buildMemoryContext`) take seconds instead of ms.

**Diagnosis:**
```bash
ls -lah store/luna.db                                # raw size
docker compose exec luna node -e "
import('better-sqlite3').then(({default: D}) => {
  const db = new D('/app/store/luna.db', { readonly: true });
  for (const t of ['memories', 'episodes', 'chat_log', 'kanban_cards', 'attendance_badge_records']) {
    try {
      const r = db.prepare(\`SELECT COUNT(*) AS n FROM \${t}\`).get();
      console.log(\`\${t}: \${r.n} rows\`);
    } catch {}
  }
  db.close();
});"
```

Salience decay normally keeps `memories` bounded. If row counts are running into millions on any table, decay isn't running (or wasn't keeping up).

**Fix:**

```bash
# Force a decay sweep right now (won't wait for the next scheduled run):
docker compose exec luna node -e "
import('./dist/memory.js').then(async m => {
  await m.runDecaySweep();
  console.log('Decay sweep complete');
});"

# If chat_log is the offender, prune older than 200 turns per chat (the cap):
docker compose exec luna node -e "
import('./dist/db-knex.js').then(async ({getKnex, initKnex}) => {
  initKnex({ driver: 'sqlite', sqliteFilename: '/app/store/luna.db' });
  const k = getKnex();
  // Keep newest 200 per chat; this is the rc.69 retention semantics
  const before = await k('chat_log').count('* as n').first();
  console.log('chat_log before:', before.n);
  await k.raw(\`
    DELETE FROM chat_log WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at DESC) AS rn
        FROM chat_log
      ) WHERE rn <= 200
    )\`);
  const after = await k('chat_log').count('* as n').first();
  console.log('chat_log after:', after.n);
  process.exit(0);
});"

# Vacuum to reclaim disk:
docker compose stop luna
docker compose run --rm luna node -e "
import('better-sqlite3').then(({default: D}) => {
  const db = new D('/app/store/luna.db');
  db.pragma('journal_mode = WAL');
  db.exec('VACUUM');
  db.close();
});"
docker compose up -d luna
```

**Verification:**
```bash
ls -lah store/luna.db                                # should be smaller after VACUUM
docker compose logs luna --tail=20 | grep "Application started"
```
In a chat, send a memory-using message (e.g., "what did we discuss yesterday about X") — response time should be <2s.

### 7. Bridge cold-start causing timeouts (DEFERRED)

**Status:** This procedure is intentionally deferred. The NovaLink bridge runs today as a Replit prototype where cold-start delays of 15-30s are inherent to the free tier. The same-VM target architecture eliminates this failure mode entirely (the bridge container is always up, no cold-start). Documenting a workaround for the Replit cold-start would be wasted effort because the bridge is moving.

When the bridge is integrated as a same-VM sidecar, this procedure will be replaced with: "Bridge container unreachable — diagnose `docker compose ps novalink-bridge`, fix with `docker compose up -d novalink-bridge`, verify with `curl http://novalink-bridge:5000/api/health` from inside `luna`." See [`NOVALINK_BRIDGE_INTEGRATION.md`](./NOVALINK_BRIDGE_INTEGRATION.md) §7 (migration plan) for when this changes.

---

## When in doubt

The four-step "what changed?" diagnostic always applies before opening a deeper investigation:

1. `git log --since="last week" --oneline` — recent commits that might explain new behavior
2. `git diff HEAD~5 -- .env.example` — env-var schema changes you may need to mirror in `.env`
3. `docker compose ps` and `docker compose logs --tail=100 luna` — current state
4. `/usage` in Telegram — verify routing posture is what you expect

If after that you're still stuck, escalate per [`ONBOARDING.md`](./ONBOARDING.md) §12 ("Where to ask for help").
