/**
 * Future-absence CRUD (rc.90).
 *
 * A supervisor (or HR) files a pre-approved absence ahead of time —
 * typical cases: scheduled vacation, filed medical leave, union-duty
 * permits. The reconciliation engine in Phase B reads this table while
 * building the morning exception list and EXCLUDES anyone covered here,
 * so no one badgers the supervisor about employees that are already
 * documented as out.
 *
 * Date semantics: dateStart and dateEnd are inclusive. A single-day
 * absence has dateStart === dateEnd. The `hitsDate` helper below is
 * what Phase B will use to filter exceptions.
 *
 * Cancellation (not deletion): an absence that was created in error or
 * that the employee cancelled stays in the table with `cancelled_at`
 * set — gives the audit trail you'd want for "why was Juan flagged
 * absent when you said he was on vacation?".
 */
import { randomUUID } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import type { DateOnly } from './types.js';

export interface FutureAbsence {
  id: string;
  moduleId: string;
  badgeId: string;
  dateStart: DateOnly;
  dateEnd: DateOnly;
  absenceCode: string;
  filedByChatId: string;
  notes: string | null;
  createdAt: number;
  cancelledAt: number | null;
}

export interface CreateFutureAbsenceInput {
  moduleId: string;
  badgeId: string;
  dateStart: DateOnly;
  dateEnd?: DateOnly;
  absenceCode: string;
  filedByChatId: string;
  notes?: string;
}

function isoOk(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

export async function createFutureAbsence(
  input: CreateFutureAbsenceInput,
): Promise<FutureAbsence> {
  if (!input.moduleId) throw new Error('moduleId is required');
  if (!input.badgeId?.trim()) throw new Error('badgeId is required');
  if (!input.absenceCode?.trim()) throw new Error('absenceCode is required');
  if (!isoOk(input.dateStart)) throw new Error(`dateStart must be YYYY-MM-DD, got "${input.dateStart}"`);
  const dateEnd = input.dateEnd ?? input.dateStart;
  if (!isoOk(dateEnd)) throw new Error(`dateEnd must be YYYY-MM-DD, got "${dateEnd}"`);
  if (dateEnd < input.dateStart) throw new Error('dateEnd cannot be earlier than dateStart');
  if (!input.filedByChatId) throw new Error('filedByChatId is required');

  const db = getKnex();
  const mod = await db('attendance_modules').where({ id: input.moduleId }).first();
  if (!mod) throw new Error(`module ${input.moduleId} does not exist`);

  // Validate the absence code exists for this module's site.
  const site = await db('attendance_modules').where({ id: input.moduleId }).select('site_id').first() as { site_id: string };
  const codeRow = await db('absence_codes')
    .where({ site_id: site.site_id, code: input.absenceCode.trim() })
    .first();
  if (!codeRow) {
    throw new Error(
      `absence code "${input.absenceCode}" is not configured for this module's site — ` +
      `seed the defaults or add it in Setup first`,
    );
  }

  // Validate the employee exists in the roster.
  const emp = await db('attendance_employees')
    .where({ site_id: site.site_id, badge_id: input.badgeId.trim() })
    .first();
  if (!emp) {
    throw new Error(
      `employee with badge ${input.badgeId} is not in the roster — ` +
      `ingest the roster first or correct the badge number`,
    );
  }

  const id = `fa_${randomUUID().slice(0, 12)}`;
  const now = Date.now();
  await db('attendance_future_absences').insert({
    id,
    module_id: input.moduleId,
    badge_id: input.badgeId.trim(),
    date_start: input.dateStart,
    date_end: dateEnd,
    absence_code: input.absenceCode.trim(),
    filed_by_chat_id: input.filedByChatId,
    notes: input.notes ?? null,
    created_at: now,
  });

  return {
    id,
    moduleId: input.moduleId,
    badgeId: input.badgeId.trim(),
    dateStart: input.dateStart,
    dateEnd,
    absenceCode: input.absenceCode.trim(),
    filedByChatId: input.filedByChatId,
    notes: input.notes ?? null,
    createdAt: now,
    cancelledAt: null,
  };
}

export async function listFutureAbsences(filter: {
  moduleId?: string;
  badgeId?: string;
  /** When set, return only absences whose range covers this date. */
  activeOnDate?: DateOnly;
  /** Include cancelled rows (default false). */
  includeCancelled?: boolean;
}): Promise<FutureAbsence[]> {
  const db = getKnex();
  const q = db('attendance_future_absences').orderBy('date_start', 'desc');
  if (filter.moduleId) q.where({ module_id: filter.moduleId });
  if (filter.badgeId) q.where({ badge_id: filter.badgeId });
  if (!filter.includeCancelled) q.whereNull('cancelled_at');
  if (filter.activeOnDate) {
    q.where('date_start', '<=', filter.activeOnDate);
    q.where('date_end', '>=', filter.activeOnDate);
  }
  const rows = await q as Array<{
    id: string; module_id: string; badge_id: string;
    date_start: string; date_end: string;
    absence_code: string; filed_by_chat_id: string; notes: string | null;
    created_at: number; cancelled_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    moduleId: r.module_id,
    badgeId: r.badge_id,
    dateStart: r.date_start,
    dateEnd: r.date_end,
    absenceCode: r.absence_code,
    filedByChatId: r.filed_by_chat_id,
    notes: r.notes,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
  }));
}

export async function cancelFutureAbsence(id: string): Promise<boolean> {
  const db = getKnex();
  const n = await db('attendance_future_absences')
    .where({ id })
    .whereNull('cancelled_at')
    .update({ cancelled_at: Date.now() });
  return n > 0;
}

/**
 * Test helper — given a FutureAbsence and a date, does the absence
 * cover the date? Phase B will use this directly while building
 * exception lists.
 */
export function hitsDate(fa: FutureAbsence, date: DateOnly): boolean {
  if (fa.cancelledAt !== null) return false;
  return fa.dateStart <= date && date <= fa.dateEnd;
}
