# clauded — Operations & Support Model

**For:** IT Operations, CTO, Department Champions

---

## Ownership

| Role | Responsibility |
|------|---------------|
| **Software Development Team** | Core platform development, Level 3 packs, dashboards, architecture |
| **IT Operations** | Deployment, infrastructure, backups, monitoring, credentials |
| **Department Champions** | Pack configuration, tool tuning, user training, feedback |
| **clauded (AI)** | Self-service: Level 2 packs, tool creation, skill learning, auto-healing |

---

## Incident Classes

### Severity 1 — Bot Down (service unavailable)

| Symptom | Likely Cause | Recovery |
|---------|-------------|----------|
| Telegram bot not responding | Docker container crashed | `docker compose up -d --build clauded` |
| "Connection refused" errors | Docker not running | Restart Docker Desktop |
| Health check failing | Process crash inside container | Check `docker logs clauded-bot` |

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
| New Level 2 tool | Department Champion + clauded | Conversational creation |
| New Level 3 dashboard | Software Development Team | Requirements → development → deployment |
| Pack configuration change | Department Champion | `/pack enable/disable` or tell clauded |
| API connection | IT Operations | Add credentials to `.env`, restart container |

**SLO Target:** Acknowledge within 24 hours, prioritize in next sprint.

---

## Monitoring

### What to Watch

| Metric | Where | Healthy | Warning |
|--------|-------|---------|---------|
| Container health | `docker ps` | "healthy" | "unhealthy" or missing |
| Startup warnings | `docker logs clauded-bot \| grep WARN` | 0 | >0 |
| Processes running | Docker logs "spawned" | 3 (core + tools + parsers) | <3 |
| Packs loaded | Docker logs "Loaded domain pack" | 11 | <11 |
| Response time | User experience | <10s | >30s |
| Rate limit hits | User reports | Rare | Frequent |

### Daily Check (2 minutes)

```bash
docker ps --format "table {{.Names}}\t{{.Status}}" --filter name=clauded
docker logs clauded-bot --since 24h 2>&1 | grep -c "ERROR"
```

---

## Escalation Path

```
User → Department Champion → IT Operations → Software Development Team
         (Level 2 fix)        (infra/config)    (Level 3 / core fix)
```

1. **User tries self-service first:** Ask clauded for help
2. **Department Champion:** pack config, tool tuning, user training
3. **IT Operations:** container restarts, credential rotation, backups
4. **Software Development:** architecture changes, new dashboards, core bugs

---

## Backup & Recovery

| Component | Backup Method | Frequency | Recovery Time |
|-----------|-------------|-----------|---------------|
| Database | `cp store/clauded.db` or `pg_dump` | Daily (automated) | < 30 minutes |
| Configuration | `.env` file (manual, version controlled separately) | On change | < 5 minutes |
| Packs | `packs/` directory (in git) | Every commit | `git pull` |
| User tools | In database (backed up with DB) | With DB backup | With DB restore |

---

*clauded v1.0.0-rc.31 — Operations & Support Model*
