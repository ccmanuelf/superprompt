/**
 * Rebrand audit regression guard — rc.85
 *
 * Runs scripts/rebrand-audit.sh as part of the vitest suite. If any future
 * contribution reintroduces the former product brand "clauded" anywhere in
 * tracked source / config / docs, this test fails the CI run.
 *
 * The script deliberately distinguishes between the old product brand
 * (which is always wrong post-rebrand) and Anthropic Claude API references
 * like `claude-sonnet`, `CLAUDE_API_KEY`, `@anthropic-ai/claude-code`
 * (which MUST remain). See scripts/rebrand-audit.sh for the full policy.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(here, '..');

describe('rebrand audit (rc.85): no residual "clauded" product-brand references', () => {
  it('scripts/rebrand-audit.sh exits 0', () => {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execSync('./scripts/rebrand-audit.sh', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    // Helpful debug output when this fails — the audit script prints the
    // offending file list to stdout, which vitest will show alongside the
    // assertion error.
    if (exitCode !== 0) {
      console.error('Rebrand audit failed:');
      console.error(stdout);
      if (stderr) console.error('stderr:', stderr);
    }
    expect(exitCode).toBe(0);
  });
});
