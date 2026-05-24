# NovaLink Bridge Pack — Design

**Date:** 2026-05-23
**Status:** Proposed (awaiting review)
**Topic:** A Luna pack that connects to the NovaLink Bridge — a read-only HTTP API exposing NovaLink production databases — and lets Luna self-discover and query whatever the bridge offers.

---

## 1. Context

The NovaLink team stood up the **NovaLink Bridge**: a read-only HTTP API in front of their production databases (IM_DB, AS_DB), reachable from inside Luna's container at `http://novalink-bridge:5000` (internal Docker network, no host port). It is **self-describing** — `GET /api/docs` returns a machine-readable catalog of every configured query, its params, the response shape, and error codes. Today it exposes two queries (`im-bom`, `as-company`); the NovaLink team adds more through their own admin UI, hitting the same DB, with no coordination required on Luna's side.

This pack is the Luna-side adapter. Per Luna's architecture, **all the NovaLink-specific surface lives in this pack + two env vars**; Luna core stays company-agnostic. Drop the pack in, point it at a bridge, and Luna can talk to that company's data.

## 2. Goal & non-goals

**Goal:** Luna can, in normal conversation, (a) discover what the bridge currently offers, (b) query any of it and answer correctly from live production data, and (c) report whether its connection to prod is healthy — all without per-endpoint Luna code or redeploys when the bridge's catalog grows.

**Non-goals:**
- No writes. The bridge is read-only and so is this pack.
- No per-endpoint tools. We do **not** materialize one tool per slug. (See §7 on why discovery + the existing auto-skills loop already deliver "the pack gets richer over time.")
- No new self-improvement machinery. B (skills that emerge from repeated use) is **existing functionality** and is not built here.
- No admin/key-management surface. Minting Luna's own key and revoking the shared test key is an operational step on the NovaLink side, flagged in §6, not code in this pack.

## 3. Success criteria

The PoC "works" when, against the live bridge:
1. Luna answers a real question from live prod data end-to-end (e.g. *"what's the BOM status for order X?"*) — correct rows, correctly framed.
2. The NovaLink team adds a new query in their admin UI and Luna can use it **with no Luna change or redeploy** (proven via `novalink_list_queries` returning the new slug, then `novalink_query` calling it).
3. `novalink_health` correctly reports up/down, key validity, and current catalog size.
4. `npx tsc --noEmit` clean; `npx vitest run` green; pack tests cover parse/registration + the envelope/error paths.

## 4. Architecture

> **Implementation note (corrected after tracing the code):** the generic `loadLevel3Pack` loader (`packs.ts:610`) is defined but **never called**, and the manufacturing-barrel pattern (`src/packs/<name>/index.ts` + explicit wiring in `src/index.ts`) is for **core/DB** tools. NovaLink's tools are *network* tools, so they follow the **`render_*` pattern** instead: real code in `src/providers/tools/`, registered in both the tools process and the core registry. The pack's *identity* still comes from `packs/novalink/pack.yaml` + a `packName: 'novalink'` tag on each tool — so it remains a drop-in, company-agnostic pack.

```
packs/novalink/pack.yaml              # metadata, capabilities (system-prompt hint), intent patterns
src/providers/tools/novalink.ts       # bridge client + 3 tool definitions + 3 handlers
src/tools-process.ts                  # (edit) register the 3 tools in Process 2 — the executor
src/providers/tools/index.ts          # (edit) register the 3 in core — LLM visibility + policy + IPC routing
src/ipc/env-whitelist.ts              # (edit) forward the two NOVALINK_* vars to Process 2
```

- **Two registries (the key fact):** a network tool is registered in `tools-process.ts` (P2, which *executes* it) **and** in `providers/tools/index.ts` (P1, which exposes its definition to the LLM, classifies its policy, and IPC-routes execution to P2 via `executeTool`). This mirrors `render_list_services` exactly.
- **Process placement:** the three tools run in the **tools process** (`process: 'tools'`, network scope, no DB) — the correct home for outbound HTTP per SA3.
- **Config flow:** `NOVALINK_BRIDGE_URL` and `NOVALINK_BRIDGE_API_KEY` live in `.env`, are read via `readEnvFile()` (never `process.env`), and are forwarded into the tools process via the same env-whitelist mechanism that already forwards API keys (e.g. `BRAVE_API_KEY`) to that process. The client reads them at call time.

```
.env ──readEnvFile()──► core ──(whitelist)──► tools process ──fetch──► http://novalink-bridge:5000
```

## 5. The three tools

