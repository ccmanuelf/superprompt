import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import { saveConwip, listConwips, type CONWIPConfig, type HeijunkaConfig } from '../../conwip/index.js';
import {
  calculateConwipMetrics,
  calculateHeijunkaMetrics,
} from '../../calculations/conwip.js';
import { parseCalcMode } from '../../calculations/handler-boundary.js';
import { buildAssumptionSnapshot } from '../../assumptions.js';

export const conwipDefinition: Tool = {
  type: 'function',
  function: {
    name: 'conwip_heijunka',
    description: `CONWIP (Constant WIP) and Heijunka (production leveling) analysis.

Actions:
- conwip: Analyze CONWIP system. Requires config_json (CONWIPConfig).
- heijunka: Level production mix. Requires config_json (HeijunkaConfig).
- list: List saved configs.

CONWIP config: { name, stages: [{id, name, sequence, cycle_time_minutes, capacity_per_hour}], wip_limit, products: [{id, name, mix_pct}], available_minutes_per_day, demand_per_day }
Heijunka config: { name, products: [{id, name, mix_pct, cycle_time_minutes, changeover_minutes}], takt_time_minutes, pitch_minutes, pack_out_quantity, slots_per_shift, shifts_per_day, demand_per_day }

Web UI: /conwip`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['conwip', 'heijunka', 'list'] },
        config_json: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function conwipHeijunka(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (args.action as string) {
      case 'conwip': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as CONWIPConfig;
        const conwipMode = parseCalcMode(args);
        const conwipSnapshot = await buildAssumptionSnapshot('conwip', conwipMode);
        const result = calculateConwipMetrics(config, conwipSnapshot, conwipMode).value;
        if (config.name) await saveConwip(config.name, config, result);
        return {
          success: true, wip_limit: result.wip_limit,
          throughput: `${result.throughput_per_hour.toFixed(1)} u/hr`,
          cycle_time: `${result.avg_cycle_time.toFixed(1)} min`,
          wip_turns: `${result.wip_turns_per_day.toFixed(1)}/day`,
          recommendations: result.recommendations,
        };
      }
      case 'heijunka': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as HeijunkaConfig;
        const heijunkaMode = parseCalcMode(args);
        const heijunkaSnapshot = await buildAssumptionSnapshot('heijunka', heijunkaMode);
        const result = calculateHeijunkaMetrics(config, heijunkaSnapshot, heijunkaMode).value;
        if (config.name) await saveConwip(config.name, config, result);
        return {
          success: true, leveling_score: result.leveling_score,
          takt: `${result.takt_time.toFixed(1)} min`, pitch: `${result.pitch.toFixed(1)} min`,
          changeovers: result.changeover_count,
          mix: result.actual_mix.map((m) => `${m.product_name}: ${m.actual_pct.toFixed(1)}% (target ${m.target_pct}%)`),
          suggestions: result.changeover_suggestions,
        };
      }
      case 'list': {
        const configs = await listConwips();
        return { success: true, configs: configs.map((c) => ({ name: c.name, updated: new Date(c.updated_at).toISOString() })) };
      }
      default: return { error: `Unknown action: ${args.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'conwip_heijunka error');
    return { error: msg };
  }
}
