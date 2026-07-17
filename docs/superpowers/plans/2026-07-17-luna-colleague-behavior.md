# Luna Colleague-Behavior Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Luna behave like a competent Jr IE colleague — execute clear instructions, never re-ask answered questions, proceed-then-flag — without losing the honesty / anti-fabrication / governed-write discipline. Three changes, each landing on BOTH provider paths: (A) the debugger skill stops hijacking ops language and becomes bilingual EN/ES; (B) an execution-posture block enters the base persona of both paths with byte-identical wording; (C) the SAM write gate relaxes for ordinary creates/updates/status changes on both mechanisms (prompt rule + SA4 flags), keeping the generate heads-up and governed library writes.

**Architecture:** A is ONE edit in `src/skills.ts` — `SKILL_TRIGGERS` patterns + the `builtin-debugger` systemPrompt are injected via `getSkillSystemPrompt` → `skillPrompt` into BOTH `composeClaudeSystemPrompt` and `buildLocalSystemPrompt` (router.ts:1561-1565). A also needs a builtin-prompt DB sync in `initBuiltinSkills` (audit finding: `createSkillIfNotExists` is `onConflict('id').ignore()` — a shipped prompt edit would otherwise NEVER reach the prod DB seeded by an older build). B is single-sourced in a new zero-import module `src/execution-posture.ts`, interpolated into `CAPABILITIES_PROMPT` (Claude path) and `LOCAL_RULES` (Ollama path) — one constant makes wording drift impossible and dodges the router↔local-prompt import cycle. C edits the "Write confirmation rule" block in `src/providers/sam-prompt.ts` (Claude path; changes the claude-prompt-freeze snapshot) and flips two `requiresConfirmation` flags in `src/providers/tools/index.ts` (Ollama/SA4 path).

**Tech Stack:** TypeScript ES2022 / NodeNext ESM, vitest (snapshot regen with `-u`, scoped-diff verification), grammy/Telegram for live smoke.

**Spec:** `docs/superpowers/specs/2026-07-17-luna-colleague-behavior-design.md` (approved; source of truth).

## Global Constraints

**Cross-path PARITY rule (verbatim from the spec — binding):**

> Luna answers on two paths: **Claude** (`composeClaudeSystemPrompt`, router.ts) and **Ollama/local** (`buildLocalSystemPrompt`, local-prompt.ts). Every behavioral change below MUST land on both, or behavior flips when Claude is unavailable / `/sam local` / `/auto` local / `NOVALINK_PIN_LOCAL` on. Each row names the Claude-path location AND the Ollama-path location; a change is not "done" until both cells are ticked and the verification exercises both.

| # | Behavior change | Claude-path location | Ollama-path location | Shared? |
|---|---|---|---|---|
| A | **Debugger skill** stops hijacking ops language; even when active, favors action | `skills.ts` `SKILL_TRIGGERS` + `builtin-debugger.systemPrompt` (injected via `skillPrompt`) | **same file** — `skillPrompt` injects on both | ✅ ONE edit covers both (Tasks 1–2) |
| B | **Execution posture** (execute clear instr., no re-ask, fresh-instr > memory, brevity) | `capabilities.ts` base persona (adds it — currently missing) | `local-prompt.ts` `LOCAL_RULES` (has "be concise"; extend to match) | ⚠️ mirror — implemented as ONE shared constant (Task 3) |
| C | **SAM write gate** relaxed for create/set-status/update; kept for generate + governed library writes | `sam-prompt.ts` "Write confirmation rule" + "Library governance" | SA4 `requiresConfirmation` flags on `sam_*` tools in `providers/tools/index.ts` | ⚠️ two mechanisms — relax both consistently (Tasks 4–5) |

**Bilingual rule (verbatim from the spec — binding):**

> B (persona posture) and C (SAM write gate) are language-agnostic — English prompt instructions that govern responses in any language (persona: "respond in the language of the user's current message; tools work identically in ALL languages"), plus C's SA4 half is language-neutral code. A (debugger trigger) is the only language-sensitive change and is explicitly made bilingual above.

**What must NOT change (spec guardrails):** anti-fabrication (SAM Claude pin + abort-over-fabricate + UNVERIFIED banner), honesty rules, governed library writes keep per-item confirmation, `critical`-risk tools (`run_command`, github commit/PR) keep `requiresConfirmation: true`, and the debugger skill's real-debugging method (logs / reproduce / hypotheses / verify) stays intact.

**Binding values — every task must use these EXACTLY:**

- Execution-posture text (spec §B, verbatim — the single-source constant):
  `**Execution posture.** Execute a clear instruction directly — don't re-ask for anything already provided in this thread, and don't open an investigation or confirmation phase first. A fresh explicit instruction outranks your memory or a prior lookup; a client/product not yet in the system is expected for new work — create it. Lead with the result and match the user's brevity. Ask a clarifying question only when genuinely blocked (a required field with no sensible default, or a destructive/irreversible action); otherwise proceed and flag any discrepancy afterward. Never invent a number.`
- Debugger task-first line (spec §A.2, verbatim inside the skill body):
  `TASK-FIRST OVERRIDE: If the user's message is actually a task or a data lookup, do it first and investigate only what actually fails; do not preface execution with an investigation phase or clarifying questions the user already answered.`
- SA4 flips: `sam_create` → `requiresConfirmation: false` (index.ts:240), `sam_set_status` → `false` (index.ts:257), `sam_generate` STAYS `true` (index.ts:248). There is NO internal `sam_update` tool (update is Claude-path `sam` wrapper only).
- Snapshot discipline: every `vitest -u` run is followed by `git diff` on the `.snap` file; the diff must be scoped ONLY to the block the task changes. If it touches anything else → STOP, revert, report.
- ESM only; imports end in `.js`. `npx tsc --noEmit` clean; `npm run lint` 0 errors, no NEW `no-explicit-any` warnings.
- Git: stage explicit paths only (never `git add -A`); conventional commits; never `--no-verify`.
- Branch: `feat/luna-colleague-behavior` off `main`. Version bump at the end: `1.0.0-rc.139` → `1.0.0-rc.140`.
- The PR is NOT auto-merged (explicit override of the auto-merge-on-green default for this ship): a review pass runs first, then the operator live smoke (Task 7) after merge+deploy.

**Resolved ambiguities (documented judgment calls — verified against the working tree, rc.139):**

