/**
 * Attendance row validation (Phase A, rc.88).
 *
 * Policy chosen with the manager: skip-with-warn at the row level, plus
 * an explicit ingestion report so HR/management can see inconsistencies.
 * Per-row skips are per-file only — they do not fail the whole ingestion.
 *
 * A separate sanity check looks for red flags at the aggregate level
 * (e.g., 40% row-count drop vs last ingest) and surfaces them as
 * warnings; it still lets the ingest complete because a smaller roster
 * is a legitimate scenario (end of month layoffs).
 */
import type {
  MappedRow,
} from './parser.js';
import { parseTimestamp, parseDateOnly } from './parser.js';
import type {
  RosterEntry,
  BadgeRecord,
  IngestionReport,
  IngestionWarningKind,
  DateOnly,
} from './types.js';

// ── Shared helpers ────────────────────────────────────────────

export interface SkippedRow {
  rowNumber: number;
  reason: string;
  rawRow: Record<string, unknown>;
}

export interface Warning {
  kind: IngestionWarningKind;
  detail: string;
}

export interface RosterValidationResult {
  accepted: RosterEntry[];
  skipped: SkippedRow[];
  warnings: Warning[];
}

export interface BadgeValidationResult {
  accepted: BadgeRecord[];
  skipped: SkippedRow[];
  warnings: Warning[];
}

// ── Roster validation ────────────────────────────────────────

export interface RosterValidateOptions {
  moduleId: string;
  /** Known count from the previous ingestion — used for sanity delta. */
  priorRowCount?: number;
  /**
   * Threshold for flagging a row-count drop. Defaults to 25% — smaller
   * values would false-positive on normal turnover.
   */
  rowCountDropThreshold?: number;
}

