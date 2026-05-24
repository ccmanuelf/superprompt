import { describe, it, expect } from 'vitest';
import {
  resolveBridgeConfig,
  buildQueryPath,
  parseQueryResponse,
  EXTERNAL_NOTICE,
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
});
