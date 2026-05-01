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
  _assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<InventoryMetrics> {
  const eoq = calculateEOQ(
    inputs.annualDemand,
    inputs.orderCost,
    inputs.holdingCostPerUnit,
  );
  const safetyStock = calculateSafetyStock(
    inputs.dailyDemand,
    inputs.leadTimeDays,
    inputs.serviceLevel,
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
      serviceLevel: inputs.serviceLevel,
      demandStddev: inputs.demandStddev ?? null,
    },
    assumptionsApplied: [],
    computedAt: new Date().toISOString(),
  };
}
