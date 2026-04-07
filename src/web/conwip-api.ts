/**
 * CONWIP & Heijunka HTTP API
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  analyzeCONWIP, analyzeHeijunka, saveConwip, getConwip, listConwips, deleteConwip,
  generateStageUtilChart, generateMixChart,
  type CONWIPConfig, type HeijunkaConfig,
} from '../conwip/index.js';

export async function handleConwipApi(req: IncomingMessage, res: ServerResponse, urlPath: string, chatId: string): Promise<boolean> {
  if (!urlPath.startsWith('/api/conwip')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const route = urlPath.replace('/api/conwip', '') || '/';
  try {
    if (req.method === 'GET') return handleGet(route, res, chatId);
    if (req.method === 'POST') { const body = await readBody(req); return await handlePost(route, body, res, chatId); }
    if (req.method === 'DELETE') return handleDelete(route, res, chatId);
    json(res, 405, { error: 'Method not allowed' }); return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, route }, 'CONWIP API error');
    json(res, 500, { error: msg }); return true;
  }
}

function handleGet(route: string, res: ServerResponse, chatId: string): boolean {
  if (route === '/' || route === '/info') {
    json(res, 200, { engine: 'CONWIP & Heijunka v1.0', features: ['CONWIP token board', 'Heijunka box', 'Pitch calculation', 'Leveling score', 'Changeover analysis'] });
    return true;
  }
  if (route === '/configs') {
    json(res, 200, { configs: listConwips(chatId).map((c) => ({ id: c.id, name: c.name, has_result: !!c.result_json, created_at: c.created_at, updated_at: c.updated_at })) });
    return true;
  }
  const match = route.match(/^\/configs\/(.+)$/);
  if (match) {
    const c = getConwip(match[1], chatId);
    if (!c) { json(res, 404, { error: 'Not found' }); return true; }
    json(res, 200, { ...c, config: JSON.parse(c.config_json), result: c.result_json ? JSON.parse(c.result_json) : null });
    return true;
  }
  json(res, 404, { error: 'Not found' }); return true;
}

async function handlePost(route: string, body: unknown, res: ServerResponse, chatId: string): Promise<boolean> {
  const data = body as Record<string, unknown>;
  switch (route) {
    case '/conwip': {
      const config = data.config as CONWIPConfig;
      if (!config?.stages?.length) { json(res, 400, { error: 'config with stages[] required' }); return true; }
      const result = analyzeCONWIP(config);
      let chart: string | undefined;
      try { chart = await generateStageUtilChart(result.stage_utilization, `${config.name} — CONWIP`); } catch { /* */ }
      if (config.name) saveConwip(config.name + '_conwip', config, result, chatId);
      json(res, 200, { success: true, result, chart: chart ? `data:image/png;base64,${chart}` : undefined });
      return true;
    }
    case '/heijunka': {
      const config = data.config as HeijunkaConfig;
      if (!config?.products?.length) { json(res, 400, { error: 'config with products[] required' }); return true; }
      const result = analyzeHeijunka(config);
      let chart: string | undefined;
      try { chart = await generateMixChart(result.actual_mix, `${config.name} — Product Mix`); } catch { /* */ }
      if (config.name) saveConwip(config.name + '_heijunka', config, result, chatId);
      json(res, 200, { success: true, result, chart: chart ? `data:image/png;base64,${chart}` : undefined });
      return true;
    }
    case '/configs': {
      const config = data.config; const name = (data.name as string) || (config as Record<string, unknown>)?.name as string;
      if (!name || !config) { json(res, 400, { error: 'name and config required' }); return true; }
      const saved = saveConwip(name, config, undefined, chatId);
      json(res, 201, { success: true, config: { id: saved.id, name: saved.name } });
      return true;
    }
    default: json(res, 404, { error: 'Not found' }); return true;
  }
}

function handleDelete(route: string, res: ServerResponse, chatId: string): boolean {
  const match = route.match(/^\/configs\/(.+)$/);
  if (match) { const d = deleteConwip(match[1], chatId); json(res, d ? 200 : 404, d ? { success: true } : { error: 'Not found' }); return true; }
  json(res, 404, { error: 'Not found' }); return true;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf-8'); resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function json(res: ServerResponse, status: number, data: unknown): void {
  const b = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
