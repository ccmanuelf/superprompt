/**
 * Theory of Constraints — Analysis Engine
 *
 * Implements Goldratt's TOC methodology:
 * 1. IDENTIFY the constraint (CCR)
 * 2. EXPLOIT the constraint (maximize its utilization)
 * 3. SUBORDINATE everything to the constraint (DBR)
 * 4. ELEVATE the constraint (if needed)
 * 5. Prevent INERTIA — repeat
 */

import type {
  TOCConfig,
  TOCAnalysis,
  ConstraintAnalysis,
  WorkCenterUtilization,
  ThroughputAccounting,
  DBRSchedule,
  BufferStatus,
  BufferConfig,
  BufferZone,
  WIPGauge,
  WIPStatus,
  RopeRelease,
} from './models.js';
import {
  BUFFER_GREEN_THRESHOLD,
  BUFFER_YELLOW_THRESHOLD,
  WIP_WARNING_THRESHOLD,
  WIP_CRITICAL_THRESHOLD,
} from './models.js';

// ── Public API ───────────────────────────────────────────────

export function analyzeTOC(config: TOCConfig): TOCAnalysis {
  const constraint = identifyConstraint(config);
  const warnings: string[] = [];
  if (config.demand_units_per_day <= 0) {
    warnings.push('Demand is 0 — all utilizations will be 0%. Enter a demand to get meaningful analysis.');
  }
  if (config.investment <= 0) {
    warnings.push('Investment is 0 — ROI cannot be computed.');
  }
  for (const wc of config.work_centers) {
    if (wc.capacity_units_per_hour <= 0) {
      warnings.push(`"${wc.name}" has 0 capacity — it is treated as an absolute constraint.`);
    }
  }

  const throughput = calculateThroughputAccounting(config, constraint);
  const dbr = buildDBRSchedule(config, constraint, throughput);
  const wipGauges = computeWIPGauges(config);
  const totalWip = wipGauges.reduce((s, g) => s + g.current_wip, 0);
  const focusingSteps = generateFocusingSteps(config, constraint, throughput);

  return {
    config_name: config.name,
    timestamp: new Date().toISOString(),
    constraint,
    throughput,
    dbr,
    wip_gauges: wipGauges,
    total_wip: totalWip,
    five_focusing_steps: focusingSteps,
    warnings,
  };
}

// ── Step 1: IDENTIFY the Constraint ──────────────────────────

export function identifyConstraint(config: TOCConfig): ConstraintAnalysis {
  const rankings: WorkCenterUtilization[] = [];

  for (const wc of config.work_centers) {
    const availableHours = wc.available_hours_per_day;
    let loadHours: number;
    let utilization: number;

    if (wc.capacity_units_per_hour <= 0 && config.demand_units_per_day > 0) {
      // Zero-capacity station with demand = absolute constraint
      loadHours = availableHours > 0 ? availableHours * 10 : 9999;
      utilization = 9999;
    } else if (config.demand_units_per_day > 0 && wc.capacity_units_per_hour > 0) {
      loadHours = config.demand_units_per_day / wc.capacity_units_per_hour;
      utilization = availableHours > 0 ? (loadHours / availableHours) * 100 : 0;
    } else {
      loadHours = 0;
      utilization = 0;
    }
    const excess = Math.max(0, availableHours - loadHours);

    rankings.push({
      id: wc.id,
      name: wc.name,
      capacity_per_hour: wc.capacity_units_per_hour,
      load_hours: round2(loadHours),
      available_hours: availableHours,
      utilization_pct: round2(utilization),
      is_ccr: false,
      excess_hours: round2(excess),
    });
  }

  // Sort by utilization descending — highest = constraint
  rankings.sort((a, b) => b.utilization_pct - a.utilization_pct);

  if (rankings.length > 0) {
    rankings[0].is_ccr = true;
  }

  const ccr = rankings[0];
  const maxThroughput = ccr
    ? ccr.capacity_per_hour * ccr.available_hours
    : 0;
  const demandCoverage = config.demand_units_per_day > 0
    ? Math.min(100, (maxThroughput / config.demand_units_per_day) * 100)
    : 100;

  return {
    ccr_id: ccr?.id ?? '',
    ccr_name: ccr?.name ?? 'None',
    ccr_utilization_pct: ccr?.utilization_pct ?? 0,
    ccr_load_hours: ccr?.load_hours ?? 0,
    ccr_available_hours: ccr?.available_hours ?? 0,
    ccr_excess_capacity_hours: ccr?.excess_hours ?? 0,
    work_center_ranking: rankings,
    max_system_throughput_per_day: round2(maxThroughput),
    demand_coverage_pct: round2(demandCoverage),
  };
}

