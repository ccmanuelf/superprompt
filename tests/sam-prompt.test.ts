/**
 * Tests for the NovaLink SAM system-prompt block (Claude provider path).
 *
 * The block must appear only when the deployment actually has SAM
 * (NOVALINK_SAM_URL + NOVALINK_SAM_API_KEY set) so SAM-less installs
 * don't carry a prompt for a wrapper they can't use. (spec 2026-07-13 §2)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('NOVALINK_SAM_PROMPT / SAM_CONFIGURED', () => {
  afterEach(() => {
    vi.doUnmock('../src/env.js');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is null / false when SAM is not configured', async () => {
    vi.resetModules();
    vi.stubEnv('NOVALINK_SAM_URL', '');
    vi.stubEnv('NOVALINK_SAM_API_KEY', '');
    vi.doMock('../src/env.js', () => ({ readEnvFile: () => ({}) }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.NOVALINK_SAM_PROMPT).toBeNull();
    expect(mod.SAM_CONFIGURED).toBe(false);
  });

  it('is null when only the URL is set (no key)', async () => {
    vi.resetModules();
    vi.stubEnv('NOVALINK_SAM_URL', '');
    vi.stubEnv('NOVALINK_SAM_API_KEY', '');
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ NOVALINK_SAM_URL: 'http://192.168.2.234:8080' }),
    }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.NOVALINK_SAM_PROMPT).toBeNull();
    expect(mod.SAM_CONFIGURED).toBe(false);
  });

  it('carries the contract essentials when configured', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({
        NOVALINK_SAM_URL: 'http://192.168.2.234:8080',
        NOVALINK_SAM_API_KEY: 'sam_test_fixture_key',
      }),
    }));
    const mod = await import('../src/providers/sam-prompt.js');
    expect(mod.SAM_CONFIGURED).toBe(true);
    const p = mod.NOVALINK_SAM_PROMPT as string;
    // Wrapper contract — every subcommand from spec §1
    expect(p).toContain('sam health');
    expect(p).toContain('sam search <kind>');
    expect(p).toContain('measured_times');
    expect(p).toContain('sam get <id> [--full]');
    expect(p).toContain('sam create <client|product>');
    expect(p).toContain("sam generate '<json>'");
    expect(p).toContain('sam set-status <id> <status>');
    expect(p).toContain('sam export <id>');
    // Error convention
    expect(p).toContain('`detail`');
    // §3 methodology essentials
    expect(p).toContain('15% PFD');
    expect(p).toContain('machine dwell');
    expect(p).toContain('[VALIDATED]');
    expect(p).toContain('262 measured');
    expect(p).toContain('never invent figures');
    // Write confirmation rule (SA4 bypass tradeoff moves into the prompt)
    expect(p).toContain('explicit confirmation');
    // generate cost/latency guidance
    expect(p).toContain('60–120 s');
    expect(p).toContain('"persist": false');
    // File delivery marker
    expect(p).toContain('[send-file:');
    // Ingest redirect
    expect(p).toContain('web UI');
    // Never teach the raw key
    expect(p).not.toContain('sam_test_fixture_key');
  });
});
