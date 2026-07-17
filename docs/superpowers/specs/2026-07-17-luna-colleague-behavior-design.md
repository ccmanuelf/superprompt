# Luna Colleague-Behavior Tuning — Design Spec

**Date:** 2026-07-17
**Status:** Draft for review (Manuel)
**Trigger:** Review of 4 SAM conversations (2026-07-15..17) surfaced systemic
over-clarification friction. Root causes traced across the prompt architecture
(memory `luna-virtual-colleague-behavior`). Goal: make Luna behave like the
competent Jr IE colleague she's meant to be — execute clear instructions,
don't re-ask, proceed-then-flag — **without** losing the honesty / anti-
fabrication / governed-write discipline that took three SAM releases to earn.

## The standard (what "good colleague" means, made testable)

A good junior engineer, encoded as behavior:
1. **Executes a clear instruction** when the required inputs are present — does
   not open an investigation phase or a confirmation gate first.
2. **Never re-asks for information already given** in the thread.
3. **Trusts a fresh explicit instruction over retrieved memory.** A named
   client/product not being in the system yet is *expected* for new work, not a
   blocker — create it.
4. **Leads with the result, matches the user's register.** A one-line
   instruction gets a short execution + result, not a multi-section table. One
   caveat line, not a caveats section.
5. **Asks only when genuinely blocked** — a required field with no reasonable
   default, or a destructive/irreversible/credit-spending action. Otherwise:
   proceed, then flag any discrepancy after.
6. **Keeps the rigor:** never fabricates a number, flags real problems honestly,
   states uncertainty explicitly.

