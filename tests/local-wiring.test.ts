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

  // fab-guard: a turn that is BOTH deliverable AND novalink-pinned must be able
  // to fetch real data, or the model fabricates a report with no disclosure
  // (novalinkToolStats stays undefined, the all-errored guard never fires).
  it('deliverable + novalink-pinned turn widens allowlist to include the novalink tools', () => {
    const r = resolveLocalTurnConfig(
      'genera un informe de faltantes de la compañía 1054',
      undefined,
      undefined,
      { isDeliverable: true, allowedTools: ['parse_file', 'read_file', 'generate_document'] },
    );
    expect(r.allowedTools).toEqual(
      expect.arrayContaining(['parse_file', 'read_file', 'generate_document', 'novalink_list_queries', 'novalink_query', 'novalink_health']),
    );
    expect(r.allowedTools).toHaveLength(6);
  });

  it('deliverable WITHOUT novalink intent leaves the deliverable trio unchanged', () => {
    const r = resolveLocalTurnConfig(
      'generate the pdf',
      undefined,
      undefined,
      { isDeliverable: true, allowedTools: ['parse_file', 'read_file', 'generate_document'] },
    );
    expect(r.allowedTools).toEqual(['parse_file', 'read_file', 'generate_document']);
  });

  it('novalink-pinned turn WITHOUT deliverable intent gets normal bucket tools, not the narrowed trio', () => {
    const r = resolveLocalTurnConfig(
      'revisa el bridge de novalink para faltantes de la compañía 1054',
      undefined,
      undefined,
      { isDeliverable: false },
    );
    expect(r.bucket).toBe('manufacturing');
    expect(r.allowedTools).toContain('novalink_query');
    expect(r.allowedTools).toContain('web_search'); // core still present — normal bucket tools, not narrowed
  });
});
