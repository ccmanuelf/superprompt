/**
 * Supervisor invite flow + future-absence CRUD (rc.90).
 * Runs against a real SQLite DB so the transactional claim flow and
 * cascade deletes get exercised the same way production will.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-invites-absences-'));
  const dbKnex = await import('../src/db-knex.js');
  db = dbKnex.initKnex({ driver: 'sqlite', sqliteFilename: join(storeDir, 'test.db') });
  const { attendanceTableInit } = await import('../src/attendance/schema.js');
  await attendanceTableInit.initTables();
});

afterAll(async () => {
  const dbKnex = await import('../src/db-knex.js');
  await dbKnex.destroyKnex();
  rmSync(storeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db('attendance_supervisor_invites').del();
  await db('attendance_future_absences').del();
  await db('user_roles').del();
  await db('absence_codes').del();
  await db('attendance_ingestion_reports').del();
  await db('attendance_adjustments').del();
  await db('attendance_records').del();
  await db('attendance_badge_records').del();
  await db('attendance_employees').del();
  await db('attendance_column_mappings').del();
  await db('attendance_data_sources').del();
  await db('attendance_modules').del();
  await db('breaks').del();
  await db('shifts').del();
  await db('sites').del();
});

async function seedPilot(): Promise<{ siteId: string; moduleId: string }> {
  const { createSite, createShift, createModule, seedDefaultAbsenceCodes } = await import('../src/attendance/setup.js');
  const siteId = await createSite({ name: 'Plant B', clientName: 'X' });
  const shiftId = await createShift({
    siteId, name: 'First', clockStart: '07:00', clockEnd: '17:00',
    billingHoursMonThu: 9.5, billingHoursFri: 10, breaks: [],
  });
  const moduleId = await createModule({
    siteId, name: 'CELL 1', supervisorName: 'Sanchez', shiftId,
  });
  await seedDefaultAbsenceCodes(siteId);
  return { siteId, moduleId };
}

async function seedEmployee(siteId: string, moduleId: string, badgeId = '001'): Promise<void> {
  const now = Date.now();
  await db('attendance_employees').insert({
    site_id: siteId, badge_id: badgeId, full_name: 'Alice', cost_center: 'CC1',
    labor_type: 'direct', line: 'L1', module_id: moduleId, supervisor_name: 'Sanchez',
    raw_row: '{}', created_at: now, updated_at: now,
  });
}

// ── Supervisor invites ────────────────────────────────────────

describe('supervisor invite flow', () => {
  it('admin creates an invite, supervisor claims it → module.supervisor_chat_id populated + role granted', async () => {
    const { moduleId } = await seedPilot();
    const { createSupervisorInvite, claimSupervisorInvite } = await import('../src/attendance/invites.js');
    const { hasRole } = await import('../src/attendance/roles.js');

    const invite = await createSupervisorInvite({ moduleId, createdBy: 'adminChat' });
    expect(invite.token).toMatch(/^[a-f0-9]{24}$/);

    const result = await claimSupervisorInvite(invite.token, 'supChat123');
    expect(result.ok).toBe(true);
    expect(result.moduleId).toBe(moduleId);

    const mod = await db('attendance_modules').where({ id: moduleId }).first();
    expect(mod.supervisor_chat_id).toBe('supChat123');
    expect(await hasRole('supChat123', 'supervisor', moduleId)).toBe(true);
  });

  it('claim fails on unknown token', async () => {
    const { claimSupervisorInvite } = await import('../src/attendance/invites.js');
    const r = await claimSupervisorInvite('not-a-real-token', 'someChat');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('claim fails on expired token', async () => {
    const { moduleId } = await seedPilot();
    const { createSupervisorInvite, claimSupervisorInvite } = await import('../src/attendance/invites.js');
    const invite = await createSupervisorInvite({ moduleId, createdBy: 'adminChat', ttlMs: 60_000 });
    // Rewind expiry to past
    await db('attendance_supervisor_invites').where({ token: invite.token })
      .update({ expires_at: Date.now() - 1000 });
    const r = await claimSupervisorInvite(invite.token, 'supChat');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired/);
  });

  it('claim fails when token was already redeemed (one-shot)', async () => {
    const { moduleId } = await seedPilot();
    const { createSupervisorInvite, claimSupervisorInvite } = await import('../src/attendance/invites.js');
    const invite = await createSupervisorInvite({ moduleId, createdBy: 'adminChat' });
    await claimSupervisorInvite(invite.token, 'supA');
    const r = await claimSupervisorInvite(invite.token, 'supB');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already redeemed/);
  });

  it('claim fails when invite is revoked', async () => {
    const { moduleId } = await seedPilot();
    const { createSupervisorInvite, revokeSupervisorInvite, claimSupervisorInvite } = await import('../src/attendance/invites.js');
    const invite = await createSupervisorInvite({ moduleId, createdBy: 'adminChat' });
    const revoked = await revokeSupervisorInvite(invite.token);
    expect(revoked).toBe(true);
    const r = await claimSupervisorInvite(invite.token, 'supChat');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/revoked/);
  });

  it('re-claiming a module (new invite) rotates the supervisor_chat_id', async () => {
    const { moduleId } = await seedPilot();
    const { createSupervisorInvite, claimSupervisorInvite } = await import('../src/attendance/invites.js');

    const inviteA = await createSupervisorInvite({ moduleId, createdBy: 'adminChat' });
    await claimSupervisorInvite(inviteA.token, 'supA');

    const inviteB = await createSupervisorInvite({ moduleId, createdBy: 'adminChat' });
    await claimSupervisorInvite(inviteB.token, 'supB');

    const mod = await db('attendance_modules').where({ id: moduleId }).first();
    expect(mod.supervisor_chat_id).toBe('supB');
  });
});

// ── Future absences ───────────────────────────────────────────

describe('future-absence CRUD', () => {
  it('creates a future absence for a known employee + validates the code', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence, listFutureAbsences } = await import('../src/attendance/future-absences.js');

    const fa = await createFutureAbsence({
      moduleId, badgeId: '001', absenceCode: 'V',
      dateStart: '2026-04-28', dateEnd: '2026-05-02',
      filedByChatId: 'supChat', notes: 'family trip',
    });
    expect(fa.dateStart).toBe('2026-04-28');
    expect(fa.dateEnd).toBe('2026-05-02');

    const listed = await listFutureAbsences({ moduleId });
    expect(listed).toHaveLength(1);
    expect(listed[0].notes).toBe('family trip');
  });

  it('defaults dateEnd to dateStart when not supplied (single-day)', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence } = await import('../src/attendance/future-absences.js');
    const fa = await createFutureAbsence({
      moduleId, badgeId: '001', absenceCode: 'PP',
      dateStart: '2026-04-30', filedByChatId: 'sup',
    });
    expect(fa.dateEnd).toBe('2026-04-30');
  });

  it('rejects an unknown absence code', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence } = await import('../src/attendance/future-absences.js');
    await expect(createFutureAbsence({
      moduleId, badgeId: '001', absenceCode: 'XYZ',
      dateStart: '2026-04-28', filedByChatId: 'sup',
    })).rejects.toThrow(/not configured/);
  });

  it('rejects an employee not in the roster', async () => {
    const { moduleId } = await seedPilot();
    const { createFutureAbsence } = await import('../src/attendance/future-absences.js');
    await expect(createFutureAbsence({
      moduleId, badgeId: '9999', absenceCode: 'V',
      dateStart: '2026-04-28', filedByChatId: 'sup',
    })).rejects.toThrow(/not in the roster/);
  });

  it('rejects dateEnd before dateStart', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence } = await import('../src/attendance/future-absences.js');
    await expect(createFutureAbsence({
      moduleId, badgeId: '001', absenceCode: 'V',
      dateStart: '2026-05-02', dateEnd: '2026-04-28',
      filedByChatId: 'sup',
    })).rejects.toThrow(/earlier than dateStart/);
  });

  it('cancels an absence (stays in table with cancelled_at set, not hard-deleted)', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence, cancelFutureAbsence, listFutureAbsences } = await import('../src/attendance/future-absences.js');

    const fa = await createFutureAbsence({
      moduleId, badgeId: '001', absenceCode: 'V',
      dateStart: '2026-04-28', filedByChatId: 'sup',
    });
    expect(await cancelFutureAbsence(fa.id)).toBe(true);

    const active = await listFutureAbsences({ moduleId });
    expect(active).toHaveLength(0);

    const allIncludingCancelled = await listFutureAbsences({ moduleId, includeCancelled: true });
    expect(allIncludingCancelled).toHaveLength(1);
    expect(allIncludingCancelled[0].cancelledAt).not.toBeNull();
  });

  it('activeOnDate filter returns only absences covering that date', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId, '001');
    await seedEmployee(siteId, moduleId, '002');
    const { createFutureAbsence, listFutureAbsences } = await import('../src/attendance/future-absences.js');

    await createFutureAbsence({ moduleId, badgeId: '001', absenceCode: 'V', dateStart: '2026-04-28', dateEnd: '2026-05-02', filedByChatId: 'sup' });
    await createFutureAbsence({ moduleId, badgeId: '002', absenceCode: 'PP', dateStart: '2026-05-10', filedByChatId: 'sup' });

    const onApr30 = await listFutureAbsences({ moduleId, activeOnDate: '2026-04-30' });
    expect(onApr30).toHaveLength(1);
    expect(onApr30[0].badgeId).toBe('001');

    const onMay10 = await listFutureAbsences({ moduleId, activeOnDate: '2026-05-10' });
    expect(onMay10).toHaveLength(1);
    expect(onMay10[0].badgeId).toBe('002');

    const onMay15 = await listFutureAbsences({ moduleId, activeOnDate: '2026-05-15' });
    expect(onMay15).toHaveLength(0);
  });
});

// ── Setup DELETE ──────────────────────────────────────────────

describe('setup delete endpoints', () => {
  it('deleteShift fails while modules reference it, succeeds after modules removed', async () => {
    const { siteId, moduleId } = await seedPilot();
    const { deleteShift, deleteModule, createShift } = await import('../src/attendance/setup.js');
    const shift = await db('shifts').first();
    await expect(deleteShift(shift.id)).rejects.toThrow(/modules reference/);
    await deleteModule(moduleId);
    await deleteShift(shift.id);
    // Re-create to confirm state is clean
    await createShift({ siteId, name: 'X', clockStart: '08:00', clockEnd: '16:00', billingHoursMonThu: 8, billingHoursFri: 8, breaks: [] });
  });

  it('deleteModule fails while employees exist', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { deleteModule } = await import('../src/attendance/setup.js');
    await expect(deleteModule(moduleId)).rejects.toThrow(/employees exist/);
  });

  it('deleteAbsenceCode fails while a future absence uses it', async () => {
    const { siteId, moduleId } = await seedPilot();
    await seedEmployee(siteId, moduleId);
    const { createFutureAbsence } = await import('../src/attendance/future-absences.js');
    const { deleteAbsenceCode } = await import('../src/attendance/setup.js');
    await createFutureAbsence({ moduleId, badgeId: '001', absenceCode: 'V', dateStart: '2026-04-28', filedByChatId: 'sup' });
    await expect(deleteAbsenceCode(siteId, 'V')).rejects.toThrow(/used by one or more future-absence/);
  });
});
