/**
 * Tests for OLLAMA_NUM_CTX env-configurable context window (deploy perf).
 *
 * The per-call KV allocation scales with num_ctx (32k on qwen3.5:4b is
 * ~4.3 GB resident); on RAM-tight hosts that spills to swap and model
 * loads take minutes. OLLAMA_NUM_CTX lets a deployment shrink the window
 * without a rebuild.
 *
 * Verifies:
 * 1. config.OLLAMA_NUM_CTX defaults to 32768 when unset
 * 2. OLLAMA_NUM_CTX override is parsed as a number
 * 3. non-numeric garbage falls back to the default
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('OLLAMA_NUM_CTX config', () => {
  afterEach(() => {
    vi.doUnmock('../src/env.js');
    vi.resetModules();
  });

  it('defaults to 32768 when unset', async () => {
    const { config } = await import('../src/config.js');
    expect(config.OLLAMA_NUM_CTX).toBe(32768);
  });

  it('OLLAMA_NUM_CTX=8192 overrides as a number', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ OLLAMA_NUM_CTX: '8192' }),
    }));
    const { config: freshConfig } = await import('../src/config.js');
    expect(freshConfig.OLLAMA_NUM_CTX).toBe(8192);
  });

  it('non-numeric value falls back to default', async () => {
    vi.resetModules();
    vi.doMock('../src/env.js', () => ({
      readEnvFile: () => ({ OLLAMA_NUM_CTX: 'lots' }),
    }));
    const { config: freshConfig } = await import('../src/config.js');
    expect(freshConfig.OLLAMA_NUM_CTX).toBe(32768);
  });
});
