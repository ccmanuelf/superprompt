/**
 * FSM Bridge — Connect to S16 Simulation, VSM, TOC, and Sequencer
 *
 * Maps metrics from other ClawMFG tools into FSM state residence data,
 * enabling cross-tool visualization and analysis.
 */

import type {
  S16BridgeResult,
  StateResidence,
  FSMDefinition,
  FSMConfig,
  FSMEvent,
  MfgStateType,
} from './models.js';
import { MFG_STATE_LABELS } from './models.js';
import { getTemplate } from './templates.js';

// ── S16 Simulation Bridge ────────────────────────────────────

/**
 * Convert S16 simulation station performance into FSM state residence.
 * Maps StationPerformanceRow metrics → state times.
 */
export function bridgeFromSimulation(
  stationPerformance: Array<{
    machine_tool: string;
    total_busy_time_min: number;
    queue_wait_time_min: number;
    util_pct: number;
    is_bottleneck: boolean;
  }>,
  totalSimMinutes: number,
  breakdownTimeLost?: number,
): S16BridgeResult[] {
  return stationPerformance.map((sp) => {
    const machineId = normalizeMachineName(sp.machine_tool);
    const processingMin = sp.total_busy_time_min;
    const queuedMin = sp.queue_wait_time_min;
    const breakdownMin = breakdownTimeLost
      ? (breakdownTimeLost / stationPerformance.length)
      : 0;
    const idleMin = Math.max(0, totalSimMinutes - processingMin - queuedMin - breakdownMin);

    const residence = buildResidence(totalSimMinutes, {
      processing: processingMin,
      idle: idleMin,
      queued: queuedMin,
      broken_down: breakdownMin,
    });

    return {
      machine_id: machineId,
      machine_name: sp.machine_tool,
      processing_minutes: round2(processingMin),
      idle_minutes: round2(idleMin),
      queued_minutes: round2(queuedMin),
      breakdown_minutes: round2(breakdownMin),
      changeover_minutes: 0,
      utilization_pct: sp.util_pct,
      state_residence: residence,
    };
  });
}

// ── VSM Bridge ───────────────────────────────────────────────

/**
 * Convert VSM analysis into FSM state residence per process step.
 * Maps VA/NVA/BNVA + wait/transport → manufacturing FSM states.
 */
export function bridgeFromVSM(
  vsmBreakdown: Array<{
    step_name: string;
    category: string;        // VA, NVA, BNVA
    cycle_time: number;
    wait_time: number;
    transport_time: number;
    changeover_per_unit: number;
  }>,
): S16BridgeResult[] {
  return vsmBreakdown.map((step) => {
    const totalStepTime = step.cycle_time + step.wait_time + step.transport_time + step.changeover_per_unit;

    // Map VSM categories to FSM states
    const processingMin = step.category === 'VA' ? step.cycle_time : 0;
    const nvaMin = step.category === 'NVA' ? step.cycle_time : 0;
    const bnvaMin = step.category === 'BNVA' ? step.cycle_time : 0;
    const idleMin = nvaMin + bnvaMin; // NVA/BNVA time maps to non-productive states

    const residence = buildResidence(totalStepTime, {
      processing: processingMin,
      queued: step.wait_time,
      changeover: step.changeover_per_unit,
      idle: idleMin,
    });

    return {
      machine_id: normalizeMachineName(step.step_name),
      machine_name: step.step_name,
      processing_minutes: round2(processingMin),
      idle_minutes: round2(idleMin),
      queued_minutes: round2(step.wait_time),
      breakdown_minutes: 0,
      changeover_minutes: round2(step.changeover_per_unit),
      utilization_pct: totalStepTime > 0 ? round2((processingMin / totalStepTime) * 100) : 0,
      state_residence: residence,
    };
  });
}

// ── TOC Bridge ───────────────────────────────────────────────

/**
 * Convert TOC work center utilization into FSM state data.
 * CCR is highlighted; buffer consumption maps to blocked/queued states.
 */
