# Luna Deploy-Readiness (Repo Changes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the superprompt repo deploy-ready for the MacBook Pro production cutover — env-configurable Ollama residency, bridge HTTPS trust plumbing, the one genuine memory-teardown hardening, calc-module memory review, and a soak-test harness — each landed via PR that auto-merges on green CI.

**Architecture:** Small, independent, test-first changes to the repo. None of these touch the live bot; they prepare the artifacts the prod box will clone. The operational deployment + cutover live in the sibling plan `2026-06-26-luna-macbook-cutover.md`.

**Tech Stack:** Node 26 (ESM, NodeNext), TypeScript ES2022 strict, vitest, Knex/SQLite, Docker Compose, the `ollama` npm SDK, undici `fetch`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-luna-macbook-deployment-design.md` (authoritative).
- **Code conventions:** `fileURLToPath(import.meta.url)` never `.pathname`; never set `process.env` from `.env` (use `readEnvFile()`); ESM only; graceful degradation at service boundaries.
- **Verify every task:** `npx tsc --noEmit` clean · `npm run lint` 0 errors (no new `no-explicit-any`) · `npx vitest run` green · `npm run build && npm run smoke` for dist-affecting changes.
- **Workflow:** branch per task → PR → **merge when CI is green without waiting** → continue; document comprehensively. Never `git add -A` (stage explicit paths); never `--no-verify`.
- **Memory hygiene baseline is already good** (verified, not assumed). These tasks are *narrow* — do not invent leaks. `rg` is NOT installed here; use `grep`/Read, never trust an `rg` "0 matches".

---

## File Structure

- `src/config.ts` — add `OLLAMA_KEEP_ALIVE` to the config object (env-driven, default `'3m'`).
- `src/providers/ollama.ts` — source `MODEL_KEEP_ALIVE` from config instead of a hard-coded literal.
- `docker-compose.yml` — luna service: mount the bridge CA cert (read-only) + set `NODE_EXTRA_CA_CERTS`.
- `.env.example` — document `OLLAMA_KEEP_ALIVE`, the HTTPS `NOVALINK_BRIDGE_URL`, and the cert path.
- `src/forge/worker-sandbox.ts` — (conditional) explicit terminate-on-success if the investigation confirms a linger path.
- `tests/ollama-keep-alive.test.ts`, `tests/worker-sandbox-teardown.test.ts` — new tests.
- `scripts/soak-memory.sh` — soak-test harness used by the cutover plan's validation phase.

---

### Task 1: Make Ollama `keep_alive` env-configurable

Lets the prod box tune model residency for `qwen3.5:4b` on 16 GB without a code change. Default stays `'3m'` (unchanged behavior).

**Files:**
- Modify: `src/config.ts` (config object, near the `OLLAMA_*` block ~line 53)
- Modify: `src/providers/ollama.ts:17`
- Modify: `.env.example` (OLLAMA section)
- Test: `tests/ollama-keep-alive.test.ts`

**Interfaces:**
- Produces: `config.OLLAMA_KEEP_ALIVE: string` (default `'3m'`); `src/providers/ollama.ts` `MODEL_KEEP_ALIVE` now equals `config.OLLAMA_KEEP_ALIVE`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ollama-keep-alive.test.ts
import { describe, it, expect } from 'vitest';

describe('OLLAMA_KEEP_ALIVE config', () => {
  it('defaults to 3m when unset', async () => {
    delete process.env.__nothing; // no-op; config reads .env via readEnvFile, not process.env
    const { config } = await import('../src/config.js');
    expect(config.OLLAMA_KEEP_ALIVE).toBe('3m');
  });

  it('ollama provider sources MODEL_KEEP_ALIVE from config', async () => {
    const { config } = await import('../src/config.js');
    const mod = await import('../src/providers/ollama.js');
    // The provider must not hard-code residency; it must equal the config value.
    expect((mod as { MODEL_KEEP_ALIVE?: string }).MODEL_KEEP_ALIVE ?? config.OLLAMA_KEEP_ALIVE)
      .toBe(config.OLLAMA_KEEP_ALIVE);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/ollama-keep-alive.test.ts`
Expected: FAIL — `config.OLLAMA_KEEP_ALIVE` is `undefined`.

- [ ] **Step 3: Add the config field**

In `src/config.ts`, in the config object near the other `OLLAMA_*` entries:

```ts
  OLLAMA_KEEP_ALIVE: env.OLLAMA_KEEP_ALIVE || '3m',
```

- [ ] **Step 4: Source the constant from config**

