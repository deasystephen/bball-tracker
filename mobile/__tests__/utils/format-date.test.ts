/**
 * utils/format-date.ts (#769): every shape formats with the device's full
 * language tag from expo-localization, read on each call, and falls back to
 * `undefined` (the runtime default) when the device reports none.
 */
import type * as LocalizationModule from 'expo-localization';

import {
  deviceLocale,
  formatCalendarDate,
  formatClockTime,
  formatDateTime,
  formatLongDate,
  formatMonthDay,
  formatMonthShort,
  formatNumericDate,
  formatSeasonDate,
  formatShortDate,
} from '../../utils/format-date';

type Locales = ReturnType<typeof LocalizationModule.getLocales>;

// The module object the helper actually calls (jest.setup's mock); a
// namespace import would be an interop copy that a spy cannot reach.
const Localization = jest.requireMock<typeof LocalizationModule>('expo-localization');

/** Saturday 3 October 2026, 19:30:45 local time. */
const DATE = new Date(2026, 9, 3, 19, 30, 45);

let getLocalesSpy: jest.SpyInstance<Locales, []>;

function withLocales(locales: { languageTag?: string }[]): void {
  getLocalesSpy.mockReturnValue(locales as unknown as Locales);
}

function render(): Record<string, string> {
  return {
    short: formatShortDate(DATE),
    long: formatLongDate(DATE),
    calendar: formatCalendarDate(DATE),
    season: formatSeasonDate(DATE, 'Not set'),
    monthDay: formatMonthDay(DATE),
    numeric: formatNumericDate(DATE),
    dateTime: formatDateTime(DATE),
    time: formatClockTime(DATE),
    seconds: formatClockTime(DATE, { seconds: true }),
  };
}

beforeEach(() => {
  getLocalesSpy = jest.spyOn(Localization, 'getLocales');
});

afterEach(() => {
  getLocalesSpy.mockRestore();
});

describe('format-date', () => {
  it('uses the jest.setup locale (en-US) by default', () => {
    expect(deviceLocale()).toBe('en-US');
    expect(render()).toEqual({
      short: 'Sat, Oct 3',
      long: 'Saturday, October 3, 2026',
      calendar: 'October 3, 2026',
      season: 'October 3, 2026',
      monthDay: 'Oct 3',
      numeric: '10/3/2026',
      dateTime: '10/3/2026, 7:30:45 PM',
      time: '7:30 PM',
      seconds: '7:30:45 PM',
    });
    expect(formatMonthShort(DATE)).toBe('Oct');
  });

  it('accepts an ISO string as well as a Date', () => {
    const iso = DATE.toISOString();
    expect(formatShortDate(iso)).toBe(formatShortDate(DATE));
    expect(formatLongDate(iso)).toBe(formatLongDate(DATE));
    expect(formatNumericDate(iso)).toBe(formatNumericDate(DATE));
    expect(formatClockTime(iso)).toBe(formatClockTime(DATE));
  });

  it('capitalizes the weekday that starts a Spanish game date, and leaves the rest lowercase', () => {
    withLocales([{ languageTag: 'es-ES' }]);
    expect(formatLongDate(DATE)).toBe('Sábado, 3 de octubre de 2026');
    expect(formatShortDate(DATE)).toMatch(/^Sáb,? 3 oct/);
    // Formats that do not start with a weekday keep the runtime's own case.
    expect(formatCalendarDate(DATE)).toBe('3 de octubre de 2026');
  });

  it('returns the fallback for a missing season date', () => {
    expect(formatSeasonDate(null, 'Not set')).toBe('Not set');
  });

  it('renders differently under en-US, en-GB and es-ES', () => {
    withLocales([{ languageTag: 'en-US' }]);
    const us = render();
    withLocales([{ languageTag: 'en-GB' }]);
    const gb = render();
    withLocales([{ languageTag: 'es-ES' }]);
    const es = render();

    // en-GB: day before month, 24-hour clock.
    expect(gb.calendar).toBe('3 October 2026');
    expect(gb.numeric).toBe('03/10/2026');
    expect(gb.time).toBe('19:30');
    // es-ES: Spanish month and weekday names, 24-hour clock.
    expect(es.long.toLowerCase()).toContain('octubre');
    expect(es.long.toLowerCase()).toContain('sábado');
    expect(es.time).toBe('19:30');

    for (const key of Object.keys(us)) {
      expect(new Set([us[key], gb[key], es[key]]).size).toBeGreaterThan(1);
    }
    expect(new Set([us.long, gb.long, es.long]).size).toBe(3);
  });

  it('reads the locale on every call, so a language change applies at once', () => {
    withLocales([{ languageTag: 'en-US' }]);
    expect(formatClockTime(DATE)).toBe('7:30 PM');
    withLocales([{ languageTag: 'en-GB' }]);
    expect(formatClockTime(DATE)).toBe('19:30');
  });

  it.each([
    ['the device reports no locale', []],
    ['the tag is empty', [{ languageTag: '' }]],
  ])('falls back to the runtime default when %s', (_label, locales) => {
    withLocales(locales);
    expect(deviceLocale()).toBeUndefined();
    expect(formatNumericDate(DATE)).toBe(DATE.toLocaleDateString(undefined));
  });
});
