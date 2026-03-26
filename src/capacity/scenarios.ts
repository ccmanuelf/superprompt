/**
 * Capacity Planning — What-If Scenario Engine
 *
 * 8 pre-configured scenario types that modify the baseline capacity plan
 * and produce comparative analysis results.
 *
 * Each scenario applies parameter transformations to the base config,
 * runs the 12-step analysis, and computes deltas.
 */

import { analyzeCapacity } from './analysis.js';
import type {
  CapacityPlanConfig,
  CapacityLine,
  CalendarConfig,
  DemandEntry,
  ScenarioParams,
  ScenarioResult,
  ScenarioDelta,
  ScenarioComparison,
  CapacityAnalysisResult,
} from './models.js';
import { SCENARIO_DEFAULTS } from './models.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Run a what-if scenario against a baseline configuration.
 */
export function runScenario(
  baseConfig: CapacityPlanConfig,
  params: ScenarioParams,
): ScenarioResult {
  const baseline = analyzeCapacity(baseConfig);
  const modifiedConfig = applyScenario(baseConfig, params);
  const projected = analyzeCapacity(modifiedConfig);
  const delta = computeDelta(baseline, projected, params);

  return { scenario: params, baseline, projected, delta };
}

/**
 * Run multiple scenarios and compare them.
 */
export function compareScenarios(
  baseConfig: CapacityPlanConfig,
  scenarios: ScenarioParams[],
): ScenarioComparison {
  const baseline = analyzeCapacity(baseConfig);
  const results: ScenarioResult[] = [];

  for (const params of scenarios) {
    const modifiedConfig = applyScenario(baseConfig, params);
    const projected = analyzeCapacity(modifiedConfig);
    const delta = computeDelta(baseline, projected, params);
    results.push({ scenario: params, baseline, projected, delta });
  }

  // Find best scenario by cost-effectiveness (most units gained per $ spent)
  let bestName = scenarios[0]?.name ?? 'None';
  let bestEfficiency = -Infinity;

  for (const r of results) {
    if (r.delta.additional_cost > 0 && r.delta.additional_throughput_units > 0) {
      const efficiency = r.delta.additional_throughput_units / r.delta.additional_cost;
      if (efficiency > bestEfficiency) {
        bestEfficiency = efficiency;
        bestName = r.scenario.name;
      }
    } else if (r.delta.additional_throughput_units > 0 && r.delta.additional_cost === 0) {
      // Free capacity gain is always best
      bestName = r.scenario.name;
      bestEfficiency = Infinity;
    }
  }

  const bestResult = results.find((r) => r.scenario.name === bestName);
  const recommendation = bestResult
    ? `Best option: "${bestName}" — ${round2(bestResult.delta.capacity_hours_change_pct)}% capacity increase` +
      (bestResult.delta.additional_cost > 0
        ? ` at $${round2(bestResult.delta.cost_per_additional_unit)}/unit`
        : ' at no additional cost')
    : 'No viable scenarios identified.';

  return { baseline, scenarios: results, best_scenario: bestName, recommendation };
}

/**
 * Get default parameters for a scenario type.
 */
export function getScenarioDefaults(type: ScenarioParams['type']): Partial<ScenarioParams> {
  return { ...SCENARIO_DEFAULTS[type] };
}

// ── Scenario Application ─────────────────────────────────────

function applyScenario(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  switch (params.type) {
    case 'overtime':
      return applyOvertime(base, params);
    case 'setup_reduction':
      return applySetupReduction(base, params);
    case 'new_line':
      return applyNewLine(base, params);
    case 'three_shift':
      return applyThreeShift(base, params);
    case 'absenteeism_spike':
      return applyAbsenteeismSpike(base, params);
    case 'efficiency_improvement':
      return applyEfficiencyImprovement(base, params);
    case 'subcontract':
      return applySubcontract(base, params);
    case 'multi_constraint':
      return applyMultiConstraint(base, params);
    default:
      return base;
  }
}

/**
 * Overtime: increase available hours by overtime_pct.
 * Modeled as increasing hours_per_shift proportionally.
 */
function applyOvertime(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const otPct = (params.overtime_pct ?? 20) / 100;
  const affectedIds = new Set(params.affected_line_ids ?? []);
  const affectAll = affectedIds.size === 0;

  const newCalendar: CalendarConfig = {
    ...base.calendar,
    hours_per_shift: base.calendar.hours_per_shift * (1 + otPct),
  };

  // If targeting specific lines, we need per-line calendars
  // Since our model uses one calendar for all lines, we adjust efficiency as proxy
  if (!affectAll) {
    const lines = base.lines.map((l) => {
      if (affectedIds.has(l.id)) {
        // Model OT as increased operator-equivalent (more hours = more effective operators)
        return {
          ...l,
          max_operators: Math.ceil(l.max_operators * (1 + otPct)),
        };
      }
      return l;
    });
    return { ...base, lines };
  }

  return { ...base, calendar: newCalendar };
}

/**
 * Setup reduction: reduces demand hours by setup_reduction_pct × estimated setup portion (10%).
 */
