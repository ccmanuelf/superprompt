# SAM on the Claude Path — Design Spec

**Date:** 2026-07-13
**Status:** Approved (follow-up session with Manuel; supersedes the local-path
routing posture of `2026-07-10-sam-pack-design.md` — that spec's pack, tools,
bucket, and policy remain as shipped in rc.135)
**Trigger:** Task 9 live smoke (2026-07-10) proved qwen3.5:4b fabricates SAM
data: 2 of 3 sam-bucket turns produced complete fake analyses tables with zero
tool calls in the audit log (ledger `.superpowers/sdd/progress.md`; memory
`novalink-sam-pack-status`). Ground truth: the only analysis is ID 3,
"Hoodie+Tank (from MANU sheet)", Bench Clearers, 51.148 min, draft.

## Decision (user-approved)

SAM data turns must not be answered by the local model by default. **Abort
beats fabricate**: quoting/billing numbers that are plausible-and-wrong are
worse than "temporarily unavailable."

1. SAM turns route to the **Claude provider**. If Claude is unavailable
   (quota, timeout, network), the turn **aborts** with a clear bilingual
   error — no silent fallback.
2. **`/sam claude | local | auto`** per-chat override (default `auto` =
   Claude-with-abort). Forced `local` is explicit opt-in (LAN-only reads
   during internet outages); forced modes abort if their path is down.
3. **Provenance footer** on every SAM turn: `— via Claude + SAM API` or
   `⚠️ via local model (forced) — unverified unless tools were called`.
4. Local anti-fabrication guard (forced-local mode only): a sam-bucket reply
   with **zero** `sam_*` executions this turn gets a loud
   "UNVERIFIED — no live SAM data was fetched" banner prepended.

Architectural fact recorded for posterity: `POST /analyses/generate` always
runs on the SAM server (server-side Claude, SAM's own credits) regardless of
Luna's path. Luna's path choice affects orchestration/presentation only. In a
real internet outage `generate` fails on BOTH paths; only LAN reads survive
(the forced-local use-case).

## Components

### 1. `docker/sam` shell wrapper (mirror of `docker/bridge`)

`claude -p` cannot see internal tools (SA3), so the Claude path calls SAM via
a pre-installed CLI. Bash + curl, bearer key from env, never logs the key.

```
sam health                          → GET /health + /whoami
sam search <kind> [querystring]     → GET /products|/analyses|/measured-times|/machines|/clients
sam get <id> [--full]               → GET /analyses/{id}   (--full keeps full_json)
sam create <client|product> <json>  → POST /clients|/products
sam generate <json>                 → POST /analyses/generate  (--max-time 180)
sam set-status <id> <status> [pct]  → PATCH /analyses/{id}
sam export <id>                     → GET /analyses/{id}/export.xlsx
                                      → writes /app/workspace/uploads/<ts>_sam-analysis-<id>.xlsx,
                                        prints the absolute path on stdout
```

- Env: `NOVALINK_SAM_URL`, `NOVALINK_SAM_API_KEY` (fail loudly if unset).
- kinds map exactly as `SEARCH_KINDS` in `src/providers/tools/sam.ts`
  (`measured_times` → `/measured-times`).
- Default `--max-time 30`; `generate` 180.
- Dockerfile install: plain `COPY` + `RUN chmod 755` (PR #21 BuildKit gotcha —
  never `COPY --chmod`). Destination `/usr/local/bin/sam`.

### 2. `src/providers/sam-prompt.ts` (mirror of `bridge-prompt.ts`)

Gated on both env vars; exports the block appended to the Claude-path system
prompt. Contents:
- Wrapper contract (subcommands, JSON shapes, error convention: read `detail`).
- §3 methodology (touch-SAM @15% PFD, §B1 dwell exclusion, three-layer
  minutes, provenance tiers, reconciliation, never invent figures, prefer the
  262 measured times).
- **Write confirmation rule:** `create` / `generate` / `set-status` require
  explicit user confirmation in-chat BEFORE invoking (wrapper calls bypass
  SA4 — same accepted tradeoff as bridge; the rule moves into the prompt).
- `generate` is slow (~60–120 s) + costs SAM-server credits: call once, never
  retry blind, prefer `persist=false` for exploration.
- After `sam export`, emit the file marker (below) so the workbook reaches
  the chat.
- Ingest redirect to the web UI (unchanged from pack.yaml).

### 3. Routing: SAM → Claude pin with abort

- Export the sam trigger regex from `src/providers/local-buckets.ts` (single
  vocabulary source — already adversarially probed) and add
  `isSamDataTurn(message)` in the router.
- Gate: only active when SAM env is configured.
- Behavior by per-chat mode (new `sam_route` column on sessions, mirroring
  `auto_route`):
  - `auto` (default) and `claude`: route the turn to the Claude provider.
    On Claude failure → **abort** with bilingual error:
    "⚠️ SAM is temporarily unavailable via Claude (EN) / SAM no está
    disponible vía Claude por el momento (ES) — retry shortly, or use
    `/sam local` for LAN-only reads (unverified)." Never fall through to
    the local model.
  - `local`: turn runs the existing local path (sam bucket, internal tools,
    SA4 confirmations apply). Zero-tool-call guard active (see 5).
- Precedence: the SAM pin is evaluated BEFORE `NOVALINK_DATA_PATTERNS`
  (a turn matching both is a SAM turn — data-quality wins; document inline).

### 4. `/sam` command (Telegram; mirror the `/auto` handler)

`/sam` → show current mode + one-line explanation of each.
`/sam claude | local | auto` → set `sessions.sam_route` for the chat.
Bilingual copy. No Matrix work (Matrix is OFF in prod).

### 5. Provenance footer + local guard

- Claude-path SAM turns: append `\n\n— via Claude + SAM API` to the reply.
- Forced-local SAM turns: append `\n\n⚠️ via local model (forced)`; if the
  turn executed zero `sam_*` tools (turn stats — same mechanism as the
  novalink fabrication guard), PREPEND
  "⚠️ UNVERIFIED — no live SAM data was fetched this turn. /
  NO VERIFICADO — no se consultó SAM en este turno." Detection is
  turn-scoped via the existing tool-stats plumbing.
- Footer keys on the turn being a SAM turn (`isSamDataTurn` or sam bucket
  selected), not on pack name strings in the reply.

### 6. File delivery marker (Claude path)

New mechanism, minimal: the Claude reply may contain `[send-file:<path>]`.
`telegram.ts` (same block that handles docgen):
- Extract marker(s); validate: path is absolute, resolves under
  `UPLOADS_DIR` (reject traversal), file exists.
- Send via `replyWithDocument(new InputFile(...))`, strip marker from text.
- Invalid/missing file → strip marker, log warn, deliver text (graceful).

### 7. Out of scope

- Removing the internal `sam_*` tools, the sam bucket, or SA4 policies
  (needed for forced-local mode + registry invariant).
- Matrix parity for file delivery.
- Auto-flip of the default based on accumulated reliability (evidence
  gathers via footer + logs; flipping stays a config/spec decision).

## SA4 / audit note

Wrapper calls are invisible to Luna's `AUDIT:` log (subprocess shell, same as
bridge). The SAM server's own request log is the audit trail for Claude-path
calls. Recorded, accepted.

