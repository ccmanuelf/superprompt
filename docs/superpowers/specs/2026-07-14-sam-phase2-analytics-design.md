# SAM Phase-2 Analytics + Multimodal Drafting — Design Spec

**Date:** 2026-07-14
**Status:** Approved (scope decisions with Manuel, 2026-07-14)
**Trigger:** SAM handoff v1.1 (received 2026-07-14, verbatim copy replaces
`reference/novalink-sam-handoff.md`): Phase-2 analytics endpoints are live
(review, line-balance/what-if/scenarios, estimate-sequence, cells suite),
plus a governed calc library, an admin-gated candidates queue, `generate-mm`
(multimodal tech-pack drafting), extended PATCH, and `machine-costs`.
**Builds on:** `2026-07-13-sam-claude-path-design.md` (rc.136/137 — SAM turns
run on the Claude path; wrapper + prompt contract; abort-over-fabricate).

## User decisions

1. **Hybrid wrapper**: named subcommands for hot flows + a generic
   `sam api <METHOD> <path> [json]` passthrough for the long tail and future
   endpoints (`/openapi.json` is the discovery surface). The AI-drafting
   commands that produce the full 20-section output stay first-class named
   commands (`sam generate`, `sam generate-mm`).
2. **generate-mm ships now, full flow**: user drops tech-pack images/PDF in
   Telegram → files land in `UPLOADS_DIR` (verified: photo handler downloads
   to uploads; Claude path receives file paths + an uploads manifest) →
   Claude calls `sam generate-mm … --file <path>…`.
3. **Library governance = read + staged flows only**: Luna reads `/library`
   freely, may run `candidates/scan` and PRESENT the review queue;
   approve / merge / reject / `PUT /library/*` / `PUT /machine-costs`
   require explicit per-item user confirmation in-chat (prompt-enforced,
   same mechanism as the existing write rule). "Luna presents, user decides."
4. **No local-path parity**: the internal `sam_*` tools and the sam bucket
   stay at v1.0 surface. Phase-2 analytics are Claude-path only by design
   (analytics interpretation on the 4B is the fabrication zone). Forced
   `/sam local` remains a LAN-reads fallback.

## Components (rc.138)

### 1. `docker/sam` wrapper v1.1 (append subcommands; style/flags unchanged: `-sS --fail-with-body`, key never echoed)

```
sam review <id> [--no-ai]            → POST /analyses/{id}/review?use_ai=true|false
sam balance <id> [querystring]       → GET  /analyses/{id}/line-balance[?qs]
sam balance-whatif <id> <json>       → POST /analyses/{id}/line-balance
sam scenarios <id>                   → GET  /analyses/{id}/scenarios
sam scenario-save <id> <json>        → POST /analyses/{id}/scenarios
sam estimate <json>                  → POST /estimate-sequence
sam cells                            → GET  /cells
sam cell <id>                        → GET  /cells/{id}
sam cell-create <json>               → POST /cells
sam cell-update <id> <json>          → PATCH /cells/{id}
sam cell-simulate <id> <json>        → POST /cells/{id}/simulate
sam cell-erv <id> <json>             → POST /cells/{id}/compute-erv
sam cell-export <id>                 → GET /cells/{id}/export.xlsx → uploads,
                                       prints path (same shape as sam export)
sam update <id> <json>               → PATCH /analyses/{id}  (operations[],
                                       balance_defaults, total_sam_min, …)
sam calc <operation|sequence|line-balance> <json> → POST /calc/{…}
sam library [querystring]            → GET /library
sam candidates-scan <json>           → POST /library/candidates/scan
sam candidates [querystring]         → GET /library/candidates?status=pending…
sam generate-mm <json> --file <path> [--file <path>]…
                                     → multipart POST /analyses/generate-mm
                                       (json fields → form fields via node;
                                       each --file → curl -F "files=@…";
                                       ≤8 files; --max-time 180)
sam api <METHOD> <path> [json]       → generic /api/v1 passthrough (any
                                       endpoint incl. candidates approve/
                                       merge/reject, PUT /library, PUT
                                       /machine-costs — all governed by the
                                       prompt confirmation rules)
```

`sam api` guards: METHOD whitelist GET|POST|PUT|PATCH (no DELETE unless SAM
ships one — then via spec update); path must start with `/`; body passed
through as-is when present.

### 2. `src/providers/sam-prompt.ts` v1.1 (condensed Analytics semantics, ~45 lines added; freeze snapshot regen)