In `src/providers/ollama.ts`, replace the hard-coded literal at line 17:

```ts
// rc.82 / deploy: idle model residency. Default 3m; override via OLLAMA_KEEP_ALIVE
// (e.g. shorten on a 16 GB host running qwen3.5:4b + Speaches). See deployment spec §9.
export const MODEL_KEEP_ALIVE = config.OLLAMA_KEEP_ALIVE;
```

(`config` is already imported at the top of `ollama.ts`.)

- [ ] **Step 5: Run the test; verify it passes**

Run: `npx vitest run tests/ollama-keep-alive.test.ts`
Expected: PASS.

- [ ] **Step 6: Document in `.env.example`**

Add under the OLLAMA section:

```
# Idle model residency (Ollama keep_alive). Default 3m. On a RAM-constrained
# host (e.g. 16 GB running qwen3.5:4b + Speaches), shorten to reclaim RAM
# faster between idle turns, e.g. 60s. Set 0 to unload immediately after each call.
# OLLAMA_KEEP_ALIVE=3m
```

- [ ] **Step 7: Verify + commit**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: clean, 0 errors, green.

```bash
git checkout -b feat/ollama-keep-alive-env
git add src/config.ts src/providers/ollama.ts .env.example tests/ollama-keep-alive.test.ts
git commit -m "feat(ollama): make keep_alive env-configurable (OLLAMA_KEEP_ALIVE, default 3m)"
git push -u origin feat/ollama-keep-alive-env
gh pr create --fill --base main
# Merge when CI is green (auto-authorized): gh pr merge --squash --auto
```

---

### Task 2: Bridge HTTPS cert trust (compose + env plumbing)

Luna will reach the bridge at `https://192.168.2.234:5443` with a self-signed IP cert. The bridge client (`src/providers/tools/novalink.ts:83`) uses global `fetch` with no custom dispatcher, so it honors `NODE_EXTRA_CA_CERTS` — **no code change to the client**. This task adds the mount + env plumbing and documents it. Runtime validation happens in the cutover plan against the real bridge.

**Files:**
- Modify: `docker-compose.yml` (luna service `volumes:` + `environment:`)
- Modify: `.env.example` (NOVALINK BRIDGE section)
- Verify (read-only): `src/providers/tools/novalink.ts` still uses global `fetch` (no `dispatcher`/`Agent`/`rejectUnauthorized`).

**Interfaces:**
- Produces: container path `/app/certs/bridge-cert.pem` (ro mount) + `NODE_EXTRA_CA_CERTS=/app/certs/bridge-cert.pem` in the luna service env. The cutover plan supplies the actual PEM into host `./certs/`.

- [ ] **Step 1: Confirm the client honors Node's trust store (no regression to guard)**

Run: `grep -n "fetch(\|dispatcher\|Agent(\|rejectUnauthorized" src/providers/tools/novalink.ts`
Expected: a single `fetch(` at line 83, **no** `dispatcher`/`Agent`/`rejectUnauthorized`. If any custom HTTPS agent appears, STOP — it would bypass `NODE_EXTRA_CA_CERTS` and needs a code fix first.

- [ ] **Step 2: Add the cert mount + env to `docker-compose.yml`**

In the `luna` service `volumes:` list, add:

```yaml
      # Bridge CA cert (read-only) — lets Node trust the self-signed bridge TLS.
      # The host ./certs/bridge-cert.pem is supplied during deployment.
      - ./certs/bridge-cert.pem:/app/certs/bridge-cert.pem:ro
```

In the `luna` service `environment:` list, add:

```yaml
      # Trust the bridge's self-signed cert without disabling TLS verification.
      # NEVER use NODE_TLS_REJECT_UNAUTHORIZED=0 (disables verification process-wide).
      - NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-/app/certs/bridge-cert.pem}
```

- [ ] **Step 3: Document in `.env.example`**

Replace the NOVALINK BRIDGE block's example URL and add the cert note:

```
# NOVALINK_BRIDGE_URL=https://192.168.2.234:5443
# NOVALINK_BRIDGE_API_KEY=your-novalink-key-here
# The bridge uses a self-signed IP cert (subjectAltName=IP:192.168.2.234).
# Node trusts it via NODE_EXTRA_CA_CERTS (set in docker-compose.yml); place the
# public cert at ./certs/bridge-cert.pem. Do NOT set NODE_TLS_REJECT_UNAUTHORIZED=0.
# NODE_EXTRA_CA_CERTS=/app/certs/bridge-cert.pem
```

- [ ] **Step 4: Guard against a missing cert breaking unrelated runs**

