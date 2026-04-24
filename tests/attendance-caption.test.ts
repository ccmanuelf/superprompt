/**
 * Attendance caption parsing (rc.92).
 *
 * The Telegram document handler dispatches attendance uploads based on
 * the caption text. This file exercises both the dispatch predicate
 * (`isAttendanceCaption`) and the parser (`parseAttendanceCaption`)
 * against every shape we want to support — and a handful we want to
 * reject — so regressions in the regex don't silently break uploads.
 */
import { describe, it, expect } from 'vitest';
import {
  isAttendanceCaption,
  parseAttendanceCaption,
} from '../src/attendance/caption.js';

describe('isAttendanceCaption', () => {
  it('accepts well-formed Roster Data captions', () => {
    expect(isAttendanceCaption('Roster Data mod-123')).toBe(true);
  });

  it('accepts well-formed Check-in Data captions', () => {
    expect(isAttendanceCaption('Check-in Data mod-123 2026-04-20')).toBe(true);
  });

  it('accepts case-insensitive prefixes', () => {
    expect(isAttendanceCaption('ROSTER DATA mod-1')).toBe(true);
    expect(isAttendanceCaption('roster data mod-1')).toBe(true);
    expect(isAttendanceCaption('checkin Data mod-1 2026-04-20')).toBe(true);
    expect(isAttendanceCaption('Check in Data mod-1 2026-04-20')).toBe(true);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(isAttendanceCaption('   Roster Data mod-1  ')).toBe(true);
  });

  it('rejects unrelated captions', () => {
    expect(isAttendanceCaption('')).toBe(false);
    expect(isAttendanceCaption('/skill upload')).toBe(false);
    expect(isAttendanceCaption('/balance foo')).toBe(false);
    expect(isAttendanceCaption('hello roster')).toBe(false);
  });
});

describe('parseAttendanceCaption', () => {
  it('returns null for non-attendance captions', () => {
    expect(parseAttendanceCaption('/skill upload')).toBeNull();
    expect(parseAttendanceCaption('')).toBeNull();
  });

  it('parses a roster caption', () => {
    expect(parseAttendanceCaption('Roster Data mod-abc')).toEqual({
      kind: 'roster',
      moduleId: 'mod-abc',
    });
  });

  it('parses a check-in caption with a date', () => {
    expect(parseAttendanceCaption('Check-in Data mod-abc 2026-04-20')).toEqual({
      kind: 'badge',
      moduleId: 'mod-abc',
      date: '2026-04-20',
    });
  });

  it('accepts "checkin" without a hyphen', () => {
    expect(parseAttendanceCaption('Checkin Data mod-1 2026-04-20')).toEqual({
      kind: 'badge',
      moduleId: 'mod-1',
      date: '2026-04-20',
    });
  });

  it('accepts "Check in" with a space instead of a hyphen', () => {
    expect(parseAttendanceCaption('Check in Data mod-1 2026-04-20')).toEqual({
      kind: 'badge',
      moduleId: 'mod-1',
      date: '2026-04-20',
    });
  });

  it('returns help when a roster caption is missing the moduleId', () => {
    expect(parseAttendanceCaption('Roster Data')).toEqual({ kind: 'help' });
  });

  it('returns help when a check-in caption is missing the date', () => {
    expect(parseAttendanceCaption('Check-in Data mod-1')).toEqual({ kind: 'help' });
  });

  it('returns help when the date is not YYYY-MM-DD', () => {
    expect(parseAttendanceCaption('Check-in Data mod-1 04/20/2026')).toEqual({ kind: 'help' });
    expect(parseAttendanceCaption('Check-in Data mod-1 2026-4-20')).toEqual({ kind: 'help' });
  });

  it('ignores trailing whitespace', () => {
    expect(parseAttendanceCaption('Roster Data mod-1   ')).toEqual({
      kind: 'roster', moduleId: 'mod-1',
    });
    expect(parseAttendanceCaption('Check-in Data mod-1 2026-04-20   ')).toEqual({
      kind: 'badge', moduleId: 'mod-1', date: '2026-04-20',
    });
  });
});
