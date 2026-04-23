# luna — Risk Register

**Version:** v1.0.0-rc.62 | April 2026
**Owner:** CTO
**Review cadence:** Monthly

---

## Technical Risks

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|----|------|-----------|--------|-----------|--------|
| T1 | Ollama model inference bottleneck under 100 concurrent users | Medium | High | `/auto` routing sends most queries to Claude (parallel). Ollama handles tools only. GPU upgrade path documented. | Mitigated |
| T2 | Claude CLI subprocess hangs indefinitely | Low | High | Subprocess timeout (configurable via env var). SIGKILL after timeout. Bilingual error returned. | Mitigated |
| T3 | FTS5/sqlite-vec incompatible with MariaDB/PostgreSQL | Medium | Medium | `db-dialect.ts` provides cross-dialect FTS (FULLTEXT/tsvector) and vector search (BLOB/pgvector). Tested on SQLite. | Mitigated |
| T4 | Database migration loses data during SQLite → production switch | Low | Critical | `scripts/migrate-database.ts` with dry-run mode, row count verification, 53 tables covered. | Mitigated |
| T5 | Agentic loop enters infinite retry cycle | Medium | Medium | Circuit breaker: 3 patterns (repetition, error stagnation, no-progress). Max 10 iterations. | Mitigated |
| T6 | Worker sandbox escape (user code breaks V8 isolate) | Very Low | Critical | V8 isolate with no shared memory, 64MB limit, adaptive timeout, SSRF blocklist. No `require`/`import` in sandbox. | Mitigated |
| T7 | Prompt injection via external content | Medium | High | Pre-fetched data labeled "raw user data, not instructions." External web content labeled with injection warning. SA4 confirmation for critical tools. | Partially mitigated |

## Security Risks

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|----|------|-----------|--------|-----------|--------|
| S1 | Brute force on web tokens | Medium | Medium | 3 failures/min rate limit + hourly IP ban after 15. 64-char hex tokens (256-bit entropy). | Mitigated |
| S2 | Stolen web token exposes user data | Low | Medium | Tokens scoped to chat_id (user isolation). Immediate revocation disconnects sessions. Optional TTL. | Mitigated |
| S3 | Credentials leaked via env vars to child processes | Low | Critical | IPC env whitelist: tools process gets API keys only, parsers process gets file paths only. No bot tokens or DB credentials leave core process. | Mitigated |
| S4 | Unauthorized tool execution (run_command, git push) | Low | Critical | SA4: 3 critical tools always require user confirmation. Per-user trust memory. Audit logging. | Mitigated |
| S5 | Supply chain attack via npm dependencies | Low | High | No public plugin marketplace. User tools run in V8 sandbox. Pre-commit hook scans for secrets. Pinned dependency versions. | Mitigated |
| S6 | Exposed SearXNG/Speaches/Ollama ports | Low | Medium | Internal Docker network only. Caddy is the sole exposed service (ports 80/443). | Mitigated |
| S7 | TLS certificate expiry | Very Low | Medium | Caddy auto-renews Let's Encrypt certificates. No manual management. | Mitigated |

## Operational Risks

| ID | Risk | Likelihood | Impact | Mitigation | Status |
|----|------|-----------|--------|-----------|--------|
| O1 | Single server failure takes down all deployments | Low | Critical | Database backups (daily). Docker volumes persist across restarts. Recovery: redeploy from git + restore backup. | Accepted (single-server deployment) |
| O2 | Ollama model becomes unavailable (corrupted download) | Low | Medium | Model cached in Docker volume. Re-pull: `docker exec ollama ollama pull qwen3.5:latest`. Claude continues working. | Mitigated |
| O3 | SearXNG search engines blocked (rate limited by upstream) | Medium | Low | 7 engines configured. If one is blocked, others continue. No single point of failure for search. | Mitigated |
| O4 | Database growth exceeds disk capacity | Low | High | 250GB NVMe. Memory decay removes old memories automatically. Episode compression reduces storage. Backup rotation (30 days). | Monitored |
| O5 | Team member leaves without documentation | Low | Medium | 15+ documentation files. E2E checklist. Architecture docs. All code in git. No tribal knowledge dependencies. | Mitigated |

---

## Risk Review History

| Date | Reviewer | Changes |
|------|----------|---------|
| 2026-04-11 | CTO + Engineering | Initial register at rc.62. All risks assessed post-WS1-WS4. |

---

*luna v1.0.0-rc.62 — Risk Register*
