# Luna — Architecture Decision Records (ADRs)

**Version:** v1.0.0-rc.62 | April 2026

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

*luna v1.0.0-rc.62 — Architecture Decision Records*
