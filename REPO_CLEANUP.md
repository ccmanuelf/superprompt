# clauded — Repository Cleanup Audit

**Version:** v1.0.0-rc.61
**Date:** April 11, 2026
**Auditor:** Claude (AI-assisted)
**Method:** Static import analysis, git history, dynamic import scan, directory audit

---

## Audit Results

### Category A: CONFIRMED DEAD CODE — Safe to Remove

| File | Lines | Reason | Validated by | Action |
|------|-------|--------|-------------|--------|
| `src/db.ts` | 1,117 | Replaced by `db-core.ts` + `db-knex.ts`. Zero production imports. One test (`exporter.test.ts`) has type-only import that must be switched to `db-core.js` first. | Import scan: 0 static, 0 dynamic importers in production code | **REMOVE** (Phase B) |
| `REBUILD_PROMPT.md` | 906 | Historical mega-prompt. CLAUDE.md explicitly states "kept as historical reference, not used." Never referenced in code or docs. | CLAUDE.md declaration | **REMOVE** |
| `CLAUDED.md` | ~50 | Superseded by `src/capabilities.ts` (CAPABILITIES_PROMPT). Not imported or referenced. Appears to be an early system prompt draft. | No imports, no references | **REMOVE** |
| `reference/competitive-positioning.md` | — | Superseded by `docs/competitive-assessment.md` (rc.48). Zero references. | grep: 0 references | **REMOVE** |
| `reference/cto-architecture-response.md` | — | Historical CTO review response. Content absorbed into architecture docs. Zero references. | grep: 0 references | **REMOVE** |
| `reference/cto-evaluation-hermes-holyclaude.md` | — | Historical evaluation. Content absorbed into competitive assessment. Zero references. | grep: 0 references | **REMOVE** |
| `reference/deployment-decision-matrix.md` | — | Superseded by `docs/inmotion-deployment-guide.md`. Zero references. | grep: 0 references | **REMOVE** |
| `reference/full-release-evaluation.md` | — | Historical rc.29 evaluation. Outdated (rc.61 now). Zero references. | grep: 0 references | **REMOVE** |
| `reference/validation-report-rc29.md` | — | Historical validation at rc.29. Superseded by rc.60 E2E checklist. Zero references. | grep: 0 references | **REMOVE** |

### Category B: REQUIRES MIGRATION BEFORE REMOVAL

| File | Issue | Action needed | Then |
|------|-------|--------------|------|
| `src/schedule-cli.ts` | Still imports from `src/db.js`. Standalone CLI tool. | Migrate to `db-core.js` imports | Can keep (dev tool) or remove if unused |
| `tests/exporter.test.ts` | Type-only import from `src/db.js` | Change to `db-core.js` | No further action |

### Category C: KEEP — Validated as Active

| File/Directory | Status | Why keep |
|---------------|--------|----------|
| `prompts/00-README.md` | Active | Referenced in CLAUDE.md as prompt directory index |
| `reference/decisions.md` | Active | 15 references across code and docs |
| `reference/dependency-versions.md` | Active | Referenced in CLAUDE.md |
| `reference/matrix-setup.md` | Active | 3 references |
| `reference/ollama-tools.md` | Active | Referenced in CLAUDE.md |
| `reference/voice-local.md` | Active | Referenced in CLAUDE.md |
| `reference/saas-trajectory.md` | Active | 1 reference |
| `PROJECT_PLAN.md` | Active | Master plan with phase checkboxes, referenced in CLAUDE.md |
| `CLAUDE.md` | Active | Project instructions for Claude Code |
| `banner.txt` | Active | Displayed at startup (src/index.ts reads it) |
| All `src/*.ts` files | Active | All have importers (static or dynamic) |
| All `tests/*.ts` files | Active | All are test files with passing assertions |
| All `docs/*.md` files | Active | All current with rc.61 |
| All `docker/*` files | Active | Docker configuration |
| All `scripts/*` files | Active | Build and deployment tools |
| All `packs/*` files | Active | Domain packs |

### Category D: DEPENDENCIES — Package.json Audit

| Dependency | Used | Evidence |
|-----------|------|---------|
| `better-sqlite3` | Yes | Used by Knex as SQLite driver, also in db.ts (to be removed) |
| `sqlite-vec` | Yes | Loaded in db-knex.ts afterCreate hook |
| `undici` | Yes | 1 file references it |
| `knex` | Yes | Core database layer (53 files) |
| `mysql2` | Yes | MariaDB driver (loaded by Knex when DB_DRIVER=mariadb) |
| `pg` | Yes | PostgreSQL driver (loaded by Knex when DB_DRIVER=postgres) |
| All others | Yes | Verified via import scan |

---

## Cleanup Plan

### Phase A: Pre-removal Migration (rc.62)

1. Migrate `tests/exporter.test.ts` type import from `db.js` → `db-core.js`
2. Migrate `src/schedule-cli.ts` from `db.js` → `db-core.js`
3. Verify: zero remaining imports of `src/db.ts`
4. Run full test suite
5. Commit as rc.62

### Phase B: Remove Dead Code (rc.63)

1. Remove `src/db.ts` (1,117 lines)
2. Remove `REBUILD_PROMPT.md` (906 lines)
3. Remove `CLAUDED.md` (~50 lines)
4. Remove 6 obsolete reference files
5. Update CLAUDE.md (remove db.ts and REBUILD_PROMPT.md references)
6. Run full test suite
7. Commit as rc.63

### Phase C: Post-cleanup Validation (rc.63)

1. Typecheck: 0 errors
2. Full test suite: 2003+ tests pass
3. 3 randomized seeds
4. Docker deploy: healthy
5. Document in this file

---

## What is NOT being removed (and why)

| Item | Reason to keep |
|------|---------------|
| `PROJECT_PLAN.md` | Master plan, referenced in CLAUDE.md, has historical value |
| `prompts/` directory | Only has README, referenced in CLAUDE.md |
| `reference/decisions.md` | Active — 15 references, core architecture decisions |
| `reference/dependency-versions.md` | Active — pinned versions |
| `banner.txt` | Displayed at every startup |
| `better-sqlite3` dep | Still used as Knex SQLite driver |

---

*Audit completed: April 11, 2026*
