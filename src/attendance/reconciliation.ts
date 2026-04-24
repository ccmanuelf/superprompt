/**
 * Attendance reconciliation engine (Phase B, rc.94).
 *
 * A pure function. Takes the day's inputs — roster, badge records,
 * filed future absences, absence codes, the shift definition, the site
 * timezone, and the classification policy — and returns one classified
 * row per roster entry. No I/O, no clock, no scheduler: everything the
 * engine needs is explicit in the parameters, which is the only way to
 * keep a business rule engine testable over time.
 *
 * What the engine deliberately does NOT do:
 *   - It does not decide when to run (that's the morning digest, later).
 *   - It does not format supervisor-facing messages (later slice).
 *   - It does not encode any one customer's tolerance for "late" — the
 *     policy is injected, defaults are conservative, and the caller is
 *     expected to override when real HR numbers land.
 *
 * The policy surface is deliberately small. If you find yourself needing
 * a seventh policy knob to make a customer happy, stop and ask whether
 * the engine is trying to encode a business process instead of just
 * classifying time events.
 */

import type {
  BadgeRecord,
  DateOnly,
  RosterEntry,
  Shift,
  Timestamp,
  AbsenceCode,
} from './types.js';
import type { FutureAbsence } from './future-absences.js';
import { hitsDate } from './future-absences.js';

// ── Classification surface ───────────────────────────────────────

/**
 * Every roster entry resolves to exactly one of these kinds on a given
 * date. Most are obvious; a few subtle points:
 *   - `approved_absence` always wins over missing badge data, so an
 *     employee with a filed vacation never shows up as a no-show.
 *   - `missing_punch_in` and `missing_punch_out` are distinct from
 *     `no_show` because they almost always indicate sensor trouble or
 *     a forgotten badge, not an actual absence — a supervisor needs to
 *     reconcile them, not discipline the employee.
 *   - `present` means within tolerance on BOTH ends of the shift. Late
 *     or early-leave is its own kind even when the other end was fine.
 */
export type ExceptionKind =
  | 'present'
  | 'late'
  | 'early_leave'
  | 'no_show'
  | 'approved_absence'
  | 'missing_punch_in'
  | 'missing_punch_out';

export interface ExceptionRow {
  badgeId: string;
  fullName: string;
  moduleId: string;
  kind: ExceptionKind;
  /** Absence code when kind === 'approved_absence'; null otherwise. */
  absenceCode: string | null;
  /** Minutes after shift start the employee clocked in. Null unless relevant. */
  minutesLate: number | null;
  /** Minutes before shift end the employee clocked out. Null unless relevant. */
  minutesEarly: number | null;
  timestampIn: Timestamp | null;
  timestampOut: Timestamp | null;
  /** Notes carried over from the FutureAbsence row, when applicable. */
  notes: string | null;
}

// ── Policy ───────────────────────────────────────────────────────

/**
 * Policy knobs. All are minutes. Defaults are conservative: we'd rather
 * produce slightly too few exceptions than nag supervisors about a
 * 3-minute-late clock-in that nobody cares about.
 *
 * When HR hands us their actual rules, these become the seed of a
 * site-level config row. Do not inline them in the reconciler call —
 * always pass the object so tests and production stay honest.
 */
export interface ReconciliationPolicy {
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
}

export function defaultPolicy(): ReconciliationPolicy {
  return {
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
  };
}

// ── Inputs ───────────────────────────────────────────────────────

export interface ReconcileParams {
  date: DateOnly;
  shift: Shift;
  /** IANA timezone of the site (e.g. 'America/Mexico_City'). */
  timezone: string;
  roster: RosterEntry[];
  badges: BadgeRecord[];
  futureAbsences: FutureAbsence[];
  absenceCodes: AbsenceCode[];
  policy: ReconciliationPolicy;
}

// ── Timezone helper (no new dependency) ──────────────────────────

/**
 * Convert a "YYYY-MM-DD HH:MM" wall-clock time in `timezone` into an
 * absolute UTC epoch-ms. DST-correct because Intl.DateTimeFormat
 * reflects the target zone's current rules.
 *
 * Kept private — the engine is the only consumer today. If another
 * module needs this, promote it to a shared util with tests of its own.
 */
function localTimeToEpochMs(date: DateOnly, hhmm: string, timezone: string): Timestamp {
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // First guess: pretend the wall time is UTC.
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  // Ask the timezone what *local* time that UTC instant represents.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const shownLocalMin =
    (get('year') - y) * 525_600 +
    // using Intl 'month' with '2-digit' returns the numeric month
    (get('month') - mo) * 43_200 +
    (get('day') - d) * 1_440 +
    get('hour') * 60 + get('minute');
  const wantLocalMin = hh * 60 + mm;
  const offsetMin = shownLocalMin - wantLocalMin;
  return guess - offsetMin * 60_000;
}

// ── Core reconciliation ──────────────────────────────────────────

/**
 * Build the classified exception table. One row per roster entry, in
 * the same order as `roster`. The caller decides which kinds to surface
 * to supervisors (see `filterExceptions`).
 */
