import { describe, it, expect } from 'vitest';
import type { MappedRow } from '../src/attendance/parser.js';
import {
  validateRoster,
  validateBadgeRecords,
} from '../src/attendance/validation.js';

function row(n: number, fields: Record<string, string>, rawExtras: Record<string, string> = {}): MappedRow {
  return {
    rowNumber: n,
    fields,
    rawRow: { ...fields, ...rawExtras },
  };
}

// ── Roster validation ────────────────────────────────────────

describe('validateRoster', () => {
  it('accepts a clean roster', () => {
    const rows = [
      row(2, { badge_id: '001', full_name: 'Alice', cost_center: 'CC1', labor_type: 'direct', line: 'L1', supervisor_name: 'Doe' }),
      row(3, { badge_id: '002', full_name: 'Bob',   cost_center: 'CC2', labor_type: 'indirect', line: 'L2', supervisor_name: 'Doe' }),
    ];
    const r = validateRoster(rows, { moduleId: 'M1' });
    expect(r.accepted).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.accepted[0].laborType).toBe('direct');
    expect(r.accepted[1].laborType).toBe('indirect');
    expect(r.accepted[0].moduleId).toBe('M1');
  });

  it('accepts Spanish labor_type values', () => {
    const rows = [
      row(2, { badge_id: '001', full_name: 'Alice', cost_center: 'CC1', labor_type: 'Directa', line: 'L1' }),
      row(3, { badge_id: '002', full_name: 'Bob',   cost_center: 'CC2', labor_type: 'INDIRECTO', line: 'L2' }),
    ];
    const r = validateRoster(rows, { moduleId: 'M1' });
    expect(r.accepted).toHaveLength(2);
    expect(r.accepted[0].laborType).toBe('direct');
    expect(r.accepted[1].laborType).toBe('indirect');
  });

  it('skips rows missing required fields with joined reasons', () => {
    const rows = [
      row(2, { badge_id: '', full_name: 'Alice', labor_type: 'direct', line: 'L1' }),
      row(3, { badge_id: '002', full_name: '', labor_type: 'direct', line: '' }),
    ];
    const r = validateRoster(rows, { moduleId: 'M1' });
    expect(r.accepted).toEqual([]);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0].reason).toMatch(/badge_id/);
    expect(r.skipped[1].reason).toMatch(/full_name/);
    expect(r.skipped[1].reason).toMatch(/line/);
  });

  it('skips rows with unknown labor_type', () => {
    const rows = [
      row(2, { badge_id: '001', full_name: 'Alice', labor_type: 'contractor', line: 'L1' }),
    ];
    const r = validateRoster(rows, { moduleId: 'M1' });
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/unknown labor_type/);
  });

  it('warns on duplicate badge_ids but accepts later rows (last-writer-wins)', () => {
    const rows = [
      row(2, { badge_id: '001', full_name: 'Alice', labor_type: 'direct', line: 'L1' }),
      row(3, { badge_id: '001', full_name: 'Alice Duplicate', labor_type: 'direct', line: 'L1' }),
    ];
    const r = validateRoster(rows, { moduleId: 'M1' });
    expect(r.accepted).toHaveLength(2);
    expect(r.warnings.some((w) => w.kind === 'duplicate-badge-id')).toBe(true);
  });

  it('warns on big row-count drop vs prior ingestion', () => {
    const rows = [row(2, { badge_id: '001', full_name: 'Alice', labor_type: 'direct', line: 'L1' })];
    const r = validateRoster(rows, { moduleId: 'M1', priorRowCount: 20 });
    expect(r.warnings.some((w) => w.kind === 'row-count-drop')).toBe(true);
  });

  it('does not warn when drop is within threshold (normal turnover)', () => {
    const rows = Array.from({ length: 18 }, (_, i) =>
      row(i + 2, { badge_id: String(i), full_name: `E${i}`, labor_type: 'direct', line: 'L1' }),
    );
    const r = validateRoster(rows, { moduleId: 'M1', priorRowCount: 20 });
    expect(r.warnings.filter((w) => w.kind === 'row-count-drop')).toEqual([]);
  });
});

// ── Badge validation ─────────────────────────────────────────

describe('validateBadgeRecords', () => {
  it('accepts rows with explicit IN/OUT columns', () => {
    const rows = [
      row(2, {
        badge_id: '001',
        date: '2026-04-23',
        timestamp_in: '2026-04-23T07:00:00Z',
        timestamp_out: '2026-04-23T17:00:00Z',
      }),
    ];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].timestampIn).toBe(Date.parse('2026-04-23T07:00:00Z'));
    expect(r.accepted[0].timestampOut).toBe(Date.parse('2026-04-23T17:00:00Z'));
  });

  it('coalesces IN + OUT punches from shape B (punch_timestamp + punch_direction)', () => {
    const rows = [
      row(2, { badge_id: '001', date: '2026-04-23', punch_timestamp: '2026-04-23T07:00:00Z', punch_direction: 'IN' }),
      row(3, { badge_id: '001', date: '2026-04-23', punch_timestamp: '2026-04-23T17:00:00Z', punch_direction: 'OUT' }),
    ];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].timestampIn).toBeGreaterThan(0);
    expect(r.accepted[0].timestampOut).toBeGreaterThan(0);
  });

  it('accepts Spanish ENTRADA/SALIDA punch_direction values', () => {
    const rows = [
      row(2, { badge_id: '001', date: '2026-04-23', punch_timestamp: '2026-04-23T07:00:00Z', punch_direction: 'ENTRADA' }),
      row(3, { badge_id: '001', date: '2026-04-23', punch_timestamp: '2026-04-23T17:00:00Z', punch_direction: 'SALIDA' }),
    ];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.accepted).toHaveLength(1);
  });

  it('warns when a date in the file differs from expected shift date', () => {
    const rows = [
      row(2, {
        badge_id: '001',
        date: '2026-04-22',
        timestamp_in: '2026-04-22T07:00:00Z',
        timestamp_out: '2026-04-22T17:00:00Z',
      }),
    ];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.warnings.some((w) => w.kind === 'date-range-mismatch')).toBe(true);
    expect(r.accepted).toHaveLength(1); // still accepted — warning, not rejection
  });

  it('skips rows where neither timestamp_in nor timestamp_out parses', () => {
    const rows = [
      row(2, { badge_id: '001', date: '2026-04-23', timestamp_in: 'blah', timestamp_out: 'blah' }),
    ];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.accepted).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/unparseable/);
  });

  it('warns when a badge_id is not in the known roster set', () => {
    const rows = [
      row(2, {
        badge_id: 'UNKNOWN',
        date: '2026-04-23',
        timestamp_in: '2026-04-23T07:00:00Z',
        timestamp_out: '2026-04-23T17:00:00Z',
      }),
    ];
    const r = validateBadgeRecords(rows, {
      moduleId: 'M1',
      siteId: 'S1',
      expectedDate: '2026-04-23',
      knownBadgeIds: new Set(['001', '002']),
    });
    expect(r.warnings.some((w) => w.detail.includes('UNKNOWN'))).toBe(true);
  });

  it('skips rows with neither explicit timestamps nor punch_timestamp mapped', () => {
    const rows = [row(2, { badge_id: '001', date: '2026-04-23' })];
    const r = validateBadgeRecords(rows, { moduleId: 'M1', siteId: 'S1', expectedDate: '2026-04-23' });
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/neither timestamp/);
  });
});
