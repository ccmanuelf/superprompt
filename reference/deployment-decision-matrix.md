# Deployment Decision Matrix

> CTO/Board evaluation — InMotion vs VMware vs Render

---

## Decision Factors

| Factor | InMotion Dedicated | VMware Internal | Render Cloud |
|--------|-------------------|-----------------|-------------|
| **Monthly cost** | ~$100-200/mo (existing contract) | $0 (existing infra) | ~$50-150/mo (compute) + DB |
| **Anthropic Max** | +$200/mo per account | +$200/mo per account | +$200/mo per account |
| **Total estimated** | $300-400/mo | $200/mo | $250-350/mo |
| **Network latency** | External (US datacenter) | Internal LAN (~1ms) | External (US region) |
| **Ollama hosting** | On server (needs GPU or CPU inference) | On VM or separate GPU host | Separate Ollama host needed |
| **Docker support** | Yes (root access) | Yes (VMware) | Yes (native) |
| **GPU available** | No (CPU only, slower inference) | Depends on VM host | No (CPU only on Render) |
| **Data sovereignty** | US datacenter | On-premises (full control) | US cloud (Render's infra) |
| **Backup/recovery** | Manual or cron | VMware snapshots | Render managed |
| **Scaling** | Fixed resources | Limited by host capacity | Auto-scale (paid) |
| **IT team effort** | Low (managed hosting) | Medium (VMware admin) | Low (PaaS) |
| **Client data concerns** | Shared hosting environment | Full isolation | Cloud provider TOS |
| **Voice (Speaches)** | CPU-only STT/TTS (slower) | Can dedicate resources | CPU-only (slower) |
| **Uptime SLA** | 99.9% (InMotion guarantee) | Depends on internal IT | 99.95% (Render) |

---

## Recommendation by Use Case

### Use Case A: Internal-only deployment (9 departments, no client data)

**Recommended: VMware Internal**
- Zero hosting cost beyond Anthropic subscription
- Internal LAN = fastest latency for Ollama + Speaches
- Full data control (HR data, financial data stays on-premises)
- VMware snapshots for backup
- IT team has existing VMware expertise

### Use Case B: Client-facing integrations (Shopify, ERP, EDI)

**Recommended: InMotion Dedicated or Render**
- Needs reliable external connectivity (client APIs, webhooks)
- SLA matters — client integrations can't go down during business hours
- InMotion: existing contract, root access, managed hosting
- Render: easier scaling if client count grows rapidly

### Use Case C: Hybrid (internal + future client-facing)

**Recommended: Start VMware, migrate to InMotion/Render for client-facing**
- Phase 1 (v1.0): VMware internal for departments + E2E
- Phase 2 (v1.1): Add InMotion/Render instance for client-facing integrations
- Both connect to same database (SA2 StorageProvider abstraction)
- Client data isolated from internal data by instance + pack

---

## Ollama Considerations

Ollama is the biggest variable. It needs either:
- **CPU inference** (any server): 6-8 GB RAM, 5-15 second response times with Qwen 3.5
- **GPU inference** (NVIDIA): 4-8 GB VRAM, 1-3 second response times

| Option | GPU? | Inference Speed | Notes |
|--------|------|----------------|-------|
| InMotion | No | 5-15s | Acceptable for text, slow for voice |
| VMware (with GPU passthrough) | Possible | 1-3s | Best UX if GPU available |
| VMware (CPU only) | No | 5-15s | Same as InMotion |
| Render | No | 5-15s | Ollama can't run on Render natively |
| Separate GPU server + any of above | Yes | 1-3s | Ollama on GPU host, clauded connects via OLLAMA_HOST |

**Key insight:** Ollama doesn't need to run on the same machine as clauded. Set `OLLAMA_HOST=http://gpu-server:11434` in .env and Ollama can be on a dedicated GPU machine while clauded runs anywhere.

---

## Claude CLI Considerations

The Claude CLI (`claude -p`) runs as a subprocess inside the Docker container. It connects to Anthropic's servers via HTTPS. Requirements:
- Outbound HTTPS (port 443) to api.anthropic.com
- `CLAUDE_CODE_OAUTH_TOKEN` env var (from `claude setup-token`)
- Fixed monthly fee — no per-token billing
- Works identically on any hosting option

---

## Database Migration Path

| Hosting | Recommended DB | Migration Effort |
|---------|---------------|-----------------|
| VMware | PostgreSQL (Docker container) | 1 week (SA2 StorageProvider swap) |
| InMotion | MariaDB (managed, included in hosting) | 1 week |
| Render | PostgreSQL (Render managed DB) | 1 week |

All three use the same migration path: swap `createStorageProvider()` implementation from better-sqlite3 to pg/mysql2 driver. SA2's StorageProvider abstraction makes this a configuration change, not an architecture change.

---

## What the Teams Can Build vs. What Needs Software Team

### Teams CAN build conversationally (with clauded's AI partner):

| Task | How | Level |
|------|-----|-------|
| New department tool | "I need a tool that calculates X" → conversational builder | Level 2 pack |
| New skill persona | "/skill create quality-expert" with system prompt | Skill |
| Data templates | Upload CSV/Excel to pack templates/ | Level 1 |
| API integrations | Declarative HTTP tools in pack.yaml | Level 2 |
| Auto-skills from workflows | Just use clauded — it learns automatically | Core |
| Intent pattern tuning | Edit pack.yaml regex patterns | Level 2 |

### Software team MUST build:

| Task | Why | Level |
|------|-----|-------|
| Custom web dashboards (like /sim, /capacity) | Requires HTML/JS/TypeScript, chartjs | Level 3 |
| Database schema changes | Requires TypeScript TableInitializer | Level 3 |
| New Telegram commands with CSV handlers | Requires TypeScript in platform handler | Core |
| IPC protocol changes | Requires TypeScript in ipc/ | Core |
| New process types (beyond core/tools/parsers) | Requires TypeScript + Docker changes | Core |
| DB migration (SQLite → PostgreSQL/MariaDB) | Requires driver swap + testing | Core |

### Clear boundary:
- **Level 1-2 packs:** Teams build these themselves conversationally
- **Level 3 packs + core changes:** Software team required
- **S17/S18 specifically:** The order management logic can be Level 2 tools. The **dashboard** (live order board, status visualization) requires Level 3 — software team builds it. The team can use clauded to help design and iterate, but the final TypeScript/HTML is developer work.
