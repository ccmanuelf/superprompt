# NovaLink SAM — Agent Handoff for Luna

> Received 2026-07-14 from the SAM team (Manuel Campos) — v1.1, replaces the
> 2026-07-10 v1.0 copy verbatim. Source of truth for the Luna-side
> integration; implemented by `packs/sam` + `src/providers/tools/sam.ts`
> (local v1.0 surface) and `docker/sam` + `src/providers/sam-prompt.ts`
> (Claude path, incl. Phase-2 analytics). The API key is NOT in this file —
> it lives in `.env` (`NOVALINK_SAM_API_KEY`), injected by the operator from
> the SAM server's `app_keys.txt`.

**Document type:** System handoff / integration brief
**Audience:** the Luna agent (192.168.2.244) and its operator
**Version:** 1.1 · **Date:** 2026-07-14 · **Owner:** Manuel Campos, Head of Engineering, NovaLink
**Status:** the SAM application is deployed, live, and verified.

---

## 1. Purpose & your role

**NovaLink SAM** is the system that produces **Standard Allowed Minute (SAM) analyses** — the labor-cost foundation NovaLink uses to (a) quote and win nearshore manufacturing prospects and (b) bill per-piece accounts correctly. It converts a product (tech pack, images, description, or an existing operation sequence) into a defensible, operation-by-operation SAM, plus production estimates, line balance, and costing.

**You, Luna, are a full user of this system** — the same access level as a human industrial engineer using the app directly. You can search and retrieve past analyses, browse the measured-time library, create and edit analyses, generate AI drafts, ingest historical workbooks, and export the client-facing Excel. You interact through a REST API; humans use the same API behind a web UI.

Treat SAM numbers as decisions that affect real quotes and invoices. Prefer NovaLink's own **validated measured data** over generic assumptions, always show your basis, and never invent figures.

---

## 2. Access & authentication

| | |
|---|---|
| **Base URL** | `http://192.168.2.234:8080` |
| **API root** | `http://192.168.2.234:8080/api/v1` |
| **Auth** | HTTP Bearer token — send header `Authorization: Bearer <LUNA_KEY>` on every request |
| **Your key** | the `luna_readwrite` value (read-write). Your operator injects it from the server's `app_keys.txt`; **it is a secret — never log or echo it.** |
| **Machine-readable API** | OpenAPI spec at `/openapi.json`; interactive docs at `/docs` |
| **Reachability** | LAN only (`192.168.2.0/24`); the database itself is never exposed |

Introspect the live contract at `/openapi.json` — it always reflects the current endpoints and schemas. This document explains the *meaning* behind them.

---

## 3. Domain model you must understand (so you interpret the numbers correctly)

- **SAM = touch-time only.** `total_sam_min` and each operation's `sam_min` are **operator motion time**, at a **15% PFD allowance** (`SAM = basic_time × 1.15`). This is NovaLink's standard — *not* the generic-industry 30%.
- **§B1 — machine dwell is excluded.** Machine cycle/dwell (auto cut-strip, press, heat/ultrasonic, EOL test) is **not** in SAM; it is capacity, reported separately. Charging machine time as labor is the #1 error ("slope inflation").
- **Three-layer minutes** (do not conflate them):
  1. **Touch SAM** — what the analysis reports.
  2. **Balance-adjusted labor** — line balancing rounds fractional stations up (1.3 → 2 operators).
  3. **Fully-loaded billed minutes** — touch SAM ÷ efficiency, plus indirect labor + overhead (Fair Wear LMPC: `cost/unit = (SAM ÷ efficiency) × factory-labour-minute-value`). This is why a ~49-min touch analysis can bill at ~130 loaded minutes.
- **Method branches:** textile/sewn → **GSD** codes; non-textile assembly (wire harness, mechanical) → **MOST/MODAPTS**.
- **Provenance & confidence tiers:** every rate is `[VALIDATED]` (time-study/measured), `[PROVISIONAL]` (method known, pace estimated), or `[REFERENCE]` (external). NovaLink shop-floor data overrides academic sources on conflict.
- **Measured-time library:** 262 validated stopwatch operation times (textile) are queryable via the API — these are the defensible anchors.
- **Two billing models:** per-piece (CM landed-cost) and shared-cell (head-count viability). **Reconciliation rule:** an analysis total must equal the sum of its per-operation times — never anchor a total to a prior/bundled figure.

The full analysis document has **20 sections** (schema in `schema/analysis_schema.json`), stored verbatim in each analysis's `full_json`.

---

## 4. API reference

All paths are under `/api/v1`. All require the bearer header. Times are minutes; JSON throughout.

