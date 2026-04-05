# clauded — User Help Guide

Everything you need to know to work effectively with your AI assistant.
Available in English and Spanish — clauded responds in your language.

---

## Getting Started

**clauded** is your department's AI partner. It helps with tasks, remembers context, learns from experience, and connects to your department's specialized tools.

### First Steps
1. Open Telegram and find your department's clauded bot
2. Send "Hello" — clauded will introduce itself
3. Try `/help` to see all available commands
4. Ask about your department: "What tools do you have for [your area]?"

### Voice Messages
Send a voice note in Telegram — clauded transcribes it automatically. Works in English and Spanish. Enable voice replies with `/voice`.

### Web Dashboards
Open your browser to access visual tools:
- **Voice chat:** `http://[server]:3030/`
- **Task board:** `http://[server]:3030/board.html`
- **Learning coach:** `http://[server]:3030/learn.html`

Manufacturing users also have: `/sim`, `/capacity`, `/sequence`, `/vsm`, `/toc`, `/conwip`, `/doe`, `/fsm`

---

## What clauded Can Do For You

### Answer Questions
Just ask naturally. clauded remembers your previous conversations and uses that context to give better answers over time.

### Use Department Tools
Each department has specialized tools. Ask clauded: "What tools are available?" Examples:
- **Manufacturing:** "Calculate capacity for 3 shifts" → runs capacity planning tool
- **Finance:** "Calculate NPV for a $50K investment at 8% over 5 years"
- **HR:** "Calculate PTO balance for 8 months at 15 days annual"
- **Engineering:** "Generate a code review checklist for the API changes"

### Create Documents
clauded creates real files — not just descriptions:
- "Create a spreadsheet with monthly sales data" → Excel file
- "Generate a PDF report on project status" → PDF document
- "Make a presentation about Q2 results" → PowerPoint file

### Manage Tasks
- `/board add Fix the production schedule` — creates a task card
- `/board` — shows your task board
- `/board move [id] done` — marks a task complete

### Set Reminders
- `/schedule create "0 9 * * 1" "Weekly team sync"` — every Monday at 9 AM
- `/schedule list` — shows your scheduled reminders

### Learn New Topics
- `/learn plan Machine Learning basics` — creates a learning plan
- clauded teaches with Socratic questions, not lectures
- Tracks your progress with spaced repetition

---

## Commands Quick Reference

### Everyday Commands
| Command | What it does |
|---------|-------------|
| `/help` | Show all commands |
| `/newchat` | Start fresh (memories preserved) |
| `/voice` | Toggle voice replies |
| `/memory` | Show what clauded remembers about you |

### AI Provider
| Command | What it does |
|---------|-------------|
| `/claude` | Switch to Claude (subscription, more capable) |
| `/ollama` | Switch to Ollama (local, faster) |
| `/auto` | Auto-select provider per message |
| `/provider` | Show current provider |

### Skills (AI Personas)
| Command | What it does |
|---------|-------------|
| `/skill list` | Show available skills |
| `/skill use [name]` | Activate a skill (e.g., debugger, analyst) |
| `/skill off` | Return to default mode |

### Department Packs
| Command | What it does |
|---------|-------------|
| `/pack list` | Show available packs and their status |
| `/pack enable [name]` | Enable a pack for your chat |
| `/pack disable [name]` | Disable a pack you don't need |
| `/pack info [name]` | Show pack details |
| `/pack guide` | Show how to create packs |

### Trust & Security
| Command | What it does |
|---------|-------------|
| `/trust list` | Show your tool trust decisions |
| `/trust revoke [tool]` | Remove trust for a specific tool |
| `/trust clear` | Reset all trust decisions |

When a critical tool (like running a system command) is used for the first time, clauded asks for confirmation. You can reply:
- **"confirm" / "confirmar"** — allow this once
- **"always" / "siempre"** — always allow (remembered)
- **"never" / "nunca"** — block this tool permanently

---

## What clauded Learns Automatically

### From Your Conversations
clauded remembers facts you share and events you discuss. This builds over time — the more you interact, the more relevant context it provides.

### From Complex Tasks
When you complete a task using 3+ tools, clauded offers to save the workflow as a reusable skill. Next time you have a similar task, it activates automatically.

### From Mistakes
When something doesn't work well, clauded learns from it:
- **Tool failures** become guardrails (permanent rules)
- **Your corrections** ("no, try it this way") improve skills
- **Low quality responses** create notes to use tools next time

### From Your Usage Patterns
Packs you use successfully get boosted in priority. Packs whose tools fail get dampened. clauded adapts to what works for you.

---

## What clauded CANNOT Do

clauded is honest about its boundaries:

### Can build conversationally:
- New calculation tools ("I need a tool that calculates X")
- New skills and personas
- New department packs
- API integrations (connecting to REST endpoints)
- Data analysis, reports, documents

### Needs the software development team:
- **Custom web dashboards** (like /sim, /capacity) — these require HTML/TypeScript development
- **Database schema changes** — requires developer expertise
- **New Telegram commands** — requires platform code changes

If you ask for something that needs the dev team, clauded will:
1. Build what it CAN right now (the tools and logic)
2. Draft requirements for the dev team
3. Guide you on what to request

---

## Tips for Best Results

1. **Be specific** — "Calculate capacity for Line 3 with 2 shifts, 8 hours, 22 days" works better than "how much can we make?"
2. **Use voice** — production floor workers can speak naturally in Spanish or English
3. **Upload data** — send CSV/Excel files directly; clauded parses and analyzes them
4. **Say "remember"** — "Remember that Line 3 runs 2 shifts" stores it permanently
5. **Check your packs** — `/pack list` shows what tools your department has
6. **Start fresh when stuck** — `/newchat` clears conversation history but keeps memories
7. **Trust your tools** — when asked to confirm a critical tool, say "always" if you use it regularly

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Check if Docker is running: `docker ps` |
| Slow responses | Close memory-heavy apps, or switch to `/ollama` for local processing |
| Voice not working | Voice requires Speaches sidecar running |
| Wrong language | clauded auto-detects — just write/speak in your preferred language |
| Tool keeps failing | clauded learns from failures automatically via guardrails |
| Too many confirmations | Say "always" / "siempre" to trust a tool permanently |
| Conversation feels off | Try `/newchat` — memories and skills are preserved |

---

## Contact

For issues beyond what clauded can help with:
- **Software development requests** (dashboards, new commands) → Software Development Team
- **Account/access issues** → IT Department
- **New department pack requests** → Ask clauded: "I need a pack for [your area]" — it builds Level 2 packs conversationally

---

*clauded v1.0.0-rc.29 — Your AI Engineering Partner*
*Bilingual: English + Spanish | Voice + Text | 10 Department Packs*