export function bridgeFromTOC(
  workCenterRanking: Array<{
    name: string;
    utilization_pct: number;
    load_hours: number;
    available_hours: number;
    is_ccr: boolean;
    excess_hours: number;
  }>,
  availableMinutesPerDay: number,
): S16BridgeResult[] {
  return workCenterRanking.map((wc) => {
    const totalMin = availableMinutesPerDay;
    const loadMin = wc.load_hours * 60;
    const processingMin = Math.min(loadMin, totalMin);
    const idleMin = Math.max(0, totalMin - processingMin);
    // CCR has no idle — if over 100%, it's "blocked" by excess demand
    const blockedMin = wc.is_ccr && wc.utilization_pct > 100
      ? (loadMin - totalMin)
      : 0;

    const residence = buildResidence(totalMin + blockedMin, {
      processing: processingMin,
      idle: idleMin,
      blocked: blockedMin,
    });

    return {
      machine_id: normalizeMachineName(wc.name),
      machine_name: wc.name + (wc.is_ccr ? ' (CCR)' : ''),
      processing_minutes: round2(processingMin),
      idle_minutes: round2(idleMin),
      queued_minutes: 0,
      breakdown_minutes: 0,
      changeover_minutes: 0,
      utilization_pct: wc.utilization_pct,
      state_residence: residence,
    };
  });
}

// ── Sequencer Bridge ─────────────────────────────────────────

/**
 * Convert sequencer schedule entries into FSM events.
 * Each job start/end becomes a state transition event.
 */
export function bridgeFromSequencer(
  scheduleEntries: Array<{
    job_name: string;
    machine_name: string;
    machine_id: string;
    start_time: number;
    end_time: number;
    setup_time: number;
    processing_time: number;
  }>,
): FSMEvent[] {
  const events: FSMEvent[] = [];
  let id = 0;

  for (const entry of scheduleEntries) {
    // Setup start
    if (entry.setup_time > 0) {
      events.push({
        id: `seq_${++id}`,
        time: entry.start_time - entry.setup_time,
        machine_id: entry.machine_id,
        event_name: 'job_arrives',
        data: { job: entry.job_name, type: 'changeover' },
      });
      events.push({
        id: `seq_${++id}`,
        time: entry.start_time,
        machine_id: entry.machine_id,
        event_name: 'changeover_complete',
      });
    } else {
      events.push({
        id: `seq_${++id}`,
        time: entry.start_time,
        machine_id: entry.machine_id,
        event_name: 'job_arrives',
        data: { job: entry.job_name },
      });
    }

    // Processing complete
    events.push({
      id: `seq_${++id}`,
      time: entry.end_time,
      machine_id: entry.machine_id,
      event_name: 'processing_complete',
      data: { job: entry.job_name },
    });
  }

  return events.sort((a, b) => a.time - b.time);
}

/**
 * Create an FSM config from S16 bridge results using the CNC machine template.
 */
export function createFSMFromBridge(
  bridgeResults: S16BridgeResult[],
  name: string,
  simDuration: number,
): FSMConfig {
  const template = getTemplate('cnc_machine');
  if (!template) throw new Error('CNC machine template not found');

  const machines: FSMDefinition[] = bridgeResults.map((br) => ({
    id: br.machine_id,
    name: br.machine_name,
    template: 'cnc_machine',
    resource_type: 'machine',
    ...template.definition,
  }));

  return {
    name,
    machines,
    sim_duration_minutes: simDuration,
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Normalize a machine/station name for consistent cross-tool matching.
 * Trims whitespace, lowercases, replaces special chars with underscore.
 */
export function normalizeMachineName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function buildResidence(
  totalTime: number,
  times: Partial<Record<MfgStateType, number>>,
): StateResidence[] {
  const result: StateResidence[] = [];

  for (const [type, minutes] of Object.entries(times)) {
    if (minutes == null || minutes <= 0) continue;
    result.push({
      state_id: type,
      state_name: MFG_STATE_LABELS[type as MfgStateType] ?? type,
      mfg_type: type as MfgStateType,
      total_time: round2(minutes),
      pct_of_total: totalTime > 0 ? round2((minutes / totalTime) * 100) : 0,
      visit_count: 1,
      avg_duration: round2(minutes),
      min_duration: round2(minutes),
      max_duration: round2(minutes),
    });
  }

  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
