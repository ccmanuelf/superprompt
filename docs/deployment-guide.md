# Luna — Deployment Guide

How to deploy Luna on any platform: office workstations, local servers, VPS providers, or dedicated hosting.

---

## Table of Contents

1. [What's the Same Everywhere](#whats-the-same-everywhere)
2. [What Varies Per Deployment](#what-varies-per-deployment)
3. [Workstation Deployment (LAN / E2E Testing)](#workstation-deployment)
4. [Local Server Deployment (On-Premises)](#local-server-deployment)
5. [VPS Deployment (Cloud Linux Server)](#vps-deployment)
6. [InMotion Dedicated Server](#inmotion-dedicated-server)
7. [Oracle Cloud Free Tier](#oracle-cloud-free-tier)
8. [Hardware Requirements](#hardware-requirements)
9. [Multi-Instance Considerations](#multi-instance-considerations)

---

## What's the Same Everywhere

Regardless of where you deploy, the core is identical:

| Component | What It Is | Same Everywhere? |
|-----------|-----------|:---:|
| Docker image | `luna-bot` + `luna-speaches` | Yes |
| `.env` configuration | Tokens, model names, feature flags | Yes (values differ) |
| Ollama | Local AI inference engine | Yes |
| SQLite database | `./store/luna.db` | Yes |
| Domain packs | `./packs/` directory | Yes |

The Docker image, the code, the startup sequence, and the application behavior are identical in every deployment. The only thing that changes is the networking configuration around it.

## What Varies Per Deployment

| Concern | Workstation (LAN) | Server (Production) |
|---------|:-:|:-:|
| Port binding | `127.0.0.1` (localhost only) | `0.0.0.0` (all interfaces) or behind reverse proxy |
| TLS / HTTPS | Not needed (localhost) | Required for web UI over network |
| Reverse proxy | Not needed | Nginx or Caddy recommended |
| DNS | Not needed | Optional (e.g., `luna.yourcompany.com`) |
| `VOICE_WEB_ORIGIN` | Not needed | Required (your domain URL) |
| Persistence | Docker Desktop auto-manages | Volume mounts + backup strategy |
| Ollama location | Same machine | Same machine or dedicated GPU server |
| Auto-start | Manual `docker compose up` | systemd service or Docker restart policy |

---

## Workstation Deployment

**For:** E2E testing, personal use, department evaluation. Regular office computers (Mac or Linux) on a LAN.

This is the simplest deployment — each person runs their own instance on their own machine. No network configuration needed.

### Prerequisites

- macOS (Apple Silicon or Intel) or Linux
- Docker Desktop >= 24.0
- Ollama >= 0.5.0
- 32GB RAM recommended (16GB minimum — Ollama models + Docker + Speaches)

### Setup

Follow the [User Guide — Getting Started](user-guide.md#getting-started) steps 1-8. The default configuration works out of the box for workstation deployment.

### Key Points

- **Ports stay on localhost** — the default `127.0.0.1:3030` binding means only your machine can access the web UI. This is the secure default.
- **Each workstation is independent** — separate Telegram bots, separate databases, separate memories. No shared state.
- **Ollama runs on the host** — not inside Docker. Each workstation needs its own Ollama with models pulled.
- **Web UI is optional** — Telegram works without the web UI. Enable it only if you need the dashboards or voice chat.

### Accessing from Another Machine on the LAN

If you need to access one workstation's Luna from another machine (e.g., for testing the web UI from a phone):

1. Change the port binding in `docker-compose.yml`:
```yaml
ports:
  - "0.0.0.0:3030:3030"  # Was: "127.0.0.1:3030:3030"
```

2. Access via the machine's LAN IP: `http://192.168.1.100:3030/`

3. **Note:** Browser microphone access requires HTTPS on non-localhost. Voice chat won't work over LAN without TLS. Dashboards and docs work fine over HTTP.

---

## Local Server Deployment

**For:** Permanent on-premises deployment on a dedicated server or repurposed workstation.

### Differences from Workstation

| Setting | Workstation | Local Server |
|---------|------------|-------------|
| Port binding | `127.0.0.1` | `0.0.0.0` (behind reverse proxy) |
| TLS | Not needed | Reverse proxy handles HTTPS |
| Auto-start | Manual | Docker restart policy + systemd |
| Backup | Optional | Required (cron job for ./store/) |

### Step 1: Install Docker and Ollama

```bash
# Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull qwen3.5:latest
ollama pull nomic-embed-text
```

### Step 2: Clone and Configure

```bash
git clone https://github.com/your-org/superprompt.git /opt/luna
cd /opt/luna
cp .env.example .env
# Edit .env with your tokens and configuration
```

### Step 3: Set Up Reverse Proxy (Nginx)

Install Nginx:
```bash
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/luna`:
```nginx
server {
    listen 80;
    server_name luna.local;  # Or your server's hostname/IP

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Enable and start:
```bash
sudo ln -s /etc/nginx/sites-available/luna /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Step 4: TLS with Self-Signed Certificate (LAN)

For LAN access where you don't have a public domain:

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/luna.key \
  -out /etc/ssl/certs/luna.crt \
  -subj "/CN=luna.local"
```

Update Nginx config to add HTTPS:
```nginx
server {
    listen 443 ssl;
    server_name luna.local;

    ssl_certificate /etc/ssl/certs/luna.crt;
    ssl_certificate_key /etc/ssl/private/luna.key;

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name luna.local;
    return 301 https://$host$request_uri;
}
```

Update `.env`:
```bash
VOICE_WEB_ORIGIN=https://luna.local
```

### Step 5: Auto-Start with systemd

Create `/etc/systemd/system/luna.service`:
```ini
[Unit]
Description=luna AI Assistant
After=docker.service ollama.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/luna
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable luna
sudo systemctl start luna
```

### Step 6: Backup Strategy

Create `/etc/cron.daily/luna-backup`:
```bash
#!/bin/bash
BACKUP_DIR=/var/backups/luna
mkdir -p "$BACKUP_DIR"
cp /opt/luna/store/luna.db "$BACKUP_DIR/luna-$(date +%Y%m%d).db"
# Keep last 30 days
find "$BACKUP_DIR" -name "*.db" -mtime +30 -delete
```

```bash
sudo chmod +x /etc/cron.daily/luna-backup
```

---

## VPS Deployment

**For:** Cloud deployment on any Linux VPS provider (DigitalOcean, Linode, Hetzner, Vultr, etc.).

### Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 16GB | 32GB |
| Disk | 50GB SSD | 100GB SSD |
| OS | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |
| Architecture | x86_64 | x86_64 (ARM possible but untested) |

### Steps

1. **Provision the VPS** with your provider. Choose a plan that meets the requirements above.

2. **Install Docker and Ollama** (same as Local Server Step 1).

3. **Clone and configure** (same as Local Server Step 2).

4. **Set up TLS with Let's Encrypt** (if you have a public domain):

```bash
sudo apt install -y certbot python3-certbot-nginx

# Get certificate (replace with your domain)
sudo certbot --nginx -d luna.yourdomain.com
```

Update `.env`:
```bash
VOICE_WEB_ORIGIN=https://luna.yourdomain.com
```

5. **Set up Nginx** (same as Local Server Step 3, with your domain name).

6. **Set up auto-start** (same as Local Server Step 5).

7. **Configure firewall**:
```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

8. **Verify**: Open `https://luna.yourdomain.com/docs` — you should see the documentation viewer.

### VPS-Specific Notes

- **Ollama GPU**: Most VPS providers offer GPU instances. If available, Ollama will use the GPU automatically — inference is 5-10x faster.
- **Swap**: If RAM is tight (16GB), add 8GB swap: `sudo fallocate -l 8G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
- **Monitoring**: Use `docker compose logs -f luna` or set up a log aggregator.

---

## InMotion Dedicated Server

**For:** Deployment on an existing InMotion Hosting dedicated server.

### Prerequisites

- InMotion dedicated server with root/SSH access
- Docker support (may need to request from InMotion support)
- Sufficient RAM (16GB+ recommended)

### Key Differences

InMotion dedicated servers typically run CentOS/AlmaLinux rather than Ubuntu. The main differences:

| Step | Ubuntu | CentOS/AlmaLinux |
|------|--------|------------------|
| Package manager | `apt` | `dnf` or `yum` |
| Firewall | `ufw` | `firewalld` |
| Service manager | systemd (same) | systemd (same) |

### Steps

1. **SSH into your server**:
```bash
ssh root@your-inmotion-ip
```

2. **Install Docker**:
```bash
curl -fsSL https://get.docker.com | sh
systemctl enable docker && systemctl start docker
```

3. **Install Ollama**:
```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull qwen3.5:latest
ollama pull nomic-embed-text
```

4. **Clone and configure** — same as other deployments.

5. **Firewall** (if using firewalld):
```bash
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

6. **TLS**: If InMotion provides SSL certificates through cPanel/WHM, use those. Otherwise, use Let's Encrypt (same as VPS deployment).

7. **Reverse proxy**: InMotion servers often have Apache pre-installed. You can either:
   - Use Apache as reverse proxy (add ProxyPass rules)
   - Install Nginx alongside Apache on a different port
   - Disable Apache and use Nginx exclusively

Apache reverse proxy config (`/etc/httpd/conf.d/luna.conf`):
```apache
<VirtualHost *:443>
    ServerName luna.yourdomain.com
    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem

    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3030/
    ProxyPassReverse / http://127.0.0.1:3030/

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) ws://127.0.0.1:3030/$1 [P,L]
</VirtualHost>
```

---

## Oracle Cloud Free Tier

**For:** Free deployment with 4 ARM cores, 24GB RAM, 200GB storage.

### Assessment

| Component | Fits? | Notes |
|-----------|:---:|-------|
| Luna bot | Yes | Node.js works on ARM |
| Ollama | Yes | ARM-native, 24GB fits qwen3.5 |
| Speaches (voice) | Tight | ~1.5GB RAM; leaves ~22GB for Ollama |
| Docker | Yes | Oracle Linux supports Docker |

### Risks

- **Instance reclamation**: Oracle may reclaim idle free-tier instances. Set up a keep-alive cron.
- **ARM architecture**: Docker images must be ARM-compatible. `node:22-slim` supports ARM. Speaches CPU image supports ARM. Chromium may need `--no-sandbox` on ARM.
- **No GPU**: Ollama runs on CPU only — inference is slower but functional.

### Steps

1. Create a free-tier ARM instance (Ampere A1, 4 OCPUs, 24GB RAM).
2. SSH in and follow the VPS deployment steps.
3. Add a keep-alive cron to prevent reclamation:
```bash
# /etc/cron.d/oracle-keepalive
*/5 * * * * root curl -sf http://localhost:3030/api/docs > /dev/null 2>&1
```

---

## Hardware Requirements

### Per Instance

| Component | Minimum | Recommended | Used By |
|-----------|---------|-------------|---------|
| CPU | 4 cores | 8 cores | Ollama inference, TypeScript, Chromium |
| RAM | 16GB | 32GB | Ollama (~8GB), Speaches (~1.5GB), Node (~500MB), Chromium (~500MB) |
| Disk | 20GB | 50GB | Docker images (~4GB), Ollama models (~5GB), database, workspace |
| Network | LAN | LAN or internet | Telegram API, Ollama on host |

### RAM Breakdown

| Process | Approximate Usage |
|---------|------------------|
| Ollama (qwen3.5:latest loaded) | 6-8 GB |
| Ollama (nomic-embed-text loaded) | 0.5 GB |
| Speaches (STT + TTS models) | 1.0-1.5 GB |
| Luna Node.js process | 200-500 MB |
| Chromium (screenshots, if used) | 200-500 MB |
| OS + Docker overhead | 1-2 GB |
| **Total** | **10-13 GB active** |

On a 32GB machine, this leaves ~20GB headroom — comfortable. On 16GB, it's tight but workable if Ollama isn't running large models.

---

## Multi-Instance Considerations

When multiple departments each run their own Luna instance:

### What's Isolated (Per Instance)

- Telegram bot (each department has their own @BotFather bot)
- SQLite database (all memories, skills, tools, board cards)
- Ollama models (each machine's local Ollama)
- Domain packs (each instance has its own packs/)
- Web UI tokens: Per-user tokens (via `/webtoken create`) scope data to individual users within each instance. The shared `VOICE_WEB_TOKEN` env var is still supported as a fallback but does not provide per-user data isolation.
- Conversation history and memories (scoped per chat_id AND per instance)

### What Could Be Shared (Optional)

- **Git repository**: All instances clone the same repo. Department-specific packs are added locally.
- **Ollama server**: Multiple Luna instances could point to a single Ollama server on the network by changing `OLLAMA_HOST`. This saves RAM but creates a single point of failure.
- **Telegram bot**: NOT recommended to share. Each department should have their own bot for clear ownership and `ALLOWED_CHAT_ID` separation.

### Updating All Instances

When the repo is updated (new features, bug fixes):

```bash
cd superprompt
git pull origin main
docker compose up -d --build    # Rebuild with new code
```

Each department pulls the same update. Their `.env`, `store/`, and `packs/` are unaffected (mounted as volumes, not part of the image).

### Naming Convention

For organizations running multiple instances, consider a naming convention:

| Department | Bot Name | Container Prefix | Web Port |
|------------|----------|------------------|----------|
| Engineering | @eng_luna_bot | luna-eng | 3030 |
| Manufacturing | @mfg_luna_bot | luna-mfg | 3030 |
| Finance | @fin_luna_bot | luna-fin | 3030 |
| HR | @hr_luna_bot | luna-hr | 3030 |

Since each runs on a separate machine, port conflicts don't apply. The container names are only for Docker management clarity.
