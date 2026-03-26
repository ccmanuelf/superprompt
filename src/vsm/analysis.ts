/**
 * Value Stream Mapping — Analysis Engine
 *
 * Pure functions for VSM calculations:
 * - Takt time
 * - Lead time breakdown (VA/NVA/wait/transport)
 * - PCE (Process Cycle Efficiency)
 * - TIMWOODS waste classification
 * - Current vs Future state comparison
 * - Waterfall data generation
 */

import type {
  VSMConfig,
  VSMAnalysis,
  VSMComparison,
  ImprovementMetric,
  LeadTimeBreakdown,
  TimewoodsBreakdown,
  WaterfallEntry,
  WasteType,
  ProcessStep,
} from './models.js';
import { TIMWOODS_LABELS, TIMWOODS_SUGGESTIONS } from './models.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Run full VSM analysis on a configuration.
 */
export function analyzeVSM(config: VSMConfig): VSMAnalysis {
  const warnings: string[] = [];

  const taktTime = config.available_minutes_per_day > 0 && config.customer_demand_per_day > 0
    ? config.available_minutes_per_day / config.customer_demand_per_day
    : 0;

  // GAP #10: Validate cycle times
  for (const step of config.steps) {
    if (step.cycle_time > 480) {
      warnings.push(`"${step.name}" has cycle time ${step.cycle_time} min (${(step.cycle_time / 60).toFixed(1)}h). If you meant seconds, divide by 60.`);
    }
  }

  const breakdown = computeLeadTimeBreakdown(config.steps);
  const waterfall = buildWaterfall(breakdown);
  const timwoods = classifyTimwoods(config);

  // Aggregate times
  let totalVA = 0, totalNVA = 0, totalBNVA = 0;
  let totalWait = 0, totalTransport = 0, totalChangeover = 0;

  for (const b of breakdown) {
    if (b.category === 'VA') totalVA += b.cycle_time;
    else if (b.category === 'NVA') totalNVA += b.cycle_time;
    else totalBNVA += b.cycle_time;
    totalWait += b.wait_time;
    totalTransport += b.transport_time;
    totalChangeover += b.changeover_per_unit;
  }

  const totalLeadTime = totalVA + totalNVA + totalBNVA + totalWait + totalTransport + totalChangeover;

  // PCE
  const pcePct = totalLeadTime > 0 ? (totalVA / totalLeadTime) * 100 : 0;

  // Inventory
  const totalWipUnits = config.steps.reduce((s, st) => s + (st.wip_before ?? 0), 0)
    + (config.inventory_points?.reduce((s, ip) => s + ip.quantity, 0) ?? 0);
  const totalWipDays = config.customer_demand_per_day > 0
    ? totalWipUnits / config.customer_demand_per_day
    : 0;

  // Operators
  const totalOperators = config.steps.reduce((s, st) => s + st.operators, 0);

  // Bottleneck: step with highest effective cycle time (C/T per operator)
  // operators=0 treated as automated station (use 1 for calculation)
  let bottleneckStep = '';
  let bottleneckCT = 0;
  for (const step of config.steps) {
    if (step.cycle_time <= 0) continue; // Skip zero-time steps
    const ops = Math.max(1, step.operators);
    const effectiveCT = step.cycle_time / ops;
    if (effectiveCT > bottleneckCT) {
      bottleneckCT = effectiveCT;
      bottleneckStep = step.name;
    }
  }

  return {
    map_name: config.name,
    state: config.state,
    takt_time: round2(taktTime),
    total_lead_time: round2(totalLeadTime),
    total_va_time: round2(totalVA),
    total_nva_time: round2(totalNVA),
    total_bnva_time: round2(totalBNVA),
    total_wait_time: round2(totalWait),
    total_transport_time: round2(totalTransport),
    total_changeover_time: round2(totalChangeover),
    pce_pct: round2(pcePct),
    lead_time_hours: round2(totalLeadTime / 60),
    lead_time_days: round2(totalLeadTime / 480), // 8h working day
    total_wip_units: totalWipUnits,
    total_wip_days: round2(totalWipDays),
    total_operators: totalOperators,
    bottleneck_step: bottleneckStep,
    bottleneck_cycle_time: round2(bottleneckCT),
    meets_takt: taktTime > 0 ? bottleneckCT <= taktTime : true,
    takt_gap_minutes: taktTime > 0 ? round2(taktTime - bottleneckCT) : 0,
    lead_time_breakdown: breakdown,
    timwoods,
    waterfall,
    warnings,
  };
}

