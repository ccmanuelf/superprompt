/**
 * Attendance Admin HTTP API (rc.88, Phase A).
 *
 * Mounted on the existing web server at /api/attendance/*. All endpoints
 * require the standard web-token auth (handled at the server entrypoint).
 *
 * Endpoints:
 *   POST   /api/attendance/preview    — upload a CSV buffer, return header + 10 sample rows
 *   POST   /api/attendance/mapping    — save { moduleId, dataType, fields } as the active mapping
 *   GET    /api/attendance/mapping    — ?moduleId&dataType → current mapping
 *   POST   /api/attendance/ingest     — run ingestion for a previously-uploaded file + saved mapping
 *   GET    /api/attendance/reports    — list recent IngestionReports
 *   GET    /api/attendance/modules    — list configured modules (for the dropdown in the UI)
 *
 * The admin UI lives at /attendance/admin and is served as a static
 * file (see src/web/public/attendance/).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { logger } from '../logger.js';
import { UPLOADS_DIR } from '../config.js';
import { getKnex } from '../db-knex.js';
import { previewBuffer } from '../attendance/parser.js';
import {
  ingestRoster,
  ingestBadgeRecords,
  listRecentIngestionReports,
} from '../attendance/ingestion.js';
import type { ColumnMapping, IngestionReport } from '../attendance/types.js';

const ATTENDANCE_UPLOADS = resolve(UPLOADS_DIR, 'attendance');

export async function handleAttendanceApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  _chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/attendance')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return true;
  }

  const route = urlPath.replace('/api/attendance', '') || '/';

  try {
    if (req.method === 'POST' && route === '/preview') {
      return await handlePreview(req, res);
    }
    if (req.method === 'POST' && route === '/mapping') {
      return await handleSaveMapping(req, res);
    }
    if (req.method === 'GET' && route === '/mapping') {
      return await handleGetMapping(req, res);
    }
    if (req.method === 'POST' && route === '/ingest') {
      return await handleIngest(req, res);
    }
    if (req.method === 'GET' && route === '/reports') {
      return await handleListReports(res);
    }
    if (req.method === 'GET' && route === '/modules') {
      return await handleListModules(res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown route ${route}` }));
    return true;
  } catch (err) {
    logger.error({ err, route }, 'Attendance API handler failed');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
    return true;
  }
}

// ── Route handlers ────────────────────────────────────────────

/**
 * POST /api/attendance/preview
 * body: multipart/form-data OR { base64: string, filename: string, moduleId: string, dataType: 'roster'|'badge' }
 *
 * Returns preview + a server-side fileId the client uses for the
 * subsequent ingest call. We persist the uploaded buffer under
 * WORKSPACE/uploads/attendance/<fileId>.csv so ingestion can reference
 * it without the client re-uploading.
 */
