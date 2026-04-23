# luna v1.0.0-rc.29 — End-to-End Test Guide & Checklist

Complete E2E validation for the architecture-hardened version (SA1-SA5).
Run all sections to certify a deployment is production-ready.

**Estimated time:** 60-75 minutes
**Prerequisites:** luna running, Telegram bot connected, Ollama responding

---

## Section 1: Startup & Process Verification (5 min)

| # | Test | Expected | Pass |
|---|------|----------|------|
| 1.1 | `docker ps` shows luna-bot healthy | Status: healthy | [ ] |
| 1.2 | `docker logs luna-bot \| grep "Application started"` | Log entry present | [ ] |
| 1.3 | `docker logs luna-bot \| grep "Tools process (P2) spawned"` | Process 2 running | [ ] |
| 1.4 | `docker logs luna-bot \| grep "Parsers process (P3) spawned"` | Process 3 running | [ ] |
| 1.5 | `docker logs luna-bot \| grep "Loaded domain pack" \| wc -l` | 9 packs loaded | [ ] |
| 1.6 | `docker logs luna-bot \| grep "Telegram bot started"` | Bot connected | [ ] |
| 1.7 | `docker logs luna-bot \| grep -c "WARN\|ERROR"` | 0 warnings/errors | [ ] |
| 1.8 | Voice web server started on configured port | Log entry present | [ ] |

## Section 2: Basic Messaging (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 2.1 | Text message | Send "Hello" | Response within 10s | [ ] |
| 2.2 | Provider switch | `/ollama` then send message | Responds via Ollama | [ ] |
| 2.3 | Provider switch back | `/claude` then send message | Responds via Claude | [ ] |
| 2.4 | New chat | `/newchat` then send message | No prior context | [ ] |
| 2.5 | Help command | `/help` | Lists all commands | [ ] |
| 2.6 | Spanish message | "Hola, como estas?" | Responds in Spanish | [ ] |

## Section 3: Memory System (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 3.1 | Memory creation | Tell bot a fact: "My favorite color is blue" | Acknowledged | [ ] |
| 3.2 | Memory recall | Ask: "What is my favorite color?" | Recalls "blue" | [ ] |
| 3.3 | Memory list | `/memory` | Shows stored memories | [ ] |

## Section 4: Skills (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 4.1 | List skills | `/skill list` | Shows builtin + custom skills | [ ] |
| 4.2 | Activate skill | `/skill use debugger` | "Switched to debugger mode" | [ ] |
| 4.3 | Deactivate skill | `/skill off` | "Back to default mode" | [ ] |
| 4.4 | Auto-trigger | Send error description | Debugger skill auto-activates | [ ] |

## Section 5: Tool Execution + Policy Engine (10 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 5.1 | Low-risk tool | Ask "What time is it?" | get_time executes, no confirmation | [ ] |
| 5.2 | Medium-risk tool | "Save a memory: test note" | save_memory executes, no confirmation | [ ] |
| 5.3 | High-risk tool | "Search for Node.js best practices" | web_search executes, no confirmation | [ ] |
| 5.4 | Critical tool | Ask to run a shell command | Confirmation prompt appears (bilingual EN/ES) | [ ] |
| 5.5 | Confirm once | Reply "confirm" | Tool executes, asks again next time | [ ] |
| 5.6 | Confirm always | On next critical tool, reply "always" / "siempre" | Tool executes, trust stored | [ ] |
| 5.7 | Trust remembered | Trigger same critical tool again | Executes WITHOUT confirmation | [ ] |
| 5.8 | Trust list | `/trust list` | Shows stored trust decisions | [ ] |
| 5.9 | Trust revoke | `/trust revoke run_command` | Trust removed, confirmation required again | [ ] |

## Section 6: Worker Sandbox (SA1) (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 6.1 | User tool creation | `/tool upload` with a generated_code .md file | Tool registered | [ ] |
| 6.2 | User tool execution | Ask AI to use the tool | Executes in Worker sandbox | [ ] |
| 6.3 | Tool list | `/tool list` | Shows user tool alongside builtins | [ ] |
| 6.4 | Bilingual errors | Create tool with intentional error | Error message has [EN] + [ES] | [ ] |

## Section 7: Domain Packs (SA5) (10 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 7.1 | Pack list | `/pack list` | Shows 9 packs with enabled status | [ ] |
| 7.2 | Pack info | `/pack info manufacturing` | Shows description, tools, triggers | [ ] |
| 7.3 | Pack disable | `/pack disable trade-compliance` | Pack disabled confirmation | [ ] |
| 7.4 | Pack re-enable | `/pack enable trade-compliance` | Pack enabled confirmation | [ ] |
| 7.5 | Manufacturing tool | "Calculate line balance for 5 stations" | Manufacturing tool executes | [ ] |
| 7.6 | Finance tool | "Calculate NPV for $10000 at 5% over 5 years" | Finance tool executes | [ ] |
| 7.7 | HR tool | "Calculate PTO balance: 15 days annual, 8 months, 5 taken" | HR tool executes | [ ] |
| 7.8 | Pack guide | `/pack guide` | Bilingual guide displayed | [ ] |

