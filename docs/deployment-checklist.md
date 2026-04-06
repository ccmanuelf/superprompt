# clauded v1.0.0-rc.29 — Deployment Checklist

Pre-deployment criteria, considerations, and decision factors for production deployment.

---

## 1. Deployment Option Decision Factors

| Factor | InMotion Dedicated | VMware Internal | Render Cloud |
|--------|:-:|:-:|:-:|
| **Monthly hosting cost** | $100-200 | $0 (existing infra) | $50-150 |
| **+ Claude subscription** | +$200/account | +$200/account | +$200/account |
| **Network latency to Ollama** | Higher (remote) | Low (LAN) | Higher (remote) |
| **GPU for Ollama** | No (CPU only) | Possible (passthrough) | No (CPU only) |
| **Data sovereignty** | US datacenter | On-premises ✅ | US cloud |
| **IT team effort** | Low (managed) | Medium (VMware admin) | Low (PaaS) |
| **Client API connectivity** | ✅ External access | ⚠️ Needs NAT/proxy | ✅ External access |
| **Uptime SLA** | 99.9% | Internal IT | 99.95% |
| **Backup** | Manual/cron | VMware snapshots | Managed |

### Recommended Path
- **Phase 1 (internal):** VMware — zero cost, full data control, E2E validation
- **Phase 2 (client-facing):** InMotion or Render — external access for client APIs

---

## 2. Pre-Deployment Checklist

### Infrastructure
- [ ] Hosting platform selected (VMware / InMotion / Render)
- [ ] Docker available on target (Docker Engine or Docker Desktop)
- [ ] Minimum 16 GB RAM (32 GB recommended) verified
- [ ] Minimum 50 GB SSD free space
- [ ] Docker memory limit set to ≥8 GB

### AI Providers
- [ ] Ollama installed on target or GPU host
- [ ] Ollama models pulled: `ollama pull qwen3.5:latest` + `ollama pull nomic-embed-text`
- [ ] Dedicated Anthropic Max account ($200/month) created
- [ ] `claude setup-token` run to generate `CLAUDE_CODE_OAUTH_TOKEN`
- [ ] OLLAMA_HOST configured (if Ollama on separate machine)

### Messaging
- [ ] Telegram bot created via @BotFather (token obtained)
- [ ] ALLOWED_CHAT_ID configured (SECURITY: required for production)
- [ ] Matrix homeserver deployed (if Matrix enabled) — see `reference/matrix-setup.md`

### Voice
- [ ] Speaches sidecar configured in docker-compose.yml
- [ ] STT model (faster-whisper-small) will auto-download on first use
- [ ] TTS model (Kokoro-82M) will auto-download on first use

### Web UI
- [ ] VOICE_WEB_PORT set (default: 3030)
- [ ] VOICE_WEB_TOKEN generated (optional fallback): `openssl rand -hex 32` — per-user tokens via `/webtoken create` are now the recommended approach
- [ ] TLS certificates (VOICE_WEB_TLS_CERT/KEY) for non-localhost access
- [ ] Reverse proxy (Nginx/Apache) configured for HTTPS

### Database
- [ ] **Development/E2E:** SQLite (default, no config needed)
- [ ] **Production:** MariaDB or PostgreSQL selected
- [ ] DB migration tested (StorageProvider swap in db.ts)
- [ ] Backup strategy defined (automated daily with point-in-time recovery)

### Security
- [ ] ALLOWED_CHAT_ID set (prevents unauthorized access)
- [ ] VOICE_WEB_TOKEN set (optional shared fallback) or per-user tokens configured via `/webtoken create`
- [ ] TLS certificates installed (web UI HTTPS)
- [ ] .env file permissions restricted (chmod 600)
- [ ] Docker network isolated from host network

### Packs
- [ ] Department packs verified: `/pack list` shows all 10
- [ ] Client packs configured (if applicable): API tokens in .env
- [ ] Unnecessary packs disabled for this department: `/pack disable [name]`

---

## 3. Post-Deployment Verification

Run the full E2E test guide: `docs/e2e-test-guide.md` (17 sections, 65+ tests)

