# clauded — Department Onboarding Runbook

Get your own clauded instance running in 30 minutes. This guide is for team members receiving the repository who need to set up their own independent instance.

**What you'll have when done:** Your own AI assistant on Telegram with voice processing, manufacturing tools, document generation, and a web dashboard — all running locally on your workstation.

---

## Before You Start

Verify you have:

- [ ] macOS with Docker Desktop installed and running (check: `docker --version`)
- [ ] Ollama installed and running (check: `ollama list`)
- [ ] The superprompt repository cloned: `git clone https://github.com/your-org/superprompt.git`
- [ ] A Telegram account on your phone

**Time estimate:** 30 minutes for first setup (most of it is waiting for Docker to build and models to download).

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

Open `.env` in your editor and set these values (everything else can stay as defaults):

```bash
# REQUIRED — paste your BotFather token
TELEGRAM_BOT_TOKEN=7123456789:AAFxxx...

# LEAVE EMPTY FOR NOW — you'll fill this in Step 6
ALLOWED_CHAT_ID=

# REQUIRED IF USING CLAUDE — generate with: claude setup-token
# If you don't have a Claude subscription, change AI_PROVIDER to ollama
CLAUDE_CODE_OAUTH_TOKEN=your-token-here

# OR, if using Ollama only:
# AI_PROVIDER=ollama
```

**Optional — enable the web UI** (dashboards, docs, voice chat):

```bash
# Generate a random token:
#   openssl rand -hex 32
# Then uncomment and fill in both lines:
VOICE_WEB_PORT=3030
VOICE_WEB_TOKEN=paste-your-random-token-here
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

1. Open Telegram
2. Search for your bot's username (e.g., `@eng_clauded_bot`)
3. Send `/start`
4. You should see a welcome message with all available commands

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
