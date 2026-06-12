/**
 * Cross-Tool Bridges — Data converters between ClawMFG modules
 *
 * GAP #28: Capacity Planning → TOC
 * GAP #29: VSM → S16 Simulation
 */

import type { CapacityPlanConfig } from './capacity/models.js';
import type { TOCConfig, WorkCenter } from './toc/models.js';
import type { VSMConfig } from './vsm/models.js';
import type { SimulationConfig, OperationInput, ScheduleConfig, DemandInput } from './simulation/models.js';

// ── Capacity → TOC ──────────────────────────────────────────

/**
 * Convert a Capacity Plan configuration into a TOC configuration.
 * Maps capacity lines → work centers, and demand data → TOC demand.
 *
 * Requires additional economic parameters (selling price, TVC, OE, investment)
 * since Capacity Planning doesn't track financials.
 */
export function convertCapacityToTOC(
  capacityConfig: CapacityPlanConfig,
  economics: {
    selling_price_per_unit: number;
    total_variable_cost_per_unit: number;
    operating_expense_per_period: number;
    investment: number;
  },
): TOCConfig {
  const calendar = capacityConfig.calendar;

  // Convert capacity lines to work centers
  const work_centers: WorkCenter[] = capacityConfig.lines.map((line) => {
    const lineCalendar = line.calendar_override ?? calendar;

    // Estimate capacity_units_per_hour from demand and hours
    // If standard_capacity_uph is available, use it directly
    let capacityUPH = line.standard_capacity_uph ?? 0;

    if (capacityUPH === 0) {
      // Estimate from line parameters:
      // Net effective hours = available × efficiency × (1 - absenteeism)
      // Assume 1 unit per operator-minute as rough estimate
      capacityUPH = line.max_operators * line.efficiency_factor * (1 - line.absenteeism_factor) * 60;
    }

    return {
      id: line.id,
      name: line.name,
      department: line.department,
      capacity_units_per_hour: Math.round(capacityUPH),
      available_hours_per_day: lineCalendar.shifts_per_day * lineCalendar.hours_per_shift,
      operators: line.max_operators,
      current_wip: 0,
    };
  });

  // Sum demand across all lines to get total daily demand
  const totalDays = calendar.working_days || 1;
  const totalDemandUnits = capacityConfig.demands.reduce((s, d) => s + d.quantity, 0);
  const demandPerDay = Math.round(totalDemandUnits / totalDays);

  return {
    name: `TOC — ${capacityConfig.name}`,
    work_centers,
    selling_price_per_unit: economics.selling_price_per_unit,
    total_variable_cost_per_unit: economics.total_variable_cost_per_unit,
    operating_expense_per_period: economics.operating_expense_per_period,
    investment: economics.investment,
    demand_units_per_day: demandPerDay,
    available_hours_per_day: calendar.shifts_per_day * calendar.hours_per_shift,
  };
}

// ── VSM → S16 Simulation ────────────────────────────────────

/**
 * Convert a VSM configuration into an S16 Simulation configuration.
 * Maps VSM process steps → simulation operations, preserving cycle times,
 * changeover, and operator counts.
 */
export function convertVSMToSimulation(
  vsmConfig: VSMConfig,
): SimulationConfig {
  const sortedSteps = [...vsmConfig.steps].sort((a, b) => a.sequence - b.sequence);

  // Map VSM steps to simulation operations
  const operations: OperationInput[] = sortedSteps.map((step, idx) => ({
    product: vsmConfig.product_family || 'Product',
    step: idx + 1,
    operation: step.name,
    machine_tool: step.name.replace(/\s+/g, '_'),
    sam_min: step.cycle_time,
    operators: Math.max(1, step.operators),
    grade_pct: step.uptime_pct,
  }));

  // Changeover config from VSM steps with changeover_time > 0
  // (VSM has changeover per step, simulation has changeover between products)
  // Since VSM typically models a single product family, changeover is less relevant
  // but we preserve it as self-changeover for accuracy

  // Schedule from VSM available minutes
  const hoursPerDay = vsmConfig.available_minutes_per_day / 60;
  const schedule: ScheduleConfig = {
    shifts_enabled: 1,
    shift1_hours: Math.min(hoursPerDay, 12),
    shift2_hours: hoursPerDay > 12 ? hoursPerDay - 12 : 0,
    work_days: 5,
  };
  if (hoursPerDay > 12) {
    schedule.shifts_enabled = 2;
  }

  // Demand
  const demands: DemandInput[] = [{
    product: vsmConfig.product_family || 'Product',
    daily_demand: vsmConfig.customer_demand_per_day,
    bundle_size: 1,
  }];

  // Breakdown config from uptime < 100%
  const breakdowns = sortedSteps
    .filter((s) => s.uptime_pct < 100)
    .map((s) => ({
      machine_tool: s.name.replace(/\s+/g, '_'),
      breakdown_pct: 100 - s.uptime_pct,
    }));

  return {
    operations,
    schedule,
    demands,
    breakdowns: breakdowns.length > 0 ? breakdowns : undefined,
    mode: 'demand-driven',
    horizon_days: 1,
  };
}
