import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  initSimulation, runToCompletion, generateDemoEvents, analyzeSimulation, validateFSM,
  listTemplates, saveFSM, listFSMs, type FSMConfig,
} from '../../fsm/index.js';

export const fsmDefinition: Tool = {
  type: 'function',
  function: {
    name: 'state_machine_simulator',
    description: `Manufacturing State Machine (FSM) visual simulator for DES resource modeling.

Actions:
- simulate: Run FSM simulation. Requires config_json.
- validate: Validate FSM (reachability, deadlock). Requires config_json.
- templates: List available manufacturing FSM templates (CNC Machine, Conveyor, AGV, Order Processing).
- list: List saved configs.

Config: { name, machines: [{id, name, states: [{id, name, mfg_type, is_initial}], transitions: [{from_state_id, to_state_id, event, guard?}]}], sim_duration_minutes }

Manufacturing state types: idle, processing, queued, changeover, broken_down, starved, blocked, on_break, warmup.

Bridges to: S16 Simulation, VSM (S15.3), TOC (S15.4), Sequencer (S15.2).
Web UI: /fsm`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['simulate', 'validate', 'templates', 'list'] },
        config_json: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function stateMachineSimulator(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (args.action as string) {
      case 'simulate': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as FSMConfig;
        if (!config.event_queue || config.event_queue.length === 0) {
          config.event_queue = generateDemoEvents(config);
        }
        const state = initSimulation(config);
        const finalState = runToCompletion(state, config);
        const analysis = analyzeSimulation(finalState, config);
        if (config.name) await saveFSM(config.name, config, analysis);
        return {
          success: true,
          transitions: analysis.system_metrics.total_transitions,
          avg_utilization: `${analysis.system_metrics.avg_utilization_pct.toFixed(1)}%`,
          avg_availability: `${analysis.system_metrics.avg_availability_pct.toFixed(1)}%`,
          bottleneck: analysis.system_metrics.bottleneck_machine ?? 'None',
          machines: analysis.machines.map((m) => ({
            name: m.machine_name,
            utilization: `${m.utilization_pct.toFixed(1)}%`,
            states_visited: m.states_visited,
            top_state: m.state_residence.sort((a, b) => b.pct_of_total - a.pct_of_total)[0]?.state_name,
          })),
        };
      }
      case 'validate': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as FSMConfig;
        const result = validateFSM(config);
        return { success: true, is_valid: result.is_valid, issues: result.issues.map((i) => `[${i.severity}] ${i.message}`) };
      }
      case 'templates': {
        return { success: true, templates: listTemplates() };
      }
      case 'list': {
        const configs = await listFSMs();
        return { success: true, configs: configs.map((c) => ({ name: c.name, updated: new Date(c.updated_at).toISOString() })) };
      }
      default: return { error: `Unknown action: ${args.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'state_machine_simulator error');
    return { error: msg };
  }
}
