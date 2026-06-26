#!/usr/bin/env bash
# Soak-test memory sampler. Usage: scripts/soak-memory.sh [minutes] [interval_s]
# Samples Luna container RSS, Ollama loaded models, and host memory pressure.
set -euo pipefail
MINUTES="${1:-30}"; INTERVAL="${2:-60}"
END=$(( $(date +%s) + MINUTES * 60 ))
echo "ts,luna_mem,ollama_loaded,host_pressure"
while [ "$(date +%s)" -lt "$END" ]; do
  LUNA=$(docker stats --no-stream --format '{{.MemUsage}}' luna-bot 2>/dev/null | awk '{print $1}')
  OLLAMA=$(ollama ps 2>/dev/null | tail -n +2 | awk '{print $1}' | paste -sd'|' -)
  PRESSURE=$(memory_pressure 2>/dev/null | awk -F': ' '/percentage/{print $2; exit}')
  echo "$(date +%H:%M:%S),${LUNA:-NA},${OLLAMA:-none},${PRESSURE:-NA}"
  sleep "$INTERVAL"
done
echo "# Soak complete. Compare first vs last luna_mem: a monotonic climb is a finding (spec §9, no-deferral)."
