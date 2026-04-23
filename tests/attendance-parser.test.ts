/**
 * CSV parser — schema-agnostic behavior against the real shapes we
 * expect HR/T&A exports to arrive in. Every test corresponds to a
 * quirk we deliberately tolerate (see parser.ts header comment).
 */
import { describe, it, expect } from 'vitest';
import {
  previewBuffer,
  parseBuffer,
  canonicalHeader,
  parseTimestamp,
  parseDateOnly,
} from '../src/attendance/parser.js';

// ── canonicalHeader ───────────────────────────────────────────

describe('canonicalHeader', () => {
  it('trims whitespace', () => {
    expect(canonicalHeader('  Badge ID  ')).toBe('badge id');
  });
  it('lowercases', () => {
    expect(canonicalHeader('Badge Number')).toBe('badge number');
  });
  it('collapses internal whitespace runs', () => {
    expect(canonicalHeader('Badge\t\tNumber')).toBe('badge number');
  });
  it('strips BOM', () => {
    expect(canonicalHeader('\uFEFFBadge')).toBe('badge');
  });
});

// ── previewBuffer ────────────────────────────────────────────

describe('previewBuffer', () => {
  it('parses a plain UTF-8 comma CSV', () => {
    const csv = Buffer.from('badge_id,name\n001,Alice\n002,Bob\n');
    const r = previewBuffer(csv);
    expect(r.headers).toEqual(['badge_id', 'name']);
    expect(r.delimiter).toBe(',');
    expect(r.totalRows).toBe(2);
    expect(r.sampleRows).toEqual([
      { badge_id: '001', name: 'Alice' },
      { badge_id: '002', name: 'Bob' },
    ]);
  });

  it('strips UTF-8 BOM from Excel-exported CSVs', () => {
    const csv = Buffer.concat([
      Buffer.from('\uFEFF'), // BOM
      Buffer.from('Badge,Name\n001,Alice\n'),
    ]);
    const r = previewBuffer(csv);
    expect(r.headers[0]).toBe('badge');     // no leading BOM on the header
    expect(r.sampleRows[0]).toEqual({ badge: '001', name: 'Alice' });
  });

  it('handles CRLF line endings (Windows)', () => {
    const csv = Buffer.from('badge,name\r\n001,Alice\r\n002,Bob\r\n');
    const r = previewBuffer(csv);
    expect(r.totalRows).toBe(2);
    expect(r.sampleRows[1]).toEqual({ badge: '002', name: 'Bob' });
  });

  it('auto-detects semicolon delimiter (LATAM Excel default)', () => {
    const csv = Buffer.from('badge;name;line\n001;Alice;L1\n002;Bob;L2\n');
    const r = previewBuffer(csv);
    expect(r.delimiter).toBe(';');
    expect(r.headers).toEqual(['badge', 'name', 'line']);
    expect(r.sampleRows[0].line).toBe('L1');
  });

  it('auto-detects tab delimiter', () => {
    const csv = Buffer.from('badge\tname\n001\tAlice\n');
    const r = previewBuffer(csv);
    expect(r.delimiter).toBe('\t');
  });

  it('respects explicit delimiter override', () => {
    const csv = Buffer.from('badge|name\n001|Alice\n');
    const r = previewBuffer(csv, { delimiter: '|' });
    expect(r.delimiter).toBe('|');
    expect(r.headers).toEqual(['badge', 'name']);
  });

  it('canonicalises mixed-case and whitespace headers', () => {
    const csv = Buffer.from('  Badge ID ,  Full Name \n001,Alice\n');
    const r = previewBuffer(csv);
    expect(r.headers).toEqual(['badge id', 'full name']);
    expect(r.sampleRows[0]['badge id']).toBe('001');
  });

  it('limits sample to sampleLimit rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i},n${i}`).join('\n');
    const csv = Buffer.from(`badge,name\n${rows}\n`);
    const r = previewBuffer(csv, { sampleLimit: 5 });
    expect(r.sampleRows.length).toBe(5);
    expect(r.totalRows).toBe(50);
  });

  it('skips empty trailing lines', () => {
    const csv = Buffer.from('badge,name\n001,Alice\n\n\n');
    const r = previewBuffer(csv);
    expect(r.totalRows).toBe(1);
  });

  it('returns empty preview for empty file', () => {
    const r = previewBuffer(Buffer.from(''));
    expect(r.headers).toEqual([]);
    expect(r.sampleRows).toEqual([]);
    expect(r.totalRows).toBe(0);
  });
});

// ── parseBuffer ──────────────────────────────────────────────

