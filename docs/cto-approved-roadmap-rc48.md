# Luna — CTO-Approved Enhancement Roadmap

**Approved by:** CTO
**Date:** April 10, 2026
**Baseline:** v1.0.0-rc.48 | 1845 tests | 77 files
**Target Environment:** InMotion Dedicated Server (Alma Linux 8, 64GB RAM, 16 cores, 250GB NVMe)

---

## Overview

Four workstreams approved for execution before public deployment. All items classified as MUST or SHOULD by CTO review.

| # | Workstream | Priority | Estimated Effort |
|---|-----------|----------|-----------------|
| 1 | Security Hardening for Public Deployment | MUST — blocks production | 3-5 days |
| 2 | Multi-Agent & Autonomous Execution | SHOULD — enhances platform value | 5-8 days |
| 3 | Architecture B Deployment (Shared Infra) | MUST — deployment architecture | 2-3 days |
| 4 | Database Abstraction (MariaDB production) | MUST — production database | 8-13 days |

---

## Workstream 1: Security Hardening for Public Deployment

### MUST Do (Blocks Deployment)

| # | Action | Why | Effort | Deliverable |
|---|--------|-----|--------|-------------|
| 1.1 | TLS mandatory | All traffic encrypted. Browsers block microphone without HTTPS. | Config — already supported | `VOICE_WEB_TLS_CERT/KEY` in `.env` |
| 1.2 | Reverse proxy (Caddy) | Automatic HTTPS via Let's Encrypt, DDoS basic protection, request size limits, HTTP/2. Luna's built-in HTTP server is not production-grade for public exposure. | Add Caddy service to docker-compose.yml | `docker/Caddyfile` + compose service |
| 1.3 | Firewall rules | Only expose port 443 (HTTPS). Ports 3030, 8080, 8000 stay internal. | InMotion server config | Firewall rule documentation |
| 1.4 | Telegram webhook mode | Long-polling is inefficient for public servers. Webhook requires HTTPS. | grammy config change (not code) | `.env` flag: `TELEGRAM_WEBHOOK_URL` |
| 1.5 | Tighten auth rate limits | 5 failures/min too generous. Reduce to 3/min, IP ban after 15/hour. | Small code change in `server.ts` | Updated rate limiter |
| 1.6 | WAF / fail2ban | Block automated scanners, known attack patterns, brute force. | InMotion server-level config | fail2ban rules for Luna logs |

### SHOULD Do (Recommended, Not Optional per CTO)

| # | Action | Why | Deliverable |
|---|--------|-----|-------------|
| 1.7 | IP allowlisting for web UI | Restrict web access to known office IPs at Caddy level. CTO notes: "Ideal to implement web UI for admin configuration." | Caddy IP allowlist config |
| 1.8 | Audit logging for all tool executions | Currently only token events logged. Add logging for every tool call with chatId, tool name, timestamp. | Structured audit log table + pino output |
| 1.9 | Request body size limits | Prevent large payload attacks. | Caddy: `request_body max_size 10MB` |
| 1.10 | Database encryption at rest | Database stored plaintext on disk. | InMotion disk encryption or MariaDB TDE |

---

## Workstream 2: Multi-Agent & Autonomous Execution

### Approved Enhancements (Within Current Architecture)

| # | Enhancement | What It Adds | Effort | Value |
|---|-------------|-------------|--------|-------|
| 2.1 | Parallel orchestration steps | Steps without dependencies run simultaneously via `Promise.all()`. Example: capacity analysis AND material check in parallel. | Medium — modify `orchestrateTask()` | High — faster complex tasks |
| 2.2 | Event-driven triggers | "When a new order arrives in /hub, automatically run shortage check." DB change triggers agent action. Currently time-based (cron) only. | Medium — trigger table + DB observer pattern | High — real operational value |
| 2.3 | Pack-scoped delegation | Main agent delegates to pack-specific personas per orchestration step. "Run a quality analysis" → manufacturing persona handles it. | Low-Medium — extend orchestrator to set active skill per step | Medium — better domain responses |
| 2.4 | Background task queue | Long-running tasks (1000 Monte Carlo runs, large DOE) execute in background. User gets notification on completion. | Medium — Worker thread for async + notification | High — UX improvement |

### Not In Scope (Would Require Re-Architecture)

| Enhancement | Why Deferred |
|-------------|-------------|
| True multi-agent (SuperAGI-style) | Requires agent-to-agent protocol, shared memory, conflict resolution. Packs achieve similar outcomes. |
| Autonomous web browsing | Security implications on public server. Puppeteer exists for screenshots, not interactive browsing. |
| Self-modifying code | Worker sandbox explicitly prevents this for security. |

---

## Workstream 3: Architecture B Deployment (Shared Infrastructure)

### Target Architecture

```
InMotion Server (Alma Linux 8, 64GB, 16 cores)
├── Shared Services (1 instance each)
│   ├── Ollama (local AI model inference)
│   ├── SearXNG (web search)
│   └── Speaches (voice STT/TTS)
├── Per-Deployment (up to 10)
│   ├── luna-bot-1 (Telegram bot + web UI, own DB)
│   ├── luna-bot-2
│   ├── ...
│   └── luna-bot-10
├── Caddy (reverse proxy, TLS termination)
└── MariaDB (shared, per-deployment databases)
```

### Server Requirements (CTO-Approved)