// ── Throughput Accounting ────────────────────────────────────

export function calculateThroughputAccounting(
  config: TOCConfig,
  constraint: ConstraintAnalysis,
): ThroughputAccounting {
  const tPerUnit = config.selling_price_per_unit - config.total_variable_cost_per_unit;
  const actualUnitsPerDay = Math.min(config.demand_units_per_day, constraint.max_system_throughput_per_day);
  const tPerDay = tPerUnit * actualUnitsPerDay;
  const tPerPeriod = tPerDay * 22; // ~22 working days/month

  const oe = config.operating_expense_per_period;
  const np = tPerPeriod - oe;
  const investment = config.investment;
  const roiPct = investment > 0 ? (np / investment) * 100 : 0;
  const productivity = oe > 0 ? tPerPeriod / oe : 0;
  const investmentTurns = investment > 0 ? tPerPeriod / investment : 0;

  // Constraint economics
  const ccrWc = config.work_centers.find((wc) => wc.id === constraint.ccr_id);
  const constraintMinPerUnit = ccrWc && ccrWc.capacity_units_per_hour > 0
    ? 60 / ccrWc.capacity_units_per_hour
    : 0;
  const tPerConstraintMin = constraintMinPerUnit > 0 ? tPerUnit / constraintMinPerUnit : 0;
  const revenueLostPerHour = ccrWc
    ? ccrWc.capacity_units_per_hour * tPerUnit
    : 0;

  return {
    selling_price: config.selling_price_per_unit,
    tvc: config.total_variable_cost_per_unit,
    throughput_per_unit: round2(tPerUnit),
    throughput_per_day: round2(tPerDay),
    throughput_per_period: round2(tPerPeriod),
    operating_expense: oe,
    net_profit: round2(np),
    roi_pct: round2(roiPct),
    productivity: round2(productivity),
    investment_turns: round2(investmentTurns),
    throughput_per_constraint_minute: round2(tPerConstraintMin),
    constraint_utilization_pct: constraint.ccr_utilization_pct,
    revenue_lost_per_hour_constraint_down: round2(revenueLostPerHour),
  };
}

// ── Drum-Buffer-Rope ─────────────────────────────────────────

export function buildDBRSchedule(
  config: TOCConfig,
  constraint: ConstraintAnalysis,
  throughput: ThroughputAccounting,
): DBRSchedule {
  const ccrWc = config.work_centers.find((wc) => wc.id === constraint.ccr_id);
  const drumRate = ccrWc?.capacity_units_per_hour ?? 0;

  // Estimate total lead time through all work centers
  const totalProcessingHours = config.work_centers.reduce((s, wc) => {
    return s + (wc.capacity_units_per_hour > 0 ? 1 / wc.capacity_units_per_hour : 0);
  }, 0);
  const estimatedLeadTimeHours = totalProcessingHours * config.demand_units_per_day / (config.work_centers.length || 1);
  const leadTime = Math.max(estimatedLeadTimeHours, config.available_hours_per_day);

  // Buffer sizes: typically lead time / 3 for each buffer
  const defaultBufferHours = leadTime / 3;
  const shippingBufferSize = config.shipping_buffer_hours ?? defaultBufferHours;
  const constraintBufferSize = config.constraint_buffer_hours ?? defaultBufferHours;

  // Compute buffer consumption based on WIP
  const shippingBuffer = computeBufferStatus({
    id: 'shipping',
    name: 'Shipping Buffer',
    buffer_type: 'time',
    total_size: shippingBufferSize,
    current_consumption: estimateBufferConsumption(config, 'shipping'),
    unit: 'hours',
  });

  const constraintBuffer = computeBufferStatus({
    id: 'constraint',
    name: 'Constraint Buffer',
    buffer_type: 'time',
    total_size: constraintBufferSize,
    current_consumption: estimateBufferConsumption(config, 'constraint'),
    unit: 'hours',
  });

  // Assembly buffer: protects assembly operations downstream of constraint
  const assemblyBufferSize = config.assembly_buffer_hours ?? defaultBufferHours;
  const assemblyBuffer = computeBufferStatus({
    id: 'assembly',
    name: 'Assembly Buffer',
    buffer_type: 'time',
    total_size: assemblyBufferSize,
    current_consumption: estimateBufferConsumption(config, 'assembly'),
    unit: 'hours',
  });

  // Rope releases: when to release work into the system
  const ropeReleases = computeRopeReleases(config, constraint, drumRate);

  const plannedThroughput = Math.min(
    drumRate * config.available_hours_per_day,
    config.demand_units_per_day,
  );

  return {
    drum_rate: round2(drumRate),
    drum_work_center: constraint.ccr_name,
    shipping_buffer: shippingBuffer,
    constraint_buffer: constraintBuffer,
    assembly_buffer: assemblyBuffer,
    rope_releases: ropeReleases,
    planned_throughput_per_day: round2(plannedThroughput),
    lead_time_hours: round2(leadTime),
  };
}

