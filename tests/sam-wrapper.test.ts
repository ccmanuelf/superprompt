/**
 * docker/sam — behavioural tests for the wrapper the `claude -p` subprocess
 * calls (rc.147). The wrapper is bash, not TypeScript, so it had no test
 * coverage at all until now; these exercise the guards that must hold
 * regardless of what the model is persuaded to ask for.
 *
 * Everything here runs WITHOUT network: the guards fire before any curl, and
 * the URL/key handed in are deliberately unroutable so a regression that let a
 * call through would fail loudly rather than quietly hit a real server.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAM = join(REPO_ROOT, 'docker', 'sam');

/** Run `sam …` with dummy, deliberately unroutable config. */
async function runSam(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    NOVALINK_SAM_URL: 'http://127.0.0.1:9',       // discard port — nothing listens
    NOVALINK_SAM_API_KEY: 'sam_test_fixture_key',
  };
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SAM, ...args], { env, timeout: 20_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('docker/sam — set-status approval guard (rc.147)', () => {
  it('refuses to set `approved` and points at the Web UI', async () => {
    const { code, stderr } = await runSam(['set-status', '49', 'approved']);
    // Distinct from the usage exit (2) so a caller can tell them apart.
    expect(code).toBe(3);
    expect(stderr).toMatch(/refusing to set 'approved'/);
    expect(stderr).toContain('/ui/');
    // The reason must travel with the refusal — the model relays this to the
    // user, so "no" without "here is where to do it" is a dead end.
    expect(stderr).toMatch(/service:readwrite/);
  });

  it('refuses BEFORE making any request', async () => {
    // The configured URL is the discard port; anything that actually tried to
    // reach it would burn curl's timeout. Returning fast proves we short-circuit.
    const started = Date.now();
    const { code } = await runSam(['set-status', '49', 'approved']);
    expect(code).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still allows `superseded` through to the API layer', async () => {
    // Bookkeeping, not a judgement — must NOT be blocked. It will fail at the
    // network (nothing listens on the discard port), which is precisely the
    // proof it got past the guard rather than being refused by it.
    const { code, stderr } = await runSam(['set-status', '49', 'superseded']);
    expect(code).not.toBe(3);
    expect(stderr).not.toMatch(/refusing to set/);
  });
});

describe('docker/sam — completion is SAM-declared, not inferred (rc.147)', () => {
  it('polls on generation_status and no longer guesses from updated_at', async () => {
    const src = await readFile(SAM, 'utf8');
    // The recovery poll must key off SAM's own verdict. The old heuristic
    // ("updated_at held steady across two polls") could return a `pending`
    // draft as finished: the engine review is a separate 5-8 min AI call, so
    // updated_at sits unchanged for far longer than two POLL_INTERVALs.
    expect(src).toMatch(/gen=\$\(json_field "\$detail" generation_status\)/);
    expect(src).toMatch(/"\$gen" = "complete"/);
    expect(src).toMatch(/"\$gen" = "failed"/);
    expect(src).not.toContain('prev_updated');
  });
});
