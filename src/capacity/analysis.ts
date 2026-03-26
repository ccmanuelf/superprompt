/**
 * Capacity Planning — 12-Step Analysis Engine
 *
 * Pure functions implementing the capacity calculation methodology:
 * 1. Working days in period
 * 2. Shifts per day
 * 3. Hours per shift
 * 4. Gross hours = days × shifts × hours
 * 5. Apply efficiency factor
 * 6. Apply absenteeism factor
 * 7. Net hours = gross × efficiency × (1 - absenteeism)
 * 8. Capacity hours = net × operators
 * 9. Demand hours (from SAM or direct)
 * 10. Utilization % = demand / capacity × 100
 * 11. Identify bottlenecks
 * 12. Rank constraints
 *
 * Adapted from kpi-operations analysis_service.py.
 * No database dependencies — stateless calculations.
 */

import type {
  CapacityLine,
  CalendarConfig,
  DemandEntry,
  CapacityPlanConfig,
  LineCapacityResult,
  CapacityAnalysisResult,
  ConstraintRank,
  BottleneckSeverity,
  UtilizationHeatmap,
  HeatmapCell,
} from './models.js';

import {
  BOTTLENECK_THRESHOLD_CRITICAL,
  BOTTLENECK_THRESHOLD_WARNING,
} from './models.js';

// ── Core 12-Step Calculation ─────────────────────────────────

/**
 * Run the 12-step capacity analysis for a single line.
 */
export function analyzeLineCapacity(
  line: CapacityLine,
  calendar: CalendarConfig,
  demandHours: number,
  demandUnits: number,
): LineCapacityResult {
  // Steps 1-3: Calendar inputs
  const { working_days, shifts_per_day, hours_per_shift } = calendar;

  // Step 4: Gross hours
  const gross_hours = working_days * shifts_per_day * hours_per_shift;

  // Steps 5-6: Efficiency factors
  const efficiency = line.efficiency_factor;
  const absenteeism = line.absenteeism_factor;

  // Step 7: Net hours (apply efficiency and absenteeism)
  const net_hours = gross_hours * efficiency * (1 - absenteeism);

  // Step 8: Capacity hours (multiply by operators)
  const capacity_hours = net_hours * line.max_operators;

  // Step 9: Demand hours (passed in)
  const demand_hours = demandHours;

  // Step 10: Utilization %
  const utilization_pct = capacity_hours > 0
    ? (demand_hours / capacity_hours) * 100
    : 0;

  // Step 11: Bottleneck identification
  const severity = getBottleneckSeverity(utilization_pct);
  const is_bottleneck = utilization_pct >= BOTTLENECK_THRESHOLD_WARNING;

  // Available / over capacity
  const available_hours = Math.max(0, capacity_hours - demand_hours);
  const over_capacity_hours = Math.max(0, demand_hours - capacity_hours);

  return {
    line_id: line.id,
    line_code: line.code,
    line_name: line.name,
    department: line.department,
    working_days,
    shifts_per_day,
    hours_per_shift,
    operators_available: line.max_operators,
    efficiency_factor: efficiency,
    absenteeism_factor: absenteeism,
    gross_hours: round2(gross_hours),
    net_hours: round2(net_hours),
    capacity_hours: round2(capacity_hours),
    demand_hours: round2(demand_hours),
    demand_units: demandUnits,
    utilization_pct: round2(utilization_pct),
    available_hours: round2(available_hours),
    over_capacity_hours: round2(over_capacity_hours),
    is_bottleneck,
    bottleneck_severity: severity,
    capacity_units: line.standard_capacity_uph
      ? round2(capacity_hours * line.standard_capacity_uph)
      : undefined,
    throughput_rate_uph: line.standard_capacity_uph
      ? round2(line.standard_capacity_uph * efficiency * (1 - absenteeism))
      : undefined,
  };
}

/**
 * Run full capacity analysis for a plan configuration.
 */
export function analyzeCapacity(config: CapacityPlanConfig): CapacityAnalysisResult {
  const warnings: string[] = [];

  // Check for demands with no SAM/hours (quantity-only fallback)
  for (const d of config.demands) {
    if (d.quantity > 0 && (d.hours == null || d.hours <= 0) && (d.sam_minutes == null || d.sam_minutes <= 0)) {
      warnings.push(`"${d.product}" has quantity (${d.quantity}) but no SAM or hours — using estimate of 1 min/unit. Provide SAM for accurate results.`);
    }
  }

  // Aggregate demand per line
  const demandByLine = aggregateDemandByLine(config.demands);

  // Analyze each line
  const lineResults: LineCapacityResult[] = [];
  let totalCapacity = 0;
  let totalDemand = 0;
  let bottleneckCount = 0;

  for (const line of config.lines) {
    const lineDemand = demandByLine.get(line.id) ?? { hours: 0, units: 0 };
    const lineCalendar = line.calendar_override ?? config.calendar;
    const result = analyzeLineCapacity(
      line,
      lineCalendar,
      lineDemand.hours,
      lineDemand.units,
    );

    lineResults.push(result);
    totalCapacity += result.capacity_hours;
    totalDemand += result.demand_hours;
    if (result.is_bottleneck) bottleneckCount++;
  }

  // Overall utilization
  const overallUtilization = totalCapacity > 0
    ? (totalDemand / totalCapacity) * 100
    : 0;

  // Rank constraints
  const constraintRanking = rankConstraints(lineResults);

  return {
    plan_name: config.name,
    period_label: config.period_label,
    period_start: config.period_start,
    period_end: config.period_end,
    analysis_timestamp: new Date().toISOString(),
    lines_analyzed: lineResults.length,
    total_capacity_hours: round2(totalCapacity),
    total_demand_hours: round2(totalDemand),
    overall_utilization_pct: round2(overallUtilization),
    bottleneck_count: bottleneckCount,
    lines: lineResults,
    constraint_ranking: constraintRanking,
    warnings,
  };
}

