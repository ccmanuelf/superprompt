# Luna — Build Prompt System

## Current Status (2026-04-27)

**This directory is historical scaffolding, not an active build system.** The
per-phase prompt files (`01-foundation.md` … `12-integration.md`) referenced
below were the planned modular structure, but they were **never authored as
standalone files** — the original mega-prompt (`REBUILD_PROMPT.md`) was used
directly to bootstrap the project, and subsequent work happened as normal
incremental commits in `src/`, not via prompt-driven phase replays.

The directory is preserved because it documents the original modular plan and
the dependency graph between subsystems, which is still useful as reference
when reading `src/` for the first time. **Do not expect to find the phase
prompts on disk** — the rest of this README describes the plan as it was
intended, not the workflow as it exists today.

For the current source of truth on what is built and what remains, see
`/PROJECT_PLAN.md` and `/ROADMAP.md` at the repo root.

---

## What This Is

This directory contains modular build prompts for constructing **Luna** (Inge Luna in Spanish), a personal AI assistant daemon. Each prompt is a self-contained specification that, when pasted into a Claude Code session in the target project directory, creates all files for that phase.

## How To Use

### Prerequisites
1. Read `PROJECT_PLAN.md` at the repo root to understand the full plan
2. Check the completion status checkboxes to know which phases are done
3. Read `reference/decisions.md` so you don't re-discuss settled decisions

### Executing a Phase

1. Open a fresh Claude Code session in the **target project directory** (not this repo)
2. Paste the contents of the relevant `XX-*.md` prompt file
3. Claude Code will create all files specified in the prompt
4. Run the verification steps listed at the bottom of the prompt
5. If verification passes, commit with the format: `feat(phase-N): description`
6. Update the checkbox in `PROJECT_PLAN.md`

### Ordering

Phases MUST be executed in order. Each phase lists its prerequisites:

```
Phase 0:  Project Setup (this repo — already done)
Phase 1:  Foundation (no prerequisites)
Phase 2:  AI Providers (requires Phase 1)
Phase 3:  Memory (requires Phase 1)
Phase 4:  Voice (requires Phase 1)
Phase 5:  Telegram (requires Phases 1, 2, 3)
Phase 6:  Matrix (requires Phases 1, 2, 3)
Phase 7:  Scheduler (requires Phases 1, 2)
Phase 8:  Media (requires Phase 1)
Phase 9:  Docker (requires Phases 1-8)
Phase 10: Service (requires Phases 1-9)
Phase 11: Tests (requires Phases 1-8)
Phase 12: Integration (requires Phases 1-11)
```

Phases 3, 4, and 8 can run in parallel after Phase 1 (they don't depend on each other).
Phases 5 and 6 can run in parallel after Phases 1-3.
Phase 7 can run in parallel with Phases 5 and 6.

### Dependency Graph

```
Phase 1 (Foundation)
  ├── Phase 2 (AI Providers)
  │     ├── Phase 5 (Telegram) ← also needs Phase 3
  │     ├── Phase 6 (Matrix)   ← also needs Phase 3
  │     └── Phase 7 (Scheduler)
  ├── Phase 3 (Memory)
  ├── Phase 4 (Voice)
  └── Phase 8 (Media)

Phase 9 (Docker)       ← needs Phases 1-8
Phase 10 (Service)     ← needs Phases 1-9
Phase 11 (Tests)       ← needs Phases 1-8
Phase 12 (Integration) ← needs Phases 1-11
```

## Prompt Design Principles

Each prompt is **deterministic** — no interactive questions. It builds the full feature set for its phase.

Each prompt contains:
1. **Header**: Phase name, goal, prerequisites
2. **File specs**: Exact files to create with detailed implementation notes
3. **Interfaces**: TypeScript types and function signatures
4. **Known gotchas**: Phase-specific pitfalls to avoid
5. **Verification**: Commands to run to confirm the phase works

## If a Session Ends Mid-Phase

1. Check `git status` to see what files were created
2. Read the prompt file for the incomplete phase
3. Resume from where it left off — the prompt has the full spec
4. Files already created don't need to be regenerated (unless broken)

## Important: Prompts Are Historical

All 12 phases have been executed. The per-phase prompt files (01-foundation.md
… 12-integration.md) **were never written as standalone artifacts** — only this
README ever existed in this directory. The plan below reflects the **original
build spec** at design time. Several details changed during deployment testing:

- **TTS**: Piper → Kokoro-82M (much more natural voice quality)
- **STT/TTS model IDs**: Now fully-qualified HuggingFace IDs
- **Ollama models**: `qwen3:4b` (chat) + `qwen3:latest` (tools) — not 14B
- **Claude auth in Docker**: `CLAUDE_CODE_OAUTH_TOKEN` env var, not `~/.claude` volume mount
- **Speaches**: Models loaded via POST API, not env vars
- **Language detection**: Auto EN/ES via `franc-min` (not in original spec)

For the **actual deployed configuration**, always refer to:
- `reference/decisions.md` — Source of truth for all decisions
- `reference/voice-local.md` — Actual voice integration details
- `reference/dependency-versions.md` — Actual pinned versions
- The source code itself (especially `src/voice.ts`, `docker-compose.yml`, `docker/entrypoint.sh`)

## Reference Documents

The `reference/` directory contains research artifacts:
- `decisions.md` — All confirmed architectural decisions (do not re-discuss)
- `dependency-versions.md` — Pinned package versions
- `ollama-tools.md` — Tool definitions and agentic loop patterns
- `matrix-setup.md` — Synapse deployment and bot SDK usage
- `voice-local.md` — Speaches/Kokoro-82M/Faster-whisper integration with language detection