async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBody(req);
  const moduleId = String(body.moduleId ?? '');
  const dataType = String(body.dataType ?? '') as 'roster' | 'badge';
  const base64 = String(body.base64 ?? '');
  const filename = String(body.filename ?? 'upload.csv');

  if (!moduleId || !dataType || !base64) {
    return json(res, 400, { error: 'moduleId, dataType, base64 are required' });
  }
  if (dataType !== 'roster' && dataType !== 'badge') {
    return json(res, 400, { error: `dataType must be "roster" or "badge", got "${dataType}"` });
  }

  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) {
    return json(res, 400, { error: 'decoded upload is empty' });
  }

  mkdirSync(ATTENDANCE_UPLOADS, { recursive: true });
  const fileId = `att_${moduleId}_${dataType}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const storedPath = resolve(ATTENDANCE_UPLOADS, `${fileId}.csv`);
  writeFileSync(storedPath, buf);

  const preview = previewBuffer(buf);
  return json(res, 200, {
    fileId,
    storedPath,
    originalFilename: filename,
    preview,
  });
}

/**
 * POST /api/attendance/mapping
 * body: { moduleId, dataType, fields: {logical: physical}, samplePreview: [...] }
 */
async function handleSaveMapping(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBody(req);
  const moduleId = String(body.moduleId ?? '');
  const dataType = String(body.dataType ?? '') as 'roster' | 'badge';
  const fields = body.fields ?? {};
  const samplePreview = body.samplePreview ?? [];

  if (!moduleId || (dataType !== 'roster' && dataType !== 'badge')) {
    return json(res, 400, { error: 'moduleId and valid dataType required' });
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    return json(res, 400, { error: 'fields must be an object' });
  }

  const db = getKnex();
  const now = Date.now();
  const existing = await db('attendance_column_mappings')
    .where({ module_id: moduleId, data_type: dataType }).first();

  if (existing) {
    await db('attendance_column_mappings')
      .where({ module_id: moduleId, data_type: dataType })
      .update({
        fields: JSON.stringify(fields),
        sample_preview: JSON.stringify(samplePreview),
        updated_at: now,
      });
  } else {
    await db('attendance_column_mappings').insert({
      id: `map_${randomUUID()}`,
      module_id: moduleId,
      data_type: dataType,
      fields: JSON.stringify(fields),
      sample_preview: JSON.stringify(samplePreview),
      created_at: now,
      updated_at: now,
    });
  }

  return json(res, 200, { saved: true });
}

/**
 * GET /api/attendance/mapping?moduleId=...&dataType=...
 */
async function handleGetMapping(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const moduleId = url.searchParams.get('moduleId') ?? '';
  const dataType = url.searchParams.get('dataType') ?? '';
  if (!moduleId || !dataType) {
    return json(res, 400, { error: 'moduleId and dataType query params required' });
  }
  const mapping = await loadMapping(moduleId, dataType as 'roster' | 'badge');
  return json(res, 200, mapping ?? null);
}

/**
 * POST /api/attendance/ingest
 * body: { fileId, moduleId, dataType, expectedDate? }
 */
async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBody(req);
  const fileId = String(body.fileId ?? '');
  const moduleId = String(body.moduleId ?? '');
  const dataType = String(body.dataType ?? '') as 'roster' | 'badge';
  const expectedDate = body.expectedDate ? String(body.expectedDate) : null;

  if (!fileId || !moduleId || (dataType !== 'roster' && dataType !== 'badge')) {
    return json(res, 400, { error: 'fileId, moduleId, valid dataType required' });
  }
  if (dataType === 'badge' && !expectedDate) {
    return json(res, 400, { error: 'expectedDate required for badge ingestion' });
  }

  const storedPath = resolve(ATTENDANCE_UPLOADS, `${fileId}.csv`);
  if (!existsSync(storedPath)) {
    return json(res, 404, { error: `uploaded file ${fileId} not found — re-upload required` });
  }

  const mapping = await loadMapping(moduleId, dataType);
  if (!mapping) {
    return json(res, 400, { error: 'no column mapping saved for this module+dataType — save one first' });
  }

  const siteId = await loadSiteIdForModule(moduleId);
  if (!siteId) {
    return json(res, 404, { error: `module ${moduleId} not found` });
  }

  let report: IngestionReport;
  if (dataType === 'roster') {
    report = await ingestRoster({ moduleId, siteId, filePath: storedPath, mapping });
  } else {
    report = await ingestBadgeRecords({
      moduleId, siteId, filePath: storedPath, mapping, expectedDate: expectedDate!,
    });
  }
  return json(res, 200, { report });
}

async function handleListReports(res: ServerResponse): Promise<boolean> {
  const reports = await listRecentIngestionReports(25);
  return json(res, 200, { reports });
}

async function handleListModules(res: ServerResponse): Promise<boolean> {
  const db = getKnex();
  const rows = await db('attendance_modules').select('*').orderBy('name', 'asc');
  return json(res, 200, { modules: rows });
}

// ── Helpers ───────────────────────────────────────────────────

async function loadMapping(
  moduleId: string,
  dataType: 'roster' | 'badge',
): Promise<ColumnMapping | null> {
  const db = getKnex();
  const row = await db('attendance_column_mappings')
    .where({ module_id: moduleId, data_type: dataType }).first() as
      | { id: string; module_id: string; data_type: string; fields: string;
          sample_preview: string; created_at: number; updated_at: number }
      | undefined;
  if (!row) return null;
  return {
    id: row.id,
    moduleId: row.module_id,
    dataType: row.data_type as 'roster' | 'badge',
    fields: JSON.parse(row.fields),
    samplePreview: JSON.parse(row.sample_preview),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadSiteIdForModule(moduleId: string): Promise<string | null> {
  const db = getKnex();
  const row = await db('attendance_modules').where({ id: moduleId }).first() as
    { site_id: string } | undefined;
  return row?.site_id ?? null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((res, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        res(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

/** Exported so the test suite can import it without pulling in the whole server. */
export const _internals = { readJsonBody, loadMapping, loadSiteIdForModule };
