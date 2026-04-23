/**
 * Role enforcement + organisational CRUD — the Phase A gaps surfaced
 * by user-level walk-through and fixed in rc.89. Runs against a real
 * SQLite DB so constraints and role-chain interactions are genuinely
 * exercised.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-roles-setup-'));
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
  // Clear in FK-child-first order so constraints pass. This is the same
  // order the production schema would enforce on a cascade delete.
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

// ── Roles ─────────────────────────────────────────────────────

describe('attendance roles', () => {
  it('isBootstrapAdmin: chat_id in ALLOWED_CHAT_ID is auto-admin', async () => {
    // Config reads ALLOWED_CHAT_ID at module load. Override via the
    // config object for the test; the module re-reads on each call.
    const cfg = await import('../src/config.js');
    const prior = cfg.config.ALLOWED_CHAT_ID;
    // @ts-expect-error test-only mutation
    cfg.config.ALLOWED_CHAT_ID = '123, 456 ,789';
    try {
      const { isBootstrapAdmin, hasRole } = await import('../src/attendance/roles.js');
      expect(isBootstrapAdmin('123')).toBe(true);
      expect(isBootstrapAdmin('456')).toBe(true);
      expect(isBootstrapAdmin('789')).toBe(true);
      expect(isBootstrapAdmin('999')).toBe(false);
      expect(await hasRole('123', 'admin')).toBe(true);
      expect(await hasRole('999', 'admin')).toBe(false);
    } finally {
      // @ts-expect-error restore
      cfg.config.ALLOWED_CHAT_ID = prior;
    }
  });

  it('grantRole / hasRole / revokeRole round-trip', async () => {
    const { grantRole, hasRole, revokeRole, listRoles } = await import('../src/attendance/roles.js');

    expect(await hasRole('user1', 'hr')).toBe(false);
    await grantRole({ chatId: 'user1', role: 'hr', grantedBy: 'admin1' });
    expect(await hasRole('user1', 'hr')).toBe(true);

    const roles = await listRoles('user1');
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ chatId: 'user1', role: 'hr', moduleId: null });

    await revokeRole({ chatId: 'user1', role: 'hr' });
    expect(await hasRole('user1', 'hr')).toBe(false);
  });

  it('re-granting a revoked role clears revoked_at instead of inserting a duplicate', async () => {
    const { grantRole, revokeRole, hasRole } = await import('../src/attendance/roles.js');

    await grantRole({ chatId: 'u2', role: 'hr', grantedBy: 'admin1' });
    await revokeRole({ chatId: 'u2', role: 'hr' });
    expect(await hasRole('u2', 'hr')).toBe(false);
    await grantRole({ chatId: 'u2', role: 'hr', grantedBy: 'admin1' });
    expect(await hasRole('u2', 'hr')).toBe(true);

    const rows = await db('user_roles').where({ chat_id: 'u2', role: 'hr' });
    expect(rows).toHaveLength(1);
  });

  it('supervisor role is module-scoped: hasRole(user, supervisor, moduleId) respects scope', async () => {
    const { grantRole, hasRole } = await import('../src/attendance/roles.js');

    // Supervisor for M1 only
    await grantRole({ chatId: 'sup1', role: 'supervisor', moduleId: 'M1', grantedBy: 'admin1' });
    expect(await hasRole('sup1', 'supervisor', 'M1')).toBe(true);
    expect(await hasRole('sup1', 'supervisor', 'M2')).toBe(false);

    // Site-wide supervisor (moduleId null) satisfies any module check
    await grantRole({ chatId: 'sup2', role: 'supervisor', moduleId: null, grantedBy: 'admin1' });
    expect(await hasRole('sup2', 'supervisor', 'M1')).toBe(true);
    expect(await hasRole('sup2', 'supervisor', 'M2')).toBe(true);
  });

  it('requireRole throws RoleRequiredError when the caller lacks the role', async () => {
    const { requireRole, RoleRequiredError } = await import('../src/attendance/roles.js');
    try {
      await requireRole('stranger', 'admin');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoleRequiredError);
      expect((err as InstanceType<typeof RoleRequiredError>).role).toBe('admin');
    }
  });
});

// ── Setup CRUD ────────────────────────────────────────────────

describe('attendance setup: sites', () => {
  it('creates a site with a sensible default timezone', async () => {
    const { createSite, listSites } = await import('../src/attendance/setup.js');
    const id = await createSite({ name: 'Plant B', clientName: 'Franklin' });
    const sites = await listSites();
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ id, name: 'Plant B', clientName: 'Franklin', timezone: 'America/Mexico_City' });
  });

  it('rejects empty name or clientName', async () => {
    const { createSite } = await import('../src/attendance/setup.js');
    await expect(createSite({ name: '', clientName: 'X' })).rejects.toThrow(/required/);
    await expect(createSite({ name: 'X', clientName: '' })).rejects.toThrow(/required/);
  });

  it('refuses to delete a site while employees reference it', async () => {
    const { createSite, deleteSite } = await import('../src/attendance/setup.js');
    const id = await createSite({ name: 'Plant A', clientName: 'C' });
    const now = Date.now();
    await db('shifts').insert({
      id: 'sh1', site_id: id, name: 'First', clock_start: '07:00', clock_end: '17:00',
      billing_hours_mon_thu: 9.5, billing_hours_fri: 10, created_at: now, updated_at: now,
    });
    await db('attendance_modules').insert({
      id: 'mod1', site_id: id, name: 'CELL A', supervisor_name: 'X',
      shift_id: 'sh1', created_at: now, updated_at: now,
    });
    await db('attendance_employees').insert({
      site_id: id, badge_id: '001', full_name: 'Alice', cost_center: '',
      labor_type: 'direct', line: 'L1', module_id: 'mod1', supervisor_name: 'X',
      raw_row: '{}', created_at: now, updated_at: now,
    });
    await expect(deleteSite(id)).rejects.toThrow(/employees exist/);
  });
});

describe('attendance setup: shifts + breaks', () => {
  async function seedSite(): Promise<string> {
    const { createSite } = await import('../src/attendance/setup.js');
    return createSite({ name: 'P', clientName: 'C' });
  }

  it('creates a shift with breaks and lists them together', async () => {
    const { createShift, listShifts } = await import('../src/attendance/setup.js');
    const siteId = await seedSite();
    const id = await createShift({
      siteId, name: 'First', clockStart: '07:00', clockEnd: '17:00',
      billingHoursMonThu: 9.5, billingHoursFri: 10,
      breaks: [
        { name: 'Lunch', durationMinutes: 70, paid: false },
        { name: 'Break AM', durationMinutes: 10, paid: true },
      ],
    });
    const shifts = await listShifts();
    expect(shifts).toHaveLength(1);
    expect(shifts[0].id).toBe(id);
    expect(shifts[0].breaks).toHaveLength(2);
    const lunch = shifts[0].breaks.find((b) => b.name === 'Lunch');
    expect(lunch?.paid).toBe(false);
    expect(lunch?.durationMinutes).toBe(70);
  });

  it('rejects bad clock-time formats', async () => {
    const { createShift } = await import('../src/attendance/setup.js');
    const siteId = await seedSite();
    await expect(createShift({
      siteId, name: 'X', clockStart: '7am', clockEnd: '17:00',
      billingHoursMonThu: 9.5, billingHoursFri: 10, breaks: [],
    })).rejects.toThrow(/HH:MM/);
  });

  it('rejects negative billing hours', async () => {
    const { createShift } = await import('../src/attendance/setup.js');
    const siteId = await seedSite();
    await expect(createShift({
      siteId, name: 'X', clockStart: '07:00', clockEnd: '17:00',
      billingHoursMonThu: -1, billingHoursFri: 10, breaks: [],
    })).rejects.toThrow(/positive/);
  });

  it('rejects shift pointing at non-existent site', async () => {
    const { createShift } = await import('../src/attendance/setup.js');
    await expect(createShift({
      siteId: 'NOPE', name: 'X', clockStart: '07:00', clockEnd: '17:00',
      billingHoursMonThu: 9.5, billingHoursFri: 10, breaks: [],
    })).rejects.toThrow(/does not exist/);
  });
});

describe('attendance setup: modules', () => {
  it('enforces that shift belongs to the same site as the module', async () => {
    const { createSite, createShift, createModule } = await import('../src/attendance/setup.js');
    const siteA = await createSite({ name: 'A', clientName: 'C' });
    const siteB = await createSite({ name: 'B', clientName: 'C' });
    const shiftA = await createShift({
      siteId: siteA, name: 'First', clockStart: '07:00', clockEnd: '17:00',
      billingHoursMonThu: 9.5, billingHoursFri: 10, breaks: [],
    });

    // shift from A, module claiming site B → rejected
    await expect(createModule({
      siteId: siteB, name: 'M', supervisorName: 'S', shiftId: shiftA,
    })).rejects.toThrow(/does not exist/);
  });
});

describe('attendance setup: absence codes', () => {
  async function seedSite(): Promise<string> {
    const { createSite } = await import('../src/attendance/setup.js');
    return createSite({ name: 'P', clientName: 'C' });
  }

  it('seedDefaultAbsenceCodes installs the 7 VP codes and is idempotent', async () => {
    const { seedDefaultAbsenceCodes, listAbsenceCodes, DEFAULT_ABSENCE_CODES } =
      await import('../src/attendance/setup.js');
    const siteId = await seedSite();
    const count1 = await seedDefaultAbsenceCodes(siteId);
    expect(count1).toBe(DEFAULT_ABSENCE_CODES.length);
    const list1 = await listAbsenceCodes(siteId);
    expect(list1.map((c) => c.code).sort()).toEqual(['DI', 'P', 'PP', 'PT', 'SI', 'U', 'V']);
    // Re-seed: no duplicates, still same count
    await seedDefaultAbsenceCodes(siteId);
    const list2 = await listAbsenceCodes(siteId);
    expect(list2.length).toBe(list1.length);
  });

  it('upsertAbsenceCode updates the existing row rather than inserting a duplicate', async () => {
    const { upsertAbsenceCode, listAbsenceCodes } = await import('../src/attendance/setup.js');
    const siteId = await seedSite();
    await upsertAbsenceCode({ siteId, code: 'U', descriptionEn: 'Unexcused', descriptionEs: 'Falta' });
    await upsertAbsenceCode({ siteId, code: 'U', descriptionEn: 'Updated', descriptionEs: 'Actualizado' });
    const codes = await listAbsenceCodes(siteId);
    expect(codes).toHaveLength(1);
    expect(codes[0].descriptionEn).toBe('Updated');
  });
});
