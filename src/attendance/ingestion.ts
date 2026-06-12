/**
 * Ingestion orchestrator (rc.88).
 *
 * One thin function per data type (`ingestRoster`, `ingestBadgeRecords`)
 * that wires parser → validator → DB writes → IngestionReport.
 *
 * The orchestrator owns:
 *   - Persistence of both the validated data and the ingestion report
 *     (so operators can always answer "why was row 47 skipped?")
 *   - Idempotence: re-ingesting the same file produces the same DB
 *     state. Employees are upserted by (site, badge); badge records
 *     replace any prior rows for the same (module, date).
 *   - Cross-data-type awareness: badge ingestion will warn when a
 *     badge_id is not in the current roster, so HR spots stale rosters.
 *
 * The orchestrator does NOT own source selection — callers pass in the
 * source they want to read from. This keeps the admin-UI flow (upload
 * a specific file) and the future scheduled flow (pick from config +
 * selector) both simple.
 */
import { randomUUID } from 'node:crypto';
import { getKnex } from '../db-knex.js';
import { logger } from '../logger.js';
import { parseFile } from './parser.js';
import {
  validateRoster,
  validateBadgeRecords,
  buildIngestionReport,
  type RosterValidationResult,
  type BadgeValidationResult,
} from './validation.js';
import type {
  IngestionReport,
  RosterEntry,
  BadgeRecord,
  ColumnMapping,
  DateOnly,
  AttendanceDataSource,
} from './types.js';

// ── Public API ────────────────────────────────────────────────

export interface IngestRosterParams {
  moduleId: string;
  siteId: string;
  filePath: string;
  mapping: ColumnMapping;
  delimiter?: string;
  encoding?: 'utf-8' | 'latin1';
}

export interface IngestBadgeParams {
  moduleId: string;
  siteId: string;
  filePath: string;
  mapping: ColumnMapping;
  expectedDate: DateOnly;
  delimiter?: string;
  encoding?: 'utf-8' | 'latin1';
}

/**
 * Parse a roster CSV, validate, upsert employees, write ingestion report.
 * Idempotent — running the same file twice yields no duplicate rows.
 */
export async function ingestRoster(p: IngestRosterParams): Promise<IngestionReport> {
  const startedAt = Date.now();
  let rowsRead = 0;
  let result: RosterValidationResult = { accepted: [], skipped: [], warnings: [] };
  let errorMessage: string | undefined;

  try {
    const rows = parseFile(p.filePath, {
      mapping: p.mapping.fields,
      delimiter: p.delimiter,
      encoding: p.encoding,
    });
    rowsRead = rows.length;

    const priorRowCount = await countEmployeesForModule(p.moduleId);
    result = validateRoster(rows, { moduleId: p.moduleId, priorRowCount });

    await upsertEmployees(p.siteId, result.accepted);
  } catch (err) {
    errorMessage = (err as Error).message;
    logger.error({ err, moduleId: p.moduleId }, 'Attendance: ingestRoster failed');
  }

  const report = buildIngestionReport({
    id: `ing_${randomUUID()}`,
    moduleId: p.moduleId,
    dataType: 'roster',
    sourceKind: 'csv',
    filePath: p.filePath,
    rowsRead,
    rowsAccepted: result.accepted.length,
    skipped: result.skipped,
    warnings: result.warnings,
    startedAt,
    completedAt: Date.now(),
    succeeded: !errorMessage,
    errorMessage,
  });

  await persistIngestionReport(report);
  return report;
}

/**
 * Parse a badge-records CSV, validate, replace prior records for the
 * (module, date), write ingestion report.
 */
export async function ingestBadgeRecords(p: IngestBadgeParams): Promise<IngestionReport> {
  const startedAt = Date.now();
  let rowsRead = 0;
  let result: BadgeValidationResult = { accepted: [], skipped: [], warnings: [] };
  let errorMessage: string | undefined;

  try {
    const rows = parseFile(p.filePath, {
      mapping: p.mapping.fields,
      delimiter: p.delimiter,
      encoding: p.encoding,
    });
    rowsRead = rows.length;

    const knownBadgeIds = await loadKnownBadgeIds(p.siteId);
    const priorRowCount = await countBadgeRecordsForModule(p.moduleId, p.expectedDate);
    result = validateBadgeRecords(rows, {
      moduleId: p.moduleId,
      siteId: p.siteId,
      expectedDate: p.expectedDate,
      knownBadgeIds,
      priorRowCount,
    });

    await replaceBadgeRecordsForDate(p.siteId, p.moduleId, p.expectedDate, result.accepted);
  } catch (err) {
    errorMessage = (err as Error).message;
    logger.error({ err, moduleId: p.moduleId }, 'Attendance: ingestBadgeRecords failed');
  }

  const report = buildIngestionReport({
    id: `ing_${randomUUID()}`,
    moduleId: p.moduleId,
    dataType: 'badge',
    sourceKind: 'csv',
    filePath: p.filePath,
    rowsRead,
    rowsAccepted: result.accepted.length,
    skipped: result.skipped,
    warnings: result.warnings,
    startedAt,
    completedAt: Date.now(),
    succeeded: !errorMessage,
    errorMessage,
  });

  await persistIngestionReport(report);
  return report;
}

// ── DB helpers ────────────────────────────────────────────────

