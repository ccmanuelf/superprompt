/**
 * Value Stream Mapping HTTP API — REST endpoints for the VSM web UI.
 *
 * Mounted on the existing web server at /api/vsm/*.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  analyzeVSM,
  compareStates,
  saveVSM,
  getVSM,
  listVSMs,
  deleteVSM,
  generateWaterfallChart,
  generateTimwoodsChart,
  generatePCEComparisonChart,
  type VSMConfig,
} from '../vsm/index.js';

export async function handleVsmApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/vsm')) return false;


  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const route = urlPath.replace('/api/vsm', '') || '/';

  try {
    if (req.method === 'GET') return await handleGet(route, res, chatId);
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res, chatId);
    }
    if (req.method === 'DELETE') return await handleDelete(route, res, chatId);
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, route }, 'VSM API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

async function handleGet(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  switch (route) {
    case '/':
    case '/info':
      jsonResponse(res, 200, {
        engine: 'Value Stream Mapping v1.0',
        categories: ['VA', 'NVA', 'BNVA'],
        waste_types: ['transport', 'inventory', 'motion', 'waiting', 'overproduction', 'overprocessing', 'defects', 'skills'],
      });
      return true;

    case '/maps': {
      const maps = await listVSMs(chatId);
      jsonResponse(res, 200, {
        maps: maps.map((m) => ({
          id: m.id, name: m.name, has_result: !!m.result_json,
          created_at: m.created_at, updated_at: m.updated_at,
        })),
      });
      return true;
    }

    default: {
      const match = route.match(/^\/maps\/(.+)$/);
      if (match) {
        const vsm = await getVSM(match[1], chatId);
        if (!vsm) { jsonResponse(res, 404, { error: 'Map not found' }); return true; }
        jsonResponse(res, 200, {
          ...vsm,
          config: JSON.parse(vsm.config_json),
          result: vsm.result_json ? JSON.parse(vsm.result_json) : null,
        });
        return true;
      }
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
    }
  }
}

async function handlePost(route: string, body: unknown, res: ServerResponse, chatId: string): Promise<boolean> {
  const data = body as Record<string, unknown>;

  switch (route) {
    case '/analyze': {
      const config = data.config as VSMConfig;
      if (!config?.steps?.length) {
        jsonResponse(res, 400, { error: 'config with steps[] required' });
        return true;
      }
      const result = analyzeVSM(config);

      let waterfallChart: string | undefined;
      let timwoodsChart: string | undefined;
      try {
        waterfallChart = await generateWaterfallChart(result.waterfall, `${config.name} — Lead Time Waterfall`);
        if (result.timwoods.some((t) => t.total_minutes > 0)) {
          timwoodsChart = await generateTimwoodsChart(result.timwoods, `${config.name} — TIMWOODS Waste`);
        }
      } catch (err) { logger.warn({ err }, 'VSM chart generation failed'); }

      if (config.name) await saveVSM(config.name, config, result, chatId);

      jsonResponse(res, 200, {
        success: true,
        result,
        waterfall_chart: waterfallChart ? `data:image/png;base64,${waterfallChart}` : undefined,
        timwoods_chart: timwoodsChart ? `data:image/png;base64,${timwoodsChart}` : undefined,
      });
      return true;
    }

    case '/compare': {
      const current = data.current as VSMConfig;
      const future = data.future as VSMConfig;
      if (!current?.steps?.length || !future?.steps?.length) {
        jsonResponse(res, 400, { error: 'current and future configs with steps[] required' });
        return true;
      }
      const comparison = compareStates(current, future);

      let compChart: string | undefined;
      try {
        compChart = await generatePCEComparisonChart(comparison, 'Current vs Future State');
      } catch (err) { logger.warn({ err }, 'Comparison chart failed'); }

      jsonResponse(res, 200, {
        success: true,
        comparison,
        comparison_chart: compChart ? `data:image/png;base64,${compChart}` : undefined,
      });
      return true;
    }

    case '/maps': {
      const config = data.config as VSMConfig;
      const name = (data.name as string) || config?.name;
      if (!name || !config) {
        jsonResponse(res, 400, { error: 'name and config required' });
        return true;
      }
      const saved = await saveVSM(name, config, undefined, chatId);
      jsonResponse(res, 201, { success: true, map: { id: saved.id, name: saved.name } });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

async function handleDelete(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  const match = route.match(/^\/maps\/(.+)$/);
  if (match) {
    const deleted = await deleteVSM(match[1], chatId);
    jsonResponse(res, deleted ? 200 : 404, deleted ? { success: true } : { error: 'Not found' });
    return true;
  }
  jsonResponse(res, 404, { error: 'Not found' });
  return true;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf-8') ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
