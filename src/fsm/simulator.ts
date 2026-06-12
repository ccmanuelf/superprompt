/**
 * FSM Simulator — Step-through DES execution engine
 *
 * Processes events against FSM definitions, tracking state transitions,
 * residence times, and generating analysis metrics.
 */

import type {
  FSMConfig,
  FSMEvent,
  FSMSimulationState,
  MachineState,
  StateHistoryEntry,
  FSMAnalysis,
  MachineAnalysis,
  StateResidence,
} from './models.js';
import { validateFSM } from './validation.js';

// ── Public API ───────────────────────────────────────────────

/**
 * Initialize simulation state from config.
 */
export function initSimulation(config: FSMConfig): FSMSimulationState {
  const machines: MachineState[] = config.machines.map((m) => {
    const initial = m.states.find((s) => s.is_initial) ?? m.states[0];
    return {
      machine_id: m.id,
      machine_name: m.name,
      current_state_id: initial.id,
      current_state_name: initial.name,
      current_mfg_type: initial.mfg_type,
      entered_at: 0,
      state_history: [],
    };
  });

  return {
    time: 0,
    machines,
    event_log: [],
    pending_events: [...(config.event_queue ?? [])].sort((a, b) => a.time - b.time),
    completed: false,
  };
}

/**
 * Process a single event (manual step mode).
 */
export function processEvent(
  state: FSMSimulationState,
  event: FSMEvent,
  config: FSMConfig,
): FSMSimulationState {
  const machine = state.machines.find((m) => m.machine_id === event.machine_id);
  const fsmDef = config.machines.find((m) => m.id === event.machine_id);
  if (!machine || !fsmDef) return state;

  // Find matching transition — evaluate guards against event data
  const candidates = fsmDef.transitions.filter((t) =>
    t.from_state_id === machine.current_state_id &&
    t.event === event.event_name,
  );

  // Sort by priority (lower = higher priority), then guarded before unguarded
  candidates.sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    // Guarded transitions take priority over unguarded (more specific first)
    if (a.guard && !b.guard) return -1;
    if (!a.guard && b.guard) return 1;
    return 0;
  });

  // Find first transition whose guard passes and probability check succeeds
  const transition = candidates.find((t) => {
    if (t.probability != null && Math.random() >= t.probability) return false;
    if (!t.guard) return true;
    // Evaluate guard against event.data (simple key presence check)
    return evaluateGuard(t.guard, event.data ?? {});
  });

  if (!transition) {
    // No valid transition — log and skip
    state.event_log.push({
      time: event.time,
      machine_id: machine.machine_id,
      machine_name: machine.machine_name,
      event: event.event_name,
      from_state: machine.current_state_name,
      to_state: '(no transition)',
      guard_result: false,
    });
    return state;
  }

  const toState = fsmDef.states.find((s) => s.id === transition.to_state_id);
  if (!toState) return state;

  // Record history
  const duration = event.time - machine.entered_at;
  machine.state_history.push({
    state_id: machine.current_state_id,
    state_name: machine.current_state_name,
    mfg_type: machine.current_mfg_type,
    entered_at: machine.entered_at,
    exited_at: event.time,
    duration,
    trigger_event: event.event_name,
  });

  // Log event
  state.event_log.push({
    time: event.time,
    machine_id: machine.machine_id,
    machine_name: machine.machine_name,
    event: event.event_name,
    from_state: machine.current_state_name,
    to_state: toState.name,
    guard_result: true,
  });

  // Transition
  machine.current_state_id = toState.id;
  machine.current_state_name = toState.name;
  machine.current_mfg_type = toState.mfg_type;
  machine.entered_at = event.time;

  state.time = event.time;
  return state;
}

/**
 * Run the next pending event (step mode).
 */
export function stepSimulation(
  state: FSMSimulationState,
  config: FSMConfig,
): FSMSimulationState {
  if (state.pending_events.length === 0) {
    state.completed = true;
    return state;
  }

  const event = state.pending_events.shift()!;
  return processEvent(state, event, config);
}

