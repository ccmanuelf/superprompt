import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  calculateDispatchSchedule,
  calculateRuleComparison,
  calculateGeneticSchedule,
} from '../../calculations/sequencer.js';
import { parseCalcMode } from '../../calculations/handler-boundary.js';
import { buildAssumptionSnapshot } from '../../assumptions.js';
import {
  saveSchedule,
  listSchedules,
  getSchedule,
  type SequencerConfig,
  type DispatchRule,
  type GAConfig,
} from '../../sequencer/index.js';

export const sequencerDefinition: Tool = {
  type: 'function',
  function: {
    name: 'job_sequencer',
    description: `Job-shop scheduling with dispatching rules and genetic algorithm optimization.

Actions:
- dispatch: Run a dispatching rule. Requires config_json + rule (FIFO/SPT/LPT/EDD/CR/SLACK).
- compare: Compare all 6 rules side-by-side. Requires config_json.
- ga: Run genetic algorithm optimization. Requires config_json. Optional: ga_config_json.
- list: List saved schedules.
- load: Load a saved schedule. Requires schedule_name.

Config format: { name, jobs: [{id, name, product, quantity, processing_minutes, due_date?, priority?}], machines: [{id, name}], setup_matrix?: [{from_product, to_product, setup_minutes}] }

Also available: web UI at /sequence on the web dashboard.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dispatch', 'compare', 'ga', 'list', 'load'] },
        config_json: { type: 'string', description: 'SequencerConfig as JSON string' },
        rule: { type: 'string', description: 'Dispatching rule: FIFO, SPT, LPT, EDD, CR, SLACK' },
        ga_config_json: { type: 'string', description: 'GAConfig as JSON string (optional)' },
        schedule_name: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function jobSequencer(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'dispatch': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SequencerConfig;
        const rule = (args.rule as DispatchRule) ?? 'SPT';
        const dispatchMode = parseCalcMode(args);
        const dispatchSnapshot = await buildAssumptionSnapshot('sequence', dispatchMode);
        const result = calculateDispatchSchedule({ config, rule }, dispatchSnapshot, dispatchMode).value;
        if (config.name) await saveSchedule(config.name + '_' + rule, config, result);
        return {
          success: true,
          rule,
          makespan: `${result.metrics.makespan.toFixed(0)} min`,
          on_time: `${result.metrics.on_time_pct.toFixed(0)}%`,
          late_jobs: result.metrics.num_late_jobs,
          setup_time: `${result.metrics.total_setup_time.toFixed(0)} min`,
          utilization: `${result.metrics.avg_utilization_pct.toFixed(0)}%`,
        };
      }

      case 'compare': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SequencerConfig;
        const compareMode = parseCalcMode(args);
        const compareSnapshot = await buildAssumptionSnapshot('sequence', compareMode);
        const comp = calculateRuleComparison(config, compareSnapshot, compareMode).value;
        if (config.name) await saveSchedule(config.name, config, comp);
        return {
          success: true,
          best_overall: comp.best_overall,
          best_makespan: comp.best_makespan,
          best_lateness: comp.best_lateness,
          recommendation: comp.recommendation,
          rules: comp.rules.map((r) => ({
            rule: r.rule_or_method,
            makespan: r.metrics.makespan.toFixed(0),
            on_time: `${r.metrics.on_time_pct.toFixed(0)}%`,
            late: r.metrics.num_late_jobs,
          })),
        };
      }

      case 'ga': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as SequencerConfig;
        const gaConfig = args.ga_config_json ? JSON.parse(args.ga_config_json as string) as Partial<GAConfig> : undefined;
        const gaMode = parseCalcMode(args);
        const gaSnapshot = await buildAssumptionSnapshot('sequence', gaMode);
        const result = calculateGeneticSchedule({ config, gaConfig }, gaSnapshot, gaMode).value;
        if (config.name) await saveSchedule(config.name + '_GA', config, result);
        return {
          success: true,
          makespan: `${result.metrics.makespan.toFixed(0)} min`,
          on_time: `${result.metrics.on_time_pct.toFixed(0)}%`,
          best_fitness: result.best_fitness,
          converged_at: result.convergence_generation,
          computation_ms: result.computation_ms,
        };
      }

      case 'list': {
        const schedules = await listSchedules();
        if (schedules.length === 0) return { success: true, message: 'No saved schedules.' };
        return {
          success: true,
          schedules: schedules.map((s) => ({ name: s.name, updated: new Date(s.updated_at).toISOString() })),
        };
      }

      case 'load': {
        const name = args.schedule_name as string;
        if (!name) return { error: 'schedule_name is required.' };
        const sched = await getSchedule(name);
        if (!sched) return { error: `Schedule "${name}" not found.` };
        const config = JSON.parse(sched.config_json);
        return {
          success: true,
          name: sched.name,
          jobs: config.jobs?.length ?? 0,
          machines: config.machines?.length ?? 0,
        };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'job_sequencer tool error');
    return { error: message };
  }
}
