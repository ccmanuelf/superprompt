#!/usr/bin/env bash
# Luna — Interactive Setup Script
# Usage: ./scripts/setup.sh [--replicate]
#
# Fresh setup:    Prompts for all configuration, generates .env, builds container
# Replicate mode: Imports skills/tools from forge/ directory, prompts for secrets only

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Helpers ─────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

prompt_required() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local value=""
  while [ -z "$value" ]; do
    if [ -n "$default" ]; then
      read -rp "$(echo -e "${CYAN}$prompt${NC} [${default}]: ")" value
      value="${value:-$default}"
    else
      read -rp "$(echo -e "${CYAN}$prompt${NC}: ")" value
    fi
    if [ -z "$value" ]; then
      echo -e "  ${RED}This field is required.${NC}"
    fi
  done
  eval "$var_name=\"$value\""
}

prompt_optional() {
  local var_name="$1" prompt="$2" default="${3:-}"
  local value=""
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${CYAN}$prompt${NC} [${default}]: ")" value
    value="${value:-$default}"
  else
    read -rp "$(echo -e "${CYAN}$prompt${NC} (optional, press Enter to skip): ")" value
  fi
  eval "$var_name=\"$value\""
}

prompt_choice() {
  local var_name="$1" prompt="$2"
  shift 2
  local options=("$@")
  echo -e "${CYAN}$prompt${NC}"
  local i=1
  for opt in "${options[@]}"; do
    echo "  $i) $opt"
    ((i++))
  done
  local choice=""
  while true; do
    read -rp "  Choice [1]: " choice
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
      eval "$var_name=\"${options[$((choice-1))]}\""
      break
    fi
    echo -e "  ${RED}Invalid choice.${NC}"
  done
}

confirm() {
  local prompt="$1"
  read -rp "$(echo -e "${CYAN}$prompt${NC} [y/N]: ")" answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Script Root ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Mode Detection ──────────────────────────────────────────
REPLICATE=false
if [ "${1:-}" = "--replicate" ]; then
  REPLICATE=true
fi

# ── Banner ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║         Luna Setup Wizard             ║${NC}"
if $REPLICATE; then
echo -e "${BOLD}║         Mode: REPLICATE                  ║${NC}"
else
echo -e "${BOLD}║         Mode: FRESH INSTALL              ║${NC}"
fi
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check Prerequisites ────────────────────────────
echo -e "${BOLD}Step 1: Checking prerequisites...${NC}"

# Docker
if command -v docker &>/dev/null; then
  DOCKER_VERSION=$(docker --version 2>/dev/null | head -1)
  success "Docker: $DOCKER_VERSION"
else
  error "Docker is not installed."
  echo "  Install from: https://docs.docker.com/get-docker/"
  exit 1
fi

# Docker Compose
if docker compose version &>/dev/null; then
  success "Docker Compose: available"
else
  error "Docker Compose is not available."
  echo "  Install Docker Desktop or the compose plugin."
  exit 1
fi

# Node.js (for local development, optional)
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version 2>/dev/null)
  success "Node.js: $NODE_VERSION"
else
  warn "Node.js not found (only needed for local development)"
fi

# Ollama
OLLAMA_AVAILABLE=false
if command -v ollama &>/dev/null; then
  success "Ollama: installed"
  OLLAMA_AVAILABLE=true
elif curl -sf http://localhost:11434/api/tags &>/dev/null; then
  success "Ollama: running (detected via API)"
  OLLAMA_AVAILABLE=true
else
  warn "Ollama is not installed or not running."
  echo ""
  if confirm "Would you like to install Ollama now?"; then
    info "Installing Ollama..."
    if [[ "$(uname)" == "Darwin" ]]; then
      # macOS
      if command -v brew &>/dev/null; then
        brew install ollama
      else
        curl -fsSL https://ollama.com/install.sh | sh
      fi
    elif [[ "$(uname)" == "Linux" ]]; then
      curl -fsSL https://ollama.com/install.sh | sh
    else
      error "Unsupported OS for automatic Ollama install. Visit https://ollama.com/download"
      echo "  Continuing without Ollama..."
    fi

    # Verify installation
    if command -v ollama &>/dev/null; then
      success "Ollama installed successfully"
      OLLAMA_AVAILABLE=true

      # Start Ollama if not running
      if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
        info "Starting Ollama..."
        ollama serve &>/dev/null &
        sleep 3
      fi
    else
      warn "Ollama installation may have failed. Continuing..."
    fi
  else
    warn "Skipping Ollama. You can use Claude as AI provider instead."
  fi
fi

echo ""

