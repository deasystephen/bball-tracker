/**
 * Wall-clock time in an IANA zone <-> UTC instants, without a date library
 * (#33, practice series).
 *
 * ECS runs in UTC, so "every Tuesday at 18:00" cannot be stored as one UTC
 * time: it is 23:00Z in New York winter and 22:00Z in summer. A series keeps
 * the local date, the local "HH:MM" and the zone, and `zonedTimeToUtc` turns
 * each occurrence into its own instant using the zone's offset on that day.
 *
 * Built on `Intl.DateTimeFormat`, whose zone data ships with Node's ICU.
 */

/** A local calendar date. `month` is 1-12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/**
 * One formatter per zone, keyed by the CANONICAL name only: every name that
 * reaches here went through `canonicalTimeZone` at the API boundary, so the
 * map holds at most one entry per real zone (a few hundred), never one per
 * spelling a client sends.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The resolved names refused: the fixed-offset `Etc/GMT±n` zones, which would
 * silently ignore daylight saving.
 */
const FIXED_OFFSET_RE = /^(?:[+-]\d|Etc\/GMT[+-])/;

/**
 * Accepted input: an "Area/Location" name (what every device reports) or
 * UTC/GMT, in any case. Bare names are refused: abbreviations are ambiguous
 * and several resolve to a zone without daylight saving ("est" is
 * America/Panama), so a New York coach sending one would drift an hour every
 * summer; offsets ("+05:30") have no DST at all.
 */
const ACCEPTED_INPUT_RE = /^(?:utc|gmt|[a-z_]+(?:\/[a-z0-9_+-]+)+)$/i;

/**
 * The runtime's name for `timeZone`, case-normalized ("america/new_york" gives
 * "America/New_York"; Node 22 also folds aliases such as "US/Eastern", newer
 * ECMA-402 runtimes may keep them), or null when it is unknown or a fixed
 * offset. Builds an
 * uncached formatter, so arbitrary client input never grows the cache.
 */
export function canonicalTimeZone(timeZone: string): string | null {
  if (!timeZone || !ACCEPTED_INPUT_RE.test(timeZone)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return FIXED_OFFSET_RE.test(resolved) ? null : resolved;
}


/** The local wall-clock fields of `instant` in `timeZone`, as a UTC epoch (ms). */
function wallClockMs(instant: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second')
  );
}

/** The zone's offset from UTC at `instant`, in ms (New York winter: -5h). */
function offsetMs(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockMs(whole, timeZone) - whole;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads `date` at
 * `hour:minute`.
 *
 * - A time that happens twice (the hour repeated when clocks go back) resolves
 *   to the EARLIER instant.
 * - A time that never happens (the hour skipped when clocks go forward)
 *   resolves to the instant the same number of minutes after the jump, so
 *   02:30 on a spring-forward night becomes 03:30 local.
 */
export function zonedTimeToUtc(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The offset just before and just after the wall-clock time cover both
  // sides of any transition that day.
  const offsets = [offsetMs(naive - 86_400_000, timeZone), offsetMs(naive + 86_400_000, timeZone)];
  const candidates = [...new Set(offsets.map((o) => naive - o))].sort((a, b) => a - b);

  const exact = candidates.filter((c) => wallClockMs(c, timeZone) === naive);
  if (exact.length > 0) {
    return new Date(exact[0]);
  }
  // The time falls in a gap: the later candidate is the time shifted forward
  // by the jump.
  return new Date(candidates[candidates.length - 1]);
}

/** Parses "YYYY-MM-DD" (already validated) into a LocalDate. */
export function parseLocalDate(value: string): LocalDate {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

/** Parses "HH:MM" (already validated) into hour and minute. */
export function parseLocalTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

/** "YYYY-MM-DD" for a LocalDate. */
export function formatLocalDate(date: LocalDate): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** `date` plus `days` calendar days (pure calendar arithmetic, no zone). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Day of the week of a calendar date, 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000
  );
}

/** The local calendar date of `instant` in `timeZone` (a canonical name). */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const d = new Date(wallClockMs(instant.getTime(), timeZone));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The local wall time of `instant` in `timeZone` (a canonical name), "HH:MM" (seconds dropped). */
export function localTimeOf(instant: Date, timeZone: string): string {
  const d = new Date(wallClockMs(instant.getTime(), timeZone));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
