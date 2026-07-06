# Pipeline Surgery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Luna's local (Ollama) per-turn prompt from ~27k tokens to <12k with a KV-cache-stable layout, then pin NovaLink-data turns to the local model with soft Claude fallback.

**Architecture:** A new `LocalPromptAssembler` (frozen prefix / intent bucket / volatile tail) replaces the inline Ollama-branch prompt concatenation in `router.ts`; tool pruning rides the existing `allowedTools` plumbing (core + one intent bucket ⇒ ~15-20 of ~48 schemas); the Claude branch is byte-frozen and snapshot-tested. Phase 2 adds a `novalink-data` pin that overrides routing stickiness, with disclosure-prefixed Claude fallback.

**Tech Stack:** TypeScript ES2022/NodeNext, vitest, ollama SDK (`client.chat` native `tools`), pino.

**Spec:** `docs/superpowers/specs/2026-07-06-pipeline-surgery-design.md` — read it first.

## Global Constraints

- Claude path FROZEN: the Claude branch's composed system prompt must remain byte-identical (Task 2 snapshot test is the guard).
- Prod env unchanged: `OLLAMA_THINK=false`, `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_NUM_CTX=32768`, ministral-3:3b.
- Gate: warm same-bucket local turn <30s on ministral-3:3b on the .244 box before any prod `AUTO_ROUTE` flip; the flip itself is a user action, never automated.
- Code Convention #6: every new failure path logs and continues — assembler/selector/fallback must never crash a turn.
- Verify per repo workflow before any "done" claim: `npx tsc --noEmit` && `npm run lint` (0 errors, no new `no-explicit-any` warnings) && `npx vitest run` && `npm run build && npm run smoke`.
- Never `git add -A`; stage explicit paths. Conventional commits. rc bump in `package.json` per ship.
- Ollama SDK types: `import { type Message, type Tool } from 'ollama'`.
- Deviation from spec table (approved in plan review): the ~11 github_*/render_* tools get a fifth `devops` bucket — the spec's bucket table omitted them and they must live somewhere that isn't `core`.

---

### Task 1: Phase 0 — KV-reuse benchmark script

**Files:**
- Create: `scripts/bench-local-pipeline.mjs`

**Interfaces:**
- Produces: a runnable script; results JSON lines on stdout. No exports consumed by other tasks — its OUTPUT (the findings file) calibrates Task 4/7 decisions.

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// Phase 0 spike for pipeline surgery (spec 2026-07-06).
// Measures whether Ollama KV prefix reuse engages for our request shape, and
// the prompt-eval cost of tool schemas. Run on the target box:
//   OLLAMA_HOST=http://127.0.0.1:11434 MODEL=ministral-3:3b node scripts/bench-local-pipeline.mjs
// Prints one JSON line per scenario: {scenario, prompt_eval_count, prompt_eval_ms, total_ms}

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.MODEL || 'ministral-3:3b';

const STATIC_PREFIX = 'You are Luna, a helpful assistant. '.repeat(200); // ~1.4k tok stable block
const TOOL = (n) => ({
  type: 'function',
  function: {
    name: `bench_tool_${n}`,
    description: `Benchmark tool number ${n}. Does nothing useful but occupies schema space like a real tool definition with parameters.`,
    parameters: {
      type: 'object',
      properties: {
        alpha: { type: 'string', description: 'first parameter, a string input' },
        beta: { type: 'number', description: 'second parameter, a numeric input' },
      },
      required: ['alpha'],
    },
  },
});

async function chat(messages, tools) {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, messages, tools, stream: false, think: false,
      options: { num_ctx: 32768, temperature: 0.2, num_predict: 32 },
      keep_alive: '30m',
    }),
  });
  const body = await res.json();
  return {
    prompt_eval_count: body.prompt_eval_count,
    prompt_eval_ms: Math.round((body.prompt_eval_duration ?? 0) / 1e6),
    total_ms: Date.now() - t0,
  };
}

function report(scenario, r) {
  console.log(JSON.stringify({ scenario, ...r }));
}

const sys = { role: 'system', content: STATIC_PREFIX };
const tools20 = Array.from({ length: 20 }, (_, i) => TOOL(i));
const tools48 = Array.from({ length: 48 }, (_, i) => TOOL(i));

