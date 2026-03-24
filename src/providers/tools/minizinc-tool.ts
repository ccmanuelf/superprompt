import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  isMiniZincAvailable, optimizeOperators, optimizeSequence,
  optimizeSchedule, rebalanceLine,
} from '../../minizinc.js';

export const minizincOptimizeDefinition: Tool = {
  type: 'function',
  function: {
    name: 'minizinc_optimize',
    description: `MiniZinc constraint optimization for manufacturing. Four models:
- operators: Minimize headcount while meeting throughput. Requires input_json with {stations:[{name,sam_per_piece}], available_minutes, demand}.
- sequence: Minimize changeover time. Requires input_json with {products:[], changeover_matrix:[][]}.
- schedule: Minimize labor cost. Requires input_json with {days, shifts_per_day, min/max_operators_per_shift, demand_per_day:[], capacity_per_operator_per_shift, operator_cost_per_shift}.
- rebalance: Redistribute fixed headcount. Requires input_json with {stations:[{name,current_operators,utilization_pct,sam_per_piece}], total_operators, available_minutes, demand}.`,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['operators', 'sequence', 'schedule', 'rebalance'] },
        input_json: { type: 'string', description: 'Input parameters as JSON string' },
      },
      required: ['type', 'input_json'],
    },
  },
};

export function minizincOptimize(args: Record<string, unknown>): Record<string, unknown> {
  try {
    if (!isMiniZincAvailable()) return { error: 'MiniZinc solver not available on this system.' };

    const type = args.type as string;
    const input = JSON.parse(args.input_json as string);

    switch (type) {
      case 'operators': {
        const result = optimizeOperators(input);
        if (!result) return { error: 'Optimization failed — no feasible solution.' };
        return { success: true, ...result, message: `Minimum ${result.total_operators} operators needed.` };
      }
      case 'sequence': {
        const result = optimizeSequence(input);
        if (!result) return { error: 'Optimization failed.' };
        return { success: true, ...result, message: `Optimal: ${result.product_order.join(' → ')} (${result.total_changeover_minutes} min changeover)` };
      }
      case 'schedule': {
        const result = optimizeSchedule(input);
        if (!result) return { error: 'Optimization failed.' };
        return { success: true, ...result, message: `Total cost: $${result.total_cost}` };
      }
      case 'rebalance': {
        const result = rebalanceLine(input);
        if (!result) return { error: 'Optimization failed.' };
        return { success: true, ...result, message: `Max utilization after rebalancing: ${result.max_utilization_after}%` };
      }
      default:
        return { error: `Unknown type: ${type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'MiniZinc tool error');
    return { error: message };
  }
}
