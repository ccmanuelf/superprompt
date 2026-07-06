import { describe, it, expect } from 'vitest';
import { resolveLocalTurnConfig } from '../src/providers/router.js';

// resolveLocalTurnConfig is the pure core of the Ollama-branch wiring:
// (message, currentBucket, skillAllowedTools, deliverableIntent) → {bucket, allowedTools, systemPromptIsLocal}
describe('local turn config', () => {
  it('bucket tools flow into allowedTools when no narrowing applies', () => {
    const r = resolveLocalTurnConfig('run a capacity analysis for the line', undefined, undefined, { isDeliverable: false });
    expect(r.bucket).toBe('manufacturing');
    expect(r.allowedTools).toContain('capacity_planning');
    expect(r.allowedTools).toContain('web_search'); // core included
    expect(r.allowedTools).not.toContain('github_list_repos'); // other bucket excluded
  });
  it('deliverable narrowing beats bucket tools', () => {
    const r = resolveLocalTurnConfig('generate the pdf', 'manufacturing', undefined, { isDeliverable: true, allowedTools: ['parse_file', 'generate_document'] });
    expect(r.allowedTools).toEqual(['parse_file', 'generate_document']);
  });
  it('skill allowlist beats bucket tools', () => {
    const r = resolveLocalTurnConfig('hello', undefined, ['web_search'], { isDeliverable: false });
    expect(r.allowedTools).toEqual(['web_search']);
  });
  it('bucket persists (hysteresis) via returned bucket', () => {
    const r = resolveLocalTurnConfig('ok continue', 'simulation', undefined, { isDeliverable: false });
    expect(r.bucket).toBe('simulation');
  });
});
