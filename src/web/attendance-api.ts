/**
 * Attendance Admin HTTP API (rc.88 → rc.89 hardened).
 *
 * Mounted on the existing web server at /api/attendance/*. All endpoints
 * require the standard web-token auth (handled at the server entrypoint)
 * AND, for every mutating / privileged route, an attendance-specific
 * role check (rc.89):
 *
 *   POST   /api/attendance/preview       (admin | hr)  — upload CSV, return preview
 *   POST   /api/attendance/mapping       (admin | hr)  — save column mapping
 *   GET    /api/attendance/mapping       (any role)    — read mapping
 *   POST   /api/attendance/ingest        (admin | hr)  — run ingestion
 *   GET    /api/attendance/reports       (any role)    — recent ingestion reports
 *   GET    /api/attendance/modules       (public read) — modules dropdown
 *   GET    /api/attendance/whoami        (authed)      — role info for UI
 *   GET    /api/attendance/sites         (admin)       — list
 *   POST   /api/attendance/sites         (admin)       — create
 *   DELETE /api/attendance/sites/:id     (admin)       — delete (rc.92, blocked if employees exist)
 *   GET    /api/attendance/shifts        (admin)       — list (?siteId=)
 *   POST   /api/attendance/shifts        (admin)       — create w/ breaks
 *   POST   /api/attendance/modules       (admin)       — create
 *   GET    /api/attendance/absence-codes (admin)       — list (?siteId=)
 *   POST   /api/attendance/absence-codes (admin)       — upsert one
 *   POST   /api/attendance/absence-codes/seed (admin)  — seed VP's 7 defaults
 *
 * Role model:
 *   admin → full CRUD + ingestion. Bootstrap: chat_id in ALLOWED_CHAT_ID.
 *   hr    → ingestion + mapping. Cannot create sites/shifts/modules.
 *   any   → read mappings + reports (mostly for UI dropdowns).
 *
 * The admin UI lives at /attendance/admin and is served as a static
 * file (see src/web/public/attendance/).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
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
import {
  hasRole,
  hasAnyAttendanceRole,
  listRoles,
  isBootstrapAdmin,
  RoleRequiredError,
  grantRole,
  revokeRole,
  type AttendanceRole,
} from '../attendance/roles.js';
import {
  createSite, listSites, deleteSite,
  createShift, listShifts, deleteShift,
  createModule, deleteModule,
  upsertAbsenceCode, listAbsenceCodes, seedDefaultAbsenceCodes, deleteAbsenceCode,
} from '../attendance/setup.js';
import {
  createSupervisorInvite, listSupervisorInvites, revokeSupervisorInvite,
} from '../attendance/invites.js';
import {
  createFutureAbsence, listFutureAbsences, cancelFutureAbsence,
} from '../attendance/future-absences.js';

const ATTENDANCE_UPLOADS = resolve(UPLOADS_DIR, 'attendance');

/**
 * How long uploaded preview CSVs stay on disk before opportunistic
 * cleanup removes them. Runs on every upload. 24h gives HR enough time
 * to come back and map the columns across a shift change or weekend.
 */
