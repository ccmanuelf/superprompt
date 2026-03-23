import type { Tool } from 'ollama';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../../logger.js';
import { STORE_DIR } from '../../config.js';
import {
  executeCapabilityAnalysis,
  calculateDpmo,
  rolledThroughputYield,
  paretoAnalysis,
  listSigmaProjects,
  getSigmaProjectByName,
  getMeasurements,
  getSigmaResults,
  deleteSigmaProject,
  formatCapabilityResult,
  generateControlChart,
  generateParetoChart,
  generateCapabilityChart,
  generateCusumChart,
  generateEwmaChart,
  generateAttributeChart,
  parseSigmaCsv,
  cusumChart,
  ewmaChart,
  trendRegression,
  pChart,
  cChart,
  type CapabilityResult,
  type ControlChartData,
  type SpecLimits,
} from '../../sigma.js';

export const sigmaAnalysisDefinition: Tool = {
  type: 'function',
  function: {
    name: 'sigma_analysis',
    description: `Six Sigma SPC platform — capability analysis, control charts, shift detection, trend analysis.
Actions:
- capability: Capability analysis (Cp, Cpk, Pp, Ppk). Requires csv_content, usl, lsl, project_name.
- dpmo: DPMO and sigma level. Requires defects, units, opportunities.
- rty: Rolled throughput yield. Requires step_yields (comma-separated).
- chart: Control chart (I-MR or X-bar/R). Requires project_name.
- cusum: CUSUM chart for small shift detection. Requires csv_content, project_name. Optional: target.
- ewma: EWMA chart for gradual drift. Requires csv_content, project_name. Optional: target, lambda.
- trend: Trend regression with predicted OOS date. Requires csv_content, project_name. Optional: usl, lsl.
- p_chart: p-chart (proportion defective). Requires csv_content (value=defectives, subgroup=sample_size), project_name.
- c_chart: c-chart (defect count). Requires csv_content (value=defect_count), project_name.
- pareto: Pareto chart of defect types. Requires project_name.
- status: Project status. Requires project_name.
- list: List projects.

CSV: value (required), subgroup (optional), timestamp (optional), defect_type (optional).`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['capability', 'dpmo', 'rty', 'chart', 'cusum', 'ewma', 'trend', 'p_chart', 'c_chart', 'pareto', 'status', 'list'],
        },
        csv_content: { type: 'string', description: 'Raw CSV content (for capability action)' },
        usl: { type: 'number', description: 'Upper spec limit (for capability)' },
        lsl: { type: 'number', description: 'Lower spec limit (for capability)' },
        target: { type: 'number', description: 'Target value (optional, for Cpm calculation)' },
        project_name: { type: 'string', description: 'Project name' },
        defects: { type: 'number', description: 'Number of defects (for dpmo)' },
        units: { type: 'number', description: 'Number of units inspected (for dpmo)' },
        opportunities: { type: 'number', description: 'Defect opportunities per unit (for dpmo)' },
        step_yields: { type: 'string', description: 'Comma-separated step yield percentages (for rty)' },
        lambda: { type: 'number', description: 'EWMA smoothing factor (0-1, default 0.2)' },
      },
      required: ['action'],
    },
  },
};