/**
 * Run all events up to a given time (auto/fast-forward mode).
 */
export function runUntil(
  state: FSMSimulationState,
  config: FSMConfig,
  untilTime: number,
): FSMSimulationState {
  while (state.pending_events.length > 0 && state.pending_events[0].time <= untilTime) {
    const event = state.pending_events.shift()!;
    processEvent(state, event, config);
  }

  state.time = untilTime;
  if (state.pending_events.length === 0) state.completed = true;
  return state;
}

/**
 * Run all events to completion.
 */
export function runToCompletion(
  state: FSMSimulationState,
  config: FSMConfig,
): FSMSimulationState {
  return runUntil(state, config, config.sim_duration_minutes);
}

/**
 * Generate events from a simple repeating pattern (for demo/testing).
 * Creates a cycle of events for each machine.
 */
export function generateDemoEvents(config: FSMConfig): FSMEvent[] {
  const events: FSMEvent[] = [];
  let eventId = 0;

  for (const machine of config.machines) {
    const transitions = machine.transitions;
    if (transitions.length === 0) continue;

    let time = 0;
    let currentStateId = machine.states.find((s) => s.is_initial)?.id ?? machine.states[0]?.id;
    const maxEvents = Math.min(50, Math.ceil(config.sim_duration_minutes / 5));

    for (let i = 0; i < maxEvents && time < config.sim_duration_minutes; i++) {
      // Find a valid transition from current state
      const validTransitions = transitions.filter((t) => t.from_state_id === currentStateId);
      if (validTransitions.length === 0) break;

      const t = validTransitions[i % validTransitions.length];
      const state = machine.states.find((s) => s.id === currentStateId);
      time += state?.avg_duration ?? (5 + Math.random() * 15);

      if (time >= config.sim_duration_minutes) break;

      events.push({
        id: `evt_${++eventId}`,
        time: Math.round(time * 100) / 100,
        machine_id: machine.id,
        event_name: t.event,
      });

      currentStateId = t.to_state_id;
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

// ── Analysis ─────────────────────────────────────────────────

/**
 * Analyze completed simulation — state residence, utilization, etc.
 */
export function analyzeSimulation(
  state: FSMSimulationState,
  config: FSMConfig,
): FSMAnalysis {
  const totalTime = config.sim_duration_minutes;
  const validation = validateFSM(config);

  const machineAnalyses: MachineAnalysis[] = state.machines.map((ms) => {
    // Add final state residence (from last transition to sim end)
    const allHistory: StateHistoryEntry[] = [...ms.state_history];
    if (ms.entered_at < totalTime) {
      allHistory.push({
        state_id: ms.current_state_id,
        state_name: ms.current_state_name,
        mfg_type: ms.current_mfg_type,
        entered_at: ms.entered_at,
        exited_at: totalTime,
        duration: totalTime - ms.entered_at,
        trigger_event: '(sim_end)',
      });
    }

    // Aggregate by state
    const stateMap = new Map<string, { entries: StateHistoryEntry[]; mfg_type: string; name: string }>();
    for (const h of allHistory) {
      const entry = stateMap.get(h.state_id) ?? { entries: [], mfg_type: h.mfg_type, name: h.state_name };
      entry.entries.push(h);
      stateMap.set(h.state_id, entry);
    }

    const stateResidence: StateResidence[] = Array.from(stateMap.entries()).map(([stateId, data]) => {
      const durations = data.entries.map((e) => e.duration);
      const totalStateTime = durations.reduce((s, d) => s + d, 0);
      return {
        state_id: stateId,
        state_name: data.name,
        mfg_type: data.mfg_type as StateHistoryEntry['mfg_type'],
        total_time: round2(totalStateTime),
        pct_of_total: totalTime > 0 ? round2((totalStateTime / totalTime) * 100) : 0,
        visit_count: durations.length,
        avg_duration: durations.length > 0 ? round2(totalStateTime / durations.length) : 0,
        min_duration: durations.length > 0 ? round2(Math.min(...durations)) : 0,
        max_duration: durations.length > 0 ? round2(Math.max(...durations)) : 0,
      };
    });

    const processingTime = stateResidence
      .filter((sr) => sr.mfg_type === 'processing')
      .reduce((s, sr) => s + sr.total_time, 0);
    const idleTime = stateResidence
      .filter((sr) => sr.mfg_type === 'idle')
      .reduce((s, sr) => s + sr.total_time, 0);
    const breakdownTime = stateResidence
      .filter((sr) => sr.mfg_type === 'broken_down')
      .reduce((s, sr) => s + sr.total_time, 0);

    return {
      machine_id: ms.machine_id,
      machine_name: ms.machine_name,
      state_residence: stateResidence,
      transition_count: ms.state_history.length,
      total_processing_time: round2(processingTime),
      total_idle_time: round2(idleTime),
      total_breakdown_time: round2(breakdownTime),
      utilization_pct: totalTime > 0 ? round2((processingTime / totalTime) * 100) : 0,
      availability_pct: totalTime > 0 ? round2(((totalTime - breakdownTime) / totalTime) * 100) : 100,
      states_visited: stateMap.size,
    };
  });

  // System metrics
  const avgUtil = machineAnalyses.length > 0
    ? machineAnalyses.reduce((s, m) => s + m.utilization_pct, 0) / machineAnalyses.length
    : 0;
  const avgAvail = machineAnalyses.length > 0
    ? machineAnalyses.reduce((s, m) => s + m.availability_pct, 0) / machineAnalyses.length
    : 100;

  const bottleneck = machineAnalyses.reduce(
    (min, m) => m.utilization_pct > (min?.utilization_pct ?? 0) ? m : min,
    machineAnalyses[0],
  );
  const mostBreakdowns = machineAnalyses.reduce(
    (max, m) => m.total_breakdown_time > (max?.total_breakdown_time ?? 0) ? m : max,
    machineAnalyses[0],
  );

  return {
    config_name: config.name,
    total_time: totalTime,
    machines: machineAnalyses,
    system_metrics: {
      total_transitions: state.event_log.length,
      avg_utilization_pct: round2(avgUtil),
      avg_availability_pct: round2(avgAvail),
      bottleneck_machine: bottleneck?.machine_name,
      most_breakdowns_machine: mostBreakdowns?.total_breakdown_time > 0 ? mostBreakdowns.machine_name : undefined,
    },
    validation,
  };
}

/**
 * Evaluate a guard string against event data.
 * Supports simple expressions: "key", "!key", "key && key2", "key || key2".
 * Values in event data are checked for truthiness.
 */
function evaluateGuard(guard: string, data: Record<string, unknown>): boolean {
  if (!guard || guard.trim() === '') return true;

  // Handle && (AND)
  if (guard.includes('&&')) {
    return guard.split('&&').every((part) => evaluateGuard(part.trim(), data));
  }
  // Handle || (OR)
  if (guard.includes('||')) {
    return guard.split('||').some((part) => evaluateGuard(part.trim(), data));
  }
  // Handle negation: !key
  const trimmed = guard.trim();
  if (trimmed.startsWith('!')) {
    const key = trimmed.slice(1).trim();
    return !data[key];
  }
  // Handle comparison: key < value, key > value, key == value
  const compMatch = trimmed.match(/^(\w+)\s*(<=?|>=?|==)\s*(.+)$/);
  if (compMatch) {
    const [, key, op, valStr] = compMatch;
    const actual = Number(data[key] ?? 0);
    const expected = Number(valStr);
    switch (op) {
      case '<': return actual < expected;
      case '<=': return actual <= expected;
      case '>': return actual > expected;
      case '>=': return actual >= expected;
      case '==': return actual === expected;
    }
  }
  // Simple presence check: truthy value for key
  return !!data[trimmed];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