const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function handleAttendanceApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  chatId: string,
): Promise<boolean> {
  if (!urlPath.startsWith('/api/attendance')) return false;

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return true;
  }

  const route = urlPath.replace('/api/attendance', '') || '/';

  try {
    // Public-read routes (need token but no specific role)
    if (req.method === 'GET' && route === '/whoami') {
      return await handleWhoami(res, chatId);
    }
    if (req.method === 'GET' && route === '/modules') {
      await requireAny(chatId);
      return await handleListModules(res);
    }
    if (req.method === 'GET' && route === '/mapping') {
      await requireAny(chatId);
      return await handleGetMapping(req, res);
    }
    if (req.method === 'GET' && route === '/reports') {
      await requireAny(chatId);
      return await handleListReports(res);
    }

    // Ingestion-role routes (admin | hr)
    if (req.method === 'POST' && route === '/preview') {
      await requireAdminOrHr(chatId);
      return await handlePreview(req, res);
    }
    if (req.method === 'POST' && route === '/mapping') {
      await requireAdminOrHr(chatId);
      return await handleSaveMapping(req, res);
    }
    if (req.method === 'POST' && route === '/ingest') {
      await requireAdminOrHr(chatId);
      return await handleIngest(req, res);
    }

    // Setup routes (admin only)
    if (req.method === 'GET' && route === '/sites') {
      await requireAdmin(chatId);
      return json(res, 200, { sites: await listSites() });
    }
    if (req.method === 'POST' && route === '/sites') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const id = await createSite({
        name: String(body.name ?? ''),
        clientName: String(body.clientName ?? ''),
        timezone: body.timezone ? String(body.timezone) : undefined,
      });
      return json(res, 200, { id });
    }
    if (req.method === 'GET' && route === '/shifts') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      return json(res, 200, { shifts: await listShifts(url.searchParams.get('siteId') ?? undefined) });
    }
    if (req.method === 'POST' && route === '/shifts') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const id = await createShift({
        siteId: String(body.siteId ?? ''),
        name: String(body.name ?? ''),
        clockStart: String(body.clockStart ?? ''),
        clockEnd: String(body.clockEnd ?? ''),
        billingHoursMonThu: Number(body.billingHoursMonThu),
        billingHoursFri: Number(body.billingHoursFri),
        breaks: Array.isArray(body.breaks) ? body.breaks as Array<{ name: string; durationMinutes: number; paid: boolean }> : [],
      });
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && route === '/modules') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const id = await createModule({
        siteId: String(body.siteId ?? ''),
        name: String(body.name ?? ''),
        supervisorName: String(body.supervisorName ?? ''),
        supervisorChatId: body.supervisorChatId ? String(body.supervisorChatId) : null,
        shiftId: String(body.shiftId ?? ''),
      });
      return json(res, 200, { id });
    }
    if (req.method === 'GET' && route === '/absence-codes') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const siteId = url.searchParams.get('siteId');
      if (!siteId) return json(res, 400, { error: 'siteId query param required' });
      return json(res, 200, { codes: await listAbsenceCodes(siteId) });
    }
    if (req.method === 'POST' && route === '/absence-codes') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      await upsertAbsenceCode({
        siteId: String(body.siteId ?? ''),
        code: String(body.code ?? ''),
        descriptionEn: String(body.descriptionEn ?? ''),
        descriptionEs: String(body.descriptionEs ?? ''),
        countsAsPresent: Boolean(body.countsAsPresent),
        billingHoursFactor: Number(body.billingHoursFactor ?? 0),
      });
      return json(res, 200, { saved: true });
    }
    if (req.method === 'POST' && route === '/absence-codes/seed') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const count = await seedDefaultAbsenceCodes(String(body.siteId ?? ''));
      return json(res, 200, { seeded: count });
    }

    // ── DELETE endpoints for setup entities (rc.90 / rc.92) ───────
    if (req.method === 'DELETE' && route.startsWith('/sites/')) {
      await requireAdmin(chatId);
      const id = route.replace('/sites/', '');
      await deleteSite(id);
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'DELETE' && route.startsWith('/shifts/')) {
      await requireAdmin(chatId);
      const id = route.replace('/shifts/', '');
      await deleteShift(id);
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'DELETE' && route.startsWith('/modules/')) {
      await requireAdmin(chatId);
      const id = route.replace('/modules/', '');
      await deleteModule(id);
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'DELETE' && route === '/absence-codes') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const siteId = url.searchParams.get('siteId') ?? '';
      const code = url.searchParams.get('code') ?? '';
      if (!siteId || !code) return json(res, 400, { error: 'siteId and code query params required' });
      await deleteAbsenceCode(siteId, code);
      return json(res, 200, { deleted: true });
    }

    // ── Supervisor invitations (rc.90) ────────────────────
    if (req.method === 'POST' && route === '/supervisor-invite') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const ttlHours = Number(body.ttlHours ?? 24);
      const invite = await createSupervisorInvite({
        moduleId: String(body.moduleId ?? ''),
        createdBy: chatId,
        ttlMs: ttlHours * 60 * 60 * 1000,
      });
      return json(res, 200, { invite });
    }
    if (req.method === 'GET' && route === '/supervisor-invites') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const moduleId = url.searchParams.get('moduleId') ?? undefined;
      return json(res, 200, { invites: await listSupervisorInvites(moduleId) });
    }
    if (req.method === 'POST' && route === '/supervisor-invite/revoke') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const ok = await revokeSupervisorInvite(String(body.token ?? ''));
      return json(res, 200, { revoked: ok });
    }

    // ── Future absences (rc.90) ───────────────────────────
    if (req.method === 'POST' && route === '/future-absences') {
      await requireAdminOrHr(chatId);
      const body = await readJsonBody(req);
      const fa = await createFutureAbsence({
        moduleId: String(body.moduleId ?? ''),
        badgeId: String(body.badgeId ?? ''),
        absenceCode: String(body.absenceCode ?? ''),
        dateStart: String(body.dateStart ?? ''),
        dateEnd: body.dateEnd ? String(body.dateEnd) : undefined,
        filedByChatId: chatId,
        notes: body.notes ? String(body.notes) : undefined,
      });
      return json(res, 200, { futureAbsence: fa });
    }
    if (req.method === 'GET' && route === '/future-absences') {
      await requireAny(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const list = await listFutureAbsences({
        moduleId: url.searchParams.get('moduleId') ?? undefined,
        badgeId: url.searchParams.get('badgeId') ?? undefined,
        activeOnDate: url.searchParams.get('activeOnDate') ?? undefined,
        includeCancelled: url.searchParams.get('includeCancelled') === 'true',
      });
      return json(res, 200, { futureAbsences: list });
    }
    if (req.method === 'POST' && route === '/future-absences/cancel') {
      await requireAdminOrHr(chatId);
      const body = await readJsonBody(req);
      const ok = await cancelFutureAbsence(String(body.id ?? ''));
      return json(res, 200, { cancelled: ok });
    }

    // ── Role management (rc.90) ───────────────────────────
    if (req.method === 'GET' && route === '/role-assignments') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const targetChatId = url.searchParams.get('chatId');
      if (targetChatId) {
        return json(res, 200, { roles: await listRoles(targetChatId) });
      }
      // List all active assignments (no cap because expected to be small)
      const db = getKnex();
      const rows = await db('user_roles').whereNull('revoked_at').orderBy('granted_at', 'desc');
      return json(res, 200, { assignments: rows });
    }
    if (req.method === 'POST' && route === '/role') {
      await requireAdmin(chatId);
      const body = await readJsonBody(req);
      const targetChatId = String(body.chatId ?? '');
      const role = String(body.role ?? '') as AttendanceRole;
      const moduleId = body.moduleId ? String(body.moduleId) : null;
      if (!targetChatId || !['admin','hr','supervisor','manager'].includes(role)) {
        return json(res, 400, { error: 'chatId and a valid role (admin|hr|supervisor|manager) required' });
      }
      if (role === 'supervisor' && !moduleId) {
        return json(res, 400, { error: 'supervisor role requires a moduleId (scoped)' });
      }
      await grantRole({ chatId: targetChatId, role, moduleId, grantedBy: chatId });
      return json(res, 200, { granted: true });
    }
    if (req.method === 'DELETE' && route === '/role') {
      await requireAdmin(chatId);
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const targetChatId = url.searchParams.get('chatId') ?? '';
      const role = (url.searchParams.get('role') ?? '') as AttendanceRole;
      const moduleId = url.searchParams.get('moduleId');
      if (!targetChatId || !role) return json(res, 400, { error: 'chatId and role required' });
      await revokeRole({ chatId: targetChatId, role, moduleId });
      return json(res, 200, { revoked: true });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown route ${route}` }));
    return true;
  } catch (err) {
    // RoleRequiredError → 403, readable message. Validation-style
    // Error thrown from setup.ts (FK prerequisites, format errors) → 400.
    // Anything else → 500.
    if (err instanceof RoleRequiredError) {
      logger.warn({ chatId, route, role: err.role }, 'Attendance API: role denied');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `This action requires the "${err.role}" role. Ask your admin to grant it.` }));
      return true;
    }
    const msg = (err as Error).message ?? 'Internal error';
    const isValidation = /required|does not exist|must be|must have|invalid|unknown|cannot delete/i.test(msg);
    const status = isValidation ? 400 : 500;
    if (!isValidation) {
      logger.error({ err, route }, 'Attendance API handler failed');
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
    return true;
  }
}

// ── Role gates ────────────────────────────────────────────────

async function requireAny(chatId: string): Promise<void> {
  if (!(await hasAnyAttendanceRole(chatId))) {
    throw new RoleRequiredError('hr', chatId);
  }
}

async function requireAdminOrHr(chatId: string): Promise<void> {
  if (await hasRole(chatId, 'admin')) return;
  if (await hasRole(chatId, 'hr')) return;
  throw new RoleRequiredError('hr', chatId);
}

async function requireAdmin(chatId: string): Promise<void> {
  if (await hasRole(chatId, 'admin')) return;
  throw new RoleRequiredError('admin', chatId);
}

async function handleWhoami(res: ServerResponse, chatId: string): Promise<boolean> {
  const roles = await listRoles(chatId);
  return json(res, 200, {
    chatId,
    bootstrap: isBootstrapAdmin(chatId),
    roles,
    can: {
      setup: roles.some((r) => r.role === 'admin'),
      ingest: roles.some((r) => r.role === 'admin' || r.role === 'hr'),
      read: roles.length > 0,
    },
  });
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
  cleanupStaleUploads(); // opportunistic — never blocks the request
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

/**
 * Opportunistic cleanup of preview uploads older than the retention
 * window. Called on every successful upload and once at server start.
 * Best-effort — errors are swallowed so a failing sweep never takes
 * down the upload itself.
 */
export function cleanupStaleUploads(): void {
  try {
    if (!existsSync(ATTENDANCE_UPLOADS)) return;
    const now = Date.now();
    const entries = readdirSync(ATTENDANCE_UPLOADS);
    let removed = 0;
    for (const name of entries) {
      if (!name.endsWith('.csv')) continue;
      const full = resolve(ATTENDANCE_UPLOADS, name);
      try {
        const age = now - statSync(full).mtimeMs;
        if (age > UPLOAD_RETENTION_MS) {
          unlinkSync(full);
          removed += 1;
        }
      } catch {
        // Ignore; file may have been removed by a concurrent call.
      }
    }
    if (removed > 0) {
      logger.info({ removed }, 'Attendance: cleaned up stale preview uploads');
    }
  } catch (err) {
    logger.warn({ err }, 'Attendance: upload cleanup failed (non-fatal)');
  }
}

/** Exported so the test suite can import it without pulling in the whole server. */
export const _internals = { readJsonBody, loadMapping, loadSiteIdForModule, cleanupStaleUploads };
