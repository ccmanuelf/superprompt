# Luna — Architecture Decision Records (ADRs)

**Version:** v1.0.0-rc.108 | May 2026

Each ADR documents a significant architectural decision, the alternatives considered, and why the chosen approach was selected. These demonstrate intentional engineering, not ad-hoc development.

---

## ADR-001: Independent Development (Not a Fork)

**Date:** 2026-02-25
**Status:** Accepted
**Context:** The team needed an AI assistant platform for manufacturing operations. OpenClaw existed as an open-source option but had fundamental security concerns (unrestricted system access, no process isolation, no domain specialization).
**Decision:** Build Luna from scratch in TypeScript/Node.js as an independent project.
**Alternatives considered:**
- Fork OpenClaw and harden it → Rejected: OpenClaw's architecture (single-process, no sandbox) would require rewriting core components. Starting fresh was faster and cleaner.
- Use a commercial agent platform → Rejected: No data sovereignty. Manufacturing domain tools don't exist in any commercial platform.
- Use Agent SDK (Anthropic) → Rejected: Too low-level for a full platform. Good for single-agent tasks, not multi-department operations.
**Consequences:** Full control over security architecture, no upstream dependency risk, no inherited vulnerabilities.

---

## ADR-002: 3-Process Separation (SA3)

**Date:** 2026-03-20
**Status:** Accepted
**Context:** Tools that access the network (web search, GitHub) should not have database access. File parsers should have neither network nor database access.
**Decision:** Separate the application into 3 processes via `child_process.fork()`:
- Process 1 (core): Database access, session management, memory
- Process 2 (tools): Network access, compute, no database
- Process 3 (parsers): File I/O only, no network, no database
**Alternatives considered:**
- Single process with permission checks → Rejected: A compromised tool can bypass in-process permission checks.
- Docker-per-tool isolation → Rejected: Too much overhead for 43+ tools. Startup time would be unacceptable.
- Worker threads → Rejected: Workers share process memory. A memory corruption in a tool could affect the database.
**Consequences:** Even if a tool is compromised, the attacker cannot access the database or bot tokens. IPC env whitelist ensures credentials don't leak between processes.

---

## ADR-003: Knex Query Builder (Not ORM)

**Date:** 2026-04-10 (WS4)
**Status:** Accepted
**Context:** Production deployment requires MariaDB or PostgreSQL. The codebase had 418 raw SQLite SQL statements across 36 files.
**Decision:** Use Knex.js as a query builder (not a full ORM like Prisma/TypeORM).
**Alternatives considered:**
- Prisma ORM → Rejected: Heavy, generates client code, schema-first approach would require rewriting all models. Overkill for the project's needs.
- TypeORM → Rejected: Decorator-based, runtime overhead, complex migration system.
- Raw SQL with dialect adapter → Rejected: Fragile, error-prone, no connection pooling.
- Knex.js → Accepted: Lightweight, chainable query builder, built-in connection pooling, supports all 3 backends, raw SQL fallback for complex queries (FTS, vectors).
**Consequences:** All 53 production files migrated. `DB_DRIVER` env var selects backend at deployment time. SQLite for development, MariaDB/PostgreSQL for production.

---

## ADR-004: Per-User Web Tokens (Not Shared Secret)

**Date:** 2026-04-06 (rc.38)
**Status:** Accepted
**Context:** The original `VOICE_WEB_TOKEN` was a single shared secret for all web UI users. No per-user data isolation on web dashboards.
**Decision:** Self-service per-user tokens via `/webtoken create` in Telegram. Each token scoped to the user's `chat_id`.
**Alternatives considered:**
- OAuth/OIDC → Rejected: Requires external identity provider. Too complex for the current deployment model.
- Username/password login → Rejected: Needs user management UI, password storage, forgot-password flow.
- Per-user tokens → Accepted: Simple, secure (64-char hex), self-service, scoped to user data, revocable.
**Consequences:** Each user creates their own tokens. Board data, learning plans, memory, schedules all isolated per user. Legacy `VOICE_WEB_TOKEN` preserved as fallback.

---

## ADR-005: SearXNG (Not Multiple API Providers)

**Date:** 2026-04-08 (rc.47)
**Status:** Accepted
**Context:** Web search requires a backend for Ollama (which has no internet access). Multiple search APIs were considered (Serper, Google GCSE, Tavily, Brave).
**Decision:** Use SearXNG as a self-hosted meta-search aggregator.
**Alternatives considered:**
- Multiple API providers → Rejected: Each adds an API key, rate limit, error path. SearXNG queries 70+ engines simultaneously with zero API cost.
- Brave API only → Rejected: Single provider, per-query cost, single point of failure.
- Google Custom Search → Rejected: Requires API key, $5/1000 queries, CAPTCHA issues.
**Consequences:** One Docker container, zero API keys, 7 engines enabled (DuckDuckGo, Bing, Brave, Qwant, Wikipedia, arXiv, Semantic Scholar). Brave API kept as fallback.

