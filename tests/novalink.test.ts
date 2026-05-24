import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveBridgeConfig,
  buildQueryPath,
  parseQueryResponse,
  EXTERNAL_NOTICE,
  novalinkListQueriesDefinition,
  novalinkQueryDefinition,
  novalinkHealthDefinition,
  novalinkListQueries,
  novalinkQuery,
  novalinkHealth,
} from '../src/providers/tools/novalink.js';

describe('resolveBridgeConfig', () => {
  it('returns null when url or key is missing', () => {
    expect(resolveBridgeConfig({})).toBeNull();
    expect(resolveBridgeConfig({ NOVALINK_BRIDGE_URL: 'http://b:5000' })).toBeNull();
    expect(resolveBridgeConfig({ NOVALINK_BRIDGE_API_KEY: 'k' })).toBeNull();
  });

  it('returns config and strips a trailing slash from the url', () => {
    const cfg = resolveBridgeConfig({
      NOVALINK_BRIDGE_URL: 'http://novalink-bridge:5000/',
      NOVALINK_BRIDGE_API_KEY: 'nlb_test',
    });
    expect(cfg).toEqual({ url: 'http://novalink-bridge:5000', key: 'nlb_test' });
  });

  it('returns null for empty-string values', () => {
    expect(resolveBridgeConfig({ NOVALINK_BRIDGE_URL: '', NOVALINK_BRIDGE_API_KEY: 'k' })).toBeNull();
  });

  it('strips multiple trailing slashes', () => {
    expect(
      resolveBridgeConfig({ NOVALINK_BRIDGE_URL: 'http://b:5000//', NOVALINK_BRIDGE_API_KEY: 'k' })?.url,
    ).toBe('http://b:5000');
  });
});

describe('buildQueryPath', () => {
  it('builds a slug path with no params', () => {
    expect(buildQueryPath('as-company', {})).toBe('/api/q/as-company');
  });

  it('appends params as a query string', () => {
    expect(buildQueryPath('im-bom', { limit: 50 })).toBe('/api/q/im-bom?limit=50');
  });

  it('skips null/undefined param values', () => {
    expect(buildQueryPath('im-bom', { limit: undefined, q: null })).toBe('/api/q/im-bom');
  });
});

describe('parseQueryResponse', () => {
  it('unwraps an OK envelope and adds the external-data notice', () => {
    const out = parseQueryResponse({
      status: 'OK',
      data: { columns: ['part', 'status'], rows: [['A1', 'released']] },
    });
    expect(out._notice).toBe(EXTERNAL_NOTICE);
    expect(out.columns).toEqual(['part', 'status']);
    expect(out.rows).toEqual([['A1', 'released']]);
  });

  it('maps an ERROR envelope to { error, code }', () => {
    const out = parseQueryResponse({
      status: 'ERROR',
      error: { code: 'AUTH_INVALID', message: 'bad key' },
    });
    expect(out).toEqual({ error: 'bad key', code: 'AUTH_INVALID' });
  });

  it('returns a BAD_RESPONSE error for an unexpected shape', () => {
    const out = parseQueryResponse({});
    expect(out.code).toBe('BAD_RESPONSE');
    expect(out.error).toBeDefined();
  });

  it('treats an OK envelope with no data as BAD_RESPONSE', () => {
    expect(parseQueryResponse({ status: 'OK' }).code).toBe('BAD_RESPONSE');
  });
});

describe('NovaLink tool definitions', () => {
  it('exports 3 definitions with novalink_ names', () => {
    const defs = [novalinkListQueriesDefinition, novalinkQueryDefinition, novalinkHealthDefinition];
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.function.name)).toEqual([
      'novalink_list_queries',
      'novalink_query',
      'novalink_health',
    ]);
  });

  it('novalink_query requires slug', () => {
    expect(novalinkQueryDefinition.function.parameters.required).toContain('slug');
  });
});

