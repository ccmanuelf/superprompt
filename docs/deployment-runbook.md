# clauded v1.0.0-rc.29 — Department Onboarding Runbook

Get your own clauded instance running in 45-60 minutes. This guide is for team members receiving the repository who need to set up their own independent instance.

**What you'll have when done:** Your own autonomous AI assistant on Telegram with:
- Voice processing (EN/ES), 10 department packs (manufacturing, finance, HR, engineering, etc.)
- 43+ tools with 4-layer security (policy engine → process isolation → Worker sandbox → SSRF protection)
- Auto-skill learning (clauded gets smarter from complex tasks)
- Web dashboards (/sim, /capacity, /sequence, /vsm, /toc, /conwip, /doe, /fsm, /board, /learn)
- Document generation (Excel, PDF, Word, CSV, PowerPoint)
- Circuit breaker, rate limiting, guardrails memory, context health monitoring, self-tuning pack weights

**Architecture:** 3-process model (core + tools + parsers) with per-user trust memory.

**Claude subscription:** Uses `claude` CLI with a fixed monthly Anthropic subscription — no per-token API costs. The deployed version runs on the same subscription as the demo.

**After deployment:** Run the [E2E Test Guide](e2e-test-guide.md) to validate all 17 sections (65+ test cases).

---

## Hardware Requirements

**Check your machine BEFORE starting setup.** clauded runs AI models locally — this requires significant RAM and a modern processor. Running on under-spec hardware will cause the machine to hang or responses to take minutes instead of seconds.

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
| Docker + clauded Node.js | 0.5-1.0 GB | Application + container overhead |
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

Yes, but close memory-heavy applications before starting clauded:
- Close Chrome/Firefox (can use 2-4 GB)
- Close Slack/Teams (500 MB-1 GB each)
- Close VS Code/IDEs (500 MB-1 GB)
- Don't run multiple Docker projects simultaneously

With 16 GB and other apps closed, response times should be 5-15 seconds. With 32 GB, you can keep your normal apps open and clauded responds in 3-8 seconds.

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
4. Choose a name (e.g., "Engineering clauded") and a username (e.g., `eng_clauded_bot`)
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

After starting clauded, each user generates their own web token:
```
/webtoken create my-laptop 30d
```

## Step 4: Start clauded (5 minutes)

```bash
docker compose up -d
```

First run takes 3-5 minutes (building the Docker image, downloading voice models). Watch progress:

```bash
docker compose logs -f clauded
```

**What to look for:**
```
[clauded] Database initialized
[clauded] Provider router initialized
[clauded] Telegram bot started
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
2. Search for your bot's username (e.g., `@eng_clauded_bot`) — it works like any Telegram contact
3. Tap **Start** (or send `/start`)
4. You should see a welcome message with all available commands

**If the bot doesn't respond:**
- Check that `ALLOWED_CHAT_ID` is empty in `.env` (not set to someone else's ID)
- Check logs: `docker compose logs -f clauded`
- Make sure you're messaging the right bot (check the username matches)

Try:
- Send a text message: "What can you do?"
- Send a voice message: Ask anything — it should transcribe and respond
- Type `/help` for the full command list

## Step 6: Add Your Team (5 minutes)

clauded supports multiple users on one instance. Each user gets their own private conversation — they cannot see each other's messages, memories, or learning progress.

### Single user

1. Send `/chatid` to your bot — it replies with a number like `123456789`
2. Open `.env` and set:
```bash
ALLOWED_CHAT_ID=123456789
```
3. Restart:
```bash
docker compose restart clauded
```

### Multiple users (recommended for E2E testing)

Have each team member message the bot and send `/chatid`. Collect all IDs, then set them comma-separated:

```bash
ALLOWED_CHAT_ID=123456789,987654321,555555555
```

Restart once:
```bash
docker compose restart clauded
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
docker compose up -d          # Start (runs in background)
docker compose down           # Stop
docker compose restart clauded # Restart after .env changes
docker compose logs -f clauded # View live logs
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
| Bot not responding | `docker compose logs clauded` — look for errors |
| Voice not working | `docker compose logs speaches` — model loading status |
| Ollama errors | Is Ollama running? `curl http://localhost:11434/api/tags` |
| Out of memory | Close other apps. Check: `docker stats` |
| Container won't start | `docker compose down && docker compose up -d --build` |

### Getting Help

Ask clauded itself: "How do I configure [feature]?" — it knows its own setup and can walk you through any configuration.

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
3. If you get NO response at all, check the logs: `docker compose logs -f clauded`
4. After getting your chat ID, add it to `.env` and restart.

If **multiple people** are already configured and a **new person** can't get in: add their chat ID to the comma-separated list, then restart.

### "How do users join the bot? Do they need BotFather?"

**No.** Only one person (the department admin) creates the bot via BotFather. Everyone else just searches for the bot's username in Telegram and taps Start — exactly like adding a regular contact.

The process:
1. **Admin** creates bot once → gets username like `@eng_clauded_bot`
2. **Admin** shares the username with the team (text message, email, Slack — any way)
3. **Each team member** opens Telegram → searches `@eng_clauded_bot` → taps Start → sends `/chatid`
4. **Each team member** sends their chat ID number back to the admin
5. **Admin** adds all IDs to `.env`: `ALLOWED_CHAT_ID=111,222,333` → restarts once

After restart, all team members can use the bot independently.

### "Where do I get the Claude token? Who provides it?"

**You generate it yourself** — it's not provided by anyone else.

clauded uses two AI providers. You only need one:

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
docker compose restart clauded
```
If `ALLOWED_CHAT_ID` was changed to only include some IDs, users whose IDs were removed will no longer get responses.

### "What's the difference between this and ChatGPT / other AI chatbots?"

clauded runs **on your own machine** — your conversations, data, and files never leave your workstation. It also has specialized capabilities that general-purpose chatbots don't:

| Feature | General Chatbots | clauded |
|---------|:---:|:---:|
| Manufacturing engineering tools | No | 15 modules with web dashboards |
| Persistent memory across conversations | Limited | Full dual-layer with AI compression |
| Voice processing | Cloud-based | Fully local (99 languages) |
| Custom department tools (Domain Packs) | No | Yes — any department can add their own |
| File generation (Excel, PDF, PPTX) | Limited | Full document generation with charts |
| Your data stays on your machine | No | Yes — Docker on your workstation |
| Works without internet | No | Yes (with Ollama) |
