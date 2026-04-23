# E2E Testing Plan — Voice & Forge Features

Covers the two most recent commits:
- `8435b1c` feat(voice): prompt tuning + WebRTC voice chat
- `a436dfe` feat(forge): Skill & Tool Forge

Testing broken into 5 phases, executed sequentially.

---

## Phase 1: Voice Prompt Tuning (Telegram)

Tests that voice messages get concise, conversational, no-markdown replies.

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 1.1 | Voice → short reply | Send voice note: "What is artificial intelligence?" | Reply is 1-3 sentences, no bullet points, no markdown | [x] |
| 1.2 | Voice → no markdown | Send voice note: "List 5 programming languages" | NO bullet points, headers, bold, code blocks — conversational prose | [x] |
| 1.3 | Voice → TTS reply | Send voice note: any question | Bot replies with BOTH text message AND voice note | [x] |
| 1.4 | Text → normal reply | Send text: "List 5 programming languages" | Normal formatting with markdown/bullets (NOT constrained) | [x] |
| 1.5 | Voice + memory | Send voice: "My favorite color is purple" → later voice: "What's my favorite color?" | Recalls memory, still concise | [x] |
| 1.6 | Voice + Ollama | `/ollama` → send voice note | Concise reply + num_predict limit (noticeably shorter than text) | [x] |
| 1.7 | Voice + Claude | `/claude` → send voice note | Concise reply (prompt-only, no hard token limit) | [x] |
| 1.8 | Voice + skill | `/skill use translator` → send voice in Spanish | Translates concisely, voice reply | [x] |
| 1.9 | Voice toggle + text | `/voice` (enable) → send text message | TTS reply BUT full-length text (not constrained by isVoice) | [x] |
| 1.10 | Voice toggle off | `/voice` (disable) → send voice note | Voice note still gets isVoice=true treatment (flag is per-message, not toggle) | [x] |

---

## Phase 2: Skill Forge (Telegram)

Tests skill upload, fix, lock, export, and edge cases.

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 2.1 | Skill list | `/skill list` | Shows 5 built-in + any user skills | [x] |
| 2.2 | Skill create | `/skill create pirate "Pirate AI" "Speak like a pirate always"` | "Skill created: pirate" | [x] |
| 2.3 | Skill use | `/skill use pirate` → "Tell me about the weather" | Pirate-themed response | [x] |
| 2.4 | Skill fix | `/skill fix pirate` | AI analyzes and suggests/applies improvements | [x] |
| 2.5 | Skill lock | `/skill lock pirate` | "Skill locked" — prevents edits | [x] |
| 2.6 | Skill edit locked | `/skill create pirate "New" "New prompt"` | Error: skill is locked | [x] |
| 2.7 | Skill unlock | `/skill unlock pirate` | "Skill unlocked" | [x] |
| 2.8 | Skill export | `/skill export pirate` | Sends .md file with skill definition | [x] |
| 2.9 | Skill upload | Send a .md file with skill definition, caption `/skill upload` | Parses and creates skill from markdown | [x] |
| 2.10 | Skill delete custom | `/skill delete pirate` | "Skill deleted" | [x] |
| 2.11 | Skill delete builtin | `/skill delete translator` | Error: cannot delete built-in skill | [x] |
| 2.12 | Skill current | `/skill current` | Shows "no skill" or active skill name | [x] |
| 2.13 | Skill off | `/skill use translator` → `/skill off` | Back to default behavior | [x] |

---

## Phase 3: Tool Forge (Telegram)

Tests tool upload, generation, safety scanning, fix, enable/disable.

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 3.1 | Tool list | `/tool list` | Shows builtin tools (11) + any user tools | [ ] |
| 3.2 | Tool show | `/tool show read_bot_logs` | Displays tool description, parameters | [ ] |
| 3.3 | Tool upload | Send .md file with tool definition, caption `/tool upload` | Parses, safety-scans, registers tool | [ ] |
| 3.4 | Tool upload unsafe | Send .md with `exec()` or `eval()` in code | Safety scanner rejects: dangerous patterns | [ ] |
| 3.5 | Tool generate | `/tool generate "A tool that fetches the current Bitcoin price"` | AI generates tool code, safety-scans, registers | [ ] |
| 3.6 | Tool fix | `/tool fix <name>` on a tool with issues | AI analyzes and fixes the tool | [ ] |
| 3.7 | Tool disable | `/tool disable <name>` | Tool removed from available set | [ ] |
| 3.8 | Tool enable | `/tool enable <name>` | Tool restored to available set | [ ] |
| 3.9 | Tool delete | `/tool delete <name>` | User tool deleted | [ ] |
| 3.10 | Tool delete builtin | `/tool delete read_bot_logs` | Error: cannot delete built-in tool | [ ] |
| 3.11 | Tool reload | `/reload` | Reloads user tools from DB | [ ] |
| 3.12 | Tool in action | After uploading a tool, trigger it via Ollama | Tool executes and returns result in conversation | [ ] |