/**
 * Compare current state vs future state VSM.
 */
export function compareStates(
  currentConfig: VSMConfig,
  futureConfig: VSMConfig,
): VSMComparison {
  const current = analyzeVSM({ ...currentConfig, state: 'current' });
  const future = analyzeVSM({ ...futureConfig, state: 'future' });

  const improvements: ImprovementMetric[] = [
    metric('Lead Time', current.total_lead_time, future.total_lead_time, 'min'),
    metric('VA Time', current.total_va_time, future.total_va_time, 'min'),
    metric('NVA Time', current.total_nva_time, future.total_nva_time, 'min'),
    metric('Wait Time', current.total_wait_time, future.total_wait_time, 'min'),
    metric('PCE', current.pce_pct, future.pce_pct, '%'),
    metric('WIP (units)', current.total_wip_units, future.total_wip_units, 'units'),
    metric('WIP (days)', current.total_wip_days, future.total_wip_days, 'days'),
    metric('Operators', current.total_operators, future.total_operators, 'people'),
    metric('Changeover', current.total_changeover_time, future.total_changeover_time, 'min'),
  ];

  const ltReduction = current.total_lead_time > 0
    ? ((current.total_lead_time - future.total_lead_time) / current.total_lead_time * 100)
    : 0;

  const summary = `Lead time reduced ${round2(ltReduction)}% ` +
    `(${round2(current.total_lead_time)} → ${round2(future.total_lead_time)} min). ` +
    `PCE improved from ${round2(current.pce_pct)}% to ${round2(future.pce_pct)}%. ` +
    `WIP reduced by ${round2(current.total_wip_units - future.total_wip_units)} units.`;

  return { current, future, improvements, summary };
}

// ── Lead Time Breakdown ──────────────────────────────────────

function computeLeadTimeBreakdown(steps: ProcessStep[]): LeadTimeBreakdown[] {
  const sorted = [...steps].sort((a, b) => a.sequence - b.sequence);

  return sorted.map((step) => {
    const batchSize = step.batch_size ?? 1;
    const changeoverPerUnit = batchSize > 0 ? step.changeover_time / batchSize : 0;
    const waitTime = step.wait_time ?? 0;
    const transportTime = step.transport_time ?? 0;
    const totalStepTime = step.cycle_time + waitTime + transportTime + changeoverPerUnit;

    return {
      step_id: step.id,
      step_name: step.name,
      category: step.category,
      cycle_time: round2(step.cycle_time),
      wait_time: round2(waitTime),
      transport_time: round2(transportTime),
      changeover_per_unit: round2(changeoverPerUnit),
      total_step_time: round2(totalStepTime),
    };
  });
}

// ── TIMWOODS Classification ──────────────────────────────────

