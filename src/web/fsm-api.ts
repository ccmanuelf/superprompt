/**
 * FSM State Machine HTTP API
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import { readJsonBody } from './http-helpers.js';
import {
  initSimulation, runToCompletion, generateDemoEvents, analyzeSimulation,
  validateFSM, listTemplates, getTemplate,
  bridgeFromSimulation, bridgeFromVSM, bridgeFromTOC, bridgeFromSequencer, createFSMFromBridge,
  saveFSM, getFSMConfig, listFSMs, deleteFSMConfig,
  generateStateResidenceChart, generateSystemUtilChart,
  type FSMConfig, type FSMEvent,
} from '../fsm/index.js';

export async function handleFsmApi(req: IncomingMessage, res: ServerResponse, urlPath: string, chatId: string): Promise<boolean> {
  if (!urlPath.startsWith('/api/fsm')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const route = urlPath.replace('/api/fsm', '') || '/';
  try {
    if (req.method === 'GET') return await handleGet(route, res, chatId);
    if (req.method === 'POST') { const body = await readBody(req); return await handlePost(route, body, res, chatId); }
    if (req.method === 'DELETE') return await handleDelete(route, res, chatId);
    json(res, 405, { error: 'Method not allowed' }); return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, route }, 'FSM API error');
    json(res, 500, { error: msg }); return true;
  }
}

async function handleGet(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  if (route === '/' || route === '/info') {
    json(res, 200, {
      engine: 'State Machine Simulator v1.0',
      mfg_state_types: ['idle', 'processing', 'queued', 'changeover', 'broken_down', 'starved', 'blocked', 'on_break', 'warmup'],
      templates: listTemplates(),
      bridges: ['simulation (S16)', 'vsm (S15.3)', 'toc (S15.4)', 'sequencer (S15.2)'],
    });
    return true;
  }
  if (route === '/templates') { json(res, 200, { templates: listTemplates() }); return true; }
  if (route.startsWith('/templates/')) {
    const name = route.replace('/templates/', '');
    const t = getTemplate(name);
    if (!t) { json(res, 404, { error: 'Template not found' }); return true; }
    json(res, 200, { template: t }); return true;
  }
  if (route === '/configs') {
    json(res, 200, { configs: (await listFSMs(chatId)).map((c) => ({ id: c.id, name: c.name, has_result: !!c.result_json, created_at: c.created_at, updated_at: c.updated_at })) });
    return true;
  }
  const match = route.match(/^\/configs\/(.+)$/);
  if (match) {
    const c = await getFSMConfig(match[1], chatId);
    if (!c) { json(res, 404, { error: 'Not found' }); return true; }
    json(res, 200, { ...c, config: JSON.parse(c.config_json), result: c.result_json ? JSON.parse(c.result_json) : null });
    return true;
  }
  json(res, 404, { error: 'Not found' }); return true;
}

async function handlePost(route: string, body: unknown, res: ServerResponse, chatId: string): Promise<boolean> {
  const data = body as Record<string, unknown>;

  switch (route) {
    case '/validate': {
      const config = data.config as FSMConfig;
      if (!config?.machines?.length) { json(res, 400, { error: 'config with machines[] required' }); return true; }
      json(res, 200, { success: true, validation: validateFSM(config) }); return true;
    }

    case '/simulate': {
      const config = data.config as FSMConfig;
      if (!config?.machines?.length) { json(res, 400, { error: 'config with machines[] required' }); return true; }

      // Generate demo events if none provided
      if (!config.event_queue || config.event_queue.length === 0) {
        config.event_queue = generateDemoEvents(config);
      }

      const state = initSimulation(config);
      const finalState = runToCompletion(state, config);
      const analysis = analyzeSimulation(finalState, config);

      let residenceChart: string | undefined;
      let utilChart: string | undefined;
      try {
        if (analysis.machines.length > 0) {
          residenceChart = await generateStateResidenceChart(analysis.machines[0], `${analysis.machines[0].machine_name} — State Residence`);
          utilChart = await generateSystemUtilChart(analysis.machines, `${config.name} — System Utilization`);
        }
      } catch (err) { logger.warn({ err }, 'FSM chart generation failed'); }

      if (config.name) await saveFSM(config.name, config, analysis, chatId);

      json(res, 200, {
        success: true, analysis, simulation_state: finalState,
        residence_chart: residenceChart ? `data:image/png;base64,${residenceChart}` : undefined,
        util_chart: utilChart ? `data:image/png;base64,${utilChart}` : undefined,
      });
      return true;
    }

    // ── Bridges ──
    case '/bridge/simulation': {
      const stationPerf = data.station_performance as Array<Record<string, unknown>>;
      const totalMin = (data.total_minutes as number) ?? 480;
      const breakdownTime = data.breakdown_time_lost as number | undefined;
      if (!stationPerf?.length) { json(res, 400, { error: 'station_performance[] required' }); return true; }
      const result = bridgeFromSimulation(stationPerf as never, totalMin, breakdownTime);
      json(res, 200, { success: true, bridge_results: result });
      return true;
    }

    case '/bridge/vsm': {
      const breakdown = data.lead_time_breakdown as Array<Record<string, unknown>>;
      if (!breakdown?.length) { json(res, 400, { error: 'lead_time_breakdown[] required' }); return true; }
      const result = bridgeFromVSM(breakdown as never);
      json(res, 200, { success: true, bridge_results: result });
      return true;
    }

    case '/bridge/toc': {
      const ranking = data.work_center_ranking as Array<Record<string, unknown>>;
      const availMin = (data.available_minutes as number) ?? 480;
      if (!ranking?.length) { json(res, 400, { error: 'work_center_ranking[] required' }); return true; }
      const result = bridgeFromTOC(ranking as never, availMin);
      json(res, 200, { success: true, bridge_results: result });
      return true;
    }

    case '/bridge/sequencer': {
      const entries = data.schedule_entries as Array<Record<string, unknown>>;
      if (!entries?.length) { json(res, 400, { error: 'schedule_entries[] required' }); return true; }
      const events = bridgeFromSequencer(entries as never);
      json(res, 200, { success: true, events });
      return true;
    }

    case '/configs': {
      const config = data.config;
      const name = (data.name as string) || (config as Record<string, unknown>)?.name as string;
      if (!name || !config) { json(res, 400, { error: 'name and config required' }); return true; }
      const saved = await saveFSM(name, config, undefined, chatId);
      json(res, 201, { success: true, config: { id: saved.id, name: saved.name } });
      return true;
    }

    default: json(res, 404, { error: 'Not found' }); return true;
  }
}

async function handleDelete(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  const match = route.match(/^\/configs\/(.+)$/);
  if (match) { const d = await deleteFSMConfig(match[1], chatId); json(res, d ? 200 : 404, d ? { success: true } : { error: 'Not found' }); return true; }
  json(res, 404, { error: 'Not found' }); return true;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return readJsonBody<unknown>(req);
}
function json(res: ServerResponse, status: number, data: unknown): void {
  const b = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
