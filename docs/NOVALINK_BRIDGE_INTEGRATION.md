# NovaLink Bridge — Integration Spec

**Status:** PLANNED. Not yet integrated. The bridge runs today as a Replit-hosted prototype at `https://data-connect-bridge-mcamposcerda.replit.app/` and exposes SQL-over-HTTP. The integration described here moves it to a same-VM Docker sidecar alongside Luna, adds typed REST endpoints as the primary integration path, and keeps SQL-over-HTTP as an admin-only escape hatch.

**Scope:** NovaLink only. The bridge connects to NovaLink's internal MariaDB systems (IM_DB, AS_DB) and is the data plane behind the `/hub` and BOM-related slash commands. Other Luna deployments do not need this pack.

**Codebase under analysis:** `~/Documents/Programming/novalink-bridge/DataConnectBridge` (Replit export, ~83K LOC, 87 TS files). Will live as its own repo once a remote name is decided (proposed: `ccmanuelf/novalink-bridge`).

---

## 1. Executive summary

The NovaLink bridge is a Node + TypeScript + Express + React app that sits in front of two MariaDB instances (`IM_DB` for BOM/parts, `AS_DB` for AppSynergy operational data) and exposes them over HTTP with API-key auth, rate limiting, SQL safety scanning, and multi-tier caching. It includes a full BOM business-logic layer (1,506 LOC in `BomService` with 11 typed methods: `getBom`, `listBoms`, `getBomRevisions`, `createBom`, `modifyBom`, `validateBom`, `updateBomStatus`, `getBomStatus`, `getPartInfo`, `searchParts`, `checkHealth`).

Today it ships only `GET /api/query/:database` (raw SQL execution) and `POST /api/multi-query`. The typed `BomService` methods exist but are not wired to routes. The integration plan calls for **wiring typed REST endpoints that delegate to the existing `BomService`**, plus a new `InventoryService` for stock/availability data, then having Luna call those typed endpoints from a new `packs/novalink/` deployment-scoped pack.

Why this is the right shape:

- **Smallest attack surface.** Typed endpoints eliminate the prompt-injection → SQL-injection class entirely. The LLM only does what we expose.
- **Smaller LLM burden.** No DDL in the system prompt, no schema-discovery dance. Five typed tools the model invokes by name.
- **Server-side joins, server-side caching, stable cache keys.** Performance and cost dominate any flexibility lost.
- **The escape hatch is preserved.** SQL-over-HTTP stays available behind an admin-only `/novalink-sql` Luna command for ad-hoc analyst work.

The bridge code is reusable as-is. No rewrite. The integration is mostly route wiring (bridge side) plus a small adapter pack (Luna side).

---

## 2. Current state (Replit prototype)

| Aspect | Value |
|-|-|
| Host | Replit free tier — `https://data-connect-bridge-mcamposcerda.replit.app/` |
| Stack | Node 20 + TypeScript + Express 4.21 + React 18 + Vite 5 + Drizzle ORM 0.39 |
| Listen port | `5000` (hardcoded in `server/index.ts:72`, "the only port not firewalled" on Replit) |
| Auth | API key via `X-API-Key` header. Granular permissions per key. |
| Rate limit | Per-minute and per-hour (configurable). |
| Routes today | `GET /api/health`, `GET /api/query/:database?sqlCmd=...`, `POST /api/multi-query`, `GET /api/test/:format/:database`, `GET /api/test-write/:database`, `GET /api` (info), `POST /api` (admin), `GET /docs` (frontend) |
| Backend DBs | `IM_DB` (MariaDB, port 3306, BOM and parts data — direct SSL connection), `AS_DB` (MariaDB, port 3306, AppSynergy data — REST API with direct-connection fallback) |
| Metadata DB | PostgreSQL via Neon serverless. Tables: `db_connections`, `api_keys`, `api_logs`, `cache_entries`, `bom_queries` |
| SQL safety scanner | Blocks `DROP`, `DELETE`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `CREATE`, `INSERT`, `UPDATE` (read-only enforcement) |
| Cache backends | Redis / file / memory / disabled (configurable) |
| Test files at root | `test_all_csv_connections.mjs`, `test_api_formats.mjs`, `test_as_db_formats.mjs`, `test_csv_format.mjs`, `test_csv_format_internal.mjs`, `test_db_connections.mjs` |

