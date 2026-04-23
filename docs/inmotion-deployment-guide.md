# Luna -- InMotion Dedicated Server Deployment Guide

Complete deployment guide for Luna on an InMotion Hosting dedicated server running AlmaLinux 8. Covers MariaDB and PostgreSQL with equal detail -- the CTO chooses which database at deploy time.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Initial Server Setup](#2-initial-server-setup)
3. [Database Setup](#3-database-setup)
   - [3a. MariaDB Option](#3a-mariadb-option)
   - [3b. PostgreSQL Option](#3b-postgresql-option)
4. [Deploy Shared Services](#4-deploy-shared-services)
5. [Configure First Deployment](#5-configure-first-deployment)
6. [Configure HTTPS (Caddy)](#6-configure-https-caddy)
7. [Enable Telegram Webhook](#7-enable-telegram-webhook)
8. [Add More Deployments](#8-add-more-deployments)
9. [Monitoring and Maintenance](#9-monitoring-and-maintenance)
10. [Troubleshooting](#10-troubleshooting)
11. [Security Checklist](#11-security-checklist)
12. [Resource Allocation](#12-resource-allocation)

---

## 1. Prerequisites

### Server Specifications

| Requirement | Value |
|-------------|-------|
| Provider | InMotion Hosting -- Bare Metal Dedicated |
| OS | AlmaLinux 8 (RHEL 8 compatible) |
| CPU | 16 cores minimum |
| RAM | 64 GB minimum |
| Storage | 250 GB NVMe |
| Network | 1 Gbps uplink, static IPv4 |

### Before You Begin

1. **Root SSH access** to the InMotion server (provided in your welcome email).
2. **Domain name** pointed to the server IP via an A record (e.g., `luna.yourcompany.com`). DNS propagation takes up to 24 hours -- set this first.
3. **Telegram bot tokens** -- one per deployment. Create bots via [@BotFather](https://t.me/BotFather) on Telegram. Each bot must have a unique token.
4. **Claude OAuth token** -- generated on a machine with Claude CLI installed via `claude setup-token`. This is a subscription token (no per-token API cost).
5. **Git repository access** -- clone URL for the Luna repo.

---

## 2. Initial Server Setup

### 2.1 System Update

SSH into the server as root and update all packages:

```bash
ssh root@YOUR_SERVER_IP

dnf update -y
dnf install -y epel-release
dnf install -y git curl wget openssl tar jq htop tmux
```

### 2.2 Create the Luna System User

Never run Luna as root. Create a dedicated system user:

```bash
useradd -r -m -s /bin/bash -d /opt/luna luna
passwd luna  # set a strong password

# Allow luna user to run Docker (added to docker group in section 2.5)
```

### 2.3 Configure firewalld

AlmaLinux 8 uses `firewalld` by default. Lock down to only HTTP, HTTPS, and SSH:

```bash
# Verify firewalld is running
systemctl enable --now firewalld
firewall-cmd --state

# Allow only SSH, HTTP, HTTPS
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https

# Remove any default services you do not need
firewall-cmd --permanent --remove-service=cockpit 2>/dev/null || true
firewall-cmd --permanent --remove-service=dhcpv6-client 2>/dev/null || true

# Block all database ports from external access (MariaDB 3306, PostgreSQL 5432)
# These are never exposed -- Docker internal network only -- but be explicit:
firewall-cmd --permanent --remove-port=3306/tcp 2>/dev/null || true
firewall-cmd --permanent --remove-port=5432/tcp 2>/dev/null || true

# Reload and verify
firewall-cmd --reload
firewall-cmd --list-all
```

Expected output should show only: `ssh`, `http`, `https` in the services list.

### 2.4 Configure SELinux

AlmaLinux 8 ships with SELinux in enforcing mode. Keep it enforcing but allow Docker to function:

```bash
# Verify SELinux status
getenforce   # Should print: Enforcing
sestatus     # Full status

# Install SELinux policy utilities (needed for container volume labels)
dnf install -y policycoreutils-python-utils setools-console

# Allow containers to manage Docker volumes:
setsebool -P container_manage_cgroup on
```

If Docker fails to start volumes later, apply the `:Z` label fix documented in section 11.

### 2.5 Install Docker (Official RHEL/AlmaLinux Repo)

Do NOT use the AlmaLinux `podman-docker` compatibility layer. Install official Docker CE:

```bash
# Remove any existing container runtimes
dnf remove -y docker docker-client docker-client-latest \
  docker-common docker-latest docker-latest-logrotate \
  docker-logrotate docker-engine podman runc 2>/dev/null || true

# Add Docker official repository
dnf install -y yum-utils
yum-config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo

# Install Docker CE, CLI, containerd, and Compose plugin
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Enable and start Docker
systemctl enable --now docker

# Verify installation
docker --version          # Docker version 27.x or later
docker compose version    # Docker Compose version v2.x
```

### 2.6 Add luna User to Docker Group

```bash
usermod -aG docker luna

# Verify (as luna user)
su - Luna -c "docker ps"
```

### 2.7 Configure Docker Daemon

Create `/etc/docker/daemon.json` with production settings:

```bash
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  },
  "live-restore": true
}
EOF

systemctl restart docker
```

---

## 3. Database Setup

Luna supports both MariaDB and PostgreSQL via the `StorageProvider` abstraction. Choose ONE. Both run inside Docker (defined in `docker-compose.production.yml`) and are never exposed outside the internal Docker network.

---

### 3a. MariaDB Option

#### 3a.1 Image and Version

The production compose file uses `mariadb:11` (MariaDB 11.x LTS). No host-level installation needed -- it runs entirely inside Docker.

#### 3a.2 Configuration in `.env.production`

```bash
DB_DRIVER=mariadb
DB_HOST=mariadb
DB_PORT=3306
DB_NAME=luna
DB_USER=luna
DB_PASSWORD=<generate-with-openssl-rand-base64-32>
DB_ROOT_PASSWORD=<generate-a-different-strong-password>
DB_POOL_MIN=2
DB_POOL_MAX=20
```

Generate strong passwords:

```bash
openssl rand -base64 32   # Use for DB_PASSWORD
openssl rand -base64 32   # Use for DB_ROOT_PASSWORD (different!)
```

#### 3a.3 Start MariaDB

```bash
docker compose -f docker-compose.production.yml --profile mariadb up -d mariadb

# Wait for healthy status
docker compose -f docker-compose.production.yml ps mariadb
# Should show: luna-mariadb   ... (healthy)
```

#### 3a.4 Verify Database and User

```bash
# Connect as root to verify
docker exec -it luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}" -e "
  SHOW DATABASES;
  SELECT User, Host FROM mysql.user WHERE User='luna';
"
```

The `luna` database and user are created automatically by the MariaDB image from the `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` environment variables.

#### 3a.5 Create Isolated Databases (for Client Mode)

If you plan to run isolated deployments (section 8), pre-create their databases:

```bash
docker exec -it luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}" -e "
  CREATE DATABASE IF NOT EXISTS luna_deploy_3;
  CREATE DATABASE IF NOT EXISTS luna_deploy_4;
  GRANT ALL PRIVILEGES ON luna_deploy_3.* TO 'luna'@'%';
  GRANT ALL PRIVILEGES ON luna_deploy_4.* TO 'luna'@'%';
  FLUSH PRIVILEGES;
"
```

#### 3a.6 Connection Pooling

Connection pooling is handled application-side by the Luna `StorageProvider`. The `DB_POOL_MIN` and `DB_POOL_MAX` settings in `.env.production` control pool size:

| Setting | Default | Recommended (10 deployments) |
|---------|---------|------------------------------|
| `DB_POOL_MIN` | 2 | 2 |
| `DB_POOL_MAX` | 20 | 30 |

MariaDB's default `max_connections` is 151. For more than 10 deployments, increase it:

```bash
docker exec -it luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}" -e "
  SET GLOBAL max_connections = 300;
"
```

To make this persistent, mount a custom config file. Create `docker/mariadb-custom.cnf`:

```ini
[mysqld]
max_connections = 300
innodb_buffer_pool_size = 2G
innodb_log_file_size = 256M
innodb_flush_log_at_trx_commit = 2
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
```

Add the volume mount to the `mariadb` service in `docker-compose.production.yml`:

```yaml
volumes:
  - mariadb-data:/var/lib/mysql
  - ./docker/mariadb-custom.cnf:/etc/mysql/conf.d/custom.cnf:ro
```

#### 3a.7 Security Hardening

MariaDB is already secured by default in the production compose file:

- **No host port binding** -- accessible only on Docker's internal `luna-net` network.
- **Non-root application user** -- the `luna` user has privileges only on its own database(s).
- **Health checks** -- Docker restarts unhealthy containers automatically.

Additional hardening:

```bash
# Remove the test database (if present)
docker exec -it luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}" -e "
  DROP DATABASE IF EXISTS test;
  DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';
  FLUSH PRIVILEGES;
"
```

#### 3a.8 Backup Strategy

Create `/opt/luna/scripts/backup-mariadb.sh`:

```bash
#!/bin/bash
# MariaDB backup script for luna
# Run via cron: 0 2 * * * /opt/luna/scripts/backup-mariadb.sh

set -euo pipefail

BACKUP_DIR="/opt/luna/backups/mariadb"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d-%H%M%S)
CONTAINER="luna-mariadb"

mkdir -p "${BACKUP_DIR}"

# Dump all databases
docker exec "${CONTAINER}" mariadb-dump \
  -u root \
  -p"$(grep DB_ROOT_PASSWORD /opt/luna/.env.production | cut -d= -f2)" \
  --all-databases \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  | gzip > "${BACKUP_DIR}/luna-mariadb-${DATE}.sql.gz"

# Remove backups older than retention period
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date -Iseconds)] MariaDB backup complete: luna-mariadb-${DATE}.sql.gz"
```

```bash
chmod +x /opt/luna/scripts/backup-mariadb.sh

# Schedule daily at 2:00 AM
crontab -l 2>/dev/null | cat - <(echo "0 2 * * * /opt/luna/scripts/backup-mariadb.sh >> /opt/luna/backups/backup.log 2>&1") | crontab -
```

#### 3a.9 Restore from Backup

```bash
gunzip < /opt/luna/backups/mariadb/luna-mariadb-YYYYMMDD-HHMMSS.sql.gz \
  | docker exec -i luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}"
```

---

### 3b. PostgreSQL Option

#### 3b.1 Image and Version

The production compose file uses `postgres:16-alpine` (PostgreSQL 16.x on Alpine Linux). Lightweight and production-ready.

#### 3b.2 Configuration in `.env.production`

```bash
DB_DRIVER=postgres
DB_HOST=postgres
DB_PORT=5432
DB_NAME=luna
DB_USER=luna
DB_PASSWORD=<generate-with-openssl-rand-base64-32>
DB_POOL_MIN=2
DB_POOL_MAX=20
```

Note: PostgreSQL does not use a separate `DB_ROOT_PASSWORD`. The `POSTGRES_USER` is the superuser. If you want a separate superuser, override `POSTGRES_USER` and create the application user manually (section 3b.5).

Generate a strong password:

```bash
openssl rand -base64 32   # Use for DB_PASSWORD
```

#### 3b.3 Start PostgreSQL

```bash
docker compose -f docker-compose.production.yml --profile postgres up -d postgres

# Wait for healthy status
docker compose -f docker-compose.production.yml ps postgres
# Should show: luna-postgres   ... (healthy)
```

#### 3b.4 Verify Database and User

```bash
docker exec -it luna-postgres psql -U luna -d luna -c "
  SELECT current_database(), current_user, version();
"
```

The `luna` database and user are created automatically by the PostgreSQL image from the `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` environment variables.

#### 3b.5 Install pgvector Extension (for Vector Search)

If you plan to use semantic vector search (memory system embeddings), install pgvector. Replace the image in `docker-compose.production.yml`:

```yaml
postgres:
  image: pgvector/pgvector:pg16
  # ... rest stays the same
```

Then enable the extension:

```bash
docker compose -f docker-compose.production.yml --profile postgres up -d postgres

docker exec -it luna-postgres psql -U luna -d luna -c "
  CREATE EXTENSION IF NOT EXISTS vector;
  SELECT * FROM pg_extension WHERE extname = 'vector';
"
```

If you do not need vector search, the default `postgres:16-alpine` image is sufficient.

#### 3b.6 Create Isolated Databases (for Client Mode)

```bash
docker exec -it luna-postgres psql -U luna -c "
  CREATE DATABASE luna_deploy_3 OWNER luna;
  CREATE DATABASE luna_deploy_4 OWNER luna;
"
```

#### 3b.7 Connection Pooling

Like MariaDB, pooling is handled application-side via `DB_POOL_MIN` / `DB_POOL_MAX`. PostgreSQL's default `max_connections` is 100. For more than 10 deployments, increase it.

Create `docker/postgresql-custom.conf`:

```ini
max_connections = 300
shared_buffers = 2GB
effective_cache_size = 6GB
maintenance_work_mem = 512MB
checkpoint_completion_target = 0.9
wal_buffers = 64MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
work_mem = 16MB
huge_pages = off
min_wal_size = 1GB
max_wal_size = 4GB
```

Add the volume mount to the `postgres` service:

```yaml
volumes:
  - postgres-data:/var/lib/postgresql/data
  - ./docker/postgresql-custom.conf:/etc/postgresql/custom.conf:ro
command: postgres -c config_file=/etc/postgresql/custom.conf
```

Alternatively, for PgBouncer-based connection pooling (external pooler), add a PgBouncer service:

```yaml
pgbouncer:
  image: bitnami/pgbouncer:1
  container_name: luna-pgbouncer
  environment:
    - POSTGRESQL_HOST=postgres
    - POSTGRESQL_PORT=5432
    - POSTGRESQL_USERNAME=luna
    - POSTGRESQL_PASSWORD=${DB_PASSWORD}
    - POSTGRESQL_DATABASE=luna
    - PGBOUNCER_MAX_CLIENT_CONN=300
    - PGBOUNCER_DEFAULT_POOL_SIZE=30
    - PGBOUNCER_POOL_MODE=transaction
  depends_on:
    postgres:
      condition: service_healthy
  networks:
    - luna-net
  restart: unless-stopped
  profiles:
    - postgres
```

When using PgBouncer, set `DB_HOST=pgbouncer` and `DB_PORT=6432` in `.env.production`.

#### 3b.8 Security Hardening

PostgreSQL is already secured in the production compose file:

- **No host port binding** -- internal Docker network only.
- **Single application user** -- `luna` user owns only its database(s).
- **Health checks** via `pg_isready`.

Additional hardening -- restrict connections to the Docker subnet. Create `docker/pg_hba_custom.conf`:

```
# TYPE  DATABASE    USER        ADDRESS         METHOD
local   all         all                         peer
host    all         luna     172.16.0.0/12   scram-sha-256
host    all         all         0.0.0.0/0       reject
```

Mount it:

```yaml
volumes:
  - postgres-data:/var/lib/postgresql/data
  - ./docker/pg_hba_custom.conf:/etc/postgresql/pg_hba.conf:ro
command: postgres -c hba_file=/etc/postgresql/pg_hba.conf
```

#### 3b.9 Backup Strategy

Create `/opt/luna/scripts/backup-postgres.sh`:

```bash
#!/bin/bash
# PostgreSQL backup script for luna
# Run via cron: 0 2 * * * /opt/luna/scripts/backup-postgres.sh

set -euo pipefail

BACKUP_DIR="/opt/luna/backups/postgres"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d-%H%M%S)
CONTAINER="luna-postgres"
DB_USER="luna"

mkdir -p "${BACKUP_DIR}"

# Dump all databases (custom format for pg_restore)
docker exec "${CONTAINER}" pg_dumpall -U "${DB_USER}" \
  | gzip > "${BACKUP_DIR}/luna-postgres-${DATE}.sql.gz"

# Remove backups older than retention period
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date -Iseconds)] PostgreSQL backup complete: luna-postgres-${DATE}.sql.gz"
```

```bash
chmod +x /opt/luna/scripts/backup-postgres.sh

# Schedule daily at 2:00 AM
crontab -l 2>/dev/null | cat - <(echo "0 2 * * * /opt/luna/scripts/backup-postgres.sh >> /opt/luna/backups/backup.log 2>&1") | crontab -
```

#### 3b.10 Restore from Backup

```bash
gunzip < /opt/luna/backups/postgres/luna-postgres-YYYYMMDD-HHMMSS.sql.gz \
  | docker exec -i luna-postgres psql -U luna
```

---

## 4. Deploy Shared Services

### 4.1 Clone the Repository

```bash
su - luna
cd /opt/luna

git clone https://github.com/YOUR_ORG/luna.git .
# Or if private:
git clone git@github.com:YOUR_ORG/luna.git .
```

### 4.2 Configure `.env.production`

```bash
cp .env.production.example .env.production
```

Edit `.env.production` with your chosen database driver and credentials:

**For MariaDB:**

```bash
# .env.production
CADDY_DOMAIN=luna.yourcompany.com

DB_DRIVER=mariadb
DB_HOST=mariadb
DB_PORT=3306
DB_NAME=luna
DB_USER=luna
DB_PASSWORD=<your-generated-password>
DB_ROOT_PASSWORD=<your-generated-root-password>
DB_POOL_MIN=2
DB_POOL_MAX=20

CLAUDE_CODE_OAUTH_TOKEN=<your-claude-oauth-token>
AI_PROVIDER=claude
OLLAMA_HOST=http://ollama:11434
OLLAMA_CHAT_MODEL=qwen3.5:latest
OLLAMA_TOOL_MODEL=qwen3.5:latest
LOG_LEVEL=info
NODE_ENV=production
```

**For PostgreSQL:**

```bash
# .env.production
CADDY_DOMAIN=luna.yourcompany.com

DB_DRIVER=postgres
DB_HOST=postgres
DB_PORT=5432
DB_NAME=luna
DB_USER=luna
DB_PASSWORD=<your-generated-password>
DB_POOL_MIN=2
DB_POOL_MAX=20

CLAUDE_CODE_OAUTH_TOKEN=<your-claude-oauth-token>
AI_PROVIDER=claude
OLLAMA_HOST=http://ollama:11434
OLLAMA_CHAT_MODEL=qwen3.5:latest
OLLAMA_TOOL_MODEL=qwen3.5:latest
LOG_LEVEL=info
NODE_ENV=production
```

### 4.3 Start Shared Services

Start all shared infrastructure. Pick the command matching your database choice:

**MariaDB:**

```bash
docker compose -f docker-compose.production.yml --profile mariadb up -d
```

**PostgreSQL:**

```bash
docker compose -f docker-compose.production.yml --profile postgres up -d
```

This starts: Caddy, your chosen database, Ollama, SearXNG, and Speaches.

### 4.4 Verify Service Health

```bash
# Check all containers are running and healthy
docker compose -f docker-compose.production.yml ps

# Expected output (MariaDB example):
# NAME                STATUS              PORTS
# luna-caddy       Up (healthy)        0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
# luna-mariadb     Up (healthy)
# luna-ollama      Up
# luna-searxng     Up (healthy)
# luna-speaches    Up (healthy)
```

### 4.5 Pull the Ollama Model

Ollama starts with no models. Pull the required model:

```bash
docker exec -it luna-ollama ollama pull qwen3.5:latest

# Verify the model is available
docker exec -it luna-ollama ollama list
```

This downloads approximately 4.7 GB. On a 1 Gbps connection, expect 1-2 minutes.

### 4.6 Verify SearXNG Health

```bash
docker exec -it luna-searxng wget -qO- http://localhost:8080/healthz
# Should print: OK
```

### 4.7 Verify Speaches Health

Speaches takes up to 2 minutes on first start (model download). Wait for healthy status:

```bash
# Watch until healthy
docker compose -f docker-compose.production.yml ps speaches

# Or check directly
docker exec -it luna-speaches python3 -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read().decode())"
```

---

## 5. Configure First Deployment

### 5.1 Create Deployment 1

```bash
cd /opt/luna
./scripts/add-deployment.sh 1 "Production"
```

This creates:
- `.env.deploy-1` -- configuration file
- `store/deploy-1/` -- persistent storage
- `workspace/deploy-1/` -- workspace files
- `forge/deploy-1/` -- user tools and skills

### 5.2 Configure the Deployment

Edit `.env.deploy-1`:

```bash
# .env.deploy-1
DEPLOYMENT_NAME=Production

# Telegram (from @BotFather)
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALLOWED_CHAT_ID=123456789,987654321

# Web UI (internal port, proxied by Caddy)
VOICE_WEB_PORT=3031

# Paths (set by Docker volume mounts)
STORE_DIR=/app/store
WORKSPACE_DIR=/app/workspace
```

Replace `TELEGRAM_BOT_TOKEN` with your actual token from @BotFather. Replace `ALLOWED_CHAT_ID` with the Telegram user IDs authorized to use this bot (find your ID by messaging [@userinfobot](https://t.me/userinfobot)).

### 5.3 Build and Start Deployment 1

```bash
# Build the Luna image (first time takes 3-5 minutes)
docker compose -f docker-compose.production.yml build luna-1

# Start deployment 1
docker compose -f docker-compose.production.yml --profile deploy-1 up -d
```

### 5.4 Verify Bot is Running

```bash
# Check container status
docker compose -f docker-compose.production.yml --profile deploy-1 ps

# Check logs for successful startup
docker logs luna-bot-1 --tail 50

# Look for:
#   "luna started"
#   "Telegram bot connected"
#   "Web server listening on port 3031"
```

### 5.5 Test Telegram Interaction

Open Telegram, find your bot, and send `/ping`. The bot should respond. If it does not respond, check the logs:

```bash
docker logs luna-bot-1 -f
```

### 5.6 Create First Web Token

In Telegram, send the following command to your bot:

```
/webtoken create
```

The bot responds with a token URL. Open it in a browser to access the web UI. This web token is per-user and can be revoked with `/webtoken revoke`.

---

## 6. Configure HTTPS (Caddy)

Caddy is already running from section 4.3. It handles TLS certificate acquisition and renewal automatically via Let's Encrypt.

### 6.1 Set the Domain

Ensure `CADDY_DOMAIN` is set correctly in `.env.production`:

```bash
CADDY_DOMAIN=luna.yourcompany.com
```

### 6.2 Verify DNS Resolution

From the server:

```bash
dig +short luna.yourcompany.com
# Should return your server's public IP
```

### 6.3 Restart Caddy with the Domain

If you changed `CADDY_DOMAIN` after initial startup:

```bash
docker compose -f docker-compose.production.yml up -d caddy
```

### 6.4 Verify Certificate Acquisition

```bash
# Check Caddy logs for certificate events
docker logs luna-caddy --tail 30

# Look for:
#   "certificate obtained successfully"
#   "serving initial certificate"
```

Caddy obtains certificates on first request. Trigger it:

```bash
curl -I https://luna.yourcompany.com/
# Should return HTTP/2 200 with Strict-Transport-Security header
```

If the certificate fails (e.g., DNS not propagated yet), Caddy retries automatically. Check logs for details.

### 6.5 Verify Web UI Access

Open `https://luna.yourcompany.com/` in a browser. You should see the luna web UI login page. Use the web token from section 5.6 to authenticate.

### 6.6 Certificate Renewal

Caddy handles renewal automatically. Certificates are stored in the `caddy-data` Docker volume. No cron job needed. Caddy renews certificates 30 days before expiry.

---

## 7. Enable Telegram Webhook

By default, Luna uses Telegram long-polling (the bot connects outbound to Telegram). For production, webhooks are more reliable and reduce latency.

### 7.1 Prerequisites

- HTTPS must be working (section 6).
- The domain must be publicly reachable on port 443.

### 7.2 Configure Webhook

Edit `.env.deploy-1`:

```bash
# Uncomment and set these lines:
TELEGRAM_WEBHOOK_URL=https://luna.yourcompany.com/webhook/deploy-1
TELEGRAM_WEBHOOK_SECRET=<paste-the-generated-secret-from-env-file>
```

The `TELEGRAM_WEBHOOK_SECRET` was auto-generated by `add-deployment.sh`. If you need to regenerate:

```bash
openssl rand -hex 32
```

### 7.3 Restart Deployment

```bash
docker compose -f docker-compose.production.yml --profile deploy-1 up -d luna-1
```

### 7.4 Verify Webhook is Active

```bash
# Check the Telegram webhook status via the bot API
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | jq .
```

Expected response:

```json
{
  "ok": true,
  "result": {
    "url": "https://luna.yourcompany.com/webhook/deploy-1",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "max_connections": 40,
    "ip_address": "YOUR_SERVER_IP"
  }
}
```

If `url` is empty, the bot failed to register the webhook. Check container logs:

```bash
docker logs luna-bot-1 --tail 50
```

### 7.5 Test Webhook

Send a message to your bot in Telegram. Check Caddy's access log for the incoming POST:

```bash
docker exec luna-caddy cat /data/access.log | tail -5
```

You should see POST requests to `/webhook/deploy-1`.

---

## 8. Add More Deployments

### 8.1 Shared Database Mode (Departments)

Departments within the same organization share data (work orders, cards, memories). Each department gets its own bot but reads/writes the same database.

```bash
cd /opt/luna

# Create deployment 2
./scripts/add-deployment.sh 2 "Engineering"

# Edit .env.deploy-2
# Set TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID for the Engineering bot

# Add deployment 2 to docker-compose.production.yml if it doesn't exist
# (Deployments 1 and 2 are pre-defined in the compose file)

# Start deployment 2
docker compose -f docker-compose.production.yml --profile deploy-2 up -d
```

### 8.2 Isolated Database Mode (Clients)

For client-facing deployments where data must be completely separated:

```bash
# Create deployment 3 in isolated mode
./scripts/add-deployment.sh 3 "Client ACME" --isolated

# This adds DB_NAME=luna_deploy_3 to .env.deploy-3
```

Create the isolated database:

**MariaDB:**

```bash
docker exec -it luna-mariadb mariadb -u root -p"${DB_ROOT_PASSWORD}" -e "
  CREATE DATABASE IF NOT EXISTS luna_deploy_3;
  GRANT ALL PRIVILEGES ON luna_deploy_3.* TO 'luna'@'%';
  FLUSH PRIVILEGES;
"
```

**PostgreSQL:**

```bash
docker exec -it luna-postgres psql -U luna -c "
  CREATE DATABASE luna_deploy_3 OWNER luna;
"
```

### 8.3 Add Deployments 3-10 to Docker Compose

Deployments 1 and 2 are pre-defined in `docker-compose.production.yml`. For deployments 3-10, add a new service block following the same pattern. Copy the `luna-2` service and change:

- Service name: `luna-3`
- `container_name`: `luna-bot-3`
- `env_file`: `.env.deploy-3`
- Volume paths: `./store/deploy-3`, `./workspace/deploy-3`, `./forge/deploy-3`
- Profile: `deploy-3`

Example for deployment 3:

```yaml
luna-3:
  build:
    context: .
    dockerfile: docker/luna.dockerfile
  container_name: luna-bot-3
  env_file:
    - .env.production
    - .env.deploy-3
  environment:
    - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
    - OLLAMA_HOST=http://ollama:11434
    - SPEACHES_URL=http://speaches:8000/v1
    - SEARXNG_URL=http://searxng:8080
  volumes:
    - ./store/deploy-3:/app/store
    - ./workspace/deploy-3:/app/workspace
    - ./packs:/app/packs:ro
    - ./forge/deploy-3:/app/forge
    - ./docs:/app/docs:ro
  depends_on:
    searxng:
      condition: service_healthy
    speaches:
      condition: service_started
  networks:
    - luna-net
  restart: unless-stopped
  deploy:
    resources:
      limits:
        memory: 1G
        cpus: '0.5'
  profiles:
    - deploy-3
```

### 8.4 Per-Deployment Webhook Paths

Each deployment must have a unique webhook path in the Caddyfile. Edit `docker/Caddyfile.production`:

```
handle /webhook/deploy-3/* {
    reverse_proxy luna-bot-3:3033
}
```

And in `.env.deploy-3`:

```bash
TELEGRAM_WEBHOOK_URL=https://luna.yourcompany.com/webhook/deploy-3
VOICE_WEB_PORT=3033
```

Reload Caddy after editing:

```bash
docker exec luna-caddy caddy reload --config /etc/caddy/Caddyfile
```

---

## 9. Monitoring and Maintenance

### 9.1 Docker Container Logs

```bash
# All containers (shared + deployments)
docker compose -f docker-compose.production.yml logs --tail 100

# Specific service
docker logs luna-bot-1 --tail 50
docker logs luna-mariadb --tail 50    # or luna-postgres
docker logs luna-ollama --tail 50
docker logs luna-caddy --tail 50

# Follow logs in real time
docker logs -f luna-bot-1
```

### 9.2 Caddy Access Logs

Caddy writes JSON access logs to `/data/access.log` inside the container:

```bash
docker exec luna-caddy cat /data/access.log | jq '.' | tail -50

# Or copy the log to the host
docker cp luna-caddy:/data/access.log /opt/luna/logs/caddy-access.log
```

### 9.3 Database Backup Verification

Check that backups are running:

```bash
# View cron jobs
crontab -l

# Check backup log
tail -20 /opt/luna/backups/backup.log

# List recent backups
ls -lh /opt/luna/backups/mariadb/   # or /opt/luna/backups/postgres/
```

### 9.4 Ollama Model Updates

Update the AI model periodically:

```bash
docker exec -it luna-ollama ollama pull qwen3.5:latest

# Verify current model
docker exec -it luna-ollama ollama list
```

### 9.5 Update Luna Application

```bash
cd /opt/luna

# Pull latest code
git pull origin main

# Rebuild the Luna image
docker compose -f docker-compose.production.yml build

# Restart all deployments (one at a time to avoid downtime)
docker compose -f docker-compose.production.yml --profile deploy-1 up -d luna-1
docker compose -f docker-compose.production.yml --profile deploy-2 up -d luna-2
# ... repeat for each deployment
```

### 9.6 Certificate Renewal

Caddy handles this automatically. To verify certificate status:

```bash
curl -vI https://luna.yourcompany.com/ 2>&1 | grep -A 5 "Server certificate"
```

### 9.7 Disk Space Monitoring

```bash
# Overall disk usage
df -h /

# Docker disk usage
docker system df

# Per-volume usage
docker system df -v

# Clean unused images and build cache
docker system prune -f
docker builder prune -f
```

Set up a disk space alert. Create `/opt/luna/scripts/check-disk.sh`:

```bash
#!/bin/bash
THRESHOLD=85
USAGE=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$USAGE" -gt "$THRESHOLD" ]; then
  echo "[ALERT] Disk usage at ${USAGE}% on $(hostname) at $(date)" \
    | mail -s "luna: Disk space warning" admin@yourcompany.com
fi
```

```bash
chmod +x /opt/luna/scripts/check-disk.sh
# Run every hour
crontab -l | cat - <(echo "0 * * * * /opt/luna/scripts/check-disk.sh") | crontab -
```

---

## 10. Troubleshooting

### 10.1 Port Conflicts

**Symptom:** Caddy fails to start with "address already in use".

```bash
# Find what is using ports 80/443
ss -tlnp | grep -E ':80|:443'

# Common culprit: httpd (Apache) from InMotion's default install
systemctl stop httpd
systemctl disable httpd

# Restart Caddy
docker compose -f docker-compose.production.yml up -d caddy
```

### 10.2 TLS Certificate Errors

**Symptom:** Caddy logs show "acme: error" or "challenge failed".

```bash
# Check DNS resolution from the server
dig +short luna.yourcompany.com

# Verify ports 80 and 443 are open from outside
# (Use a service like https://www.yougetsignal.com/tools/open-ports/)

# Check firewalld is not blocking
firewall-cmd --list-all

# Caddy needs both port 80 (HTTP challenge) and 443 (TLS-ALPN challenge)
```

### 10.3 Database Connection Errors

**Symptom:** Luna logs show "ECONNREFUSED" or "connection refused" to database.

```bash
# Verify database container is running
docker ps | grep -E "mariadb|postgres"

# Check database health
docker inspect luna-mariadb --format='{{.State.Health.Status}}'   # MariaDB
docker inspect luna-postgres --format='{{.State.Health.Status}}'  # PostgreSQL

# Check database logs
docker logs luna-mariadb --tail 30   # or luna-postgres

# Verify network connectivity from bot container
docker exec luna-bot-1 ping -c 1 mariadb    # or postgres

# Verify credentials
docker exec luna-bot-1 env | grep DB_
```

**Common causes:**
- `DB_HOST` in `.env.production` does not match the Docker service name (`mariadb` or `postgres`).
- `DB_DRIVER` set to `mariadb` but PostgreSQL profile started (or vice versa).
- Database container not yet healthy (still initializing).

### 10.4 Telegram Webhook Failures

**Symptom:** Bot does not respond to messages; webhook info shows errors.

```bash
# Check webhook status
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq .

# Common issues:
# - "last_error_message": "SSL error" → TLS certificate not yet obtained
# - "last_error_message": "Wrong response" → Caddy routing misconfigured
# - "pending_update_count" very high → Bot container is down

# Delete webhook and revert to polling (for debugging)
curl -s "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# Comment out TELEGRAM_WEBHOOK_URL in .env.deploy-1
# Restart the deployment to use polling mode
docker compose -f docker-compose.production.yml --profile deploy-1 up -d luna-1
```

### 10.5 Ollama Model Not Loading

**Symptom:** AI responses fail or timeout.

```bash
# Check Ollama is running
docker logs luna-ollama --tail 20

# Check available models
docker exec -it luna-ollama ollama list

# If model is missing, pull it again
docker exec -it luna-ollama ollama pull qwen3.5:latest

# Check memory usage (Ollama needs ~4-6 GB for qwen3.5)
docker stats luna-ollama --no-stream
```

### 10.6 Speaches Voice Service Down

**Symptom:** Voice messages not transcribed or TTS fails.

```bash
# Speaches takes up to 2 minutes on first start (model download)
docker logs luna-speaches --tail 30

# Check health
docker exec luna-speaches python3 -c "
import urllib.request
print(urllib.request.urlopen('http://localhost:8000/health').read().decode())
"

# Restart if stuck
docker compose -f docker-compose.production.yml restart speaches
```

### 10.7 Container Keeps Restarting

```bash
# Check exit code and restart count
docker inspect luna-bot-1 --format='Exit: {{.State.ExitCode}}, Restarts: {{.RestartCount}}'

# Check OOM (out of memory) kills
docker inspect luna-bot-1 --format='{{.State.OOMKilled}}'
dmesg | grep -i "oom\|killed" | tail -10

# If OOM, increase memory limit in docker-compose.production.yml
```

### 10.8 Log Locations Summary

| Component | Log Location |
|-----------|-------------|
| Bot deployment N | `docker logs luna-bot-N` |
| MariaDB | `docker logs luna-mariadb` |
| PostgreSQL | `docker logs luna-postgres` |
| Ollama | `docker logs luna-ollama` |
| SearXNG | `docker logs luna-searxng` |
| Speaches | `docker logs luna-speaches` |
| Caddy access log | `docker exec luna-caddy cat /data/access.log` |
| Backup log | `/opt/luna/backups/backup.log` |
| System / Docker daemon | `journalctl -u docker.service` |
| SELinux denials | `ausearch -m avc -ts recent` |

---

## 11. Security Checklist

### 11.1 Firewall Rules

```bash
# Verify only required ports are open
firewall-cmd --list-all

# Expected services: ssh, http, https
# NO database ports (3306, 5432) should be listed
# NO Ollama port (11434) should be listed
# NO Speaches port (8000) should be listed
```

### 11.2 SELinux Context for Docker Volumes

If Docker containers cannot write to bind-mounted volumes:

```bash
# Option A: Apply SELinux labels to volume directories
chcon -R -t container_file_t /opt/luna/store/
chcon -R -t container_file_t /opt/luna/workspace/
chcon -R -t container_file_t /opt/luna/forge/

# Option B: Use :Z flag on volume mounts (relabels automatically)
# In docker-compose.production.yml, change:
#   - ./store/deploy-1:/app/store
# To:
#   - ./store/deploy-1:/app/store:Z
```

Option A is preferred for shared volumes (the `:Z` flag is for private volumes only; `:z` is for shared).

### 11.3 Database Passwords

- `DB_PASSWORD` and `DB_ROOT_PASSWORD` (MariaDB only) must be unique, random, and at least 32 characters.
- Never reuse passwords across environments.
- Store passwords only in `.env.production` (gitignored).
- The `.env.production.example` file contains placeholders only.

Verify `.env.production` is not tracked by git:

```bash
git status .env.production
# Should show nothing (file is gitignored)
```

### 11.4 Web Token Rotation

Web tokens are per-user and managed via the `/webtoken` Telegram command:

```
/webtoken create    -- Generate a new token
/webtoken list      -- List active tokens
/webtoken revoke    -- Revoke a specific token
```

Advise users to revoke tokens periodically and always revoke tokens for departed employees immediately.

### 11.5 fail2ban Configuration

Install and configure fail2ban to protect SSH and Caddy:

```bash
dnf install -y fail2ban

cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
filter  = sshd
logpath = /var/log/secure
maxretry = 3

[caddy-auth]
enabled  = true
port     = http,https
filter   = caddy-auth
logpath  = /var/lib/docker/volumes/superprompt_caddy-data/_data/access.log
maxretry = 10
findtime = 300
bantime  = 7200
EOF
```

Create the Caddy filter. Create `/etc/fail2ban/filter.d/caddy-auth.conf`:

```ini
[Definition]
failregex = "client_ip":"<HOST>".*"status":40[13]
ignoreregex =
```

Start fail2ban:

```bash
systemctl enable --now fail2ban
fail2ban-client status
```

### 11.6 SSH Hardening

```bash
# Disable root login and password authentication
cat >> /etc/ssh/sshd_config << 'EOF'

# Luna hardening
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
EOF

systemctl restart sshd
```

Ensure you have SSH key access configured BEFORE disabling password authentication.

### 11.7 Automatic Security Updates

```bash
dnf install -y dnf-automatic

# Configure automatic security updates only
sed -i 's/^upgrade_type = default/upgrade_type = security/' /etc/dnf/automatic.conf
sed -i 's/^apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf

systemctl enable --now dnf-automatic-install.timer
```

---

## 12. Resource Allocation

### 12.1 Shared Services Breakdown

| Service | Memory Limit | CPU Limit | Typical Usage | Notes |
|---------|-------------|-----------|---------------|-------|
| Ollama | 8 GB | 4 cores | 4-6 GB active | Model loaded in RAM; spikes during inference |
| MariaDB / PostgreSQL | 4 GB | 2 cores | 1-2 GB idle | Scales with query load and buffer pool |
| Speaches | 2 GB | 2 cores | 1-1.5 GB active | Kokoro-82M TTS + Faster-whisper STT |
| SearXNG | 512 MB | 0.5 cores | 200-300 MB | Web search aggregator, mostly idle |
| Caddy | 128 MB | 0.5 cores | 30-50 MB | Reverse proxy, very lightweight |
| **Shared Total** | **14.6 GB** | **9 cores** | **~8 GB typical** | |

### 12.2 Per-Deployment Allocation

| Service | Memory Limit | CPU Limit | Typical Usage |
|---------|-------------|-----------|---------------|
| luna-bot-N | 1 GB | 0.5 cores | 300-500 MB |

### 12.3 Total for N Deployments

| Deployments | Shared (GB) | Bots (GB) | Total RAM | Remaining (of 64 GB) |
|:-----------:|:-----------:|:---------:|:---------:|:---------------------:|
| 1 | ~8 | 1 | 9 | 55 |
| 5 | ~8 | 5 | 13 | 51 |
| 10 | ~8 | 10 | 18 | 46 |
| 20 | ~9 | 20 | 29 | 35 |
| 30 | ~10 | 30 | 40 | 24 |

### 12.4 Scaling Beyond 10 Deployments

For more than 10 deployments:

1. **Increase database pool size**: Set `DB_POOL_MAX=30` or higher. Increase MariaDB `max_connections` or PostgreSQL `max_connections` (section 3a.6 / 3b.7).

2. **Increase Ollama memory**: If all bots make concurrent AI requests, Ollama may need more RAM. Edit the memory limit:

   ```yaml
   ollama:
     deploy:
       resources:
         limits:
           memory: 12G
   ```

3. **Monitor and tune**: Use `docker stats` to observe actual usage:

   ```bash
   docker stats --no-stream
   ```

4. **Add deployments 3-10 to compose file**: Follow the template in section 8.3.

5. **Disk space**: Each deployment adds roughly 100-500 MB of persistent data (store + workspace). With 250 GB NVMe, disk is not a bottleneck for up to 30+ deployments.

### 12.5 CPU Allocation Summary

| Component | CPU Limit |
|-----------|-----------|
| Shared services | 9 cores |
| 10 bot deployments | 5 cores |
| OS / overhead | 2 cores |
| **Total** | **16 cores** |

This fits exactly on the 16-core InMotion server with 10 deployments. For more than 10, the CPU limits are soft -- Docker allows bursting when cores are idle. Monitor with `docker stats` and adjust if contention occurs.

---

## Quick Reference: Command Cheat Sheet

```bash
# ── Start/Stop ──
docker compose -f docker-compose.production.yml --profile mariadb up -d        # Shared (MariaDB)
docker compose -f docker-compose.production.yml --profile postgres up -d       # Shared (PostgreSQL)
docker compose -f docker-compose.production.yml --profile deploy-1 up -d       # Bot 1
docker compose -f docker-compose.production.yml --profile deploy-1 down        # Stop bot 1

# ── Logs ──
docker logs luna-bot-1 -f                                                   # Follow bot 1 logs
docker compose -f docker-compose.production.yml logs --tail 100                # All services

# ── Health ──
docker compose -f docker-compose.production.yml ps                             # All container statuses
docker stats --no-stream                                                       # Resource usage

# ── Database ──
docker exec -it luna-mariadb mariadb -u luna -p                          # MariaDB shell
docker exec -it luna-postgres psql -U luna -d luna                    # PostgreSQL shell

# ── Ollama ──
docker exec -it luna-ollama ollama list                                     # List models
docker exec -it luna-ollama ollama pull qwen3.5:latest                      # Update model

# ── Caddy ──
docker exec luna-caddy caddy reload --config /etc/caddy/Caddyfile           # Reload config
docker exec luna-caddy cat /data/access.log | tail -20                      # Access log

# ── Backup (manual) ──
/opt/luna/scripts/backup-mariadb.sh                                         # MariaDB backup
/opt/luna/scripts/backup-postgres.sh                                        # PostgreSQL backup

# ── Add deployment ──
./scripts/add-deployment.sh 3 "Team Name"                                      # Shared DB
./scripts/add-deployment.sh 4 "Client Name" --isolated                         # Isolated DB
```
