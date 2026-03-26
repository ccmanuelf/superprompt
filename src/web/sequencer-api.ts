/**
 * Job Sequencing HTTP API — REST endpoints for the sequencer web UI.
 *
 * Mounted on the existing web server at /api/sequence/*.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  dispatch,
  compareAllRules,
  runGA,
  buildGanttData,
  buildSetupMatrix,
  computeMetrics,
  saveSchedule,
  getSchedule,
  listSchedules,
  deleteSchedule,
  generateGanttChart,
  generateComparisonChart,
  type SequencerConfig,
  type DispatchRule,
  type GAConfig,
  ALL_RULES,
  DEFAULT_GA_CONFIG,
} from '../sequencer/index.js';

/**
 * Handle sequencer API requests.
 * Returns true if handled, false if not a sequencer route.
 */
export async function handleSequencerApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/sequence')) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const route = urlPath.replace('/api/sequence', '') || '/';

  try {
    if (req.method === 'GET') return handleGet(route, res);
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res);
    }
    if (req.method === 'DELETE') return handleDelete(route, res);

    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, route }, 'Sequencer API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

// ── GET Routes ───────────────────────────────────────────────

function handleGet(route: string, res: ServerResponse): boolean {
  switch (route) {
    case '/':
    case '/info': {
      jsonResponse(res, 200, {
        engine: 'Job Sequencer v1.0',
        rules: ALL_RULES,
        objectives: ['makespan', 'lateness', 'setup_time', 'weighted'],
        default_ga: DEFAULT_GA_CONFIG,
      });
      return true;
    }

    case '/schedules': {
      const schedules = listSchedules();
      jsonResponse(res, 200, {
        schedules: schedules.map((s) => ({
          id: s.id,
          name: s.name,
          has_result: !!s.result_json,
          created_at: s.created_at,
          updated_at: s.updated_at,
        })),
      });
      return true;
    }

    default: {
      const match = route.match(/^\/schedules\/(.+)$/);
      if (match) {
        const sched = getSchedule(match[1]);
        if (!sched) { jsonResponse(res, 404, { error: 'Schedule not found' }); return true; }
        jsonResponse(res, 200, {
          ...sched,
          config: JSON.parse(sched.config_json),
          result: sched.result_json ? JSON.parse(sched.result_json) : null,
        });
        return true;
      }
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
    }
  }
}

// ── POST Routes ──────────────────────────────────────────────

async function handlePost(route: string, body: unknown, res: ServerResponse): Promise<boolean> {
  const data = body as Record<string, unknown>;

  switch (route) {
    // ── Dispatch (single rule) ──
    case '/dispatch': {
      const config = data.config as SequencerConfig;
      const rule = (data.rule as DispatchRule) ?? 'SPT';
      if (!config?.jobs?.length) {
        jsonResponse(res, 400, { error: 'config with jobs[] required' });
        return true;
      }

      const result = dispatch(config, rule);
      const gantt = buildGanttData(result.entries, config);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateGanttChart(gantt, `${rule} — ${config.name}`);
      } catch (err) {
        logger.warn({ err }, 'Gantt chart generation failed');
      }

      if (config.name) saveSchedule(config.name + '_' + rule, config, result);

      jsonResponse(res, 200, {
        success: true,
        result,
        gantt,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── Compare all rules ──
    case '/compare': {
      const config = data.config as SequencerConfig;
      if (!config?.jobs?.length) {
        jsonResponse(res, 400, { error: 'config with jobs[] required' });
        return true;
      }

      const comparison = compareAllRules(config);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateComparisonChart(comparison, `Rule Comparison — ${config.name}`);
      } catch (err) {
        logger.warn({ err }, 'Comparison chart generation failed');
      }

      // Also generate Gantt for best rule
      const bestResult = comparison.rules.find((r) => r.rule_or_method === comparison.best_overall);
      let ganttChart: string | undefined;
      if (bestResult) {
        const gantt = buildGanttData(bestResult.entries, config);
        try {
          ganttChart = await generateGanttChart(gantt, `Best: ${comparison.best_overall}`);
        } catch { /* optional */ }
      }

      if (config.name) saveSchedule(config.name, config, comparison);

      jsonResponse(res, 200, {
        success: true,
        comparison,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
        gantt_chart: ganttChart ? `data:image/png;base64,${ganttChart}` : undefined,
      });
      return true;
    }

    // ── GA optimization ──
    case '/ga': {
      const config = data.config as SequencerConfig;
      const gaConfig = data.ga_config as Partial<GAConfig> | undefined;
      if (!config?.jobs?.length) {
        jsonResponse(res, 400, { error: 'config with jobs[] required' });
        return true;
      }

      const result = runGA(config, gaConfig);
      const gantt = buildGanttData(result.entries, config);

      let chartBase64: string | undefined;
      try {
        chartBase64 = await generateGanttChart(gantt, `GA Optimized — ${config.name}`);
      } catch (err) {
        logger.warn({ err }, 'GA Gantt chart generation failed');
      }

      if (config.name) saveSchedule(config.name + '_GA', config, result);

      jsonResponse(res, 200, {
        success: true,
        result,
        gantt,
        chart: chartBase64 ? `data:image/png;base64,${chartBase64}` : undefined,
      });
      return true;
    }

    // ── Setup matrix ──
    case '/setup-matrix': {
      const setup = data.setup_matrix as Array<{ from_product: string; to_product: string; setup_minutes: number }>;
      if (!setup?.length) {
        jsonResponse(res, 400, { error: 'setup_matrix[] required' });
        return true;
      }
      const matrix = buildSetupMatrix(setup);
      jsonResponse(res, 200, { success: true, ...matrix });
      return true;
    }

    // ── Save schedule ──
    case '/schedules': {
      const config = data.config as SequencerConfig;
      const name = (data.name as string) || config?.name;
      if (!name || !config) {
        jsonResponse(res, 400, { error: 'name and config required' });
        return true;
      }
      const sched = saveSchedule(name, config);
      jsonResponse(res, 201, { success: true, schedule: { id: sched.id, name: sched.name } });
      return true;
    }

    // ── Update job status (progress tracking) ──
    case '/progress': {
      const jobId = data.job_id as string;
      const status = data.status as string;
      if (!jobId || !status) {
        jsonResponse(res, 400, { error: 'job_id and status required' });
        return true;
      }
      // Progress tracking is client-side for now; return confirmation
      jsonResponse(res, 200, {
        success: true,
        job_id: jobId,
        status,
        updated_at: new Date().toISOString(),
      });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

// ── DELETE Routes ────────────────────────────────────────────

function handleDelete(route: string, res: ServerResponse): boolean {
  const match = route.match(/^\/schedules\/(.+)$/);
  if (match) {
    const deleted = deleteSchedule(match[1]);
    jsonResponse(res, deleted ? 200 : 404, deleted ? { success: true } : { error: 'Not found' });
    return true;
  }
  jsonResponse(res, 404, { error: 'Not found' });
  return true;
}

// ── Helpers ──────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