---

## ADR-006: Event-Driven Triggers (Not Cron-Only)

**Date:** 2026-04-10 (WS2, rc.59)
**Status:** Accepted
**Context:** Scheduled tasks (cron) are time-based. Manufacturing operations need reactive triggers: "When a critical card is created, alert the team."
**Decision:** Add event-driven trigger system alongside cron scheduling.
**Alternatives considered:**
- Cron with frequent polling → Rejected: Wastes resources, delayed reaction, doesn't scale.
- External event bus (Redis, RabbitMQ) → Rejected: Additional infrastructure dependency for a simple use case.
- Database triggers (SQL) → Rejected: Not portable across SQLite/MariaDB/PostgreSQL.
- Application-level events → Accepted: `emitEvent()` from any module, condition matching, cooldown, audit log.
**Consequences:** Kanban card events (created, moved) automatically trigger registered actions. Extensible to order events, shortage detection, etc.

---

## ADR-007: Caddy (Not Nginx/Apache)

**Date:** 2026-04-10 (WS1, rc.58)
**Status:** Accepted
**Context:** Production deployment needs HTTPS reverse proxy with automatic certificate management.
**Decision:** Use Caddy as the reverse proxy.
**Alternatives considered:**
- Nginx → Rejected: Manual certbot setup, manual renewal scripts, complex config syntax.
- Apache → Rejected: Heavier, same certbot complexity as Nginx.
- Caddy → Accepted: Automatic HTTPS (Let's Encrypt), zero-config certificate renewal, simple Caddyfile syntax, built-in HTTP/2, WebSocket proxy.
**Consequences:** One Caddyfile, one Docker container, automatic HTTPS. No cron jobs for certificate renewal.

---

## ADR-008: Claude Subscription (Not API Per-Token)

**Date:** 2026-02-25
**Status:** Accepted
**Context:** AI model access is the largest variable cost in an AI assistant platform.
**Decision:** Use Claude via CLI subscription (`claude -p` subprocess) with fixed monthly fee. No per-token API billing.
**Alternatives considered:**
- Anthropic API (per-token) → Rejected: Costs scale with usage. 100 users generating long conversations = unpredictable monthly bill.
- OpenAI API → Rejected: Same per-token pricing issue. Also requires API key management.
- Claude subscription + Ollama local → Accepted: Fixed monthly cost for Claude (reasoning), free local Ollama (tools). Predictable budget.
**Consequences:** AI cost is fixed at ~$20-100/month per instance regardless of usage. Ollama handles tool calls locally (zero API cost).

---

## ADR-009: Public `/api/health` Endpoint Bypasses Auth Gate

**Date:** 2026-05-05 (rc.102)
**Status:** Accepted
**Context:** External monitoring systems (LB, Prometheus blackbox, uptime checks) need a way to verify the bot is running without an auth token. Originally `/api/health` fell through to the catchall auth check and returned 401 — breaking deployment automation.
**Decision:** Register `/api/health` ahead of the auth gate, returning 204 No Content for `GET` and `HEAD`. Other methods on the path continue to require auth (the catchall returns 401 for `POST` etc.).
**Alternatives considered:**
- Token-protected health → Rejected: monitors don't carry chat-scoped tokens; defeats the purpose.
- TCP-only check → Rejected: doesn't catch app-loop wedge (process alive but unresponsive).
**Consequences:** Compose-level Docker healthcheck is now `curl -fsS http://127.0.0.1:3030/api/health`. Used by both Docker's HEALTHCHECK and any external monitor. The `204 + no body` shape minimizes log noise.

---

## ADR-010: NPM Overrides for Vulnerable Transitive Deps

**Date:** 2026-05-05 (rc.104)
**Status:** Accepted
**Context:** `@vector-im/matrix-bot-sdk` 0.9 still depends on the deprecated `request` library, which transitively pulls vulnerable versions of `form-data`, `qs`, and `uuid`. The vulnerabilities cannot be fixed by upgrading the SDK alone (upstream has not migrated off `request`).
**Decision:** Pin transitive deps via `package.json` `overrides`:
- `form-data ^4.0.5` (was <2.5.4 — CRITICAL boundary CVE)
- `qs ^6.15.1` (was <6.14.1 — moderate `arrayLimit` DoS)
- `uuid ^14.0.0` (was <14 — moderate buffer bounds-check)
**Alternatives considered:**
- Drop matrix-bot-sdk → Rejected: Matrix is a deployed feature; replacement is a separate workstream.
- Wait for upstream → Rejected: Element's roadmap to drop `request` is not committed.
- `npm audit fix --force` → Rejected: would downgrade exceljs to 3.4.0 (breaking change).
**Consequences:** CVE count went from 14 (3 critical, 11 moderate) → 4 moderate. The 4 residuals are CVEs against `request` itself (DoS / SSRF), reachable only via the operator-controlled Synapse homeserver — not externally exploitable in our threat model. `tough-cookie ^4.1.4` was already pinned the same way for the same reason.

---

## ADR-011: Dual-View Calculation Architecture (Pure-Function Inputs Only)

**Date:** 2026-04-30 (rc.100) — see `docs/audit/calculation-modules-audit.md` for the original Phase 0 scope and locked decisions.
**Status:** Accepted
**Context:** Manufacturing calculations had ~17 hardcoded constants across 14 modules (cycle-time source, setup treatment, ROI hurdle, default service level, etc.). Operators wanted per-site overrides without touching the math; users wanted explainability of which assumption produced a given result.
**Decision:** Introduce a calculation-wrapper layer (`src/calculations/`) that:
1. Takes the same inputs as the underlying pure function plus `(assumptions, mode)`.
2. In `standard` mode passes the textbook defaults through unchanged.
3. In `site_adjusted` mode resolves named assumptions from a registry (built-in defaults → global → pack → user, first-match-wins) and applies them as **input overrides** — never modifying the math.
4. Returns `CalculationResult { value, mode, inputsUsed, assumptionsApplied, computedAt }` so callers can render the lineage.
The Web UI exposes `/docs/assumptions` for CRUD and `/explain` for ephemeral most-recent-result lineage. The Telegram surface honors `--site-adjusted` on every manufacturing slash command and CSV caption.
**Alternatives considered:**
- Mutable math (per-pack code branches) → Rejected: violates the "pure function" contract; gives every pack a footgun.
- Inline registry lookups inside pure functions → Rejected: makes pure functions impure and breaks unit tests that don't init a registry.
- Single global override map → Rejected: no per-site / per-user precedence; can't ship multi-tenant.
**Consequences:** All 14 calc modules ship dual-view. AIAG control-chart constants (d2, D4, Western Electric thresholds) are explicitly NOT folded — they're standards, not assumptions. Inventory's `default_service_level` ships as the latest active hook (rc.102) with the same precedence semantics as ROI's `roi_default_discount_rate` and `roi_default_horizon_months`.

---

## ADR-012: Vitest 4 — `vi.hoisted` + Class-Based Mock for Module-Cached Singletons

**Date:** 2026-05-05 (rc.105)
**Status:** Accepted
**Context:** vitest 4 changed module-mock factory semantics. The pre-rc.105 pattern of attaching a `__mockX` escape-hatch to the mocked module returned a stale reference under vitest 4, and `mockResolvedValueOnce` queued values were silently dropped (the test for `tests/embeddings.test.ts` failed in this mode after the upgrade).
**Decision:** When a module under test caches a constructed instance at module scope (`let client: X = null`), use:
```ts
const { mockEmbed } = vi.hoisted(() => ({ mockEmbed: vi.fn() }));
vi.mock('ollama', () => ({
  Ollama: class MockOllama { embed = mockEmbed; },
}));
```
Class-based mocks bind the hoisted `vi.fn` reference at every constructor call, so cached singletons see the same mock the test queues against.
**Alternatives considered:**
- `vi.resetModules()` in `beforeEach` → Rejected: doesn't fix the underlying reference issue.
- Refactor source to remove module-level cache → Rejected: cache exists for a reason (connection reuse).
**Consequences:** Documented as the canonical pattern for tests that mock connection-cached SDKs (Ollama, OpenAI, etc.). Used in `tests/embeddings.test.ts`; future similar mocks should follow.

---

## ADR-013: Major Dep Bumps Land In Isolated Commits

**Date:** 2026-05-05 (rc.105)
**Status:** Accepted
**Context:** rc.105 attempted seven concurrent major-version bumps (TypeScript 5→6, vitest 3→4, openai 4→6, @types/node 22→25, undici 7→8, ollama 0.5→0.6, pdfkit 0.17→0.18). If any one had broken the suite, identifying which would have required bisection across all seven.
**Decision:** Attempt each major bump in a separate `npm install pkg@N` step, run `tsc --noEmit` + full vitest suite after each, and only continue to the next on green. Each is logically isolated and revertable. The final ship commit aggregates them once verified.
**Alternatives considered:**
- Single bulk bump → Rejected: bisection cost on failure too high.
- One commit per major → Rejected: branch noise; no functional benefit because the fixes ship as one rc.
**Consequences:** rc.105 landed seven majors clean in one commit. Two source-side fixups required (worker-sandbox.ts type narrow under @types/node 25; embeddings.test.ts mock pattern under vitest 4) — both isolated to their respective bumps and traceable in the commit body.

---

*luna v1.0.0-rc.108 — Architecture Decision Records*
