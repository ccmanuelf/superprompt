import type { Tool } from 'ollama';
import { logger } from '../../logger.js';
import {
  executeInventoryAnalysis,
  listInventoryProjects,
  getInventoryProjectByName,
  getInventoryItems,
  getInventoryResults,
  deleteInventoryProject,
  generateReplenishmentPlan,
  abcClassification,
  exponentialSmoothing,
  formatReplenishmentPlan,
  generateAbcChart,
  generateForecastChart,
  type AbcItem,
  type ReplenishmentPlan,
  type ForecastResult,
} from '../../inventory.js';

export const inventoryPlanDefinition: Tool = {
  type: 'function',
  function: {
    name: 'inventory_plan',
    description: `Inventory planning and replenishment tool. EOQ, safety stock, ABC classification, demand forecasting.
Actions:
- plan: Run full inventory analysis on CSV data. Requires csv_content, project_name. Optional: demand_history (comma-separated period demands).
- abc: Show ABC classification for a project. Requires project_name.
- forecast: Run exponential smoothing on demand data. Requires demand_history (comma-separated), project_name.
- status: Show project status. Requires project_name.
- list: List all inventory projects.

CSV columns (required): item_id, annual_demand, unit_cost, order_cost, holding_cost_pct, lead_time_days
Optional columns: description, service_level (0-1, default 0.95), demand_stddev`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['plan', 'abc', 'forecast', 'status', 'list'],
        },
        csv_content: { type: 'string', description: 'Raw CSV content (for plan action)' },
        project_name: { type: 'string', description: 'Project name' },
        demand_history: { type: 'string', description: 'Comma-separated demand values per period (for forecast)' },
      },
      required: ['action'],
    },
  },
};

export async function inventoryPlan(
  args: {
    action: string;
    csv_content?: string;
    project_name?: string;
    demand_history?: string;
  },
  chatId: string,
): Promise<Record<string, unknown>> {
  try {
    switch (args.action) {
      case 'plan': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const demandHistory = args.demand_history
          ? args.demand_history.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n))
          : undefined;

        const { project, plans, abc, forecast, stockoutRisks } = executeInventoryAnalysis(
          args.csv_content, args.project_name, demandHistory,
        );

        const summary = formatReplenishmentPlan(plans, abc, false);

        return {
          success: true,
          project_id: project.id,
          summary,
          items: plans.length,
          total_annual_cost: plans.reduce((s, p) => s + p.total_annual_cost, 0),
          abc_counts: {
            A: abc.filter((i) => i.classification === 'A').length,
            B: abc.filter((i) => i.classification === 'B').length,
            C: abc.filter((i) => i.classification === 'C').length,
          },
          stockout_risks: stockoutRisks,
          forecast: forecast ? { mape: forecast.mape, next_period: forecast.forecasts[forecast.forecasts.length - 1] } : null,
        };
      }

      case 'abc': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = getInventoryProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const results = getInventoryResults(project.id);
        const abcResult = results.find((r) => r.result_type === 'abc');
        if (!abcResult) return { error: 'No ABC data. Run plan analysis first.' };

        const abc = JSON.parse(abcResult.result_json) as AbcItem[];
        const filePath = await generateAbcChart(abc, args.project_name);

        return {
          success: true,
          file: filePath,
          abc: abc.map((i) => ({ item_id: i.item_id, class: i.classification, dollar_vol: i.annual_dollar_volume })),
        };
      }

      case 'forecast': {
        if (!args.demand_history) return { error: 'demand_history is required (comma-separated).' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const demands = args.demand_history.split(',').map((s) => parseFloat(s.trim()));
        if (demands.some(isNaN)) return { error: 'All demand values must be numbers.' };

        const forecast = exponentialSmoothing(demands);
        const filePath = await generateForecastChart(forecast, args.project_name);

        return {
          success: true,
          file: filePath,
          alpha: forecast.alpha,
          mape: forecast.mape,
          mad: forecast.mad,
          next_period_forecast: forecast.forecasts[forecast.forecasts.length - 1],
        };
      }

      case 'status': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = getInventoryProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const items = getInventoryItems(project.id);
        const results = getInventoryResults(project.id);

        return {
          project: { name: project.name, items: items.length, analyses: results.length },
        };
      }

      case 'list': {
        const projects = listInventoryProjects();
        if (projects.length === 0) return { message: 'No inventory projects found.' };
        return {
          projects: projects.map((p) => ({
            name: p.name,
            updated: new Date(p.updated_at).toLocaleString(),
          })),
        };
      }

      default:
        return { error: `Unknown action: ${args.action}. Use plan, abc, forecast, status, or list.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, action: args.action }, 'Inventory plan error');
    return { error: message };
  }
}
