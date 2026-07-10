# NovaLink SAM — Agent Handoff for Luna

> Received 2026-07-10 from the SAM team (Manuel Campos). Source of truth for the
> Luna-side integration; the pack implementing it is `packs/sam` +
> `src/providers/tools/sam.ts`. The API key is NOT in this file — it lives in
> `.env` (`NOVALINK_SAM_API_KEY`), injected by the operator from the SAM
> server's `app_keys.txt`.

**Document type:** System handoff / integration brief
**Audience:** the Luna agent (192.168.2.244) and its operator
**Version:** 1.0 · **Date:** 2026-07-10 · **Owner:** Manuel Campos, Head of Engineering, NovaLink
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

### Analyses
| Method | Path | Notes |
|--------|------|-------|
| GET | `/analyses?q=&client_id=&status=&limit=` | search across product name/description and operation text |
| GET | `/analyses/{id}` | full analysis incl. `operations[]` and `full_json` (20 sections) |
| POST | `/analyses` | store an analysis directly (fields + optional `operations[]` + `full_json`) |
| PATCH | `/analyses/{id}` | update `status` / `confidence_pct` / `full_json` |
| POST | `/analyses/generate` | **AI draft** — see below |
| GET | `/analyses/{id}/export.xlsx` | download the client-facing Excel workbook |

### Ingest
| Method | Path | Notes |
|--------|------|-------|
| POST | `/ingest/workbook?product_id=` | multipart file upload of a historical `.xls/.xlsx`; parses the Takt-Balance sheet into a standardized, stored analysis |

### `POST /analyses/generate` (AI drafting)
Body:
```json
{ "product_id": 12, "product_name": "Op Assault Pant", "client_name": "Born Primitive",
  "category": "Men's Tactical Pants", "input_text": "<tech-pack text / description / URL>",
  "model": null, "persist": true }
```
- Feeds the unified engine prompt + references to Claude and returns the drafted analysis (persisted when `persist=true`, returns `{"draft": …}` when `false`).
- **Latency ~60–120 s** (a full analysis) — set generous timeouts and do not retry prematurely.
- `product_id` must reference an existing product when `persist=true` (create the product first).

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

## 7. Roadmap (endpoints planned, not yet live)

These will appear in `/openapi.json` when built; design your integration to discover them:
- `POST /analyses/{id}/review` — verdict on an existing analysis: **good / too strict / too relaxed / outlier**, vs benchmarks + measured times.
- `GET /analyses/{id}/line-balance?daily_target=&shift_min=&efficiency=` — takt, operators, station grouping, bottlenecks (deterministic).
- `POST /estimate-sequence` — assign times to a supplied list of steps, anchored to the measured/GSD libraries.
- `POST /cells` — combine multiple products into a shared-cell / comparative rollup (consolidated SAM, viability, award-mix).

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
