# Luna MacBook Pro Provisioning & Cutover Runbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, against live machines). Steps use checkbox (`- [ ]`) syntax. This is an **operational** plan — most steps are exact shell commands run over SSH with expected output, not TDD. Run it **inline**, not subagent-driven (SSH/cutover state must stay in one session).

**Goal:** Provision the dedicated MacBook Pro from a clean slate and cut `luna-bot` over to it as production, with zero Telegram-token overlap, full web UI over mkcert HTTPS, validated memory behavior, and automated backups.

**Architecture:** Build out the clean M1/16 GB Mac (Homebrew → Colima → Ollama → mkcert), stage and dry-run the full stack with a throwaway Telegram bot, then execute the hard-ordered cutover behind a single human go/no-go gate. NovaLink-Bridge lives on the Linux VM (separate session); this plan only consumes its endpoint.

**Tech Stack:** macOS 26.5.1 (Apple M1), Colima + Docker Compose, host Ollama (`qwen3.5:4b`), mkcert, Speaches/SearXNG/Caddy containers, SQLite (DELETE journal).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-luna-macbook-deployment-design.md` (authoritative). **Prereq plan:** `2026-06-26-luna-deploy-readiness.md` must be merged to `main` first.
- **Machines:** prod Mac `developer@192.168.2.244` (passwordless key installed); bridge/backup VM `manuel@192.168.2.234`; migration source = this dev Mac (`192.168.3.187`, running `luna-bot`).
- **Hostname:** `luna.novalink.local` → `192.168.2.244` (hosts entries; mkcert cert for this name).
- **Bridge endpoint:** `https://192.168.2.234:5443` (self-signed IP-SAN cert; trusted via `NODE_EXTRA_CA_CERTS`). Bridge must be up (separate session) before §Validation's bridge check and before go-live.
- **Hard rule — zero Telegram overlap:** the real bot token runs in exactly one place. Dev stays up until the cutover gate; prod uses a **throwaway** token for all dry-run validation.
- **No-deferral memory gate:** the soak test must show flat RSS before go-live; any climb is fixed first (spec §9).
- **`rg` is not installed on these hosts** — use `grep`.

---

## Phase A — Prod Mac host build-out (clean → ready)

### Task A1: Install Homebrew + base CLI tools

- [ ] **Step 1: Install Homebrew (non-interactive)**

```bash
ssh developer@192.168.2.244 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
```
Expected: ends with "Installation successful!".

- [ ] **Step 2: Put brew on PATH + verify**

```bash
ssh developer@192.168.2.244 'echo "eval \"\$(/opt/homebrew/bin/brew shellenv)\"" >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)" && brew --version'
```
Expected: `Homebrew 4.x`.

- [ ] **Step 3: Install git, mkcert, nss (for Firefox CA trust)**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && brew install git mkcert nss'
```
Expected: all three installed; `mkcert --version` prints a version.

### Task A2: Install Colima + Docker CLI; verify host networking

- [ ] **Step 1: Install Colima + docker client + compose plugin**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && brew install colima docker docker-compose'
```
Expected: `docker --version`, `docker compose version`, `colima version` all succeed.