export function validateRoster(
  rows: MappedRow[],
  opts: RosterValidateOptions,
): RosterValidationResult {
  const accepted: RosterEntry[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: Warning[] = [];

  const seenBadgeIds = new Set<string>();

  for (const row of rows) {
    const f = row.fields;
    const reasons: string[] = [];

    if (!f.badge_id?.trim()) reasons.push('missing badge_id');
    if (!f.full_name?.trim()) reasons.push('missing full_name');
    if (!f.line?.trim()) reasons.push('missing line');

    const labor = (f.labor_type || '').trim().toLowerCase();
    const normalisedLabor: 'direct' | 'indirect' | null =
      labor === 'direct' || labor === 'd' || labor === 'directa' || labor === 'directo'
        ? 'direct'
        : labor === 'indirect' || labor === 'i' || labor === 'indirecta' || labor === 'indirecto'
          ? 'indirect'
          : null;
    if (!normalisedLabor) reasons.push(`unknown labor_type "${f.labor_type ?? ''}"`);

    if (reasons.length > 0) {
      skipped.push({ rowNumber: row.rowNumber, reason: reasons.join('; '), rawRow: row.rawRow });
      continue;
    }

    const badgeId = f.badge_id.trim();
    if (seenBadgeIds.has(badgeId)) {
      warnings.push({
        kind: 'duplicate-badge-id',
        detail: `badge_id "${badgeId}" appears more than once; row ${row.rowNumber} accepted (last-writer-wins)`,
      });
    }
    seenBadgeIds.add(badgeId);

    accepted.push({
      badgeId,
      fullName: f.full_name.trim(),
      costCenter: (f.cost_center ?? '').trim(),
      laborType: normalisedLabor!,
      line: f.line.trim(),
      moduleId: opts.moduleId,
      supervisorName: (f.supervisor_name ?? '').trim(),
      rawRow: row.rawRow,
    });
  }

  // Row-count drop sanity check
  if (opts.priorRowCount && opts.priorRowCount > 0) {
    const threshold = opts.rowCountDropThreshold ?? 0.25;
    const drop = (opts.priorRowCount - accepted.length) / opts.priorRowCount;
    if (drop > threshold) {
      warnings.push({
        kind: 'row-count-drop',
        detail: `roster dropped from ${opts.priorRowCount} to ${accepted.length} rows (${(drop * 100).toFixed(0)}% decline) — review before continuing`,
      });
    }
  }

  return { accepted, skipped, warnings };
}

// ── Badge record validation ──────────────────────────────────

export interface BadgeValidateOptions {
  moduleId: string;
  siteId: string;
  /** The shift date these records are expected to cover. Mismatches are warned. */
  expectedDate: DateOnly;
  knownBadgeIds?: Set<string>;
  knownAbsenceCodes?: Set<string>;
  priorRowCount?: number;
  rowCountDropThreshold?: number;
}

export function validateBadgeRecords(
  rows: MappedRow[],
  opts: BadgeValidateOptions,
): BadgeValidationResult {
  const accepted: BadgeRecord[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: Warning[] = [];

  // First pass: parse each row into normalised IN/OUT events.
  interface Punch {
    rowNumber: number;
    badgeId: string;
    date: DateOnly;
    tsIn: number | null;
    tsOut: number | null;
    rawRow: Record<string, unknown>;
  }
  const punches: Punch[] = [];

  for (const row of rows) {
    const f = row.fields;
    const reasons: string[] = [];

    const badgeId = (f.badge_id || '').trim();
    if (!badgeId) reasons.push('missing badge_id');

    // Two accepted shapes:
    //   A) explicit timestamp_in / timestamp_out columns
    //   B) punch_timestamp + punch_direction (IN / OUT)
    let tsIn: number | null = null;
    let tsOut: number | null = null;

    if (f.timestamp_in !== undefined || f.timestamp_out !== undefined) {
      tsIn = parseTimestamp(f.timestamp_in);
      tsOut = parseTimestamp(f.timestamp_out);
      if (!tsIn && !tsOut) reasons.push('timestamp_in and timestamp_out both unparseable');
    } else if (f.punch_timestamp !== undefined) {
      const ts = parseTimestamp(f.punch_timestamp);
      if (!ts) {
        reasons.push('punch_timestamp unparseable');
      } else {
        const dir = (f.punch_direction || '').trim().toUpperCase();
        if (dir === 'IN' || dir === 'ENTRADA') tsIn = ts;
        else if (dir === 'OUT' || dir === 'SALIDA') tsOut = ts;
        else reasons.push(`unknown punch_direction "${f.punch_direction ?? ''}"`);
      }
    } else {
      reasons.push('neither timestamp_in/out nor punch_timestamp present in mapping');
    }

    // Determine shift date. Prefer an explicit date column; fall back to
    // the date portion of whichever timestamp we parsed.
    let date: DateOnly | null = null;
    if (f.date) {
      date = parseDateOnly(f.date);
      if (!date) reasons.push(`date column "${f.date}" unparseable`);
    } else if (tsIn) {
      date = new Date(tsIn).toISOString().slice(0, 10);
    } else if (tsOut) {
      date = new Date(tsOut).toISOString().slice(0, 10);
    }
    if (!date) reasons.push('cannot determine shift date for row');

    if (reasons.length > 0) {
      skipped.push({ rowNumber: row.rowNumber, reason: reasons.join('; '), rawRow: row.rawRow });
      continue;
    }

    if (date !== opts.expectedDate) {
      warnings.push({
        kind: 'date-range-mismatch',
        detail: `row ${row.rowNumber} has date ${date}, expected ${opts.expectedDate}`,
      });
    }

    if (opts.knownBadgeIds && !opts.knownBadgeIds.has(badgeId)) {
      warnings.push({
        kind: 'duplicate-badge-id',
        detail: `row ${row.rowNumber}: badge_id "${badgeId}" is not in the roster — is the roster stale?`,
      });
    }

    punches.push({ rowNumber: row.rowNumber, badgeId, date: date!, tsIn, tsOut, rawRow: row.rawRow });
  }

  // Second pass: coalesce IN+OUT punches for the same (badge, date).
  // If a file uses shape B (punch_timestamp), there may be two rows per
  // employee (one IN, one OUT) that need to merge into one record.
  const byKey = new Map<string, Punch>();
  for (const p of punches) {
    const key = `${p.badgeId}|${p.date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
      continue;
    }
    // Merge: prefer the IN side from whichever row has one, same for OUT.
    existing.tsIn = existing.tsIn ?? p.tsIn;
    existing.tsOut = existing.tsOut ?? p.tsOut;
    // rawRow becomes the first row's — we don't attempt to merge JSON blobs.
  }

  for (const p of byKey.values()) {
    accepted.push({
      badgeId: p.badgeId,
      date: p.date,
      timestampIn: p.tsIn,
      timestampOut: p.tsOut,
      rawRow: p.rawRow,
    });
  }

  if (opts.priorRowCount && opts.priorRowCount > 0) {
    const threshold = opts.rowCountDropThreshold ?? 0.25;
    const drop = (opts.priorRowCount - accepted.length) / opts.priorRowCount;
    if (drop > threshold) {
      warnings.push({
        kind: 'row-count-drop',
        detail: `badge records dropped from ${opts.priorRowCount} to ${accepted.length} (${(drop * 100).toFixed(0)}% decline)`,
      });
    }
  }

  return { accepted, skipped, warnings };
}

// ── IngestionReport assembly (shared) ─────────────────────────

export function buildIngestionReport(params: {
  id: string;
  moduleId: string;
  dataType: 'roster' | 'badge';
  sourceKind: 'csv' | 'api' | 'supervisor-sensor';
  filePath: string | null;
  rowsRead: number;
  rowsAccepted: number;
  skipped: SkippedRow[];
  warnings: Warning[];
  startedAt: number;
  completedAt: number;
  succeeded: boolean;
  errorMessage?: string;
}): IngestionReport {
  return {
    id: params.id,
    moduleId: params.moduleId,
    dataType: params.dataType,
    sourceKind: params.sourceKind,
    filePath: params.filePath,
    rowsRead: params.rowsRead,
    rowsAccepted: params.rowsAccepted,
    rowsSkipped: params.skipped.length,
    skippedReasons: params.skipped,
    warnings: params.warnings,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    succeeded: params.succeeded,
    errorMessage: params.errorMessage ?? null,
  };
}