async function countEmployeesForModule(moduleId: string): Promise<number> {
  const db = getKnex();
  const row = await db('attendance_employees').where({ module_id: moduleId }).count('* as c').first();
  return Number((row as { c?: number })?.c ?? 0);
}

async function countBadgeRecordsForModule(moduleId: string, date: DateOnly): Promise<number> {
  const db = getKnex();
  const row = await db('attendance_badge_records')
    .where({ module_id: moduleId, date })
    .count('* as c')
    .first();
  return Number((row as { c?: number })?.c ?? 0);
}

async function loadKnownBadgeIds(siteId: string): Promise<Set<string>> {
  const db = getKnex();
  const rows = await db('attendance_employees')
    .where({ site_id: siteId })
    .select('badge_id') as Array<{ badge_id: string }>;
  return new Set(rows.map((r) => r.badge_id));
}

async function upsertEmployees(siteId: string, employees: RosterEntry[]): Promise<void> {
  if (employees.length === 0) return;
  const db = getKnex();
  const now = Date.now();
  await db.transaction(async (trx) => {
    for (const e of employees) {
      const existing = await trx('attendance_employees')
        .where({ site_id: siteId, badge_id: e.badgeId })
        .first();
      if (existing) {
        await trx('attendance_employees')
          .where({ site_id: siteId, badge_id: e.badgeId })
          .update({
            full_name: e.fullName,
            cost_center: e.costCenter,
            labor_type: e.laborType,
            line: e.line,
            module_id: e.moduleId,
            supervisor_name: e.supervisorName,
            raw_row: JSON.stringify(e.rawRow),
            updated_at: now,
          });
      } else {
        await trx('attendance_employees').insert({
          site_id: siteId,
          badge_id: e.badgeId,
          full_name: e.fullName,
          cost_center: e.costCenter,
          labor_type: e.laborType,
          line: e.line,
          module_id: e.moduleId,
          supervisor_name: e.supervisorName,
          raw_row: JSON.stringify(e.rawRow),
          created_at: now,
          updated_at: now,
        });
      }
    }
  });
}

async function replaceBadgeRecordsForDate(
  siteId: string,
  moduleId: string,
  date: DateOnly,
  records: BadgeRecord[],
): Promise<void> {
  const db = getKnex();
  const now = Date.now();
  await db.transaction(async (trx) => {
    await trx('attendance_badge_records').where({ module_id: moduleId, date }).del();
    if (records.length === 0) return;
    await trx('attendance_badge_records').insert(records.map((r) => ({
      id: `br_${randomUUID()}`,
      site_id: siteId,
      module_id: moduleId,
      badge_id: r.badgeId,
      date: r.date,
      timestamp_in: r.timestampIn,
      timestamp_out: r.timestampOut,
      raw_row: JSON.stringify(r.rawRow),
      created_at: now,
    })));
  });
}

async function persistIngestionReport(report: IngestionReport): Promise<void> {
  const db = getKnex();
  await db('attendance_ingestion_reports').insert({
    id: report.id,
    module_id: report.moduleId,
    data_type: report.dataType,
    source_kind: report.sourceKind,
    file_path: report.filePath,
    rows_read: report.rowsRead,
    rows_accepted: report.rowsAccepted,
    rows_skipped: report.rowsSkipped,
    skipped_reasons: JSON.stringify(report.skippedReasons),
    warnings: JSON.stringify(report.warnings),
    started_at: report.startedAt,
    completed_at: report.completedAt,
    succeeded: report.succeeded,
    error_message: report.errorMessage,
  });
}

// ── Read helpers (used by admin UI) ───────────────────────────

export async function listRecentIngestionReports(limit: number = 20): Promise<IngestionReport[]> {
  const db = getKnex();
  const rows = await db('attendance_ingestion_reports')
    .orderBy('completed_at', 'desc')
    .limit(limit) as Array<{
      id: string; module_id: string; data_type: 'roster' | 'badge';
      source_kind: 'csv' | 'api' | 'supervisor-sensor';
      file_path: string | null;
      rows_read: number; rows_accepted: number; rows_skipped: number;
      skipped_reasons: string; warnings: string;
      started_at: number; completed_at: number;
      succeeded: number; error_message: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    moduleId: r.module_id,
    dataType: r.data_type,
    sourceKind: r.source_kind,
    filePath: r.file_path,
    rowsRead: r.rows_read,
    rowsAccepted: r.rows_accepted,
    rowsSkipped: r.rows_skipped,
    skippedReasons: JSON.parse(r.skipped_reasons),
    warnings: JSON.parse(r.warnings),
    startedAt: r.started_at,
    completedAt: r.completed_at,
    succeeded: Boolean(r.succeeded),
    errorMessage: r.error_message,
  }));
}

/**
 * Run the read path via an abstract data source (any of CSV / API /
 * supervisor-sensor). Used by scheduled ingestions in later phases.
 * Today, only the admin UI upload flow is wired in rc.88.
 */
export async function ingestViaSource(
  source: AttendanceDataSource,
  dataType: 'roster' | 'badge',
  date: DateOnly,
): Promise<RosterEntry[] | BadgeRecord[]> {
  return dataType === 'roster' ? source.getRoster(date) : source.getBadgeRecords(date);
}
