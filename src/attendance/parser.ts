/**
 * Schema-agnostic CSV / Excel parser (Phase A, rc.88).
 *
 * The core promise: accept a file whose column layout is unknown, along
 * with a column mapping (`{logical_field: physical_column_name}`), and
 * emit rows keyed by the logical fields the caller asked for. Original
 * row content is preserved in `rawRow` for audit.
 *
 * Every quirk the parser tolerates is driven by a real thing we expect
 * to see from HR exports:
 *   - UTF-8 BOMs from Excel "Save As CSV"
 *   - CRLF line endings from Windows
 *   - Comma / semicolon / tab delimiters (regional Excel defaults)
 *   - Latin-1 encoding (Mexican plants sometimes export this by default)
 *   - Trailing empty lines
 *   - Header case/whitespace drift ("Badge ID" vs "badge_id" vs "BADGE")
 *   - .xlsx files uploaded directly (we read with exceljs)
 *
 * What the parser deliberately does NOT do:
 *   - Guess the column mapping. That's a separate, operator-driven step
 *     that happens once per module in the admin UI.
 *   - Validate business rules. That's validation.ts.
 *   - Write to the DB. That's ingestion.ts.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { DateOnly, Timestamp } from './types.js';

// ── Previewing (admin UI column-mapping step) ─────────────────

export interface ParsedPreview {
  /** Canonicalised physical column names (trimmed, BOM-stripped). */
  headers: string[];
  /** First N rows as header→value dicts, for the mapping UI table. */
  sampleRows: Array<Record<string, string>>;
  /** Auto-detected delimiter — the admin UI can display for confirmation. */
  delimiter: string;
  /** Total rows in file, excluding header and trailing blanks. */
  totalRows: number;
}

export interface PreviewOptions {
  /** How many sample rows to keep for the UI. Default 10. */
  sampleLimit?: number;
  /** Override auto-detection. */
  delimiter?: string;
  /** Override encoding (default utf-8). */
  encoding?: 'utf-8' | 'latin1';
}

/**
 * Read a file and produce a preview for the admin column-mapping step.
 * Does not require a mapping — the whole point is to see what columns
 * the file has.
 */
export function previewFile(filePath: string, opts: PreviewOptions = {}): ParsedPreview {
  const buf = readFileSync(filePath);
  return previewBuffer(buf, opts);
}

/**
 * Same as previewFile, but operates on an in-memory buffer (for upload
 * handlers that never write to disk).
 */
export function previewBuffer(buf: Buffer, opts: PreviewOptions = {}): ParsedPreview {
  const sampleLimit = opts.sampleLimit ?? 10;
  const text = decode(buf, opts.encoding);
  const cleaned = stripBom(text);
  const delimiter = opts.delimiter ?? detectDelimiter(cleaned);

  const rows = parse(cleaned, {
    delimiter,
    columns: true,           // first row as header
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true, // tolerate rows with missing trailing columns
    relax_quotes: true,
    bom: true,
  }) as Array<Record<string, string>>;

  const headers = rows.length > 0 ? Object.keys(rows[0]).map(canonicalHeader) : [];

  // Re-key rows using the canonical header names for UI consistency.
  const sampleRows = rows.slice(0, sampleLimit).map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      out[canonicalHeader(k)] = v ?? '';
    }
    return out;
  });

  return {
    headers,
    sampleRows,
    delimiter,
    totalRows: rows.length,
  };
}

// ── Applying a mapping (actual ingestion read) ────────────────

export interface ParseOptions extends PreviewOptions {
  /** Required: logical field → physical column name. */
  mapping: Record<string, string>;
}

export interface MappedRow {
  /** Index in file (1-based, counts header as row 0). */
  rowNumber: number;
  /** Logical-field view of the row. Values are strings; caller coerces. */
  fields: Record<string, string>;
  /** Original row, canonical-header keyed. Preserves unmapped columns for audit. */
  rawRow: Record<string, string>;
}

/**
 * Read a file and emit rows keyed by logical field names.
 *
 * Rows where a required mapped column is MISSING ENTIRELY from the file
 * are surfaced as a parser-level error — the caller should not get rows
 * back when the mapping is structurally wrong. Rows where the column
 * exists but an individual cell is empty are returned with an empty
 * string, and validation.ts decides whether to skip or accept.
 */
export function parseFile(filePath: string, opts: ParseOptions): MappedRow[] {
  const buf = readFileSync(filePath);
  return parseBuffer(buf, opts);
}