Why temporary: Replit free tier has cold starts (~15-30s wake-up after idle), no SLA, public surface, and the 5000-port-only constraint forces us to expose the whole thing publicly even though Luna is the only intended consumer.

---

## 3. Target architecture

### 3.1 Same-VM topology

When the deployment VM is provisioned (currently pending), Luna and the bridge run as separate services in the same `docker-compose.yml`:

```
docker-compose.yml (Luna repo)
├── luna                  # rc.95 image, this repo
├── speaches              # voice STT/TTS
├── searxng               # web search
├── novalink-bridge       # NEW — built from ccmanuelf/novalink-bridge
└── novalink-postgres     # NEW — local Postgres for bridge metadata
                          # (replaces Neon serverless)
```

**Network model:**

- All services on Luna's existing internal `luna-network` Docker bridge.
- `novalink-bridge` reachable from Luna at `http://novalink-bridge:5000` (internal hostname). **No host-port publish** — the bridge is internal-only.
- `novalink-postgres` reachable from `novalink-bridge` at `novalink-postgres:5432`. Same internal-only treatment.
- The bridge container outbound-connects to **IM_DB and AS_DB** (NovaLink internal MariaDB instances). Connectivity assumed to exist on the VM's internal network. Confirmed prerequisite — see §10.

### 3.2 ASCII diagram

```
                  ┌──────────────────────────┐
                  │  Telegram / Matrix /     │
                  │  Web UI (browser)        │
                  └──────────────┬───────────┘
                                 │
                  ┌──────────────▼───────────┐
                  │  luna container          │
                  │  (rc.95+, packs/novalink │
                  │   adapter + 5 tools)     │
                  └──────────────┬───────────┘
                                 │  HTTP w/ X-API-Key
                                 │  internal docker net
                  ┌──────────────▼───────────┐
                  │  novalink-bridge         │
                  │  Express :5000           │
                  │  - typed /api/bom/...    │
                  │  - typed /api/parts/...  │
                  │  - typed /api/inventory/.│
                  │  - SQL escape hatch      │
                  │    /api/query/:database  │
                  └──┬─────────────┬──────┬──┘
                     │             │      │
   metadata DB  ◄────┘             │      └─────► AS_DB
   (Postgres,                      │              (MariaDB,
    api keys,                      │               AppSynergy,
    logs, cache)                   │               REST + direct
   novalink-postgres:5432          │               failover)
                                   │
                                   ▼
                                 IM_DB
                                 (MariaDB, BOM,
                                  parts — direct
                                  SSL on port 3306)
```

### 3.3 Why local Postgres (not Neon)

Decision: bridge metadata DB moves from Neon serverless to a local `postgres:16-alpine` container in the same compose stack.

| Concern | Neon | Local Postgres container |
|-|-|-|
| External dependency | One more SaaS to manage / audit / pay for | None |
| Network egress | Bridge → public internet → Neon | Bridge → internal docker net → Postgres |
| Latency | ~30-100ms per metadata read | <1ms |
| Audit story | "Where do API key hashes live?" → external | "Where do API key hashes live?" → on the same VM |
| Cost at scale | Neon free tier limits, then paid | Container CPU/RAM only |
| Cost: switching now | Drizzle config change + driver swap (`@neondatabase/serverless` → `pg`) + initial schema push | One-time |

The bridge's Drizzle schema works on standard Postgres without modification. The driver swap is a `package.json` and `server/db/index.ts` change, ~30 lines.

---

## 4. Data scope

The bridge exposes data from two NovaLink-internal MariaDB systems. **Read-only** for Luna's purposes — the bridge's SQL safety scanner enforces this regardless of what the LLM tries.

### 4.1 IM_DB — Internal Management

Holds BOM and parts data. Direct MariaDB connection over SSL. The bridge knows this database well — `BomService` is built around it.

Known surfaces (from `BomService` typed methods):
- BOM headers and lines (per-part-number, per-company)
- BOM revision history (multiple revisions per part)
- BOM approval status workflow
- Part metadata (descriptions, units of measure, weights, costs)
- Part search (fuzzy matching against part numbers and descriptions)

**Inventory data is also in IM_DB**, but the exact tables/columns are not yet documented in the bridge. Discovery item — see §10.

### 4.2 AS_DB — AppSynergy

