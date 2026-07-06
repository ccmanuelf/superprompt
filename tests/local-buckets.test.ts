import { describe, it, expect } from 'vitest';
import {
  selectBucket, toolNamesForBucket, bucketForTool, CORE_TOOLS, BUCKET_TOOLS,
} from '../src/providers/local-buckets.js';

describe('bucket selection', () => {
  it('routes manufacturing vocabulary (EN) to manufacturing', () => {
    expect(selectBucket('show me the bom shortage for company 1054', undefined)).toBe('manufacturing');
  });
  it('routes manufacturing vocabulary (ES) to manufacturing', () => {
    expect(selectBucket('análisis de causa raíz del cuello de botella', undefined)).toBe('manufacturing');
  });
  it('routes simulation asks to simulation', () => {
    expect(selectBucket('run a production simulation with 3 cells', undefined)).toBe('simulation');
  });
  it('routes document asks (EN+ES) to docs', () => {
    expect(selectBucket('generate a PDF report of the results', undefined)).toBe('docs');
    expect(selectBucket('genera un reporte en xlsx', undefined)).toBe('docs');
  });
  it('routes github/render asks to devops', () => {
    expect(selectBucket('list my repos and open PRs', undefined)).toBe('devops');
  });
  it('hysteresis: no bucket match keeps the current bucket', () => {
    expect(selectBucket('ok thanks, continue', 'manufacturing')).toBe('manufacturing');
  });
  it('no match and no current bucket falls back to core', () => {
    expect(selectBucket('hola, buenos días', undefined)).toBe('core');
  });
  it('explicit different-bucket match switches buckets', () => {
    expect(selectBucket('now generate the docx summary', 'manufacturing')).toBe('docs');
  });
  it('specific-vocabulary buckets win over generic docs vocabulary after reorder', () => {
    expect(selectBucket('genera un reporte de capacidad', undefined)).toBe('manufacturing');
    expect(selectBucket('read this file from the repo and diff it', undefined)).toBe('devops');
  });
  it('bare "company" without plural/numeric/data context does not false-positive to manufacturing', () => {
    expect(selectBucket("let's start a company selling shoes", undefined)).toBe('core');
  });
  it('bare singular "issue" without verb/plural context does not false-positive to devops', () => {
    expect(selectBucket('I have an issue with my order', undefined)).toBe('core');
  });
});

describe('bucket tool lists', () => {
  it('toolNamesForBucket returns core ∪ bucket with no duplicates', () => {
    const names = toolNamesForBucket('manufacturing');
    expect(names).toEqual([...new Set(names)]);
    for (const t of CORE_TOOLS) expect(names).toContain(t);
    for (const t of BUCKET_TOOLS.manufacturing) expect(names).toContain(t);
  });
  it('core bucket returns only core tools', () => {
    expect(toolNamesForBucket('core')).toEqual(CORE_TOOLS);
  });
  it('bucketForTool reverse lookup works and core tools map to core', () => {
    expect(bucketForTool('production_simulation')).toBe('simulation');
    expect(bucketForTool('web_search')).toBe('core');
    expect(bucketForTool('nonexistent_tool')).toBeUndefined();
  });
  it('per-turn schema count target: core + largest bucket ≤ 22', () => {
    const counts = Object.keys(BUCKET_TOOLS).map((b) => toolNamesForBucket(b as never).length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(22);
  });
});