// ── Buffer Management ────────────────────────────────────────

export function computeBufferStatus(buffer: BufferConfig): BufferStatus {
  const remaining = Math.max(0, buffer.total_size - buffer.current_consumption);
  const consumptionPct = buffer.total_size > 0
    ? (buffer.current_consumption / buffer.total_size) * 100
    : 0;

  const zone = getBufferZone(consumptionPct);
  const action = getBufferAction(zone, buffer.buffer_type);

  return {
    id: buffer.id,
    name: buffer.name,
    buffer_type: buffer.buffer_type,
    total_size: round2(buffer.total_size),
    consumed: round2(buffer.current_consumption),
    remaining: round2(remaining),
    consumption_pct: round2(consumptionPct),
    zone,
    action,
  };
}

function getBufferZone(consumptionPct: number): BufferZone {
  if (consumptionPct <= BUFFER_GREEN_THRESHOLD) return 'green';
  if (consumptionPct <= BUFFER_YELLOW_THRESHOLD) return 'yellow';
  return 'red';
}

function getBufferAction(zone: BufferZone, type: string): string {
  switch (zone) {
    case 'green':
      return 'Normal operation. No action needed.';
    case 'yellow':
      return `Monitor closely. ${type === 'time' ? 'Expedite if trend continues.' : 'Prepare to replenish.'}`;
    case 'red':
      return `Immediate action required! ${type === 'time' ? 'Expedite orders, assign overtime to upstream.' : 'Emergency replenishment, escalate to management.'}`;
  }
}

function estimateBufferConsumption(config: TOCConfig, bufferType: string): number {
  // Estimate based on WIP levels — higher WIP = more buffer consumed
  const totalWip = config.work_centers.reduce((s, wc) => s + wc.current_wip, 0);
  const totalCapacity = config.work_centers.reduce((s, wc) => s + wc.capacity_units_per_hour, 0);
  const wipHours = totalCapacity > 0 ? totalWip / totalCapacity : 0;

  if (bufferType === 'constraint') {
    // Constraint buffer: WIP before constraint (CCR = highest utilization)
    let maxUtil = 0;
    let ccrIdx = 0;
    for (let i = 0; i < config.work_centers.length; i++) {
      const wc = config.work_centers[i];
      const util = wc.available_hours_per_day > 0 && wc.capacity_units_per_hour > 0
        ? (config.demand_units_per_day / wc.capacity_units_per_hour) / wc.available_hours_per_day
        : 0;
      if (util > maxUtil) { maxUtil = util; ccrIdx = i; }
    }
    const wipBefore = config.work_centers.slice(0, Math.max(1, ccrIdx))
      .reduce((s, wc) => s + wc.current_wip, 0);
    return totalCapacity > 0 ? wipBefore / totalCapacity : 0;
  }

  if (bufferType === 'assembly') {
    // Assembly buffer: WIP after constraint (downstream of CCR)
    let maxUtil = 0;
    let ccrIdx = config.work_centers.length - 1;
    for (let i = 0; i < config.work_centers.length; i++) {
      const wc = config.work_centers[i];
      const util = wc.available_hours_per_day > 0 && wc.capacity_units_per_hour > 0
        ? (config.demand_units_per_day / wc.capacity_units_per_hour) / wc.available_hours_per_day
        : 0;
      if (util > maxUtil) { maxUtil = util; ccrIdx = i; }
    }
    const wipAfter = config.work_centers.slice(ccrIdx + 1)
      .reduce((s, wc) => s + wc.current_wip, 0);
    return totalCapacity > 0 ? wipAfter / totalCapacity : 0;
  }

  return wipHours * 0.5; // Shipping buffer: 50% of total WIP time
}

// ── Rope Release ─────────────────────────────────────────────