| Resource | Spec |
|----------|------|
| RAM | 64GB |
| CPU | 16 cores |
| Storage | 250GB NVMe SSD |
| OS | Alma Linux 8 |
| Network | 1Gbps |
| Max deployments | 10 |
| Max users per deployment | 10 |
| Max total users | 100 |

### Resource Allocation

| Component | RAM | CPU | Instances |
|-----------|-----|-----|-----------|
| Ollama (shared) | 8GB | 4 cores | 1 |
| SearXNG (shared) | 512MB | 0.5 core | 1 |
| Speaches (shared) | 2GB | 2 cores | 1 |
| Caddy (shared) | 128MB | 0.5 core | 1 |
| MariaDB (shared) | 4GB | 2 cores | 1 |
| luna-bot (per deployment) | 1GB each | 0.5 core each | Up to 10 |
| **Total** | **~25GB allocated, ~39GB headroom** | **~12 cores allocated, 4 headroom** | |

---

## Workstream 4: Database Abstraction (MariaDB Production)

### Strategy: Option C (CTO-Approved)

Keep `better-sqlite3` for development/testing. Add `mysql2` (MariaDB) driver for production. `DB_DRIVER` env var selects the backend. Both dialects tested in CI.

### Phase 1: SQL Compatibility Audit

| SQLite Syntax | MariaDB Equivalent | PostgreSQL Equivalent | Files Affected |
|--------------|-------------------|----------------------|---------------|
| `INTEGER PRIMARY KEY` (auto-increment) | `INT AUTO_INCREMENT` | `SERIAL` | All 29 modules with tables |
| `PRAGMA table_info()` | `DESCRIBE table` | `\d table` or `information_schema` | 8 manufacturing modules (migration checks) |
| `INSERT OR REPLACE` | `REPLACE INTO` or `INSERT ... ON DUPLICATE KEY UPDATE` | `INSERT ... ON CONFLICT DO UPDATE` | ~15 occurrences |
| FTS5 `MATCH` | `FULLTEXT INDEX` + `MATCH ... AGAINST` | `tsvector/tsquery` | Memory search, kanban, learning |
| `COLLATE NOCASE` | Collation at table/column level (`utf8mb4_general_ci`) | `CITEXT` extension or `ILIKE` | ~20 occurrences |
| WAL mode | InnoDB (default, row-level locking) | MVCC (default) | `db.ts` initialization |
| `sqlite-vec` (vector search) | Application-level (BLOB + cosine similarity) | `pgvector` extension | `embeddings.ts` |

### Phase 2: Database Adapter Layer

```
src/db/
├── adapter.ts         — Interface: query(), exec(), prepare(), transaction()
├── sqlite-adapter.ts  — SQLite implementation (better-sqlite3)
├── mariadb-adapter.ts — MariaDB implementation (mysql2)
└── index.ts           — Factory: reads DB_DRIVER, returns adapter
```

- `DB_DRIVER=sqlite` (default, development)
- `DB_DRIVER=mariadb` (production)
- Each module's `initTables()` receives the adapter and generates dialect-appropriate DDL
- CRUD functions use parameterized queries (already standard SQL — most work as-is)

### Phase 3: Migration Tooling

| Deliverable | Description |
|-------------|-------------|
| Schema generation script | Creates all tables in MariaDB from Luna's table definitions |
| Data migration script | Exports SQLite data → imports into MariaDB (handles type mapping) |
| Dual-backend test runner | CI runs full test suite against both SQLite and MariaDB |
| Rollback procedure | MariaDB → SQLite export if needed |

### Effort Estimate

| Phase | Scope | Days |
|-------|-------|------|
| Phase 1 | Audit 265 SQL statements, flag incompatible syntax | 1-2 |
| Phase 2 | Adapter layer, dialect-aware DDL, connection pooling | 3-4 |
| Phase 3a | CRUD compatibility (fix ~30-40 SQLite-specific patterns) | 2-3 |
| Phase 3b | FTS5 → FULLTEXT migration (memory, kanban, learning) | 1-2 |
| Phase 4 | Migration script, dual-backend testing, verification | 1-2 |
| **Total** | | **8-13** |

---

## Execution Order (Recommended)

| Order | Workstream | Rationale |
|-------|-----------|-----------|
| 1st | Database Abstraction (#4) | Foundation — everything else depends on production DB |
| 2nd | Security Hardening (#1) | Required before any public exposure |
| 3rd | Architecture B (#3) | Deployment topology for InMotion |
| 4th | Multi-Agent Enhancements (#2) | Platform value — can ship incrementally |

**Total estimated effort:** 18-29 days of focused development work.

---

## Decision Log

| Decision | Date | By | Rationale |
|----------|------|----|-----------|
| MariaDB for production | 2026-04-10 | CTO | 10 years production experience, proven operational playbook |
| SQLite for development | 2026-04-10 | CTO | Fast, zero-config, perfect for testing |
| Architecture B (shared infra) | 2026-04-10 | CTO | 10 deployments × 10 users on single server |
| 64GB/16-core server | 2026-04-10 | CTO | InMotion dedicated server spec |
| Alma Linux 8 | 2026-04-10 | CTO | Production OS standard |
| Security items MUST + SHOULD | 2026-04-10 | CTO | "SHOULD" reclassified as "recommended, not optional" |
| PostgreSQL available as option | 2026-04-10 | CTO | Available on InMotion, used for side projects. MariaDB preferred for production. Adapter supports both. |

---

*luna v1.0.0-rc.48 — CTO-Approved Enhancement Roadmap*
