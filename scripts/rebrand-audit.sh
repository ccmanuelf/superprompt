#!/usr/bin/env bash
#
# Rebrand audit — rc.85
#
# Fails (exit 1) if any reference to the former product brand "clauded" /
# "Clauded" / "CLAUDED" remains in the codebase. The brand is "Inge Luna"
# (Spanish) / "Luna" (English); the internal canonical slug is `luna`.
#
# This script is deliberately strict about the DISTINCTION between the
# product brand (`clauded`, with trailing D) and references to the
# Anthropic Claude API (model IDs, env vars, SDK imports — which MUST
# stay). The pattern is:
#
#   - MATCH:  clauded | Clauded | CLAUDED        (always wrong after rebrand)
#   - IGNORE: claude-sonnet, claude-opus, claude-haiku, claude-cli,
#             CLAUDE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TIMEOUT_MS,
#             @anthropic-ai/claude-code, claude.ts, ClaudeProvider,
#             any `claude` without trailing D
#
# Usage:
#   ./scripts/rebrand-audit.sh         # non-zero exit on any hit
#   ./scripts/rebrand-audit.sh --list  # print file:line:text for hits
#
# Called from tests/rebrand-audit.test.ts as a regression guard — if a
# future contribution reintroduces "clauded" anywhere in tracked files,
# CI fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The pattern is case-sensitive and matches only the three forms; any other
# casing would be flagged by a generic case-insensitive check but we limit
# to the three that actually appeared in the original codebase.
PATTERN='(clauded|Clauded|CLAUDED)'

# Exclude paths that are noise:
#   - node_modules / .git / dist — not our code
#   - store, workspace, uploads, screenshots, repos — runtime data
#   - package-lock.json — auto-generated; the root name field is the only
#     human-authored location and lives in package.json (audited)
#   - scripts/rebrand-audit.sh — this file documents the brand, so it
#     MUST contain the string literally to explain what it's matching
#   - tests/rebrand-audit.test.ts — same
#   - memory/**.md — Claude Code's auto-memory, outside this repo
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=dist
  --exclude-dir=store
  --exclude-dir=workspace
  --exclude-dir=coverage
  --exclude-dir=.vitest
  # Claude Code tooling (permission allowlist captures historical shell
  # commands verbatim — those command strings are not product code).
  --exclude-dir=.claude
  --exclude=rebrand-audit.sh
  --exclude=rebrand-audit.test.ts
  # The migration module and its tests MUST reference the legacy
  # filenames — that's the whole point. They're the single authorized
  # location for "clauded.*" string literals post-rebrand.
  --exclude=rebrand-data-files.ts
  --exclude=rebrand-data-files.test.ts
  # On-demand DB cleanup script: same authorization — it's the tool that
  # rewrites the old brand to the new one, so it must name the old one.
  --exclude=rebrand-db-cleanup.ts
  # Docker entrypoint clears both legacy + new PID files during container
  # startup so an in-place upgrade from the old brand can't trip the
  # PID-lock guard (observed in rc.85 rollout).
  --exclude=entrypoint.sh
  --exclude=package-lock.json
)

MODE="${1:-check}"

if [[ "$MODE" == "--list" ]]; then
  # Show every hit for investigation. Disable pipefail for this branch —
  # grep exits 1 when it finds no matches, which in the clean-repo case
  # would otherwise fall through `set -e`.
  set +e
  grep -rnE "$PATTERN" "${EXCLUDES[@]}" .
  if [[ $? -ne 0 ]]; then
    echo "no matches — rebrand complete"
  fi
  exit 0
fi

# Count hits. grep returns 1 when no matches — that's SUCCESS for us, so
# we explicitly ignore its exit code and only look at the count.
set +e
HITS=$(grep -rlE "$PATTERN" "${EXCLUDES[@]}" . 2>/dev/null | wc -l | tr -d ' ')
set -e

if [[ "$HITS" -gt 0 ]]; then
  echo "❌ Rebrand audit FAILED: $HITS file(s) still contain the old product brand."
  echo ""
  echo "Files:"
  grep -rlE "$PATTERN" "${EXCLUDES[@]}" . 2>/dev/null | sed 's/^/  /'
  echo ""
  echo "Run './scripts/rebrand-audit.sh --list' to see every occurrence."
  exit 1
fi

echo "✅ Rebrand audit clean: no 'clauded' / 'Clauded' / 'CLAUDED' product-brand references found."
exit 0
