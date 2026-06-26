# Luna — Production Deployment to the Dedicated MacBook Pro

**Date:** 2026-06-26
**Status:** Design approved; pending spec review → implementation plan
**Scope:** Luna agent only (superprompt repo). NovaLink-Bridge and KPI-operations
deploy from their own folders in their own sessions and are **out of scope** here,
except for the bridge **contract** Luna consumes (§8).

This document supersedes the four legacy deployment guides in `docs/`
(`deployment-guide.md`, `deployment-runbook.md`, `deployment-checklist.md`,
`inmotion-deployment-guide.md`), which are sediment from the abandoned
InMotion / internal-Linux-VM plans and were never canonical.

---

## 0. Decisions locked (with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Production cutover** of `luna-bot` to the MacBook Pro, **same** Telegram bot token | The dedicated Mac becomes the real Luna; the team keeps the bot they know |
| 2 | Dev instance **retired immediately before** prod activation; zero overlap | A Telegram bot token can poll from only one place at a time |
| 3 | **Migrate** `.env` + `store/` data (not a clean start) | Preserve memory, schedules, board, Claude session state |
| 4 | **NovaLink-Bridge on the Linux VM** (`192.168.2.234`), Luna points at a LAN URL | Keep the Mac lean for Luna + Ollama + voice; bridge is a thin read-only proxy |
| 5 | **On-prem-first AI**: default Ollama `qwen3.5:4b`, Claude is fallback for non-sensitive heavy/long-form | Production data (inventory/BOM) reasoning stays on the LAN; Claude egress only for non-sensitive generalist work |
| 6 | **Full deployment**: Telegram **+** full web UI (voice chat, all dashboards, `/learn` tutoring) | Luna is a complete "Junior Industrial Engineer" *and* generalist/learning support employee |
| 7 | **mkcert internal CA** for web-UI HTTPS, served by Caddy, addressed by a stable hostname | No usable company domain / internal DNS; mkcert is self-contained on the LAN and aligns with on-prem-first |
| 8 | **FileVault OFF**, auto-login, never sleep | Machine lives in a locked datacenter; enables unattended boot recovery |
| 9 | **Daily encrypted `store/` backup pushed to the VM** | Separate failure domain; VM storage self-adjustable to 1 TB |
| 10 | **Lightweight container runtime (Colima)** rather than Docker Desktop | Saves 2–3 GB VM overhead on a 16 GB box; no business-licensing terms |
| 11 | **Memory-hygiene & leak audit** is part of this deployment | 16 GB ceiling demands enforced memory release, not hopeful tuning (§9) |

---

## 1. Target topology

```
NovaLink LAN
├── MacBook Pro  192.168.2.244  (Apple M1 · 8 core · 16 GB · macOS 26.5.1)   ← THIS DEPLOYMENT
│     macOS host:  Colima (Docker runtime) + Ollama (qwen3.5:4b, nomic-embed-text) + mkcert CA
│     containers:  luna-bot · speaches (voice) · searxng (search) · caddy (HTTPS)
│     persistent:  ./store  (luna.db, claude-home, schedules, board)
│
├── Linux VM     192.168.2.234  (Ubuntu 26.04 · 8 core · 30 GB · 59 GB free→1 TB)  ← SEPARATE SESSION
│     hosts NovaLink-Bridge (Docker NOT yet installed — bridge-session prereq)
│     also receives Luna's daily store/ backups
│
└── Dev Mac (192.168.3.187, M3 Pro / 18 GB) — RETIRED from prod role at cutover
```

- Luna reaches **Ollama on the host** at `host.docker.internal:11434` (Apple-Silicon GPU via unified memory).
- Luna reaches the **bridge over the LAN** at the VM (§8 contract).
- **Telegram** is cloud (works anywhere). The **web UI** is LAN-only (mkcert HTTPS) until a future VPN (§7).

### Machine profiles (verified 2026-06-26 via SSH)

| | Dev Mac (source) | Prod MacBook Pro (target) | Linux VM (bridge) |
|---|---|---|---|
| Chip | M3 Pro | Apple M1 | x86-64 |
| Cores | 11 | 8 | 8 |
| RAM | 18 GB | **16 GB** | 30 GB |
| Disk free | 25 GB | 839 GB | 59 GB (→1 TB) |
| OS | macOS 15.7.8 | macOS 26.5.1 | Ubuntu 26.04 |
| Runtime | Docker 29.5.3 | **none (clean slate)** | **none** |
| Ollama | ✓ + models | **none** | `ollama` group present |
| Node | 26 | **none** | — |
| SSH | — | passwordless key installed ✓ | key auth works ✓ |

**Why the Mac despite less RAM than the VM:** the Mac is the only Apple-Silicon box, so
Ollama gets GPU acceleration there; on the x86 VM, Ollama would be CPU-only and far too slow.

---

## 2. Host build-out (clean Mac → ready)

The prod Mac has no Homebrew/Docker/Ollama/Node. Build order:

1. Install **Homebrew**.
2. Install **Colima** + Docker CLI + Compose plugin. Configure the Colima VM with
   enough resources for the stack (see §6 RAM budget) and confirm it starts on login.
3. Install **Ollama** (host, for GPU). `ollama pull qwen3.5:4b` + `ollama pull nomic-embed-text`.
   Configure auto-start and the `keep_alive`/unload policy (§9).
4. Install **mkcert**, create the local CA, issue Luna's cert for the chosen hostname.
5. Clone the **superprompt** repo into a clean project folder (deploy-from-own-folder).

---

## 3. Configuration delta vs. the dev box

Migrated unchanged via §4, **except** these deliberate prod `.env` edits:

- `OLLAMA_CHAT_MODEL=qwen3.5:4b`, `OLLAMA_TOOL_MODEL=qwen3.5:4b` (was `qwen3.5:latest`).
  `OLLAMA_EMBED_MODEL=nomic-embed-text` unchanged.
- `AI_PROVIDER=ollama`, `AUTO_ROUTE=true` (on-prem-first; Claude is the fallback).
- `NOVALINK_BRIDGE_URL=https://192.168.2.234:5443` (the VM, LAN), **not**
  `http://novalink-bridge:5000`. Mount the bridge's public cert and set
  `NODE_EXTRA_CA_CERTS=/app/certs/bridge-cert.pem` so Node trusts it (full contract in §8).
- Web UI enabled: `VOICE_WEB_PORT=3030`, per-user tokens (`/webtoken` flow),
  `CADDY_DOMAIN=<luna-hostname>`, `VOICE_WEB_ORIGIN=https://<luna-hostname>`.
- Compose runs with the **`production` profile** (Caddy up, serving HTTPS for the full
  web UI: voice chat, `/sim` `/capacity` `/sequence` `/board` `/learn`).
  **Matrix profile stays OFF** (Telegram only).

---

## 4. Data + secrets migration (dev Mac → prod Mac)

- Quiesce dev Luna (`docker compose down`) so `store/luna.db` is consistent
  (DELETE-journal SQLite = single self-contained file, no `-wal`/`-shm` sidecars).
- `rsync` `store/` (≈10 MB: `luna.db`, `claude-home/`, schedules, board) and `scp` `.env`
  over the LAN — **never** through git. `chmod 600 .env` on arrival.
- Same `CLAUDE_CODE_OAUTH_TOKEN`, Telegram bot token, and bridge key carry over as-is.
  Runbook records the OAuth token's age (~1-year life) so it does not silently lapse.

---

## 5. Cutover sequence (hard-ordered, zero-overlap)

1. **Pre-stage** the prod Mac fully (build-out §2, repo cloned, cert issued, prod `.env`
   prepared) **while dev keeps serving**.
2. **Quiesce dev** → `docker compose down`. **Verify** the dev bot is actually offline.
3. **Migrate** `store/` + `.env` (§4).
4. **Start prod** → `docker compose --profile production up -d`. Healthchecks green.
5. **Verify live** (§7 criteria).
6. **Retire** the dev box from the prod role.

---

## 6. Operating as an unattended server

- **FileVault OFF** (locked datacenter) → clean unattended boot.
- **Auto-login** + **never sleep** (`pmset`/disable sleep) so Colima + Ollama + the stack
  recover after any reboot. Compose `restart: unless-stopped` already set.
- **Daily backup**: a `launchd` job tars `store/` (encrypted) and pushes it to the VM
  (`192.168.2.234`) over the LAN, with rotation/retention.

### RAM budget (16 GB, the binding constraint)

Steady-state target with `qwen3.5:4b` (≈3.4 GB) + Colima (lean) + Speaches idle-unloaded
+ Luna + macOS must stay clear of swap. Enforced by §9 (Ollama unload + Speaches idle-unload).
Validation includes a concurrent voice + calc job RSS check.

---

## 7. Web-UI access & TLS (mkcert)

- **Why mkcert, not Let's Encrypt:** no usable company domain / internal DNS, so there is
  no DNS lever for an ACME challenge. mkcert stands up a local CA → trusted HTTPS on the
  LAN with no public dependency; each team device trusts the CA once.
- **Stable hostname** (not a hard-coded IP) so a future VPN is a clean add-on.
- **Off-site (future, ~2–3 months):** add a VPN/WireGuard overlay; the same mkcert + LAN
  setup then works remotely unchanged. (Tailscale could fold LAN + off-site into one tool
  with real certs, at the cost of a cloud coordination dependency — weigh when off-site lands.)
- **Deliverable:** a short bilingual "install the Luna CA" guide for the team.

### Success criteria

- Dev bot confirmed offline; prod bot answers the same Telegram chat.
- All container healthchecks green; **survives a test reboot** unattended
  (stack + Ollama auto-recover).
- `novalink_health` + a real bridge query succeed from prod over the LAN.
- Web UI reachable at `https://<hostname>` with a **trusted** cert on a CA-installed
  device; dashboards + browser voice chat + `/learn` all functional.