// ── Demand Aggregation ───────────────────────────────────────

/**
 * Aggregate demand entries by line ID.
 * If SAM is provided, convert to hours: (quantity × sam_minutes) / 60
 * If direct hours provided, use those.
 */
export function aggregateDemandByLine(
  demands: DemandEntry[],
): Map<string, { hours: number; units: number }> {
  const map = new Map<string, { hours: number; units: number }>();

  for (const d of demands) {
    const existing = map.get(d.line_id) ?? { hours: 0, units: 0 };

    let hours = 0;
    if (d.hours != null && d.hours > 0) {
      hours = d.hours;
    } else if (d.sam_minutes != null && d.sam_minutes > 0) {
      hours = (d.quantity * d.sam_minutes) / 60;
    } else if (d.quantity > 0) {
      // Fallback: estimate 1 min/unit if no SAM or hours provided
      hours = d.quantity / 60;
    }

    existing.hours += hours;
    existing.units += d.quantity;
    map.set(d.line_id, existing);
  }

  return map;
}

// ── Constraint Ranking ───────────────────────────────────────

/**
 * Rank lines by utilization (descending) to identify constraints.
 */
export function rankConstraints(lines: LineCapacityResult[]): ConstraintRank[] {
  const sorted = [...lines]
    .filter((l) => l.utilization_pct > 0)
    .sort((a, b) => b.utilization_pct - a.utilization_pct);

  return sorted.map((line, i) => ({
    rank: i + 1,
    line_id: line.line_id,
    line_code: line.line_code,
    line_name: line.line_name,
    utilization_pct: line.utilization_pct,
    over_capacity_hours: line.over_capacity_hours,
    severity: line.bottleneck_severity,
    recommendation: generateRecommendation(line),
  }));
}

function generateRecommendation(line: LineCapacityResult): string {
  if (line.utilization_pct >= BOTTLENECK_THRESHOLD_CRITICAL) {
    const overHrs = line.over_capacity_hours;
    if (overHrs > 0) {
      return `Critical: ${round2(overHrs)}h over capacity. Consider overtime, additional shift, or subcontracting.`;
    }
    return 'Critical: near 100% utilization. Any disruption will cause delays.';
  }
  if (line.utilization_pct >= BOTTLENECK_THRESHOLD_WARNING) {
    return `Warning: ${round2(line.utilization_pct)}% utilized. Limited buffer for variability.`;
  }
  if (line.utilization_pct < 50) {
    return `Underutilized at ${round2(line.utilization_pct)}%. Consider consolidating or reassigning demand.`;
  }
  return `Healthy utilization at ${round2(line.utilization_pct)}%.`;
}

// ── Heatmap Generation ───────────────────────────────────────

/**
 * Generate utilization heatmap data for lines × time periods.
 * Splits the planning period into sub-periods (days or weeks) and calculates
 * utilization for each cell.
 *
 * @param demandWeights Optional array of weights per period (length must match periods).
 *   Values are relative — [1,1,2,1,1] means period 3 has double the demand.
 *   If not provided, demand is distributed evenly.
 */
export function generateUtilizationHeatmap(
  config: CapacityPlanConfig,
  periodsPerLine?: number,
  demandWeights?: number[],
): UtilizationHeatmap {
  const periods = periodsPerLine ?? Math.min(config.calendar.working_days, 10);
  const daysPerPeriod = Math.max(1, Math.floor(config.calendar.working_days / periods));

  // Normalize demand weights
  let weights: number[];
  if (demandWeights && demandWeights.length === periods) {
    const weightSum = demandWeights.reduce((s, w) => s + w, 0);
    weights = weightSum > 0 ? demandWeights.map((w) => w / weightSum) : Array(periods).fill(1 / periods);
  } else {
    weights = Array(periods).fill(1 / periods);
  }

  const rows = config.lines.map((l) => l.code);
  const columns: string[] = [];
  for (let i = 0; i < periods; i++) {
    columns.push(periods <= 7 ? `Day ${i + 1}` : `Period ${i + 1}`);
  }

  const demandByLine = aggregateDemandByLine(config.demands);
  const cells: HeatmapCell[] = [];

  for (const line of config.lines) {
    const lineDemand = demandByLine.get(line.id) ?? { hours: 0, units: 0 };
    const lineCalendar = line.calendar_override ?? config.calendar;

    for (let p = 0; p < periods; p++) {
      const demandPerPeriod = lineDemand.hours * weights[p];
      const periodCalendar: CalendarConfig = {
        working_days: daysPerPeriod,
        shifts_per_day: lineCalendar.shifts_per_day,
        hours_per_shift: lineCalendar.hours_per_shift,
      };

      const result = analyzeLineCapacity(line, periodCalendar, demandPerPeriod, 0);
      cells.push({
        line_id: line.id,
        line_code: line.code,
        period: columns[p],
        utilization_pct: result.utilization_pct,
        severity: result.bottleneck_severity,
      });
    }
  }

  return { rows, columns, cells };
}

// ── Helpers ──────────────────────────────────────────────────

export function getBottleneckSeverity(utilization: number): BottleneckSeverity {
  if (utilization >= BOTTLENECK_THRESHOLD_CRITICAL) return 'critical';
  if (utilization >= BOTTLENECK_THRESHOLD_WARNING) return 'warning';
  return 'ok';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
