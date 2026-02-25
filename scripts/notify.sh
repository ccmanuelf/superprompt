#!/usr/bin/env bash
#
# Send a notification message via Telegram from the command line.
#
# Usage:
#   ./scripts/notify.sh "Your message here"
#
# Requires TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID in .env
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ $# -eq 0 ]; then
  echo "Usage: $0 \"message\""
  exit 1
fi

MESSAGE="$1"

# Read .env
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

# Parse values from .env (simple grep, handles KEY=value and KEY="value")
get_env() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | head -1 | sed "s/^${key}=//" | sed 's/^["'\'']//' | sed 's/["'\'']$//'
}

TOKEN=$(get_env "TELEGRAM_BOT_TOKEN")
CHAT_ID=$(get_env "ALLOWED_CHAT_ID")

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

# Handle comma-separated chat IDs — send to the first one
CHAT_ID=$(echo "$CHAT_ID" | cut -d',' -f1 | tr -d ' ')

# Send via Telegram Bot API
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CHAT_ID}\", \"text\": $(echo "$MESSAGE" | jq -Rs .), \"parse_mode\": \"HTML\"}" \
  > /dev/null

echo "Message sent."
