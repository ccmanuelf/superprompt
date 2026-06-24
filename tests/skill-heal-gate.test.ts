/**
 * Skill self-healing validation gate — acceptance rule.
 *
 * Pure unit pins for the Self-Harness non-regression rule that decides whether
 * a candidate (AI-rewritten) skill prompt is promoted over the current one:
 *   promote iff Δ_in ≥ 0 ∧ Δ_out ≥ 0 ∧ max(Δ_in, Δ_out) > 0
 * where Δ is mean(candidate scores) − mean(current scores) per split, and an
 * empty split contributes Δ = 0 (no evidence either way).
 *
 * No DB, no LLM — this is the heart of opportunity A and must be deterministic.
 */

import { describe, it, expect } from 'vitest';
import { evaluateHealAcceptance } from '../src/auto-skills.js';

describe('evaluateHealAcceptance', () => {
  it('promotes a candidate that improves both splits', () => {
    const verdict = evaluateHealAcceptance(
      { heldIn: [50, 60], heldOut: [40] },
      { heldIn: [70, 80], heldOut: [55] },
    );
    expect(verdict.promote).toBe(true);
    expect(verdict.deltaIn).toBe(20);
    expect(verdict.deltaOut).toBe(15);
  });

  it('rejects a candidate that regresses the held-in split even if held-out improves', () => {
    const verdict = evaluateHealAcceptance(
      { heldIn: [80], heldOut: [40] },
      { heldIn: [60], heldOut: [90] },
    );
    expect(verdict.promote).toBe(false);
    expect(verdict.deltaIn).toBe(-20);
  });

  it('rejects a candidate that merely ties (no net improvement)', () => {
    const verdict = evaluateHealAcceptance(
      { heldIn: [70], heldOut: [50] },
      { heldIn: [70], heldOut: [50] },
    );
    expect(verdict.promote).toBe(false);
  });

  it('treats an empty held-out split as Δ_out = 0 and promotes on held-in gain', () => {
    const verdict = evaluateHealAcceptance(
      { heldIn: [50], heldOut: [] },
      { heldIn: [75], heldOut: [] },
    );
    expect(verdict.deltaOut).toBe(0);
    expect(verdict.promote).toBe(true);
  });

  it('rejects when there is no evidence at all (both splits empty)', () => {
    const verdict = evaluateHealAcceptance(
      { heldIn: [], heldOut: [] },
      { heldIn: [], heldOut: [] },
    );
    expect(verdict.deltaIn).toBe(0);
    expect(verdict.deltaOut).toBe(0);
    expect(verdict.promote).toBe(false);
  });

  it('records a structured reason for both promote and reject', () => {
    const promoted = evaluateHealAcceptance({ heldIn: [50], heldOut: [50] }, { heldIn: [60], heldOut: [50] });
    const rejected = evaluateHealAcceptance({ heldIn: [50], heldOut: [50] }, { heldIn: [40], heldOut: [50] });
    expect(promoted.reason).toMatch(/promote/i);
    expect(rejected.reason).toMatch(/reject/i);
  });
});
