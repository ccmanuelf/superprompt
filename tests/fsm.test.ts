import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Knex } from 'knex';
import { createTestKnex } from '../src/db-knex.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

let testKnex: Knex;
vi.mock('../src/db-knex.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, getKnex: () => testKnex, getDbDriver: () => 'sqlite' };
});
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/config.js', () => ({ STORE_DIR: resolve(tmpdir(), 'clauded-test-fsm'), config: { NODE_ENV: 'test' } }));

import {
  initSimulation, processEvent, stepSimulation, runToCompletion, generateDemoEvents, analyzeSimulation,
} from '../src/fsm/simulator.js';
import { validateFSM } from '../src/fsm/validation.js';
import { getTemplate, listTemplates, FSM_TEMPLATES } from '../src/fsm/templates.js';
import { bridgeFromSimulation, bridgeFromVSM, bridgeFromTOC, bridgeFromSequencer } from '../src/fsm/bridge.js';
import { initFsmTables, saveFSM, getFSMConfig, listFSMs, deleteFSMConfig } from '../src/fsm/index.js';
import type { FSMConfig, FSMDefinition, FSMEvent } from '../src/fsm/models.js';

async function initTestDb(): Promise<void> {
  if (testKnex) await testKnex.destroy();
  testKnex = createTestKnex();
  await initFsmTables();
}
beforeEach(async () => { await initTestDb(); });
afterAll(async () => { if (testKnex) await testKnex.destroy(); });

// ── Sample Data ──────────────────────────────────────────────

function makeCNCMachine(): FSMDefinition {
  const t = getTemplate('cnc_machine')!;
  return { id: 'cnc_1', name: 'CNC Mill 1', ...t.definition };
}

function makeConfig(machines?: FSMDefinition[]): FSMConfig {
  return {
    name: 'Test FSM',
    machines: machines ?? [makeCNCMachine()],
    sim_duration_minutes: 480,
  };
}

function makeEvents(): FSMEvent[] {
  return [
    { id: 'e1', time: 0, machine_id: 'cnc_1', event_name: 'job_arrives', data: { material_available: true, wip_below_limit: true } },
    { id: 'e2', time: 20, machine_id: 'cnc_1', event_name: 'processing_complete' },
    { id: 'e3', time: 25, machine_id: 'cnc_1', event_name: 'job_arrives', data: { material_available: true, wip_below_limit: true } },
    { id: 'e4', time: 50, machine_id: 'cnc_1', event_name: 'failure_occurs' },
    { id: 'e5', time: 80, machine_id: 'cnc_1', event_name: 'repair_complete' },
    { id: 'e6', time: 85, machine_id: 'cnc_1', event_name: 'job_arrives', data: { material_available: true, wip_below_limit: true } },
    { id: 'e7', time: 110, machine_id: 'cnc_1', event_name: 'processing_complete' },
  ];
}

// ══════════════════════════════════════════════════════════════
// Templates
// ══════════════════════════════════════════════════════════════

