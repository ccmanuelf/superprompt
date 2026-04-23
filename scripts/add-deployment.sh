#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Luna — Add New Deployment
# ═══════════════════════════════════════════════════════════════
#
# Creates the directory structure and env file for a new deployment.
#
# Usage:
#   ./scripts/add-deployment.sh 3 "Engineering Team"
#   ./scripts/add-deployment.sh 4 "Client ACME" --isolated

set -euo pipefail

DEPLOY_NUM="${1:?Usage: $0 <number> <name> [--isolated]}"
DEPLOY_NAME="${2:?Usage: $0 <number> <name> [--isolated]}"
ISOLATED="${3:-}"

ENV_FILE=".env.deploy-${DEPLOY_NUM}"
WEB_PORT=$((3030 + DEPLOY_NUM))

if [ -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE already exists. Remove it first to recreate."
  exit 1
fi

# Create directories
echo "Creating deployment ${DEPLOY_NUM}: ${DEPLOY_NAME}"
mkdir -p "store/deploy-${DEPLOY_NUM}"
mkdir -p "workspace/deploy-${DEPLOY_NUM}"
mkdir -p "forge/deploy-${DEPLOY_NUM}"

# Generate secrets
WEBHOOK_SECRET=$(openssl rand -hex 32)

# Create env file
cat > "$ENV_FILE" << EOF
# Luna Deployment ${DEPLOY_NUM}: ${DEPLOY_NAME}
# Created: $(date -Iseconds)

DEPLOYMENT_NAME=${DEPLOY_NAME}

# Telegram (get token from @BotFather)
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN
ALLOWED_CHAT_ID=REPLACE_WITH_CHAT_IDS

# Webhook (production)
# TELEGRAM_WEBHOOK_URL=https://\${CADDY_DOMAIN}/webhook/deploy-${DEPLOY_NUM}
# TELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Web UI
VOICE_WEB_PORT=${WEB_PORT}

# Paths
STORE_DIR=/app/store
WORKSPACE_DIR=/app/workspace
EOF

# Isolated mode
if [ "$ISOLATED" = "--isolated" ]; then
  echo "" >> "$ENV_FILE"
  echo "# Isolated database (client data separation)" >> "$ENV_FILE"
  echo "DB_NAME=luna_deploy_${DEPLOY_NUM}" >> "$ENV_FILE"
  echo ""
  echo "  Mode: ISOLATED database (luna_deploy_${DEPLOY_NUM})"
else
  echo ""
  echo "  Mode: SHARED database (uses .env.production DB_NAME)"
fi

echo ""
echo "Deployment ${DEPLOY_NUM} created:"
echo "  Config: ${ENV_FILE}"
echo "  Store:  store/deploy-${DEPLOY_NUM}/"
echo "  Forge:  forge/deploy-${DEPLOY_NUM}/"
echo "  Port:   ${WEB_PORT}"
echo ""
echo "Next steps:"
echo "  1. Edit ${ENV_FILE} — set TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID"
echo "  2. Start: docker compose -f docker-compose.production.yml --profile deploy-${DEPLOY_NUM} up -d"
echo ""
