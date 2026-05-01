/**
 * Dual-view calculation architecture — shared types.
 *
 * Phase 1: type shape only. The `assumptions` parameter is accepted but not
 * yet consumed; `assumptionsApplied` is always empty until Phase 2 lands the
 * registry. Both modes return identical results in Phase 1 — the mode
 * parameter exists so callers can be migrated now and the branching logic
 * lights up in Phase 3 without further signature churn.
 *
 * Spec: docs/audit/calculation-modules-audit.md
 */

export type CalculationMode = 'standard' | 'site_adjusted';

export type AssumptionScope = 'user' | 'pack' | 'global' | 'default';

export interface AppliedAssumption {
  name: string;
  value: unknown;
  sourceScope: AssumptionScope;
  rationale?: string;
}

/**
 * Caller-supplied bag of resolved assumptions, keyed by assumption name.
 * Each entry is a fully-resolved AppliedAssumption (value + sourceScope +
 * rationale + scopeId), built at the handler boundary by
 * buildAssumptionSnapshot() in src/assumptions.ts.
 *
 * In Phase 1 callers always passed `{}` — the empty object is still valid.
 * In Phase 3 callers populate this bag in `site_adjusted` mode; wrappers
 * surface every entry via CalculationResult.assumptionsApplied. Wrappers
 * that have a calculation-relevant hook for a particular assumption may
 * also read `assumptions[name].value` to influence the computation
 * (e.g., Sim Monte Carlo reads monte_carlo_default_iterations).
 */
export type AssumptionSet = Record<string, AppliedAssumption>;

export interface CalculationResult<T> {
  value: T;
  mode: CalculationMode;
  inputsUsed: Record<string, unknown>;
  assumptionsApplied: AppliedAssumption[];
  computedAt: string;
}
