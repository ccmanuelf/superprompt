import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import { saveTOC, listTOCs, getTOC, type TOCConfig } from '../../toc/index.js';
import { calculateTocMetrics } from '../../calculations/toc.js';
import { parseCalcMode } from '../../calculations/handler-boundary.js';
import { buildAssumptionSnapshot } from '../../assumptions.js';

export const tocDefinition: Tool = {
  type: 'function',
  function: {
    name: 'toc_analysis',
    description: `Theory of Constraints (TOC) analysis — Goldratt's 5 Focusing Steps.

Actions:
- analyze: Run TOC analysis. Requires config_json.
- list: List saved TOC configs.
- load: Load a saved config. Requires config_name.

Config format: { name, work_centers: [{id, name, capacity_units_per_hour, available_hours_per_day, operators, current_wip}], selling_price_per_unit, total_variable_cost_per_unit, operating_expense_per_period, investment, demand_units_per_day, available_hours_per_day }

Outputs: CCR identification, throughput accounting (T/OE/NP/ROI), DBR schedule, buffer status, WIP gauges, 5 focusing steps.

Web UI: /toc`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'list', 'load'] },
        config_json: { type: 'string' },
        config_name: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function tocAnalysis(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;
    switch (action) {
      case 'analyze': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as TOCConfig;
        const mode = parseCalcMode(args);
        const snapshot = await buildAssumptionSnapshot('toc', mode);
        const result = calculateTocMetrics(config, snapshot, mode).value;
        if (config.name) await saveTOC(config.name, config, result);
        return {
          success: true,
          ccr: `${result.constraint.ccr_name} at ${result.constraint.ccr_utilization_pct.toFixed(1)}%`,
          throughput_per_unit: `$${result.throughput.throughput_per_unit.toFixed(2)}`,
          net_profit: `$${result.throughput.net_profit.toLocaleString()}/mo`,
          roi: `${result.throughput.roi_pct.toFixed(1)}%`,
          revenue_lost_per_constraint_hour: `$${result.throughput.revenue_lost_per_hour_constraint_down.toLocaleString()}`,
          five_steps: result.five_focusing_steps,
        };
      }
      case 'list': {
        const configs = await listTOCs();
        if (configs.length === 0) return { success: true, message: 'No saved TOC configs.' };
        return { success: true, configs: configs.map((c) => ({ name: c.name, updated: new Date(c.updated_at).toISOString() })) };
      }
      case 'load': {
        const name = args.config_name as string;
        if (!name) return { error: 'config_name required.' };
        const toc = await getTOC(name);
        if (!toc) return { error: `"${name}" not found.` };
        return { success: true, name: toc.name, work_centers: JSON.parse(toc.config_json).work_centers?.length ?? 0 };
      }
      default: return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'toc_analysis tool error');
    return { error: msg };
  }
}