All three return plain objects; failures return `{ error, ... }` (graceful degradation, Code Convention #6) rather than throwing.

### `novalink_list_queries()` — discovery
- **Params:** none.
- **Does:** `GET {BRIDGE_URL}/api/docs` (with `X-API-Key`), parses the catalog.
- **Returns:** `{ _notice, queries: [{ slug, description, params }], count }`.
- **Why:** this *is* "rediscovery." It always reflects the live bridge because it asks the bridge. New endpoints appear here the moment NovaLink configures them.

### `novalink_query(slug, params?)` — the workhorse
- **Params:** `slug` (string, required); `params` (optional **JSON object string**, e.g. `'{"limit": 50}'`) — query params for that slug. A JSON string (not a native object) is used for type-safety against the Ollama `Tool` type and for compatibility with smaller models; the handler parses it. The discovery tool tells the model which params each slug accepts, keeping this generic over any present/future endpoint.
- **Does:** `GET {BRIDGE_URL}/api/q/{slug}?{params}` with `X-API-Key`; unwraps `{ status:"OK", data:{ columns, rows } }`.
- **Returns (success):** `{ _notice: "[EXTERNAL DATA — NovaLink production DB]", columns, rows }`.
- **Returns (bridge error):** `{ error: message, code }` from the `{ status:"ERROR", error:{ code, message } }` envelope. Codes surfaced: 401 `AUTH_INVALID`, 403 `AUTH_PERMISSION`, 404 `ENDPOINT_NOT_FOUND`, 400 `PARAM_MISSING`/`QUERY_INVALID`, 429 `RATE_LIMIT`.

### `novalink_health()` — connectivity probe
- **Params:** none.
- **Does:** probes the bridge (via `/api/docs`), measures latency, classifies the response.
- **Returns:** `{ reachable: bool, latency_ms, auth_valid: bool, query_count, bridge_url }`; if unreachable, `{ reachable: false, error }`.
- **Note to resolve during build:** whether `/api/docs` itself requires `X-API-Key`. If it does, the same probe validates the key (200 vs 401). If it does not, `auth_valid` needs one extra authenticated touch (the lightest catalogued query) to confirm the key. The handoff lists no dedicated `/health` route, so health rides on `/api/docs`.

## 6. Trust & security

- **Production data crosses into the model's context.** Manufacturing rows contain free-text fields. Returned rows are wrapped with `[EXTERNAL DATA — NovaLink production DB]` so the model treats them as data, not instructions — mirroring the `_notice` pattern `web_search` uses.
- **Intentional internal call.** The bridge is an internal Docker host. The declarative-HTTP tool path would only reach it by an *omission* in the SSRF blocklist (`isInternalUrl`, summarize-url.ts:11, has no `novalink-bridge` entry and skips the IP check for bare hostnames). Relying on that omission is fragile. Instead the pack's `client.ts` calls `fetch` directly — an explicit, auditable internal call that does not depend on the SSRF list staying unchanged.
- **Read-only + scoped key** → low blast radius. The current key (`nlb_…`) is a shared **test/dev** key. Before this is "production," mint Luna its own key in the bridge admin UI and revoke the shared one. Operational step, not a code blocker.
- **Rate limits (429).** Conservative call patterns; surface `RATE_LIMIT` to the model rather than retrying aggressively. Per-call timeout (~10–15s), graceful on timeout.
- **No secrets in git.** Env only; `.env.example` gets placeholder entries for the two vars.

## 7. Discovery (A) and the self-improvement loop (B)

- **A — live discovery (built here):** `novalink_list_queries` + `novalink_query` mean the pack is tiny and static yet always current. Nothing on disk to maintain or go stale.
- **B — emergent skills (already exists, not built here):** Luna's auto-skills machinery is live in the message flow (`core/context.ts`: `detectSkillCandidate` → `draftSkillDefinition` → `proposeSkillToUser` → `createAutoSkill`). It fires on **repeated multi-step work** (≥3 distinct tools in a turn, or ≥3 successful orchestration steps; quality ≥70; ≤1 proposal/chat/hour; deduped). It produces a **skill** — a saved procedure (system prompt + tool allow-list + triggers) stored in the DB and proposed to the user bilingually — **not** a new tool or a rewritten pack file.
  - A single NovaLink lookup will not auto-promote (correctly — one query isn't a skill).
  - A recurring composed workflow (e.g. *pull BOM status → summarize → set reminder*) crosses the threshold and Luna drafts a reusable skill. **This is the "self-improving" behavior, and it requires no new code** — it works *because* the three tools are normal registered tools that appear in `toolsUsed`.

## 8. Error handling

Every tool degrades gracefully: bridge unreachable → `{ error, reachable:false }` (health) or `{ error }` (list/query); non-200 with an error envelope → `{ error: message, code }`; timeout → `{ error: "Request timed out" }`. Luna logs and continues; it never crashes on a bridge problem.

## 9. Testing (vitest)

- `pack.yaml` parses and declares the expected capabilities/intent patterns.
- `client.ts`: unwraps a success envelope into `{ columns, rows }`; maps each error code to `{ error, code }`; applies the `_notice` framing; handles unreachable/timeout. (HTTP mocked.)
- `registerTools()` registers exactly three tools with `network` scope and the chosen policies.
- Discovery parses a sample `/api/docs` payload into `{ slug, description, params }[]`.

## 10. Out of scope

Writes; per-endpoint tools; admin/key-management UI; new self-improvement machinery; non-NovaLink bridges (the pack is generic, but only NovaLink is wired now).

## 11. Open items to verify during build

1. Does `/api/docs` require `X-API-Key`? (Determines the `novalink_health` auth-validation path — §5.)
2. Exact JSON shape of `/api/docs` (field names for slug/params/description) — confirm against the live catalog before finalizing the discovery parser.
3. Exact symbol/file for the tools-process env whitelist — confirm and add the two `NOVALINK_*` vars there.

**Resolution (build, 2026-05-23):** (2) sidestepped — `novalink_list_queries` returns `/api/docs` verbatim, so there is no brittle catalog-shape coupling and no parser to finalize. (3) resolved — the symbol is `TOOLS_PROCESS_ENV` in `src/ipc/env-whitelist.ts`; both vars were added. (1) handled defensively — `novalink_health` treats HTTP 401/403 as `auth_valid:false` regardless of whether `/api/docs` is authenticated; still worth a one-time live confirmation of `/api/docs` auth behaviour.
