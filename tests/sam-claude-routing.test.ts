import { describe, it, expect } from 'vitest';
import {
  isSamDataTurn,
  resolveSamTurnRoute,
  isNovalinkDataTurn,
} from '../src/providers/router.js';

// spec 2026-07-13 §3 — SAM turns must not be answered by the local model by
// default (Task 9 live smoke 2026-07-10: qwen3.5:4b fabricated complete
// analyses tables on 2 of 3 sam-bucket turns). Vocabulary is the rc.135
// adversarially-probed bucket regex, re-exported — these cases mirror
// tests/local-buckets.test.ts so a vocabulary drift breaks both suites.
describe('isSamDataTurn', () => {
  it('detects EN SAM asks', () => {
    expect(isSamDataTurn('what are the standard allowed minutes for the assault pant?')).toBe(true);
    expect(isSamDataTurn('draft a sam analysis from this tech pack')).toBe(true);
    expect(isSamDataTurn('show me the measured times for bastillar')).toBe(true);
    expect(isSamDataTurn('run a sam health check')).toBe(true);
  });
  it('detects ES SAM asks', () => {
    expect(isSamDataTurn('dame los minutos estándar del análisis de sam')).toBe(true);
    expect(isSamDataTurn('cuál es el costo por pieza de este producto')).toBe(true);
  });
  it('does not fire on bare "Sam" as a person name or general chat', () => {
    expect(isSamDataTurn('Sam said hi about the meeting')).toBe(false);
    expect(isSamDataTurn('write me a poem about the ocean')).toBe(false);
  });
});

describe('resolveSamTurnRoute', () => {
  const samAsk = 'draft a sam analysis from this tech pack';

  it('returns null when SAM env is not configured (gate)', () => {
    expect(resolveSamTurnRoute({ samConfigured: false, message: samAsk, samRoute: 'auto' })).toBeNull();
  });
  it('returns null for non-SAM messages', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: 'hello there', samRoute: 'auto' })).toBeNull();
  });
  it('auto (default, incl. missing/unknown column values) and claude → claude', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'auto' })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: undefined })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: null })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'garbage' })).toBe('claude');
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'claude' })).toBe('claude');
  });
  it('local → local (explicit opt-in, LAN-only reads)', () => {
    expect(resolveSamTurnRoute({ samConfigured: true, message: samAsk, samRoute: 'local' })).toBe('local');
  });

  // Precedence (spec §3): a turn matching BOTH the SAM vocabulary and
  // NOVALINK_DATA_PATTERNS is a SAM turn — data-quality wins. Enforced by
  // call order in getProviderForChat (SAM pin runs before the auto-route
  // block that hosts the novalink pin); this test pins the both-match input.
  it('a message matching both SAM and NovaLink vocabularies resolves as a SAM turn', () => {
    const both = 'necesito el análisis de sam para los faltantes de la compañía 1054';
    expect(isSamDataTurn(both)).toBe(true);
    expect(isNovalinkDataTurn(both)).toBe(true);
    expect(resolveSamTurnRoute({ samConfigured: true, message: both, samRoute: 'auto' })).toBe('claude');
  });
});
