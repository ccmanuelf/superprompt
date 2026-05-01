/**
 * Assumption Registry HTTP API — REST endpoints for the Web UI CRUD page.
 *
 * Mounted at /api/assumptions/*. The corresponding UI lives at /docs/assumptions.
 * Per locked spec-owner decision (rc.100 audit Q1), assumption CRUD is
 * Web-UI-only — no Telegram commands.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import {
  ASSUMPTION_DEFAULTS,
  setAssumption,
  retireAssumption,
  getAssumptionById,
  listAssumptions,
  listMetricDependencies,
  resolveAssumption,
  type AssumptionScope,
  type AssumptionStatus,
  type SetAssumptionInput,
} from '../assumptions.js';
import { getKnex } from '../db-knex.js';

export async function handleAssumptionsApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/assumptions')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const route = urlPath.replace('/api/assumptions', '') || '/';

  try {
    if (req.method === 'GET') return await handleGet(route, req, res);
    if (req.method === 'POST') {
      const body = await readBody(req);
      return await handlePost(route, body, res, chatId);
    }
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, route }, 'Assumptions API error');
    jsonResponse(res, 500, { error: message });
    return true;
  }
}

async function handleGet(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '', 'http://localhost');

  // /api/assumptions/catalog — the built-in default catalog
  if (route === '/catalog') {
    const catalog = Object.entries(ASSUMPTION_DEFAULTS).map(([name, entry]) => ({
      name,
      default_value: entry.value,
      default_rationale: entry.rationale,
    }));
    jsonResponse(res, 200, { catalog });
    return true;
  }

  // /api/assumptions/dependencies?metric=oee
  if (route === '/dependencies') {
    const metric = url.searchParams.get('metric') ?? undefined;
    const deps = await listMetricDependencies(metric);
    jsonResponse(res, 200, { dependencies: deps });
    return true;
  }

  // /api/assumptions/resolve?name=X&userId=Y&packs=a,b
  if (route === '/resolve') {
    const name = url.searchParams.get('name');
    if (!name) {
      jsonResponse(res, 400, { error: 'name query param is required' });
      return true;
    }
    const userId = url.searchParams.get('userId') ?? undefined;
    const packsCsv = url.searchParams.get('packs') ?? '';
    const activePacks = packsCsv ? packsCsv.split(',').map((p) => p.trim()).filter(Boolean) : [];
    const resolved = await resolveAssumption(name, { userId, activePacks });
    jsonResponse(res, 200, { resolved });
    return true;
  }

  // /api/assumptions/<id>/changes — change log for a single assumption
  const changesMatch = route.match(/^\/([a-f0-9]+)\/changes$/);
  if (changesMatch) {
    const id = changesMatch[1];
    const rows = await getKnex()('luna_assumption_changes')
      .where({ assumption_id: id })
      .orderBy('changed_at', 'desc') as Array<Record<string, unknown>>;
    const changes = rows.map((r) => ({
      id: r.id,
      assumption_id: r.assumption_id,
      changed_by: r.changed_by,
      changed_at: r.changed_at,
      previous_value: tryParse(r.previous_value),
      new_value: tryParse(r.new_value),
      change_reason: r.change_reason,
    }));
    jsonResponse(res, 200, { changes });
    return true;
  }

  // /api/assumptions/<id> — single record
  const idMatch = route.match(/^\/([a-f0-9]+)$/);
  if (idMatch) {
    const found = await getAssumptionById(idMatch[1]);
    if (!found) {
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
    }
    jsonResponse(res, 200, { assumption: found });
    return true;
  }

  // /api/assumptions or /api/assumptions/ — list with optional filters
  if (route === '/' || route === '') {
    const scopeType = url.searchParams.get('scope_type') as AssumptionScope | null;
    const scopeIdRaw = url.searchParams.get('scope_id');
    const status = (url.searchParams.get('status') as AssumptionStatus | null) ?? 'active';
    const filter: {
      scope_type?: AssumptionScope;
      scope_id?: string | null;
      status?: AssumptionStatus;
    } = { status };
    if (scopeType === 'global' || scopeType === 'pack' || scopeType === 'user') {
      filter.scope_type = scopeType;
    }
    if (scopeIdRaw !== null) {
      filter.scope_id = scopeIdRaw === '' ? null : scopeIdRaw;
    }
    const items = await listAssumptions(filter);
    jsonResponse(res, 200, { assumptions: items });
    return true;
  }

  jsonResponse(res, 404, { error: 'Unknown route' });
  return true;
}

async function handlePost(
  route: string,
  body: unknown,
  res: ServerResponse,
  chatId: string,
): Promise<boolean> {
  const data = body as Record<string, unknown>;

  // /api/assumptions — create or update
  if (route === '/' || route === '') {
    const validation = validateSetInput(data, chatId);
    if ('error' in validation) {
      jsonResponse(res, 400, { error: validation.error });
      return true;
    }
    const created = await setAssumption(validation.input);
    jsonResponse(res, 200, { success: true, assumption: created });
    return true;
  }

  // /api/assumptions/retire — soft-delete
  if (route === '/retire') {
    const id = data.id as string | undefined;
    if (!id) {
      jsonResponse(res, 400, { error: 'id is required' });
      return true;
    }
    const reason = (data.reason as string) ?? 'retired via web UI';
    const by = (data.by as string) ?? chatId ?? 'web';
    const ok = await retireAssumption(id, by, reason);
    if (!ok) {
      jsonResponse(res, 404, { error: 'Not found or already retired' });
      return true;
    }
    jsonResponse(res, 200, { success: true });
    return true;
  }

  jsonResponse(res, 404, { error: 'Unknown route' });
  return true;
}

function validateSetInput(
  data: Record<string, unknown>,
  chatId: string,
): { input: SetAssumptionInput } | { error: string } {
  const scopeType = data.scope_type;
  if (scopeType !== 'global' && scopeType !== 'pack' && scopeType !== 'user') {
    return { error: 'scope_type must be one of: global, pack, user' };
  }

  let scopeId: string | null;
  if (scopeType === 'global') {
    scopeId = null;
  } else {
    if (typeof data.scope_id !== 'string' || data.scope_id.trim() === '') {
      return { error: `scope_id is required for scope_type=${scopeType}` };
    }
    scopeId = data.scope_id;
  }

  if (typeof data.assumption_name !== 'string' || data.assumption_name.trim() === '') {
    return { error: 'assumption_name is required' };
  }
  if (data.value === undefined) {
    return { error: 'value is required' };
  }

  const input: SetAssumptionInput = {
    scope_type: scopeType,
    scope_id: scopeId,
    assumption_name: data.assumption_name,
    value: data.value,
    rationale: typeof data.rationale === 'string' ? data.rationale : '',
    created_by: typeof data.created_by === 'string' && data.created_by.trim() !== ''
      ? data.created_by
      : (chatId || 'web'),
    effective_date: typeof data.effective_date === 'number' ? data.effective_date : null,
    expiration_date: typeof data.expiration_date === 'number' ? data.expiration_date : null,
    change_reason: typeof data.change_reason === 'string' ? data.change_reason : undefined,
  };
  return { input };
}

function tryParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}