### Meta
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness + row counts (no auth needed) |
| GET | `/whoami` | confirms your key/role (`{"role":"readwrite"}`) |

### Catalog
| Method | Path | Notes |
|--------|------|-------|
| GET | `/clients` | list clients |
| POST | `/clients` | `{name, notes?}` |
| GET | `/products?q=&client_id=&limit=` | **fuzzy search** on name/description/style — use this to *find a similar past product* |
| POST | `/products` | `{client_id, name, style_no?, category?, description?, base_size?, billing_model?, quoting_mode?}` |
| GET | `/machines` | canonical machine codes (e.g. SNLS, OL-5T-516) |
| GET | `/measured-times?q=&machine_code=&limit=` | **the validated stopwatch library** — search measured operation times |
| GET/PUT | `/machine-costs` | per-machine-type replacement cost (`{machine_type, replacement_cost, category?, notes?}`); drives cell ERV auto-compute. PUT upserts a list. |

### Analyses
| Method | Path | Notes |
|--------|------|-------|
| GET | `/analyses?q=&client_id=&status=&limit=` | search across product name/description and operation text |
| GET | `/analyses/{id}` | full analysis incl. `operations[]` and `full_json` (20 sections) |
| POST | `/analyses` | store an analysis directly (fields + optional `operations[]` + `full_json`) |
| PATCH | `/analyses/{id}` | update in place: `status` / `confidence_pct` / `full_json` / `balance_defaults` / `total_sam_min` / `operations[]` (replaces the operation set). Used to save an edited sequence without creating a duplicate analysis. |
| POST | `/analyses/generate`, `/analyses/generate-mm` | **AI draft** (text / text+image+PDF) — see below |
| GET | `/analyses/{id}/export.xlsx` | download the client-facing Excel workbook |