describe('parseBuffer', () => {
  it('maps physical columns to logical fields', () => {
    const csv = Buffer.from('BadgeNumber,EmployeeName,CostCenter\n001,Alice,CC1\n002,Bob,CC2\n');
    const rows = parseBuffer(csv, {
      mapping: {
        badge_id: 'BadgeNumber',
        full_name: 'EmployeeName',
        cost_center: 'CostCenter',
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].fields).toEqual({
      badge_id: '001',
      full_name: 'Alice',
      cost_center: 'CC1',
    });
    expect(rows[0].rowNumber).toBe(2);  // header is row 1, first data row is 2
    expect(rows[1].rowNumber).toBe(3);
  });

  it('preserves unmapped columns in rawRow (audit trail)', () => {
    const csv = Buffer.from('BadgeNumber,Name,InternalNotes\n001,Alice,VIP\n');
    const rows = parseBuffer(csv, {
      mapping: { badge_id: 'BadgeNumber', full_name: 'Name' },
    });
    expect(rows[0].rawRow).toEqual({
      badgenumber: '001',
      name: 'Alice',
      internalnotes: 'VIP',
    });
  });

  it('throws a clear error when mapping references a missing column', () => {
    const csv = Buffer.from('badge,name\n001,Alice\n');
    expect(() =>
      parseBuffer(csv, { mapping: { badge_id: 'badge', full_name: 'FullName' } }),
    ).toThrow(/FullName.*for logical "full_name"/);
  });

  it('ignores empty mapping entries (logical field deliberately left unmapped)', () => {
    const csv = Buffer.from('badge,name\n001,Alice\n');
    const rows = parseBuffer(csv, {
      mapping: { badge_id: 'badge', full_name: 'name', cost_center: '' },
    });
    expect(rows[0].fields.badge_id).toBe('001');
    expect(rows[0].fields.full_name).toBe('Alice');
    expect(rows[0].fields.cost_center).toBeUndefined();
  });

  it('returns empty string for cells whose column is present but blank', () => {
    const csv = Buffer.from('badge,name,cc\n001,,CC1\n');
    const rows = parseBuffer(csv, {
      mapping: { badge_id: 'badge', full_name: 'name', cost_center: 'cc' },
    });
    expect(rows[0].fields.full_name).toBe('');
  });

  it('canonicalises the mapping lookup (case-insensitive match)', () => {
    const csv = Buffer.from('Badge ID,Full Name\n001,Alice\n');
    const rows = parseBuffer(csv, {
      mapping: { badge_id: 'BADGE ID', full_name: 'full name' },
    });
    expect(rows[0].fields).toEqual({ badge_id: '001', full_name: 'Alice' });
  });

  it('returns empty array on empty file', () => {
    const rows = parseBuffer(Buffer.from(''), { mapping: { badge_id: 'badge' } });
    expect(rows).toEqual([]);
  });
});

// ── parseTimestamp ────────────────────────────────────────────

describe('parseTimestamp', () => {
  it('parses ISO 8601', () => {
    expect(parseTimestamp('2026-04-23T07:00:00Z')).toBe(Date.parse('2026-04-23T07:00:00Z'));
  });
  it('parses "YYYY-MM-DD HH:MM:SS" (Excel space-separated)', () => {
    expect(parseTimestamp('2026-04-23 07:00:00')).toBe(Date.parse('2026-04-23T07:00:00'));
  });
  it('parses 13-digit epoch millis', () => {
    expect(parseTimestamp('1745409600000')).toBe(1745409600000);
  });
  it('parses 10-digit epoch seconds', () => {
    expect(parseTimestamp('1745409600')).toBe(1745409600000);
  });
  it('returns null on garbage', () => {
    expect(parseTimestamp('not a date')).toBeNull();
  });
  it('returns null on empty / nullish', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

// ── parseDateOnly ─────────────────────────────────────────────

describe('parseDateOnly', () => {
  it('passes through YYYY-MM-DD', () => {
    expect(parseDateOnly('2026-04-23')).toBe('2026-04-23');
  });
  it('extracts date from YYYY-MM-DDTHH:MM:SS', () => {
    expect(parseDateOnly('2026-04-23T07:00:00Z')).toBe('2026-04-23');
  });
  it('parses DD/MM/YYYY (LATAM convention)', () => {
    expect(parseDateOnly('23/04/2026')).toBe('2026-04-23');
  });
  it('pads single-digit DD/MM', () => {
    expect(parseDateOnly('3/4/2026')).toBe('2026-04-03');
  });
  it('returns null on garbage', () => {
    expect(parseDateOnly('blah')).toBeNull();
  });
  it('returns null on empty', () => {
    expect(parseDateOnly('')).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
  });
});
