/**
 * Attendance reconciliation engine (rc.94).
 *
 * The engine is a pure function, so every test here is a triple: input
 * fixtures → call `reconcile` → assert classification. Fixtures are
 * crafted per-case so a failure tells you exactly which rule is wrong,
 * not just "something changed".
 *
 * If you find yourself adding a test that needs actual HR policy
 * numbers (grace-period tuning, output formatting, digest timing),
 * stop — that belongs to a later slice. This suite pins the algorithm,
 * not the business rules.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcile,
  filterExceptions,
  tally,
  defaultPolicy,
  codeCountsAsPresent,
} from '../src/attendance/reconciliation.js';
import type { ReconcileParams } from '../src/attendance/reconciliation.js';
import type {
  BadgeRecord,
  RosterEntry,
  Shift,
  AbsenceCode,
} from '../src/attendance/types.js';
import type { FutureAbsence } from '../src/attendance/future-absences.js';

// ── Fixture helpers ──────────────────────────────────────────────
const TZ = 'America/Mexico_City'; // UTC-6, no DST since 2022 → stable tests

function roster(badges: Array<{ id: string; name: string }>): RosterEntry[] {
  return badges.map((b) => ({
    badgeId: b.id,
    fullName: b.name,
    costCenter: 'FP-ONT',
    laborType: 'direct',
    line: 'ASSY LINE 01',
    moduleId: 'mod-1',
    supervisorName: 'Sanchez',
    rawRow: {},
  }));
}

function badge(
  id: string,
  date: string,
  inHHMM: string | null,
  outHHMM: string | null,
): BadgeRecord {
  const toMs = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    const [y, mo, d] = date.split('-').map(Number);
    // Mexico City is UTC-6, so local 07:00 = UTC 13:00.
    return Date.UTC(y, mo - 1, d, h + 6, m, 0);
  };
  return {
    badgeId: id,
    date,
    timestampIn: inHHMM ? toMs(inHHMM) : null,
    timestampOut: outHHMM ? toMs(outHHMM) : null,
    rawRow: {},
  };
}

function absence(
  badgeId: string,
  start: string,
  end: string,
  code: string,
  notes: string | null = null,
): FutureAbsence {
  return {
    id: `fa-${badgeId}-${start}`,
    moduleId: 'mod-1',
    badgeId,
    dateStart: start,
    dateEnd: end,
    absenceCode: code,
    filedByChatId: 'chat-admin',
    notes,
    createdAt: Date.now(),
    cancelledAt: null,
  };
}

const SHIFT: Shift = {
  id: 'sh-1',
  siteId: 'site-1',
  name: 'First',
  clockStart: '07:00',
  clockEnd: '17:00',
  billingHoursMonThu: 9.5,
  billingHoursFri: 10,
  createdAt: 0,
  updatedAt: 0,
};

const ABSENCE_CODES: AbsenceCode[] = [
  { code: 'V', descriptionEn: 'Vacation', descriptionEs: 'Vacaciones', countsAsPresent: false, billingHoursFactor: 0 },
  { code: 'P', descriptionEn: 'Paid permit', descriptionEs: 'Permiso con goce', countsAsPresent: true, billingHoursFactor: 1 },
  { code: 'PT', descriptionEn: 'Paid training', descriptionEs: 'Capacitacion pagada', countsAsPresent: true, billingHoursFactor: 1 },
];

function base(date: string): Omit<ReconcileParams, 'roster' | 'badges' | 'futureAbsences'> {
  return {
    date,
    shift: SHIFT,
    timezone: TZ,
    absenceCodes: ABSENCE_CODES,
    policy: defaultPolicy(),
  };
}

// ── Classification tests ─────────────────────────────────────────

describe('reconcile: baseline classification', () => {
  it('classifies a clean on-time shift as present', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:00', '17:00')],
      futureAbsences: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('present');
    expect(rows[0].minutesLate).toBeNull();
    expect(rows[0].minutesEarly).toBeNull();
  });

  it('accepts clock-in within grace without flagging late', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:04', '17:00')], // 4 min late, grace=5
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('present');
  });

  it('flags late past the grace window', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:15', '17:00')],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('late');
    expect(rows[0].minutesLate).toBe(15);
  });

  it('flags early leave past the early-grace window', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:00', '16:40')],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('early_leave');
    expect(rows[0].minutesEarly).toBe(20);
  });

  it('prefers late over early-leave when both hold', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:15', '16:30')],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('late');
    expect(rows[0].minutesLate).toBe(15);
    // When the row is late, minutesEarly is surfaced alongside when it
    // ALSO exceeds grace — supervisors want to see both.
    expect(rows[0].minutesEarly).toBe(30);
  });

  it('classifies missing roster check-in (no badge record) as no_show', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('no_show');
  });

  it('classifies only-OUT punch as missing_punch_in (sensor trouble, not absence)', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', null, '17:00')],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('missing_punch_in');
    expect(rows[0].timestampOut).not.toBeNull();
  });

  it('classifies only-IN punch as missing_punch_out (forgot to clock out)', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:00', null)],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('missing_punch_out');
  });
});

describe('reconcile: approved absences', () => {
  it('approved absence wins over missing badges', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [],
      futureAbsences: [absence('001', '2026-04-20', '2026-04-22', 'V', 'family trip')],
    });
    expect(rows[0].kind).toBe('approved_absence');
    expect(rows[0].absenceCode).toBe('V');
    expect(rows[0].notes).toBe('family trip');
  });

  it('approved absence wins even if employee also punched in', () => {
    // Edge case — someone came to work on their filed vacation day.
    // Treat as absence for reconciliation; supervisor can override later.
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:00', '17:00')],
      futureAbsences: [absence('001', '2026-04-20', '2026-04-20', 'V')],
    });
    expect(rows[0].kind).toBe('approved_absence');
    // We still carry the badge data through so HR can see the conflict.
    expect(rows[0].timestampIn).not.toBeNull();
  });

  it('ignores absences whose range does not cover the date', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [],
      futureAbsences: [absence('001', '2026-04-21', '2026-04-22', 'V')],
    });
    expect(rows[0].kind).toBe('no_show');
  });

  it('ignores cancelled absences', () => {
    const fa = absence('001', '2026-04-20', '2026-04-20', 'V');
    fa.cancelledAt = Date.now() - 1000;
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [],
      futureAbsences: [fa],
    });
    expect(rows[0].kind).toBe('no_show');
  });

  it('when duplicate active absences exist, the most recently filed wins', () => {
    const older = absence('001', '2026-04-20', '2026-04-20', 'V');
    older.createdAt = 1_000_000;
    const newer = absence('001', '2026-04-20', '2026-04-20', 'P');
    newer.createdAt = 2_000_000;
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [],
      futureAbsences: [older, newer],
    });
    expect(rows[0].absenceCode).toBe('P');
  });
});

describe('reconcile: policy injection', () => {
  it('a generous policy silences a marginal late (15 min)', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:15', '17:00')],
      futureAbsences: [],
      policy: { lateGraceMinutes: 30, earlyLeaveGraceMinutes: 5 },
    });
    expect(rows[0].kind).toBe('present');
  });

  it('a strict policy (0 minutes) flags any minute of tardiness', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-20', '07:01', '17:00')],
      futureAbsences: [],
      policy: { lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
    });
    expect(rows[0].kind).toBe('late');
    expect(rows[0].minutesLate).toBe(1);
  });

  it('defaults are exported so callers have a documented starting point', () => {
    expect(defaultPolicy()).toEqual({ lateGraceMinutes: 5, earlyLeaveGraceMinutes: 5 });
  });
});

describe('reconcile: multi-employee roster', () => {
  it('classifies each roster entry independently and preserves order', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([
        { id: '001', name: 'Alice' },
        { id: '002', name: 'Bob' },
        { id: '003', name: 'Charlie' },
        { id: '004', name: 'Diana' },
      ]),
      badges: [
        badge('001', '2026-04-20', '07:00', '17:00'),  // present
        badge('002', '2026-04-20', '07:20', '17:00'),  // late
        // 003 missing — will become no_show or approved_absence
        badge('004', '2026-04-20', '07:00', null),      // missing_punch_out
      ],
      futureAbsences: [absence('003', '2026-04-20', '2026-04-20', 'V')],
    });
    expect(rows.map((r) => r.kind)).toEqual([
      'present', 'late', 'approved_absence', 'missing_punch_out',
    ]);
    // Order preserved from roster (not from badges).
    expect(rows.map((r) => r.badgeId)).toEqual(['001', '002', '003', '004']);
  });

  it('deduplicates duplicate badge records conservatively (earliest IN, latest OUT)', () => {
    // If ingestion ever double-inserts (shouldn't, but defend anyway),
    // we should not flip a late employee into present or vice versa.
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [
        badge('001', '2026-04-20', '07:20', '16:50'), // would be late+early
        badge('001', '2026-04-20', '07:02', '17:05'), // would be present
      ],
      futureAbsences: [],
    });
    // Earliest IN = 07:02 (within grace), latest OUT = 17:05 (after shift end → not early).
    expect(rows[0].kind).toBe('present');
  });
});

describe('filterExceptions + tally + codeCountsAsPresent', () => {
  it('filterExceptions drops clean present rows and keeps everything else', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([
        { id: '001', name: 'Alice' },
        { id: '002', name: 'Bob' },
        { id: '003', name: 'Charlie' },
      ]),
      badges: [
        badge('001', '2026-04-20', '07:00', '17:00'),  // present
        badge('002', '2026-04-20', '07:20', '17:00'),  // late
      ],
      futureAbsences: [absence('003', '2026-04-20', '2026-04-20', 'V')],
    });
    const exceptions = filterExceptions(rows);
    expect(exceptions.map((r) => r.kind)).toEqual(['late', 'approved_absence']);
  });

  it('tally counts every kind independently and sums to total', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([
        { id: '001', name: 'Alice' },
        { id: '002', name: 'Bob' },
        { id: '003', name: 'Charlie' },
        { id: '004', name: 'Diana' },
      ]),
      badges: [
        badge('001', '2026-04-20', '07:00', '17:00'),
        badge('002', '2026-04-20', '07:20', '17:00'),
        badge('004', '2026-04-20', null, '17:00'),
      ],
      futureAbsences: [absence('003', '2026-04-20', '2026-04-20', 'V')],
    });
    const t = tally(rows);
    expect(t.total).toBe(4);
    expect(t.present).toBe(1);
    expect(t.late).toBe(1);
    expect(t.approvedAbsence).toBe(1);
    expect(t.missingPunchIn).toBe(1);
    expect(t.noShow).toBe(0);
    expect(
      t.present + t.late + t.earlyLeave + t.noShow +
      t.approvedAbsence + t.missingPunchIn + t.missingPunchOut,
    ).toBe(t.total);
  });

  it('codeCountsAsPresent maps absence codes using the provided table', () => {
    expect(codeCountsAsPresent('V', ABSENCE_CODES)).toBe(false);
    expect(codeCountsAsPresent('P', ABSENCE_CODES)).toBe(true);
    expect(codeCountsAsPresent('XX', ABSENCE_CODES)).toBe(false); // unknown → not present
  });
});

describe('reconcile: timezone handling', () => {
  it('07:00 Mexico City on 2026-04-20 resolves to 13:00 UTC (no DST)', () => {
    // Indirect check: a badge record at UTC 13:05:00 on the date is 5 min
    // into the shift and still within the 5-min grace → present.
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [{
        badgeId: '001',
        date: '2026-04-20',
        timestampIn: Date.UTC(2026, 3, 20, 13, 5, 0), // 07:05 local
        timestampOut: Date.UTC(2026, 3, 20, 23, 0, 0), // 17:00 local
        rawRow: {},
      }],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('present');
  });

  it('honors a different timezone for a different site', () => {
    // Buenos Aires is UTC-3. 07:00 local = 10:00 UTC.
    const rows = reconcile({
      ...base('2026-04-20'),
      timezone: 'America/Argentina/Buenos_Aires',
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [{
        badgeId: '001',
        date: '2026-04-20',
        timestampIn: Date.UTC(2026, 3, 20, 10, 20, 0), // 07:20 local → late
        timestampOut: Date.UTC(2026, 3, 20, 20, 0, 0),  // 17:00 local → on time
        rawRow: {},
      }],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('late');
    expect(rows[0].minutesLate).toBe(20);
  });
});

describe('reconcile: edge cases', () => {
  it('empty roster yields empty output without throwing', () => {
    expect(reconcile({
      ...base('2026-04-20'),
      roster: [],
      badges: [],
      futureAbsences: [],
    })).toEqual([]);
  });

  it('badges for other dates are ignored', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('001', '2026-04-19', '07:00', '17:00')], // yesterday
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('no_show');
  });

  it('badges for other badgeIds are ignored', () => {
    const rows = reconcile({
      ...base('2026-04-20'),
      roster: roster([{ id: '001', name: 'Alice' }]),
      badges: [badge('999', '2026-04-20', '07:00', '17:00')],
      futureAbsences: [],
    });
    expect(rows[0].kind).toBe('no_show');
  });
});
