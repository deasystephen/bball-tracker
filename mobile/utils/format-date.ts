/**
 * The one place mobile turns a date or time into a string (#769). Every
 * `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString` and
 * `Intl.DateTimeFormat` call lives here; a source-scanning guard
 * (`__tests__/utils/date-locale-guard.test.ts`) fails CI on one anywhere else.
 *
 * The locale is the device's full BCP 47 tag (`en-GB`, `es-ES`) from
 * expo-localization, the same `getLocales()` that `i18n/config.ts` reads for
 * the app language. A bare language code such as i18next's `en` is not
 * enough: it would give an `en-GB` device a 12-hour clock. It is read on every
 * call, never cached, so an Android language change that keeps the JS
 * runtime alive takes effect at once. When the device reports no tag the
 * locale is `undefined` and the runtime default applies.
 */
import { getLocales } from 'expo-localization';

/** The device's preferred locale tag, or `undefined` for the runtime default. */
export function deviceLocale(): string | undefined {
  const tag = getLocales()[0]?.languageTag;
  return tag ? tag : undefined;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Uppercase the first character, in the given locale. For the weekday-led
 * formats below, which always stand at the start of their label: Spanish
 * writes weekdays and months lowercase in running text ("el sábado"), but a
 * label that starts with one capitalizes it ("Sábado, 3 de octubre"). English
 * output is unchanged.
 */
function capitalizeFirst(text: string, locale: string | undefined): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/**
 * A display zone for the formatters below. Practices (#33) are shown in the
 * IANA zone they were scheduled in, so "18:00" stays the coach's 18:00 for a
 * viewer elsewhere; every other caller omits it and gets the device zone.
 */
export interface ZoneOption {
  timeZone?: string;
}

/**
 * Runs a formatter in `timeZone`, or in the device zone when the runtime
 * refuses that name (a RangeError for a zone its data does not know): a date
 * one zone off is better than a screen that throws.
 */
function inZone<T extends Intl.DateTimeFormatOptions>(
  format: (options: T) => string,
  options: T,
  timeZone: string | undefined,
): string {
  if (!timeZone) return format(options);
  try {
    return format({ ...options, timeZone });
  } catch {
    return format(options);
  }
}

/**
 * The device's IANA zone (`America/New_York`), what a new practice series is
 * scheduled in; `undefined` when the runtime reports none.
 */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `timeZone` shows a different wall time from the device at that
 * instant, so a time shown in it needs its zone named (`formatZoneName`).
 * Compared by the time each zone shows, never by name: the server stores its
 * runtime's canonical name, which can be another alias of the device's zone.
 * A zone the runtime does not know counts as the same.
 */
export function isOtherTimeZone(timeZone: string, at: Date | string = new Date()): boolean {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  };
  try {
    const instant = toDate(at);
    return instant.toLocaleString('en-US', { ...options, timeZone }) !== instant.toLocaleString('en-US', options);
  } catch {
    return false;
  }
}

/**
 * The zone's short name at that instant, e.g. "EST" or "GMT-5", read from the
 * formatter's `timeZoneName` part (locales put it before or after the time).
 * A runtime whose `formatToParts` has no such part (Hermes' is not
 * guaranteed to split it out) falls back to the time with the zone minus the
 * same time without it. `''` when neither yields a name.
 */
export function formatZoneName(value: Date | string, timeZone: string): string {
  const locale = deviceLocale();
  const instant = toDate(value);
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(instant);
    const part = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (part) return part;
  } catch {
    // fall through to the string difference
  }
  try {
    const base: Intl.DateTimeFormatOptions = { timeZone, hour: 'numeric', minute: '2-digit' };
    const withZone = instant.toLocaleTimeString(locale, { ...base, timeZoneName: 'short' });
    const without = instant.toLocaleTimeString(locale, base);
    return withZone.includes(without) ? withZone.replace(without, '').trim() : '';
  } catch {
    return '';
  }
}

/** A wall-clock reading: local date "YYYY-MM-DD" and local time "HH:MM". */
export interface WallClock {
  date: string;
  time: string;
}

/**
 * What the wall clock in `timeZone` reads at `value` ("2030-03-12", "18:00"),
 * the starting point of the practice edit form (#1051). This only reads a
 * clock: one instant has exactly one reading in every zone. The reverse (a
 * reading to an instant, which a daylight-saving gap or repeated hour makes
 * ambiguous) is the server's job, never the app's. `null` for a zone the
 * runtime does not know: reading the device clock instead would show (and
 * send back) another zone's time as the practice's.
 */
export function wallClockIn(value: Date | string, timeZone: string): WallClock | null {
  const instant = toDate(value);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch {
    return null;
  }
  // A runtime that ignored the 24-hour clock, or did not split the fields
  // out, gives no reading rather than a wrong one.
  if (parts.some((p) => p.type === 'dayPeriod')) return null;
  const field = (type: Intl.DateTimeFormatPartTypes): number | null => {
    const raw = parts.find((p) => p.type === type)?.value;
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const [year, month, day, rawHour, minute] = (['year', 'month', 'day', 'hour', 'minute'] as const).map(field);
  if (year === null || month === null || day === null || rawHour === null || minute === null) return null;
  // Some engines write midnight as 24 with a 24-hour clock.
  const hour = rawHour === 24 ? 0 : rawHour;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return { date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, time: `${pad(hour)}:${pad(minute)}` };
}

/**
 * A local calendar date "YYYY-MM-DD" (no zone) as a long date, e.g. "Tuesday,
 * March 12, 2030" (the practice edit form, #1051). Formatted as that day at
 * UTC noon in UTC, so no device zone can move it to another day.
 */
export function formatLongLocalDate(key: string): string {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  return formatLongDate(new Date(Date.UTC(year, month - 1, day, 12)), { timeZone: 'UTC' });
}

/**
 * A zone's name that holds all year, e.g. "Eastern Time" / "hora del este"
 * (`longGeneric`), for a date and time that may fall on either side of a
 * daylight-saving change (the practice edit form, #1051). A runtime without
 * generic names, or one that only offers an offset ("GMT-5"), gets the IANA
 * name with spaces ("America/New York").
 */
export function formatTimeZoneLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat(deviceLocale(), {
      timeZone,
      timeZoneName: 'longGeneric',
    } as Intl.DateTimeFormatOptions).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^(GMT|UTC)[+\-−]/.test(name)) return name;
  } catch {
    // fall through to the IANA name
  }
  return timeZone.replace(/_/g, ' ');
}

