# clauded — Resource Allocation Guide

**For:** IT Team / CTO
**Version:** v1.0.0-rc.60 | April 2026
**Target:** InMotion Dedicated Server (Alma Linux 8)

---

## Server Specification

| Resource | Specification |
|----------|--------------|
| RAM | 64GB |
| CPU | 16 cores |
| Storage | 250GB NVMe SSD |
| OS | Alma Linux 8 |
| Network | 1Gbps |
| Max deployments | 10 |
| Max users per deployment | 10 |
| Max total users | 100 |

---

## Service Resource Allocation

### Shared Services (always running)

| Service | RAM Limit | CPU Limit | Idle RAM | Peak RAM | Purpose |
|---------|-----------|-----------|----------|----------|---------|
| Ollama | 8GB | 4 cores | 4GB | 8GB | Local AI model inference (Qwen 3.5) |
| MariaDB/PostgreSQL | 4GB | 2 cores | 500MB | 4GB | Production database |
| Speaches | 2GB | 2 cores | 1.5GB | 2GB | Voice STT (Whisper) + TTS (Kokoro) |
| SearXNG | 512MB | 0.5 core | 100MB | 400MB | Web search aggregator |
| Caddy | 128MB | 0.5 core | 30MB | 100MB | HTTPS reverse proxy |
| **Subtotal** | **~15GB** | **~9 cores** | **~6GB** | **~15GB** | |

### Per-Deployment Bots

| Service | RAM Limit | CPU Limit | Idle RAM | Peak RAM |
|---------|-----------|-----------|----------|----------|
| clauded-bot (each) | 1GB | 0.5 core | 200MB | 800MB |
| **10 deployments** | **10GB** | **5 cores** | **2GB** | **8GB** |

### Total Allocation

| Category | RAM | CPU |
|----------|-----|-----|
| Shared services | 15GB | 9 cores |
| 10 bot instances | 10GB | 5 cores |
| OS + overhead | 4GB | 2 cores |
| **Total allocated** | **29GB** | **16 cores** |
| **Headroom** | **35GB** | **0 cores** |

The 35GB RAM headroom provides buffer for:
- Ollama model loading spikes (models are memory-mapped)
- Database query caching
- Linux filesystem cache (improves SSD read performance)
- Unexpected traffic bursts

---

## Bottleneck Analysis

### Ollama (primary bottleneck)

Ollama processes one inference at a time per model. With 10 deployments and 100 users, simultaneous Ollama tool calls queue.

**Mitigation:**
- Default provider is Claude (handles most queries — parallel, subprocess-based)
- Ollama handles tool calls only (less frequent than conversation)
- `/auto` routing sends reasoning to Claude, tool requests to Ollama
- Circuit breaker prevents runaway loops (max 10 iterations)

**Observed throughput:** ~2-4 tool calls/second on Qwen 3.5 with 16 cores.

### Database (secondary bottleneck)

| Backend | Concurrent reads | Concurrent writes | Risk |
|---------|-----------------|-------------------|------|
| SQLite (dev) | Unlimited (WAL) | 1 at a time | Not suitable for production |
| MariaDB | Unlimited (InnoDB) | Row-level locking | Low risk for 100 users |
| PostgreSQL | Unlimited (MVCC) | Row-level locking | Low risk for 100 users |

**Recommendation:** MariaDB or PostgreSQL eliminates the write bottleneck. With connection pooling (DB_POOL_MAX=20), 100 concurrent users are well within capacity.

### Claude Subprocess (no bottleneck)

Each Claude call spawns a subprocess. Multiple users can query Claude simultaneously — each gets its own process. Limited by Claude subscription rate limits, not server resources.

### Voice (Speaches)

STT and TTS are sequential per model. If 10 users send voice messages simultaneously, they queue. Speaches uses ~2GB RAM for model caching.

**Mitigation:** Voice is used intermittently, not continuously. Real-world concurrent voice sessions are typically 1-3, not 10.

---

## Scaling Guidance

### When to add resources

| Symptom | Cause | Action |
|---------|-------|--------|
| Slow Ollama responses (>10s for tool calls) | Too many concurrent tool requests | Reduce Ollama-dependent features or add GPU |
| Database connection pool exhaustion | Too many concurrent queries | Increase DB_POOL_MAX or add read replicas |
| High memory usage on bot instances | Large conversation contexts | Restart instances, tune context health |
| Disk space low | Database growth + logs | Archive old data, rotate logs |
| Voice responses slow | Multiple concurrent STT/TTS | Acceptable — voice is intermittent |

### Scaling to more than 10 deployments

| Deployment count | Server needs | Notes |
|-----------------|-------------|-------|
| 1-5 | 32GB RAM, 8 cores | Comfortable |
| 6-10 | 64GB RAM, 16 cores | Current spec |
| 11-20 | 128GB RAM, 32 cores | Add second Ollama instance |
| 20+ | Multiple servers | Kubernetes or Docker Swarm |

### Adding GPU for Ollama

If Ollama throughput becomes a bottleneck, adding a GPU dramatically improves inference speed:

| GPU | Ollama speedup | Cost impact |
|-----|----------------|-------------|
| NVIDIA T4 (16GB) | 5-10x faster | ~$300/month (cloud) |
| NVIDIA A10G (24GB) | 10-20x faster | ~$500/month (cloud) |
| Local GPU (RTX 4090) | 15-25x faster | $1,600 one-time |

With GPU, Ollama can handle 20-50 tool calls/second, eliminating the inference bottleneck entirely.

---

## Monitoring Recommendations

### Docker resource monitoring

```bash
# Real-time resource usage
docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"

# Per-service logs
docker compose -f docker-compose.production.yml logs -f clauded-bot-1
docker compose -f docker-compose.production.yml logs -f ollama
```

### Database monitoring

**MariaDB:**
```sql
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Slow_queries';
SHOW ENGINE INNODB STATUS\G
```

**PostgreSQL:**
```sql
SELECT count(*) FROM pg_stat_activity;
SELECT * FROM pg_stat_user_tables ORDER BY n_tup_upd DESC LIMIT 10;
```

### Disk space

```bash
# Overall
df -h /

# Per-service data
du -sh store/deploy-*/
du -sh /var/lib/docker/volumes/
```

### Caddy access logs

```bash
# Recent requests
tail -f docker/caddy-data/access.log | jq .

# Error rate
grep '"status":5' docker/caddy-data/access.log | wc -l
```

---

## Backup Strategy

### Database (daily)

**MariaDB:**
```bash
# Add to crontab: 0 2 * * * /path/to/backup-mariadb.sh
docker exec clauded-mariadb mysqldump -u clauded -p clauded > backup-$(date +%Y%m%d).sql
gzip backup-$(date +%Y%m%d).sql
# Retain 30 days
find /backups/ -name "backup-*.sql.gz" -mtime +30 -delete
```

**PostgreSQL:**
```bash
docker exec clauded-postgres pg_dump -U clauded clauded > backup-$(date +%Y%m%d).sql
gzip backup-$(date +%Y%m%d).sql
find /backups/ -name "backup-*.sql.gz" -mtime +30 -delete
```

### Application data (weekly)

```bash
# Store directories (per-deployment forge tools, workspace files)
tar czf clauded-data-$(date +%Y%m%d).tar.gz store/ forge/ workspace/
```

### TLS certificates

Caddy manages certificates automatically. The `caddy-data` volume contains them. Back up this volume if migrating servers.

---

*clauded v1.0.0-rc.60 — Resource Allocation Guide*