- A backup tarball lands on the VM and **restores cleanly** in a dry run.
- §9 soak test shows **flat RSS** (no unbounded growth) over the soak window.

---

## 8. Cross-project dependency: the bridge contract

Luna cannot fully go live until NovaLink-Bridge is up on the VM (Docker not installed
there yet — a **bridge-session** prerequisite). This plan only defines what Luna consumes:

- **Endpoint (pinned 2026-06-26):** `NOVALINK_BRIDGE_URL=https://192.168.2.234:5443`.
  TLS terminates at `5443` on the VM and forwards to the bridge container's `:5000`
  internally (`https://192.168.2.234:5443 → bridge:5000`).
- **Cert:** self-signed for the IP `192.168.2.234`. **Hard requirements:**
  1. The cert **must** carry an IP SAN — `subjectAltName = IP:192.168.2.234` — or Node
     rejects it even when trusted (CN-only is not enough).
  2. **Luna trusts it via `NODE_EXTRA_CA_CERTS`**: mount the bridge's *public* cert PEM
     (cert only) into the Luna container and set `NODE_EXTRA_CA_CERTS=/app/certs/bridge-cert.pem`.
     Keep TLS verification **on**. Do **not** use `NODE_TLS_REJECT_UNAUTHORIZED=0` (disables
     verification process-wide). Implementation check: confirm Luna's bridge client uses
     Node's default trust store and does not build its own HTTPS agent that ignores the var.
  3. Make the cert **long-lived** (≈10 yr, both ends self-controlled); record expiry.
  - *Optional:* issue this cert from the same **mkcert** CA used for the web UI
    (`mkcert 192.168.2.234` sets the IP SAN automatically) for a single trusted CA
    everywhere — vs. a standalone self-signed cert that keeps the bridge self-contained.
    Bridge session's call; both are acceptable.
- **VM firewall:** allow `5443/tcp` from `192.168.2.244` (bridge-session checklist item).
- **API key**: Luna's own bridge key (pre-prod TODO: mint Luna its own key and revoke the
  shared test key).
- **Tools unaffected**: `novalink_list_queries` / `novalink_query` / `novalink_health`.

---

## 9. Memory-hygiene & leak audit (workstream)

The 16 GB ceiling makes enforced memory release a deployment requirement, not a nicety.
Findings from the 2026-06-26 recon, and the audit scope:

### Confirmed clean (do not touch)
- **Timer lifecycle.** All 20 `setInterval` sites have matching `clearInterval`
  (per-request typing indicators, IPC heartbeat, scheduler poll, salience-decay,
  proactive follow-up, learning-session cleanup, calc result sweep). Not a leak source.

### Confirmed fix (high value)
- **Ollama `keep_alive` is never set** (0 occurrences in `src/`). Default 5-minute model
  residency pins `qwen3.5:4b` in RAM after every call. **Action:** set `keep_alive`
  explicitly on Ollama requests and enforce unload between idle periods (target the
  provider that builds the Ollama request body). Tunable, with an aggressive default
  suited to 16 GB.

### Audit targets (require reading, not grep — verify and fix or explicitly defer)
- **SA1 Worker sandbox lifecycle.** A quick grep found no explicit `.terminate()`; V8
  isolates that are not terminated leak hard. Verify each generated-code Worker is
  terminated on completion/timeout/error and that no isolate outlives its task.
- **In-memory caches.** The 24h model-list cache (`providers/claude.ts`) and any other
  module-level caches/Maps: confirm bounded size + TTL eviction; no unbounded growth keyed
  by chat/user/session.
- **Heavy calc modules.** `sigma.ts` (1885L), `balance.ts` (1106L), and the DOE /
  Monte-Carlo / GA paths the base compose already flags at the 4 GB ceiling: ensure large
  intermediate arrays are released after the result is produced (no retained references via
  closures, history buffers, or logs).
- **Speaches idle-unload.** Confirm the sidecar's STT/TTS models unload on idle and the TTL
  is tuned so they are not resident during long text-only stretches.

### Proof
- A **soak test**: drive representative traffic (chat, a bridge query, a voice round-trip,
  one heavy calc) over a sustained window and confirm **flat RSS** for the Luna container
  and bounded host memory (Ollama unloads, Speaches unloads). Any monotonic climb is a
  finding to fix before go-live (per repo policy: self-audit findings stay in scope).

---

## 10. Open items to confirm before / during execution

1. **Bridge contract** (§8): endpoint pinned to `https://192.168.2.234:5443`. Remaining to
   coordinate with the bridge session: cert with IP SAN delivered to Luna for
   `NODE_EXTRA_CA_CERTS`, `ufw` allow `5443`, and Luna's own minted bridge key.
2. **`host.docker.internal` under Colima** (§2): verify the Luna container reaches host
   Ollama on `:11434`; fallback is the Colima gateway IP. (Native under Docker Desktop.)
3. **Luna hostname** for the cert/CADDY_DOMAIN (e.g. `luna.novalink.local` or the Mac's
   hostname).
4. **Backup retention** policy (count/age) on the VM.
