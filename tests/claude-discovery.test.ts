/**
 * rc.68 — Claude model discovery via ANTHROPIC_DISCOVERY_API_KEY.
 *
 * Guards the critical safety property: the discovery key lives under a
 * distinct env var name that the Claude CLI does NOT read, so it cannot
 * accidentally switch inference from OAuth subscription to pay-per-token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Silence logger
vi.mock('../src/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// Claude provider is imported lazily so we can mutate env before each test
async function loadProvider() {
  const mod = await import('../src/providers/claude.js');
  return mod;
}

const MOCK_MODELS_RESPONSE = {
  data: [
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
  ],
};

describe('ClaudeProvider.listModels', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_DISCOVERY_API_KEY;

  beforeEach(() => {
    // Start each test with a clean cache by re-importing the module
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_DISCOVERY_API_KEY;
    } else {
      process.env.ANTHROPIC_DISCOVERY_API_KEY = originalKey;
    }
  });

  it('throws ModelDiscoveryUnavailableError when key is not set', async () => {
    delete process.env.ANTHROPIC_DISCOVERY_API_KEY;
    const { ClaudeProvider, ModelDiscoveryUnavailableError } = await loadProvider();
    const provider = new ClaudeProvider();

    await expect(provider.listModels()).rejects.toBeInstanceOf(ModelDiscoveryUnavailableError);
  });

  it('uses ANTHROPIC_DISCOVERY_API_KEY (not ANTHROPIC_API_KEY) for the request', async () => {
    process.env.ANTHROPIC_DISCOVERY_API_KEY = 'discovery-sentinel-key';
    process.env.ANTHROPIC_API_KEY = 'billing-sentinel-key-DO-NOT-USE';

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(MOCK_MODELS_RESPONSE), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { ClaudeProvider } = await loadProvider();
    const provider = new ClaudeProvider();

    await provider.listModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('discovery-sentinel-key');
    // Critical: the billing key must not have been substituted anywhere.
    expect(headers['x-api-key']).not.toBe('billing-sentinel-key-DO-NOT-USE');
    expect(Object.values(headers)).not.toContain('billing-sentinel-key-DO-NOT-USE');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('caches results within the 24h TTL — second call hits cache, not fetch', async () => {
    process.env.ANTHROPIC_DISCOVERY_API_KEY = 'discovery-sentinel-key';

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(MOCK_MODELS_RESPONSE), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { ClaudeProvider } = await loadProvider();
    const provider = new ClaudeProvider();

    const first = await provider.listModels();
    const second = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).toEqual([
      { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    ]);
  });

  it('surfaces HTTP errors with status code', async () => {
    process.env.ANTHROPIC_DISCOVERY_API_KEY = 'discovery-sentinel-key';

    globalThis.fetch = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    const { ClaudeProvider } = await loadProvider();
    const provider = new ClaudeProvider();

    await expect(provider.listModels()).rejects.toThrow(/HTTP 401/);
  });
});