Reliable lever = adapt to the **message's register**, not the user's job title
(the bot may be shared; role isn't in the message). Per-role behavior would need
an explicit `/role` signal — out of scope here, named for later.

## Cross-path PARITY CHECKLIST (the core of this spec)

Luna answers on two paths: **Claude** (`composeClaudeSystemPrompt`, router.ts) and
**Ollama/local** (`buildLocalSystemPrompt`, local-prompt.ts). Every behavioral
change below MUST land on both, or behavior flips when Claude is unavailable /
`/sam local` / `/auto` local / `NOVALINK_PIN_LOCAL` on. Each row names the
Claude-path location AND the Ollama-path location; a change is not "done" until
both cells are ticked and the verification exercises both.

| # | Behavior change | Claude-path location | Ollama-path location | Shared? |
|---|---|---|---|---|
| A | **Debugger skill** stops hijacking ops language; even when active, favors action | `skills.ts` `SKILL_TRIGGERS` + `builtin-debugger.systemPrompt` (injected via `skillPrompt`) | **same file** — `skillPrompt` injects on both | ✅ ONE edit covers both |
| B | **Execution posture** (execute clear instr., no re-ask, fresh-instr > memory, brevity) | `capabilities.ts` base persona (adds it — currently missing) | `local-prompt.ts` `LOCAL_RULES` (has "be concise"; extend to match) | ⚠️ mirror — edit both, keep wording identical |
| C | **SAM write gate** relaxed for create/set-status/update; kept for generate + governed library writes | `sam-prompt.ts` "Write confirmation rule" + "Library governance" | SA4 `requiresConfirmation` flags on `sam_*` tools in `providers/tools/index.ts` | ⚠️ two mechanisms — relax both consistently |

## Changes in detail

### A — Debugger skill (`src/skills.ts`) — highest leverage, both paths

The `builtin-debugger` skill (`mode:'auto'`, TTL 3 turns, clears on `/newchat`)
auto-triggers on `error/bug/broken/not working/fails/"why doesn't X work"/
"fix … issue"` and injects "PHASE 1 — INVESTIGATE … ask clarifying questions …
do NOT jump to solutions." For a *manufacturing-ops* assistant, that language is
everyday shop-floor reality ("the line isn't working", "fix the shortage",
"the BOM fails to load"), not a request to debug Luna's software. It fires on
BOTH paths and stalls the 4B model harder than Claude.

Two-part change:
1. **Tighten the auto-trigger** so it requires a **software/system-technical
   anchor** (code/script/config/server/database/api/deploy/container/log/the bot
   itself), not bare ops problem-language. A data discrepancy ("inventory isn't
   showing right") should route to the data tools (bridge/inventory) that present
   the real numbers — not into a debugging interview. Keep the explicit
   `debug/troubleshoot` trigger. **Make the trigger BILINGUAL (EN+ES) as part of
   this change** — the current patterns are English-only, so today genuine
   Spanish software-debugging ("¿por qué la API se cae cada vez?",
   "depura este script") triggers nothing while English over-fires. Add ES
   patterns with the SAME technical-anchor requirement
   (api/servidor/base de datos/script/contenedor/registro/despliegue/depurar/
   depuración) so ordinary ES ops language ("la línea no funciona", "arregla el
   faltante", "el inventario no cuadra") does NOT fire, but real ES software
   issues do. This closes an existing EN/ES inconsistency in both directions.
2. **Soften the skill body** so even a legitimate trigger favors action: add a
   line — *"If the user's message is actually a task or a data lookup, do it
   first and investigate only what actually fails; do not preface execution with
   an investigation phase or clarifying questions the user already answered."*
   Keep the rest (check logs, reproduce, hypotheses, verify-before-claiming) — it
   is genuinely good for a real bug.

Do NOT gut the skill — real software debugging still benefits. This narrows
*when* it fires and stops it blocking execution when it does.

### B — Execution posture (`capabilities.ts` + `local-prompt.ts`) — mirrored

Add the same short block to the base persona on both paths. `local-prompt.ts`
`LOCAL_RULES` already has *"Be concise. Lead with the answer. No filler, no
repeated caveats."* — extend it; add the equivalent to `capabilities.ts` (which
lacks it). Identical wording both places:

> **Execution posture.** Execute a clear instruction directly — don't re-ask for
> anything already provided in this thread, and don't open an investigation or
> confirmation phase first. A fresh explicit instruction outranks your memory or
> a prior lookup; a client/product not yet in the system is expected for new work
> — create it. Lead with the result and match the user's brevity. Ask a
> clarifying question only when genuinely blocked (a required field with no
> sensible default, or a destructive/irreversible action); otherwise proceed and
> flag any discrepancy afterward. Never invent a number.

### C — SAM write gate (`sam-prompt.ts` + SA4 policy) — consistent both paths

Current state over-gates ordinary creates. New posture:

| Operation | Before | After (both paths) |
|---|---|---|
| `sam_create` (client/product/analysis) | confirm first | **execute** — creating/storing IS the point |
| `sam_set_status` | confirm first | **execute** — reversible status change |
| `sam update` / `scenario-save` / `cell-create/update` (Claude `sam api`) | confirm first | **execute** |
| `sam_generate` / `generate-mm` | confirm first | **one confirmation kept** — slow, costs SAM-server credits, always persists |
| approve/merge/reject candidates, `PUT /library`, `PUT /machine-costs` (Claude `sam api` only) | per-item confirm | **per-item confirm KEPT** (governed) |

- **`sam-prompt.ts`:** rewrite the "Write confirmation rule" — remove
  create/set-status/update/scenario-save/cell-create/update from the mandatory
  list; keep `generate`/`generate-mm` (one heads-up: "creating now, it costs
  credits and will be stored") and keep the "Library governance (presents, user
  decides)" block verbatim.
- **SA4 (`providers/tools/index.ts`):** flip `sam_create`
  (index.ts:240) and `sam_set_status` (index.ts:257) `requiresConfirmation:
  true → false`. **Keep `sam_generate` (index.ts:248) `true`** — that's the
  local-path equivalent of the generate heads-up, so both paths confirm once
  before a credit-costing persist.

Rationale: the goal of the SAM system is to *collect and manage* analyses for
easy storage/retrieval and iteration — storing a draft is the happy path, not a
risk. The genuinely-governed action (writing a rate into the shared library that
prices every future quote) keeps its confirmation. The one credit-spending
action (generate) keeps a single heads-up.

## What must NOT change (guardrails to preserve)

- Anti-fabrication: SAM turns stay Claude-pinned with abort-over-fabricate; the
  unpinned-local UNVERIFIED banner stays.
- Honesty: post-completion discrepancy flags, error-ownership, "state
  uncertainty explicitly."
- Governed library writes keep per-item confirmation.
- `critical`-risk tools (`run_command`, github commit/PR, etc.) keep
  `requiresConfirmation: true` — untouched by this spec.
- The debugger skill's real-debugging value (logs/reproduce/hypotheses/verify).

## Verification (must exercise BOTH paths)

1. **Unit:** debugger `SKILL_TRIGGERS` regex — **EN + ES adversarial sets**.
   Must NOT trigger (ops language, both languages): "the line isn't working",
   "fix the shortage on line 3", "inventory isn't updating", "the BOM fails to
   load", "la línea no funciona", "arregla el faltante de la línea 3", "el
   inventario no cuadra", "el BOM no carga bien". MUST trigger (real software,
   both languages): "the API returns 500 every time", "debug this script", "why
   does the container keep crashing", "¿por qué la API se cae cada vez?", "depura
   este script", "el servidor se reinicia solo". SA4 policy test:
   `sam_create`/`sam_set_status` `requiresConfirmation:false`, `sam_generate`
   `true`. Prompt-content assertions for the execution-posture block on both
   `capabilities.ts` and `local-prompt.ts`; freeze-snapshot regen scoped to the
   changed blocks.
2. **Gates:** tsc, lint 0, full vitest, build+smoke, docker build. rc bump.
3. **Live smoke — CLAUDE path** (Telegram, default): replay the analysis-23
   shape — give client+product+file in one message → Luna creates + runs +
   returns result with caveats, **zero re-asks**; a library-write request still
   stops for confirmation.
4. **Live smoke — OLLAMA path** (`/sam local`, or default flipped): same terse
   instruction → same execute-then-flag behavior, no investigation-phase
   preamble, no re-asking. This is the row that proves parity.
5. **Live smoke — SPANISH** (either path): run one exchange entirely in Spanish
   (terse instruction with client/product/file) → Luna executes + returns the
   result in Spanish with caveats, no re-asking. Confirms B/C govern behavior in
   ES and the debugger tightening didn't break ES.

**Bilingual note:** B (persona posture) and C (SAM write gate) are
language-agnostic — English prompt instructions that govern responses in any
language (persona: "respond in the language of the user's current message; tools
work identically in ALL languages"), plus C's SA4 half is language-neutral code.
A (debugger trigger) is the only language-sensitive change and is explicitly made
bilingual above.

## Out of scope
- Per-role (`/role`) behavior — needs an explicit signal; named for later.
- KPI-operations pack (pending server deploy) — inherits A & B automatically once
  it ships; no extra work here.
- Rewriting the debugger skill's core method (kept intact).