export function classifyTimwoods(config: VSMConfig): TimewoodsBreakdown[] {
  const wasteMap = new Map<WasteType, { minutes: number; steps: string[] }>();

  // Initialize all waste types
  const allWastes: WasteType[] = [
    'transport', 'inventory', 'motion', 'waiting',
    'overproduction', 'overprocessing', 'defects', 'skills',
  ];
  for (const w of allWastes) {
    wasteMap.set(w, { minutes: 0, steps: [] });
  }

  for (const step of config.steps) {
    // Waiting: queue/wait time
    if ((step.wait_time ?? 0) > 0) {
      const entry = wasteMap.get('waiting')!;
      entry.minutes += step.wait_time!;
      entry.steps.push(step.name);
    }

    // Transport: transport time
    if ((step.transport_time ?? 0) > 0) {
      const entry = wasteMap.get('transport')!;
      entry.minutes += step.transport_time!;
      entry.steps.push(step.name);
    }

    // Inventory: WIP before step
    if ((step.wip_before ?? 0) > 0 && config.customer_demand_per_day > 0) {
      const entry = wasteMap.get('inventory')!;
      // Convert WIP to time: WIP × takt_time
      const takt = config.available_minutes_per_day / config.customer_demand_per_day;
      entry.minutes += step.wip_before! * takt;
      entry.steps.push(step.name);
    }

    // Overprocessing: changeover time
    if (step.changeover_time > 0) {
      const entry = wasteMap.get('overprocessing')!;
      const batchSize = step.batch_size ?? 1;
      entry.minutes += step.changeover_time / batchSize;
      entry.steps.push(step.name);
    }

    // Defects: uptime < 100 means downtime/rework
    if (step.uptime_pct < 100) {
      const entry = wasteMap.get('defects')!;
      const downtimePct = (100 - step.uptime_pct) / 100;
      entry.minutes += step.cycle_time * downtimePct;
      entry.steps.push(step.name);
    }

    // Explicit waste_types tagging
    if (step.waste_types) {
      for (const wt of step.waste_types) {
        const entry = wasteMap.get(wt)!;
        if (!entry.steps.includes(step.name)) {
          // NVA steps contribute their cycle time as waste
          if (step.category === 'NVA') {
            entry.minutes += step.cycle_time;
          }
          entry.steps.push(step.name);
        }
      }
    }
  }

  // Inventory points
  if (config.inventory_points) {
    for (const ip of config.inventory_points) {
      if (ip.quantity > 0 && config.customer_demand_per_day > 0) {
        const entry = wasteMap.get('inventory')!;
        const takt = config.available_minutes_per_day / config.customer_demand_per_day;
        entry.minutes += ip.quantity * takt;
        entry.steps.push(ip.name);
      }
    }
  }

  // Build total lead time for percentage
  const totalLead = config.steps.reduce((s, st) => {
    return s + st.cycle_time + (st.wait_time ?? 0) + (st.transport_time ?? 0) +
      (st.changeover_time / (st.batch_size ?? 1));
  }, 0);

  return Array.from(wasteMap.entries())
    .filter(([, v]) => v.minutes > 0 || v.steps.length > 0)
    .map(([type, v]) => ({
      waste_type: type,
      label: TIMWOODS_LABELS[type],
      total_minutes: round2(v.minutes),
      pct_of_lead_time: totalLead > 0 ? round2((v.minutes / totalLead) * 100) : 0,
      contributing_steps: Array.from(new Set(v.steps)),
      suggestion: TIMWOODS_SUGGESTIONS[type],
    }))
    .sort((a, b) => b.total_minutes - a.total_minutes);
}

// ── Waterfall Data ───────────────────────────────────────────

function buildWaterfall(breakdown: LeadTimeBreakdown[]): WaterfallEntry[] {
  let cumulative = 0;

  return breakdown.map((b) => {
    const vaMin = b.category === 'VA' ? b.cycle_time : 0;
    const nvaMin = b.category !== 'VA' ? b.cycle_time : 0;

    cumulative += b.total_step_time;

    return {
      label: b.step_name,
      va_minutes: round2(vaMin),
      nva_minutes: round2(nvaMin),
      wait_minutes: round2(b.wait_time),
      transport_minutes: round2(b.transport_time),
      cumulative: round2(cumulative),
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────

function metric(
  name: string,
  current: number,
  future: number,
  unit: string,
): ImprovementMetric {
  const change = future - current;
  const changePct = current !== 0 ? (change / current) * 100 : 0;
  return {
    metric: name,
    current_value: round2(current),
    future_value: round2(future),
    change: round2(change),
    change_pct: round2(changePct),
    unit,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
