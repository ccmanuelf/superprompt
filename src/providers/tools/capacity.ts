import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  analyzeCapacity,
  runScenario,
  runCapacityMonteCarlo,
  calculateROI,
  savePlan,
  listPlans,
  getPlan,
  generateCapacityUtilizationChart,
  type CapacityPlanConfig,
  type ScenarioParams,
  type ROIInput,
} from '../../capacity/index.js';

export const capacityDefinition: Tool = {
  type: 'function',
  function: {
    name: 'capacity_planning',
    description: `Manufacturing capacity planning with 12-step analysis methodology.

Actions:
- analyze: Run capacity analysis. Requires config_json (JSON string of CapacityPlanConfig).
- scenario: Run what-if scenario. Requires config_json + scenario_json.
- monte_carlo: Run Monte Carlo analysis (N replications with stochastic variation). Requires config_json. Optional: replications (default 1000).
- roi: Calculate investment ROI. Requires roi_json (JSON string of ROIInput: scenario_name, investment_cost, capacity_gain_hours, revenue_per_unit, units_per_hour).
- list: List saved capacity plans.
- load: Load a saved plan. Requires plan_name.

Config format: { name, period_label, period_start, period_end, lines: [{id, code, name, max_operators, efficiency_factor(0-1), absenteeism_factor(0-1)}], calendar: {working_days, shifts_per_day, hours_per_shift}, demands: [{product, line_id, quantity, sam_minutes?, hours?}] }

Scenario types: overtime, three_shift, efficiency_improvement, absenteeism_spike, subcontract, setup_reduction, new_line, multi_constraint.

Also available: web UI at /capacity on the web dashboard.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'scenario', 'monte_carlo', 'roi', 'list', 'load'] },
        config_json: { type: 'string', description: 'CapacityPlanConfig as JSON string' },
        scenario_json: { type: 'string', description: 'ScenarioParams as JSON string (for scenario action)' },
        roi_json: { type: 'string', description: 'ROIInput as JSON string (for roi action)' },
        plan_name: { type: 'string', description: 'Plan name to save or load' },
        replications: { type: 'number', description: 'Monte Carlo replications (default 1000)' },
      },
      required: ['action'],
    },
  },
};

export async function capacityPlanning(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'analyze': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as CapacityPlanConfig;
        const result = analyzeCapacity(config);

        // Auto-save
        if (config.name) {
          await savePlan(config.name, config, result);
        }

        // Generate chart
        let chart: string | undefined;
        try {
          chart = await generateCapacityUtilizationChart(result.lines, config.name);
        } catch { /* chart optional */ }

        return {
          success: true,
          overall_utilization: `${result.overall_utilization_pct.toFixed(1)}%`,
          total_capacity_hours: result.total_capacity_hours,
          total_demand_hours: result.total_demand_hours,
          bottleneck_count: result.bottleneck_count,
          lines: result.lines.map((l) => ({
            line: l.line_code,
            utilization: `${l.utilization_pct.toFixed(1)}%`,
            capacity: `${l.capacity_hours.toFixed(1)}h`,
            demand: `${l.demand_hours.toFixed(1)}h`,
            status: l.bottleneck_severity,
          })),
          constraint_ranking: result.constraint_ranking.map((c) => ({
            rank: c.rank,
            line: c.line_code,
            utilization: `${c.utilization_pct.toFixed(1)}%`,
            recommendation: c.recommendation,
          })),
          chart_base64: chart,
        };
      }

      case 'scenario': {
        if (!args.config_json || !args.scenario_json) {
          return { error: 'config_json and scenario_json are required.' };
        }
        const config = JSON.parse(args.config_json as string) as CapacityPlanConfig;
        const scenario = JSON.parse(args.scenario_json as string) as ScenarioParams;
        const result = runScenario(config, scenario);

        return {
          success: true,
          scenario_name: result.scenario.name,
          baseline_utilization: `${result.baseline.overall_utilization_pct.toFixed(1)}%`,
          projected_utilization: `${result.projected.overall_utilization_pct.toFixed(1)}%`,
          capacity_change: `${result.delta.capacity_hours_change >= 0 ? '+' : ''}${result.delta.capacity_hours_change.toFixed(1)}h (${result.delta.capacity_hours_change_pct.toFixed(1)}%)`,
          bottlenecks_resolved: result.delta.bottlenecks_resolved,
          additional_cost: `$${result.delta.additional_cost.toLocaleString()}`,
          cost_per_unit: result.delta.cost_per_additional_unit < 999999
            ? `$${result.delta.cost_per_additional_unit.toFixed(2)}`
            : 'N/A',
        };
      }

      case 'monte_carlo': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as CapacityPlanConfig;
        const reps = (args.replications as number) || 1000;

        const mc = runCapacityMonteCarlo({ base_config: config, replications: reps });

        return {
          success: true,
          replications: mc.replications,
          mean_utilization: `${mc.overall_utilization.mean.toFixed(1)}%`,
          p5_p95: `${mc.overall_utilization.p5.toFixed(1)}% — ${mc.overall_utilization.p95.toFixed(1)}%`,
          bottleneck_probability: `${mc.bottleneck_probability.toFixed(1)}%`,
          confidence_95: `${mc.confidence_95.lower.toFixed(1)}% — ${mc.confidence_95.upper.toFixed(1)}%`,
        };
      }

      case 'roi': {
        if (!args.roi_json) return { error: 'roi_json is required.' };
        const input = JSON.parse(args.roi_json as string) as ROIInput;
        const result = calculateROI(input);

        return {
          success: true,
          payback_months: result.payback_months === Infinity ? 'Never' : `${result.payback_months.toFixed(1)} months`,
          npv: `$${Math.round(result.npv).toLocaleString()}`,
          roi_pct: `${result.roi_pct.toFixed(1)}%`,
          monthly_net_benefit: `$${Math.round(result.monthly_net_benefit).toLocaleString()}`,
          break_even_utilization: `${result.break_even_utilization_pct.toFixed(1)}%`,
          recommendation: result.recommendation,
        };
      }

      case 'list': {
        const plans = await listPlans();
        if (plans.length === 0) return { success: true, message: 'No saved plans.' };
        return {
          success: true,
          plans: plans.map((p) => ({
            name: p.name,
            has_result: !!p.result_json,
            updated: new Date(p.updated_at).toISOString(),
          })),
        };
      }

      case 'load': {
        const name = args.plan_name as string;
        if (!name) return { error: 'plan_name is required.' };
        const plan = await getPlan(name);
        if (!plan) return { error: `Plan "${name}" not found.` };

        const config = JSON.parse(plan.config_json);
        const result = plan.result_json ? JSON.parse(plan.result_json) : null;

        return {
          success: true,
          plan_name: plan.name,
          config_summary: {
            lines: config.lines?.length ?? 0,
            demands: config.demands?.length ?? 0,
            calendar: config.calendar,
          },
          result_summary: result ? {
            overall_utilization: `${result.overall_utilization_pct?.toFixed(1)}%`,
            bottleneck_count: result.bottleneck_count,
          } : null,
        };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'capacity_planning tool error');
    return { error: message };
  }
}
