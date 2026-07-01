/**
 * Tests for OLLAMA_KEEP_ALIVE env-configurable model residency (rc.82 / deploy).
 *
 * Verifies:
 * 1. config.OLLAMA_KEEP_ALIVE defaults to '3m' when unset
 * 2. ollama provider's MODEL_KEEP_ALIVE is exported and equals config.OLLAMA_KEEP_ALIVE
 *    (non-tautology: fails if MODEL_KEEP_ALIVE is missing or hardcoded to a different value)
 * 3. When OLLAMA_KEEP_ALIVE is set in the env file config reads, config.OLLAMA_KEEP_ALIVE
 *    reflects the override (uses vi.doMock on env.js, the same mechanism existing tests
 *    use to isolate config — e.g. vi.mock('../src/config.js') in ws-integration.test.ts)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('OLLAMA_KEEP_ALIVE config', () => {
  afterEach(() => {
    // Restore any per-test mocks and reset the module registry so later
    // tests in the full suite get a clean slate.
    vi.doUnmock('../src/env.js');
    vi.resetModules();
  });

  it('defaults to 3m when unset', async () => {
    const { config } = await import('../src/config.js');
    expect(config.OLLAMA_KEEP_ALIVE).toBe('3m');
  });

  it('ollama provider exports MODEL_KEEP_ALIVE equal to config.OLLAMA_KEEP_ALIVE', async () => {
    const { config } = await import('../src/config.js');
    // Import the real provider — if MODEL_KEEP_ALIVE is not exported this
    // destructure yields undefined, which would fail the toBe() assertion below
    // (not a tautology: the ?? fallback from the brief's starting-point is absent).
    const { MODEL_KEEP_ALIVE } = await import('../src/providers/ollama.js') as {
      MODEL_KEEP_ALIVE: string;
    };
    expect(typeof MODEL_KEEP_ALIVE).toBe('string');
    expect(MODEL_KEEP_ALIVE).toBe(config.OLLAMA_KEEP_ALIVE);
  });

  it('OLLAMA_KEEP_ALIVE override in env is reflected in config', async () => {
    // config.ts reads env via readEnvFile() at module evaluation time.
    // Mock the env module BEFORE importing config so the fresh evaluation
    // picks up the overridden value.
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ OLLAMA_KEEP_ALIVE: '60s' }),
    }));
    const { config: freshConfig } = await import('../src/config.js');
    expect(freshConfig.OLLAMA_KEEP_ALIVE).toBe('60s');
  });
});