# ── Step 2: Pull Ollama Models ──────────────────────────────
if $OLLAMA_AVAILABLE; then
  echo -e "${BOLD}Step 2: Ollama models${NC}"

  # Check which models are available
  MODELS_NEEDED=("qwen3.5:latest" "nomic-embed-text")
  MODELS_MISSING=()

  for model in "${MODELS_NEEDED[@]}"; do
    if ollama list 2>/dev/null | grep -q "$model"; then
      success "Model: $model (already pulled)"
    else
      MODELS_MISSING+=("$model")
    fi
  done

  if [ ${#MODELS_MISSING[@]} -gt 0 ]; then
    echo ""
    info "Missing models: ${MODELS_MISSING[*]}"
    if confirm "Pull missing Ollama models now? (this may take a while)"; then
      for model in "${MODELS_MISSING[@]}"; do
        info "Pulling $model..."
        ollama pull "$model" && success "Pulled $model" || warn "Failed to pull $model"
      done
    else
      warn "Skipping model pulls. The entrypoint will attempt to pull nomic-embed-text on container start."
    fi
  fi
  echo ""
fi

# ── Step 3: Configuration ──────────────────────────────────
echo -e "${BOLD}Step 3: Configuration${NC}"

if [ -f .env ]; then
  warn ".env file already exists."
  if ! confirm "Overwrite existing .env?"; then
    info "Keeping existing .env. Skipping configuration."
    SKIP_ENV=true
  else
    SKIP_ENV=false
  fi
else
  SKIP_ENV=false
fi

if [ "$SKIP_ENV" = false ]; then
  echo ""
  echo -e "${BOLD}AI Provider${NC}"
  prompt_choice AI_PROVIDER "Which AI provider should be the default?" "ollama" "claude"
  echo ""

  # Claude token
  CLAUDE_TOKEN=""
  if [ "$AI_PROVIDER" = "claude" ]; then
    echo -e "${BOLD}Claude Configuration${NC}"
    echo "  Generate a token with: claude setup-token"
    prompt_required CLAUDE_TOKEN "Claude OAuth token"
  else
    prompt_optional CLAUDE_TOKEN "Claude OAuth token (for fallback)"
  fi
  echo ""

  # Ollama config
  echo -e "${BOLD}Ollama Configuration${NC}"
  if $OLLAMA_AVAILABLE; then
    OLLAMA_HOST_DEFAULT="http://localhost:11434"
    # For Docker, suggest host.docker.internal
    echo "  Note: Inside Docker, Ollama is reached via host.docker.internal"
    echo "  The .env value is used inside the container."
    prompt_optional OLLAMA_HOST "Ollama host (for Docker)" "http://host.docker.internal:11434"
  else
    prompt_optional OLLAMA_HOST "Ollama host" "http://host.docker.internal:11434"
  fi
  prompt_optional OLLAMA_CHAT_MODEL "Ollama chat model" "qwen3.5:latest"
  prompt_optional OLLAMA_TOOL_MODEL "Ollama tool model" "qwen3.5:latest"
  prompt_optional OLLAMA_EMBED_MODEL "Ollama embed model" "nomic-embed-text"
  echo ""

  # Telegram
  echo -e "${BOLD}Telegram Configuration${NC}"
  echo "  Create a bot with @BotFather on Telegram to get a token."
  prompt_required TELEGRAM_TOKEN "Telegram bot token"
  echo ""
  echo "  To find your chat ID, message @userinfobot on Telegram."
  prompt_required ALLOWED_CHAT_ID "Allowed Telegram chat ID(s) (comma-separated)"
  echo ""

  # Matrix (optional)
  echo -e "${BOLD}Matrix Configuration (optional)${NC}"
  MATRIX_HOMESERVER=""
  MATRIX_ACCESS_TOKEN=""
  MATRIX_ALLOWED_USERS=""
  if confirm "Configure Matrix?"; then
    prompt_optional MATRIX_HOMESERVER "Matrix homeserver URL" "http://localhost:8008"
    prompt_optional MATRIX_ACCESS_TOKEN "Matrix access token"
    prompt_optional MATRIX_ALLOWED_USERS "Allowed Matrix users (comma-separated)"
  fi
  echo ""

  # Voice
  echo -e "${BOLD}Voice Configuration${NC}"
  prompt_optional SPEACHES_URL "Speaches URL" "http://speaches:8000/v1"
  echo ""

  # Tools
  echo -e "${BOLD}Tool Configuration${NC}"
  prompt_optional OLLAMA_ALLOWED_PATHS "Allowed file paths for read-file tool (comma-separated)"
  echo ""

  # Web search
  echo -e "${BOLD}Web Search${NC}"
  prompt_choice SEARCH_TYPE "Web search backend?" "searxng" "brave" "none"
  SEARXNG_URL=""
  BRAVE_API_KEY=""
  if [ "$SEARCH_TYPE" = "searxng" ]; then
    prompt_optional SEARXNG_URL "SearXNG URL" "http://localhost:8888"
  elif [ "$SEARCH_TYPE" = "brave" ]; then
    prompt_optional BRAVE_API_KEY "Brave Search API key"
  fi
  echo ""

  # Log level
  prompt_optional LOG_LEVEL "Log level" "info"
  echo ""

  # ── Generate .env ──────────────────────────────────────────
  info "Generating .env file..."

  cat > .env << ENVEOF
# Luna — Environment Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── AI Provider ──────────────────────────────────────────────
AI_PROVIDER=${AI_PROVIDER}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN:-your-claude-oauth-token-here}

# ── Ollama ───────────────────────────────────────────────────
OLLAMA_HOST=${OLLAMA_HOST:-http://host.docker.internal:11434}
OLLAMA_CHAT_MODEL=${OLLAMA_CHAT_MODEL:-qwen3.5:latest}
OLLAMA_TOOL_MODEL=${OLLAMA_TOOL_MODEL:-qwen3.5:latest}
OLLAMA_EMBED_MODEL=${OLLAMA_EMBED_MODEL:-nomic-embed-text}

# ── Telegram ─────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}
ALLOWED_CHAT_ID=${ALLOWED_CHAT_ID}

# ── Matrix ───────────────────────────────────────────────────
MATRIX_HOMESERVER=${MATRIX_HOMESERVER}
MATRIX_ACCESS_TOKEN=${MATRIX_ACCESS_TOKEN}
MATRIX_ALLOWED_USERS=${MATRIX_ALLOWED_USERS}

# ── Voice (Speaches) ────────────────────────────────────────
SPEACHES_URL=${SPEACHES_URL:-http://speaches:8000/v1}

# ── Ollama Tools ─────────────────────────────────────────────
OLLAMA_ALLOWED_PATHS=${OLLAMA_ALLOWED_PATHS}
SEARXNG_URL=${SEARXNG_URL}
BRAVE_API_KEY=${BRAVE_API_KEY}

# ── Logging ──────────────────────────────────────────────────
LOG_LEVEL=${LOG_LEVEL:-info}
ENVEOF

  success ".env file created"
fi

# ── Step 4: Create Required Directories ────────────────────
echo ""
echo -e "${BOLD}Step 4: Ensuring directory structure...${NC}"
mkdir -p store workspace/uploads forge/skills forge/tools
success "Directories ready"

# ── Step 5: Import Skills & Tools (replicate mode) ─────────
if $REPLICATE; then
  echo ""
  echo -e "${BOLD}Step 5: Importing skills & tools from forge/...${NC}"

  SKILL_COUNT=$(find forge/skills -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  TOOL_COUNT=$(find forge/tools -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

  if [ "$SKILL_COUNT" -gt 0 ] || [ "$TOOL_COUNT" -gt 0 ]; then
    info "Found $SKILL_COUNT skill(s) and $TOOL_COUNT tool(s) in forge/"
    info "These will be auto-imported when the bot starts."
    success "Skills and tools will be loaded from forge/ directory on first boot"
  else
    warn "No .md files found in forge/skills/ or forge/tools/"
    info "You can add skill/tool markdown files there and they'll be imported on bot start."
  fi
else
  echo ""
  echo -e "${BOLD}Step 5: Forge directory${NC}"
  info "Custom skills and tools can be placed in:"
  echo "  forge/skills/*.md — Skill definitions (YAML frontmatter + system prompt)"
  echo "  forge/tools/*.md  — Tool definitions (YAML frontmatter + config)"
  info "These are auto-imported on bot startup and safe to commit to git."
fi

# ── Step 6: Build and Start ────────────────────────────────
echo ""
echo -e "${BOLD}Step 6: Build and start${NC}"

if confirm "Build and start the Luna container now?"; then
  info "Building Luna container..."
  docker compose up -d --build luna 2>&1 | tail -5

  # Wait a moment for startup
  sleep 3

  # Check if running
  if docker compose ps luna 2>/dev/null | grep -q "running\|Up"; then
    success "Luna is running!"
    echo ""
    echo -e "${BOLD}Container logs (last 10 lines):${NC}"
    docker logs luna-bot --tail 10 2>&1 || true
  else
    warn "Container may not have started correctly."
    echo "  Check logs with: docker logs luna-bot"
  fi
else
  info "Skipping build. Run manually with:"
  echo "  docker compose up -d --build luna"
fi

# ── Done ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           Setup Complete!                ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}Quick reference:${NC}"
echo "  Start:   docker compose up -d luna"
echo "  Stop:    docker compose down"
echo "  Rebuild: docker compose up -d --build luna"
echo "  Logs:    docker logs -f luna-bot"
echo ""
echo "  Export skills/tools: Use /skill export or /tool export in Telegram"
echo "  Replicate setup:     ./scripts/setup.sh --replicate"
echo ""
