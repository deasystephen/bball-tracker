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

/** Short game date, e.g. "Sat, Oct 3" / "Sáb, 3 oct" (GameCard). Starts its label, so capitalized. */
export function formatShortDate(value: Date | string): string {
  const locale = deviceLocale();
  return capitalizeFirst(
    toDate(value).toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }),
    locale,
  );
}

/**
 * Long game date, e.g. "Saturday, October 3, 2026" / "Sábado, 3 de octubre de 2026" (game
 * detail, game stats, Create Game). Starts its label, so capitalized.
 */
export function formatLongDate(value: Date | string): string {
  const locale = deviceLocale();
  return capitalizeFirst(
    toDate(value).toLocaleDateString(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
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

/** Clock time, e.g. "7:30 PM" or "19:30"; `seconds` adds the seconds (EventTimeline). */
export function formatClockTime(value: Date | string, options: { seconds?: boolean } = {}): string {
  return toDate(value).toLocaleTimeString(deviceLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  });
}