export function reconcile(p: ReconcileParams): ExceptionRow[] {
  const { date, shift, timezone, roster, badges, futureAbsences, policy } = p;

  // Build quick-lookup indexes so the main loop is O(roster).
  const badgeByBadgeId = new Map<string, BadgeRecord>();
  for (const b of badges) {
    if (b.date !== date) continue;
    // If ingestion ever emits multiple records per (badge, date), we keep
    // the earliest IN and latest OUT — conservative merge.
    const prior = badgeByBadgeId.get(b.badgeId);
    if (!prior) {
      badgeByBadgeId.set(b.badgeId, { ...b });
      continue;
    }
    const merged: BadgeRecord = {
      ...prior,
      timestampIn: pickEarliest(prior.timestampIn, b.timestampIn),
      timestampOut: pickLatest(prior.timestampOut, b.timestampOut),
    };
    badgeByBadgeId.set(b.badgeId, merged);
  }

  const activeAbsenceByBadgeId = new Map<string, FutureAbsence>();
  for (const fa of futureAbsences) {
    if (!hitsDate(fa, date)) continue;
    // Keep the most recently filed one if duplicates exist.
    const prior = activeAbsenceByBadgeId.get(fa.badgeId);
    if (!prior || fa.createdAt > prior.createdAt) {
      activeAbsenceByBadgeId.set(fa.badgeId, fa);
    }
  }

  // Shift boundaries as absolute UTC timestamps.
  const shiftStartTs = localTimeToEpochMs(date, shift.clockStart, timezone);
  const shiftEndTs = localTimeToEpochMs(date, shift.clockEnd, timezone);

  return roster.map<ExceptionRow>((r) => {
    const fa = activeAbsenceByBadgeId.get(r.badgeId);
    const badge = badgeByBadgeId.get(r.badgeId);

    // Approved absence always wins over missing badge data — if the
    // supervisor filed it, don't surface it as an exception.
    if (fa) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'approved_absence',
        absenceCode: fa.absenceCode,
        minutesLate: null,
        minutesEarly: null,
        timestampIn: badge?.timestampIn ?? null,
        timestampOut: badge?.timestampOut ?? null,
        notes: fa.notes,
      };
    }

    if (!badge || (badge.timestampIn == null && badge.timestampOut == null)) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'no_show',
        absenceCode: null,
        minutesLate: null,
        minutesEarly: null,
        timestampIn: null,
        timestampOut: null,
        notes: null,
      };
    }

    if (badge.timestampIn == null) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'missing_punch_in',
        absenceCode: null,
        minutesLate: null,
        minutesEarly: null,
        timestampIn: null,
        timestampOut: badge.timestampOut,
        notes: null,
      };
    }

    if (badge.timestampOut == null) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'missing_punch_out',
        absenceCode: null,
        minutesLate: null,
        minutesEarly: null,
        timestampIn: badge.timestampIn,
        timestampOut: null,
        notes: null,
      };
    }

    // Both punches present — compute lateness / early-leave.
    const minsLate = Math.max(0, Math.round((badge.timestampIn - shiftStartTs) / 60_000));
    const minsEarly = Math.max(0, Math.round((shiftEndTs - badge.timestampOut) / 60_000));

    if (minsLate > policy.lateGraceMinutes) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'late',
        absenceCode: null,
        minutesLate: minsLate,
        minutesEarly: minsEarly > policy.earlyLeaveGraceMinutes ? minsEarly : null,
        timestampIn: badge.timestampIn,
        timestampOut: badge.timestampOut,
        notes: null,
      };
    }

    if (minsEarly > policy.earlyLeaveGraceMinutes) {
      return {
        badgeId: r.badgeId,
        fullName: r.fullName,
        moduleId: r.moduleId,
        kind: 'early_leave',
        absenceCode: null,
        minutesLate: null,
        minutesEarly: minsEarly,
        timestampIn: badge.timestampIn,
        timestampOut: badge.timestampOut,
        notes: null,
      };
    }

    return {
      badgeId: r.badgeId,
      fullName: r.fullName,
      moduleId: r.moduleId,
      kind: 'present',
      absenceCode: null,
      minutesLate: null,
      minutesEarly: null,
      timestampIn: badge.timestampIn,
      timestampOut: badge.timestampOut,
      notes: null,
    };
  });
}

// ── Convenience filters / projections ────────────────────────────

/**
 * What the supervisor actually wants in their morning digest: anything
 * that isn't clean `present`. Approved absences are surfaced too — they
 * are not problems, but they ARE information the supervisor needs to
 * see ("yes, I filed Juan's vacation, got it").
 */
export function filterExceptions(rows: ExceptionRow[]): ExceptionRow[] {
  return rows.filter((r) => r.kind !== 'present');
}

export interface ExceptionTally {
  total: number;
  present: number;
  late: number;
  earlyLeave: number;
  noShow: number;
  approvedAbsence: number;
  missingPunchIn: number;
  missingPunchOut: number;
}

export function tally(rows: ExceptionRow[]): ExceptionTally {
  const t: ExceptionTally = {
    total: rows.length,
    present: 0, late: 0, earlyLeave: 0, noShow: 0,
    approvedAbsence: 0, missingPunchIn: 0, missingPunchOut: 0,
  };
  for (const r of rows) {
    switch (r.kind) {
      case 'present': t.present++; break;
      case 'late': t.late++; break;
      case 'early_leave': t.earlyLeave++; break;
      case 'no_show': t.noShow++; break;
      case 'approved_absence': t.approvedAbsence++; break;
      case 'missing_punch_in': t.missingPunchIn++; break;
      case 'missing_punch_out': t.missingPunchOut++; break;
    }
  }
  return t;
}

/**
 * Narrow helper: is this absence code treated as "present for billing"?
 * Not used by `reconcile` directly (approved_absence wins regardless),
 * but a digest formatter will want it when computing headcount.
 */
export function codeCountsAsPresent(code: string, codes: AbsenceCode[]): boolean {
  return codes.find((c) => c.code === code)?.countsAsPresent ?? false;
}

// ── Small internal utilities ─────────────────────────────────────

function pickEarliest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
}

function pickLatest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}
