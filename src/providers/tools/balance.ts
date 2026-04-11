import type { Tool } from 'ollama';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../../logger.js';
import { STORE_DIR } from '../../config.js';
import {
  executeBalance,
  listProjects,
  getProject,
  getProjectByName,
  getProjectTasks,
  getResultsForProject,
  formatBalanceResult,
  formatBalanceComparison,
  exportAssignmentsCsv,
  generateYamazumiChart,
  generateGanttChart,
  runBalance,
  parseBalanceCsv,
  type BalanceResult,
} from '../../balance.js';

export const lineBalanceDefinition: Tool = {
  type: 'function',
  function: {
    name: 'line_balance',
    description: `Assembly line balancing tool using Ranked Positional Weight (RPW) heuristic.
Actions:
- run: Execute balance on CSV data. Provide csv_content (raw CSV text) + takt_time (seconds) + project_name.
- status: Show current project status. Provide project_name.
- compare: Compare balance runs for a project. Provide project_name.
- list: List all balance projects.
- export: Export assignments as CSV. Provide project_name.
- yamazumi: Generate yamazumi (stacked bar) chart — primary visualization showing station loads vs takt time.
- gantt: Generate Gantt chart PNG. Provide project_name.
- charts: Generate both yamazumi and Gantt charts. Provide project_name.

CSV format (columns): task_id, task_name, time_seconds, predecessors, station_requirement
Predecessors are semicolon-separated task IDs. station_requirement is optional (station number constraint).`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: run, status, compare, list, export, yamazumi, gantt, charts',
          enum: ['run', 'status', 'compare', 'list', 'export', 'yamazumi', 'gantt', 'charts'],
        },
        csv_content: {
          type: 'string',
          description: 'Raw CSV content for balance input (required for "run" action)',
        },
        takt_time: {
          type: 'number',
          description: 'Cycle time target in seconds (required for "run" action)',
        },
        project_name: {
          type: 'string',
          description: 'Project name (required for run/status/compare/export/gantt)',
        },
        description: {
          type: 'string',
          description: 'Optional project description (for "run" action)',
        },
      },
      required: ['action'],
    },
  },
};

export async function lineBalance(
  args: {
    action: string;
    csv_content?: string;
    takt_time?: number;
    project_name?: string;
    description?: string;
  },
  chatId: string,
): Promise<Record<string, unknown>> {
  try {
    switch (args.action) {
      case 'run': {
        if (!args.csv_content) return { error: 'csv_content is required for run action.' };
        if (!args.takt_time || args.takt_time <= 0) return { error: 'takt_time must be a positive number.' };
        if (!args.project_name) return { error: 'project_name is required for run action.' };

        const result = await executeBalance(
          args.csv_content,
          args.takt_time,
          args.project_name,
          args.description || '',
        );

        const summary = formatBalanceResult(result, false);

        return {
          success: true,
          project_id: result.project_id,
          summary,
          efficiency: result.efficiency,
          smoothness_index: result.smoothness_index,
          num_stations: result.num_stations,
          stations: result.stations,
        };
      }

      case 'status': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const tasks = await getProjectTasks(project.id);
        const results = await getResultsForProject(project.id);
        const latestResult = results[0];

        return {
          project: {
            name: project.name,
            description: project.description,
            takt_time: project.takt_time,
            task_count: tasks.length,
            run_count: results.length,
            created: new Date(project.created_at).toLocaleString(),
          },
          latest_run: latestResult ? {
            efficiency: latestResult.efficiency,
            smoothness_index: latestResult.smoothness_index,
            num_stations: latestResult.num_stations,
            date: new Date(latestResult.created_at).toLocaleString(),
          } : null,
        };
      }

      case 'compare': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const results = await getResultsForProject(project.id);
        if (results.length === 0) return { error: 'No balance runs found for this project.' };

        return {
          comparison: formatBalanceComparison(results, false),
          runs: results.map((r) => ({
            id: r.id.slice(0, 8),
            takt_time: r.takt_time,
            efficiency: r.efficiency,
            smoothness_index: r.smoothness_index,
            num_stations: r.num_stations,
            date: new Date(r.created_at).toLocaleString(),
          })),
        };
      }

      case 'list': {
        const projects = await listProjects();
        if (projects.length === 0) return { message: 'No balance projects found.' };

        return {
          projects: projects.map((p) => ({
            name: p.name,
            takt_time: p.takt_time,
            updated: new Date(p.updated_at).toLocaleString(),
          })),
        };
      }

      case 'export': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const results = await getResultsForProject(project.id);
        if (results.length === 0) return { error: 'No balance runs found.' };

        const latest = results[0];
        const assignments = JSON.parse(latest.assignments_json);
        const tasks = await getProjectTasks(project.id);

        // Reconstruct BalanceResult for export
        const balanceResult: BalanceResult = runBalance(tasks, latest.takt_time, project.name);
        balanceResult.project_id = project.id;

        const csv = exportAssignmentsCsv(balanceResult);
        const filename = `balance-export-${project.name.replace(/\s+/g, '-')}-${Date.now()}.csv`;
        const filePath = resolve(STORE_DIR, filename);
        writeFileSync(filePath, csv, 'utf-8');

        return { success: true, file: filePath, message: `Exported to ${filename}` };
      }

      case 'yamazumi': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const tasks = await getProjectTasks(project.id);
        const results = await getResultsForProject(project.id);
        if (results.length === 0) return { error: 'No balance runs found.' };

        const latest = results[0];
        const balanceResult = runBalance(tasks, latest.takt_time, project.name);
        balanceResult.project_id = project.id;

        const filePath = await generateYamazumiChart(balanceResult);
        return { success: true, file: filePath, message: `Yamazumi chart saved to ${filePath}` };
      }

      case 'gantt': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const tasks = await getProjectTasks(project.id);
        const results = await getResultsForProject(project.id);
        if (results.length === 0) return { error: 'No balance runs found.' };

        const latest = results[0];
        const balanceResult = runBalance(tasks, latest.takt_time, project.name);
        balanceResult.project_id = project.id;

        const filePath = await generateGanttChart(balanceResult);
        return { success: true, file: filePath, message: `Gantt chart saved to ${filePath}` };
      }

      case 'charts': {
        if (!args.project_name) return { error: 'project_name is required.' };
        const project = await getProjectByName(args.project_name);
        if (!project) return { error: `Project "${args.project_name}" not found.` };

        const tasks = await getProjectTasks(project.id);
        const results = await getResultsForProject(project.id);
        if (results.length === 0) return { error: 'No balance runs found.' };

        const latest = results[0];
        const balanceResult = runBalance(tasks, latest.takt_time, project.name);
        balanceResult.project_id = project.id;

        const yamazumiPath = await generateYamazumiChart(balanceResult);
        const ganttPath = await generateGanttChart(balanceResult);
        return {
          success: true,
          yamazumi: yamazumiPath,
          gantt: ganttPath,
          message: `Charts saved: yamazumi → ${yamazumiPath}, gantt → ${ganttPath}`,
        };
      }

      default:
        return { error: `Unknown action: ${args.action}. Use run, status, compare, list, export, yamazumi, gantt, or charts.` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, action: args.action }, 'Line balance error');
    return { error: message };
  }
}
