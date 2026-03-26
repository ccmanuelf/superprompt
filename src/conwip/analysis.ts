/**
 * CONWIP & Heijunka — Analysis Engine
 */

import type {
  CONWIPConfig,
  CONWIPAnalysis,
  CONWIPToken,
  StageUtilization,
  TokenFlowTimeSeries,
  TokenFlowSnapshot,
  HeijunkaConfig,
  HeijunkaAnalysis,
  HeijunkaBox,
  HeijunkaSlot,
  ProductMix,
  ShiftPlan,
  ProductType,
} from './models.js';
import { PRODUCT_COLORS } from './models.js';

// ── CONWIP Analysis ──────────────────────────────────────────

export function analyzeCONWIP(config: CONWIPConfig): CONWIPAnalysis {
  const tokens = distributeTokens(config);
  const stageUtil = computeStageUtilization(config, tokens);

  // Throughput = limited by bottleneck
  const bottleneck = stageUtil.reduce((min, s) => s.utilization_pct > min.utilization_pct ? s : min, stageUtil[0]);
  const bottleneckStage = config.stages.find((s) => s.id === bottleneck?.stage_id);
  const throughputPerHour = bottleneckStage?.capacity_per_hour ?? 0;

  // Average cycle time through all stages
  const totalCycleTime = config.stages.reduce((s, st) => s + st.cycle_time_minutes, 0);

  // WIP turns = throughput × available_time / WIP
  const dailyThroughput = throughputPerHour * (config.available_minutes_per_day / 60);
  const wipTurns = config.wip_limit > 0 ? dailyThroughput / config.wip_limit : 0;

  const recommendations = generateCONWIPRecommendations(config, stageUtil, throughputPerHour);

  return {
    config_name: config.name,
    wip_limit: config.wip_limit,
    tokens,
    stage_utilization: stageUtil,
    throughput_per_hour: round2(throughputPerHour),
    avg_cycle_time: round2(totalCycleTime),
    wip_turns_per_day: round2(wipTurns),
    recommendations,
  };
}

