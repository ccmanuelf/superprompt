/**
 * Tests for OLLAMA_THINK env-configurable thinking mode (deploy perf).
 *
 * qwen3.5-class models emit hidden chain-of-thought before every answer;
 * on slow GPUs (M1 ~16 tok/s) that is minutes per reply. OLLAMA_THINK=false
 * lets a deployment trade reasoning depth for latency without a rebuild.
 *
 * Verifies:
 * 1. config.OLLAMA_THINK defaults to true when unset (upstream behavior)
 * 2. OLLAMA_THINK=false in env flips it off
 * 3. any other value (including 'true') keeps it on
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('OLLAMA_THINK config', () => {
  afterEach(() => {
    vi.doUnmock('../src/env.js');
    vi.resetModules();
  });

  it('defaults to true when unset', async () => {
    const { config } = await import('../src/config.js');
    expect(config.OLLAMA_THINK).toBe(true);
  });

  it('OLLAMA_THINK=false disables thinking', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ OLLAMA_THINK: 'false' }),
    }));
    const { config: freshConfig } = await import('../src/config.js');
    expect(freshConfig.OLLAMA_THINK).toBe(false);
  });

  it('OLLAMA_THINK=true keeps thinking enabled', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ OLLAMA_THINK: 'true' }),
    }));
    const { config: freshConfig } = await import('../src/config.js');
    expect(freshConfig.OLLAMA_THINK).toBe(true);
  });
});
