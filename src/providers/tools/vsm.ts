import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  analyzeVSM,
  compareStates,
  saveVSM,
  listVSMs,
  getVSM,
  type VSMConfig,
} from '../../vsm/index.js';

export const vsmDefinition: Tool = {
  type: 'function',
  function: {
    name: 'value_stream_map',
    description: `Value Stream Mapping tool for lean manufacturing analysis.

Actions:
- analyze: Analyze a value stream. Requires config_json (VSMConfig).
- compare: Compare current vs future state. Requires current_json + future_json.
- list: List saved VSM maps.
- load: Load a saved map. Requires map_name.

Config format: { name, product_family, customer_demand_per_day, available_minutes_per_day, state("current"/"future"), steps: [{id, name, sequence, cycle_time, changeover_time, uptime_pct, category("VA"/"NVA"/"BNVA"), operators, wait_time?, transport_time?, wip_before?}] }

Key outputs: PCE (Process Cycle Efficiency), lead time breakdown, TIMWOODS waste analysis, takt time.

Also available: web UI at /vsm on the web dashboard.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'compare', 'list', 'load'] },
        config_json: { type: 'string', description: 'VSMConfig as JSON string' },
        current_json: { type: 'string', description: 'Current state VSMConfig (for compare)' },
        future_json: { type: 'string', description: 'Future state VSMConfig (for compare)' },
        map_name: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function valueStreamMap(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const action = args.action as string;

    switch (action) {
      case 'analyze': {
        if (!args.config_json) return { error: 'config_json is required.' };
        const config = JSON.parse(args.config_json as string) as VSMConfig;
        const result = analyzeVSM(config);
        if (config.name) saveVSM(config.name, config, result);

        return {
          success: true,
          pce_pct: `${result.pce_pct.toFixed(1)}%`,
          takt_time: `${result.takt_time.toFixed(2)} min`,
          lead_time: `${result.total_lead_time.toFixed(1)} min`,
          va_time: `${result.total_va_time.toFixed(1)} min`,
          nva_time: `${result.total_nva_time.toFixed(1)} min`,
          wait_time: `${result.total_wait_time.toFixed(1)} min`,
          wip: `${result.total_wip_units} units (${result.total_wip_days.toFixed(1)} days)`,
          bottleneck: result.bottleneck_step,
          top_waste: result.timwoods.filter((t) => t.total_minutes > 0).slice(0, 3).map((t) =>
            `${t.label}: ${t.total_minutes.toFixed(0)}min — ${t.suggestion}`),
        };
      }

      case 'compare': {
        if (!args.current_json || !args.future_json) return { error: 'current_json and future_json required.' };
        const current = JSON.parse(args.current_json as string) as VSMConfig;
        const future = JSON.parse(args.future_json as string) as VSMConfig;
        const comp = compareStates(current, future);
        return {
          success: true,
          summary: comp.summary,
          improvements: comp.improvements.map((i) =>
            `${i.metric}: ${i.current_value} → ${i.future_value} (${i.change_pct >= 0 ? '+' : ''}${i.change_pct.toFixed(1)}%)`),
        };
      }

      case 'list': {
        const maps = listVSMs();
        if (maps.length === 0) return { success: true, message: 'No saved VSM maps.' };
        return { success: true, maps: maps.map((m) => ({ name: m.name, updated: new Date(m.updated_at).toISOString() })) };
      }

      case 'load': {
        const name = args.map_name as string;
        if (!name) return { error: 'map_name is required.' };
        const vsm = getVSM(name);
        if (!vsm) return { error: `Map "${name}" not found.` };
        const config = JSON.parse(vsm.config_json);
        const result = vsm.result_json ? JSON.parse(vsm.result_json) : null;
        return {
          success: true,
          name: vsm.name,
          steps: config.steps?.length ?? 0,
          state: config.state,
          pce: result ? `${result.pce_pct?.toFixed(1)}%` : 'not analyzed',
        };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'value_stream_map tool error');
    return { error: message };
  }
}