Operational data for the manufacturing floor. Primary access via AppSynergy REST API; falls back to direct MariaDB connection if the API is unavailable.

Currently exposed only via the SQL-over-HTTP route. No typed `AppSynergyService` exists in the bridge. Adding typed endpoints for AS_DB is a future increment, not part of the initial integration.

### 4.3 Metadata (PostgreSQL)

Internal to the bridge — Luna does not access this directly. Holds: `db_connections` (config), `api_keys` (hash + permissions per key), `api_logs` (audit), `cache_entries` (multi-tier cache backing), `bom_queries` (BOM result cache keyed by part+company+revision+queryHash).

---

## 5. Integration design

### 5.1 Typed endpoints (PRIMARY path — bridge work needed)

Five new routes wire the existing `BomService` plus a new `InventoryService`:

| Method | Path | Bridge implementation |
|-|-|-|
| GET | `/api/bom/:companyId/:partNumber` | `BomService.getBom(partNumber, companyId, revision?)` |
| GET | `/api/bom/:companyId/:partNumber/revisions` | `BomService.getBomRevisions(partNumber, companyId)` |
| GET | `/api/parts/:companyId/:partNumber` | `BomService.getPartInfo(partNumber, companyId)` |
| GET | `/api/parts/:companyId/search?q=...&limit=20` | `BomService.searchParts(companyId, query, limit?)` |
| GET | `/api/inventory/:companyId/:partNumber` | New `InventoryService.getInventoryStatus(...)` — needs IM_DB schema discovery first |

Estimated bridge work: 1 file (`server/routes-typed.ts`) + 1 new service file for inventory + tests. ~300 LOC total. The `BomService` methods exist; we just call them from new routes with auth + validation middleware.

Auth on these routes: same `X-API-Key` enforcement that the existing `/api/query` route uses.

Response shape: existing `ApiResponse<T>` envelope from `shared/types.ts`:

```typescript
interface ApiResponse<T> {
  status: "OK" | "ERROR";
  data?: T;
  error?: { code: ErrorCode; message: string; details?: Record<string, any> };
}
```

### 5.2 SQL-over-HTTP escape hatch (RETAINED, gated)

`GET /api/query/:database?sqlCmd=...` stays as-is on the bridge. **Not exposed to Luna's LLM auto-invoke.** Reachable from Luna only via an explicit slash command:

- Telegram: `/novalink-sql <database> <sql>`
- Matrix: `!novalink-sql <database> <sql>`
- Web: not exposed

**Role-gated.** The command checks the caller's role against an env var `NOVALINK_SQL_ALLOWED_ROLES` (default: `admin`). Roles use the existing `user_roles` table from the attendance pilot (rc.88+). The list is comma-separated so it can grow without code changes:

```bash
# Default: admin only.
NOVALINK_SQL_ALLOWED_ROLES=admin

# Future expansion if/when needed:
# NOVALINK_SQL_ALLOWED_ROLES=admin,senior_engineer
```

If the caller does not have any of the listed roles, the command replies with the bilingual "you don't have permission" message and the bridge is never called.

### 5.3 Luna-side adapter — `packs/novalink/`

New deployment-scoped pack. Lives under `packs/novalink/`, follows the existing pack structure (manifest + index + tools + tests + awareness).

```
packs/novalink/
├── manifest.json              # name, version, level: 2, intent_keywords
├── index.ts                   # pack registration + capability prompt
├── awareness.ts               # registerFeature() — teaches Luna
├── client.ts                  # HTTP client wrapping fetch with retries + timeout
├── tools/
│   ├── get-bom.ts             # → GET /api/bom/:companyId/:partNumber
│   ├── get-bom-revisions.ts   # → GET /api/bom/:companyId/:partNumber/revisions
│   ├── get-part-info.ts       # → GET /api/parts/:companyId/:partNumber
│   ├── search-parts.ts        # → GET /api/parts/:companyId/search?q=...
│   └── get-inventory-status.ts # → GET /api/inventory/:companyId/:partNumber
└── tests/
    ├── client.test.ts         # adapter behavior with nock-mocked bridge
    └── tools.test.ts          # each tool's input/output shape

src/platforms/telegram.ts        # add /novalink-sql command (admin role check)
src/platforms/matrix.ts          # add !novalink-sql parity
```

**Pack capability prompt** (~200 words appended to the system prompt when the chat has the pack subscribed):