### Analytics (Phase-2)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/analyses/{id}/review?use_ai=true` | **re-validate** an analysis: deterministic benchmark-band + reconciliation check, plus an AI verdict `good / too strict / too relaxed / outlier` with flagged operations. `use_ai=false` for a fast deterministic-only check. |
| GET | `/analyses/{id}/line-balance?daily_target=&work_min=480&efficiency=0.85&shifts=1` | deterministic balance modelled on the manual Takt-Balance sheet. takt = available ÷ target; **operators pooled by phase** (Σ sam ÷ takt, rounded up), **machines counted per type** independently — the two are decoupled (machines may exceed operators). Returns `operators_by_phase[]`, `machines_by_type[]`, per-resource capacity/day, `line_output_per_day`, `bottleneck`, `line_efficiency`, `meets_target`. Omitting query params uses the analysis's saved `balance_defaults`. |
| POST | `/analyses/{id}/line-balance` | what-if: body `{config:{daily_target,work_min,efficiency,shifts, uplift_pct,mgr_ratio,tech_ratio,planners,qc,ie}, overrides:{operators:{"<phase>":n}, machines:{"<TYPE>":n}}}` → recomputes with your resource edits without saving. Response includes a `staffing` block: Layer-1 **direct uplift** (default 15% for handling/feeding/setup/thread — distinct from PFD) and Layer-2 **support** (managers = ceil(operators÷`mgr_ratio`), technicians = ceil(machines÷`tech_ratio`), planners, QC, IE; a role is off when its ratio/count is 0). Buildup: direct → +uplift → +support = `total_headcount`. |
| GET/POST | `/analyses/{id}/scenarios` | list / save named balance scenarios (config + overrides), e.g. "2 shifts @ 1500/day". |
| PATCH | `/analyses/{id}` | now also accepts `{balance_defaults:{...}}` to store default work-hours/shifts/efficiency/target for the analysis. |
| POST | `/estimate-sequence` | body `{steps:[{operation, machine?, length_cm?}], use_ai_for_gaps:false, min_score:0.35}` → assigns a time to each step from the **measured library** first (tier VALIDATED). Matching maps steps (English or Spanish) into a unified **concept space** and ranks by **IDF-weighted concept overlap**, so distinctive objects (collar/cuello) dominate over common verbs (attach/poner) — object-precise, not verb-fooled. Each step returns `match_score` (0–1 = share of the query's information content matched) and ranked `alternates`; steps below `min_score` (default 0.35) are left `unmatched` rather than force-matched. Set `use_ai_for_gaps:true` to have GSD/MOST fill unmatched steps (tier REFERENCE). |
| GET/POST | `/cells`, `GET /cells/{id}` | shared-cell **viability**. POST body `{name, client_id?, analysis_ids:[...], weekly_volumes:{"<id>": units_wk}}`. GET returns full viability: **equipment** (ERV→capital recovery + AEMC = TAEF, MAR, per-unit rates), **labor** (combined operators vs min-headcount floor, coverage), **management** floor (role table), **P&L** (revenue = labor + management + equipment; floor; weekly/annual surplus; viable?), and a **stress test** (remove each product → remaining coverage). Models the SharedCell PARAMETERS + CELL_VIABILITY sheet. |
| PATCH | `/cells/{id}` | update `params` blocks: `equipment` (erv, prior_recovery, recovery_years, maintenance_rate, mar_threshold), `labor` (min_headcount, weekly_hours, hourly_rate, efficiency, weeks_year), `management` (role table), `overrides` (per-analysis `revenue_wk` / `equip_fee_unit`). |
| POST | `/cells/{id}/simulate` | partial-award: body `{included_analysis_ids:[...]}` → recomputes viability for that subset. |
| POST | `/cells/{id}/compute-erv` | auto-compute ERV = Σ(machines needed × replacement cost) across the cell's products + optional `other_equipment` lump. Body `{work_min,efficiency,shifts,days_per_week,other_equipment,apply}`; `apply:true` writes ERV into cell params. Returns per-type breakdown + `unmatched_types` (machine types with no cost row). |
| GET | `/cells/{id}/export.xlsx` | client-facing shared-cell workbook: Cell Summary (P&L, equipment recovery, per-unit cost), Products (incl. labor & total cost/unit), Stress Test, Parameters. |

### Ingest
| Method | Path | Notes |
|--------|------|-------|
| POST | `/ingest/workbook?product_id=` | multipart file upload of a historical `.xls/.xlsx`; parses the Takt-Balance sheet into a standardized, stored analysis |

### Calc library (governed multi-method engine)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/library` | the full live calculation library: `length_bands`, `machines`, `fabrics`, `categories`, `operations`, `multipliers`, `consts`. This is the DB-backed, governed source of truth for every calculation — **live and growing**. |
| PUT | `/library/{table}` | upsert rows into a library table (`operations`, `machines`, `fabrics`, `length_bands`, `categories`, `multipliers`, `machine_catalog`, `machine_costs`; `measured_times` is update-only). Admin/API-key only. Every write bumps a DB cache version so all server workers reload instantly. |
| POST | `/calc/operation?allowance_pct=15` | compute one operation. Body is a row: `{op_id, machine_id?, fabric_id?, length_band?, length_in?, folder?, plies?, mixed_material?, feed_type?, difficulty_pct?, rep_count?}`. Returns `unit_min`, `sam_min`, `method`, `tier`, `source`, `measured_ref?`, `conformance`, `benchmark`, and a step-by-step `math[]`. |
| POST | `/calc/sequence` | body `{rows:[...], allowance_pct}` → each row calculated, plus `total_sam_min`. Rows carry `method`/`tier`/`source`/`measured_ref` for provenance. |
| POST | `/calc/line-balance` | **stateless** balance over ad-hoc rows (no saved analysis): body `{rows:[{sam_min, phase, machine_id}], config:{...}, overrides:{...}}` → same output as `/analyses/{id}/line-balance` incl. `staffing`. |

**Three calculation methods, one model** (an operation's `method` column selects it):
- **`gsd`** — band-anchored sewing/fixed/manual: `base = handle(band×folder) + sew(rate/in × inches × fabric) + dispose`, × plies × mixed(1.08) × feed × duty × difficulty × rep, then × (1+allowance). Length anchors to the band's 75th-pct unless a positive `length_in` is given.
- **`most` / `modapts`** — non-textile assembly/wiring: time = `base_min` × difficulty × rep, then × (1+allowance). 13 grounded ops are seeded (`wiring`, `mech_assembly` categories).
- **measured anchor** — if an operation's `measured_ref` points at a validated `measured_time_study` row, that standard **wins** (it already carries the allowance; only difficulty/rep apply). `source:"measured"`, `tier:"validated"`.

**Provenance:** every calc returns `method` (gsd/most/modapts/measured) and `tier` (`validated` > `provisional` > `reference`). Prefer higher-tier results; when presenting a SAM, state its method and tier. To **promote** a rate, `PUT /library/operations` with a raised `tier` and/or a `measured_ref` link.

### Library growth from AI analyses (admin-gated review queue)
AI-generated operations **never** write to `sam.lib_operation` directly — they are staged and approved.
| Method | Path | Notes |
|--------|------|-------|
| POST | `/library/candidates/scan` | body `{analysis_id}` → matches each of the analysis's operations against the library (token overlap) and stages them in `sam.lib_op_candidate` (deduped by name). Admin only. |
| GET | `/library/candidates?status=pending` | review queue: each candidate carries `raw_name`, `proposed_sam`, and `match_op_id` + `match_score` (closest existing op). |
| POST | `/library/candidates/{id}/approve` | body `{op_id, method, tier?(default provisional), cat, es, en, machine?, def_band?, base_min?}` → creates the governed `lib_operation` (GSD computes from band+machine; MOST/MODAPTS uses `base_min`). Admin only. Never enters `validated`. |
| POST | `/library/candidates/{id}/merge` | body `{into_op_id}` → mark as duplicate of an existing op (no new row). |
| POST | `/library/candidates/{id}/reject` | discard. |

Rule: **match before create.** On a high `match_score`, merge rather than approve, or you get near-duplicate ops with divergent times.

### AI analysis engine (`POST /analyses/generate` · `POST /analyses/generate-mm`)
Engine model defaults to **`claude-opus-4-8`** (best methodology + tech-pack vision); light helpers (review, gap-fill) stay on Sonnet. Output is capped at 32k tokens with a JSON-salvage fallback.

- **`/analyses/generate`** (JSON) — text-only draft. Body: `{product_id, product_name, client_name?, category?, input_text, model?, persist?}`. `persist=false` returns `{"draft": …}`.
- **`/analyses/generate-mm`** (multipart form) — **text and/or tech-pack files**. Form fields: `product_id, product_name, client_name?, category?, input_text?, model?` plus one or more `files` (images `png/jpg/webp/gif` or `application/pdf`, ≤12 MB, ≤8 files). Opus reads specs/measurements straight from the images/PDF.
- Both return the full persisted analysis (20-section `full_json` + `operations[]`); `section_02_operations` may be a list or `{operations:[...]}`.
- **Latency ~2–6 min** (was ~60–120 s before SAM moved its AI legs to the subscription backend, `claude -p`) — generous timeouts, no premature retries. `product_id` must exist when `persist=true`.

---

## 5. Common workflows

**Find whether we've quoted something similar**
`GET /products?q=cargo pant` → `GET /analyses?client_id=…` or `GET /analyses?q=cargo` → `GET /analyses/{id}`.

**Draft a new analysis from a tech pack**
Ensure a client + product exist (`POST /clients`, `POST /products`) → `POST /analyses/generate` with the tech-pack text → review `operations[]` and `total_sam_min` → `PATCH` status to `review`/`approved` → `GET …/export.xlsx`.

**Standardize an old manual workbook**
`POST /ingest/workbook?product_id=…` with the file → returns a stored analysis you can then review/edit.

**Look up a defensible measured time**
`GET /measured-times?q=bastillar&machine_code=SNLS` — use these validated values to sanity-check or anchor an estimate.

---

## 6. Etiquette & guardrails

- You hold a **read-write** key: create/edit freely, but keep the data clean (meaningful product names, correct client links). Use `persist=false` on `generate` for exploratory drafts you don't want stored.
- Respect the methodology in §3 when interpreting or presenting results — especially touch-SAM vs loaded minutes, the 15% allowance, and §B1.
- `generate` is slow and costs API credit; batch thoughtfully, don't poll-spam.
- On any error, read the JSON `detail`; the OpenAPI spec at `/openapi.json` is authoritative for shapes.
- The database is never directly reachable — the API is the only surface (by design).

---

## 7. Roadmap

The four Phase-2 analytics endpoints (review, line-balance, estimate-sequence, cells) are **now live** — see §4 Analytics. Planned next:
- Richer cell **viability / capital-recovery** (ERV, MAR, partial-award simulation) on top of the `/cells` rollup.
- UI panels surfacing review and line-balance for human analysts (the API is already usable by you now).

---

## 8. Quick reference (curl)

```bash
B=http://192.168.2.234:8080/api/v1
H="Authorization: Bearer $LUNA_KEY"
curl -s -H "$H" "$B/whoami"
curl -s -H "$H" "$B/analyses?q=pant&limit=10"
curl -s -H "$H" "$B/measured-times?q=coser&limit=10"
curl -s -H "$H" -H "Content-Type: application/json" -X POST "$B/analyses/generate" \
  -d '{"product_id":12,"product_name":"Demo Tee","input_text":"basic crew tee…","persist":false}'
```

*End of handoff. Source of truth for the system internals: `NovaLink-SAM-System/00_README.md` and `NovaLink_SAM_Project_Brief.md`.*