## Verification

1. Unit: sam-prompt gating (env present/absent); `isSamDataTurn` routing pin
   incl. mode precedence and abort (mock Claude failure); footer/banner
   composition; `[send-file:]` parsing (valid, traversal, missing file).
2. Wrapper: bats-style shell check is overkill — verify in-container by
   executing each read subcommand against the live SAM API post-deploy.
3. Full gates: tsc, lint, vitest, build+smoke, docker build. rc.136. PR,
   merge on green.
4. Live re-smoke (browser agent): search must return **ID 3 / Hoodie+Tank /
   Bench Clearers / 51.148 min / draft** (ground truth); export must deliver
   a real .xlsx in chat; footer present; `/sam local` + a data question must
   show banner-or-tools behavior; simulated Claude outage → abort message
   (kill switch: temporarily unset OAuth token in a test container, or defer
   this leg to a documented manual test).

## Addendum (rc.137): pin recall

Live re-smoke (2026-07-13) found "What analyses are stored in SAM right
now?" dodged `SAM_TRIGGER_PATTERN`'s phrase-adjacency requirement and
answered unpinned. Fix: `SAM_ACRONYM_PATTERN`, a case-SENSITIVE uppercase
"SAM" + data/analysis-anchor co-occurrence regex (deliberately not `/i` — the
person name "Sam" must never match), combined with the existing pattern via
`matchesSamVocabulary`; the router pin now consumes the combined test. A
safety net (`finalizeUnpinnedSamLocalTurn`) also labels any local turn that
executed `sam_*` tools without being pinned (mid-loop widening or a residual
vocabulary miss) with an explicit unpinned-footer, so an unlabeled fabricated
SAM answer is no longer possible even on a pin miss. Residual accepted:
lowercase "sam" phrasings without one of the specific `SAM_TRIGGER_PATTERN`
phrases still miss the pin (by design — the person-name guard requires the
acronym to be uppercase).