> NovaLink data access. You can query BOM, part, and inventory information for NovaLink companies via the following tools:
>
> - `get_bom(company_id, part_number, revision?)` — full BOM tree
> - `get_bom_revisions(company_id, part_number)` — revision history
> - `get_part_info(company_id, part_number)` — metadata, weight, cost
> - `search_parts(company_id, query, limit?)` — fuzzy part search
> - `get_inventory_status(company_id, part_number)` — current stock
>
> All tools accept `company_id` (e.g. "ACME") and a part number. Responses are typed JSON with `status: "OK"` and a `data` payload. On errors, surface the bridge's `error.message` to the user verbatim — those are written for human readers.
>
> For ad-hoc SQL queries, advise the user to run `/novalink-sql` themselves (admin only). Do NOT compose SQL yourself.

**Env vars added on Luna's side:**

```bash
# Required when packs/novalink/ is subscribed.
NOVALINK_BRIDGE_URL=http://novalink-bridge:5000
NOVALINK_BRIDGE_API_KEY=...                    # generated by bridge admin
NOVALINK_BRIDGE_TIMEOUT_MS=30000

# Role gate for the SQL escape hatch slash command.
NOVALINK_SQL_ALLOWED_ROLES=admin
```

**Client behavior** (`packs/novalink/client.ts`):

- One `fetch` call per tool invocation, no retries on 4xx (auth/permission/not-found stay errors).
- One automatic retry on 5xx and timeout, with 1-second backoff. Beyond that, surface `BRIDGE_UNREACHABLE` to the model so it can apologize cleanly instead of hanging.
- All requests include `X-API-Key`. Never logged in plaintext (use the existing `redact()` helper from `src/logger.ts`).
- Telemetry: increment a `novalink_bridge_calls` counter (optional rc.97+; not blocking initial integration).

### 5.4 Policy-engine classification (SA4)

| Tool | Risk level | Confirmation? | Why |
|-|-|-|-|
| `get_bom` | medium | no | Read-only, structured. Bridge enforces SQL safety. |
| `get_bom_revisions` | medium | no | Same. |
| `get_part_info` | medium | no | Same. |
| `search_parts` | medium | no | Bounded-result search. |
| `get_inventory_status` | medium | no | Same. |
| `/novalink-sql` slash command | high | **yes (always)** | Free-form SQL, even with bridge's read-only scanner. Confirmation gate per the policy engine's high-risk pattern. |

### 5.5 What does NOT change

- `src/providers/router.ts` does not need changes. Tools are registered through the pack-loading path.
- `src/db-core.ts` does not need changes. The pack does not persist anything in Luna's local DB.
- The Claude path is unchanged. Claude doesn't call Ollama-style tools, so the NovaLink tools are Ollama-only — Claude users get the data via the slash command escape hatch or by switching providers.

---

## 6. Security model

### 6.1 Attack surface analysis

**Without typed endpoints (status quo SQL-over-HTTP):**

1. Prompt injection makes the LLM emit a SELECT against pricing or supplier-cost tables. *Mitigation: bridge SQL scanner doesn't block reads, so this is not blocked at the bridge.*
2. Prompt injection makes the LLM emit a UNION attack to leak schema. *Mitigation: SQL scanner allows arbitrary SELECT.*
3. Prompt injection makes the LLM run a DROP. *Mitigation: bridge scanner blocks. ✓*

**With typed endpoints + admin-only escape hatch:**

1. *Eliminated.* The LLM has no SQL surface. It can only call 5 typed tools by name, each of which calls a typed bridge service that knows what to query.
2. *Eliminated.* Same.
3. *Same protection.* Plus the LLM can no longer reach `/api/query` regardless of intent.

### 6.2 Defense in depth

- **Bridge layer**: API-key auth, rate limiting, SQL safety scanner (blocks writes), connection pooling with timeouts, CORS lockdown to internal hostname only.
- **Luna pack layer**: Tool inputs validated at the pack-tool level (zod schemas), retries bounded, redaction in logs, role gate on the SQL escape hatch.
- **Network layer**: Bridge container has no published host port. Reachable only from inside the docker network.
- **Audit**: Bridge writes per-request logs to `api_logs` (Postgres). Luna writes per-tool-call entries via the existing audit logger.

### 6.3 Secrets & rotation

