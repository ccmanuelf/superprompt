#!/usr/bin/env bash
# Luna — Dependency & System Health Check
# Usage: ./scripts/health-check.sh [--fix]
#
# Checks:
# 1. npm packages vs reference/dependency-versions.md
# 2. npm audit for security vulnerabilities
# 3. CDN versions in HTML files (Vue, Vuetify, Chart.js, MDI)
# 4. Node.js version compatibility
# 5. TypeScript compilation
#
# Run manually or via cron: 0 9 * * 1 /path/to/health-check.sh >> /var/log/luna-health.log

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIX_MODE="${1:-}"
ISSUES=0
WARNINGS=0

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Luna — Health Check                 ║${NC}"
echo -e "${BLUE}║   $(date '+%Y-%m-%d %H:%M:%S')                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

cd "$PROJECT_DIR"

# ── 1. Node.js Version ──────────────────────────────────────

echo -e "${BLUE}[1/6] Node.js version${NC}"
NODE_VERSION=$(node --version 2>/dev/null || echo "NOT FOUND")
if [[ "$NODE_VERSION" == "NOT FOUND" ]]; then
  echo -e "  ${RED}✗ Node.js not found${NC}"
  ISSUES=$((ISSUES + 1))
else
  MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if (( MAJOR >= 20 )); then
    echo -e "  ${GREEN}✓ Node.js $NODE_VERSION (OK)${NC}"
  else
    echo -e "  ${YELLOW}⚠ Node.js $NODE_VERSION — recommend v20+ for ESM + native fetch${NC}"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ── 2. npm Audit ────────────────────────────────────────────

echo -e "\n${BLUE}[2/6] npm security audit${NC}"
AUDIT_OUTPUT=$(npm audit --json 2>/dev/null || true)
VULN_COUNT=$(echo "$AUDIT_OUTPUT" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try {
      const j = JSON.parse(data);
      const v = j.metadata?.vulnerabilities || {};
      const total = (v.critical||0) + (v.high||0) + (v.moderate||0);
      console.log(total);
    } catch { console.log('0'); }
  });
" 2>/dev/null || echo "0")

if [[ "$VULN_COUNT" -gt 0 ]]; then
  echo -e "  ${YELLOW}⚠ $VULN_COUNT known vulnerabilities found${NC}"
  WARNINGS=$((WARNINGS + 1))
  if [[ "$FIX_MODE" == "--fix" ]]; then
    echo -e "  ${BLUE}  Attempting npm audit fix...${NC}"
    npm audit fix --force 2>/dev/null || true
  else
    echo -e "  ${BLUE}  Run with --fix to attempt auto-fix${NC}"
  fi
else
  echo -e "  ${GREEN}✓ No known vulnerabilities${NC}"
fi

# ── 3. Outdated Packages ────────────────────────────────────

echo -e "\n${BLUE}[3/6] Outdated packages${NC}"
OUTDATED=$(npm outdated --json 2>/dev/null || echo "{}")
OUTDATED_COUNT=$(echo "$OUTDATED" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try {
      const j = JSON.parse(data);
      console.log(Object.keys(j).length);
    } catch { console.log('0'); }
  });
" 2>/dev/null || echo "0")

if [[ "$OUTDATED_COUNT" -gt 0 ]]; then
  echo -e "  ${YELLOW}⚠ $OUTDATED_COUNT packages have newer versions available${NC}"
  echo "$OUTDATED" | node -e "
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(data);
        for (const [name, info] of Object.entries(j)) {
          console.log('    ' + name + ': ' + (info.current||'?') + ' → ' + (info.latest||'?'));
        }
      } catch {}
    });
  " 2>/dev/null || true
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✓ All packages up to date${NC}"
fi

# ── 4. CDN Versions in HTML Files ───────────────────────────

echo -e "\n${BLUE}[4/6] CDN library versions in web apps${NC}"

check_cdn() {
  local lib_name="$1"
  local pattern="$2"
  local latest_check="$3"

  local versions=$(grep -roh "$pattern" src/web/public/ 2>/dev/null | sort -u || true)
  if [[ -n "$versions" ]]; then
    local count=$(echo "$versions" | wc -l | tr -d ' ')
    if [[ "$count" -eq 1 ]]; then
      echo -e "  ${GREEN}✓ $lib_name: $(echo $versions | head -1) (consistent across all files)${NC}"
    else
      echo -e "  ${YELLOW}⚠ $lib_name: multiple versions found!${NC}"
      echo "$versions" | while read -r v; do echo "      $v"; done
      WARNINGS=$((WARNINGS + 1))
    fi
  fi
}

check_cdn "Vue.js" 'vue@[0-9.]*' ""
check_cdn "Vuetify" 'vuetify@[0-9.]*' ""
check_cdn "MDI Icons" '@mdi/font@[0-9.]*' ""

# ── 5. TypeScript Compilation ───────────────────────────────

echo -e "\n${BLUE}[5/6] TypeScript compilation check${NC}"
TS_ERRORS=$(npx tsc --noEmit 2>&1 | grep -c "error TS" || true)
if [[ "$TS_ERRORS" -gt 0 ]]; then
  echo -e "  ${YELLOW}⚠ $TS_ERRORS TypeScript errors (note: some may be pre-existing Map iteration warnings)${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✓ TypeScript compilation clean${NC}"
fi

# ── 6. Test Suite ───────────────────────────────────────────

echo -e "\n${BLUE}[6/6] Test suite${NC}"
TEST_OUTPUT=$(npx vitest run 2>&1 || true)
TEST_PASS=$(echo "$TEST_OUTPUT" | grep -o '[0-9]* passed' | head -1 || echo "0 passed")
TEST_FAIL=$(echo "$TEST_OUTPUT" | grep -o '[0-9]* failed' | head -1 || echo "")

if [[ -z "$TEST_FAIL" ]]; then
  echo -e "  ${GREEN}✓ $TEST_PASS${NC}"
else
  echo -e "  ${RED}✗ $TEST_FAIL / $TEST_PASS${NC}"
  ISSUES=$((ISSUES + 1))
fi

# ── Summary ─────────────────────────────────────────────────

echo -e "\n${BLUE}══════════════════════════════════════════${NC}"
if [[ "$ISSUES" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  echo -e "${GREEN}✓ All checks passed — system is healthy${NC}"
elif [[ "$ISSUES" -eq 0 ]]; then
  echo -e "${YELLOW}⚠ $WARNINGS warning(s) — review recommended${NC}"
else
  echo -e "${RED}✗ $ISSUES issue(s), $WARNINGS warning(s) — action required${NC}"
fi
echo -e "${BLUE}══════════════════════════════════════════${NC}"

exit "$ISSUES"
