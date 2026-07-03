/**
 * Tests for the NovaLink bridge system-prompt block (Claude provider path).
 *
 * The block must appear only when the deployment actually has a bridge
 * (NOVALINK_BRIDGE_URL + NOVALINK_BRIDGE_API_KEY set) so bridge-less
 * installs don't carry a prompt for tools they can't reach.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('NOVALINK_BRIDGE_PROMPT', () => {
  afterEach(() => {
    vi.doUnmock('../src/env.js');
    vi.resetModules();
  });

  it('is null when the bridge is not configured', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({}),
    }));
    const { NOVALINK_BRIDGE_PROMPT } = await import('../src/providers/bridge-prompt.js');
    expect(NOVALINK_BRIDGE_PROMPT).toBeNull();
  });

  it('is null when only the URL is set (no key)', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ NOVALINK_BRIDGE_URL: 'https://192.168.2.234:5443' }),
    }));
    const { NOVALINK_BRIDGE_PROMPT } = await import('../src/providers/bridge-prompt.js');
    expect(NOVALINK_BRIDGE_PROMPT).toBeNull();
  });

  it('carries the contract essentials when configured', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({
        NOVALINK_BRIDGE_URL: 'https://192.168.2.234:5443',
        NOVALINK_BRIDGE_API_KEY: 'nlb_test',
      }),
    }));
    const { NOVALINK_BRIDGE_PROMPT } = await import('../src/providers/bridge-prompt.js');
    expect(NOVALINK_BRIDGE_PROMPT).toBeTruthy();
    const p = NOVALINK_BRIDGE_PROMPT as string;
    // The three rules
    expect(p).toContain('Read-only, always');
    expect(p).toContain('NOT ANSWERABLE');
    // The call recipe uses the baked-in wrapper
    expect(p).toContain('bridge <slug>');
    // Endpoint coverage spot checks (one per section)
    expect(p).toContain('bom-explosion-batch');
    expect(p).toContain('inventory-coverage');
    expect(p).toContain('part-master-trade');
    expect(p).toContain('companies');
    // Conventions that prevent wrong answers
    expect(p).toContain('meta.truncated');
    expect(p).toContain('COMPANY_ID');
    // Never teach the raw key
    expect(p).not.toContain('nlb_test');
  });
});
