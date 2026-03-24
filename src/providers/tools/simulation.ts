import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  runSimulation, validateSimulationConfig, calculateAllBlocks,
  runMonteCarlo, saveScenario, getScenarioByName, listScenarios,
  formatSimulationResults, generateUtilizationChart, generateThroughputChart,
  type SimulationConfig,
} from '../../simulation/index.js';

export const simulationDefinition: Tool = {
  type: 'function',
  function: {
    name: 'production_simulation',
    description: `Production line discrete-event simulation. Models bundles flowing through sequential operations with resource pooling, stochastic variability, rework, and breakdowns.

Actions:
- run: Run simulation. Requires config_json (JSON string of SimulationConfig). Optional: scenario_name to save.
- monte_carlo: Run N replications. Requires config_json. Optional: replications (default 30).
- validate: Validate config. Requires config_json.
- list: List saved scenarios.
- status: Show scenario results. Requires scenario_name.

Config format: { operations: [{product, step, operation, machine_tool, sam_min, operators?, grade_pct?, fpd_pct?, rework_pct?}], schedule: {shifts_enabled, shift1_hours, work_days}, demands: [{product, bundle_size?, daily_demand?}], breakdowns?: [{machine_tool, breakdown_pct}], mode?: "demand-driven", horizon_days?: 1 }

Also available: web UI at /sim on the web dashboard.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'monte_carlo', 'validate', 'list', 'status'] },
        config_json: { type: 'string', description: 'SimulationConfig as JSON string' },
        scenario_name: { type: 'string' },
        replications: { type: 'number', description: 'Monte Carlo replications (default 30)' },
      },
      required: ['action'],
    },
  },
};

export async function productionSimulation(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'run': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SimulationConfig;

        const report = validateSimulationConfig(config);
        if (!report.is_valid) return { success: false, validation: report, message: 'Validation failed' };

        const { metrics, durationSeconds } = await runSimulation(config);
        const results = calculateAllBlocks(config, metrics, report, durationSeconds);

        if (args.scenario_name) {
          const scenario = saveScenario(args.scenario_name as string, config);
          const { saveSimResult } = await import('../../simulation/index.js');
          saveSimResult(scenario.id, 'single', results);
        }

        return {
          success: true,
          summary: formatSimulationResults(results, (args.scenario_name as string) || 'Simulation', false),
          throughput: results.daily_summary.daily_throughput_pcs,
          demand: results.daily_summary.daily_demand_pcs,
          coverage_pct: results.daily_summary.daily_coverage_pct,
          bottlenecks: results.station_performance.filter(s => s.is_bottleneck).map(s => `${s.machine_tool}: ${s.util_pct}%`),
        };
      }

      case 'monte_carlo': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SimulationConfig;
        const reps = (args.replications as number) || 30;

        const mc = await runMonteCarlo(config, reps);
        return {
          success: true,
          replications: mc.replications,
          throughput: mc.throughput,
          cycle_time: mc.cycle_time,
          demand_met_pct: mc.demand_met_pct,
          message: `Monte Carlo: ${mc.replications} reps. Throughput mean=${mc.throughput.mean} P5=${mc.throughput.p5} P95=${mc.throughput.p95}. Demand met ${mc.demand_met_pct}% of runs.`,
        };
      }

      case 'validate': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SimulationConfig;
        return validateSimulationConfig(config) as unknown as Record<string, unknown>;
      }

      case 'list': {
        const scenarios = listScenarios();
        if (scenarios.length === 0) return { message: 'No saved scenarios.' };
        return { scenarios: scenarios.map(s => ({ name: s.name, updated: new Date(s.updated_at).toLocaleString() })) };
      }

      case 'status': {
        if (!args.scenario_name) return { error: 'scenario_name is required.' };
        const scenario = getScenarioByName(args.scenario_name as string);
        if (!scenario) return { error: `Scenario "${args.scenario_name}" not found.` };
        const { getSimResults } = await import('../../simulation/index.js');
        const results = getSimResults(scenario.id);
        return {
          name: scenario.name,
          config: JSON.parse(scenario.config_json),
          runs: results.length,
          latest: results[0] ? { type: results[0].result_type, date: new Date(results[0].created_at).toLocaleString() } : null,
        };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Simulation tool error');
    return { error: message };
  }
}