describe('Templates', () => {
  it('should have 4 manufacturing templates', () => {
    expect(FSM_TEMPLATES).toHaveLength(4);
    expect(listTemplates()).toHaveLength(4);
  });

  it('should load CNC machine template', () => {
    const t = getTemplate('cnc_machine');
    expect(t).toBeDefined();
    expect(t!.definition.states.length).toBeGreaterThanOrEqual(5);
    expect(t!.definition.transitions.length).toBeGreaterThanOrEqual(8);
  });

  it('all templates should have initial state', () => {
    for (const t of FSM_TEMPLATES) {
      const hasInitial = t.definition.states.some((s) => s.is_initial);
      expect(hasInitial).toBe(true);
    }
  });

  it('all templates should have manufacturing state types', () => {
    const validTypes = ['idle', 'processing', 'queued', 'changeover', 'broken_down', 'starved', 'blocked', 'on_break', 'warmup', 'custom'];
    for (const t of FSM_TEMPLATES) {
      for (const s of t.definition.states) {
        expect(validTypes).toContain(s.mfg_type);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Simulation
// ══════════════════════════════════════════════════════════════

describe('Simulation', () => {
  it('should initialize with machines in initial state', () => {
    const config = makeConfig();
    const state = initSimulation(config);
    expect(state.machines).toHaveLength(1);
    expect(state.machines[0].current_state_name).toBe('Idle');
    expect(state.time).toBe(0);
  });

  it('should process a single event', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    const event: FSMEvent = { id: 'e1', time: 0, machine_id: 'cnc_1', event_name: 'job_arrives', data: { material_available: true, wip_below_limit: true } };
    processEvent(state, event, config);
    expect(state.machines[0].current_state_name).toBe('Processing');
    expect(state.event_log).toHaveLength(1);
  });

  it('should handle step-by-step simulation', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    let state = initSimulation(config);
    state.pending_events = [...config.event_queue];

    state = stepSimulation(state, config);
    expect(state.machines[0].current_state_name).toBe('Processing');

    state = stepSimulation(state, config);
    expect(state.machines[0].current_state_name).toBe('Idle');
  });

  it('should run to completion', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    state.pending_events = [...config.event_queue];
    const finalState = runToCompletion(state, config);
    expect(finalState.event_log.length).toBeGreaterThan(0);
  });

  it('should generate demo events from template', () => {
    const config = makeConfig();
    const events = generateDemoEvents(config);
    expect(events.length).toBeGreaterThan(0);
    // Events should be sorted by time
    for (let i = 1; i < events.length; i++) {
      expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time);
    }
  });

  it('should track state history', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    state.pending_events = [...config.event_queue];
    const finalState = runToCompletion(state, config);
    expect(finalState.machines[0].state_history.length).toBeGreaterThan(0);
    // Each history entry should have duration >= 0
    for (const h of finalState.machines[0].state_history) {
      expect(h.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('should handle invalid event (no matching transition) gracefully', () => {
    const config = makeConfig();
    const state = initSimulation(config);
    const event: FSMEvent = { id: 'bad', time: 5, machine_id: 'cnc_1', event_name: 'nonexistent_event' };
    processEvent(state, event, config);
    // Should log the failed attempt
    expect(state.event_log).toHaveLength(1);
    expect(state.event_log[0].to_state).toBe('(no transition)');
  });
});

// ══════════════════════════════════════════════════════════════
// Analysis
// ══════════════════════════════════════════════════════════════

describe('Analysis', () => {
  it('should compute state residence times', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    state.pending_events = [...config.event_queue];
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    expect(analysis.machines).toHaveLength(1);
    const ma = analysis.machines[0];
    expect(ma.state_residence.length).toBeGreaterThan(0);
    // Total of all residence times should equal sim duration
    const totalTime = ma.state_residence.reduce((s, r) => s + r.total_time, 0);
    expect(totalTime).toBeCloseTo(480, 0);
  });

  it('should compute utilization and availability', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    state.pending_events = [...config.event_queue];
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    const ma = analysis.machines[0];
    expect(ma.utilization_pct).toBeGreaterThanOrEqual(0);
    expect(ma.utilization_pct).toBeLessThanOrEqual(100);
    expect(ma.availability_pct).toBeGreaterThanOrEqual(0);
    expect(ma.availability_pct).toBeLessThanOrEqual(100);
  });

  it('should compute system metrics', () => {
    const config = makeConfig();
    config.event_queue = makeEvents();
    const state = initSimulation(config);
    state.pending_events = [...config.event_queue];
    const finalState = runToCompletion(state, config);
    const analysis = analyzeSimulation(finalState, config);

    expect(analysis.system_metrics.total_transitions).toBeGreaterThan(0);
    expect(analysis.system_metrics.avg_utilization_pct).toBeGreaterThanOrEqual(0);
  });

  it('should include validation in analysis', () => {
    const config = makeConfig();
    const state = initSimulation(config);
    const analysis = analyzeSimulation(state, config);
    expect(analysis.validation).toBeDefined();
    expect(analysis.validation.is_valid).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════

describe('Validation', () => {
  it('should validate a correct FSM', () => {
    const config = makeConfig();
    const result = validateFSM(config);
    expect(result.is_valid).toBe(true);
    expect(result.has_initial_states).toBe(true);
  });

  it('should detect missing initial state', () => {
    const machine: FSMDefinition = {
      id: 'm1', name: 'Bad Machine',
      states: [
        { id: 's1', name: 'Only State', mfg_type: 'processing', is_initial: false, is_final: false, x: 0, y: 0 },
      ],
      transitions: [],
    };
    const config = makeConfig([machine]);
    const result = validateFSM(config);
    expect(result.has_initial_states).toBe(false);
    expect(result.issues.some((i) => i.message.includes('No initial state'))).toBe(true);
  });

  it('should detect deadlock states', () => {
    const machine: FSMDefinition = {
      id: 'm1', name: 'Deadlock Machine',
      states: [
        { id: 's1', name: 'Start', mfg_type: 'idle', is_initial: true, is_final: false, x: 0, y: 0 },
        { id: 's2', name: 'Stuck', mfg_type: 'processing', is_initial: false, is_final: false, x: 100, y: 0 },
      ],
      transitions: [
        { id: 't1', from_state_id: 's1', to_state_id: 's2', event: 'go' },
        // s2 has no outgoing transitions → deadlock
      ],
    };
    const config = makeConfig([machine]);
    const result = validateFSM(config);
    expect(result.deadlock_states['m1']).toContain('s2');
  });

  it('should detect unreachable states', () => {
    const machine: FSMDefinition = {
      id: 'm1', name: 'Unreachable',
      states: [
        { id: 's1', name: 'Start', mfg_type: 'idle', is_initial: true, is_final: false, x: 0, y: 0 },
        { id: 's2', name: 'Reachable', mfg_type: 'processing', is_initial: false, is_final: false, x: 100, y: 0 },
        { id: 's3', name: 'Island', mfg_type: 'broken_down', is_initial: false, is_final: false, x: 200, y: 0 },
      ],
      transitions: [
        { id: 't1', from_state_id: 's1', to_state_id: 's2', event: 'go' },
        { id: 't2', from_state_id: 's2', to_state_id: 's1', event: 'back' },
        // s3 has no incoming transitions → unreachable
      ],
    };
    const config = makeConfig([machine]);
    const result = validateFSM(config);
    expect(result.reachability['m1']).toContain('s3');
  });

  it('should validate all templates pass validation', () => {
    for (const t of FSM_TEMPLATES) {
      const machine: FSMDefinition = { id: 'test', name: t.label, ...t.definition };
      const config = makeConfig([machine]);
      const result = validateFSM(config);
      // Templates should be valid (no errors — warnings are OK)
      expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Bridge
// ══════════════════════════════════════════════════════════════

describe('Bridge', () => {
  it('should bridge from S16 simulation metrics', () => {
    const stationPerf = [
      { machine_tool: 'CNC_1', total_busy_time_min: 360, queue_wait_time_min: 60, util_pct: 75, is_bottleneck: false },
      { machine_tool: 'CNC_2', total_busy_time_min: 440, queue_wait_time_min: 20, util_pct: 92, is_bottleneck: true },
    ];
    const result = bridgeFromSimulation(stationPerf, 480, 30);
    expect(result).toHaveLength(2);
    expect(result[0].processing_minutes).toBe(360);
    expect(result[0].utilization_pct).toBe(75);
    expect(result[0].state_residence.length).toBeGreaterThan(0);
  });

  it('should bridge from VSM breakdown', () => {
    const breakdown = [
      { step_name: 'Cut', category: 'VA', cycle_time: 2, wait_time: 10, transport_time: 1, changeover_per_unit: 0.3 },
      { step_name: 'Inspect', category: 'BNVA', cycle_time: 1, wait_time: 5, transport_time: 0, changeover_per_unit: 0 },
    ];
    const result = bridgeFromVSM(breakdown);
    expect(result).toHaveLength(2);
    expect(result[0].processing_minutes).toBe(2); // VA step
    expect(result[1].processing_minutes).toBe(0); // BNVA step → no processing
  });

  it('should bridge from TOC work center ranking', () => {
    const ranking = [
      { name: 'Welding', utilization_pct: 125, load_hours: 10, available_hours: 8, is_ccr: true, excess_hours: 0 },
      { name: 'Cutting', utilization_pct: 50, load_hours: 4, available_hours: 8, is_ccr: false, excess_hours: 4 },
    ];
    const result = bridgeFromTOC(ranking, 480);
    expect(result).toHaveLength(2);
    expect(result[0].machine_name).toContain('CCR');
    // CCR should have blocked time
    const blocked = result[0].state_residence.find((sr) => sr.mfg_type === 'blocked');
    expect(blocked).toBeDefined();
  });

  it('should bridge from sequencer schedule', () => {
    const entries = [
      { job_name: 'Job A', machine_name: 'M1', machine_id: 'm1', start_time: 10, end_time: 40, setup_time: 5, processing_time: 30 },
    ];
    const events = bridgeFromSequencer(entries);
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Should have job_arrives and processing_complete
    expect(events.some((e) => e.event_name === 'job_arrives')).toBe(true);
    expect(events.some((e) => e.event_name === 'processing_complete')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// Database CRUD
// ══════════════════════════════════════════════════════════════

describe('Database CRUD', () => {
  it('should save and retrieve', async () => {
    const config = makeConfig();
    const saved = await saveFSM('My FSM', config);
    expect(saved.id).toBeTruthy();
    const retrieved = await getFSMConfig('My FSM');
    expect(retrieved).toBeDefined();
  });

  it('should update on collision', async () => {
    await saveFSM('Same', makeConfig());
    await saveFSM('Same', { ...makeConfig(), name: 'Updated' });
    expect((await listFSMs()).filter((c) => c.name === 'Same')).toHaveLength(1);
  });

  it('should delete', async () => {
    const saved = await saveFSM('Del', makeConfig());
    expect(await deleteFSMConfig(saved.id)).toBe(true);
    expect(await getFSMConfig(saved.id)).toBeUndefined();
  });

  it('should list sorted', async () => {
    await saveFSM('A', makeConfig());
    await saveFSM('B', makeConfig());
    const all = await listFSMs();
    expect(all).toHaveLength(2);
    expect(all[0].updated_at).toBeGreaterThanOrEqual(all[1].updated_at);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge Cases
// ══════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle empty machines list', () => {
    const config: FSMConfig = { name: 'Empty', machines: [], sim_duration_minutes: 100 };
    const state = initSimulation(config);
    expect(state.machines).toHaveLength(0);
    const analysis = analyzeSimulation(state, config);
    expect(analysis.machines).toHaveLength(0);
  });

  it('should handle machine with no transitions', () => {
    const machine: FSMDefinition = {
      id: 'm1', name: 'Static',
      states: [{ id: 's1', name: 'Only', mfg_type: 'idle', is_initial: true, is_final: true, x: 0, y: 0 }],
      transitions: [],
    };
    const config = makeConfig([machine]);
    const state = initSimulation(config);
    const final = runToCompletion(state, config);
    const analysis = analyzeSimulation(final, config);
    // Should spend 100% of time in idle
    expect(analysis.machines[0].state_residence[0].pct_of_total).toBe(100);
  });

  it('should handle multiple machines', () => {
    const m1 = makeCNCMachine();
    const m2: FSMDefinition = { ...makeCNCMachine(), id: 'cnc_2', name: 'CNC Mill 2' };
    const config = makeConfig([m1, m2]);
    const events = generateDemoEvents(config);
    config.event_queue = events;
    const state = initSimulation(config);
    state.pending_events = [...events];
    const final = runToCompletion(state, config);
    const analysis = analyzeSimulation(final, config);
    expect(analysis.machines).toHaveLength(2);
  });

  it('should handle zero duration simulation', () => {
    const config = makeConfig();
    config.sim_duration_minutes = 0;
    const state = initSimulation(config);
    const analysis = analyzeSimulation(state, config);
    expect(analysis.total_time).toBe(0);
  });
});