// 1. Cold turn (first eval of prefix + 48 schemas)
report('cold_48_tools', await chat([sys, { role: 'user', content: 'Say OK.' }], tools48));
// 2. Warm turn, identical prefix + same tools, new tail → KV reuse should show
//    prompt_eval_count << cold count if prefix caching engages.
report('warm_same_prefix', await chat([sys, { role: 'user', content: 'Say OK.' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Say OK again.' }], tools48));
// 3. Warm turn, one tool swapped (simulates bucket switch) → expect near-cold eval
const swapped = [...tools48.slice(0, 47), TOOL(99)];
report('warm_tool_set_changed', await chat([sys, { role: 'user', content: 'Say OK.' }], swapped));
// 4. Warm turn, prefix byte-mutated (simulates volatile block early in prompt)
report('warm_prefix_mutated', await chat([{ role: 'system', content: `note ${Date.now()}\n` + STATIC_PREFIX }, { role: 'user', content: 'Say OK.' }], tools48));
// 5. Schema cost: 20 tools vs 48 tools, cold-equivalent (different prefix to avoid cache)
report('cold_20_tools', await chat([{ role: 'system', content: STATIC_PREFIX + ' variant-20' }, { role: 'user', content: 'Say OK.' }], tools20));
```

- [ ] **Step 2: Run against dev Ollama to validate the script mechanically**

Run: `node scripts/bench-local-pipeline.mjs`
Expected: 5 JSON lines, each with numeric `prompt_eval_count` / `prompt_eval_ms`. (Dev numbers are NOT the baseline — the dev GPU masks the problem; this run only proves the script works.)

- [ ] **Step 3: Run on the .244 box (the real baseline)**

Run: `scp scripts/bench-local-pipeline.mjs developer@192.168.2.244:/tmp/ && ssh developer@192.168.2.244 'export PATH=/opt/homebrew/bin:$PATH; MODEL=ministral-3:3b node /tmp/bench-local-pipeline.mjs'`
Expected: 5 JSON lines. Decision data: if `warm_same_prefix.prompt_eval_count` is a small fraction of `cold_48_tools.prompt_eval_count`, KV prefix reuse ENGAGES (prefix stability is the priority); if roughly equal, it does NOT (raw token cut is the priority).

- [ ] **Step 4: Record findings**

Write the JSON lines plus a 5-line interpretation into `reference/kv-reuse-spike-2026-07.md` (create it; note model, date, host, and the engage/not-engage verdict).

- [ ] **Step 5: Commit**

```bash
git add scripts/bench-local-pipeline.mjs reference/kv-reuse-spike-2026-07.md
git commit -m "feat(bench): KV-reuse spike script + .244 baseline findings (pipeline surgery phase 0)"
```

---

### Task 2: Claude-freeze snapshot test (guard BEFORE any router edits)

**Files:**
- Create: `tests/claude-prompt-freeze.test.ts`
- Modify: `src/providers/router.ts` (extract one pure function, no behavior change)

**Interfaces:**
- Produces: `composeClaudeSystemPrompt(parts: ClaudePromptParts): string` exported from `src/providers/router.ts`, where `ClaudePromptParts = { platformIdentity: string; voiceHint: string; systemPrompt?: string; skillPrompt: string; fullCapabilities: string; mfgHint: string; uploadsManifest: string; deliverableReminder: string; simulationScaffolding: string; languageOverride: string }`. Task 5 reuses the same extraction pattern for the Ollama branch.

- [ ] **Step 1: Extract the Claude branch composition into a pure exported function**

In `src/providers/router.ts`, directly above the `const systemPrompt = provider.name === 'claude'` ternary (near line 1010), the composition arrays are inline. Add above the class (module scope, near the other exported helpers):

```typescript
/** Pipeline surgery Task 2 — pure extraction of the Claude-branch prompt
 * composition so a snapshot test can freeze it byte-for-byte. MUST keep the
 * exact same block list and order as before the extraction. */
export interface ClaudePromptParts {
  platformIdentity: string;
  voiceHint: string;
  systemPrompt?: string;
  skillPrompt: string;
  fullCapabilities: string;
  mfgHint: string;
  uploadsManifest: string;
  deliverableReminder: string;
  simulationScaffolding: string;
  languageOverride: string;
}

export function composeClaudeSystemPrompt(p: ClaudePromptParts): string {
  return [
    p.platformIdentity, p.voiceHint, p.systemPrompt, p.skillPrompt,
    p.fullCapabilities, p.mfgHint, p.uploadsManifest,
    CLAUDE_PROVIDER_NOTICE, NOVALINK_BRIDGE_PROMPT, CLAUDE_DOCUMENT_PROMPT,
    CLAUDE_KANBAN_PROMPT, QUALITY_RULES, COMMAND_LIST,
    p.deliverableReminder, p.simulationScaffolding, LANGUAGE_HINT, p.languageOverride,
  ].filter(Boolean).join('\n\n');
}
```

Then replace the Claude arm of the ternary at ~line 1011 so it calls the function with the already-computed locals:

```typescript
    const systemPrompt = provider.name === 'claude'
      ? composeClaudeSystemPrompt({ platformIdentity, voiceHint, systemPrompt: params.systemPrompt, skillPrompt, fullCapabilities, mfgHint, uploadsManifest, deliverableReminder, simulationScaffolding, languageOverride })
      : [platformIdentity, voiceHint, params.systemPrompt, skillPrompt, fullCapabilities, mfgHint, uploadsManifest, CLAUDE_DOCUMENT_PROMPT, OLLAMA_KANBAN_PROMPT, QUALITY_RULES, COMMAND_LIST, deliverableReminder, simulationScaffolding, LANGUAGE_HINT, languageOverride].filter(Boolean).join('\n\n') || undefined;
```

- [ ] **Step 2: Write the snapshot test**

```typescript
// tests/claude-prompt-freeze.test.ts
import { describe, it, expect } from 'vitest';
import { composeClaudeSystemPrompt } from '../src/providers/router.js';

const FIXED_PARTS = {
  platformIdentity: 'IDENTITY_BLOCK',
  voiceHint: '',
  systemPrompt: undefined,
  skillPrompt: 'SKILL_BLOCK',
  fullCapabilities: 'CAPS_BLOCK',
  mfgHint: '',
  uploadsManifest: 'UPLOADS_BLOCK',
  deliverableReminder: '',
  simulationScaffolding: '',
  languageOverride: 'LANG_OVERRIDE_BLOCK',
};

describe('Claude prompt freeze (pipeline surgery guard)', () => {
  it('composed Claude system prompt is byte-identical across the surgery', () => {
    // toMatchSnapshot pins the FULL composed string, including the verbatim
    // CLAUDE_PROVIDER_NOTICE/QUALITY_RULES/etc. constants. Any byte change to
    // the Claude branch — accidental or deliberate — fails this test.
    expect(composeClaudeSystemPrompt(FIXED_PARTS)).toMatchSnapshot();
  });
});
```

- [ ] **Step 3: Run test to create the snapshot, then re-run to verify it passes**

Run: `npx vitest run tests/claude-prompt-freeze.test.ts`
Expected: PASS, `1 snapshot written`. Re-run: PASS, `1 snapshot matched`.

- [ ] **Step 4: Full verify (extraction must be behavior-neutral)**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: clean / 0 errors / all pass (existing router tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/providers/router.ts tests/claude-prompt-freeze.test.ts tests/__snapshots__/claude-prompt-freeze.test.ts.snap
git commit -m "test(router): byte-freeze snapshot for Claude prompt composition (surgery guard)"
```

---

### Task 3: Bucket definitions + selector with hysteresis

**Files:**
- Create: `src/providers/local-buckets.ts`
- Test: `tests/local-buckets.test.ts`

**Interfaces:**
- Produces:
  - `type BucketId = 'core' | 'docs' | 'manufacturing' | 'simulation' | 'devops'`
  - `CORE_TOOLS: string[]` and `BUCKET_TOOLS: Record<Exclude<BucketId,'core'>, string[]>`
  - `selectBucket(message: string, currentBucket: BucketId | undefined): BucketId` — hysteresis built in (no match ⇒ keep current, else `'core'`)
  - `toolNamesForBucket(bucket: BucketId): string[]` — core ∪ bucket, deduped
  - `bucketForTool(toolName: string): BucketId | undefined` — reverse lookup for the mid-loop swap (Task 5)

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/local-buckets.test.ts
import { describe, it, expect } from 'vitest';
import {
  selectBucket, toolNamesForBucket, bucketForTool, CORE_TOOLS, BUCKET_TOOLS,
} from '../src/providers/local-buckets.js';

describe('bucket selection', () => {
  it('routes manufacturing vocabulary (EN) to manufacturing', () => {
    expect(selectBucket('show me the bom shortage for company 1054', undefined)).toBe('manufacturing');
  });
  it('routes manufacturing vocabulary (ES) to manufacturing', () => {
    expect(selectBucket('análisis de causa raíz del cuello de botella', undefined)).toBe('manufacturing');
  });
  it('routes simulation asks to simulation', () => {
    expect(selectBucket('run a production simulation with 3 cells', undefined)).toBe('simulation');
  });
  it('routes document asks (EN+ES) to docs', () => {
    expect(selectBucket('generate a PDF report of the results', undefined)).toBe('docs');
    expect(selectBucket('genera un reporte en xlsx', undefined)).toBe('docs');
  });
  it('routes github/render asks to devops', () => {
    expect(selectBucket('list my repos and open PRs', undefined)).toBe('devops');
  });
  it('hysteresis: no bucket match keeps the current bucket', () => {
    expect(selectBucket('ok thanks, continue', 'manufacturing')).toBe('manufacturing');
  });
  it('no match and no current bucket falls back to core', () => {
    expect(selectBucket('hola, buenos días', undefined)).toBe('core');
  });
  it('explicit different-bucket match switches buckets', () => {
    expect(selectBucket('now generate the docx summary', 'manufacturing')).toBe('docs');
  });
});

describe('bucket tool lists', () => {
  it('toolNamesForBucket returns core ∪ bucket with no duplicates', () => {
    const names = toolNamesForBucket('manufacturing');
    expect(names).toEqual([...new Set(names)]);
    for (const t of CORE_TOOLS) expect(names).toContain(t);
    for (const t of BUCKET_TOOLS.manufacturing) expect(names).toContain(t);
  });
  it('core bucket returns only core tools', () => {
    expect(toolNamesForBucket('core')).toEqual(CORE_TOOLS);
  });
  it('bucketForTool reverse lookup works and core tools map to core', () => {
    expect(bucketForTool('production_simulation')).toBe('simulation');
    expect(bucketForTool('web_search')).toBe('core');
    expect(bucketForTool('nonexistent_tool')).toBeUndefined();
  });
  it('per-turn schema count target: core + largest bucket ≤ 22', () => {
    const counts = Object.keys(BUCKET_TOOLS).map((b) => toolNamesForBucket(b as never).length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(22);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/local-buckets.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/local-buckets.js'`.

- [ ] **Step 3: Implement `src/providers/local-buckets.ts`**

```typescript
/**
 * Pipeline surgery Phase 1 — tool buckets for the local (Ollama) path.
 * Per turn the model receives core + ONE intent bucket (~15-20 schemas of ~48).
 * Selection uses cheap regexes with hysteresis: a conversation stays in its
 * bucket until a different bucket matches explicitly, protecting KV-cache
 * prefix stability (spec 2026-07-06-pipeline-surgery-design.md).
 *
 * IMPORTANT: name lists must track the registry. `tests/local-buckets-registry.test.ts`
 * (Task 5) asserts every name here exists in the registry and every registered
 * builtin tool is assigned to exactly one bucket.
 */

export type BucketId = 'core' | 'docs' | 'manufacturing' | 'simulation' | 'devops';

export const CORE_TOOLS: string[] = [
  'web_search', 'summarize_url', 'query_memory', 'save_memory',
  'get_time', 'system_info', 'kanban_manage', 'create_reminder',
  'read_bot_logs', 'take_screenshot',
];

export const BUCKET_TOOLS: Record<Exclude<BucketId, 'core'>, string[]> = {
  docs: [
    'parse_file', 'read_file', 'generate_document', 'review_report',
    'search_papers', 'manage_citations',
  ],
  manufacturing: [
    'capacity_planning', 'value_stream_map', 'toc_analysis', 'line_balance',
    'sigma_analysis', 'inventory_plan', 'spc_setup', 'fmea_manage', 'rca_manage',
    'novalink_list_queries', 'novalink_query', 'novalink_health',
  ],
  simulation: [
    'production_simulation', 'state_machine_simulator', 'design_of_experiments',
    'minizinc_optimize', 'conwip_heijunka', 'job_sequencer',
  ],
  devops: [
    'run_command',
    'github_list_repos', 'github_read_file', 'github_list_issues', 'github_list_prs',
    'github_clone_repo', 'github_diff', 'github_commit_push', 'github_create_pr',
    'render_list_services', 'render_deploy_status', 'render_get_logs',
  ],
};

/** Bucket trigger regexes, EN+ES, checked in declaration order. */
const BUCKET_PATTERNS: Array<[Exclude<BucketId, 'core'>, RegExp]> = [
  ['simulation', /\b(simulat|simulaci[oó]n|doe\b|design of experiments|experiment|experimento|state machine|m[aá]quina de estados|minizinc|conwip|heijunka|sequenc\w* (the )?jobs?|secuencia\w* (de )?trabajos?)\b/i],
  ['docs', /\b(pdf|docx|xlsx|pptx|csv|report|reporte|informe|document|documento|archivo|file|spreadsheet|hoja de c[aá]lculo|citation|cita|papers?|art[ií]culos?)\b/i],
  ['manufacturing', /\b(bom|shortage|faltante|company|compa[ñn][ií]a|capacity|capacidad|value stream|flujo de valor|toc\b|bottleneck|cuello de botella|balance|sigma|cpk|spc|control chart|carta de control|fmea|rca|root cause|causa ra[ií]z|inventory|inventario|novalink|producci[oó]n|production data)\b/i],
  ['devops', /\b(github|repo|repos|branch|commit|push|pull request|prs?\b|issue|issues|render|deploy|deployment|clone|run command|ejecuta\w* (el )?comando)\b/i],
];

export function selectBucket(message: string, currentBucket: BucketId | undefined): BucketId {
  for (const [bucket, pattern] of BUCKET_PATTERNS) {
    if (pattern.test(message)) return bucket;
  }
  return currentBucket ?? 'core';
}

export function toolNamesForBucket(bucket: BucketId): string[] {
  if (bucket === 'core') return [...CORE_TOOLS];
  return [...new Set([...CORE_TOOLS, ...BUCKET_TOOLS[bucket]])];
}

export function bucketForTool(toolName: string): BucketId | undefined {
  if (CORE_TOOLS.includes(toolName)) return 'core';
  for (const [bucket, names] of Object.entries(BUCKET_TOOLS)) {
    if (names.includes(toolName)) return bucket as BucketId;
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass; fix regex/word-boundary misses if any**

Run: `npx vitest run tests/local-buckets.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Reconcile name lists against the live registry**

Run: `grep -oE "name: '[a-z_0-9]+'" src/providers/tools/index.ts src/packs/manufacturing/index.ts | sort -u`
If names differ from the lists above (the plan's lists come from the persona dump at `ollama.ts:73` and may drift), fix `local-buckets.ts` to match the registry, keeping the bucket assignments' intent. Re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/providers/local-buckets.ts tests/local-buckets.test.ts
git commit -m "feat(local): tool buckets + hysteresis selector for the Ollama path"
```

---

### Task 4: LocalPromptAssembler — slim prose, three-layer ordering, byte-stable prefix

**Files:**
- Create: `src/providers/local-prompt.ts`
- Test: `tests/local-prompt.test.ts`

**Interfaces:**
- Consumes: `BucketId` from Task 3; `CLAUDE_DOCUMENT_PROMPT`, `OLLAMA_KANBAN_PROMPT` remain in `router.ts` (docs bucket imports `CLAUDE_DOCUMENT_PROMPT` from there).
- Produces: `buildLocalSystemPrompt(input: LocalPromptInput): string` where
  `LocalPromptInput = { bucket: BucketId; skillPrompt: string; fullCapabilities: string; volatiles: { platformNote: string; voiceHint: string; mfgHint: string; uploadsManifest: string; deliverableReminder: string; simulationScaffolding: string; languageHint: string; languageOverride: string; continuityAppend: string } }`.
  Also exports `LOCAL_PERSONA` (slim persona replacing `TOOL_MODEL_SYSTEM_PROMPT` content on this path) and `LOCAL_RULES` (condensed quality+command text).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/local-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildLocalSystemPrompt, LOCAL_PERSONA, LOCAL_RULES } from '../src/providers/local-prompt.js';
import { estimateTokens } from '../src/context-budget.js';

const VOLATILES = {
  platformNote: 'via Telegram Bot', voiceHint: '', mfgHint: 'MFG_HINT',
  uploadsManifest: 'UPLOADS', deliverableReminder: '', simulationScaffolding: '',
  languageHint: 'LANG_HINT', languageOverride: 'LANG_OVERRIDE', continuityAppend: '',
};

describe('LocalPromptAssembler', () => {
  it('frozen prefix is byte-identical across turns with different volatiles', () => {
    const a = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: 'CAPS', volatiles: VOLATILES });
    const b = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: 'CAPS', volatiles: { ...VOLATILES, uploadsManifest: 'DIFFERENT', mfgHint: 'OTHER' } });
    // Everything before the volatile marker must match byte-for-byte.
    const cut = (s: string) => s.slice(0, s.indexOf('## This turn'));
    expect(cut(a)).toBe(cut(b));
    expect(a.indexOf('## This turn')).toBeGreaterThan(0);
  });

  it('volatile blocks appear AFTER all static content', () => {
    const out = buildLocalSystemPrompt({ bucket: 'core', skillPrompt: 'SKILL', fullCapabilities: 'CAPS', volatiles: VOLATILES });
    expect(out.indexOf('UPLOADS')).toBeGreaterThan(out.indexOf('CAPS'));
    expect(out.indexOf('LANG_OVERRIDE')).toBeGreaterThan(out.indexOf('UPLOADS'));
  });

  it('doc-schema prose ships only in the docs bucket', () => {
    const docs = buildLocalSystemPrompt({ bucket: 'docs', skillPrompt: '', fullCapabilities: '', volatiles: VOLATILES });
    const mfg = buildLocalSystemPrompt({ bucket: 'manufacturing', skillPrompt: '', fullCapabilities: '', volatiles: VOLATILES });
    expect(docs).toContain('generate_document');
    expect(mfg.length).toBeLessThan(docs.length);
  });

  it('persona has no hardcoded tool-name dump', () => {
    expect(LOCAL_PERSONA).not.toContain('github_list_repos');
    expect(LOCAL_PERSONA).not.toContain('Available tools include');
  });

  it('static prose diet: persona+rules ≤ 1200 estimated tokens', () => {
    expect(estimateTokens(`${LOCAL_PERSONA}\n\n${LOCAL_RULES}`)).toBeLessThanOrEqual(1200);
  });

  it('frozen prefix snapshot (regression guard for KV stability)', () => {
    const out = buildLocalSystemPrompt({ bucket: 'core', skillPrompt: '', fullCapabilities: '', volatiles: { ...VOLATILES, mfgHint: '', uploadsManifest: '', languageHint: '', languageOverride: '', platformNote: '' } });
    expect(out).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/local-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/local-prompt.ts`**

```typescript
/**
 * Pipeline surgery Phase 1 — slim, KV-cache-stable system prompt for the
 * local (Ollama) path. Layout contract (spec 2026-07-06):
 *   [frozen prefix: persona + rules + capabilities + skill]  ← byte-stable per conversation
 *   [bucket prose: docs schema help only in the docs bucket]
 *   [## This turn: ALL volatile per-turn blocks, last]
 * The Claude path never imports from this module.
 */
import type { BucketId } from './local-buckets.js';
import { CLAUDE_DOCUMENT_PROMPT, OLLAMA_KANBAN_PROMPT } from './router.js';

export const LOCAL_PERSONA = `You are Luna (Inge Luna in Spanish), an AI assistant on the user's company server, chatting via a messaging platform. You have real tools — the tool list attached to this request is the complete, authoritative set for this turn.

You DO have real-time web search (web_search). For current events or anything beyond training data, call it — never claim you lack internet access.

DELIVERABLE RULE: if the user asks for a PDF, DOCX, XLSX, PPTX, CSV, report/reporte/informe or any downloadable file, calling generate_document is REQUIRED. Read data first via parse_file if needed. Never reply with analysis or questions INSTEAD of the file.

VERIFY BEFORE CONCLUDING: only claim a file/artifact exists after a tool returned its path or success.

When you learn something durable about the user, save_memory it; recall with query_memory. Proactively create kanban cards for tasks/ideas via kanban_manage (assignee "noted" unless told otherwise).

Always end with a text response, and always answer in the language of the user's latest message.`;

export const LOCAL_RULES = `## Quality rules
- Be concise. Lead with the answer. No filler, no repeated caveats.
- If data is missing, say exactly what is missing — do not speculate.
- After a tool error, change approach; never repeat the identical call.
- For recommendations, state the strongest counter-argument in one line.

## Commands the user may reference
/help /status /provider /model /skill /skills /reload /budget /board /remind /voice — if asked what a command does, answer briefly; do not invent commands.`;

export interface LocalPromptVolatiles {
  platformNote: string;
  voiceHint: string;
  mfgHint: string;
  uploadsManifest: string;
  deliverableReminder: string;
  simulationScaffolding: string;
  languageHint: string;
  languageOverride: string;
  continuityAppend: string;
}

export interface LocalPromptInput {
  bucket: BucketId;
  skillPrompt: string;
  fullCapabilities: string;
  volatiles: LocalPromptVolatiles;
}

export function buildLocalSystemPrompt(input: LocalPromptInput): string {
  const frozen = [LOCAL_PERSONA, LOCAL_RULES, OLLAMA_KANBAN_PROMPT, input.fullCapabilities, input.skillPrompt]
    .filter(Boolean).join('\n\n');

  const bucketProse = input.bucket === 'docs' ? CLAUDE_DOCUMENT_PROMPT : '';

  const v = input.volatiles;
  const volatileBlocks = [
    v.platformNote, v.voiceHint, v.mfgHint, v.uploadsManifest,
    v.deliverableReminder, v.simulationScaffolding, v.continuityAppend,
    v.languageHint, v.languageOverride,
  ].filter(Boolean).join('\n\n');

  return [
    frozen,
    bucketProse,
    volatileBlocks ? `## This turn\n${volatileBlocks}` : '',
  ].filter(Boolean).join('\n\n');
}
```

- [ ] **Step 4: Run tests; adjust prose until the ≤1200-token test passes without gutting meaning**

Run: `npx vitest run tests/local-prompt.test.ts`
Expected: PASS, 1 snapshot written.

- [ ] **Step 5: Check for import cycles (`local-prompt.ts` imports `router.ts`)**

Run: `npx tsc --noEmit && npm run build && npm run smoke`
If the smoke fails on a cycle (`router.ts` will import `local-prompt.ts` in Task 5), move `CLAUDE_DOCUMENT_PROMPT`, `OLLAMA_KANBAN_PROMPT`, `QUALITY_RULES`, `COMMAND_LIST` into a new leaf module `src/providers/prompt-blocks.ts`, re-export them from `router.ts` (`export { CLAUDE_DOCUMENT_PROMPT, ... } from './prompt-blocks.js'`) so all existing importers and the Task 2 freeze test stay intact, and import from `prompt-blocks.js` here. Re-run this step clean.

- [ ] **Step 6: Commit**

```bash
git add src/providers/local-prompt.ts tests/local-prompt.test.ts tests/__snapshots__/local-prompt.test.ts.snap
git commit -m "feat(local): LocalPromptAssembler — slim persona, frozen prefix, volatile tail"
```

---

### Task 5: Wire assembler + buckets into the router's Ollama branch; mid-loop bucket swap

**Files:**
- Modify: `src/providers/router.ts` (Ollama branch of `sendMessage`, ~lines 1010-1097)
- Modify: `src/providers/ollama.ts` (`runAgenticLoop`, unknown-tool handling)
- Create: `tests/local-wiring.test.ts`, `tests/local-buckets-registry.test.ts`

**Interfaces:**
- Consumes: `buildLocalSystemPrompt` (Task 4), `selectBucket`/`toolNamesForBucket`/`bucketForTool` (Task 3), `composeClaudeSystemPrompt` (Task 2, untouched).
- Produces: router keeps per-chat bucket state in `private chatBuckets = new Map<string, BucketId>()`; Ollama branch passes `allowedTools = toolNamesForBucket(bucket)` (unless skill/deliverable narrowing applies — those are narrower and win). `runAgenticLoop` gains registry-backed execution for out-of-set tool calls plus tool-set expansion.

- [ ] **Step 1: Write the failing wiring tests**

```typescript
// tests/local-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLocalTurnConfig } from '../src/providers/router.js';

// resolveLocalTurnConfig is the pure core of the Ollama-branch wiring:
// (message, currentBucket, skillAllowedTools, deliverableIntent) → {bucket, allowedTools, systemPromptIsLocal}
describe('local turn config', () => {
  it('bucket tools flow into allowedTools when no narrowing applies', () => {
    const r = resolveLocalTurnConfig('run a capacity analysis for the line', undefined, undefined, { isDeliverable: false });
    expect(r.bucket).toBe('manufacturing');
    expect(r.allowedTools).toContain('capacity_planning');
    expect(r.allowedTools).toContain('web_search'); // core included
    expect(r.allowedTools).not.toContain('github_list_repos'); // other bucket excluded
  });
  it('deliverable narrowing beats bucket tools', () => {
    const r = resolveLocalTurnConfig('generate the pdf', 'manufacturing', undefined, { isDeliverable: true, allowedTools: ['parse_file', 'generate_document'] });
    expect(r.allowedTools).toEqual(['parse_file', 'generate_document']);
  });
  it('skill allowlist beats bucket tools', () => {
    const r = resolveLocalTurnConfig('hello', undefined, ['web_search'], { isDeliverable: false });
    expect(r.allowedTools).toEqual(['web_search']);
  });
  it('bucket persists (hysteresis) via returned bucket', () => {
    const r = resolveLocalTurnConfig('ok continue', 'simulation', undefined, { isDeliverable: false });
    expect(r.bucket).toBe('simulation');
  });
});
```

```typescript
// tests/local-buckets-registry.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBuiltinTools } from '../src/providers/tools/index.js';
import { listRegisteredTools } from '../src/forge/tool-registry.js';
import { bucketForTool, CORE_TOOLS, BUCKET_TOOLS } from '../src/providers/local-buckets.js';

describe('bucket ↔ registry consistency', () => {
  beforeAll(async () => { await registerBuiltinTools(); });
  it('every bucket-listed name exists in the registry', () => {
    const registered = new Set(listRegisteredTools().map((t) => t.name));
    const listed = [...CORE_TOOLS, ...Object.values(BUCKET_TOOLS).flat()];
    const missing = listed.filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });
  it('every registered builtin tool is assigned to a bucket', () => {
    const unassigned = listRegisteredTools()
      .filter((t) => t.source === 'builtin')
      .filter((t) => bucketForTool(t.name) === undefined)
      .map((t) => t.name);
    expect(unassigned).toEqual([]);
  });
});
```

(If `registerBuiltinTools` has a different export name or needs DB stubs, mirror how existing tests in `tests/` bootstrap the registry — `grep -l registerBuiltinTools tests/` — and adapt the `beforeAll` accordingly; the two assertions stay exactly as written.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/local-wiring.test.ts tests/local-buckets-registry.test.ts`
Expected: FAIL — `resolveLocalTurnConfig` not exported; possibly registry-test bootstrap errors to fix per the note above.

- [ ] **Step 3: Implement `resolveLocalTurnConfig` in `router.ts` (module scope, exported)**

```typescript
import { selectBucket, toolNamesForBucket, type BucketId } from './local-buckets.js';
import { buildLocalSystemPrompt } from './local-prompt.js';

/** Pure core of the Ollama-branch turn wiring (exported for testing). */
export function resolveLocalTurnConfig(
  message: string,
  currentBucket: BucketId | undefined,
  skillAllowedTools: string[] | undefined,
  deliverableIntent: { isDeliverable: boolean; allowedTools?: string[] },
): { bucket: BucketId; allowedTools: string[] } {
  const bucket = selectBucket(message, currentBucket);
  if (deliverableIntent.isDeliverable && deliverableIntent.allowedTools) {
    return { bucket, allowedTools: deliverableIntent.allowedTools };
  }
  if (skillAllowedTools?.length) {
    return { bucket, allowedTools: skillAllowedTools };
  }
  return { bucket, allowedTools: toolNamesForBucket(bucket) };
}
```

- [ ] **Step 4: Wire the Ollama branch in `sendMessage`**

Add to the `ProviderRouter` class fields: `private chatBuckets = new Map<string, BucketId>();`

Replace the Ollama arm of the systemPrompt ternary (the array at ~line 1012) and the `effectiveAllowedTools` computation for the Ollama case:

```typescript
    let localTurn: { bucket: BucketId; allowedTools: string[] } | undefined;
    if (provider.name === 'ollama') {
      localTurn = resolveLocalTurnConfig(
        params.rawUserMessage ?? params.message,
        this.chatBuckets.get(chatId),
        allowedTools ?? undefined,
        deliverableIntent,
      );
      this.chatBuckets.set(chatId, localTurn.bucket);
      logger.info({ chatId, bucket: localTurn.bucket, toolCount: localTurn.allowedTools.length }, 'Local turn bucket selected');
    }

    const systemPrompt = provider.name === 'claude'
      ? composeClaudeSystemPrompt({ platformIdentity, voiceHint, systemPrompt: params.systemPrompt, skillPrompt, fullCapabilities, mfgHint, uploadsManifest, deliverableReminder, simulationScaffolding, languageOverride })
      : buildLocalSystemPrompt({
          bucket: localTurn!.bucket,
          skillPrompt,
          fullCapabilities,
          volatiles: {
            platformNote: `The user is chatting via ${platformName}.`,
            voiceHint, mfgHint, uploadsManifest, deliverableReminder,
            simulationScaffolding, languageHint: LANGUAGE_HINT, languageOverride,
            continuityAppend: '',
          },
        });
```

NOTE the ordering dependency: `deliverableIntent` is currently computed at ~line 1072, AFTER the systemPrompt composition — move the `const deliverableIntent = classifyDeliverableIntent(...)` block (and its log) ABOVE this composition. `effectiveAllowedTools` becomes: `provider.name === 'ollama' ? localTurn!.allowedTools : (deliverableIntent.isDeliverable ? deliverableIntent.allowedTools! : (allowedTools ?? undefined))`. `params.systemPrompt` for the Ollama path: append it into `volatiles.continuityAppend` slot is WRONG — instead pass it through unchanged via the existing provider param (`ollama.ts` folds `params.systemPrompt` + `systemPromptAppend` into `extraSystemPrompt`, which lands AFTER the assembled prompt — acceptable tail position; do not double-inject it in `buildLocalSystemPrompt`). Remove `params.systemPrompt` from the local assembler input entirely (it stays a provider-level append).

- [ ] **Step 5: Neutralize the old base persona on the assembled path in `ollama.ts`**

`runAgenticLoop` currently prepends `TOOL_MODEL_SYSTEM_PROMPT` (~line 453). The router now sends a complete system prompt via `params.systemPrompt` → `extraSystemPrompt`. Change the guard so the fat base persona is skipped when the router marks the prompt as assembled. Add to `SendMessageParams` (in `src/providers/types.ts`): `assembledSystemPrompt?: boolean;` — set `assembledSystemPrompt: true` in the router's Ollama `provider.sendMessage({...})` call. In `ollama.ts`:

```typescript
    const systemContent = params?.assembledSystemPrompt && extraSystemPrompt
      ? extraSystemPrompt
      : extraSystemPrompt
        ? `${TOOL_MODEL_SYSTEM_PROMPT}\n\n${extraSystemPrompt}`
        : TOOL_MODEL_SYSTEM_PROMPT;
```

(`runAgenticLoop` doesn't receive `params` today — thread a `assembled: boolean` argument through both `runAgenticLoop` and `runChatTurn` call sites instead if that's cleaner; keep the fallback branches so non-router callers and voice keep today's behavior.)

- [ ] **Step 6: Mid-loop bucket swap in `runAgenticLoop`**

Inside the tool-call execution loop (where each `msg.tool_calls` entry is dispatched, ~lines 540-612): the registry executes any known tool regardless of the schemas sent, so execution needs no change. After executing a call whose name is NOT in the current `tools` array, expand the set for subsequent iterations:

```typescript
      // Pipeline surgery: model called a registered tool outside the current
      // bucket's schema set (selector miss). Execute normally (registry knows
      // it) and widen the tool set so later iterations see its whole bucket.
      const sentNames = new Set(tools.map((t) => t.function.name));
      if (!sentNames.has(toolName)) {
        const bucket = bucketForTool(toolName);
        if (bucket) {
          const widened = getToolDefinitions(toolNamesForBucket(bucket));
          for (const def of widened) {
            if (!sentNames.has(def.function.name)) tools.push(def);
          }
          logger.info({ toolName, bucket }, 'Mid-loop bucket swap — widened tool set');
        }
      }
```

Imports at top of `ollama.ts`: `import { bucketForTool, toolNamesForBucket } from './local-buckets.js';`. Note `tools` is a parameter array — mutating it in place is intentional (same array is re-sent next iteration).

- [ ] **Step 7: Run all tests + full verify**

Run: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run smoke`
Expected: all green, including the Task 2 freeze snapshot (proves Claude branch untouched) and the registry-consistency test (fix bucket name lists if it fails — that's the test doing its job).

- [ ] **Step 8: Commit**

```bash
git add src/providers/router.ts src/providers/ollama.ts src/providers/types.ts tests/local-wiring.test.ts tests/local-buckets-registry.test.ts
git commit -m "feat(local): wire bucket pruning + assembled prompt into Ollama path, mid-loop bucket swap"
```

---

### Task 6: Context-budget backstop on the local path

**Files:**
- Modify: `src/providers/ollama.ts` (before the chat calls in `runAgenticLoop`)
- Test: `tests/local-budget.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` from `src/context-budget.ts` (exists, `context-budget.ts:79`).
- Produces: `capHistoryToBudget(history: Message[], systemTokens: number, maxInputTokens: number): { kept: Message[]; dropped: number }` exported from `src/providers/ollama.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/local-budget.test.ts
import { describe, it, expect } from 'vitest';
import { capHistoryToBudget } from '../src/providers/ollama.js';

const msg = (role: 'user' | 'assistant', chars: number) => ({ role, content: 'x'.repeat(chars) });

describe('local history budget backstop', () => {
  it('drops oldest messages first until history fits', () => {
    const history = [msg('user', 40000), msg('assistant', 40000), msg('user', 400), msg('assistant', 400)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(2);
    expect(kept).toHaveLength(2);
    expect(kept[0].content.length).toBe(400);
  });
  it('never drops the latest user message even if over budget', () => {
    const history = [msg('user', 100000)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
  });
  it('no-op under budget', () => {
    const history = [msg('user', 400), msg('assistant', 400)];
    const { kept, dropped } = capHistoryToBudget(history as never, 2000, 12000);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/local-budget.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement in `ollama.ts`**

```typescript
import { estimateTokens } from '../context-budget.js';

/** Pipeline surgery backstop: drop oldest history messages until
 * system + history fits maxInputTokens. Never drops the last message
 * (the current user turn). Exported for testing. */
export function capHistoryToBudget(
  history: Message[],
  systemTokens: number,
  maxInputTokens: number,
): { kept: Message[]; dropped: number } {
  const kept = [...history];
  let dropped = 0;
  const total = () =>
    systemTokens + kept.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
  while (kept.length > 1 && total() > maxInputTokens) {
    kept.shift();
    dropped++;
  }
  return { kept, dropped };
}
```

In `runAgenticLoop`, after `messages` is built (~line 461), apply it:

```typescript
    const LOCAL_MAX_INPUT_TOKENS = 12000; // spec target ≤10-12k; frozen prefix + schemas excluded from trimming by construction
    const sysTokens = estimateTokens(systemContent);
    const { kept, dropped } = capHistoryToBudget(history, sysTokens, LOCAL_MAX_INPUT_TOKENS);
    if (dropped > 0) {
      logger.info({ dropped, sysTokens }, 'Local budget backstop trimmed oldest history');
      messages.splice(1, messages.length - 1, ...kept);
    }
```

- [ ] **Step 4: Run tests + full verify** — `npx vitest run && npx tsc --noEmit && npm run lint` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/providers/ollama.ts tests/local-budget.test.ts
git commit -m "feat(local): token-budget backstop trims oldest history on the Ollama path"
```

---

### Task 7: Phase 1 gate — benchmark the slimmed pipe on .244

**Files:**
- Modify: `reference/kv-reuse-spike-2026-07.md` (append post-surgery numbers)
- Modify: `package.json` (rc bump)

**Interfaces:** none — this is the measurement gate. Requires Tasks 1-6 merged and the dev-stack image rebuilt.

- [ ] **Step 1: Build + deploy the branch build to a bench container** — `docker compose build luna` locally; run a one-off container with the dev `.env` but `TELEGRAM_ENABLED=false` (or equivalent poller-off flag — check `.env.example`; never double-poll prod).
- [ ] **Step 2: Re-run `scripts/bench-local-pipeline.mjs` scenarios THROUGH the real pipe** — send 4 messages via the running bot's local path (same bucket twice, bucket switch, agentic tool turn) against `.244`'s Ollama (or run the stack ON .244 — preferred; SSH access exists). Record Ollama server-side `prompt=` sizes from logs and wall-clock per turn.
- [ ] **Step 3: Evaluate the gate** — warm same-bucket turn <30s on ministral-3:3b: if PASS, append numbers + verdict to `reference/kv-reuse-spike-2026-07.md` and proceed. If FAIL, STOP — append numbers, then present the decision (qwen3.5:4b / smaller buckets / threshold change) to the user before any Phase 2 work.
- [ ] **Step 4: rc bump + commit**

```bash
npm version prerelease --preid=rc --no-git-tag-version
git add package.json package-lock.json reference/kv-reuse-spike-2026-07.md
git commit -m "chore(release): rc bump — pipeline surgery phase 1 benchmarked on .244"
```

---

### Task 8: Phase 2 — novalink-data pin in the router

**Files:**
- Modify: `src/providers/router.ts` (patterns + `getProviderForChat`), `src/config.ts`
- Test: `tests/novalink-pin.test.ts`

**Interfaces:**
- Produces: `NOVALINK_DATA_PATTERNS: RegExp[]` and `isNovalinkDataTurn(message: string): boolean` exported from `router.ts`; config key `NOVALINK_PIN_LOCAL` (default `true`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/novalink-pin.test.ts
import { describe, it, expect } from 'vitest';
import { isNovalinkDataTurn } from '../src/providers/router.js';

describe('novalink-data classification', () => {
  it('detects EN prod-data asks', () => {
    expect(isNovalinkDataTurn('how many open shortages does company 1054 have?')).toBe(true);
    expect(isNovalinkDataTurn('query the bom status for the AS line')).toBe(true);
  });
  it('detects ES prod-data asks', () => {
    expect(isNovalinkDataTurn('cuántos faltantes tiene la compañía este mes')).toBe(true);
  });
  it('detects explicit novalink/bridge mentions', () => {
    expect(isNovalinkDataTurn('check novalink for the latest PO receipts')).toBe(true);
  });
  it('does NOT match general chat or generic analysis', () => {
    expect(isNovalinkDataTurn('write me a poem about the ocean')).toBe(false);
    expect(isNovalinkDataTurn('analyze this essay for tone')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (not exported).

- [ ] **Step 3: Implement patterns + config**

In `router.ts`, next to `OLLAMA_TOOL_PATTERNS` (~line 608):

```typescript
/** Phase 2 pipeline surgery — data-governance pin. Turns that reason over
 * NovaLink production data stay on the LOCAL model (spec 2026-07-06).
 * Exported for testing. */
export const NOVALINK_DATA_PATTERNS = [
  /\bnovalink\b/i,
  /\b(bom|shortage|faltante|po receipts?|purchase order|orden de compra|wip\b|work order|orden de trabajo)\b/i,
  /\b(company|compa[ñn][ií]a)\s+\d+\b/i,
  /\b(production|producci[oó]n)\s+(data|status|numbers|datos|estado|cifras)\b/i,
  /\b(im_db|as_db|bridge)\b.*\b(quer|consult|check|revis)/i,
];

export function isNovalinkDataTurn(message: string): boolean {
  return NOVALINK_DATA_PATTERNS.some((p) => p.test(message));
}
```

In `src/config.ts`, alongside `AUTO_ROUTE` (~line 37): `NOVALINK_PIN_LOCAL: env.NOVALINK_PIN_LOCAL !== 'false',` and add `NOVALINK_PIN_LOCAL=true` (commented) to `.env.example`.

- [ ] **Step 4: Wire the pin into `getProviderForChat` (overrides stickiness)**

At the top of the `if (session?.auto_route && message)` block (~line 840):

```typescript
      // Phase 2 pin: NovaLink-data turns stay on-LAN, overriding both the
      // classifier and Claude-stickiness (data governance, spec 2026-07-06).
      if (config.NOVALINK_PIN_LOCAL && isNovalinkDataTurn(message)) {
        logger.info({ chatId }, 'novalink-data turn — pinned to local provider');
        this.lastUsedProvider.set(chatId, this.ollama.name);
        return this.ollama;
      }
```

- [ ] **Step 5: Run tests + full verify** — `npx vitest run && npx tsc --noEmit && npm run lint` → green. (Dormant in prod: `AUTO_ROUTE=false` bypasses this whole block.)

- [ ] **Step 6: Commit**

```bash
git add src/providers/router.ts src/config.ts .env.example tests/novalink-pin.test.ts
git commit -m "feat(router): pin novalink-data turns to local provider (NOVALINK_PIN_LOCAL)"
```

---

### Task 9: Phase 2 — soft Claude fallback with disclosure

**Files:**
- Modify: `src/providers/types.ts` (`AIResponse.failed?: boolean`), `src/providers/ollama.ts` (mark failures), `src/providers/router.ts` (fallback in `sendMessage`)
- Test: `tests/novalink-fallback.test.ts`

**Interfaces:**
- Produces: `AIResponse.failed?: boolean` (set by the Ollama provider's catch paths); `FALLBACK_DISCLOSURE` constant exported from `router.ts`:
  `⚠️ Answered via cloud fallback — local AI unavailable. / Respondido vía nube — IA local no disponible.`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/novalink-fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { shouldFallbackToClaude, FALLBACK_DISCLOSURE, applyFallbackDisclosure } from '../src/providers/router.js';

describe('soft fallback', () => {
  it('fallback fires only for failed local responses on pinned turns', () => {
    expect(shouldFallbackToClaude({ pinned: true, response: { text: 'Ollama error: connect ECONNREFUSED', provider: 'ollama', failed: true } })).toBe(true);
    expect(shouldFallbackToClaude({ pinned: true, response: { text: 'all good', provider: 'ollama' } })).toBe(false);
    expect(shouldFallbackToClaude({ pinned: false, response: { text: 'x', provider: 'ollama', failed: true } })).toBe(false);
  });
  it('disclosure is prefixed exactly once', () => {
    const out = applyFallbackDisclosure({ text: 'the answer', provider: 'claude' });
    expect(out.text!.startsWith(FALLBACK_DISCLOSURE)).toBe(true);
    expect(applyFallbackDisclosure(out).text!.match(/⚠️/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (not exported).

- [ ] **Step 3: Implement**

`src/providers/types.ts` — add to `AIResponse`: `/** Provider-level failure (timeout, unreachable, loop death) — enables router fallback. */ failed?: boolean;`

`src/providers/ollama.ts` — in the catch paths of `sendMessage` (both the timeout return ~line 373 and the generic error return ~line 381), add `failed: true` to the returned object.

`src/providers/router.ts`:

```typescript
export const FALLBACK_DISCLOSURE =
  '⚠️ Answered via cloud fallback — local AI unavailable. / Respondido vía nube — IA local no disponible.\n\n';

export function shouldFallbackToClaude(args: { pinned: boolean; response: AIResponse }): boolean {
  return args.pinned && args.response.failed === true;
}

export function applyFallbackDisclosure(response: AIResponse): AIResponse {
  if (response.text?.startsWith(FALLBACK_DISCLOSURE)) return response;
  return { ...response, text: `${FALLBACK_DISCLOSURE}${response.text ?? ''}` };
}
```

In `sendMessage`, the pin decision must be visible: have `getProviderForChat` record it — add field `private pinnedTurns = new Set<string>()`; in the pin branch (Task 8 Step 4) add `this.pinnedTurns.add(chatId)` (and `this.pinnedTurns.delete(chatId)` at the top of the auto-route block so it's per-turn). After the primary `provider.sendMessage(...)` call (~line 1089):

```typescript
    if (provider.name === 'ollama' && shouldFallbackToClaude({ pinned: this.pinnedTurns.has(chatId), response })) {
      logger.warn({ chatId, reason: response.text }, 'Pinned local turn failed — soft fallback to Claude');
      try {
        const fallback = await this.claude.sendMessage({
          ...params, message: effectiveMessage, systemPrompt: undefined, sessionId: undefined,
        });
        response = applyFallbackDisclosure(fallback);
      } catch (err) {
        logger.error({ err, chatId }, 'Cloud fallback also failed — returning local error');
      }
    }
```

(`systemPrompt: undefined` — the local assembled prompt must not leak to Claude; Claude's own branch prompt was built for `provider.name === 'claude'` only, and rebuilding it here is out of scope — the fallback turn runs with Claude's provider defaults, which the disclosure makes visible.)

- [ ] **Step 4: Run tests + FULL verify** — `npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run smoke` → all green, freeze snapshot still green.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/ollama.ts src/providers/router.ts tests/novalink-fallback.test.ts
git commit -m "feat(router): soft Claude fallback with bilingual disclosure for pinned local turns"
```

---

### Task 10: Ship — E2E, docs, rc bump, PR

**Files:**
- Modify: `package.json` + `package-lock.json` (rc bump), `PROJECT_PLAN.md` (add + tick a "Pipeline surgery" line under current work), `CLAUDE.md` only if commands changed (they didn't — skip).

- [ ] **Step 1: Full verification suite** — `npx tsc --noEmit && npm run lint && npx vitest run && npm run build && npm run smoke && docker compose build luna` → all green.
- [ ] **Step 2: Live E2E on the dev stack, local path** — bring the dev stack up with the Telegram poller pointed at a TEST bot token (never the prod token). Send: (a) a manufacturing-data question — verify bucket log line + local answer; (b) "generate a pdf summary" — verify docs bucket + deliverable flow; (c) with Ollama stopped and `AUTO_ROUTE` on, a novalink question — verify the ⚠️ fallback disclosure arrives. Capture the three replies in the PR description.
- [ ] **Step 3: rc bump** — `npm version prerelease --preid=rc --no-git-tag-version`.
- [ ] **Step 4: PR + merge on green CI** (standing rule; stage explicit paths only). PR body: benchmark table (pre/post from Task 7), the three E2E screenshots/replies, and the explicit note that prod behavior is unchanged until the user flips `AUTO_ROUTE=true`.
- [ ] **Step 5: Update memory** — update `luna-pipeline-surgery-plan.md` memory (status → shipped/dormant, gate numbers) and `luna-deploy-execution-status.md` (remaining-work list). The `AUTO_ROUTE` flip stays listed as the user's deliberate step.

---

## Self-Review (done at authoring time)

- **Spec coverage:** Phase 0 → Task 1; assembler/three layers → Task 4; buckets+selector+hysteresis+mid-loop swap → Tasks 3/5; prose diet → Task 4 (persona/rules) + Task 5 (doc-schema gating via bucket); Claude freeze → Task 2 (guard-first); budget backstop → Task 6; benchmark gate → Task 7; novalink pin + stickiness override → Task 8; soft fallback + disclosure + kill switch → Tasks 8/9; rollout/E2E → Task 10. Gap deliberately accepted: `n_keep` tuning is NOT planned (spec never committed to it; the spike decides if it's worth a follow-up).
- **Known drift risks flagged in-plan:** bucket name lists vs registry (Task 3 Step 5 + Task 5 registry test); `registerBuiltinTools` bootstrap shape (Task 5 note); import cycle `local-prompt ⇄ router` (Task 4 Step 5 escape hatch).
- **Type consistency:** `BucketId`, `resolveLocalTurnConfig`, `capHistoryToBudget`, `AIResponse.failed`, `FALLBACK_DISCLOSURE` used consistently across tasks; `assembledSystemPrompt` introduced once (Task 5) and used only there.
