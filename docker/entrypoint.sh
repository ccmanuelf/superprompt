#!/bin/sh
# Entrypoint for clauded Docker container.
# Ensures Claude CLI has the required onboarding flag and config.

CLAUDE_JSON=/home/clauded/.claude.json
CLAUDE_DIR=/home/clauded/.claude

# Ensure .claude directory exists
mkdir -p "$CLAUDE_DIR"

# Ensure hasCompletedOnboarding is set (required for headless Claude CLI)
if [ ! -f "$CLAUDE_JSON" ] || ! grep -q "hasCompletedOnboarding" "$CLAUDE_JSON" 2>/dev/null; then
  echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
  echo "[entrypoint] Created $CLAUDE_JSON with onboarding flag"
fi

# Clean up stale PID file from previous container runs
rm -f /app/store/clauded.pid

# Pre-load Speaches models (non-blocking — runs in background)
SPEACHES_URL="${SPEACHES_URL:-http://speaches:8000/v1}"
(
  # Wait for Speaches to become available (up to 120s)
  for i in $(seq 1 24); do
    if curl -sf "${SPEACHES_URL%/v1}/health" > /dev/null 2>&1; then
      echo "[entrypoint] Speaches is ready, loading models..."
      curl -sf -X POST "${SPEACHES_URL}/models/Systran/faster-whisper-small" > /dev/null 2>&1 \
        && echo "[entrypoint] STT model (faster-whisper-small) loaded" \
        || echo "[entrypoint] STT model already loaded or load failed"
      curl -sf -X POST "${SPEACHES_URL}/models/speaches-ai/Kokoro-82M-v1.0-ONNX" > /dev/null 2>&1 \
        && echo "[entrypoint] TTS model (Kokoro-82M) loaded" \
        || echo "[entrypoint] TTS model already loaded or load failed"
      exit 0
    fi
    sleep 5
  done
  echo "[entrypoint] Speaches not available after 120s, skipping model preload"
) &

exec node dist/index.js
