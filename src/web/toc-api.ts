/**
 * TOC & WIP Tracking HTTP API
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  analyzeTOC,
  saveTOC,
  getTOC,
  listTOCs,
  deleteTOC,
  generateUtilizationChart,
  generateBufferChart,
  generateWIPChart,
  type TOCConfig,
} from '../toc/index.js';

export async function handleTocApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/toc')) return false;


  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const route = urlPath.replace('/api/toc', '') || '/';

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
    logger.error({ err: message, route }, 'TOC API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

async function handleGet(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  switch (route) {
    case '/':
    case '/info':
      jsonResponse(res, 200, {
        engine: 'TOC & WIP Tracking v1.0',
        methodology: 'Goldratt Theory of Constraints — 5 Focusing Steps',
        features: ['CCR Identification', 'Drum-Buffer-Rope', 'Throughput Accounting', 'Buffer Management', 'WIP Tracking'],
      });
      return true;
    case '/configs': {
      const configs = await listTOCs(chatId);
      jsonResponse(res, 200, {
        configs: configs.map((c) => ({
          id: c.id, name: c.name, has_result: !!c.result_json,
          created_at: c.created_at, updated_at: c.updated_at,
        })),
      });
      return true;
    }
    default: {
      const match = route.match(/^\/configs\/(.+)$/);
      if (match) {
        const toc = await getTOC(match[1], chatId);
        if (!toc) { jsonResponse(res, 404, { error: 'Config not found' }); return true; }
        jsonResponse(res, 200, {
          ...toc, config: JSON.parse(toc.config_json),
          result: toc.result_json ? JSON.parse(toc.result_json) : null,
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
      const config = data.config as TOCConfig;
      if (!config?.work_centers?.length) {
        jsonResponse(res, 400, { error: 'config with work_centers[] required' });
        return true;
      }
      const result = analyzeTOC(config);

      let utilChart: string | undefined;
      let bufferChart: string | undefined;
      let wipChart: string | undefined;
      try {
        utilChart = await generateUtilizationChart(result.constraint.work_center_ranking, `${config.name} — Constraint Analysis`);
        bufferChart = await generateBufferChart([result.dbr.shipping_buffer, result.dbr.constraint_buffer], `${config.name} — Buffer Status`);
        wipChart = await generateWIPChart(result.wip_gauges, `${config.name} — WIP Levels`);
      } catch (err) { logger.warn({ err }, 'TOC chart generation failed'); }

      if (config.name) await saveTOC(config.name, config, result, chatId);

      jsonResponse(res, 200, {
        success: true, result,
        utilization_chart: utilChart ? `data:image/png;base64,${utilChart}` : undefined,
        buffer_chart: bufferChart ? `data:image/png;base64,${bufferChart}` : undefined,
        wip_chart: wipChart ? `data:image/png;base64,${wipChart}` : undefined,
      });
      return true;
    }

    case '/configs': {
      const config = data.config as TOCConfig;
      const name = (data.name as string) || config?.name;
      if (!name || !config) { jsonResponse(res, 400, { error: 'name and config required' }); return true; }
      const saved = await saveTOC(name, config, undefined, chatId);
      jsonResponse(res, 201, { success: true, config: { id: saved.id, name: saved.name } });
      return true;
    }

    default:
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
  }
}

async function handleDelete(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  const match = route.match(/^\/configs\/(.+)$/);
  if (match) {
    const deleted = await deleteTOC(match[1], chatId);
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
      try { const text = Buffer.concat(chunks).toString('utf-8'); resolve(text ? JSON.parse(text) : {}); }
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
