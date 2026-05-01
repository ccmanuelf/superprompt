import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import { saveDOE, listDOEs, getDOE, type DOEConfig, DESIGN_LABELS } from '../../doe/index.js';
import {
  calculateDoeMatrix,
  calculateDoeAnalysis,
} from '../../calculations/doe.js';

export const doeDefinition: Tool = {
  type: 'function',
  function: {
    name: 'design_of_experiments',
    description: `Design of Experiments (DOE) tool for statistical experiment planning and analysis.

Actions:
- generate: Generate experiment matrix. Requires config_json.
- analyze: Analyze results (with response data). Requires config_json + matrix_json.
- list: List saved experiments.
- load: Load a saved experiment. Requires experiment_name.

Config: { name, design_type("full_factorial"/"fractional"/"taguchi"/"box_behnken"/"central_composite"), factors: [{id, name, type:"numeric", levels:[low,high]}], responses: [{id, name, minimize?, target?}], replicates?, randomize? }

Outputs: experiment matrix, ANOVA (F-test, p-values, contribution %), main effects, interactions, desirability optimization.

Web UI: /doe`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'analyze', 'list', 'load'] },
        config_json: { type: 'string' },
        matrix_json: { type: 'string' },
        experiment_name: { type: 'string' },
      },
      required: ['action'],
    },
  },
};

export async function designOfExperiments(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (args.action as string) {
      case 'generate': {
        if (!args.config_json) return { error: 'config_json required.' };
        const config = JSON.parse(args.config_json as string) as DOEConfig;
        const matrix = calculateDoeMatrix(config, {}, 'standard').value;
        if (config.name) await saveDOE(config.name, { config, matrix });
        return {
          success: true,
          design: DESIGN_LABELS[config.design_type],
          total_runs: matrix.total_runs,
          factors: matrix.factors,
          responses: matrix.responses,
          note: 'Matrix generated. Fill in response values and call analyze.',
        };
      }
      case 'analyze': {
        if (!args.config_json || !args.matrix_json) return { error: 'config_json and matrix_json required.' };
        const config = JSON.parse(args.config_json as string) as DOEConfig;
        const matrix = JSON.parse(args.matrix_json as string);
        const analysis = calculateDoeAnalysis({ config, matrix }, {}, 'standard').value;
        if (config.name) await saveDOE(config.name, { config, matrix }, analysis);
        return {
          success: true,
          anova: analysis.anova.map((a) => ({
            response: a.response_name,
            r_squared: a.r_squared.toFixed(4),
            significant_factors: a.rows.filter((r) => r.significant).map((r) => `${r.source} (p=${r.p_value.toFixed(4)})`),
          })),
          main_effects: analysis.main_effects.map((e) => `${e.factor_name}: effect=${e.effect_size.toFixed(4)}`),
          desirability: analysis.desirability ? `${(analysis.desirability.overall_desirability * 100).toFixed(0)}%` : 'N/A',
        };
      }
      case 'list': {
        const exps = await listDOEs();
        return { success: true, experiments: exps.map((e) => ({ name: e.name, updated: new Date(e.updated_at).toISOString() })) };
      }
      case 'load': {
        const name = args.experiment_name as string;
        if (!name) return { error: 'experiment_name required.' };
        const exp = await getDOE(name);
        if (!exp) return { error: `"${name}" not found.` };
        return { success: true, name: exp.name, has_result: !!exp.result_json };
      }
      default: return { error: `Unknown action: ${args.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'design_of_experiments error');
    return { error: msg };
  }
}