---

## Phase 4: Voice Web Chat (Browser)

Requires `VOICE_WEB_PORT=3030` and `VOICE_WEB_TOKEN` set in `.env`, container port exposed.

### 4.0 Pre-requisites

| # | Step | Expected | Status |
|---|------|----------|--------|
| 4.0a | Add `VOICE_WEB_PORT=3030` and `VOICE_WEB_TOKEN=<token>` to `.env` | Vars set | [ ] |
| 4.0b | Uncomment port in `docker-compose.yml`: `"127.0.0.1:3030:3030"` | Port exposed | [ ] |
| 4.0c | Rebuild: `docker compose up -d --build luna` | Container starts, logs show "Voice web server started" | [ ] |

### 4.1 Connection & Auth

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 4.1a | Page loads | Open `http://localhost:3030` | Auth screen with token input | [ ] |
| 4.1b | Wrong token | Enter wrong token, click Connect | "Invalid token", returns to auth screen | [ ] |
| 4.1c | Correct token | Enter valid token | Main screen appears, status dot green, "Connected" | [ ] |
| 4.1d | Mic permission | On connect | Browser prompts for microphone access | [ ] |

### 4.2 Push to Talk

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 4.2a | Record + send | Hold PTT button, speak, release | Waveform red → purple (thinking) → green (speaking) → ready | [ ] |
| 4.2b | Transcript shown | After response | User message (right) + AI response (left) in transcript area | [ ] |
| 4.2c | Audio playback | After response | AI response plays through speakers | [ ] |
| 4.2d | Response is concise | Ask a complex question via voice | 1-3 sentences, no markdown (isVoice=true) | [ ] |
| 4.2e | Empty audio | Hold and release immediately (no speech) | "(No speech detected)" or graceful handling | [ ] |

### 4.3 Continuous (VAD) Mode

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 4.3a | Switch to VAD | Click "Continuous" button | Button shows "Listening...", VAD controls appear | [ ] |
| 4.3b | Auto-detect speech | Start talking without pressing button | Recording starts automatically (waveform turns red) | [ ] |
| 4.3c | Auto-stop on silence | Stop talking for ~1.2s | Recording stops, processes, plays response | [ ] |
| 4.3d | Sensitivity slider | Adjust slider up/down | Higher = triggers more easily on quiet speech, lower = needs louder | [ ] |
| 4.3e | Switch back to PTT | Click "Push to Talk" | Returns to hold-to-talk behavior | [ ] |

### 4.4 Resilience

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 4.4a | Reconnection | Restart the container while connected | "Reconnecting..." → auto-reconnects when container is back | [ ] |
| 4.4b | Tab hidden + VAD | Switch to VAD mode → switch to another tab → return | VAD pauses when hidden, resumes on return | [ ] |
| 4.4c | Multiple messages | Send 3 voice messages in rapid succession | Responses arrive in order (queue serialization) | [ ] |

---

## Phase 5: Cross-Feature Integration

Tests that combine voice, forge, and existing features.

| # | Test | Steps | Expected | Status |
|---|------|-------|----------|--------|
| 5.1 | Voice + custom skill | `/skill use pirate` → send voice note | Pirate-style concise voice reply | [ ] |
| 5.2 | Voice + custom tool | Upload a tool → trigger it via voice on Ollama | Tool executes, concise voice reply | [ ] |
| 5.3 | Voice + file | Send a PDF → send voice: "summarize what I just uploaded" | Concise voice summary of the file | [ ] |
| 5.4 | Forge + provider switch | `/ollama` → `/tool list` | User tools available on Ollama | [ ] |
| 5.5 | Skill export → upload roundtrip | `/skill export translator` → download .md → re-upload as `/skill upload` | Roundtrip preserves skill definition (duplicate name error expected) | [ ] |
| 5.6 | Web voice memory | Voice chat in browser: "Remember that I prefer dark mode" → later: "What UI preference did I mention?" | Memory persists across voice-web requests | [ ] |

---

## Execution Order

1. **Phase 1** first — validates voice prompt tuning works before testing web chat
2. **Phase 2** — skill forge (simpler, foundational for Phase 5)
3. **Phase 3** — tool forge (depends on Ollama for execution tests)
4. **Phase 4** — web voice chat (requires .env + docker-compose changes)
5. **Phase 5** — cross-feature (depends on all previous phases passing)

## Pass Criteria

- All Phase 1-3 tests pass on Telegram
- Phase 4 tests pass in browser (Chrome/Safari)
- Phase 5 cross-feature tests pass
- Zero crashes or unhandled errors in `docker logs luna-bot`
