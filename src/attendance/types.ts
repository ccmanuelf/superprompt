/**
 * Attendance Reconciliation — type contracts (Phase A, rc.88).
 *
 * Designed around two invariants that the manager set for the pilot:
 *   1. CSV is a first-class production data source, not a dev stub. An
 *      HR API will come later and must hot-swap in without rebuilding
 *      the ingestion pipeline.
 *   2. The CSV schema is UNKNOWN until HR hands over a real file. Every
 *      logical field must be discovered at runtime via operator-configured
 *      column mapping, never hardcoded.
 *
 * The AttendanceDataSource interface (below) is the single seam between
 * the workflow engine and the source of truth. Callers only ever see
 * RosterEntry / BadgeRecord; they never know or care whether the data
 * came from a CSV, an HTTP API, or a supervisor answering "¿quién falta?"
 * in Telegram.
 */

// ── Primitive types ───────────────────────────────────────────

/** ISO-8601 YYYY-MM-DD. */
export type DateOnly = string;

/**
 * Unix epoch milliseconds. Stored as INTEGER throughout — matches how
 * the rest of the codebase handles timestamps (sessions, chat_log, etc).
 */
export type Timestamp = number;

/** ISO-639-1 two-letter code. */
export type LanguageCode = 'en' | 'es';

// ── Core domain entities ──────────────────────────────────────

/**
 * A module is the finest unit of attendance — one supervisor manages one
 * module. Corresponds to the VP spreadsheet's "ASSY CELL 1,4,5" header.
 */
