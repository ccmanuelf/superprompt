/**
 * Ingestion orchestrator — end-to-end from a real CSV file through
 * parser → validator → DB writes → persisted IngestionReport.
 *
 * Runs against a real on-disk SQLite DB so the Knex queries and the
 * schema constraints both get exercised.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Knex } from 'knex';

let storeDir: string;
let db: Knex;

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'luna-attendance-ingest-'));
  const dbKnex = await import('../src/db-knex.js');
  db = dbKnex.initKnex({ driver: 'sqlite', sqliteFilename: join(storeDir, 'test.db') });

  // Apply schema
  const { attendanceTableInit } = await import('../src/attendance/schema.js');
  await attendanceTableInit.initTables();

  // Seed a site + shift + module so FK constraints pass
  const now = Date.now();
  await db('sites').insert({
    id: 'S1', name: 'Plant B', client_name: 'Test Client', timezone: 'UTC',
    created_at: now, updated_at: now,
  });
  await db('shifts').insert({
    id: 'SH1', site_id: 'S1', name: 'First', clock_start: '07:00', clock_end: '17:00',
    billing_hours_mon_thu: 9.5, billing_hours_fri: 10.0, created_at: now, updated_at: now,
  });
  await db('attendance_modules').insert({
    id: 'M1', site_id: 'S1', name: 'CELL 1,4,5', supervisor_name: 'Sanchez',
    shift_id: 'SH1', created_at: now, updated_at: now,
  });
});

afterAll(async () => {
  const dbKnex = await import('../src/db-knex.js');
  await dbKnex.destroyKnex();
  rmSync(storeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset the mutable tables between tests so assertions are isolated.
  await db('attendance_ingestion_reports').del();
  await db('attendance_employees').del();
  await db('attendance_badge_records').del();
});

// ── Roster ingestion ─────────────────────────────────────────

describe('ingestRoster', () => {
  it('parses a clean CSV, upserts employees, and persists a report', async () => {
    const csvPath = join(storeDir, 'roster-clean.csv');
    writeFileSync(csvPath,
      'BadgeNumber,FullName,CostCenter,LaborType,Line,Supervisor\n' +
      '001,Alice,CC1,direct,L1,Sanchez\n' +
      '002,Bob,CC2,indirect,L2,Sanchez\n');

    const { ingestRoster } = await import('../src/attendance/ingestion.js');
    const report = await ingestRoster({
      moduleId: 'M1',
      siteId: 'S1',
      filePath: csvPath,
      mapping: {
        id: 'map1', moduleId: 'M1', dataType: 'roster',
        fields: {
          badge_id: 'BadgeNumber', full_name: 'FullName', cost_center: 'CostCenter',
          labor_type: 'LaborType', line: 'Line', supervisor_name: 'Supervisor',
        },
        samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
      },
    });

    expect(report.succeeded).toBe(true);
    expect(report.rowsRead).toBe(2);
    expect(report.rowsAccepted).toBe(2);
    expect(report.rowsSkipped).toBe(0);

    const employees = await db('attendance_employees').where({ module_id: 'M1' });
    expect(employees).toHaveLength(2);
    expect(employees.find((e) => e.badge_id === '001')?.full_name).toBe('Alice');
  });

  it('is idempotent — ingesting the same file twice leaves one row per employee', async () => {
    const csvPath = join(storeDir, 'roster-idempotent.csv');
    writeFileSync(csvPath,
      'Badge,Name,LaborType,Line\n' +
      '001,Alice,direct,L1\n');

    const { ingestRoster } = await import('../src/attendance/ingestion.js');
    const mapping = {
      id: 'map1', moduleId: 'M1', dataType: 'roster' as const,
      fields: { badge_id: 'Badge', full_name: 'Name', labor_type: 'LaborType', line: 'Line' },
      samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
    };

    await ingestRoster({ moduleId: 'M1', siteId: 'S1', filePath: csvPath, mapping });
    await ingestRoster({ moduleId: 'M1', siteId: 'S1', filePath: csvPath, mapping });

    const employees = await db('attendance_employees').where({ site_id: 'S1' });
    expect(employees).toHaveLength(1);
  });

  it('skipped rows appear in the persisted report with reasons', async () => {
    const csvPath = join(storeDir, 'roster-partial.csv');
    writeFileSync(csvPath,
      'Badge,Name,LaborType,Line\n' +
      '001,Alice,direct,L1\n' +
      ',Bob,direct,L2\n' +                       // missing badge
      '003,,direct,L3\n' +                        // missing name
      '004,Dave,contractor,L4\n');                // unknown labor type

    const { ingestRoster } = await import('../src/attendance/ingestion.js');
    const report = await ingestRoster({
      moduleId: 'M1',
      siteId: 'S1',
      filePath: csvPath,
      mapping: {
        id: 'map1', moduleId: 'M1', dataType: 'roster',
        fields: { badge_id: 'Badge', full_name: 'Name', labor_type: 'LaborType', line: 'Line' },
        samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
      },
    });

    expect(report.rowsRead).toBe(4);
    expect(report.rowsAccepted).toBe(1);
    expect(report.rowsSkipped).toBe(3);
    expect(report.skippedReasons.map((s) => s.rowNumber)).toEqual([3, 4, 5]);

    // Report round-trips through the DB
    const persisted = await db('attendance_ingestion_reports').first();
    expect(persisted).toBeTruthy();
    const skipped = JSON.parse(persisted.skipped_reasons);
    expect(skipped).toHaveLength(3);
  });
});

// ── Badge ingestion ──────────────────────────────────────────

describe('ingestBadgeRecords', () => {
  beforeEach(async () => {
    // Badge tests need a roster to cross-reference
    await db('attendance_employees').insert([
      {
        site_id: 'S1', badge_id: '001', full_name: 'Alice', cost_center: 'CC1',
        labor_type: 'direct', line: 'L1', module_id: 'M1', supervisor_name: 'Sanchez',
        raw_row: '{}', created_at: Date.now(), updated_at: Date.now(),
      },
      {
        site_id: 'S1', badge_id: '002', full_name: 'Bob', cost_center: 'CC2',
        labor_type: 'direct', line: 'L1', module_id: 'M1', supervisor_name: 'Sanchez',
        raw_row: '{}', created_at: Date.now(), updated_at: Date.now(),
      },
    ]);
  });

  it('parses IN/OUT-shape records and persists them', async () => {
    const csvPath = join(storeDir, 'badge-inout.csv');
    writeFileSync(csvPath,
      'Badge,Date,ClockIn,ClockOut\n' +
      '001,2026-04-23,2026-04-23T07:00:00Z,2026-04-23T17:00:00Z\n' +
      '002,2026-04-23,2026-04-23T07:05:00Z,2026-04-23T17:00:00Z\n');

    const { ingestBadgeRecords } = await import('../src/attendance/ingestion.js');
    const report = await ingestBadgeRecords({
      moduleId: 'M1',
      siteId: 'S1',
      filePath: csvPath,
      mapping: {
        id: 'map2', moduleId: 'M1', dataType: 'badge',
        fields: { badge_id: 'Badge', date: 'Date', timestamp_in: 'ClockIn', timestamp_out: 'ClockOut' },
        samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
      },
      expectedDate: '2026-04-23',
    });

    expect(report.succeeded).toBe(true);
    expect(report.rowsAccepted).toBe(2);

    const recs = await db('attendance_badge_records').where({ module_id: 'M1', date: '2026-04-23' });
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.badge_id === '001')?.timestamp_in).toBe(Date.parse('2026-04-23T07:00:00Z'));
  });

  it('coalesces IN/OUT rows when the source uses one row per punch', async () => {
    const csvPath = join(storeDir, 'badge-punch.csv');
    writeFileSync(csvPath,
      'Badge,Date,Timestamp,Direction\n' +
      '001,2026-04-23,2026-04-23T07:00:00Z,IN\n' +
      '001,2026-04-23,2026-04-23T17:00:00Z,OUT\n');

    const { ingestBadgeRecords } = await import('../src/attendance/ingestion.js');
    const report = await ingestBadgeRecords({
      moduleId: 'M1',
      siteId: 'S1',
      filePath: csvPath,
      mapping: {
        id: 'map3', moduleId: 'M1', dataType: 'badge',
        fields: { badge_id: 'Badge', date: 'Date', punch_timestamp: 'Timestamp', punch_direction: 'Direction' },
        samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
      },
      expectedDate: '2026-04-23',
    });

    expect(report.rowsAccepted).toBe(1);
    const rec = await db('attendance_badge_records').where({ module_id: 'M1', date: '2026-04-23' }).first();
    expect(rec.timestamp_in).toBeTruthy();
    expect(rec.timestamp_out).toBeTruthy();
  });

  it('replaces prior badge records for same (module, date) — no duplicates', async () => {
    const csvPath = join(storeDir, 'badge-replace.csv');
    writeFileSync(csvPath,
      'Badge,Date,ClockIn,ClockOut\n' +
      '001,2026-04-23,2026-04-23T07:00:00Z,2026-04-23T17:00:00Z\n');

    const { ingestBadgeRecords } = await import('../src/attendance/ingestion.js');
    const mapping = {
      id: 'map4', moduleId: 'M1', dataType: 'badge' as const,
      fields: { badge_id: 'Badge', date: 'Date', timestamp_in: 'ClockIn', timestamp_out: 'ClockOut' },
      samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
    };

    await ingestBadgeRecords({ moduleId: 'M1', siteId: 'S1', filePath: csvPath, mapping, expectedDate: '2026-04-23' });
    await ingestBadgeRecords({ moduleId: 'M1', siteId: 'S1', filePath: csvPath, mapping, expectedDate: '2026-04-23' });

    const recs = await db('attendance_badge_records').where({ module_id: 'M1', date: '2026-04-23' });
    expect(recs).toHaveLength(1);
  });

  it('warns when a badge record references an unknown employee', async () => {
    const csvPath = join(storeDir, 'badge-unknown.csv');
    writeFileSync(csvPath,
      'Badge,Date,ClockIn,ClockOut\n' +
      '999,2026-04-23,2026-04-23T07:00:00Z,2026-04-23T17:00:00Z\n');

    const { ingestBadgeRecords } = await import('../src/attendance/ingestion.js');
    const report = await ingestBadgeRecords({
      moduleId: 'M1',
      siteId: 'S1',
      filePath: csvPath,
      mapping: {
        id: 'map5', moduleId: 'M1', dataType: 'badge',
        fields: { badge_id: 'Badge', date: 'Date', timestamp_in: 'ClockIn', timestamp_out: 'ClockOut' },
        samplePreview: [], createdAt: Date.now(), updatedAt: Date.now(),
      },
      expectedDate: '2026-04-23',
    });
    expect(report.warnings.some((w) => w.detail.includes('999'))).toBe(true);
  });
});