The mount references `./certs/bridge-cert.pem`; if absent, compose errors. Commit a tracked placeholder so dev/CI still builds, and document that deployment overwrites it:

```bash
mkdir -p certs
printf '# placeholder — replaced at deployment with the real bridge CA cert\n' > certs/bridge-cert.pem
```

Add `certs/*.pem` handling: keep the placeholder tracked but ensure no real cert is ever committed. Append to `.gitignore`:

```
# Bridge/web certs — real certs are deployment-only; placeholder is the exception
certs/*.pem
!certs/bridge-cert.pem
```

- [ ] **Step 5: Verify compose + build + commit**

Run: `docker compose config >/dev/null && echo OK` (validates the compose file parses)
Expected: `OK`.
Run: `npm run build`
Expected: builds clean.

```bash
git checkout -b feat/bridge-https-trust
git add docker-compose.yml .env.example .gitignore certs/bridge-cert.pem
git commit -m "feat(novalink): plumb bridge HTTPS trust via NODE_EXTRA_CA_CERTS mount"
git push -u origin feat/bridge-https-trust
gh pr create --fill --base main
# Merge on green CI.
```

---

### Task 3: Worker success-path teardown (investigate → harden)

Spec §9 genuine target: on the success path, `worker-sandbox.ts` `finish()` does not call `worker.terminate()` — it relies on the worker self-exiting. Verify whether user code leaving a dangling handle can keep the thread (≤64 MB) alive, and harden if so.

**Files:**
- Read: `src/forge/worker-entry.ts` (does it force-exit after posting `result`?)
- Modify (conditional): `src/forge/worker-sandbox.ts` `finish()` / the `result` branch (~lines 116-172)
- Test: `tests/worker-sandbox-teardown.test.ts`

**Interfaces:**
- Consumes: `executeInWorker(code, args, options?)` from `src/forge/worker-sandbox.ts`.
- Produces: guarantee that after a successful result the worker thread is terminated (no lingering thread regardless of user-left handles).

- [ ] **Step 1: Investigate the exit path**

Run: `grep -n "process.exit\|parentPort\|postMessage\|close()" src/forge/worker-entry.ts`
Read `worker-entry.ts`. Decide: does it deterministically exit after posting `result` (e.g. `process.exit(0)` or the event loop drains), or could user code (e.g. a `setInterval`) keep it alive? Record the finding in the PR description.

- [ ] **Step 2: Write the failing test (dangling-handle user code)**

```ts
// tests/worker-sandbox-teardown.test.ts
import { describe, it, expect } from 'vitest';
import { executeInWorker } from '../src/forge/worker-sandbox.js';

describe('worker teardown on success', () => {
  it('returns promptly and tears down even when user code leaves a timer', async () => {
    // User code resolves a result but leaves an interval running.
    const code = `
      setInterval(() => {}, 1000); // dangling handle
      return { ok: true };
    `;
    const start = Date.now();
    const result = await executeInWorker(code, {});
    expect(result).toMatchObject({ ok: true });
    // Must resolve on the result, not block on the rolling/absolute timer.
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/worker-sandbox-teardown.test.ts`
Expected: If `worker-entry.ts` already force-exits, this PASSES — then the hardening is unnecessary; keep the test as a regression guard, note the finding, and skip Step 4. If it FAILS/HANGS, the linger is real → proceed to Step 4.

- [ ] **Step 4 (only if Step 3 failed): Add explicit terminate-on-success**

In `src/forge/worker-sandbox.ts`, in the `result` branch where `msg.success` is handled, terminate after capturing the result. Concretely, make `finish()` terminate the worker unconditionally (it is already idempotent and only called once):

```ts
    function finish(result: Record<string, unknown>): void {
      if (settled) return;
      settled = true;
      clearTimeout(rollingTimer);
      clearTimeout(absoluteTimer);
      worker.terminate().catch(() => {}); // guarantee teardown on ALL paths, incl. success
      worker.removeAllListeners();
      resolvePromise(result);
    }
```

Remove the now-redundant `worker.terminate()` inside `onTimeout` (finish handles it). Verify the `exit` handler's `!settled` guard still behaves (terminate triggers an `exit`, but `settled` is already true).

- [ ] **Step 5: Run the test; verify it passes; run the full sandbox suite for regressions**

