import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  validateSimulationConfig,
  saveScenario, getScenarioByName, listScenarios,
  formatSimulationResults,
  type SimulationConfig,
} from '../../simulation/index.js';
import {
  calculateSimulationMetrics,
  calculateMonteCarloMetrics,
} from '../../calculations/simulation.js';
import { parseCalcMode } from '../../calculations/handler-boundary.js';
import { buildAssumptionSnapshot } from '../../assumptions.js';

export const simulationDefinition: Tool = {
  type: 'function',
  function: {
    name: 'production_simulation',
    description: `Production line discrete-event simulation. Models bundles flowing through sequential operations with resource pooling, stochastic variability, rework, and breakdowns.

Actions:
- run: Run simulation. Requires config_json (JSON string of SimulationConfig). Optional: scenario_name to save.
- monte_carlo: Run N replications. Requires config_json. Optional: replications (default 30).
- optimize_validate: Auto-chain: MiniZinc optimizes → applies to config → Monte Carlo validates → reports confidence. Requires config_json. Optional: optimization_type (operators/rebalance), replications.
- validate: Validate config. Requires config_json.
- list: List saved scenarios.
- status: Show scenario results. Requires scenario_name.

CRITICAL — Multi-product / multi-cell modelling:
- Each distinct product, cell, or parallel line MUST have its own set of operation rows with a unique "product" identifier. Do NOT merge cells/products into a single serial chain. A plant with 5 parallel cells → operations[] contains rows with 5 distinct "product" values.
- Each product MUST have its own entry in demands[] with daily_demand set from the real data, not a default.
- If the source spreadsheet has multiple sheets (e.g. cycle times, scenarios, restrictions, observations), READ EVERY SHEET before building config_json. Cell names, operation counts, and demand figures are usually spread across different sheets.
- Default / template / placeholder configs ("PROD-001" with generic operations like "Corte/Doblado/Soldadura") are UNACCEPTABLE when real data is available. Use the exact cell names, operations, and SAMs from the parsed Excel.

Config format: { operations: [{product, step, operation, machine_tool, sam_min, operators?, grade_pct?, fpd_pct?, rework_pct?}], schedule: {shifts_enabled, shift1_hours, work_days}, demands: [{product, bundle_size?, daily_demand?}], breakdowns?: [{machine_tool, breakdown_pct}], mode?: "demand-driven", horizon_days?: 1 }

Also available: web UI at /sim on the web dashboard.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'monte_carlo', 'optimize_validate', 'validate', 'list', 'status'] },
        optimization_type: { type: 'string', description: 'For optimize_validate: operators or rebalance' },
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

        const mode = parseCalcMode(args);
        const snapshot = await buildAssumptionSnapshot('simulation', mode);
        const results = (await calculateSimulationMetrics(
          { config, validationReport: report },
          snapshot,
          mode,
        )).value;

        if (args.scenario_name) {
          const scenario = await saveScenario(args.scenario_name as string, config);
          const { saveSimResult } = await import('../../simulation/index.js');
          await saveSimResult(scenario.id, 'single', results);
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

        const mcMode = parseCalcMode(args);
        const mcSnapshot = await buildAssumptionSnapshot('simulation', mcMode);
        const mc = (await calculateMonteCarloMetrics(
          { config, replications: reps },
          mcSnapshot,
          mcMode,
        )).value;
        return {
          success: true,
          replications: mc.replications,
          throughput: mc.throughput,
          cycle_time: mc.cycle_time,
          demand_met_pct: mc.demand_met_pct,
          message: `Monte Carlo: ${mc.replications} reps. Throughput mean=${mc.throughput.mean} P5=${mc.throughput.p5} P95=${mc.throughput.p95}. Demand met ${mc.demand_met_pct}% of runs.`,
        };
      }

      case 'optimize_validate': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SimulationConfig;
        const { optimizeAndValidate } = await import('../../minizinc.js');
        const optType = (args.optimization_type as string) || 'operators';

        const result = await optimizeAndValidate({
          optimization_type: optType as 'operators' | 'rebalance',
          config,
          replications: (args.replications as number) || 30,
        });

        if (!result) return { error: 'Optimization found no feasible solution.' };

        return {
          success: true,
          confidence: result.confidence,
          recommendation: result.recommendation,
          original_throughput: result.original_throughput,
          optimized_mean_throughput: result.optimized_throughput.mean,
          demand_met_pct: result.demand_met_pct,
          improvement_pct: result.improvement_pct,
          message: `[${result.confidence}] ${result.recommendation} Throughput: ${result.original_throughput} → ${result.optimized_throughput.mean} (${result.improvement_pct > 0 ? '+' : ''}${result.improvement_pct}%)`,
        };
      }

      case 'validate': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SimulationConfig;
        return validateSimulationConfig(config) as unknown as Record<string, unknown>;
      }

      case 'list': {
        const scenarios = await listScenarios();
        if (scenarios.length === 0) return { message: 'No saved scenarios.' };
        return { scenarios: scenarios.map(s => ({ name: s.name, updated: new Date(s.updated_at).toLocaleString() })) };
      }

      case 'status': {
        if (!args.scenario_name) return { error: 'scenario_name is required.' };
        const scenario = await getScenarioByName(args.scenario_name as string);
        if (!scenario) return { error: `Scenario "${args.scenario_name}" not found.` };
        const { getSimResults } = await import('../../simulation/index.js');
        const results = await getSimResults(scenario.id);
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
