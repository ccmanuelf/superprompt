/**
 * Supervisor-sensor fallback (rc.88).
 *
 * When neither CSV nor API can supply badge records — typical pilot-day-1
 * reality, since HR may send roster but the T&A export might not arrive
 * on time — this source lets the workflow proceed by treating the
 * supervisor themselves as the sensor. It returns the roster through
 * a real roster source (injected) but emits an EMPTY BadgeRecord[] for
 * badge queries; the reconciliation engine reads "empty badges" as a
 * signal to send the full roster to the supervisor and ask "¿quién
 * falta?".
 *
 * This is deliberately NOT a standalone roster source — it always
 * delegates to whatever the selector resolved for roster. Keeping the
 * roster source real means we don't silently hide a CSV load failure.
 */
import type {
  AttendanceDataSource,
  RosterEntry,
  BadgeRecord,
  DateOnly,
} from '../types.js';

export class SupervisorSensorSource implements AttendanceDataSource {
  public readonly kind = 'supervisor-sensor' as const;

  constructor(
    public readonly moduleId: string,
    private readonly rosterSource: AttendanceDataSource,
  ) {}

  async healthCheck(): Promise<{ available: boolean; reason?: string }> {
    // Available iff the underlying roster source is available — we can't
    // ask the supervisor "who's missing" without a roster to compare
    // against.
    const r = await this.rosterSource.healthCheck();
    if (!r.available) {
      return { available: false, reason: `roster source unavailable: ${r.reason ?? 'unknown'}` };
    }
    return { available: true };
  }

  async getRoster(date: DateOnly): Promise<RosterEntry[]> {
    return this.rosterSource.getRoster(date);
  }

  async getBadgeRecords(_date: DateOnly): Promise<BadgeRecord[]> {
    // Intentionally empty. Downstream (Phase B reconciliation) reads the
    // empty array from kind=supervisor-sensor as "ask the supervisor
    // who clocked in", rather than treating every employee as absent.
    return [];
  }
}