| Secret | Where | How to rotate |
|-|-|-|
| `NOVALINK_BRIDGE_API_KEY` | Luna `.env` | Generate new key via bridge admin UI / `POST /api/keys`. Update Luna `.env` (use `sed -i ''` to keep secrets out of any tool transcript). `docker compose up -d --force-recreate luna`. Revoke old key on the bridge afterwards. |
| Bridge admin API key | Bridge `.env` (separate from Luna's) | Bridge has its own `register_test_key.mjs` script and admin UI. Out of scope for this doc. |
| Postgres metadata DB password | Bridge `.env` | Standard Postgres password rotation; restart `novalink-bridge` to pick up. |
| MariaDB credentials (IM_DB / AS_DB) | Bridge `.env` | Coordinate with NovaLink DBA team; restart bridge. |

---

## 7. Migration plan: Replit → same-VM

Sequential. Each step is independently revertable.

### Phase 0 — Pre-work (no VM needed)

- [ ] Push `~/Documents/Programming/novalink-bridge/DataConnectBridge` to GitHub as `ccmanuelf/novalink-bridge` (or chosen name). Strip `.replit` config and Replit-specific `vite-plugin-cartographer` / `vite-plugin-runtime-error-modal` devDependencies (they're harmless but unused outside Replit).
- [ ] Add a `Dockerfile` to the bridge repo. Multi-stage: build with Vite + esbuild, runtime layer is `node:20-alpine` with `dist/`. Expose port 5000.
- [ ] Swap `@neondatabase/serverless` → `pg` in `package.json` and `server/db/index.ts`. Drizzle config dialect stays `postgresql`.
- [ ] Add typed routes (§5.1). Wire `BomService` methods. Write `InventoryService` once IM_DB inventory schema is documented (§10).
- [ ] Bridge tests pass against a local Postgres + a mock MariaDB (or skip MariaDB in CI; the bridge has connection failure handling).

### Phase 1 — Same-VM deploy

When the VM is assigned:

- [ ] Add `novalink-bridge` and `novalink-postgres` services to Luna's `docker-compose.yml`. Internal-only, no host port publish.
- [ ] Provide bridge `.env` on the VM (separate from Luna's `.env`). Includes IM_DB / AS_DB credentials and Postgres password.
- [ ] `docker compose pull novalink-bridge` (image from your registry) or `docker compose build novalink-bridge` (from the bridge repo cloned locally).
- [ ] `docker compose up -d novalink-postgres novalink-bridge`.
- [ ] Health check: `curl http://localhost:5000/api/health` from inside the `luna` container should succeed; from the VM host (without `docker exec`) should fail (no host port).

### Phase 2 — Luna integration

- [ ] Add `packs/novalink/` per §5.3.
- [ ] Add `/novalink-sql` slash command per §5.2.
- [ ] Set `NOVALINK_BRIDGE_URL`, `NOVALINK_BRIDGE_API_KEY`, `NOVALINK_SQL_ALLOWED_ROLES` in Luna `.env`.
- [ ] `docker compose build luna && docker compose up -d luna`.
- [ ] Live test: `/pack subscribe novalink` in a chat, ask "what's the BOM for part 12345 at company ACME" — Luna should call `get_bom`.

### Phase 3 — Decommission Replit

- [ ] Verify same-VM bridge in production for ≥ 1 week with no errors.
- [ ] Update any external consumers of the Replit URL (likely none — Luna is the only consumer).
- [ ] Pause / delete the Replit instance.

---

## 8. Sprint outline (rc.97+)

The work fits across ~3 small rc bumps once the VM is available:

| rc | Repo | Scope |
|-|-|-|
| **rc.97** | `ccmanuelf/novalink-bridge` (new) | Push the bridge as its own repo; add Dockerfile; swap Neon → pg; add typed routes wiring `BomService`; write `InventoryService` (after IM_DB schema discovery in §10). |
| **rc.98** | `superprompt` (this repo) | `packs/novalink/` with 5 typed tools and the role-gated SQL slash command. Tests. Awareness registration. Capability prompt. |
| **rc.99** | both | Same-VM compose deploy + cutover from Replit. Documentation refresh removing PLANNED markers. |

The first two rcs can proceed in parallel once §10 unblocks. rc.99 depends on the VM being assigned.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|-|-|-|
| LLM emits malformed `company_id` (e.g. trailing whitespace, casing) | high | Adapter trims and uppercases at the tool boundary before calling the bridge. |
| Bridge unreachable on container restart race | medium | Adapter retries 5xx/timeout once with backoff. Beyond that, return `BRIDGE_UNREACHABLE` so the LLM apologizes cleanly. |
| Inventory schema differs from BOM tables in unexpected ways | medium | Discovery in §10 before the typed `InventoryService` is written. Until then, ship `get_inventory_status` against IM_DB via SQL escape hatch under the same role gate (transitional). |
| Bridge eats Luna's TLS budget on `BRAVE_API_KEY` flows | low | Independent code paths. No shared client. |
| API key leak via Luna log lines | low | `redact()` helper enforced; lint rule on the pack to fail CI if a string field named `apiKey`/`apikey`/`api_key` appears in `logger.info` arguments. |
| `novalink-postgres` data lost on container deletion | medium | Named volume in compose: `novalink_postgres_data:/var/lib/postgresql/data`. Backup playbook in `docs/deployment-runbook.md`. |
| Bridge image bloat (React frontend + 60+ Radix components) | low | Multi-stage Dockerfile; runtime image only ships `dist/`. Optionally drop `/docs` UI from the runtime entirely if footprint matters. |

---

## 10. Open discovery items

These block parts of the work; everything else can proceed in parallel.

1. **IM_DB inventory schema.** Need: which tables hold current stock levels, on-order quantities, ATP (available-to-promise), and any allocation/reservation flags for a given `(company_id, part_number)`. Until this is documented, `InventoryService.getInventoryStatus` cannot be written and `get_inventory_status` ships transitionally via the SQL escape hatch.

2. **VM provisioning.** No VM is currently assigned. Spec needed: vCPUs, RAM, disk, OS, networking (does the VM's internal NIC have a route to IM_DB / AS_DB? what's the firewall posture?). Until the VM exists, Phase 1 of §7 cannot start.

3. **Bridge `.env` source of truth.** The Replit `.env` has the production MariaDB credentials. Cleanest migration: bridge admin generates a new set of credentials for the same-VM deployment so the Replit instance can be decommissioned without coordination. Coordinate with NovaLink DBA team.

4. **GitHub repo creation.** Confirm the target name (`ccmanuelf/novalink-bridge`?), visibility (private likely), and CI provider (GitHub Actions matching Luna's setup, or simpler).

5. **AS_DB typed endpoints.** Out of scope for the initial integration. If/when AS_DB queries become a Luna use case, an `AppSynergyService` would mirror the `BomService` shape. Until then, AS_DB is reachable only via the SQL escape hatch.

---

## 11. Out of scope (intentionally deferred)

- BOM **write** operations (`createBom`, `modifyBom`, `updateBomStatus`). The methods exist on `BomService` but Luna does not need to write to BOMs in the initial integration. Adding write tools requires a stricter approval flow (multi-stage human-in-the-loop) and is its own design conversation.
- Multi-company tenancy. Luna's chat-id-scoped data model already isolates per-user state; per-company isolation in NovaLink is enforced by the bridge requiring a `company_id` parameter on every typed call. No additional Luna work needed.
- Real-time push notifications from the bridge to Luna (e.g., "BOM XYZ was just approved"). The bridge has no event mechanism today and Luna has no consumer. Out of scope; revisit if/when the use case emerges.
- A Luna-side cache of bridge responses. The bridge already caches; double-caching would create stale-read bugs. Skipped.
- Replacing `@anthropic-ai/claude-code` SDK on the bridge side. The bridge has no AI integration and does not need one.

---

## 12. References

- Bridge codebase (Replit export): `~/Documents/Programming/novalink-bridge/DataConnectBridge`
- Bridge `replit.md`: high-level overview of the bridge's own architecture
- Bridge `server/services/bom-service.ts`: the typed business logic that already exists, ready to be wired to typed routes
- Bridge `shared/types.ts`: `ApiResponse<T>`, `BomHeader`, error codes, BOM status enum
- Luna `src/policy-engine.ts`: risk-level definitions for the SA4 classification
- Luna `src/core/feature-awareness.ts`: registry the pack registers with
- Luna `src/attendance/awareness.ts`: reference implementation of an awareness registration
- This doc is canonical for the integration. The architecture, security, and runbook docs reference this for bridge-specific content.
