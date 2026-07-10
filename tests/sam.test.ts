import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveSamConfig,
  SEARCH_KINDS,
  buildSearchPath,
  extractErrorDetail,
  stripFullJson,
  shapeAnalysis,
  EXTERNAL_NOTICE,
} from '../src/providers/tools/sam.js';

describe('resolveSamConfig', () => {
  it('returns null when url or key is missing or empty', () => {
    expect(resolveSamConfig({})).toBeNull();
    expect(resolveSamConfig({ NOVALINK_SAM_URL: 'http://sam:8080' })).toBeNull();
    expect(resolveSamConfig({ NOVALINK_SAM_API_KEY: 'k' })).toBeNull();
    expect(resolveSamConfig({ NOVALINK_SAM_URL: '', NOVALINK_SAM_API_KEY: 'k' })).toBeNull();
  });

  it('returns config and strips trailing slashes from the url', () => {
    expect(
      resolveSamConfig({ NOVALINK_SAM_URL: 'http://sam:8080//', NOVALINK_SAM_API_KEY: 'sk' }),
    ).toEqual({ url: 'http://sam:8080', key: 'sk' });
  });
});

describe('buildSearchPath', () => {
  it('maps each kind to its endpoint with no filters', () => {
    expect(buildSearchPath('products', {})).toBe('/products');
    expect(buildSearchPath('analyses', {})).toBe('/analyses');
    expect(buildSearchPath('measured_times', {})).toBe('/measured-times');
    expect(buildSearchPath('machines', {})).toBe('/machines');
    expect(buildSearchPath('clients', {})).toBe('/clients');
  });

  it('appends only the filters applicable to the kind', () => {
    expect(
      buildSearchPath('measured_times', { q: 'bastillar', machine_code: 'SNLS', limit: 10, status: 'draft' }),
    ).toBe('/measured-times?q=bastillar&machine_code=SNLS&limit=10');
    expect(
      buildSearchPath('analyses', { q: 'pant', client_id: 3, status: 'approved', machine_code: 'SNLS' }),
    ).toBe('/analyses?q=pant&client_id=3&status=approved');
    // machines/clients take no filters at all
    expect(buildSearchPath('machines', { q: 'SNLS' })).toBe('/machines');
  });

  it('skips undefined/null/empty filter values', () => {
    expect(buildSearchPath('products', { q: undefined, client_id: null, limit: '' })).toBe('/products');
  });

  it('url-encodes filter values', () => {
    expect(buildSearchPath('products', { q: 'cargo pant' })).toBe('/products?q=cargo+pant');
  });
});

describe('extractErrorDetail', () => {
  it('surfaces a string detail', () => {
    expect(extractErrorDetail(404, { detail: 'Analysis not found' })).toBe('HTTP 404: Analysis not found');
  });

  it('stringifies a structured detail (FastAPI validation errors)', () => {
    expect(extractErrorDetail(422, { detail: [{ loc: ['body', 'name'] }] })).toBe(
      'HTTP 422: [{"loc":["body","name"]}]',
    );
  });

  it('falls back to a generic message when detail is absent or body is not JSON', () => {
    expect(extractErrorDetail(500, null)).toBe('NovaLink SAM returned HTTP 500');
    expect(extractErrorDetail(502, 'gateway')).toBe('NovaLink SAM returned HTTP 502');
  });
});

describe('stripFullJson / shapeAnalysis', () => {
  it('removes full_json and leaves a marker', () => {
    const out = stripFullJson({ id: 1, total_sam_min: 49.2, full_json: { big: true } });
    expect(out.full_json).toBeUndefined();
    expect(out._full_json_omitted).toBeTruthy();
    expect(out.id).toBe(1);
  });

  it('also strips full_json nested inside a draft (generate persist=false shape)', () => {
    const out = stripFullJson({ draft: { id: null, full_json: { big: true }, total_sam_min: 12 } });
    const draft = out.draft as Record<string, unknown>;
    expect(draft.full_json).toBeUndefined();
    expect(draft._full_json_omitted).toBeTruthy();
  });

  it('does not mutate its input', () => {
    const input = { full_json: { a: 1 } };
    stripFullJson(input);
    expect(input.full_json).toEqual({ a: 1 });
  });

  it('shapeAnalysis omits full_json by default and keeps it on request', () => {
    const body = { id: 7, operations: [{ seq: 1 }], full_json: { sections: 20 } };
    const omitted = shapeAnalysis(body, false);
    expect((omitted.analysis as Record<string, unknown>).full_json).toBeUndefined();
    expect(omitted._notice).toBe(EXTERNAL_NOTICE);
    const kept = shapeAnalysis(body, true);
    expect((kept.analysis as Record<string, unknown>).full_json).toEqual({ sections: 20 });
  });

  it('shapeAnalysis rejects non-object bodies', () => {
    expect(shapeAnalysis(null, false).error).toBeTruthy();
    expect(shapeAnalysis([1], false).error).toBeTruthy();
  });
});
