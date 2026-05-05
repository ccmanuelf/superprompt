# Luna — Operations & Support Model

**For:** IT Operations, CTO, Department Champions

---

## Ownership

| Role | Responsibility |
|------|---------------|
| **Software Development Team** | Core platform development, Level 3 packs, dashboards, architecture |
| **IT Operations** | Deployment, infrastructure, backups, monitoring, credentials |
| **Department Champions** | Pack configuration, tool tuning, user training, feedback |
| **luna (AI)** | Self-service: Level 2 packs, tool creation, skill learning, auto-healing |

---

## Incident Classes

### Severity 1 — Bot Down (service unavailable)

| Symptom | Likely Cause | Recovery |
|---------|-------------|----------|
| Telegram bot not responding | Docker container crashed | `docker compose up -d --build luna` |
| "Connection refused" errors | Docker not running | Restart Docker Desktop |
| Health check failing | Process crash inside container | Check `docker logs luna-bot` |

**SLO Target:** Respond within 1 hour, resolve within 4 hours (business hours).

### Severity 2 — Provider Down (degraded service)

| Symptom | Likely Cause | Recovery |
|---------|-------------|----------|
| Claude responses time out | Anthropic service issue or rate limit | Switch to Ollama: `/ollama` |
| Ollama not responding | Ollama service stopped | `ollama serve` or restart |
| Very slow responses (>30s) | RAM exhaustion, model swapping to disk | Close other applications, check `docker stats` |

**SLO Target:** Respond within 2 hours, resolve within 8 hours.

### Severity 3 — Feature Issue (partial functionality)

| Symptom | Likely Cause | Recovery |
|---------|-------------|----------|
| Dashboard not loading | Web server route issue | Check `docker logs`, verify port 3030 |
| Voice not working | Speaches sidecar down | `docker compose restart speaches` |
| Tool returning errors | API token expired or endpoint changed | Check `.env` credentials |
| Pack not loading | YAML syntax error in pack.yaml | Check `docker logs` for pack errors |

**SLO Target:** Respond within 4 hours, resolve within 24 hours.

### Severity 4 — Enhancement Request

| Type | Owner | Process |
|------|-------|---------|
| New Level 2 tool | Department Champion + Luna | Conversational creation |
| New Level 3 dashboard | Software Development Team | Requirements → development → deployment |
| Pack configuration change | Department Champion | `/pack enable/disable` or tell Luna |
| API connection | IT Operations | Add credentials to `.env`, restart container |

**SLO Target:** Acknowledge within 24 hours, prioritize in next sprint.

---

## Monitoring

### What to Watch

| Metric | Where | Healthy | Warning |
|--------|-------|---------|---------|
| HTTP health endpoint | `curl http://<host>:3030/api/health` | `204 No Content` | non-204 / unreachable (rc.102) |
| Container health | `docker ps` | "healthy" | "unhealthy" or missing |
| Startup warnings | `docker logs luna-bot \| grep WARN` | 0 | >0 |
| Processes running | Docker logs "spawned" | 3 (core + tools + parsers) | <3 |
| Child-process restarts | `docker logs luna-bot \| grep "Scheduling child process restart"` | rare | repeated within 60s — backoff (rc.106) growing exponentially up to 60s |
| Packs loaded | Docker logs "Loaded domain pack" | 11 | <11 |
| Slow scheduled tasks | `docker logs luna-bot \| grep "Scheduled task completed slowly"` | 0 | >0 (rc.106 — task >5s blocks the 60s poll cycle) |
| Slow DB queries | `docker logs luna-bot \| grep "Slow database query"` | 0 | >0 (rc.106 — anything >500ms gets warned with truncated SQL) |
| Background queue depth | `docker logs luna-bot \| grep "Background task queued"` → `queueDepth` | <50 | approaching 200 cap (rc.106 — global) or 25 per-chat |
| Voice WS lifetime closes | `docker logs luna-bot \| grep "Voice web: closing session on lifetime cap"` | rare | frequent — clients abandoning (rc.106 30m idle / 4h max) |
| Response time | User experience | <10s | >30s |
| Rate limit hits | User reports | Rare | Frequent |
| Telegram 429 retries | `docker logs luna-bot \| grep "Telegram 429"` | 0 | >0 (rc.107 — 3-attempt backoff honoring `retry_after`) |
| Tool audit logs | `docker logs luna-bot \| grep "tool_audit"` | Normal activity | Unusual patterns |
| Event triggers | `docker logs luna-bot \| grep "event_trigger"` | Firing as expected | Missed events |
| Auth failures | `docker logs luna-bot \| grep "auth_fail"` | 0 | >3/min (IP ban at 15/hr) |
| Caddy TLS (prod) | `docker logs luna-caddy` | Certificate valid | Renewal errors |
| Unhandled rejections | `docker logs luna-bot \| grep "Unhandled promise rejection"` | 0 | >0 (rc.103 — Luna keeps running but the cause needs investigation) |

### Daily Check (2 minutes)

```bash
# 1. Public health endpoint must return 204
curl -fsS -o /dev/null -w "/api/health -> %{http_code}\n" http://127.0.0.1:3030/api/health

# 2. Container state + error count over last 24h
docker ps --format "table {{.Names}}\t{{.Status}}" --filter name=luna
docker logs luna-bot --since 24h 2>&1 | grep -cE "ERROR|FATAL|Unhandled promise"
```

---

## Escalation Path

```
User → Department Champion → IT Operations → Software Development Team
         (Level 2 fix)        (infra/config)    (Level 3 / core fix)
```

1. **User tries self-service first:** Ask Luna for help
2. **Department Champion:** pack config, tool tuning, user training
3. **IT Operations:** container restarts, credential rotation, backups
4. **Software Development:** architecture changes, new dashboards, core bugs

---

## Backup & Recovery

| Component | Backup Method | Frequency | Recovery Time |
|-----------|-------------|-----------|---------------|
| Database | `cp store/luna.db` or `pg_dump` | Daily (automated) | < 30 minutes |
| Configuration | `.env` file (manual, version controlled separately) | On change | < 5 minutes |
| Packs | `packs/` directory (in git) | Every commit | `git pull` |
| User tools | In database (backed up with DB) | With DB backup | With DB restore |

---

*luna v1.0.0-rc.60 — Operations & Support Model*
