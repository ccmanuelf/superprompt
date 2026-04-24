/**
 * Attendance CSV caption parsing (rc.92).
 *
 * The Telegram document handler dispatches attachments to the attendance
 * ingestion pipeline based on the caption. Captions come in two shapes:
 *
 *   Roster Data <moduleId>
 *   Check-in Data <moduleId> <YYYY-MM-DD>
 *
 * Keeping this in its own module makes it unit-testable without pulling
 * in the grammy Context mock surface.
 */

export type ParsedAttendanceCaption =
  | { kind: 'roster'; moduleId: string }
  | { kind: 'badge'; moduleId: string; date: string }
  | { kind: 'help' };   // shape was attendance-ish but didn't parse

const DISPATCH_RE = /^(roster|check[-\s]?in)\s+data/i;
const ROSTER_RE = /^roster\s+data\s+(\S+)\s*$/i;
const BADGE_RE = /^check[-\s]?in\s+data\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;

/** True if the caption should be routed to the attendance handler at all. */
export function isAttendanceCaption(caption: string): boolean {
  return DISPATCH_RE.test(caption.trim());
}

/**
 * Parse a caption into its ingestion parameters. Returns `{ kind: 'help' }`
 * when the caption matches the dispatch prefix but not a valid shape, so
 * the caller can reply with the format hint instead of silently failing.
 */
export function parseAttendanceCaption(rawCaption: string): ParsedAttendanceCaption | null {
  const caption = rawCaption.trim();
  if (!DISPATCH_RE.test(caption)) return null;
  const roster = caption.match(ROSTER_RE);
  if (roster) return { kind: 'roster', moduleId: roster[1] };
  const badge = caption.match(BADGE_RE);
  if (badge) return { kind: 'badge', moduleId: badge[1], date: badge[2] };
  return { kind: 'help' };
}