function distributeTokens(config: CONWIPConfig): CONWIPToken[] {
  const tokens: CONWIPToken[] = [];
  const sortedStages = [...config.stages].sort((a, b) => a.sequence - b.sequence);

  // Distribute WIP tokens proportionally based on cycle times
  const totalCT = sortedStages.reduce((s, st) => s + st.cycle_time_minutes, 0);

  let tokenId = 0;
  let remaining = config.wip_limit;

  for (const stage of sortedStages) {
    const proportion = totalCT > 0 ? stage.cycle_time_minutes / totalCT : 1 / sortedStages.length;
    const stageTokens = Math.max(1, Math.round(config.wip_limit * proportion));
    const actual = Math.min(stageTokens, remaining);

    for (let i = 0; i < actual; i++) {
      const product = config.products.length > 0
        ? config.products[tokenId % config.products.length]
        : undefined;
      tokens.push({
        id: `token_${++tokenId}`,
        product_id: product?.id ?? 'default',
        product_name: product?.name ?? 'Product',
        current_stage_id: stage.id,
        current_stage_name: stage.name,
        entered_at: i * stage.cycle_time_minutes,
        status: i === 0 ? 'processing' : 'queued',
      });
      remaining--;
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }

  return tokens;
}

function computeStageUtilization(config: CONWIPConfig, tokens: CONWIPToken[]): StageUtilization[] {
  const sortedStages = [...config.stages].sort((a, b) => a.sequence - b.sequence);

  const utils = sortedStages.map((stage) => {
    const stageTokens = tokens.filter((t) => t.current_stage_id === stage.id).length;
    // Utilization based on demand load vs capacity
    const loadHours = config.demand_per_day > 0 && stage.capacity_per_hour > 0
      ? config.demand_per_day / stage.capacity_per_hour
      : 0;
    const availableHours = config.available_minutes_per_day / 60;
    const utilPct = availableHours > 0 ? (loadHours / availableHours) * 100 : 0;

    return {
      stage_id: stage.id,
      stage_name: stage.name,
      wip_count: stageTokens,
      utilization_pct: round2(utilPct),
      is_bottleneck: false,
    };
  });

  // Mark highest utilization as bottleneck
  if (utils.length > 0) {
    const maxUtil = Math.max(...utils.map((u) => u.utilization_pct));
    const bn = utils.find((u) => u.utilization_pct === maxUtil);
    if (bn) bn.is_bottleneck = true;
  }

  return utils;
}

function generateCONWIPRecommendations(
  config: CONWIPConfig,
  stageUtil: StageUtilization[],
  throughput: number,
): string[] {
  const recs: string[] = [];

  const bottleneck = stageUtil.find((s) => s.is_bottleneck);
  if (bottleneck && bottleneck.utilization_pct > 95) {
    recs.push(`Bottleneck at ${bottleneck.stage_name} (${bottleneck.utilization_pct.toFixed(0)}%). Consider adding capacity or reducing demand.`);
  }

  const dailyCapacity = throughput * (config.available_minutes_per_day / 60);
  if (dailyCapacity < config.demand_per_day) {
    recs.push(`System capacity (${dailyCapacity.toFixed(0)} u/day) < demand (${config.demand_per_day} u/day). Increase WIP limit or add capacity at bottleneck.`);
  }

  // WIP vs demand sanity check
  if (config.demand_per_day > 0 && config.wip_limit > config.demand_per_day) {
    recs.push(`WIP limit (${config.wip_limit}) exceeds daily demand (${config.demand_per_day}). This means more than a full day's demand is in the system at once — consider reducing WIP.`);
  }

  // Little's Law: WIP = Throughput × Lead Time
  const totalCT = config.stages.reduce((s, st) => s + st.cycle_time_minutes, 0);
  const optimalWIP = Math.ceil(throughput * (totalCT / 60));
  if (config.wip_limit > optimalWIP * 2) {
    recs.push(`WIP limit (${config.wip_limit}) may be too high. Little's Law suggests ~${optimalWIP} for current throughput. Excess WIP increases lead time.`);
  } else if (config.wip_limit < optimalWIP * 0.5 && optimalWIP > 0) {
    recs.push(`WIP limit (${config.wip_limit}) may be too low. Consider increasing to ~${optimalWIP} to avoid starvation.`);
  }

  if (recs.length === 0) {
    recs.push('System is balanced. Monitor for demand changes or equipment degradation.');
  }

  return recs;
}

// ── CONWIP Token Flow Simulation ──────────────────────────────

/**
 * Simulate token flow through stages over time, producing snapshots
 * at regular intervals for animation/trending.
 *
 * Simple model: tokens advance from stage to stage based on cycle time.
 * When a token completes the last stage, it re-enters the first stage
 * (CONWIP pull — constant WIP).
 */
export function simulateTokenFlow(
  config: CONWIPConfig,
  intervalMinutes: number = 5,
): TokenFlowTimeSeries {
  const sortedStages = [...config.stages].sort((a, b) => a.sequence - b.sequence);
  if (sortedStages.length === 0 || config.wip_limit <= 0) {
    return { snapshots: [], total_completed: 0, interval_minutes: intervalMinutes };
  }

  const totalMinutes = config.available_minutes_per_day;
  const numSnapshots = Math.ceil(totalMinutes / intervalMinutes);

  // Initialize tokens: spread across first stage
  const tokenPositions: Array<{ stageIdx: number; timeRemaining: number }> = [];
  for (let i = 0; i < config.wip_limit; i++) {
    const stageIdx = i % sortedStages.length;
    tokenPositions.push({
      stageIdx,
      timeRemaining: sortedStages[stageIdx].cycle_time_minutes * Math.random(),
    });
  }

  const snapshots: TokenFlowSnapshot[] = [];
  let completed = 0;

  for (let t = 0; t <= numSnapshots; t++) {
    const currentTime = t * intervalMinutes;

    // Take snapshot
    const stageWip: Record<string, number> = {};
    for (const stage of sortedStages) stageWip[stage.id] = 0;
    for (const token of tokenPositions) {
      const stageId = sortedStages[token.stageIdx]?.id;
      if (stageId) stageWip[stageId] = (stageWip[stageId] ?? 0) + 1;
    }
    const totalWip = tokenPositions.length;
    snapshots.push({ time_minutes: currentTime, stage_wip: stageWip, total_wip: totalWip, completed_units: completed });

    // Advance tokens by intervalMinutes
    for (const token of tokenPositions) {
      token.timeRemaining -= intervalMinutes;
      while (token.timeRemaining <= 0) {
        token.stageIdx++;
        if (token.stageIdx >= sortedStages.length) {
          // Completed — re-enter first stage (CONWIP pull)
          completed++;
          token.stageIdx = 0;
        }
        token.timeRemaining += sortedStages[token.stageIdx].cycle_time_minutes;
      }
    }
  }

  return { snapshots, total_completed: completed, interval_minutes: intervalMinutes };
}

// ── Heijunka Analysis ────────────────────────────────────────

export function analyzeHeijunka(config: HeijunkaConfig): HeijunkaAnalysis {
  if (config.products.length === 0) {
    return {
      config_name: config.name, takt_time: config.takt_time_minutes, pitch: config.pitch_minutes,
      heijunka_box: { products: [], slots: [], cells: [], shifts: 0 },
      leveling_score: 100, ideal_mix: [], actual_mix: [], changeover_count: 0,
      total_changeover_minutes: 0, changeover_suggestions: ['No products defined.'], shift_plans: [],
    };
  }
  const heijunkaBox = buildHeijunkaBox(config);
  const { idealMix, actualMix } = computeMixDeviation(config, heijunkaBox);
  const levelingScore = computeLevelingScore(idealMix, actualMix);
  const { changeovers, changeoverMinutes, suggestions } = analyzeChangeovers(config, heijunkaBox);
  const shiftPlans = buildShiftPlans(config, heijunkaBox);

  return {
    config_name: config.name,
    takt_time: config.takt_time_minutes,
    pitch: config.pitch_minutes,
    heijunka_box: heijunkaBox,
    leveling_score: round2(levelingScore),
    ideal_mix: idealMix,
    actual_mix: actualMix,
    changeover_count: changeovers,
    total_changeover_minutes: round2(changeoverMinutes),
    changeover_suggestions: suggestions,
    shift_plans: shiftPlans,
  };
}

function buildHeijunkaBox(config: HeijunkaConfig): HeijunkaBox {
  const totalSlots = config.slots_per_shift * config.shifts_per_day;
  const products = config.products.map((p) => p.name);
  const slots: string[] = [];
  const cells: HeijunkaSlot[] = [];

  // Generate slot labels
  for (let shift = 1; shift <= config.shifts_per_day; shift++) {
    for (let slot = 1; slot <= config.slots_per_shift; slot++) {
      slots.push(`S${shift}-${slot}`);
    }
  }

  // Distribute products across slots based on mix %
  // Use the "every nth" pattern for leveling
  const productSlotCounts = config.products.map((p) => ({
    product: p,
    targetSlots: Math.round((p.mix_pct / 100) * totalSlots),
    assigned: 0,
  }));

  // Sort by target (highest first) for greedy assignment
  productSlotCounts.sort((a, b) => b.targetSlots - a.targetSlots);

  // Build assignment using interleaving pattern
  const slotAssignments: Array<{ product: ProductType; shift: number; slot: number }> = [];
  let slotIdx = 0;

  for (const psc of productSlotCounts) {
    const interval = psc.targetSlots > 0 ? totalSlots / psc.targetSlots : totalSlots + 1;
    for (let i = 0; i < psc.targetSlots && slotIdx < totalSlots; i++) {
      const targetPos = Math.round(i * interval) % totalSlots;
      // Find nearest unassigned slot
      let pos = targetPos;
      let tries = 0;
      while (slotAssignments[pos] && tries < totalSlots) {
        pos = (pos + 1) % totalSlots;
        tries++;
      }
      if (!slotAssignments[pos]) {
        const shift = Math.floor(pos / config.slots_per_shift) + 1;
        const slotInShift = (pos % config.slots_per_shift) + 1;
        slotAssignments[pos] = { product: psc.product, shift, slot: slotInShift };
        psc.assigned++;
      }
    }
  }

  // Fill any remaining empty slots with the highest-mix product
  const fallback = productSlotCounts[0]?.product ?? config.products[0];
  for (let i = 0; i < totalSlots; i++) {
    if (!slotAssignments[i]) {
      const shift = Math.floor(i / config.slots_per_shift) + 1;
      const slotInShift = (i % config.slots_per_shift) + 1;
      slotAssignments[i] = { product: fallback, shift, slot: slotInShift };
    }
  }

  // Build cells
  for (let i = 0; i < totalSlots; i++) {
    const sa = slotAssignments[i];
    if (sa) {
      const colorIdx = config.products.findIndex((p) => p.id === sa.product.id);
      cells.push({
        shift: sa.shift,
        slot: sa.slot,
        product_id: sa.product.id,
        product_name: sa.product.name,
        quantity: config.pack_out_quantity,
        color: sa.product.color ?? PRODUCT_COLORS[colorIdx % PRODUCT_COLORS.length],
        status: 'assigned',
      });
    }
  }

  return { products, slots, cells, shifts: config.shifts_per_day };
}

function computeMixDeviation(
  config: HeijunkaConfig,
  box: HeijunkaBox,
): { idealMix: ProductMix[]; actualMix: ProductMix[] } {
  const totalSlots = box.cells.length;
  const idealMix: ProductMix[] = [];
  const actualMix: ProductMix[] = [];

  for (const p of config.products) {
    const actualCount = box.cells.filter((c) => c.product_id === p.id).length;
    const actualPct = totalSlots > 0 ? (actualCount / totalSlots) * 100 : 0;
    const deviation = actualPct - p.mix_pct;

    idealMix.push({
      product_id: p.id, product_name: p.name,
      target_pct: p.mix_pct, actual_pct: round2(actualPct), deviation_pct: round2(deviation),
    });
    actualMix.push({
      product_id: p.id, product_name: p.name,
      target_pct: p.mix_pct, actual_pct: round2(actualPct), deviation_pct: round2(deviation),
    });
  }

  return { idealMix, actualMix };
}

function computeLevelingScore(ideal: ProductMix[], actual: ProductMix[]): number {
  if (ideal.length === 0) return 100;
  const totalDeviation = actual.reduce((s, a) => s + Math.abs(a.deviation_pct), 0);
  // Max possible deviation is 200% (completely wrong mix)
  const maxDeviation = 200;
  return Math.max(0, 100 - (totalDeviation / maxDeviation) * 100);
}

function analyzeChangeovers(
  config: HeijunkaConfig,
  box: HeijunkaBox,
): { changeovers: number; changeoverMinutes: number; suggestions: string[] } {
  let changeovers = 0;
  let changeoverMinutes = 0;

  const sorted = [...box.cells].sort((a, b) => {
    if (a.shift !== b.shift) return a.shift - b.shift;
    return a.slot - b.slot;
  });

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].product_id !== sorted[i - 1].product_id) {
      changeovers++;
      const product = config.products.find((p) => p.id === sorted[i].product_id);
      changeoverMinutes += product?.changeover_minutes ?? 0;
    }
  }

  const suggestions: string[] = [];
  if (changeovers > sorted.length * 0.6) {
    suggestions.push('High changeover frequency. Consider grouping similar products in adjacent slots to reduce transitions.');
  }
  if (changeoverMinutes > config.takt_time_minutes * config.slots_per_shift * 0.1) {
    suggestions.push(`Changeover time (${changeoverMinutes.toFixed(0)}min) exceeds 10% of available time. Apply SMED to reduce changeover.`);
  }

  // Check for SMED opportunities
  const maxCO = Math.max(...config.products.map((p) => p.changeover_minutes));
  if (maxCO > 15) {
    const worstProduct = config.products.find((p) => p.changeover_minutes === maxCO);
    suggestions.push(`${worstProduct?.name} has ${maxCO}min changeover — primary SMED target.`);
  }

  if (suggestions.length === 0) {
    suggestions.push('Changeover levels are acceptable for current production mix.');
  }

  return { changeovers, changeoverMinutes, suggestions };
}

function buildShiftPlans(config: HeijunkaConfig, box: HeijunkaBox): ShiftPlan[] {
  const plans: ShiftPlan[] = [];

  for (let shift = 1; shift <= config.shifts_per_day; shift++) {
    const shiftSlots = box.cells.filter((c) => c.shift === shift).sort((a, b) => a.slot - b.slot);
    let shiftChangeovers = 0;
    let shiftCOMinutes = 0;

    for (let i = 1; i < shiftSlots.length; i++) {
      if (shiftSlots[i].product_id !== shiftSlots[i - 1].product_id) {
        shiftChangeovers++;
        const product = config.products.find((p) => p.id === shiftSlots[i].product_id);
        shiftCOMinutes += product?.changeover_minutes ?? 0;
      }
    }

    plans.push({
      shift,
      slots: shiftSlots,
      total_quantity: shiftSlots.reduce((s, sl) => s + sl.quantity, 0),
      changeovers: shiftChangeovers,
      changeover_minutes: round2(shiftCOMinutes),
    });
  }

  return plans;
}

// ── Helpers ──────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