function applySetupReduction(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const reductionPct = (params.setup_reduction_pct ?? 30) / 100;
  const setupPortion = 0.10; // Assume 10% of time is setup

  const demands = base.demands.map((d) => {
    const currentHours = d.hours ?? (d.sam_minutes ? (d.quantity * d.sam_minutes) / 60 : 0);
    const setupSaved = currentHours * setupPortion * reductionPct;
    return {
      ...d,
      hours: currentHours - setupSaved,
      sam_minutes: undefined as number | undefined, // Use direct hours
    };
  });

  return { ...base, demands };
}

/**
 * New line: add a new production line to the plan.
 */
function applyNewLine(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const newLine: CapacityLine = {
    id: params.new_line?.id ?? `new_${Date.now()}`,
    code: params.new_line?.code ?? 'NEW_LINE',
    name: params.new_line?.name ?? 'New Production Line',
    department: params.new_line?.department,
    max_operators: params.new_line?.max_operators ?? 10,
    efficiency_factor: params.new_line?.efficiency_factor ?? 0.75,
    absenteeism_factor: params.new_line?.absenteeism_factor ?? 0.05,
    standard_capacity_uph: params.new_line?.standard_capacity_uph,
  };

  // Redistribute demand from most overloaded line to new line
  const lines = [...base.lines, newLine];
  const demands = redistributeDemandToNewLine(base.demands, base.lines, newLine.id);

  return { ...base, lines, demands };
}

/**
 * Three-shift: increase shifts_per_day to 3.
 */
function applyThreeShift(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const targetShifts = params.target_shifts ?? 3;
  const nightEfficiency = params.night_shift_efficiency ?? 0.80;

  const newCalendar: CalendarConfig = {
    ...base.calendar,
    shifts_per_day: targetShifts,
  };

  // Reduce efficiency for additional shifts (night shift penalty)
  // Night shift efficiency is absolute (e.g., 0.80), not relative to the line's base.
  // Blend: (base_shifts × line_eff + additional_shifts × nightEfficiency) / total_shifts
  const additionalShifts = targetShifts - base.calendar.shifts_per_day;
  if (additionalShifts > 0) {
    const baseShiftCount = base.calendar.shifts_per_day;

    const lines = base.lines.map((l) => {
      const blendedEfficiency = (
        baseShiftCount * l.efficiency_factor + additionalShifts * nightEfficiency
      ) / targetShifts;
      return { ...l, efficiency_factor: Math.min(1.0, blendedEfficiency) };
    });
    return { ...base, calendar: newCalendar, lines };
  }

  return { ...base, calendar: newCalendar };
}

/**
 * Absenteeism spike: increase absenteeism factor.
 */
function applyAbsenteeismSpike(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const newAbsenteeism = params.absenteeism_new_pct ?? 0.15;
  const affectedIds = new Set(params.affected_line_ids ?? []);
  const affectAll = affectedIds.size === 0;

  const lines = base.lines.map((l) => {
    if (affectAll || affectedIds.has(l.id)) {
      return { ...l, absenteeism_factor: newAbsenteeism };
    }
    return l;
  });

  return { ...base, lines };
}

/**
 * Efficiency improvement: increase efficiency factor by N percentage points.
 */
function applyEfficiencyImprovement(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const improvement = params.efficiency_new_pct ?? 0.10;
  const affectedIds = new Set(params.affected_line_ids ?? []);
  const affectAll = affectedIds.size === 0;

  const lines = base.lines.map((l) => {
    if (affectAll || affectedIds.has(l.id)) {
      return {
        ...l,
        efficiency_factor: Math.min(1.0, l.efficiency_factor + improvement),
      };
    }
    return l;
  });

  return { ...base, lines };
}

/**
 * Subcontract: remove a percentage of demand from lines.
 */
function applySubcontract(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  const subPct = (params.subcontract_pct ?? 40) / 100;
  const affectedIds = new Set(params.affected_line_ids ?? []);
  const affectAll = affectedIds.size === 0;

  const demands = base.demands.map((d) => {
    if (affectAll || affectedIds.has(d.line_id)) {
      const reducedQty = Math.round(d.quantity * (1 - subPct));
      const currentHours = d.hours ?? (d.sam_minutes ? (d.quantity * d.sam_minutes) / 60 : 0);
      return {
        ...d,
        quantity: reducedQty,
        hours: currentHours * (1 - subPct),
        sam_minutes: undefined as number | undefined,
      };
    }
    return d;
  });

  return { ...base, demands };
}

/**
 * Multi-constraint: apply multiple sub-scenarios sequentially.
 */
function applyMultiConstraint(
  base: CapacityPlanConfig,
  params: ScenarioParams,
): CapacityPlanConfig {
  let config = base;
  for (const sub of params.sub_scenarios ?? []) {
    config = applyScenario(config, sub);
  }
  return config;
}

// ── Delta Computation ────────────────────────────────────────

