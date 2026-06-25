/**
 * Conformance pins for reference/heal-gate-contract.md. Each test maps to a
 * clause of the completion contract so the code cannot silently drift from the
 * documented values and invariants. Pure where possible; DB-backed where the
 * clause is about runtime behavior.
 */
import { describe, it, expect } from 'vitest';
import { HEAL_GATE, MAX_CONSECUTIVE_HEAL_REJECTS, MAX_EVAL_CASES_PER_SPLIT } from '../src/auto-skills.js';

describe('HEAL_GATE contract values', () => {
  it('pins the documented tunables', () => {
    expect(HEAL_GATE.MAX_CONSECUTIVE_REJECTS).toBe(3);
    expect(HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT).toBe(10);
    expect(HEAL_GATE.MIN_QUALITY_SCORE).toBe(70);
    expect(HEAL_GATE.BUDGET_MS).toBe(300_000);
  });

  it('keeps the legacy exported names pointed at the single source of truth', () => {
    expect(MAX_CONSECUTIVE_HEAL_REJECTS).toBe(HEAL_GATE.MAX_CONSECUTIVE_REJECTS);
    expect(MAX_EVAL_CASES_PER_SPLIT).toBe(HEAL_GATE.MAX_EVAL_CASES_PER_SPLIT);
  });
});