function computeRopeReleases(
  config: TOCConfig,
  constraint: ConstraintAnalysis,
  drumRate: number,
): RopeRelease[] {
  if (drumRate <= 0 || config.work_centers.length === 0) return [];

  const releases: RopeRelease[] = [];
  const batchSize = Math.ceil(drumRate); // 1-hour batches
  const numBatches = Math.ceil(config.available_hours_per_day);

  // First work center = material release point
  const firstWC = config.work_centers[0];

  // Lead time from first WC to constraint
  const ccrIdx = config.work_centers.findIndex((wc) => wc.id === constraint.ccr_id);
  const stationsBeforeCCR = Math.max(1, ccrIdx);
  const leadTimeToConstraint = stationsBeforeCCR * 0.5; // ~30 min per station buffer

  for (let i = 0; i < Math.min(numBatches, 10); i++) {
    const releaseTime = i + leadTimeToConstraint;
    releases.push({
      sequence: i + 1,
      release_time_hours: round2(releaseTime),
      work_center_id: firstWC.id,
      work_center_name: firstWC.name,
      units: batchSize,
      notes: i === 0 ? 'First release — prime the system' : `Batch ${i + 1} — paced to drum`,
    });
  }

  return releases;
}

// ── WIP Gauges ───────────────────────────────────────────────

export function computeWIPGauges(config: TOCConfig): WIPGauge[] {
  return config.work_centers.map((wc) => {
    const limit = wc.wip_limit ?? Math.ceil(wc.capacity_units_per_hour * wc.available_hours_per_day * 0.5);
    const utilizationPct = limit > 0 ? (wc.current_wip / limit) * 100 : 0;
    const hoursOfWork = wc.capacity_units_per_hour > 0
      ? wc.current_wip / wc.capacity_units_per_hour
      : 0;

    let status: WIPStatus = 'ok';
    if (utilizationPct >= WIP_CRITICAL_THRESHOLD) status = 'critical';
    else if (utilizationPct >= WIP_WARNING_THRESHOLD) status = 'warning';

    return {
      work_center_id: wc.id,
      work_center_name: wc.name,
      current_wip: wc.current_wip,
      wip_limit: limit,
      utilization_pct: round2(utilizationPct),
      status,
      hours_of_work: round2(hoursOfWork),
    };
  });
}

// ── Five Focusing Steps ──────────────────────────────────────

function generateFocusingSteps(
  config: TOCConfig,
  constraint: ConstraintAnalysis,
  throughput: ThroughputAccounting,
): string[] {
  const steps: string[] = [];

  // Step 1: IDENTIFY
  steps.push(`1. IDENTIFY: The constraint is "${constraint.ccr_name}" at ${constraint.ccr_utilization_pct.toFixed(1)}% utilization (${constraint.ccr_load_hours.toFixed(1)}h load / ${constraint.ccr_available_hours}h available).`);

  // Step 2: EXPLOIT
  if (constraint.ccr_utilization_pct < 100) {
    steps.push(`2. EXPLOIT: ${constraint.ccr_name} has ${constraint.ccr_excess_capacity_hours.toFixed(1)}h excess capacity. Ensure zero idle time — stagger breaks, preventive maintenance off-shift, quality checks before constraint.`);
  } else {
    steps.push(`2. EXPLOIT: ${constraint.ccr_name} is at capacity. Ensure zero waste — no rework, no unnecessary changeovers, dedicated quality check upstream.`);
  }

  // Step 3: SUBORDINATE
  const nonCcrWCs = constraint.work_center_ranking.filter((wc) => !wc.is_ccr);
  if (nonCcrWCs.length > 0) {
    const lowestUtil = nonCcrWCs[nonCcrWCs.length - 1];
    steps.push(`3. SUBORDINATE: All non-constraint stations must pace to the drum (${constraint.ccr_name}). ${lowestUtil.name} is at ${lowestUtil.utilization_pct.toFixed(0)}% — do NOT push it faster than the constraint.`);
  }

  // Step 4: ELEVATE
  if (constraint.demand_coverage_pct < 100) {
    const gap = config.demand_units_per_day - constraint.max_system_throughput_per_day;
    steps.push(`4. ELEVATE: Demand exceeds capacity by ${gap.toFixed(0)} units/day. Consider: overtime at constraint, add equipment, subcontract, or reduce demand. Revenue lost: $${throughput.revenue_lost_per_hour_constraint_down.toFixed(0)}/hr of constraint downtime.`);
  } else {
    steps.push(`4. ELEVATE: Current capacity meets demand. No elevation needed unless demand increases. Monitor for constraint shift.`);
  }

  // Step 5: INERTIA
  steps.push(`5. REPEAT: After any change, re-identify the constraint. It may shift to a different work center.`);

  return steps;
}

// ── Helpers ──────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