export interface Module {
  id: string;
  siteId: string;
  name: string;                   // e.g. "ASSY CELL 1,4,5"
  supervisorName: string;          // free-text; HR-authoritative spelling
  supervisorChatId: string | null; // Telegram chat_id once the supervisor joins; null before
  shiftId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Shift {
  id: string;
  siteId: string;
  name: string;                    // "First Shift"
  clockStart: string;              // "07:00"
  clockEnd: string;                // "17:00"
  billingHoursMonThu: number;      // e.g. 9.5
  billingHoursFri: number;         // e.g. 10.0
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Break {
  id: string;
  shiftId: string;
  name: string;                    // "Lunch"
  durationMinutes: number;         // 70
  paid: boolean;                   // false for lunch, true for short breaks
}

export interface AbsenceCode {
  code: string;                    // "U", "V", "DI", "PP", "P", "PT", "SI"
  descriptionEn: string;
  descriptionEs: string;
  countsAsPresent: boolean;        // false for absences; reserved for exotics
  billingHoursFactor: number;      // 0 for absences, 1 for "present but code"
}

/**
 * The minimum employee payload the reconciliation engine needs. Every
 * field here is resolved via attendance_column_mappings; the physical
 * column names in the source CSV are unknown.
 */
export interface RosterEntry {
  badgeId: string;                 // primary external key — must match badge records
  fullName: string;                // "ROMERO BALDERAS, GERARDO"
  costCenter: string;              // "FP-ONT"
  laborType: 'direct' | 'indirect';
  line: string;                    // "ASSY LINE 01"
  moduleId: string;                // derived — maps employee to their module
  supervisorName: string;          // denormalized for quick lookup
  rawRow: Record<string, unknown>; // original CSV row, for audit
}

/**
 * Badge records from the T&A system. We do NOT assume a given row
 * represents a single clock-in/clock-out pair — some systems emit one
 * row per punch (IN, OUT). The parser normalizes to this shape and the
 * ingestion layer pairs punches by badge + date.
 */
export interface BadgeRecord {
  badgeId: string;
  date: DateOnly;                  // shift date (not punch date — crossover-midnight handled)
  timestampIn: Timestamp | null;   // null if only an OUT punch exists
  timestampOut: Timestamp | null;  // null if only an IN punch
  rawRow: Record<string, unknown>;
}

// ── Data source interface ─────────────────────────────────────

/**
 * The pluggable read interface. Every implementation (CSV, API,
 * supervisor-sensor) must satisfy this contract.
 *
 * Implementations should be STATELESS beyond their construction config
 * so the selector can cache or swap them freely.
 */
export interface AttendanceDataSource {
  /** Machine-readable source kind. Used by logging + the selector. */
  readonly kind: 'csv' | 'api' | 'supervisor-sensor';

  /** The module this source instance reads for. One source per module. */
  readonly moduleId: string;

  /**
   * Employees expected to be present on `date` for `moduleId`.
   * Empty array = genuinely zero employees (e.g. holiday); never throw
   * just because the roster is empty.
   */
  getRoster(date: DateOnly): Promise<RosterEntry[]>;

  /**
   * Clock-in/out records for `date` for `moduleId`. The supervisor-sensor
   * implementation returns an empty array here — downstream must be able
   * to handle "I have the roster but no badge data, ask the supervisor".
   */
  getBadgeRecords(date: DateOnly): Promise<BadgeRecord[]>;

  /**
   * Liveness probe. The selector uses this to decide whether to fall
   * through to a secondary source. Must not throw; return an explanation
   * when `available` is false so the log trail is useful.
   */
  healthCheck(): Promise<{ available: boolean; reason?: string }>;
}

// ── Configuration ─────────────────────────────────────────────

/**
 * Per-module, per-data-type configuration. One row per module × type.
 * The operator sets `preferredKind`; when the preferred source is
 * unhealthy the selector walks the implicit [api → csv → supervisor-sensor]
 * fallback chain. `config` is a kind-specific JSON blob — CSV stores the
 * file path and the mapping id; API stores endpoint + auth.
 */
export interface AttendanceDataSourceConfig {
  id: string;
  moduleId: string;
  dataType: 'roster' | 'badge';
  preferredKind: 'csv' | 'api' | 'supervisor-sensor';
  config: CsvSourceConfig | ApiSourceConfig | Record<string, never>;
  enabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CsvSourceConfig {
  kind: 'csv';
  filePath: string;               // absolute or relative to WORKSPACE_DIR
  columnMappingId: string;        // references attendance_column_mappings
  delimiter?: string;             // auto-detected if not set
  encoding?: 'utf-8' | 'latin1';  // default utf-8
}

export interface ApiSourceConfig {
  kind: 'api';
  endpointUrl: string;
  authMethod: 'none' | 'bearer' | 'basic' | 'header';
  authValue?: string;             // token for bearer, "user:pass" for basic, raw header value for header
  authHeaderName?: string;        // only for authMethod=header
  timeoutMs?: number;             // default 30_000
}

/**
 * The column-mapping row. The logical field -> physical column-name
 * translation lives here so the parser is fully schema-agnostic. One
 * mapping per (module, data_type) pair; updating replaces.
 *
 * Unknown physical columns are allowed — they're preserved in
 * RosterEntry.rawRow / BadgeRecord.rawRow for audit, not discarded.
 */
export interface ColumnMapping {
  id: string;
  moduleId: string;
  dataType: 'roster' | 'badge';
  /** logical field name → physical CSV column name. */
  fields: Record<string, string>;
  /** Sample values captured during the preview step, for humans. */
  samplePreview: Array<Record<string, string>>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Logical field names the CSV parser will recognize for roster data. */
export const ROSTER_LOGICAL_FIELDS = [
  'badge_id',
  'full_name',
  'cost_center',
  'labor_type',
  'line',
  'supervisor_name',
] as const;
export type RosterLogicalField = (typeof ROSTER_LOGICAL_FIELDS)[number];

/** Logical field names the CSV parser will recognize for badge data. */
export const BADGE_LOGICAL_FIELDS = [
  'badge_id',
  'date',
  'timestamp_in',
  'timestamp_out',
  'punch_timestamp',   // alternative: single-punch-per-row systems
  'punch_direction',   // "IN" | "OUT", paired with punch_timestamp
] as const;
export type BadgeLogicalField = (typeof BADGE_LOGICAL_FIELDS)[number];

// ── Ingestion reports ─────────────────────────────────────────

export interface IngestionReport {
  id: string;
  moduleId: string;
  dataType: 'roster' | 'badge';
  sourceKind: 'csv' | 'api' | 'supervisor-sensor';
  filePath: string | null;         // null for api/supervisor-sensor
  rowsRead: number;
  rowsAccepted: number;
  rowsSkipped: number;
  skippedReasons: Array<{ rowNumber: number; reason: string; rawRow: Record<string, unknown> }>;
  warnings: Array<{ kind: IngestionWarningKind; detail: string }>;
  startedAt: Timestamp;
  completedAt: Timestamp;
  succeeded: boolean;
  errorMessage: string | null;
}

export type IngestionWarningKind =
  | 'unknown-absence-code'
  | 'duplicate-badge-id'
  | 'row-count-drop'                // substantial drop vs previous ingest
  | 'date-range-mismatch'           // dates in file don't match expected shift date
  | 'unmapped-physical-column'      // CSV has column the mapping doesn't cover
  | 'missing-required-field';       // mapping doesn't cover a required logical field
