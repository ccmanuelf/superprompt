/**
 * Theory of Constraints metrics — dual-view wrapper.
 * Delegates to pure functions in src/toc/.
 *
 * Single primary metric: calculateTocMetrics wraps analyzeTOC, which produces
 * the full TOC analysis bundle (constraint identification, throughput
 * accounting, DBR schedule, WIP gauges, five-focusing-steps narrative).
 */

import { analyzeTOC } from '../toc/analysis.js';
import type { TOCConfig, TOCAnalysis } from '../toc/models.js';
import type {
  AssumptionSet,
  CalculationMode,
  CalculationResult,
} from './types.js';

export type TocMetricInputs = TOCConfig;

export function calculateTocMetrics(
  inputs: TocMetricInputs,
  assumptions: AssumptionSet,
  mode: CalculationMode,
): CalculationResult<TOCAnalysis> {
  const value = analyzeTOC(inputs);

  return {
    value,
    mode,
    inputsUsed: {
      configName: inputs.name,
      workCenterCount: inputs.work_centers.length,
      demandUnitsPerDay: inputs.demand_units_per_day,
      sellingPricePerUnit: inputs.selling_price_per_unit,
      tvcPerUnit: inputs.total_variable_cost_per_unit,
      operatingExpense: inputs.operating_expense_per_period,
      investment: inputs.investment,
    },
    assumptionsApplied: Object.values(assumptions),
    computedAt: new Date().toISOString(),
  };
}