## Section 8: Manufacturing Dashboards (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 8.1 | Simulation | Open `http://localhost:3030/sim` | Dashboard loads | [ ] |
| 8.2 | Capacity | Open `http://localhost:3030/capacity` | Dashboard loads | [ ] |
| 8.3 | Sequencer | Open `http://localhost:3030/sequence` | Dashboard loads | [ ] |
| 8.4 | VSM | Open `http://localhost:3030/vsm` | Dashboard loads | [ ] |
| 8.5 | Voice chat | Open `http://localhost:3030/` | Voice UI loads | [ ] |
| 8.6 | Kanban board | Open `http://localhost:3030/board.html` | Board UI loads | [ ] |

## Section 9: Voice (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 9.1 | Voice message | Send voice note on Telegram | Transcribed + text response | [ ] |
| 9.2 | Voice reply | Send voice note with `/voice` enabled | Audio response returned | [ ] |
| 9.3 | Language detection | Send voice in Spanish | Responds in Spanish | [ ] |

## Section 10: Kanban & Scheduling (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 10.1 | Create card | `/board add Test task` | Card created | [ ] |
| 10.2 | Move card | `/board move <id> done` | Card moved to done | [ ] |
| 10.3 | Board view | `/board` | Shows all cards by column | [ ] |
| 10.4 | Create schedule | `/schedule create "0 9 * * 1" "Weekly report"` | Task scheduled | [ ] |
| 10.5 | List schedules | `/schedule list` | Shows scheduled tasks | [ ] |

## Section 11: Document Generation (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 11.1 | Excel | "Create a spreadsheet with Q1 sales data" | .xlsx file sent | [ ] |
| 11.2 | PDF | "Generate a PDF report about project status" | .pdf file sent | [ ] |

## Section 12: Auto-Skills + Self-Healing (5 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 12.1 | Complex task | Ask multi-step task using 3+ tools | Task completes | [ ] |
| 12.2 | Skill proposal | After complex task | Bilingual proposal appears (if quality ≥70) | [ ] |
| 12.3 | Approval | Reply "yes" / "si" | Skill created, confirmation shown | [ ] |
| 12.4 | Skill trigger | Send similar request | Auto-generated skill suggests activation | [ ] |

## Section 13: Circuit Breaker (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 13.1 | Bilingual breaker message | Trigger repeated tool failure | Error contains [EN] + [ES] | [ ] |

## Section 14: Rate Limiting (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 14.1 | Rate limit status | Ask AI about usage | Shows calls/hour for both providers | [ ] |
| 14.2 | Provider switch suggestion | Hit rate limit | Bilingual message suggests /ollama or /claude | [ ] |

## Section 15: Guardrails (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 15.1 | Manual guardrail | /guardrail add "Always verify data" | Guardrail stored | [ ] |
| 15.2 | Guardrail persistence | Send new message | Guardrail injected in context | [ ] |

## Section 16: Context Health (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 16.1 | Health status | After many messages | Yellow/red suggestion appears | [ ] |
| 16.2 | Reset health | /newchat | Health resets to green | [ ] |

## Section 17: Self-Tuning Packs (3 min)

| # | Test | How | Expected | Pass |
|---|------|-----|----------|------|
| 17.1 | Pack weight tracking | Use manufacturing tools | Weight adjusts after 5+ calls | [ ] |

---

## Sign-Off

| Item | Value |
|------|-------|
| **Version** | v1.0.0-rc.30 |
| **Date** | |
| **Tester** | |
| **Environment** | |
| **Sections passed** | /17 |
| **Tests passed** | /XX |
| **Notes** | |

## Complementary: Operations Hub Completion

After passing the E2E checklist, the **Production Planning team** should complete the Operations Hub configuration using the dedicated guide:

**[Hub Completion Guide](hub-completion-guide.md)** — covers:
- What's mocked vs real (every item listed with replacement instructions)
- What the team needs to provide (3-priority checklist)
- How to load templates (Telegram upload, pack directory, conversational)
- How to tweak tool behavior conversationally
- When to contact the software team (clear boundary)
- How to validate real data vs sample data (step-by-step)
- Current assumptions and how to correct them

**This guide is for the Planning team, not IT.** Most configuration is done by talking to luna.

---

## Claude Subscription Note

luna uses the Claude CLI (`claude -p`) which runs on an **Anthropic subscription** (fixed monthly fee). This is the same subscription used for the demo. **No per-token API consumption** — the deployed version costs the same as the development environment.

Authentication: `CLAUDE_CODE_OAUTH_TOKEN` env var, generated via `claude setup-token`.
