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
 * Caller-supplied bag of resolved assumption values, keyed by assumption name.
 * In Phase 1 this is always `{}`. In Phase 3 the registry resolver populates
 * it at the handler boundary before invoking the calc function.
 */
export type AssumptionSet = Record<string, unknown>;

export interface CalculationResult<T> {
  value: T;
  mode: CalculationMode;
  inputsUsed: Record<string, unknown>;
  assumptionsApplied: AppliedAssumption[];
  computedAt: string;
}