1. **B is single-sourced, not literally mirrored.** The spec says "mirror — edit both, keep wording identical". A shared `EXECUTION_POSTURE` constant interpolated into both prompt strings satisfies "identical wording" structurally (drift becomes impossible). It lives in a NEW zero-import module `src/execution-posture.ts` because putting it in `capabilities.ts` and importing that from `local-prompt.ts` risks a TDZ failure through the existing `router.ts ↔ local-prompt.ts` import cycle.
2. **Builtin prompt DB sync (Task 2) is added scope.** `createSkillIfNotExists` uses `onConflict('id').ignore()` (db-core.ts:788), and the debugger prompt is read from the DB row (`getSkillSystemPrompt` → `skill.system_prompt`), so without a sync the Task 2 prompt edit would never reach an existing deployment — the change would silently not land on EITHER path in prod. Sync skips skills the user has revised via the AI fixer (`skill_revisions` rows — user feedback outranks the shipped default).
3. **The blanket "ANY mutating `sam api` (POST/PUT/PATCH)" confirm is narrowed** to the governed endpoints (candidate approve/merge/reject, `PUT /library/{table}`, `PUT /machine-costs`) plus `sam cell-erv` with `"apply": true`. Rationale: the spec's After-table frees `sam update`/`cell-update` (which ARE PATCH calls), so a blanket PATCH confirm would contradict it; anything the spec does not name keeps its prior gate (cell-erv apply), and governed writes are exactly the Library-governance list.
4. **`[45]\d\d` (HTTP status) joins the EN problem tokens** — the spec's MUST-trigger case "the API returns 500 every time" matches no problem word in the old vocabulary; without this it fails on both the old and new sets.
5. **The two ordered problem↔temporal EN patterns collapse into one order-free lookahead pattern** (anchor + problem + temporal, each anywhere in the message). Strictly broader on ordering but strictly narrower overall because the software anchor is now required. All pre-existing test cases still pass (probed — see Task 1 Step 1).
6. **"app" and "bot" join the EN anchor list** beyond the spec's examples — existing regression tests ("The app crashes every time I click submit", "My bot stopped working…") are genuine software reports and must keep firing. The spec's anchor list is explicitly exemplary ("code/script/config/server/database/api/deploy/container/log/the bot itself").

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
git checkout main && git pull && git checkout -b feat/luna-colleague-behavior
```

---

### Task 1: Change A1 — debugger auto-trigger: software anchor + bilingual EN/ES (TDD, probe-first)

**Files:**
- Modify: `src/skills.ts:45-61` (the `SKILL_TRIGGERS` debugger entry; add two anchor consts directly above `SKILL_TRIGGERS`)
- Create: `tests/skills-debugger-trigger.test.ts`

**Interfaces:**
- Consumes: `SKILL_TRIGGERS` / `SkillTrigger` (already exported from `src/skills.ts` for testing).
- The trigger evaluation loop (`detectSkillTrigger`, skills.ts:822-884) is untouched — it iterates `trigger.patterns` with `.test(message)`, so patterns must each be independently sufficient (they are OR'd). No `g` flags (shared RegExp objects; sticky `lastIndex` would corrupt `.test()`).
- `tests/skill-auto-trigger.test.ts` (existing debugger cases, lines 128-167 + 331-337) must keep passing UNCHANGED — every existing must-fire case carries a software anchor (server/app/config/api/docker/bot/database) and was verified against the new set in the probe below.

- [ ] **Step 1: Probe the regex set standalone BEFORE writing the test**

Run this exact probe (node -e via a scratch file). It encodes the spec §Verification adversarial sets (EN+ES, both directions), every existing `skill-auto-trigger.test.ts` debugger case, and extra ops traps. Expected output: `ALL OK`. If ANY case fails, adjust the pattern minimally, re-probe, and record the deviation in the test file's header comment.

```bash
cat > /tmp/debugger-probe.mjs <<'EOF'
const EN = String.raw`(code|scripts?|configs?|configuration|servers?|databases?|db|api|endpoints?|deploy(ment|s|ing|ed)?|containers?|docker|logs?|apps?|bots?|luna|web ?ui|website)`;
const ES = String.raw`(c[oó]digo|scripts?|api|servidor(es)?|bases? de datos|endpoints?|despliegues?|contenedor(es)?|docker|registros?|logs?|aplicaci[oó]n|aplicaciones|bots?|luna|p[aá]gina web|sitio web)`;
const patterns = [
  /\b(debug(ging|s|ged)?|troubleshoot(ing|s)?|depura(r|ndo|me|lo|la)?|depuraci[oó]n)\b/i,
  new RegExp(String.raw`^(?=[\s\S]*\b${EN}\b)(?=[\s\S]*\b(errors?|bugs?|crash(es|ed|ing)?|broken|not working|isn'?t working|fails?|failing|exceptions?|stack\s*trace|[45]\d\d|timed? ?out|timeouts?)\b)(?=[\s\S]*\b(when|after|every\s*time|keeps?|always)\b)`, 'i'),
  new RegExp(String.raw`^(?=[\s\S]*\b${EN}\b)[\s\S]*\bwhy\s+(does|is|did|doesn'?t|won'?t|can'?t)\b[\s\S]*\b(work(ing)?|function|respond|connect|load|run|start|crash(es|ing)?)\b`, 'i'),
  new RegExp(String.raw`^(?=[\s\S]*\b${EN}\b)[\s\S]*\b(stopped|quit|ceased)\s+working\b`, 'i'),
  new RegExp(String.raw`\bfix(ing|es)?\b[\s\S]*\b${EN}\b`, 'i'),
  new RegExp(String.raw`^(?=[\s\S]*\b${ES}\b)(?=[\s\S]*\b(se cae|se ca[ií]a|se cay[oó]|se reinicia|se congela|se traba|truena|no responde|no arranca|no inicia|no carga|no funciona|dej[oó] de funcionar|deja de funcionar|se detiene)\b)`, 'i'),
  new RegExp(String.raw`^(?=[\s\S]*\b${ES}\b)(?=[\s\S]*\b(error(es)?|falla(s|r)?|excepci[oó]n|excepciones|bugs?)\b)(?=[\s\S]*\b(cuando|despu[eé]s de|cada vez|cada que|siempre)\b)`, 'i'),
  new RegExp(String.raw`\b(arregla(r|me|lo|la)?|repara(r|me|lo|la)?|corrige|corr[ií]ge(me|lo|la)?)\b[\s\S]*\b${ES}\b`, 'i'),
];
const fire = (m) => patterns.some((p) => p.test(m));
const mustNot = [
  "the line isn't working", "fix the shortage on line 3", "inventory isn't updating", "the BOM fails to load",
  "la línea no funciona", "arregla el faltante de la línea 3", "el inventario no cuadra", "el BOM no carga bien",
  "What is an error?", "Define the word error", "What is the weather today?", "Tell me a joke", "I love programming",
  "the machine keeps jamming every shift", "arregla la máquina de coser de la estación 4",
  "we produce 500 units every time the shift changes",
  "the line is broken, it keeps stopping",
  "production keeps failing every shift",
  "why doesn't the packing line work?",
];
const must = [
  "the API returns 500 every time", "debug this script", "why does the container keep crashing",
  "¿por qué la API se cae cada vez?", "depura este script", "el servidor se reinicia solo",
  "Can you help me debug this function?", "I need to troubleshoot my network connection",
  "I get an error when I try to run the server", "The app crashes every time I click submit",
  "This bug keeps happening after I update the config", "Why does the API not respond?",
  "Why won't my Docker container start?", "My bot stopped working after the last update",
  "Can you fix this error in the database query?", "I need to fix the API endpoint",
  "The server keeps crashing every time I deploy, I get a connection error",
  "el bot de telegram no responde", "la aplicación truena cuando subo un archivo",
];
let bad = 0;
for (const m of mustNot) if (fire(m)) { console.log('FALSE-POS:', m); bad++; }
for (const m of must) if (!fire(m)) { console.log('MISS:', m); bad++; }
console.log(bad === 0 ? 'ALL OK' : `${bad} failures`);
EOF
node /tmp/debugger-probe.mjs
```

(This exact set was pre-probed while writing this plan: `ALL OK`, 36/36. Three of the must-NOT cases — "the line is broken, it keeps stopping", "production keeps failing every shift", "why doesn't the packing line work?" — DO fire under the current rc.139 patterns; they are the over-fire the spec exists to kill and will make the Step 2 test run fail meaningfully.)

- [ ] **Step 2: Write the failing tests**

Create `tests/skills-debugger-trigger.test.ts`:

```typescript
/**
 * Debugger auto-trigger tightening (spec 2026-07-17 §A) — the trigger now
 * requires a SOFTWARE/SYSTEM ANCHOR (code/script/config/server/database/api/
 * deploy/container/log/app/bot/luna…) so everyday manufacturing-ops problem
 * language never flips Luna into a debugging interview, and it is BILINGUAL
 * (EN+ES) with the same anchor requirement in both languages.
 *
 * The skillPrompt this trigger activates is injected on BOTH provider paths
 * (composeClaudeSystemPrompt AND buildLocalSystemPrompt), so this one file
 * covers the parity checklist's row A for the trigger half.
 *
 * Deviations from the spec's example lists (probed 2026-07-17, all green):
 * - `[45]\d\d` joins the EN problem tokens (spec MUST-case "the API returns
 *   500 every time" matches no other problem word).
 * - "app"/"bot"/"website" join the EN anchors (pre-existing regression cases
 *   are genuine software reports).
 * - The two ordered problem↔temporal patterns are now ONE order-free
 *   lookahead pattern; the anchor requirement makes it net-narrower.
 */