function computeDelta(
  baseline: CapacityAnalysisResult,
  projected: CapacityAnalysisResult,
  params: ScenarioParams,
): ScenarioDelta {
  const capacityChange = projected.total_capacity_hours - baseline.total_capacity_hours;
  const capacityChangePct = baseline.total_capacity_hours > 0
    ? (capacityChange / baseline.total_capacity_hours) * 100
    : 0;

  const utilizationChange = projected.overall_utilization_pct - baseline.overall_utilization_pct;
  const bottlenecksResolved = Math.max(0, baseline.bottleneck_count - projected.bottleneck_count);
  const bottlenecksRemaining = projected.bottleneck_count;

  // Estimate additional cost based on scenario type
  const additionalCost = estimateAdditionalCost(baseline, params);

  // Estimate additional throughput
  const additionalThroughput = estimateAdditionalThroughput(baseline, projected);

  const costPerUnit = additionalThroughput > 0
    ? additionalCost / additionalThroughput
    : additionalCost > 0 ? Infinity : 0;

  return {
    capacity_hours_change: round2(capacityChange),
    capacity_hours_change_pct: round2(capacityChangePct),
    utilization_change_pct: round2(utilizationChange),
    bottlenecks_resolved: bottlenecksResolved,
    bottlenecks_remaining: bottlenecksRemaining,
    additional_cost: round2(additionalCost),
    additional_throughput_units: Math.round(additionalThroughput),
    cost_per_additional_unit: round2(costPerUnit),
  };
}

function estimateAdditionalCost(
  baseline: CapacityAnalysisResult,
  params: ScenarioParams,
): number {
  switch (params.type) {
    case 'overtime': {
      const otPct = (params.overtime_pct ?? 20) / 100;
      const additionalHours = baseline.total_capacity_hours * otPct;
      return additionalHours * (params.overtime_cost_per_hour ?? 15);
    }
    case 'three_shift': {
      const baseShifts = baseline.lines[0]?.shifts_per_day ?? 1;
      const additionalShifts = (params.target_shifts ?? 3) - baseShifts;
      // Rough estimate: labor cost for additional shifts
      return Math.max(0, additionalShifts) * baseline.total_capacity_hours * 12;
    }
    case 'subcontract': {
      const subPct = (params.subcontract_pct ?? 40) / 100;
      const totalUnits = baseline.lines.reduce((sum, l) => sum + l.demand_units, 0);
      return totalUnits * subPct * (params.subcontract_cost_per_unit ?? 2.50);
    }
    case 'new_line':
      return 50000; // Default investment for new line
    case 'setup_reduction':
      return 5000;  // Process improvement investment
    case 'efficiency_improvement':
      return 10000; // Training / tooling investment
    default:
      return 0;
  }
}

function estimateAdditionalThroughput(
  baseline: CapacityAnalysisResult,
  projected: CapacityAnalysisResult,
): number {
  // Sum of demand units gained across lines
  const baselineUnits = baseline.lines.reduce((s, l) => s + l.demand_units, 0);
  const projectedCapacityGain = projected.total_capacity_hours - baseline.total_capacity_hours;

  if (projectedCapacityGain <= 0) return 0;

  // Estimate units from additional capacity using average throughput rate
  const avgUnitsPerHour = baselineUnits > 0 && baseline.total_demand_hours > 0
    ? baselineUnits / baseline.total_demand_hours
    : 1;

  // Additional units = min(capacity gained × throughput rate, unmet demand)
  const unmetDemand = baseline.lines.reduce((s, l) => s + l.over_capacity_hours, 0) * avgUnitsPerHour;
  return Math.min(projectedCapacityGain * avgUnitsPerHour, unmetDemand > 0 ? unmetDemand : projectedCapacityGain * avgUnitsPerHour);
}

// ── Helpers ──────────────────────────────────────────────────

function redistributeDemandToNewLine(
  demands: DemandEntry[],
  existingLines: CapacityLine[],
  newLineId: string,
): DemandEntry[] {
  if (demands.length === 0 || existingLines.length === 0) return demands;

  // Find most loaded line (highest total demand hours)
  const demandByLine = new Map<string, number>();
  for (const d of demands) {
    const hours = d.hours ?? (d.sam_minutes ? (d.quantity * d.sam_minutes) / 60 : 0);
    demandByLine.set(d.line_id, (demandByLine.get(d.line_id) ?? 0) + hours);
  }

  let maxLineId = '';
  let maxHours = 0;
  for (const [lineId, hours] of Array.from(demandByLine)) {
    if (hours > maxHours) {
      maxHours = hours;
      maxLineId = lineId;
    }
  }

  if (!maxLineId) return demands;

  // Move 30% of the most loaded line's demand to the new line
  const result: DemandEntry[] = [];
  for (const d of demands) {
    if (d.line_id === maxLineId) {
      const transferQty = Math.round(d.quantity * 0.3);
      const remainQty = d.quantity - transferQty;
      const currentHours = d.hours ?? (d.sam_minutes ? (d.quantity * d.sam_minutes) / 60 : 0);

      result.push({
        ...d,
        quantity: remainQty,
        hours: currentHours * 0.7,
        sam_minutes: undefined,
      });
      result.push({
        ...d,
        line_id: newLineId,
        quantity: transferQty,
        hours: currentHours * 0.3,
        sam_minutes: undefined,
      });
    } else {
      result.push(d);
    }
  }

  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
