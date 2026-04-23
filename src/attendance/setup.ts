/**
 * Organisational CRUD (rc.89).
 *
 * Phase A shipped without any way to create sites / shifts / breaks /
 * modules / absence codes through the UI — a critical gap surfaced on
 * user-level walk-through: a new HR admin opens the admin page, sees
 * "no modules configured", and has no path forward without SQL access.
 *
 * This module provides the persistence functions the API layer calls
 * on behalf of the admin UI. Kept deliberately thin: each function is
 * a small Knex operation plus minimal validation. Rich business rules
 * live upstream (admin-api.ts) or downstream (ingestion).
 *
 * Default absence codes (per the VP's pilot spec) are seeded on
 * demand via `seedDefaultAbsenceCodes`. Idempotent.
 */
import { randomUUID } from 'node:crypto';
import { getKnex } from '../db-knex.js';

// ── Sites ─────────────────────────────────────────────────────

export interface SiteInput {
  name: string;
  clientName: string;
  timezone?: string;
}

export async function createSite(input: SiteInput): Promise<string> {
  if (!input.name?.trim() || !input.clientName?.trim()) {
    throw new Error('site name and clientName are required');
  }
  const db = getKnex();
  const id = `site_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await db('sites').insert({
    id,
    name: input.name.trim(),
    client_name: input.clientName.trim(),
    timezone: input.timezone?.trim() || 'America/Mexico_City',
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function listSites(): Promise<Array<{
  id: string; name: string; clientName: string; timezone: string;
}>> {
  const db = getKnex();
  const rows = await db('sites').select('*').orderBy('name');
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    clientName: r.client_name,
    timezone: r.timezone,
  }));
}

export async function deleteSite(id: string): Promise<void> {
  const db = getKnex();
  // Only allow delete when cascade-affected tables are empty, so we
  // don't leave orphan employees pointing at a vanished site.
  const employees = await db('attendance_employees').where({ site_id: id }).count('* as c').first();
  if (Number((employees as { c?: number })?.c ?? 0) > 0) {
    throw new Error('cannot delete site — employees exist; delete them first');
  }
  await db('sites').where({ id }).del();
}

// ── Shifts ────────────────────────────────────────────────────

export interface ShiftInput {
  siteId: string;
  name: string;
  clockStart: string;
  clockEnd: string;
  billingHoursMonThu: number;
  billingHoursFri: number;
  breaks: Array<{ name: string; durationMinutes: number; paid: boolean }>;
}

export async function createShift(input: ShiftInput): Promise<string> {
  if (!input.siteId) throw new Error('siteId is required');
  if (!input.name?.trim()) throw new Error('shift name is required');
  if (!/^\d{2}:\d{2}$/.test(input.clockStart)) {
    throw new Error(`clockStart must be HH:MM, got "${input.clockStart}"`);
  }
  if (!/^\d{2}:\d{2}$/.test(input.clockEnd)) {
    throw new Error(`clockEnd must be HH:MM, got "${input.clockEnd}"`);
  }
  if (!Number.isFinite(input.billingHoursMonThu) || input.billingHoursMonThu <= 0) {
    throw new Error('billingHoursMonThu must be a positive number');
  }
  if (!Number.isFinite(input.billingHoursFri) || input.billingHoursFri <= 0) {
    throw new Error('billingHoursFri must be a positive number');
  }

  const db = getKnex();
  const site = await db('sites').where({ id: input.siteId }).first();
  if (!site) throw new Error(`site ${input.siteId} does not exist`);

  const id = `shift_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await db.transaction(async (trx) => {
    await trx('shifts').insert({
      id,
      site_id: input.siteId,
      name: input.name.trim(),
      clock_start: input.clockStart,
      clock_end: input.clockEnd,
      billing_hours_mon_thu: input.billingHoursMonThu,
      billing_hours_fri: input.billingHoursFri,
      created_at: now,
      updated_at: now,
    });
    for (const b of input.breaks) {
      await trx('breaks').insert({
        id: `brk_${randomUUID().slice(0, 8)}`,
        shift_id: id,
        name: b.name.trim(),
        duration_minutes: b.durationMinutes,
        paid: b.paid,
      });
    }
  });
  return id;
}

export async function listShifts(siteId?: string): Promise<Array<{
  id: string; siteId: string; name: string; clockStart: string; clockEnd: string;
  billingHoursMonThu: number; billingHoursFri: number;
  breaks: Array<{ id: string; name: string; durationMinutes: number; paid: boolean }>;
}>> {
  const db = getKnex();
  const q = db('shifts').select('*').orderBy('name');
  if (siteId) q.where({ site_id: siteId });
  const shifts = await q;
  const out = [];
  for (const s of shifts) {
    const brks = await db('breaks').where({ shift_id: s.id }).select('*');
    out.push({
      id: s.id,
      siteId: s.site_id,
      name: s.name,
      clockStart: s.clock_start,
      clockEnd: s.clock_end,
      billingHoursMonThu: Number(s.billing_hours_mon_thu),
      billingHoursFri: Number(s.billing_hours_fri),
      breaks: brks.map((b) => ({
        id: b.id, name: b.name, durationMinutes: b.duration_minutes, paid: Boolean(b.paid),
      })),
    });
  }
  return out;
}