import { describe, it, expect } from 'vitest';
import { SKILL_TRIGGERS, type SkillTrigger } from '../src/skills.js';

const trigger = SKILL_TRIGGERS.find((t) => t.skillName === 'debugger') as SkillTrigger;
const fires = (message: string): boolean => trigger.patterns.some((p) => p.test(message));

describe('debugger trigger — spec 2026-07-17 §A adversarial sets', () => {
  it('exists and stays auto-mode', () => {
    expect(trigger).toBeDefined();
    expect(trigger.mode).toBe('auto');
  });

  it('has no /g flags (shared RegExp objects — sticky lastIndex would corrupt .test())', () => {
    for (const p of trigger.patterns) expect(p.global).toBe(false);
  });

  it('must NOT fire on EN ops problem-language (no software anchor)', () => {
    const cases = [
      "the line isn't working",
      'fix the shortage on line 3',
      "inventory isn't updating",
      'the BOM fails to load',
      'the line is broken, it keeps stopping',
      'production keeps failing every shift',
      "why doesn't the packing line work?",
      'the machine keeps jamming every shift',
      'we produce 500 units every time the shift changes',
    ];
    for (const m of cases) expect(fires(m), `should NOT fire: ${m}`).toBe(false);
  });

  it('must NOT fire on ES ops problem-language (no software anchor)', () => {
    const cases = [
      'la línea no funciona',
      'arregla el faltante de la línea 3',
      'el inventario no cuadra',
      'el BOM no carga bien',
      'arregla la máquina de coser de la estación 4',
    ];
    for (const m of cases) expect(fires(m), `should NOT fire: ${m}`).toBe(false);
  });

  it('MUST fire on real EN software problems', () => {
    const cases = [
      'the API returns 500 every time',
      'debug this script',
      'why does the container keep crashing',
      'I get an error when I try to run the server',
      'The app crashes every time I click submit',
      'This bug keeps happening after I update the config',
      'Why does the API not respond?',
      "Why won't my Docker container start?",
      'My bot stopped working after the last update',
      'Can you fix this error in the database query?',
      'I need to fix the API endpoint',
    ];
    for (const m of cases) expect(fires(m), `should fire: ${m}`).toBe(true);
  });

  it('MUST fire on real ES software problems (same anchor requirement)', () => {
    const cases = [
      '¿por qué la API se cae cada vez?',
      'depura este script',
      'el servidor se reinicia solo',
      'el bot de telegram no responde',
      'la aplicación truena cuando subo un archivo',
    ];
    for (const m of cases) expect(fires(m), `should fire: ${m}`).toBe(true);
  });

  it('keeps firing on explicit debug/troubleshoot verbs without an anchor', () => {
    expect(fires('Can you help me debug this function?')).toBe(true);
    expect(fires('I need to troubleshoot my network connection')).toBe(true);
  });

  it('knowledge questions never fire', () => {
    expect(fires('What is an error?')).toBe(false);
    expect(fires('Define the word error')).toBe(false);
    expect(fires('¿qué es un stack trace?')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/skills-debugger-trigger.test.ts`
Expected: FAIL — the three current-over-fire EN cases fire (`should NOT fire: the line is broken…`, `production keeps failing…`, `why doesn't the packing line work?`), and the ES MUST cases + "the API returns 500 every time" miss.

- [ ] **Step 4: Write the implementation**

In `src/skills.ts`, directly ABOVE the `export const SKILL_TRIGGERS` declaration (line 45), add:

```typescript
// ── Debugger trigger anchors (spec 2026-07-17 §A) ───────────
// The debugger auto-trigger requires a SOFTWARE/SYSTEM anchor: for a
// manufacturing-ops assistant, "the line isn't working" / "arregla el
// faltante" is everyday shop-floor language, not a request to debug
// software. Data discrepancies route to the data tools (bridge/inventory),
// not into a debugging interview. EN/ES lists are separate so each pattern
// stays readable; both carry the same anchor requirement (bilingual by
// design — the old set was EN-only, so genuine Spanish software problems
// triggered nothing while English over-fired).
const DEBUG_ANCHOR_EN = String.raw`(code|scripts?|configs?|configuration|servers?|databases?|db|api|endpoints?|deploy(ment|s|ing|ed)?|containers?|docker|logs?|apps?|bots?|luna|web ?ui|website)`;
const DEBUG_ANCHOR_ES = String.raw`(c[oó]digo|scripts?|api|servidor(es)?|bases? de datos|endpoints?|despliegues?|contenedor(es)?|docker|registros?|logs?|aplicaci[oó]n|aplicaciones|bots?|luna|p[aá]gina web|sitio web)`;
```

Then REPLACE the debugger entry's `patterns` array (currently lines 49-60, from `// Explicit debugging language` through the `\bfix\b` pattern inclusive) with:

```typescript
    patterns: [
      // Explicit debugging verbs (EN + ES) — the verb IS the anchor
      /\b(debug(ging|s|ged)?|troubleshoot(ing|s)?|depura(r|ndo|me|lo|la)?|depuraci[oó]n)\b/i,
      // EN: problem word + temporal marker + software anchor (each anywhere
      // in the message — the ^ + lookaheads make the test order-free).
      // [45]\d\d covers HTTP-status reports ("the API returns 500 every time").
      new RegExp(String.raw`^(?=[\s\S]*\b${DEBUG_ANCHOR_EN}\b)(?=[\s\S]*\b(errors?|bugs?|crash(es|ed|ing)?|broken|not working|isn'?t working|fails?|failing|exceptions?|stack\s*trace|[45]\d\d|timed? ?out|timeouts?)\b)(?=[\s\S]*\b(when|after|every\s*time|keeps?|always)\b)`, 'i'),
      // EN: "why doesn't X work" — anchored
      new RegExp(String.raw`^(?=[\s\S]*\b${DEBUG_ANCHOR_EN}\b)[\s\S]*\bwhy\s+(does|is|did|doesn'?t|won'?t|can'?t)\b[\s\S]*\b(work(ing)?|function|respond|connect|load|run|start|crash(es|ing)?)\b`, 'i'),
      // EN: "stopped working" — anchored
      new RegExp(String.raw`^(?=[\s\S]*\b${DEBUG_ANCHOR_EN}\b)[\s\S]*\b(stopped|quit|ceased)\s+working\b`, 'i'),
      // EN: "fix <software thing>" — the fix TARGET must itself be technical
      new RegExp(String.raw`\bfix(ing|es)?\b[\s\S]*\b${DEBUG_ANCHOR_EN}\b`, 'i'),
      // ES: incident verb + anchor (order-free)
      new RegExp(String.raw`^(?=[\s\S]*\b${DEBUG_ANCHOR_ES}\b)(?=[\s\S]*\b(se cae|se ca[ií]a|se cay[oó]|se reinicia|se congela|se traba|truena|no responde|no arranca|no inicia|no carga|no funciona|dej[oó] de funcionar|deja de funcionar|se detiene)\b)`, 'i'),
      // ES: error noun + temporal marker + anchor
      new RegExp(String.raw`^(?=[\s\S]*\b${DEBUG_ANCHOR_ES}\b)(?=[\s\S]*\b(error(es)?|falla(s|r)?|excepci[oó]n|excepciones|bugs?)\b)(?=[\s\S]*\b(cuando|despu[eé]s de|cada vez|cada que|siempre)\b)`, 'i'),
      // ES: "arregla/repara/corrige <software thing>"
      new RegExp(String.raw`\b(arregla(r|me|lo|la)?|repara(r|me|lo|la)?|corrige|corr[ií]ge(me|lo|la)?)\b[\s\S]*\b${DEBUG_ANCHOR_ES}\b`, 'i'),
    ],
```

- [ ] **Step 5: Run tests to verify they pass (including the untouched regression suite)**

Run: `npx vitest run tests/skills-debugger-trigger.test.ts tests/skill-auto-trigger.test.ts tests/skills.test.ts && npx tsc --noEmit`
Expected: PASS / clean. `tests/skill-auto-trigger.test.ts` needs ZERO edits — if any of its debugger cases fail, the pattern change is wrong (every existing case was probed green); fix the pattern, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/skills.ts tests/skills-debugger-trigger.test.ts
git commit -m "fix(skills): debugger auto-trigger requires software anchor + bilingual EN/ES patterns"
```

---

### Task 2: Change A2 — debugger task-first override + builtin prompt DB sync (TDD)

**Files:**
- Modify: `src/skills.ts` (builtin-debugger `systemPrompt`, ~line 219; `initBuiltinSkills`, ~line 739; extend the db-core import block at lines 1-11)
- Create: `tests/skills-builtin-sync.test.ts`

**Interfaces:**
- Consumes: `getSkill`, `getSkillRevisions`, `updateSkill` from `src/db-core.js` (all exist: db-core.ts:792, 890, 804; `updateSkill(id, { description?, systemPrompt? })`).
- `tests/sprint-s2-prompt-intelligence.test.ts:208` asserts the skills.ts SOURCE contains `'PHASE 1 — INVESTIGATE'` — the edit below keeps that heading intact (it only prepends a line). Do not touch the PHASE structure.
- Why the sync is in scope: `createSkillIfNotExists` is insert-or-IGNORE, and `getSkillSystemPrompt` reads `skill.system_prompt` from the DB — on the deployed box the debugger row was seeded long ago, so without a sync this task's prompt edit never reaches production on EITHER path (a parity-checklist violation in deployment, not just in code).

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-builtin-sync.test.ts`:

```typescript
/**
 * initBuiltinSkills builtin-prompt sync (spec 2026-07-17 §A).
 *
 * createSkillIfNotExists uses onConflict('id').ignore() — a shipped edit to a
 * BUILTIN_SKILLS systemPrompt would never reach a DB seeded by an older
 * build, and getSkillSystemPrompt serves the STORED prompt to BOTH provider
 * paths. The sync pass updates builtin rows whose stored prompt differs from
 * code, UNLESS the skill has skill_revisions rows (user revised it via the
 * AI fixer — user feedback outranks the shipped default).
 *
 * Also pins the spec §A.2 task-first override line in the debugger body.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { initBuiltinSkills, BUILTIN_SKILLS } from '../src/skills.js';
import { coreTableInit, getSkill, insertSkillRevision } from '../src/db-core.js';

const DEBUGGER = BUILTIN_SKILLS.find((s) => s.id === 'builtin-debugger')!;

describe('debugger systemPrompt content (spec 2026-07-17 §A.2)', () => {
  it('carries the task-first override verbatim, before PHASE 1', () => {
    expect(DEBUGGER.systemPrompt).toContain(
      'TASK-FIRST OVERRIDE: If the user\'s message is actually a task or a data lookup, do it first and investigate only what actually fails; do not preface execution with an investigation phase or clarifying questions the user already answered.',
    );
    expect(DEBUGGER.systemPrompt.indexOf('TASK-FIRST OVERRIDE'))
      .toBeLessThan(DEBUGGER.systemPrompt.indexOf('PHASE 1 — INVESTIGATE'));
  });

  it('keeps the real-debugging method intact (spec guardrail)', () => {
    for (const kept of ['PHASE 1 — INVESTIGATE', 'PHASE 2', 'PHASE 3', 'PHASE 4', 'CIRCUIT BREAKER', 'ANTI-RATIONALIZATION']) {
      expect(DEBUGGER.systemPrompt).toContain(kept);
    }
  });
});

describe('initBuiltinSkills sync (real in-memory DB)', () => {
  beforeEach(async () => {
    if (testKnex) await testKnex.destroy();
    testKnex = createTestKnex();
    await coreTableInit.initTables();
  });

  afterAll(async () => {
    if (testKnex) await testKnex.destroy();
  });

  it('updates a stale builtin prompt from an older build', async () => {
    await initBuiltinSkills();
    // Simulate an older build's row
    await testKnex('skills').where({ id: 'builtin-debugger' }).update({ system_prompt: 'OLD SHIPPED PROMPT' });
    await initBuiltinSkills();
    const row = await getSkill('builtin-debugger');
    expect(row!.system_prompt).toBe(DEBUGGER.systemPrompt);
  });

  it('does NOT clobber a user-revised builtin (skill_revisions present)', async () => {
    await initBuiltinSkills();
    await testKnex('skills').where({ id: 'builtin-debugger' }).update({ system_prompt: 'USER-FIXED PROMPT' });
    await insertSkillRevision('builtin-debugger', 'USER-FIXED PROMPT', 'Fix: user feedback');
    await initBuiltinSkills();
    const row = await getSkill('builtin-debugger');
    expect(row!.system_prompt).toBe('USER-FIXED PROMPT');
  });

  it('is idempotent when prompts already match', async () => {
    await initBuiltinSkills();
    const before = await getSkill('builtin-debugger');
    await initBuiltinSkills();
    const after = await getSkill('builtin-debugger');
    expect(after!.system_prompt).toBe(before!.system_prompt);
    expect(after!.updated_at).toBe(before!.updated_at); // no gratuitous write
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/skills-builtin-sync.test.ts`
Expected: FAIL — the task-first line is absent, and the stale-prompt test fails (`OLD SHIPPED PROMPT` survives because there is no sync).

- [ ] **Step 3: Write the implementation**

(a) In `src/skills.ts`, edit the `builtin-debugger` `systemPrompt` — change the opening (currently line 219-221):

```
    systemPrompt: `You are in systematic debugging mode. Follow this process strictly:

PHASE 1 — INVESTIGATE (do this FIRST, before suggesting ANY fix):
```

to:

```
    systemPrompt: `You are in systematic debugging mode. Follow this process strictly:

TASK-FIRST OVERRIDE: If the user's message is actually a task or a data lookup, do it first and investigate only what actually fails; do not preface execution with an investigation phase or clarifying questions the user already answered.

PHASE 1 — INVESTIGATE (do this FIRST, before suggesting ANY fix):
```

Everything from `PHASE 1` to the end of the prompt stays byte-identical.

(b) Extend the db-core import at the top of `src/skills.ts` — add `getSkill,`, `getSkillRevisions,`, `updateSkill,` to the existing `from './db-core.js'` list.

(c) Replace the body of `initBuiltinSkills` (currently lines 739-753) with:

```typescript
export async function initBuiltinSkills(): Promise<void> {
  for (const skill of BUILTIN_SKILLS) {
    await createSkillIfNotExists(
      skill.id,
      skill.name,
      skill.description,
      skill.systemPrompt,
      skill.allowedTools,
      true, // isBuiltin
    );
  }

  // spec 2026-07-17 §A — builtin prompts are code-owned: propagate shipped
  // edits to rows seeded by an older build (createSkillIfNotExists is
  // insert-or-ignore, so without this a prompt edit never reaches an
  // existing DB). Skip any skill the user has revised via the AI fixer
  // (skill_revisions rows) — user feedback outranks the shipped default.
  for (const skill of BUILTIN_SKILLS) {
    const existing = await getSkill(skill.id);
    if (!existing || existing.system_prompt === skill.systemPrompt) continue;
    const revisions = await getSkillRevisions(skill.id, 1);
    if (revisions.length > 0) continue;
    await updateSkill(skill.id, { description: skill.description, systemPrompt: skill.systemPrompt });
    logger.info({ skillId: skill.id }, 'Builtin skill prompt synced to current build');
  }

  const total = (await listSkills()).length;
  logger.info({ count: total }, 'Skills initialized');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/skills-builtin-sync.test.ts tests/sprint-s2-prompt-intelligence.test.ts tests/skills.test.ts tests/auto-skills.test.ts && npx tsc --noEmit`
Expected: PASS / clean (sprint-s2 proves the `PHASE 1 — INVESTIGATE` source assertion survives; auto-skills proves the skill lifecycle is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts tests/skills-builtin-sync.test.ts
git commit -m "fix(skills): debugger task-first override + builtin prompt sync for unrevised skills"
```

---

### Task 3: Change B — execution posture on BOTH paths, single-sourced (TDD + local snapshot regen)

**Files:**
- Create: `src/execution-posture.ts` (zero-import module — cycle-proof)
- Modify: `src/capabilities.ts` (import + interpolate into `CAPABILITIES_PROMPT` after the "CRITICAL — Telegram is FULLY FUNCTIONAL" paragraph, line 24)
- Modify: `src/providers/local-prompt.ts` (import + interpolate into `LOCAL_RULES`, line 26-33)
- Modify: `tests/local-prompt.test.ts` (append the parity assertion)
- Modify: `tests/__snapshots__/local-prompt.test.ts.snap` (regenerated with `-u`, scoped diff)

**Interfaces:**
- The Claude path consumes `CAPABILITIES_PROMPT` via `getCapabilitiesPrompt()` → `fullCapabilities` → `composeClaudeSystemPrompt` (router.ts:1442, 1561). The Ollama path consumes `LOCAL_RULES` inside `buildLocalSystemPrompt`'s frozen prefix (local-prompt.ts:58). The condensed `LOCAL_CAPABILITIES_HEADER` (capabilities.ts:683) is NOT touched — the local path gets the block via `LOCAL_RULES`; adding it to both local blocks would duplicate it and eat the ≤800-token local-capabilities budget.
- `tests/claude-prompt-freeze.test.ts` is NOT affected: it passes a fixture `fullCapabilities: 'CAPS_BLOCK'`, so `CAPABILITIES_PROMPT` edits never reach that snapshot. Run it anyway to prove it (Step 5).
- `tests/local-prompt.test.ts` IS affected twice: the frozen-prefix snapshot (line 52-55) and the ≤1200-token budget on `LOCAL_PERSONA + LOCAL_RULES` (line 48-50). The posture block is ~130 estimated tokens on top of ~550 — comfortably inside budget; the test proves it.
- Why a separate module: `local-prompt.ts` already sits in an import cycle with `router.ts`. If `EXECUTION_POSTURE` lived in `capabilities.ts` and any `capabilities.ts` dependency (packs/feature-awareness) ever reaches `router.ts`, `LOCAL_RULES`'s template literal would evaluate before `capabilities.ts`'s body → TDZ ReferenceError. A zero-import module cannot participate in any cycle.

- [ ] **Step 1: Write the failing tests**

Append to `tests/local-prompt.test.ts` (extend the top import block with `import { EXECUTION_POSTURE } from '../src/execution-posture.js';` and `import { CAPABILITIES_PROMPT } from '../src/capabilities.js';`):

```typescript
  // spec 2026-07-17 §B — the execution-posture block must be present on BOTH
  // provider paths with byte-identical wording. Single-sourced from
  // src/execution-posture.ts so drift is structurally impossible: this test
  // proves both prompt strings actually interpolate the shared constant.
  it('execution posture is present on BOTH paths, byte-identical (parity checklist row B)', () => {
    expect(EXECUTION_POSTURE).toContain('**Execution posture.**');
    expect(EXECUTION_POSTURE).toContain('Execute a clear instruction directly');
    expect(EXECUTION_POSTURE).toContain('A fresh explicit instruction outranks your memory');
    expect(EXECUTION_POSTURE).toContain('expected for new work — create it');
    expect(EXECUTION_POSTURE).toContain('only when genuinely blocked');
    expect(EXECUTION_POSTURE).toContain('Never invent a number.');
    expect(CAPABILITIES_PROMPT).toContain(EXECUTION_POSTURE);   // Claude path
    expect(LOCAL_RULES).toContain(EXECUTION_POSTURE);           // Ollama path
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/local-prompt.test.ts`
Expected: FAIL — cannot resolve `../src/execution-posture.js`.

- [ ] **Step 3: Write the implementation**

Create `src/execution-posture.ts`:

```typescript
/**
 * Execution posture (spec 2026-07-17 §B) — the colleague-behavior contract.
 *
 * SINGLE-SOURCED here and interpolated into BOTH provider paths:
 *   - Claude path: CAPABILITIES_PROMPT (src/capabilities.ts) →
 *     getCapabilitiesPrompt() → composeClaudeSystemPrompt
 *   - Ollama path: LOCAL_RULES (src/providers/local-prompt.ts) →
 *     buildLocalSystemPrompt frozen prefix
 * One constant = the parity checklist's "identical wording" requirement
 * cannot drift. This module must stay import-free: local-prompt.ts sits in
 * an import cycle with router.ts, and a zero-import module can never TDZ.
 *
 * Language note: this is an English instruction that governs behavior in
 * ALL response languages (the persona already pins "respond in the language
 * of the user's current message").
 */
export const EXECUTION_POSTURE = `**Execution posture.** Execute a clear instruction directly — don't re-ask for anything already provided in this thread, and don't open an investigation or confirmation phase first. A fresh explicit instruction outranks your memory or a prior lookup; a client/product not yet in the system is expected for new work — create it. Lead with the result and match the user's brevity. Ask a clarifying question only when genuinely blocked (a required field with no sensible default, or a destructive/irreversible action); otherwise proceed and flag any discrepancy afterward. Never invent a number.`;
```

In `src/capabilities.ts`:

(a) Add to the import block at the top (after the `renderDocumentationManifest` import, line 14):

```typescript
import { EXECUTION_POSTURE } from './execution-posture.js';
```

(b) Inside `CAPABILITIES_PROMPT`, directly after the paragraph ending `Never say "I can't connect to the API" — use your tools instead.` (line 24) and before `### Manufacturing & Industrial Engineering`, insert a blank line and:

```
${EXECUTION_POSTURE}
```

(template interpolation — `CAPABILITIES_PROMPT` is already a template literal.)

In `src/providers/local-prompt.ts`:

(a) Add after the existing imports (line 10):

```typescript
import { EXECUTION_POSTURE } from '../execution-posture.js';
```

(b) Replace the `LOCAL_RULES` declaration (lines 26-33) with:

```typescript
export const LOCAL_RULES = `## Quality rules
- Be concise. Lead with the answer. No filler, no repeated caveats.
- If data is missing, say exactly what is missing — do not speculate.
- After a tool error, change approach; never repeat the identical call.
- For recommendations, state the strongest counter-argument in one line.

${EXECUTION_POSTURE}

## Commands the user may reference
/help /voice /provider /model /skill /tool /board /schedule /reload /pack — if asked what a command does, answer briefly; do not invent commands.`;
```

- [ ] **Step 4: Regenerate the local-prompt snapshot and verify the diff is scoped**

```bash
npx vitest run tests/local-prompt.test.ts -u
git diff tests/__snapshots__/local-prompt.test.ts.snap
```

The snapshot diff must show EXACTLY one addition: the Execution posture paragraph inside the Quality rules block of the frozen prefix. If anything else changed → STOP, revert, report.

- [ ] **Step 5: Prove the Claude freeze snapshot is untouched + budgets hold**

Run: `npx vitest run tests/local-prompt.test.ts tests/claude-prompt-freeze.test.ts tests/local-capabilities.test.ts && npx tsc --noEmit`
Expected: all PASS with NO snapshot update prompts — claude-prompt-freeze passes unchanged (fixture capabilities), the ≤1200-token local budget holds, the ≤800-token local-capabilities budget holds (that string was not touched).

- [ ] **Step 6: Commit**

```bash
git add src/execution-posture.ts src/capabilities.ts src/providers/local-prompt.ts tests/local-prompt.test.ts tests/__snapshots__/local-prompt.test.ts.snap
git commit -m "feat(prompt): execution-posture block on both provider paths (single source)"
```

---

### Task 4: Change C1 — sam-prompt write gate relaxed (TDD + Claude freeze regen)

**Files:**
- Modify: `src/providers/sam-prompt.ts` (replace the "### Write confirmation rule (MANDATORY)" block, lines 76-77; adjust one sentence in the generate section, line 80)
- Modify: `tests/sam-prompt.test.ts` (update the write-gate assertions)
- Modify: `tests/__snapshots__/claude-prompt-freeze.test.ts.snap` (regenerated with `-u`, scoped diff — `NOVALINK_SAM_PROMPT` is composed into the Claude prompt)

**Interfaces:**
- KEEP VERBATIM (spec guardrail): the entire `### Library governance (Luna presents, user decides)` block (line 73-74) — byte-identical.
- KEEP: `sam generate` / `sam generate-mm` one heads-up (creating now, costs credits, will be stored); `sam cell-erv` with `"apply": true` keeps its gate (not named by the spec's relax table — resolved ambiguity #3).
- RELAX: `sam create`, `sam update`, `sam set-status`, `sam scenario-save`, `sam cell-create`, `sam cell-update`, and ordinary `sam api` POST/PATCH calls — execute directly, then report.

- [ ] **Step 1: Update the tests first**

In `tests/sam-prompt.test.ts`:

(a) In the first content test (`carries the contract essentials when configured`), replace lines 67-68:

```typescript
    // Write confirmation rule (SA4 bypass tradeoff moves into the prompt)
    expect(p).toContain('explicit confirmation');
```

with:

```typescript
    // Write posture (spec 2026-07-17 §C): ordinary writes execute directly;
    // generate keeps ONE heads-up; governed library writes keep per-item gates.
    expect(p).toContain('### Write posture (execute, then report)');
    expect(p).toContain('need NO confirmation: execute directly');
    expect(p).toContain('costs SAM-server credits, and the result will be stored');
    expect(p).not.toContain('Write confirmation rule (MANDATORY)');
```

(b) In the Phase-2 test (`carries the Phase-2 analytics contract`), replace lines 135-138:

```typescript
    // Extended write-confirmation list
    expect(p).toContain('ANY mutating');
    expect(p).toContain('"apply": true');
    expect(p).toContain('cell-simulate (read-like)');
```

with:

```typescript
    // Relaxed write gate (spec 2026-07-17 §C): the blanket mutating-api
    // confirm is gone; cell-erv apply and governed writes keep their gates.
    expect(p).not.toContain('ANY mutating');
    expect(p).toContain('"apply": true');
    expect(p).toContain('cell-simulate (read-like)');
    expect(p).toContain('per-item confirmation, unchanged');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sam-prompt.test.ts`
Expected: FAIL — the new posture strings are absent and `Write confirmation rule (MANDATORY)` / `ANY mutating` are still present.

- [ ] **Step 3: Write the implementation**

In `src/providers/sam-prompt.ts`, REPLACE the block (lines 76-77):

```
### Write confirmation rule (MANDATORY)
\`sam create\`, \`sam generate\`, \`sam generate-mm\`, \`sam set-status\`, \`sam update\`, \`sam cell-create\`, \`sam cell-update\`, \`sam cell-erv\` with "apply": true, \`sam scenario-save\`, and ANY mutating \`sam api\` call (POST/PUT/PATCH) change quoting/billing data. Ask the user for explicit confirmation in-chat and wait for a clear yes BEFORE invoking any of them. Reads need no confirmation: health, search, get, export, review, balance, balance-whatif, scenarios, estimate, cells, cell, cell-simulate (read-like), cell-export, calc, library, candidates-scan, candidates, and GET \`sam api\`.
```

with:

```
### Write posture (execute, then report)
Ordinary SAM writes are the happy path — storing and iterating on analyses is the point of this system. \`sam create\`, \`sam update\`, \`sam set-status\`, \`sam scenario-save\`, \`sam cell-create\`, \`sam cell-update\`, and the equivalent ordinary \`sam api\` POST/PATCH calls need NO confirmation: execute directly, then report exactly what was created or changed (IDs and fields) so the user can react. A client or product not yet in the system is expected for new work — create it, don't ask. Only two categories still stop for the user:
- \`sam generate\` and \`sam generate-mm\`: give ONE heads-up before calling — creating now, it costs SAM-server credits, and the result will be stored — then proceed on a clear yes. Never re-confirm mid-flow.
- Governed writes: candidate approve/merge/reject, PUT /library/{table}, PUT /machine-costs (per the Library governance rule above), and \`sam cell-erv\` with "apply": true — per-item confirmation, unchanged.
Reads never need confirmation: health, search, get, export, review, balance, balance-whatif, scenarios, estimate, cells, cell, cell-simulate (read-like), cell-export, calc, library, candidates-scan, candidates, and GET \`sam api\`.
```

And in the `### generate and generate-mm are slow and cost credits` section (line 80), change:

```
**\`sam generate-mm\` has no persist option — it ALWAYS stores the analysis** (it's on the confirmation list above, so confirm with the user first and tell them it will be saved).
```

to:

```
**\`sam generate-mm\` has no persist option — it ALWAYS stores the analysis** (covered by the single generate heads-up above — tell the user it will be saved).
```

The `### Library governance (Luna presents, user decides)` block and everything else stay byte-identical.

- [ ] **Step 4: Regenerate the Claude freeze snapshot and verify the diff is scoped**

```bash
npx vitest run tests/claude-prompt-freeze.test.ts -u
git diff tests/__snapshots__/claude-prompt-freeze.test.ts.snap
```

The diff must be confined to the SAM block: the Write-posture rewrite and the one generate-mm sentence. The Library-governance lines must NOT appear in the diff. Anything outside the SAM block → STOP, revert, report.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sam-prompt.test.ts tests/claude-prompt-freeze.test.ts tests/sam-claude-routing.test.ts && npx tsc --noEmit`
Expected: PASS / clean (sam-claude-routing proves the pin/abort/footer machinery is untouched).

- [ ] **Step 6: Commit**

```bash
git add src/providers/sam-prompt.ts tests/sam-prompt.test.ts tests/__snapshots__/claude-prompt-freeze.test.ts.snap
git commit -m "feat(sam): relax ordinary-write confirmations in sam-prompt — generate + governed writes keep gates"
```

---

### Task 5: Change C2 — SA4 flips: sam_create / sam_set_status execute, sam_generate keeps its gate (TDD)

**Files:**
- Modify: `src/providers/tools/index.ts` (line 240 and line 257 — two one-word edits)
- Create: `tests/sam-policy.test.ts`

**Interfaces:**
- Consumes: `registerBuiltinTools` from `src/providers/tools/index.js` (registers each entry's `policy` via `registerToolPolicy` — index.ts:372-375; pure in-memory `Map.set`, proven vitest-safe by `tests/local-buckets-registry.test.ts`), `getToolPolicy` from `src/policy-engine.js` (policy-engine.ts:137).
- This is the Ollama-path half of parity row C: the internal `sam_*` tools only execute in the Ollama agentic loop (the Claude path uses the `sam` shell wrapper governed by Task 4's prompt), so both mechanisms must agree — create/set-status free, generate confirmed.

- [ ] **Step 1: Write the failing tests**

Create `tests/sam-policy.test.ts`:

```typescript
/**
 * SA4 write-gate parity for SAM tools (spec 2026-07-17 §C) — the LOCAL-path
 * half of the relaxed write gate (parity checklist row C). sam_create and
 * sam_set_status are ordinary, reversible record writes: execute without
 * confirmation. sam_generate keeps its single confirmation — slow, costs
 * SAM-server credits, persists — the local-path equivalent of the
 * Claude-path generate heads-up, so BOTH paths confirm exactly once before
 * a credit-costing persist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBuiltinTools } from '../src/providers/tools/index.js';
import { getToolPolicy } from '../src/policy-engine.js';

describe('SAM SA4 policies (relaxed write gate, spec 2026-07-17 §C)', () => {
  beforeAll(() => {
    // Pure in-memory Map.set at registration time — no DB, no network
    // (same bootstrap as tests/local-buckets-registry.test.ts).
    registerBuiltinTools();
  });

  it('sam_create executes without confirmation', () => {
    expect(getToolPolicy('sam_create')?.requiresConfirmation).toBe(false);
  });

  it('sam_set_status executes without confirmation', () => {
    expect(getToolPolicy('sam_set_status')?.requiresConfirmation).toBe(false);
  });

  it('sam_generate KEEPS its confirmation (credit-costing persist)', () => {
    expect(getToolPolicy('sam_generate')?.requiresConfirmation).toBe(true);
  });

  it('sam reads stay unconfirmed', () => {
    for (const t of ['sam_search', 'sam_get_analysis', 'sam_export', 'sam_health']) {
      expect(getToolPolicy(t)?.requiresConfirmation, t).toBe(false);
    }
  });

  it('critical-risk tools are untouched by this spec (guardrail)', () => {
    expect(getToolPolicy('run_command')?.riskLevel).toBe('critical');
    expect(getToolPolicy('run_command')?.requiresConfirmation).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sam-policy.test.ts`
Expected: FAIL — `sam_create` and `sam_set_status` still report `requiresConfirmation: true`.

- [ ] **Step 3: Write the implementation**

In `src/providers/tools/index.ts`:

Line 240 (the `samCreateDefinition` entry) — change:

```typescript
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: true },
```

to:

```typescript
      // spec 2026-07-17 §C: ordinary record write — execute, then report.
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
```

Line 257 (the `samSetStatusDefinition` entry) — change:

```typescript
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: true },
```

to:

```typescript
      // spec 2026-07-17 §C: reversible status change — execute, then report.
      policy: { riskLevel: 'high', scopes: ['network'], requiresConfirmation: false },
```

Line 248 (the `samGenerateDefinition` entry) stays `requiresConfirmation: true` — do NOT touch it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sam-policy.test.ts tests/sam.test.ts tests/policy-engine.test.ts tests/local-buckets-registry.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/providers/tools/index.ts tests/sam-policy.test.ts
git commit -m "feat(sa4): sam_create/sam_set_status execute without confirmation; sam_generate keeps its gate"
```

---

### Task 6: Full gates, rc.140, push + PR (NOT merged)

**Files:**
- Modify: `package.json` + `package-lock.json` (version `1.0.0-rc.139` → `1.0.0-rc.140`)

- [ ] **Step 1: Full local verification**

```bash
npx tsc --noEmit
npm run lint        # 0 errors, no NEW no-explicit-any warnings
npx vitest run      # full suite
npm run build && npm run smoke
```

Expected: all green. Fix anything that isn't before proceeding (audit findings are in scope — no debt rides along).

- [ ] **Step 2: Docker build check**

```bash
docker compose build luna
```

Expected: image builds clean.

- [ ] **Step 3: Version bump**

```bash
npm version 1.0.0-rc.140 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): rc.140 — colleague-behavior tuning (cross-path)"
```

- [ ] **Step 4: Push + PR — do NOT merge**

```bash
git push -u origin feat/luna-colleague-behavior
gh pr create --title "feat: Luna colleague-behavior tuning — cross-path parity + bilingual (rc.140)" --body "$(cat <<'EOF'
## Summary
Implements docs/superpowers/specs/2026-07-17-luna-colleague-behavior-design.md
(approved). Root cause: 4 SAM conversations (2026-07-15..17) showed systemic
over-clarification — Luna interviews instead of executing. Three changes,
each landing on BOTH provider paths (the spec's parity checklist):

- **A — Debugger skill (both paths via skillPrompt):** the auto-trigger now
  requires a software/system anchor (code/script/config/server/database/api/
  deploy/container/log/app/bot) so ops language ("the line isn't working",
  "arregla el faltante") never opens a debugging interview, and it is now
  BILINGUAL (EN+ES) with the same anchor rule — closing an EN/ES asymmetry
  in both directions. The skill body gains a task-first override; the
  4-phase method, circuit breaker, and anti-rationalization stay intact.
  Also fixes a deployment gap found in audit: `initBuiltinSkills` now syncs
  code-owned builtin prompts to DBs seeded by older builds (skipping
  user-revised skills), so shipped prompt edits actually reach prod.
- **B — Execution posture (both paths, single-sourced):** new
  `src/execution-posture.ts` constant interpolated into BOTH
  `CAPABILITIES_PROMPT` (Claude) and `LOCAL_RULES` (Ollama) — execute clear
  instructions, never re-ask answered questions, fresh instruction outranks
  memory, new client/product is expected → create it, lead with the result,
  ask only when genuinely blocked, never invent a number. One constant =
  wording cannot drift between paths.
- **C — SAM write gate (both mechanisms):** `sam create/update/set-status/
  scenario-save/cell-create/cell-update` execute directly (storing drafts IS
  the product); `sam generate`/`generate-mm` keep ONE heads-up (credits +
  persist); governed library writes (candidate approve/merge/reject,
  PUT /library, PUT /machine-costs) keep per-item confirmation verbatim.
  SA4 mirrors it: `sam_create`/`sam_set_status` → requiresConfirmation
  false, `sam_generate` stays true.

Snapshots regenerated with scoped diffs only: local-prompt frozen prefix
(posture block) and claude-prompt-freeze (SAM write-posture block).

## Test plan
- [x] New suites: skills-debugger-trigger (EN+ES adversarial sets),
  skills-builtin-sync, sam-policy; updated sam-prompt + local-prompt
- [x] tsc, eslint (0 errors), full vitest, dist smoke, docker build
- [ ] Post-merge operator live smoke (plan Task 7): Claude-path analysis-23
  replay with zero re-asks, `/sam local` parity, full-Spanish exchange,
  library write still stops for confirmation

**NOT auto-merged** — final review runs first per plan (explicit override of
the auto-merge default for this ship). Leave the PR open and report its URL.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 7: Operator live smoke (after review, merge + deploy — spec §Verification 3-5)

**No code changes.** Requires the prod box (.244) and the Telegram chat. Deploy first: `git pull && docker compose build luna && docker compose up -d luna`. The restart also runs the Task 2 builtin-prompt sync — verify the log line `Builtin skill prompt synced to current build` appears once for `builtin-debugger` on first boot after deploy.

- [ ] **Step 1: CLAUDE path — analysis-23 replay (default routing).** In one single message give client + product + the tech-pack file with a terse instruction (the exact shape that previously triggered the re-ask loop, e.g. "Client: Bench Clearers. Product: <name>. Generate the SAM analysis from this file."). PASS = Luna proceeds straight to work — creates the missing client/product without asking, gives exactly ONE generate heads-up (credits + will be stored; this is the kept gate, not a re-ask), runs it after "yes", and returns the result with caveats. FAIL = any question asking for information already in the message, or any investigation-phase preamble.
- [ ] **Step 2: CLAUDE path — library write still stops.** Ask Luna to approve a library candidate (or `PUT /library`). PASS = per-item confirmation request BEFORE any write. FAIL = it writes without asking.
- [ ] **Step 3: OLLAMA path — parity.** `/sam local`, then the same terse create-type instruction (within local-path capability, e.g. create a client + product and set an analysis status). PASS = same execute-then-flag behavior: no investigation preamble, no re-asking, `sam_create`/`sam_set_status` run WITHOUT an SA4 confirmation prompt, forced-local footer/banner rules unchanged. This is the row that proves parity. Restore with `/sam auto` afterward.
- [ ] **Step 4: SPANISH exchange (either path).** Run one exchange entirely in Spanish — terse instruction with client/product/file. PASS = Luna executes and answers in Spanish with caveats, no re-asking. Also send one ES ops line ("la línea 3 no está funcionando, arregla el faltante") — PASS = normal ops handling (data/tools), NO debugging interview; and one ES software line ("depura este script" or "¿por qué la API se cae cada vez?") — PASS = debugger engages.
- [ ] **Step 5: Debugger EN ops check.** Send "the line isn't working, fix the shortage on line 3". PASS = Luna routes to data/ops handling, no PHASE-1 investigation interview.
- [ ] **Step 6: Record the outcome.** Update memory (`luna-deploy-execution-status` + the colleague-behavior memory): deployed rc.140, live-verified date, per-step results, any gotchas, and whether any step was deferred (never skip silently).

---

## Self-review notes (against the spec)

- **Parity coverage:** row A → Tasks 1-2 (one file, both paths via `skillPrompt`; Task 2's DB sync makes it land in deployment, not just code); row B → Task 3 (Claude: `CAPABILITIES_PROMPT`; Ollama: `LOCAL_RULES`; single constant proves identical wording by construction, test asserts both containments); row C → Task 4 (Claude prompt mechanism) + Task 5 (Ollama SA4 mechanism), with matching semantics (create/set-status free; generate one gate on both). Verification exercises both paths (Task 7 Steps 1-3) plus Spanish (Step 4).
- **Bilingual coverage:** A's trigger tests carry EN+ES must/must-not sets (the only language-sensitive change); B and C are language-agnostic per the spec's bilingual note; live smoke includes a full-Spanish exchange plus ES ops/software trigger probes.
- **Guardrails intact:** Library-governance block byte-identical (Task 4 diff check); `sam_generate` + `run_command` confirmations asserted (Task 5 tests); debugger PHASE 1-4 / circuit breaker / anti-rationalization asserted (Task 2 tests); SAM pin/abort/footer suites re-run in Task 4 Step 5; UNVERIFIED banner untouched (no edits to router.ts).
- **Exact strings pinned:** posture block (Global Constraints + `src/execution-posture.ts` + containment tests), task-first override (Global Constraints + Task 2 test), SA4 values (Task 5 tests), write-posture heads-up phrasing (Task 4 tests).
- **Snapshot discipline:** two regens, both with mandatory scoped-diff verification (Task 3 Step 4: posture paragraph only; Task 4 Step 4: SAM block only); Claude freeze proven UNAFFECTED by Task 3 (fixture `fullCapabilities`) by running it un-regenerated.
- **Name consistency:** `EXECUTION_POSTURE` (T3 module → capabilities → local-prompt → tests), `DEBUG_ANCHOR_EN`/`DEBUG_ANCHOR_ES` (T1 internal), `initBuiltinSkills` sync uses existing `getSkill`/`getSkillRevisions`/`updateSkill` exports (verified signatures db-core.ts:792/890/804), `registerBuiltinTools`/`getToolPolicy` (T5, verified index.ts:72/372-375 + policy-engine.ts:137).
- **Out of scope honored:** no `/role` work, no KPI-pack work, debugger core method untouched, no router/banner/abort changes, no Matrix work.