/** Short game date, e.g. "Sat, Oct 3" / "Sáb, 3 oct" (GameCard). Starts its label, so capitalized. */
export function formatShortDate(value: Date | string, options: ZoneOption = {}): string {
  const locale = deviceLocale();
  return capitalizeFirst(
    inZone(
      (o) => toDate(value).toLocaleDateString(locale, o),
      { weekday: 'short', month: 'short', day: 'numeric' },
      options.timeZone,
    ),
    locale,
  );
}

/**
 * Long game date, e.g. "Saturday, October 3, 2026" / "Sábado, 3 de octubre de 2026" (game
 * detail, game stats, Create Game). Starts its label, so capitalized.
 */
export function formatLongDate(value: Date | string, options: ZoneOption = {}): string {
  const locale = deviceLocale();
  return capitalizeFirst(
    inZone(
      (o) => toDate(value).toLocaleDateString(locale, o),
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
      options.timeZone,
    ),
    locale,
  );
}

/** Calendar date without a weekday, e.g. "October 3, 2026" (invitation expiry). */
export function formatCalendarDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Season date, e.g. "March 6, 2027", or `notSet` when there is no date. */
export function formatSeasonDate(date: Date | null, notSet: string): string {
  return date ? formatCalendarDate(date) : notSet;
}

/** Month and day, e.g. "Oct 3" (home upcoming games, relative-time rows). */
export function formatMonthDay(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), { month: 'short', day: 'numeric' });
}

/**
 * A weekday's name from its number, 0 = Sunday … 6 = Saturday, e.g. "Tue" /
 * "mar" (`short`) or "Tuesday" (`long`): the practice series weekday chips and
 * their labels (#33). 2023-01-01 was a Sunday; UTC noon, so no zone moves it.
 */
export function formatWeekdayName(day: number, width: 'short' | 'long' = 'short'): string {
  return new Date(Date.UTC(2023, 0, 1 + day, 12)).toLocaleDateString(deviceLocale(), {
    weekday: width,
    timeZone: 'UTC',
  });
}

/**
 * A wall-clock "HH:MM" (a practice series' start time) in the device's clock
 * style, e.g. "6:00 PM" or "18:00". It is a local time with no date, so it is
 * formatted as that time in UTC.
 */
export function formatWallClock(hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map((part) => Number(part));
  return new Date(Date.UTC(2023, 0, 1, hours || 0, minutes || 0)).toLocaleTimeString(deviceLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * A month's full name from its number, 1–12, e.g. "October" / "octubre" (the
 * age screen's month pills and confirmation, #981). The year is a leap year
 * so every month has a first day; the day is fixed at the 1st, UTC noon, so
 * no time zone can shift it into the month before.
 */
export function formatMonthName(month: number): string {
  return new Date(Date.UTC(2000, month - 1, 1, 12)).toLocaleDateString(deviceLocale(), {
    month: 'long',
    timeZone: 'UTC',
  });
}

/** Abbreviated month alone, e.g. "Oct" (the Games tab date badge). */
export function formatMonthShort(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), { month: 'short' });
}

/** Numeric date, e.g. "10/3/2026" or "03/10/2026" (list rows, season ranges). */
export function formatNumericDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale());
}

/**
 * A season's date range, "3/1/2024 - 6/30/2024", with the caller's localized
 * placeholder for a missing end; `null` when the season has no dates at all.
 * Shared by the league screen's season rows and the season detail (#671).
 */
export function formatSeasonRange(
  season: { startDate?: string | null; endDate?: string | null },
  labels: { noStart: string; noEnd: string }
): string | null {
  if (!season.startDate && !season.endDate) return null;
  const start = season.startDate ? formatNumericDate(season.startDate) : labels.noStart;
  const end = season.endDate ? formatNumericDate(season.endDate) : labels.noEnd;
  return `${start} - ${end}`;
}

/** Numeric date and time, e.g. "10/3/2026, 7:30:45 PM" (About screen). */
export function formatDateTime(value: Date | string): string {
  return toDate(value).toLocaleString(deviceLocale());
}

/**
 * Clock time, e.g. "7:30 PM" or "19:30"; `seconds` adds the seconds
 * (EventTimeline); `timeZone` shows it in that zone (practices, #33).
 */
export function formatClockTime(
  value: Date | string,
  options: { seconds?: boolean } & ZoneOption = {},
): string {
  return inZone(
    (o) => toDate(value).toLocaleTimeString(deviceLocale(), o),
    {
      hour: 'numeric',
      minute: '2-digit',
      ...(options.seconds ? { second: '2-digit' } : {}),
    } as Intl.DateTimeFormatOptions,
    options.timeZone,
  );
}
