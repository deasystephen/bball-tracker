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

/** Short game date, e.g. "Sat, Oct 3" (GameCard). */
export function formatShortDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** Long game date, e.g. "Saturday, October 3, 2026" (game detail, game stats, Create Game). */
export function formatLongDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
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

/** Abbreviated month alone, e.g. "Oct" (the Games tab date badge). */
export function formatMonthShort(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale(), { month: 'short' });
}

/** Numeric date, e.g. "10/3/2026" or "03/10/2026" (list rows, season ranges). */
export function formatNumericDate(value: Date | string): string {
  return toDate(value).toLocaleDateString(deviceLocale());
}

/** Numeric date and time, e.g. "10/3/2026, 7:30:45 PM" (About screen). */
export function formatDateTime(value: Date | string): string {
  return toDate(value).toLocaleString(deviceLocale());
}

/** Clock time, e.g. "7:30 PM" or "19:30"; `seconds` adds the seconds (EventTimeline). */
export function formatClockTime(value: Date | string, options: { seconds?: boolean } = {}): string {
  return toDate(value).toLocaleTimeString(deviceLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  });
}
