import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeDeclarativeHttp } from '../src/forge/declarative-http.js';
import type { DeclarativeHttpEndpoint } from '../src/forge/tool-parser.js';

// Mock global fetch
const originalFetch = global.fetch;

describe('executeDeclarativeHttp', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('substitutes parameter placeholders in URL and query', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ result: 'sunny' }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'GET',
      url: 'https://api.example.com/weather',
      // eslint-disable-next-line no-template-curly-in-string -- literal template placeholder is intentional
      query: { q: '${city}', key: '${API_KEY}' },
    };

    await executeDeclarativeHttp(endpoint, { city: 'London' }, { API_KEY: 'test-key' });

    expect(capturedUrl).toContain('q=London');
    expect(capturedUrl).toContain('key=test-key');
  });

  it('extracts response using response_path', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          current: { condition: { text: 'Partly cloudy' } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'GET',
      url: 'https://api.example.com/weather',
      response_path: 'current.condition.text',
    };

    const result = await executeDeclarativeHttp(endpoint, {});
    expect(result).toEqual({ result: 'Partly cloudy' });
  });

  it('returns error on HTTP failure', async () => {
    global.fetch = vi.fn(async () => {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'GET',
      url: 'https://api.example.com/missing',
    };

    const result = await executeDeclarativeHttp(endpoint, {});
    expect(result.error).toContain('404');
  });

  it('returns error on network failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('Network error');
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'GET',
      url: 'https://api.example.com/fail',
    };

    const result = await executeDeclarativeHttp(endpoint, {});
    expect(result.error).toContain('Network error');
  });

  it('handles POST with body', async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'POST',
      url: 'https://api.example.com/data',
      // eslint-disable-next-line no-template-curly-in-string -- literal template placeholder is intentional
      body: { message: '${text}' } as Record<string, unknown>,
    };

    await executeDeclarativeHttp(endpoint, { text: 'hello world' });

    expect(capturedInit?.method).toBe('POST');
    const bodyParsed = JSON.parse(capturedInit?.body as string);
    expect(bodyParsed.message).toBe('hello world');
  });

  it('handles non-JSON responses', async () => {
    global.fetch = vi.fn(async () => {
      return new Response('Plain text response', {
        headers: { 'content-type': 'text/plain' },
      });
    });

    const endpoint: DeclarativeHttpEndpoint = {
      method: 'GET',
      url: 'https://api.example.com/text',
    };

    const result = await executeDeclarativeHttp(endpoint, {});
    expect(result).toEqual({ text: 'Plain text response' });
  });
});