// ── Modules ───────────────────────────────────────────────────

export interface ModuleInput {
  siteId: string;
  name: string;
  supervisorName: string;
  supervisorChatId?: string | null;
  shiftId: string;
}

export async function createModule(input: ModuleInput): Promise<string> {
  if (!input.siteId) throw new Error('siteId is required');
  if (!input.name?.trim()) throw new Error('module name is required');
  if (!input.supervisorName?.trim()) throw new Error('supervisorName is required');
  if (!input.shiftId) throw new Error('shiftId is required');

  const db = getKnex();
  const site = await db('sites').where({ id: input.siteId }).first();
  if (!site) throw new Error(`site ${input.siteId} does not exist`);
  const shift = await db('shifts').where({ id: input.shiftId, site_id: input.siteId }).first();
  if (!shift) throw new Error(`shift ${input.shiftId} does not exist for site ${input.siteId}`);

  const id = `mod_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await db('attendance_modules').insert({
    id,
    site_id: input.siteId,
    name: input.name.trim(),
    supervisor_name: input.supervisorName.trim(),
    supervisor_chat_id: input.supervisorChatId ?? null,
    shift_id: input.shiftId,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export async function listModules(): Promise<Array<{
  id: string; siteId: string; name: string;
  supervisorName: string; supervisorChatId: string | null;
  shiftId: string;
}>> {
  const db = getKnex();
  const rows = await db('attendance_modules').select('*').orderBy('name');
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    name: r.name,
    supervisorName: r.supervisor_name,
    supervisorChatId: r.supervisor_chat_id,
    shiftId: r.shift_id,
  }));
}

export async function updateModuleSupervisor(
  moduleId: string,
  supervisorName: string,
  supervisorChatId?: string | null,
): Promise<void> {
  const db = getKnex();
  await db('attendance_modules').where({ id: moduleId }).update({
    supervisor_name: supervisorName.trim(),
    supervisor_chat_id: supervisorChatId ?? null,
    updated_at: Date.now(),
  });
}

// ── Absence codes ─────────────────────────────────────────────

export interface AbsenceCodeInput {
  siteId: string;
  code: string;
  descriptionEn: string;
  descriptionEs: string;
  countsAsPresent?: boolean;
  billingHoursFactor?: number;
}

export async function upsertAbsenceCode(input: AbsenceCodeInput): Promise<void> {
  if (!input.siteId) throw new Error('siteId required');
  if (!input.code?.trim()) throw new Error('code required');
  const db = getKnex();
  const now = Date.now();
  const existing = await db('absence_codes')
    .where({ site_id: input.siteId, code: input.code.trim() })
    .first();
  if (existing) {
    await db('absence_codes')
      .where({ site_id: input.siteId, code: input.code.trim() })
      .update({
        description_en: input.descriptionEn,
        description_es: input.descriptionEs,
        counts_as_present: input.countsAsPresent ?? false,
        billing_hours_factor: input.billingHoursFactor ?? 0,
        updated_at: now,
      });
  } else {
    await db('absence_codes').insert({
      site_id: input.siteId,
      code: input.code.trim(),
      description_en: input.descriptionEn,
      description_es: input.descriptionEs,
      counts_as_present: input.countsAsPresent ?? false,
      billing_hours_factor: input.billingHoursFactor ?? 0,
      created_at: now,
      updated_at: now,
    });
  }
}

export async function listAbsenceCodes(siteId: string): Promise<Array<{
  code: string; descriptionEn: string; descriptionEs: string;
  countsAsPresent: boolean; billingHoursFactor: number;
}>> {
  const db = getKnex();
  const rows = await db('absence_codes').where({ site_id: siteId }).orderBy('code');
  return rows.map((r) => ({
    code: r.code,
    descriptionEn: r.description_en,
    descriptionEs: r.description_es,
    countsAsPresent: Boolean(r.counts_as_present),
    billingHoursFactor: Number(r.billing_hours_factor),
  }));
}

/**
 * Pilot default absence codes, per the VP's spec. Idempotent — called
 * once on site creation (or manually via the admin UI). The operator can
 * edit/extend after seeding.
 */
export const DEFAULT_ABSENCE_CODES: Array<Omit<AbsenceCodeInput, 'siteId'>> = [
  { code: 'U',  descriptionEn: 'Unexcused absence',         descriptionEs: 'Falta injustificada',      countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'V',  descriptionEn: 'Vacation',                  descriptionEs: 'Vacaciones',               countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'DI', descriptionEn: 'Dismissal',                 descriptionEs: 'Baja administrativa',      countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'PP', descriptionEn: 'Personal permission',       descriptionEs: 'Permiso personal',         countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'P',  descriptionEn: 'Union permission',          descriptionEs: 'Permiso sindical',         countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'PT', descriptionEn: 'Punishment',                descriptionEs: 'Castigo',                  countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'SI', descriptionEn: 'Sickness / IMSS',           descriptionEs: 'Enfermedad / Incapacidad', countsAsPresent: false, billingHoursFactor: 0 },
];

export async function seedDefaultAbsenceCodes(siteId: string): Promise<number> {
  let count = 0;
  for (const c of DEFAULT_ABSENCE_CODES) {
    await upsertAbsenceCode({ siteId, ...c });
    count += 1;
  }
  return count;
}
