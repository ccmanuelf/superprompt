/**
 * Attendance schema — verifies every table declared by
 * src/attendance/schema.ts actually creates under SQLite, and that
 * initTables is idempotent (rebooting a live instance must never fail).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

// Use the real initKnex() entry point so schema.ts picks up the same
// getKnex() singleton — testing through the public surface, not
// monkey-patching.
let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-attendance-schema-'));
  const dbPath = join(storeDir, 'test.db');

  const dbKnex = await import('../src/db-knex.js');
  db = dbKnex.initKnex({ driver: 'sqlite', sqliteFilename: dbPath });
});

afterAll(async () => {
  const dbKnex = await import('../src/db-knex.js');
  await dbKnex.destroyKnex();
  rmSync(storeDir, { recursive: true, force: true });
});

describe('attendance schema', () => {
  it('initAttendanceTables creates all 14 tables', async () => {
    const { attendanceTableInit } = await import('../src/attendance/schema.js');
    await attendanceTableInit.initTables();

    const expected = [
      'sites',
      'shifts',
      'breaks',
      'attendance_modules',
      'absence_codes',
      'user_roles',
      'attendance_data_sources',
      'attendance_column_mappings',
      'attendance_employees',
      'attendance_badge_records',
      'attendance_records',
      'attendance_future_absences',
      'attendance_adjustments',
      'attendance_report_snapshots',
      'attendance_ingestion_reports',
    ];

    for (const table of expected) {
      const exists = await db.schema.hasTable(table);
      expect(exists, `table "${table}" should exist`).toBe(true);
    }
  });

  it('is idempotent — re-running does not throw', async () => {
    const { attendanceTableInit } = await import('../src/attendance/schema.js');
    await expect(attendanceTableInit.initTables()).resolves.not.toThrow();
    await expect(attendanceTableInit.initTables()).resolves.not.toThrow();
  });

  it('attendance_records enforces module + badge + date uniqueness', async () => {
    const now = Date.now();
    // Seed the FK chain
    await db('sites').insert({ id: 's1', name: 'Plant B', client_name: 'Test', timezone: 'UTC', created_at: now, updated_at: now });
    await db('shifts').insert({ id: 'sh1', site_id: 's1', name: 'First', clock_start: '07:00', clock_end: '17:00', billing_hours_mon_thu: 9.5, billing_hours_fri: 10.0, created_at: now, updated_at: now });
    await db('attendance_modules').insert({ id: 'm1', site_id: 's1', name: 'CELL 1', supervisor_name: 'Doe', shift_id: 'sh1', created_at: now, updated_at: now });

    await db('attendance_records').insert({
      id: 'r1', module_id: 'm1', badge_id: 'B1', date: '2026-04-23',
      resolution: 'present', billing_hours: 9.5, performance_hours: 8.83,
      resolved_by_kind: 'badge', resolved_at: now, created_at: now, updated_at: now,
    });

    // Duplicate (module, badge, date) must fail
    await expect(db('attendance_records').insert({
      id: 'r2', module_id: 'm1', badge_id: 'B1', date: '2026-04-23',
      resolution: 'late', billing_hours: 8.5, performance_hours: 7.83,
      resolved_by_kind: 'supervisor', resolved_at: now, created_at: now, updated_at: now,
    })).rejects.toThrow(/UNIQUE/);
  });

  it('attendance_data_sources enforces one config per (module, data_type)', async () => {
    const now = Date.now();
    await db('attendance_data_sources').insert({
      id: 'ds1', module_id: 'm1', data_type: 'roster',
      preferred_kind: 'csv', config: '{}', enabled: true,
      created_at: now, updated_at: now,
    });
    await expect(db('attendance_data_sources').insert({
      id: 'ds2', module_id: 'm1', data_type: 'roster',
      preferred_kind: 'api', config: '{}', enabled: true,
      created_at: now, updated_at: now,
    })).rejects.toThrow(/UNIQUE/);

    // Same module, different data_type: OK
    await expect(db('attendance_data_sources').insert({
      id: 'ds3', module_id: 'm1', data_type: 'badge',
      preferred_kind: 'csv', config: '{}', enabled: true,
      created_at: now, updated_at: now,
    })).resolves.not.toThrow();
  });
});
