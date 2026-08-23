/**
 * Date formatting for outbound email.
 *
 * `Date#toLocaleDateString()` with no arguments formats in the *server's*
 * time zone (UTC on ECS), so a 7 pm Pacific tip-off rendered as the next
 * calendar day (audit #57). Every email date goes through these helpers with
 * an explicit IANA time zone. Neither Team nor League carries a time zone yet,
 * so callers pass none and `DEFAULT_TIMEZONE` (env, default
 * `America/Los_Angeles`) applies; thread a team/league zone through here when
 * one exists.
 */

const FALLBACK_TIMEZONE = 'America/Los_Angeles';

export function getDefaultTimeZone(): string {
  return process.env.DEFAULT_TIMEZONE || FALLBACK_TIMEZONE;
}

function resolveTimeZone(timeZone?: string | null): string {
  const tz = timeZone || getDefaultTimeZone();
  try {
    // Throws RangeError for an unknown zone — fall back rather than crash a send.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

/** e.g. "Mar 15, 2026, 7:00 PM PDT" — for game times. */
export function formatEmailDateTime(date: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: resolveTimeZone(timeZone),
  }).format(date);
}

/** e.g. "Mar 15, 2026" — for deadlines such as invitation expiry. */
export function formatEmailDate(date: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: resolveTimeZone(timeZone),
  }).format(date);
}