### Quick Smoke Test (5 minutes)
- [ ] `docker ps` shows clauded-bot healthy
- [ ] `docker logs clauded-bot | grep "Application started"` — present
- [ ] `docker logs clauded-bot | grep "WARN\|ERROR" | wc -l` — 0
- [ ] 3 processes running (core + tools + parsers)
- [ ] 10 packs loaded
- [ ] Send "Hello" on Telegram — response within 10s
- [ ] Open `http://[server]:3030/` — voice chat loads
- [ ] Open `http://[server]:3030/sim` — simulation dashboard loads

### Functional Verification (30 minutes)
- [ ] Text message → AI response ✅
- [ ] Voice message → transcription + response ✅
- [ ] `/skill list` → shows builtin skills ✅
- [ ] `/pack list` → shows 10 packs with status ✅
- [ ] `/board add Test task` → card created ✅
- [ ] `/trust list` → shows trust decisions ✅
- [ ] `/webtoken create smoke-test 24h` → generates per-user web token ✅
- [ ] `/webtoken list` → shows the token just created ✅
- [ ] Web dashboards: all 12 return HTTP 200 ✅
- [ ] API security: `/api/sim/info` returns 401 without token ✅

---

## 4. Scaling Considerations

### Single Instance Capacity

| Scale | Messages/Day | Single $200 Account? |
|-------|:-:|:-:|
| E2E testing (12 users) | 100-200 | Yes |
| One department (15-20 users) | 300-500 | Likely yes |
| Company-wide (80-150 users) | 2,000-5,000 | No — multiple instances |

### Multi-Instance Architecture
Each department (or group) gets its own clauded instance:
- Own Docker container
- Own Anthropic Max subscription ($200/month)
- **Shared database** (MariaDB/PostgreSQL) — single source of truth
- Own pack configuration (enabled/disabled per instance)

### Ollama Scaling
- Ollama doesn't need to run on the same machine
- Set `OLLAMA_HOST=http://gpu-server:11434` to use a dedicated GPU server
- GPU inference: 1-3s responses (NVIDIA with 8GB+ VRAM)
- CPU inference: 5-15s responses (acceptable for text, slow for voice)

---

## 5. Monitoring

### Health Checks
- Docker health check built-in (PID-based)
- Process 2/3 auto-restart on crash (5 attempts per 60s)
- Circuit breaker detects stuck tool loops

### Log Monitoring
- `docker logs -f clauded-bot` for real-time
- Structured JSON logs (pino) — parseable by any log aggregator
- Log levels: debug, info, warn, error

### Metrics to Watch
- Response time per provider (Claude vs Ollama)
- Rate limit hits per user
- Pack weight trends (which packs are succeeding/failing)
- Context health degradation frequency
- Tool execution success/failure rates

---

## 6. Backup & Recovery

### Database
- **SQLite:** Copy `store/clauded.db` (stop container first or use WAL checkpoint)
- **PostgreSQL/MariaDB:** `pg_dump` / `mysqldump` with automated cron
- Daily automated backups recommended
- Test restore procedure before going live

### Configuration
- `.env` file — version controlled separately (NOT in git)
- `packs/` directory — version controlled in git
- `forge/` directory — user-created tools/skills, include in backups

### Recovery
- If DB corrupts: delete `store/clauded.db`, restart (auto-recreates, but data lost)
- If container crashes: `docker compose up -d --build clauded`
- If child process crashes: auto-restart built-in (SA3)

---

## 7. Claude Subscription Notes

- **Model:** Claude via `claude` CLI (`claude -p` subprocess)
- **Auth:** `CLAUDE_CODE_OAUTH_TOKEN` env var (generated via `claude setup-token`)
- **Cost:** Fixed monthly fee (Anthropic Max ~$200/month) — **no per-token API consumption**
- **The deployed version runs on the same subscription model as the demo**
- **Scaling:** One subscription per clauded instance. Company-wide = N instances × $200/month

---

*clauded v1.0.0-rc.29 — Deployment Checklist*