export function parseBuffer(buf: Buffer, opts: ParseOptions): MappedRow[] {
  const text = decode(buf, opts.encoding);
  const cleaned = stripBom(text);
  const delimiter = opts.delimiter ?? detectDelimiter(cleaned);

  const rows = parse(cleaned, {
    delimiter,
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  }) as Array<Record<string, string>>;

  if (rows.length === 0) return [];

  // Canonicalise headers on the first row, and verify every column the
  // mapping references actually exists in the file. Empty-string entries
  // mean the operator deliberately left a logical field unmapped — skip
  // those from the missing-column check.
  const canonicalHeaders = Object.keys(rows[0]).map(canonicalHeader);
  const missing = Object.entries(opts.mapping)
    .filter(([, physical]) => physical !== '' && !canonicalHeaders.includes(canonicalHeader(physical)))
    .map(([logical, physical]) => `"${physical}" (for logical "${logical}")`);
  if (missing.length > 0) {
    throw new Error(
      `parseBuffer: mapping references columns not present in the file: ${missing.join(', ')}. ` +
      `Available columns: ${canonicalHeaders.join(', ')}`,
    );
  }

  // Reverse-map: physical → logical, using canonical-cased keys for
  // lookup. Empty string physical entries in the mapping (operator
  // deliberately left a logical field unmapped) are ignored.
  const reverseMap = new Map<string, string>();
  for (const [logical, physical] of Object.entries(opts.mapping)) {
    if (!physical) continue;
    reverseMap.set(canonicalHeader(physical), logical);
  }

  return rows.map((row, idx) => {
    const canonicalRow: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      canonicalRow[canonicalHeader(k)] = v ?? '';
    }
    const fields: Record<string, string> = {};
    for (const [canonHeader, logical] of reverseMap) {
      fields[logical] = canonicalRow[canonHeader] ?? '';
    }
    return {
      rowNumber: idx + 2, // +2 because row 1 is the header
      fields,
      rawRow: canonicalRow,
    };
  });
}

// ── Internals ─────────────────────────────────────────────────

const BOM = '\uFEFF';

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function decode(buf: Buffer, encoding?: 'utf-8' | 'latin1'): string {
  return buf.toString(encoding ?? 'utf-8');
}

/**
 * Pick the delimiter by counting occurrences in the first non-empty line.
 * Candidates in order of likelihood: comma, semicolon, tab, pipe.
 * Tie-breaker: comma wins. This is the same heuristic Excel itself uses
 * when opening a CSV with an unknown delimiter.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = (firstLine.match(new RegExp(escapeForRegex(c), 'g')) || []).length;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Canonicalise a header name for case/whitespace-insensitive matching:
 *   "Badge ID "        → "badge id"
 *   "\uFEFFBadgeID"    → "badgeid"
 *   "Badge\t\tNumber"  → "badge number"
 *
 * Preserves the original header elsewhere — this is only for lookup.
 */
export function canonicalHeader(raw: string): string {
  return stripBom(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Value coercion helpers (used by validation.ts and sources) ────

/**
 * Parse a timestamp field. Accepts several formats because T&A exports
 * vary wildly:
 *   - ISO 8601: "2026-04-23T07:00:00Z"
 *   - Excel-serialized datetime as string: "2026-04-23 07:00:00"
 *   - Separate date + time columns: handled by the caller passing both
 *   - Unix epoch seconds/millis as a string
 *
 * Returns null (with no throw) when the string doesn't parse, so the
 * caller can log and skip without branching.
 */
export function parseTimestamp(raw: string | null | undefined): Timestamp | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Epoch numeric
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    // 10-digit = seconds, 13-digit = ms
    return trimmed.length === 10 ? n * 1000 : n;
  }

  // Excel's "YYYY-MM-DD HH:MM:SS" with a space separator — Date() accepts
  // it on modern Node but only in UTC-ambiguous mode. Normalise to T.
  const normalised = trimmed.replace(' ', 'T');
  const ts = Date.parse(normalised);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Parse a date-only field. Tolerates "YYYY-MM-DD", "DD/MM/YYYY",
 * "MM/DD/YYYY" (ambiguous — we pick DMY because the pilot is in MX).
 */
export function parseDateOnly(raw: string | null | undefined): DateOnly | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  // DD/MM/YYYY — MX convention
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Fall back to Date.parse
  const ts = Date.parse(s);
  if (Number.isFinite(ts)) {
    const d = new Date(ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}