- [ ] **Step 2: Start Colima sized for the stack (lean, leaves RAM for Ollama on host)**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && colima start --cpu 4 --memory 8 --disk 60 --vm-type vz --mount-type virtiofs'
```
Expected: "colima is running". (8 GB to the Linux VM leaves ~8 GB on the host for Ollama+macOS; tune after the soak test.)

- [ ] **Step 3: Verify `host.docker.internal` reaches the host (critical under Colima)**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && docker run --rm alpine sh -c "getent hosts host.docker.internal || nslookup host.docker.internal" '
```
Expected: resolves to a host-gateway IP. If it does NOT resolve, the Luna→host-Ollama path is broken — fix by adding `--add-host=host.docker.internal:host-gateway` to the luna service (record this in the spec's open-item #2) before continuing.

- [ ] **Step 4: Make Colima start at login**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && brew services start colima'
```
Expected: service started (auto-starts on login alongside the unattended-server config in Phase E).

### Task A3: Install Ollama + pull models

- [ ] **Step 1: Install Ollama**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && brew install ollama && brew services start ollama'
```
Expected: `ollama --version` succeeds; service running on `:11434`.

- [ ] **Step 2: Pull the production models**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && ollama pull qwen3.5:4b && ollama pull nomic-embed-text'
```
Expected: both pulled; `ollama list` shows `qwen3.5:4b` (~3.4 GB) and `nomic-embed-text`.

- [ ] **Step 3: Confirm GPU/Metal acceleration**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && ollama run qwen3.5:4b "say ok" --verbose 2>&1 | tail -5'
```
Expected: a response + eval-rate stats (Metal-accelerated on M1). Note tokens/sec for the soak baseline.

### Task A4: mkcert CA + Luna cert

- [ ] **Step 1: Create the local CA**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && mkcert -install && echo "CAROOT=$(mkcert -CAROOT)"'
```
Expected: "The local CA is now installed..."; prints CAROOT path (its `rootCA.pem` is what team devices will trust — Phase F).

- [ ] **Step 2: Issue the Luna web-UI cert**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && mkdir -p ~/luna-certs && cd ~/luna-certs && mkcert luna.novalink.local 192.168.2.244 && ls'
```
Expected: `luna.novalink.local+1.pem` (cert) + `luna.novalink.local+1-key.pem` (key).

### Task A5: Clone the repo (deploy-readiness merged)

- [ ] **Step 1: Confirm Plan 1 is merged to main**

Run (dev box): `gh pr list --state merged --base main --limit 10 | grep -E "keep-alive|bridge-https|worker-success|soak"`
Expected: the deploy-readiness PRs show merged. If not, finish that plan first.

- [ ] **Step 2: Clone into a dedicated folder**

```bash
ssh developer@192.168.2.244 'mkdir -p ~/Developer && cd ~/Developer && git clone https://github.com/ccmanuelf/superprompt.git && cd superprompt && git log --oneline -3'
```
Expected: clone succeeds; recent commits include the deploy-readiness merges.

---

## Phase B — Prod configuration & secrets

### Task B1: Migrate `.env` and apply prod deltas

- [ ] **Step 1: Copy the dev `.env` to the prod Mac (LAN, not git)**

```bash
scp /Users/mcampos.cerda/Developer/Programming/superprompt/.env developer@192.168.2.244:~/Developer/superprompt/.env
ssh developer@192.168.2.244 'chmod 600 ~/Developer/superprompt/.env'
```
Expected: copied; perms `600`.

- [ ] **Step 2: Apply the prod-specific edits**

Edit `~/Developer/superprompt/.env` on the prod Mac (via `ssh ... 'sed -i ...'` or an editor) to set:

```
OLLAMA_CHAT_MODEL=qwen3.5:4b
OLLAMA_TOOL_MODEL=qwen3.5:4b
OLLAMA_KEEP_ALIVE=60s
AI_PROVIDER=ollama
AUTO_ROUTE=true
NOVALINK_BRIDGE_URL=https://192.168.2.234:5443
VOICE_WEB_PORT=3030
CADDY_DOMAIN=luna.novalink.local
VOICE_WEB_ORIGIN=https://luna.novalink.local
```
Keep unchanged: `TELEGRAM_BOT_TOKEN` (the REAL token — but it is NOT used until cutover; see B4), `CLAUDE_CODE_OAUTH_TOKEN`, `NOVALINK_BRIDGE_API_KEY`, `ALLOWED_CHAT_ID`.
Verify: `ssh developer@192.168.2.244 'grep -E "OLLAMA_(CHAT|TOOL)_MODEL|OLLAMA_KEEP_ALIVE|NOVALINK_BRIDGE_URL|CADDY_DOMAIN" ~/Developer/superprompt/.env'`

- [ ] **Step 3: Record the OAuth token age**

```bash
ssh developer@192.168.2.244 'grep -c CLAUDE_CODE_OAUTH_TOKEN ~/Developer/superprompt/.env'
```
Note in the deployment log that the migrated token is ~1-yr-lived; set a calendar reminder ~10 months out to regenerate (`claude setup-token`).

### Task B2: Install the bridge cert for Node trust

- [ ] **Step 1: Obtain the bridge public cert (from the bridge session)**

The bridge session produces `bridge-cert.pem` (the self-signed IP-SAN cert, public part only). Place it:

```bash
scp /path/to/bridge-cert.pem developer@192.168.2.244:~/Developer/superprompt/certs/bridge-cert.pem
ssh developer@192.168.2.244 'openssl x509 -in ~/Developer/superprompt/certs/bridge-cert.pem -noout -ext subjectAltName'
```
Expected: SAN includes `IP Address:192.168.2.234`. If it does not, the cert is wrong — Node will reject it; get a corrected cert before continuing.

### Task B3: Configure the web UI TLS (mkcert cert via Caddy)

- [ ] **Step 1: Read the current Caddy config to see the ACME assumption**

```bash
ssh developer@192.168.2.244 'cat ~/Developer/superprompt/docker/Caddyfile'
```
Decide the minimal change: point Caddy at the mounted mkcert cert with an explicit `tls <cert> <key>` directive for `luna.novalink.local` (instead of automatic Let's Encrypt). This is a small repo PR (`fix(caddy): serve mkcert cert for luna.novalink.local`) — author it, merge on green CI, and pull on the box. Mount the mkcert cert/key (`~/luna-certs/*.pem`) into the caddy container.

- [ ] **Step 2: Add hosts entry on the prod Mac itself**

```bash
ssh developer@192.168.2.244 'grep -q luna.novalink.local /etc/hosts || echo "127.0.0.1 luna.novalink.local" | sudo tee -a /etc/hosts'
```
Expected: entry present (so the box can resolve its own name for healthchecks).

### Task B4: Stage a throwaway Telegram bot for the dry run

- [ ] **Step 1: Create a throwaway bot**

Via @BotFather create e.g. `@LunaDryRunBot`; copy its token.

- [ ] **Step 2: Point the staged `.env` at the throwaway token (temporarily)**

```bash
ssh developer@192.168.2.244 'cp ~/Developer/superprompt/.env ~/Developer/superprompt/.env.realtoken && sed -i "" "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=<THROWAWAY_TOKEN>|" ~/Developer/superprompt/.env'
```
Expected: `.env.realtoken` holds the real token (restored at cutover); active `.env` uses the throwaway. This guarantees zero overlap with the live dev bot during validation.

---

## Phase C — Dry-run build & validation (dev still live)

### Task C1: Build and start the full stack (throwaway token)

- [ ] **Step 1: Build images**

```bash
ssh developer@192.168.2.244 'cd ~/Developer/superprompt && eval "$(/opt/homebrew/bin/brew shellenv)" && docker compose build luna'
```
Expected: builds clean.

- [ ] **Step 2: Bring up with the production profile**

```bash
ssh developer@192.168.2.244 'cd ~/Developer/superprompt && eval "$(/opt/homebrew/bin/brew shellenv)" && docker compose --profile production up -d && docker compose ps'
```
Expected: `luna-bot`, `luna-speaches`, `luna-searxng`, `luna-caddy` all healthy within ~2 min.

### Task C2: Functional validation

- [ ] **Step 1: Telegram (throwaway) round-trip** — message `@LunaDryRunBot`; expect a reply. Send `/chatid`; confirm the bot answers.
- [ ] **Step 2: Ollama routing on `qwen3.5:4b`** — `ssh developer@192.168.2.244 'docker compose -f ~/Developer/superprompt/docker-compose.yml logs luna | grep "Ollama routing decision" | tail -3'`; expect `model: qwen3.5:4b`.
- [ ] **Step 3: Web UI over HTTPS** — from a CA-trusted device, open `https://luna.novalink.local`; expect a valid (green) cert. Exercise: a dashboard (`/capacity`), browser voice chat (mic prompt works = TLS good), and `/learn`.
- [ ] **Step 4: Bridge query (requires bridge up on the VM)** — in Telegram ask for a NovaLink inventory/health check that triggers `novalink_health`/`novalink_query`; expect a real response, no TLS error. If the bridge isn't up yet, mark this step blocked and proceed; it is a **go-live blocker** (re-run before the gate).

### Task C3: Memory soak test (the no-deferral gate)

- [ ] **Step 1: Run the soak harness for 30 min under representative load**

```bash
ssh developer@192.168.2.244 'cd ~/Developer/superprompt && ./scripts/soak-memory.sh 30 60 | tee ~/soak-$(date +%H%M).csv'
```
While it runs, drive: several chat turns, one voice round-trip, one heavy calc (`/sim` or `/balance`), a couple of bridge queries.

- [ ] **Step 2: Assess**

Expected: `luna_mem` (container RSS) returns to baseline between bursts (flat, not monotonic); `ollama ps` shows `qwen3.5:4b` evicting after `OLLAMA_KEEP_ALIVE`; host memory pressure stays "normal/warn", never "critical". **Any monotonic climb → STOP, fix per spec §9 (likely Task 4 of the readiness plan), re-run.** Do not proceed to cutover with a known climb.

### Task C4: Reboot resilience test

- [ ] **Step 1: Reboot and confirm unattended recovery**

```bash
ssh developer@192.168.2.244 'sudo reboot'
# wait ~90s
sleep 90
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && colima status && ollama ps && docker compose -f ~/Developer/superprompt/docker-compose.yml ps'
```
Expected: after the Phase E config, Colima + Ollama + the stack all come back without manual intervention. (Run this AFTER Phase E is applied; here it confirms the auto-start chain.)

### Task C5: Backup dry-run + restore

- [ ] **Step 1: Tar `store/` and push to the VM**

```bash
ssh developer@192.168.2.244 'cd ~/Developer/superprompt && tar czf ~/luna-store-test.tgz store && scp ~/luna-store-test.tgz manuel@192.168.2.234:~/luna-backups/'
```
Expected: tarball lands on the VM (`~/luna-backups/`).

- [ ] **Step 2: Verify it restores**

```bash
ssh manuel@192.168.2.234 'mkdir -p /tmp/restore-test && tar xzf ~/luna-backups/luna-store-test.tgz -C /tmp/restore-test && ls /tmp/restore-test/store && sqlite3 /tmp/restore-test/store/luna.db ".tables" | head'
```
Expected: `luna.db` present and queryable. Clean up the test artifacts.

---

## Phase D — CUTOVER (single human go/no-go gate)

> ⚠️ **This is the one irreversible, gated step.** All prior phases are non-destructive. Confirm the gate before proceeding. Zero Telegram overlap is mandatory.

- [ ] **Step 1: GATE — confirm go**

Confirm with the spec owner: dry-run passed, soak flat, bridge reachable, reboot test green. Get explicit "go" (per the standing authorization, the auto-merge applies to CI-gated PRs, NOT to this live cutover — it requires the gate).

- [ ] **Step 2: Quiesce the dev bot + verify offline**

```bash
cd /Users/mcampos.cerda/Developer/Programming/superprompt && docker compose down
docker compose ps   # expect: no luna-bot running
```
Then confirm in Telegram the real bot no longer responds (send a message; expect silence). **Do not proceed until dev is confirmed down.**

- [ ] **Step 3: Migrate the live `store/` (fresh, post-quiesce)**

```bash
rsync -avz /Users/mcampos.cerda/Developer/Programming/superprompt/store/ developer@192.168.2.244:~/Developer/superprompt/store/
```
Expected: `luna.db`, `claude-home/`, schedules, board copied (overwrites the dry-run store with the real, current state).

- [ ] **Step 4: Restore the real Telegram token**

```bash
ssh developer@192.168.2.244 'mv ~/Developer/superprompt/.env.realtoken ~/Developer/superprompt/.env && chmod 600 ~/Developer/superprompt/.env && grep -c "^TELEGRAM_BOT_TOKEN=" ~/Developer/superprompt/.env'
```
Expected: `.env` now has the real token (the throwaway is gone).

- [ ] **Step 5: Start prod with the real token**

```bash
ssh developer@192.168.2.244 'cd ~/Developer/superprompt && eval "$(/opt/homebrew/bin/brew shellenv)" && docker compose --profile production up -d && docker compose ps'
```
Expected: all services healthy.

- [ ] **Step 6: Verify live production**

- Telegram: message the REAL bot → expect a reply (now served by the Mac).
- Bridge: trigger a `novalink_query` → real data, no TLS error.
- Web: open `https://luna.novalink.local` → dashboards + voice + `/learn` work.
- Memory continuity: ask Luna something only the migrated memory would know (e.g. a prior board card) → confirms `store/` carried over.

- [ ] **Step 7: Retire the dev role**

Leave the dev box down (or repurpose with a *different* throwaway token for future dev). Record cutover timestamp in the deployment log.

---

## Phase E — Unattended-server hardening

### Task E1: Disable sleep + confirm FileVault off + auto-login

- [ ] **Step 1: Never sleep**

```bash
ssh developer@192.168.2.244 'sudo pmset -a sleep 0 disksleep 0 displaysleep 0 womp 1 && pmset -g | grep -E "sleep|womp"'
```
Expected: sleep values `0`.

- [ ] **Step 2: Confirm FileVault is OFF**

```bash
ssh developer@192.168.2.244 'fdesetup status'
```
Expected: "FileVault is Off." (locked-datacenter decision). If On, disable it (so auto-login/auto-start work unattended).

- [ ] **Step 3: Confirm auto-login is enabled** (so Colima/Ollama login-services start on boot). Verify via System Settings (Screen Sharing) or `sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`. If unset, enable auto-login for `developer`.

### Task E2: Daily backup via launchd

- [ ] **Step 1: Install a backup script + launchd job**

Create `~/luna-backup.sh` on the prod Mac (tar `store/`, gpg-encrypt, scp to the VM, prune >14 days), and a `~/Library/LaunchAgents/com.novalink.luna-backup.plist` running it daily. Load it:

```bash
ssh developer@192.168.2.244 'launchctl load ~/Library/LaunchAgents/com.novalink.luna-backup.plist && launchctl list | grep luna-backup'
```
Expected: job registered. Trigger once manually and confirm a dated tarball lands on the VM.

- [ ] **Step 2: Reboot test (re-run Phase C4 now that auto-start is configured)** — confirm the full chain recovers unattended.

---

## Phase F — Team rollout & documentation

### Task F1: Team CA + hosts onboarding

- [ ] **Step 1: Export the mkcert root CA**

```bash
ssh developer@192.168.2.244 'eval "$(/opt/homebrew/bin/brew shellenv)" && cp "$(mkcert -CAROOT)/rootCA.pem" ~/luna-rootCA.pem'
scp developer@192.168.2.244:~/luna-rootCA.pem ./luna-rootCA.pem
```

- [ ] **Step 2: Write a bilingual onboarding guide** (`docs/luna-team-access.md`): how to (a) install `luna-rootCA.pem` as a trusted root on macOS/Windows/iOS/Android, and (b) add `192.168.2.244 luna.novalink.local` to the device's hosts (or distribute via MDM). Commit + merge.

### Task F2: Supersede legacy docs + finalize

- [ ] **Step 1: Mark the four legacy guides superseded**

Add a top banner to `docs/deployment-guide.md`, `deployment-runbook.md`, `deployment-checklist.md`, `inmotion-deployment-guide.md`: "SUPERSEDED by `docs/superpowers/specs/2026-06-26-luna-macbook-deployment-design.md` + the cutover runbook." Commit.

- [ ] **Step 2: Update `PROJECT_PLAN.md`** — record the production deployment as done (date, host, topology). Commit + PR, merge on green CI.

- [ ] **Step 3: Final deployment log** — append outcomes (timestamps, soak result, token expiry reminder, open follow-ups: off-site VPN ~Sep 2026, Luna's own bridge key minting) to the deployment log / memory.

---

## Self-Review

- **Spec coverage:** §2 build-out → Phase A; §3 config → Phase B; §4 migration → Phase B1 + Phase D3; §5 cutover → Phase D; §6 ops (FileVault/sleep/auto-login/backup) → Phase E; §7 mkcert + success criteria → A4/B3/C2; §8 bridge trust → B2 + C2.4; §9 soak gate → C3; §10 host.docker.internal → A2.3, hostname → B3. All covered.
- **Placeholder scan:** the Caddyfile-for-mkcert edit (B3) and the launchd plist (E2) are "read current, then minimal change" — concrete approach given, exact bytes depend on reading the current file on the box; acceptable for an operational runbook.
- **Sequencing integrity:** dev stays up through Phase C (throwaway token); the only destructive step is Phase D behind the gate; `store/` is migrated twice intentionally (dry-run copy in B, then the authoritative post-quiesce rsync in D3).

## Execution Handoff

Run this plan **inline** (executing-plans) — operational SSH/cutover state must stay in one session. Phase D is the human gate. Prerequisite: the deploy-readiness plan merged to `main`, and the NovaLink-Bridge up on the VM (separate session) before Phase C2.4 and the Phase D gate.
