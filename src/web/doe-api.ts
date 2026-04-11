/**
 * Design of Experiments HTTP API
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  generateMatrix, analyzeDOE, saveDOE, getDOE, listDOEs, deleteDOE,
  generateMainEffectsChart, generateANOVAChart,
  type DOEConfig, type ExperimentMatrix,
} from '../doe/index.js';

export async function handleDoeApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/doe')) return false;


  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const route = urlPath.replace('/api/doe', '') || '/';

  try {
    if (req.method === 'GET') return await handleGet(route, res, chatId);
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res, chatId);
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      return await handlePut(route, body, res, chatId);
    }
    if (req.method === 'DELETE') return await handleDelete(route, res, chatId);
    json(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, route }, 'DOE API error');
    json(res, 500, { error: msg });
    return true;
  }
}

async function handleGet(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  if (route === '/' || route === '/info') {
    json(res, 200, {
      engine: 'Design of Experiments v1.0',
      design_types: ['full_factorial', 'fractional', 'taguchi', 'box_behnken', 'central_composite'],
    });
    return true;
  }
  if (route === '/experiments') {
    json(res, 200, {
      experiments: (await listDOEs(chatId)).map((e) => ({
        id: e.id, name: e.name, has_result: !!e.result_json,
        created_at: e.created_at, updated_at: e.updated_at,
      })),
    });
    return true;
  }
  const match = route.match(/^\/experiments\/(.+)$/);
  if (match) {
    const exp = await getDOE(match[1], chatId);
    if (!exp) { json(res, 404, { error: 'Not found' }); return true; }
    json(res, 200, {
      ...exp, config: JSON.parse(exp.config_json),
      result: exp.result_json ? JSON.parse(exp.result_json) : null,
    });
    return true;
  }
  json(res, 404, { error: 'Not found' });
  return true;
}

async function handlePost(route: string, body: unknown, res: ServerResponse, chatId: string): Promise<boolean> {
  const data = body as Record<string, unknown>;

  switch (route) {
    // Generate experiment matrix
    case '/generate': {
      const config = data.config as DOEConfig;
      if (!config?.factors?.length || !config?.responses?.length) {
        json(res, 400, { error: 'config with factors[] and responses[] required' });
        return true;
      }
      const matrix = generateMatrix(config);
      if (config.name) await saveDOE(config.name, { config, matrix }, undefined, chatId);
      json(res, 200, { success: true, matrix });
      return true;
    }

    // Analyze (with response data filled in)
    case '/analyze': {
      const config = data.config as DOEConfig;
      const matrix = data.matrix as ExperimentMatrix;
      if (!config?.factors?.length || !matrix?.runs?.length) {
        json(res, 400, { error: 'config and matrix with response data required' });
        return true;
      }

      const analysis = analyzeDOE(config, matrix);

      let effectsChart: string | undefined;
      let anovaChart: string | undefined;
      try {
        if (analysis.main_effects.length > 0) {
          // Group main effects by first response
          const firstResponseEffects = analysis.main_effects.filter((_, i) => i < config.factors.length);
          effectsChart = await generateMainEffectsChart(firstResponseEffects, `${config.name} — Main Effects`);
        }
        if (analysis.anova.length > 0) {
          anovaChart = await generateANOVAChart(analysis.anova[0], `${config.name} — ANOVA (${analysis.anova[0].response_name})`);
        }
      } catch (err) { logger.warn({ err }, 'DOE chart generation failed'); }

      if (config.name) await saveDOE(config.name, { config, matrix }, analysis, chatId);

      json(res, 200, {
        success: true, analysis,
        effects_chart: effectsChart ? `data:image/png;base64,${effectsChart}` : undefined,
        anova_chart: anovaChart ? `data:image/png;base64,${anovaChart}` : undefined,
      });
      return true;
    }

    // Save
    case '/experiments': {
      const config = data.config;
      const name = (data.name as string) || (config as Record<string, unknown>)?.name as string;
      if (!name || !config) { json(res, 400, { error: 'name and config required' }); return true; }
      const saved = await saveDOE(name, config, undefined, chatId);
      json(res, 201, { success: true, experiment: { id: saved.id, name: saved.name } });
      return true;
    }

    default:
      json(res, 404, { error: 'Not found' });
      return true;
  }
}

// PUT to update response data in runs
async function handlePut(route: string, body: unknown, res: ServerResponse, chatId: string): Promise<boolean> {
  const match = route.match(/^\/experiments\/(.+)\/responses$/);
  if (match) {
    const exp = await getDOE(match[1], chatId);
    if (!exp) { json(res, 404, { error: 'Not found' }); return true; }

    const data = body as Record<string, unknown>;
    const responses = data.responses as Record<string, Record<string, number>>;  // run_order → response_id → value

    const config = JSON.parse(exp.config_json);
    if (config.matrix) {
      for (const run of config.matrix.runs) {
        const runResponses = responses?.[String(run.run_order)];
        if (runResponses) {
          run.responses = { ...run.responses, ...runResponses };
        }
      }
      await saveDOE(exp.name, config, undefined, chatId);
    }

    json(res, 200, { success: true });
    return true;
  }
  json(res, 404, { error: 'Not found' });
  return true;
}

async function handleDelete(route: string, res: ServerResponse, chatId: string): Promise<boolean> {
  const match = route.match(/^\/experiments\/(.+)$/);
  if (match) {
    const d = await deleteDOE(match[1], chatId);
    json(res, d ? 200 : 404, d ? { success: true } : { error: 'Not found' });
    return true;
  }
  json(res, 404, { error: 'Not found' });
  return true;
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