Run: `npx vitest run tests/worker-sandbox-teardown.test.ts && npx vitest run tests/ | grep -i worker`
Expected: PASS; existing worker/forge tests still green.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`

```bash
git checkout -b fix/worker-success-teardown
git add src/forge/worker-sandbox.ts tests/worker-sandbox-teardown.test.ts
git commit -m "fix(sandbox): guarantee Worker teardown on success path (no lingering thread)"
git push -u origin fix/worker-success-teardown
gh pr create --fill --base main
# Merge on green CI.
```

---

### Task 4: Heavy calc-module memory review (investigate → fix per finding)

Spec §9 target: confirm the largest calc modules release big intermediate arrays after producing a result. This is a read-and-verify task; fixes are authored per confirmed finding (do not fabricate fixes for code that's already clean).

**Files:**
- Read: `src/sigma.ts` (1885L), `src/balance.ts` (1106L), `src/doe.ts` / Monte-Carlo / GA paths.
- Modify: only files where a confirmed retention is found.
- Test: per finding (a test asserting the result shape is unchanged after the fix).

- [ ] **Step 1: Identify the large-allocation hot paths**

Run: `grep -n "new Array\|Array.from\|\.push(\|new Float64Array\|matrix\|samples\|iterations" src/sigma.ts src/balance.ts src/doe.ts`
For each, ask: is a large array (Monte-Carlo samples, DOE design matrix, GA population) held in a closure / module-level var / appended to a history or log after the result is computed?

- [ ] **Step 2: Classify each candidate**

For each hot path, record one of: (a) **clean** — array is local and GC-eligible after return; (b) **retained** — referenced beyond the result (closure, module var, pushed to a kept buffer, or logged in full). Only (b) is a finding.

- [ ] **Step 3 (per finding): Write a regression test, then fix**

For a confirmed retention, write a test that exercises the module and asserts the result is byte-identical before/after, then null the retained reference / scope it locally / log a summary instead of the full array. Show the exact diff in the PR.

- [ ] **Step 4: If no findings, document that explicitly**

If all paths classify as (a), the deliverable is the written classification in the PR description (per the no-silent-caps rule — record what was checked and found clean). No code change is a valid outcome here.

- [ ] **Step 5: Verify + commit (only if a fix was made)**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`

```bash
git checkout -b perf/calc-memory-release
git add src/<changed>.ts tests/<added>.test.ts
git commit -m "perf(calc): release large intermediate arrays after result in <module>"
gh pr create --fill --base main   # or skip PR if no code change; record findings in the cutover plan instead
```

---

### Task 5: Soak-test harness

A repeatable script the cutover plan uses to prove flat RSS on the real 16 GB box. Drives representative load and samples container + host memory.

**Files:**
- Create: `scripts/soak-memory.sh`

**Interfaces:**
- Produces: `scripts/soak-memory.sh <minutes>` → prints periodic `docker stats` (luna container RSS) + `ollama ps` (loaded models) + host `vm_stat`/`memory_pressure`, and a start/end delta summary.

- [ ] **Step 1: Write the harness**

```bash
# scripts/soak-memory.sh
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
```

- [ ] **Step 2: Make it executable + sanity-run locally (short window)**

Run: `chmod +x scripts/soak-memory.sh && ./scripts/soak-memory.sh 1 15`
Expected: prints a CSV header + ~4 sample rows over 1 minute without error (on the dev box; `luna-bot` is running here).

- [ ] **Step 3: Commit**

```bash
git checkout -b chore/soak-memory-harness
git add scripts/soak-memory.sh
git commit -m "chore(ops): add soak-memory.sh harness for RSS validation on the prod box"
gh pr create --fill --base main   # merge on green CI
```

---

## Self-Review

- **Spec coverage:** §3 model default → set via `.env` on the box (Task 1 makes residency tunable); §8 bridge trust → Task 2; §9 keep_alive tune → Task 1, Worker teardown → Task 3, calc arrays → Task 4, soak proof → Task 5. Speaches idle-unload (§9) is a runtime config check → handled in the cutover plan's validation, not a repo change.
- **Placeholder scan:** Tasks 3 & 4 are investigate-then-fix by nature; their investigation steps are concrete and a "no code change, document the finding" outcome is explicitly allowed — this is honest scoping, not a placeholder.
- **Type consistency:** `config.OLLAMA_KEEP_ALIVE: string` consumed by `MODEL_KEEP_ALIVE` (string) in ollama.ts; `executeInWorker` signature unchanged.

## Execution Handoff

This plan is code work — best run **subagent-driven** (fresh subagent per task, review between tasks). Tasks 1, 2, 5 are independent and can go in parallel; Tasks 3 and 4 are investigate-then-fix. All merge on green CI per the standing authorization. The operational deployment that consumes these artifacts is `2026-06-26-luna-macbook-cutover.md`.