export async function sigmaAnalysis(
  args: {
    action: string;
    csv_content?: string;
    usl?: number;
    lsl?: number;
    target?: number;
    project_name?: string;
    defects?: number;
    units?: number;
    opportunities?: number;
    lambda?: number;
    step_yields?: string;
  },
  chatId: string,
): Promise<Record<string, unknown>> {
  try {
    switch (args.action) {
      case 'capability': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (args.usl === undefined || args.lsl === undefined) return { error: 'usl and lsl are required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const { project, capability, controlChart } = executeCapabilityAnalysis(
          args.csv_content, args.usl, args.lsl, args.project_name, args.target,
        );

        const summary = formatCapabilityResult(capability, controlChart, args.project_name, false);

        return {
          success: true,
          project_id: project.id,
          summary,
          cp: capability.cp,
          cpk: capability.cpk,
          pp: capability.pp,
          ppk: capability.ppk,
          within_spec_pct: capability.within_spec_pct,
          violations: controlChart.violations.length,
        };
      }

      case 'dpmo': {
        if (args.defects === undefined || args.units === undefined || args.opportunities === undefined) {
          return { error: 'defects, units, and opportunities are required.' };
        }
        const result = calculateDpmo(args.defects, args.units, args.opportunities);
        return {
          success: true,
          ...result,
          message: `DPMO: ${result.dpmo.toLocaleString()} | Sigma Level: ${result.sigma_level.toFixed(2)} | Yield: ${result.yield_pct.toFixed(2)}%`,
        };
      }

      case 'rty': {
        if (!args.step_yields) return { error: 'step_yields is required (comma-separated percentages).' };
        const yields = args.step_yields.split(',').map((s) => parseFloat(s.trim()));
        if (yields.some(isNaN)) return { error: 'All step yields must be numbers.' };
        const rty = rolledThroughputYield(yields);
        return {
          success: true,
          step_yields: yields,
          rty,
          message: `Rolled Throughput Yield: ${rty.toFixed(2)}% from ${yields.length} steps`,
        };
      }

      case 'chart': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = getSigmaProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const measurements = getMeasurements(project.id);
        if (measurements.length < 2) return { error: 'Need at least 2 measurements for control chart.' };

        const results = getSigmaResults(project.id);
        const chartResult = results.find((r) => r.result_type === 'control_chart');
        if (!chartResult) return { error: 'No control chart data. Run capability analysis first.' };

        const chartData = JSON.parse(chartResult.result_json) as ControlChartData;
        const filePath = await generateControlChart(chartData, args.project_name);

        return { success: true, file: filePath, violations: chartData.violations.length };
      }

      case 'pareto': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = getSigmaProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const measurements = getMeasurements(project.id);
        const hasDefectTypes = measurements.some((m) => m.defect_type);
        if (!hasDefectTypes) return { error: 'No defect_type data. CSV must include a defect_type column.' };

        const pareto = paretoAnalysis(measurements);
        const filePath = await generateParetoChart(pareto, args.project_name);

        return {
          success: true,
          file: filePath,
          pareto: pareto.slice(0, 10),
          message: `Top defect: "${pareto[0].category}" (${pareto[0].count} occurrences, ${pareto[0].cumulative_pct}% cumulative)`,
        };
      }

      case 'status': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = getSigmaProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const measurements = getMeasurements(project.id);
        const results = getSigmaResults(project.id);
        const capResult = results.find((r) => r.result_type === 'capability');

        return {
          project: {
            name: project.name,
            usl: project.usl,
            lsl: project.lsl,
            target: project.target,
            measurements: measurements.length,
            analyses: results.length,
          },
          latest_capability: capResult ? JSON.parse(capResult.result_json) : null,
        };
      }

      case 'list': {
        const projects = listSigmaProjects();
        if (projects.length === 0) return { message: 'No sigma projects found.' };
        return {
          projects: projects.map((p) => ({
            name: p.name,
            usl: p.usl,
            lsl: p.lsl,
            updated: new Date(p.updated_at).toLocaleString(),
          })),
        };
      }

      case 'cusum': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const rows = parseSigmaCsv(args.csv_content);
        const values = rows.map((r) => r.value);
        const data = cusumChart(values, args.target);
        const filePath = await generateCusumChart(data, args.project_name);

        return {
          success: true, file: filePath,
          shifts: data.violations.length,
          message: data.violations.length > 0
            ? `CUSUM detected ${data.violations.length} shift(s) — process mean has changed.`
            : 'No significant shifts detected.',
        };
      }

      case 'ewma': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const rows = parseSigmaCsv(args.csv_content);
        const values = rows.map((r) => r.value);
        const data = ewmaChart(values, args.lambda ?? 0.2, 3, args.target);
        const filePath = await generateEwmaChart(data, args.project_name);

        return {
          success: true, file: filePath,
          violations: data.violations.length,
          lambda: data.lambda,
          message: data.violations.length > 0
            ? `EWMA detected ${data.violations.length} violation(s) — gradual drift detected.`
            : 'Process stable — no drift detected.',
        };
      }

      case 'trend': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const rows = parseSigmaCsv(args.csv_content);
        const values = rows.map((r) => r.value);
        const spec = (args.usl !== undefined && args.lsl !== undefined)
          ? { usl: args.usl, lsl: args.lsl } : undefined;
        const result = trendRegression(values, spec);

        return {
          success: true,
          ...result,
          message: `Trend: ${result.trend_direction} (slope=${result.slope.toFixed(4)}, R²=${result.r_squared.toFixed(3)}). ${result.predicted_oos_description}`,
        };
      }

      case 'p_chart': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const rows = parseSigmaCsv(args.csv_content);
        const defectives = rows.map((r) => r.value);
        const sampleSizes = rows.map((r) => parseFloat(r.subgroup || '100'));
        if (sampleSizes.some(isNaN)) return { error: 'subgroup column must contain sample sizes for p-chart.' };

        const data = pChart(defectives, sampleSizes);
        const filePath = await generateAttributeChart(data, args.project_name);
        return { success: true, file: filePath, violations: data.violations.length, p_bar: data.center_line };
      }

      case 'c_chart': {
        if (!args.csv_content) return { error: 'csv_content is required.' };
        if (!args.project_name) return { error: 'project_name is required.' };

        const rows = parseSigmaCsv(args.csv_content);
        const defects = rows.map((r) => r.value);
        const data = cChart(defects);
        const filePath = await generateAttributeChart(data, args.project_name);
        return { success: true, file: filePath, violations: data.violations.length, c_bar: data.center_line };
      }

      default:
        return { error: `Unknown action: ${args.action}. Use capability, dpmo, rty, chart, cusum, ewma, trend, p_chart, c_chart, pareto, status, or list.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, action: args.action }, 'Sigma analysis error');
    return { error: message };
  }
}
