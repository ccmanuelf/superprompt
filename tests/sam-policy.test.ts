/**
 * SA4 write-gate parity for SAM tools (spec 2026-07-17 §C) — the LOCAL-path
 * half of the relaxed write gate (parity checklist row C). sam_create and
 * sam_set_status are ordinary, reversible record writes: execute without
 * confirmation. sam_generate keeps its single confirmation — slow, costs
 * SAM-server credits, persists — the local-path equivalent of the
 * Claude-path generate heads-up, so BOTH paths confirm exactly once before
 * a credit-costing persist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBuiltinTools } from '../src/providers/tools/index.js';
import { getToolPolicy } from '../src/policy-engine.js';

describe('SAM SA4 policies (relaxed write gate, spec 2026-07-17 §C)', () => {
  beforeAll(() => {
    // Pure in-memory Map.set at registration time — no DB, no network
    // (same bootstrap as tests/local-buckets-registry.test.ts).
    registerBuiltinTools();
  });

  it('sam_create executes without confirmation', () => {
    expect(getToolPolicy('sam_create')?.requiresConfirmation).toBe(false);
  });

  it('sam_set_status executes without confirmation', () => {
    expect(getToolPolicy('sam_set_status')?.requiresConfirmation).toBe(false);
  });

  it('sam_generate KEEPS its confirmation (credit-costing persist)', () => {
    expect(getToolPolicy('sam_generate')?.requiresConfirmation).toBe(true);
  });

  it('sam reads stay unconfirmed', () => {
    for (const t of ['sam_search', 'sam_get_analysis', 'sam_export', 'sam_health']) {
      expect(getToolPolicy(t)?.requiresConfirmation, t).toBe(false);
    }
  });

  it('critical-risk tools are untouched by this spec (guardrail)', () => {
    expect(getToolPolicy('run_command')?.riskLevel).toBe('critical');
    expect(getToolPolicy('run_command')?.requiresConfirmation).toBe(true);
  });
});