describe('NovaLink handlers (stubbed fetch)', () => {
  function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    const { ok = true, status = 200 } = init;
    return vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  }

  beforeEach(() => {
    process.env.NOVALINK_BRIDGE_URL = 'http://bridge.test';
    process.env.NOVALINK_BRIDGE_API_KEY = 'nlb_test';
  });

  afterEach(() => {
    delete process.env.NOVALINK_BRIDGE_URL;
    delete process.env.NOVALINK_BRIDGE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('novalink_query returns rows with the notice and sends X-API-Key', async () => {
    const f = mockFetch({ status: 'OK', data: { columns: ['part'], rows: [['A1']] } });
    vi.stubGlobal('fetch', f);

    const out = await novalinkQuery({ slug: 'im-bom', params: '{"limit":2}' });

    expect(out._notice).toBe(EXTERNAL_NOTICE);
    expect(out.rows).toEqual([['A1']]);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('http://bridge.test/api/q/im-bom?limit=2');
    expect((opts.headers as Record<string, string>)['X-API-Key']).toBe('nlb_test');
  });

  it('novalink_query surfaces an ERROR envelope code', async () => {
    vi.stubGlobal('fetch', mockFetch(
      { status: 'ERROR', error: { code: 'AUTH_INVALID', message: 'bad key' } },
      { ok: false, status: 401 },
    ));
    const out = await novalinkQuery({ slug: 'im-bom' });
    expect(out).toEqual({ error: 'bad key', code: 'AUTH_INVALID' });
  });

  it('novalink_query rejects missing slug and bad params without calling fetch', async () => {
    const f = mockFetch({});
    vi.stubGlobal('fetch', f);
    expect((await novalinkQuery({})).code).toBe('PARAM_MISSING');
    expect((await novalinkQuery({ slug: 'x', params: 'not-json' })).code).toBe('PARAM_INVALID');
    expect((await novalinkQuery({ slug: 'x', params: '[]' })).code).toBe('PARAM_INVALID');
    expect(f).not.toHaveBeenCalled();
  });

  it('novalink_query degrades gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const out = await novalinkQuery({ slug: 'im-bom' });
    expect(String(out.error)).toContain('ECONNREFUSED');
  });

  it('novalink_list_queries returns the catalog verbatim with the notice', async () => {
    vi.stubGlobal('fetch', mockFetch({ endpoints: [{ slug: 'im-bom' }, { slug: 'as-company' }] }));
    const out = await novalinkListQueries();
    expect(out._notice).toBe(EXTERNAL_NOTICE);
    expect(out.catalog).toEqual({ endpoints: [{ slug: 'im-bom' }, { slug: 'as-company' }] });
  });

  it('novalink_health reports reachable/auth/count on 200', async () => {
    vi.stubGlobal('fetch', mockFetch({ endpoints: [{ slug: 'im-bom' }, { slug: 'as-company' }] }));
    const out = await novalinkHealth();
    expect(out.reachable).toBe(true);
    expect(out.auth_valid).toBe(true);
    expect(out.query_count).toBe(2);
    expect(out.bridge_url).toBe('http://bridge.test');
  });

  it('novalink_health reports auth_valid=false on 401', async () => {
    vi.stubGlobal('fetch', mockFetch({}, { ok: false, status: 401 }));
    const out = await novalinkHealth();
    expect(out.reachable).toBe(true);
    expect(out.auth_valid).toBe(false);
  });

  it('novalink_health reports unreachable when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const out = await novalinkHealth();
    expect(out.reachable).toBe(false);
    expect(out.error).toBeDefined();
  });

  it('novalink_query returns BAD_RESPONSE on a non-OK non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('not JSON');
      },
    }));
    const out = await novalinkQuery({ slug: 'im-bom' });
    expect(out.code).toBe('BAD_RESPONSE');
    expect(String(out.error)).toContain('503');
  });

  it('novalink_list_queries returns an error on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const out = await novalinkListQueries();
    expect(String(out.error)).toContain('404');
  });
});
