/**
 * rc.72 — Ollama model-size-aware agentic ceilings.
 *
 * Small models (≤2B) spiral on complex tool loops. Tighter
 * MAX_ITERATIONS + num_predict + lower temperature reduces
 * hallucinations and fails fast so the user knows to upgrade.
 */
import { describe, it, expect } from 'vitest';
import { parseParameterSize, resolveModelTier } from '../src/providers/ollama.js';

describe('parseParameterSize (rc.72)', () => {
  it('parses billions with B suffix', () => {
    expect(parseParameterSize('9.7B')).toBeCloseTo(9.7, 5);
    expect(parseParameterSize('14.8B')).toBeCloseTo(14.8, 5);
    expect(parseParameterSize('2.0B')).toBeCloseTo(2.0, 5);
    expect(parseParameterSize('2B')).toBeCloseTo(2, 5);
  });

  it('converts M suffix to fractional billions', () => {
    expect(parseParameterSize('137M')).toBeCloseTo(0.137, 5);
    expect(parseParameterSize('999.89M')).toBeCloseTo(0.99989, 5);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseParameterSize('9.7b')).toBeCloseTo(9.7, 5);
    expect(parseParameterSize('  2.0B  ')).toBeCloseTo(2.0, 5);
  });

  it('returns +Infinity (treat as large) for unknown / missing formats', () => {
    expect(parseParameterSize(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(parseParameterSize(null)).toBe(Number.POSITIVE_INFINITY);
    expect(parseParameterSize('')).toBe(Number.POSITIVE_INFINITY);
    expect(parseParameterSize('unknown')).toBe(Number.POSITIVE_INFINITY);
    expect(parseParameterSize('9.7G')).toBe(Number.POSITIVE_INFINITY);
    expect(parseParameterSize('abc')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('resolveModelTier (rc.72)', () => {
  it('≤2B uses the strict tier (4 iterations, 512 tokens, temp 0.2)', () => {
    expect(resolveModelTier(0.5)).toEqual({ maxIterations: 4, numPredict: 512, temperature: 0.2 });
    expect(resolveModelTier(2)).toEqual({ maxIterations: 4, numPredict: 512, temperature: 0.2 });
    expect(resolveModelTier(2.0)).toEqual({ maxIterations: 4, numPredict: 512, temperature: 0.2 });
  });

  it('>2B and ≤4B uses the medium tier (6 iterations, 1024 tokens, temp 0.3)', () => {
    expect(resolveModelTier(2.01)).toEqual({ maxIterations: 6, numPredict: 1024, temperature: 0.3 });
    expect(resolveModelTier(4)).toEqual({ maxIterations: 6, numPredict: 1024, temperature: 0.3 });
    expect(resolveModelTier(4.0)).toEqual({ maxIterations: 6, numPredict: 1024, temperature: 0.3 });
  });

  it('>4B uses the default tier (10 iterations, no cap, temp 0.7)', () => {
    expect(resolveModelTier(4.1)).toEqual({ maxIterations: 10, temperature: 0.7 });
    expect(resolveModelTier(9.7)).toEqual({ maxIterations: 10, temperature: 0.7 });
    expect(resolveModelTier(Number.POSITIVE_INFINITY)).toEqual({ maxIterations: 10, temperature: 0.7 });
  });
});
