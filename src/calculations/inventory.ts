/**
 * Inventory replenishment metrics — dual-view wrapper.
 * Delegates to pure functions in src/inventory.ts.
 */

import {
  calculateEOQ,
  calculateSafetyStock,
  calculateReorderPoint,
} from '../inventory.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export interface InventoryMetricInputs {
  annualDemand: number;
  orderCost: number;
  holdingCostPerUnit: number;
  dailyDemand: number;
  leadTimeDays: number;
  serviceLevel: number;
  demandStddev?: number;
}

export interface InventoryMetrics {
  eoq: number;
  safetyStock: number;
  reorderPoint: number;
}

export function calculateInventoryMetrics(
  inputs: InventoryMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<InventoryMetrics> {
  // Active hook (rc.102): in site_adjusted mode, when default_service_level
  // has been overridden in the registry (pack/user/global scope, not the
  // built-in default), use that value in place of the input. The standard
  // mode + the default-scope assumption both leave inputs.serviceLevel alone,
  // matching ROI's hurdle/horizon behavior.
  const slAssumption = assumptions['default_service_level'];
  const slOverridden =
    mode === 'site_adjusted'
    && slAssumption
    && slAssumption.sourceScope !== 'default'
    && typeof slAssumption.value === 'number'
    && slAssumption.value > 0
    && slAssumption.value < 1;
  const effectiveServiceLevel = slOverridden
    ? (slAssumption.value as number)
    : inputs.serviceLevel;

  const eoq = calculateEOQ(
    inputs.annualDemand,
    inputs.orderCost,
    inputs.holdingCostPerUnit,
  );
  const safetyStock = calculateSafetyStock(
    inputs.dailyDemand,
    inputs.leadTimeDays,
    effectiveServiceLevel,
    inputs.demandStddev,
  );
  const reorderPoint = calculateReorderPoint(
    inputs.dailyDemand,
    inputs.leadTimeDays,
    safetyStock,
  );

  return {
    value: { eoq, safetyStock, reorderPoint },
    mode,
    inputsUsed: {
      annualDemand: inputs.annualDemand,
      orderCost: inputs.orderCost,
      holdingCostPerUnit: inputs.holdingCostPerUnit,
      dailyDemand: inputs.dailyDemand,
      leadTimeDays: inputs.leadTimeDays,
      serviceLevel: effectiveServiceLevel,
      demandStddev: inputs.demandStddev ?? null,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