- Named commands above + `sam api` for anything else in `/openapi.json`.
- Line-balance model: takt = available ÷ target; operators pooled by phase
  (Σsam ÷ takt, round UP); machines counted per type, decoupled from
  operators; staffing = direct → +uplift (Layer-1, default 15%, distinct
  from PFD) → +support (managers ceil(op÷ratio), technicians ceil(mach÷ratio),
  planners/QC/IE) = total_headcount. Omitted params use saved
  `balance_defaults`.
- Review: verdicts good/too strict/too relaxed/outlier; `use_ai=false` for
  the fast deterministic check.
- estimate-sequence: measured library first (tier VALIDATED); `match_score`
  = share of query information content matched; below `min_score` (0.35)
  stays `unmatched` — never force-match; `use_ai_for_gaps:true` fills with
  GSD/MOST at tier REFERENCE. Steps may be English or Spanish.
- Cells: ERV → capital recovery + AEMC = TAEF, MAR, P&L floor, stress test,
  partial-award via cell-simulate; `cell-erv` needs machine-costs rows
  (report `unmatched_types` honestly).
- Calc provenance: every result carries `method` + `tier`
  (validated > provisional > reference) — ALWAYS state both when presenting
  a SAM figure.
- Governance block: `/library` reads free; `candidates-scan` + presenting
  the queue free; **approve/merge/reject, PUT /library/*, PUT
  /machine-costs: only after explicit per-item user confirmation** ("match
  before create" — on high match_score recommend merge, never auto-approve;
  approvals never enter tier `validated`).
- generate-mm: files come from the uploads manifest paths (user-sent
  images/PDF, ≤8 files ≤12 MB each, png/jpg/webp/gif/pdf); slow (~60–120 s),
  server-side credits; `persist=false` for drafts. After `sam cell-export`
  or `sam export`, emit `[send-file:<path>]`.
- The existing write-confirmation rule extends to: `sam update`,
  `cell-create/update/simulate` (simulate is read-like — exempt),
  `cell-erv` with `apply:true`, `scenario-save`, and any mutating `sam api`.

### 3. Reference + docs

- `reference/novalink-sam-handoff.md` → replaced with v1.1 verbatim.
- CLAUDE.md SAM bullet: append "Phase-2 analytics (review/balance/cells/
  estimate/calc-library) are Claude-path only via the `sam` wrapper".
- pack.yaml capabilities: one line noting analytics live on the Claude path.

### 4. Vocabulary (small, safe): extend `SAM_ACRONYM_PATTERN` anchors

Add anchor words (still require uppercase `SAM` in the bounded window —
precision preserved): `[Tt]akt`, `[Bb]alanc\w*`, `[Vv]iab\w*`,
`[Ss]taffing`, `[Hh]eadcount`, `[Cc]ell\w*`, `[Cc]elda\w*`,
`[Ee]stimat\w*`, `[Ss]cenario\w*`, `[Ee]scenario\w*`.
Bucket vocabulary and `SAM_TRIGGER_PATTERN` unchanged. Standalone regex
probe (must-match incl. "run the SAM line balance", "SAM cell viability",
"takt time in SAM"; must-NOT-match incl. "Sam balanced the books",
"sam's cell phone", "SAMSUNG cell").

### 5. Out of scope

- Local-tool parity for Phase-2 (deliberate, §User decisions 4).
- `/ingest/workbook` via Telegram upload (generate-mm covers the drafting
  path; workbook standardization stays on the web UI).
- Matrix file delivery (pre-existing gap).
- UI panels (SAM team's roadmap, not Luna's).

## Verification

1. Unit: wrapper syntax (`bash -n`) + generate-mm form-building probe;
   sam-prompt content assertions (new commands, governance strings,
   provenance rule); acronym-pattern probes (new anchors, adversarial set);
   freeze snapshot regen scoped to the SAM block.
2. Gates: tsc, lint 0, full vitest, build+smoke, docker build. rc.138. PR,
   merge on green (final review first).
3. Live smoke (browser agent, ground truth = analysis ID 3):
   `sam review 3` verdict turn; `line-balance` turn (takt/operators for a
   named target); `estimate` with a 2–3 step list; generate-mm end-to-end:
   send a small test PDF via Telegram, ask for a draft with persist=false;
   confirm provenance footer on all; confirm a library-write request
   triggers the per-item confirmation ask (and DECLINE it — no mutation).
