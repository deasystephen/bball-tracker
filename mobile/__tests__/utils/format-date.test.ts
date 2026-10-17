/**
 * utils/format-date.ts (#769): the locale comes from the device's full
 * language tag, read once through `requireOptionalNativeModule`, and falls
 * back to `undefined` (the runtime default) when the module is missing.
 */
import { requireOptionalNativeModule } from 'expo';

import {
  deviceLocale,
  formatClockTime,
  formatLongDate,
  formatSeasonDate,
  formatShortDate,
  resetDeviceLocaleCacheForTests,
} from '../../utils/format-date';

const mockedRequire = requireOptionalNativeModule as jest.Mock;

/** Saturday 3 October 2026, 19:30:45 local time. */
const DATE = new Date(2026, 9, 3, 19, 30, 45);

function withLocale(languageTag: string | null): void {
  resetDeviceLocaleCacheForTests();
  mockedRequire.mockImplementation((name: string) =>
    name === 'ExpoLocalization' ? { getLocales: () => [{ languageTag }] } : null
  );
}

function render(): Record<string, string> {
  return {
    short: formatShortDate(DATE),
    long: formatLongDate(DATE),
    season: formatSeasonDate(DATE, 'Not set'),
    time: formatClockTime(DATE),
    seconds: formatClockTime(DATE, { seconds: true }),
  };
}

const defaultImplementation = mockedRequire.getMockImplementation();

afterEach(() => {
  mockedRequire.mockImplementation(defaultImplementation);
  resetDeviceLocaleCacheForTests();
});

describe('format-date', () => {
  it('uses the jest.setup locale (en-US) by default', () => {
    expect(deviceLocale()).toBe('en-US');
    expect(render()).toEqual({
      short: 'Sat, Oct 3',
      long: 'Saturday, October 3, 2026',
      season: 'October 3, 2026',
      time: '7:30 PM',
      seconds: '7:30:45 PM',
    });
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(formatLongDate(DATE.toISOString())).toBe(formatLongDate(DATE));
    expect(formatClockTime(DATE.toISOString())).toBe(formatClockTime(DATE));
  });

  it('returns the fallback for a missing season date', () => {
    expect(formatSeasonDate(null, 'Not set')).toBe('Not set');
  });

  it('renders differently under en-US, en-GB and es-ES', () => {
    withLocale('en-US');
    const us = render();
    withLocale('en-GB');
    const gb = render();
    withLocale('es-ES');
    const es = render();

    // en-GB: day before month, 24-hour clock.
    expect(gb.season).toBe('3 October 2026');
    expect(gb.time).toBe('19:30');
    // es-ES: Spanish month and weekday names, 24-hour clock.
    expect(es.long.toLowerCase()).toContain('octubre');
    expect(es.long.toLowerCase()).toContain('sábado');
    expect(es.time).toBe('19:30');

    for (const key of Object.keys(us)) {
      expect(new Set([us[key], gb[key], es[key]]).size).toBeGreaterThan(1);
    }
    expect(us.long).not.toBe(gb.long);
    expect(us.long).not.toBe(es.long);
    expect(gb.long).not.toBe(es.long);
  });

  it('resolves the locale once and caches it', () => {
    withLocale('en-GB');
    mockedRequire.mockClear();
    expect(deviceLocale()).toBe('en-GB');
    expect(deviceLocale()).toBe('en-GB');
    expect(mockedRequire.mock.calls.filter(([name]) => name === 'ExpoLocalization')).toHaveLength(1);
  });

  it.each([
    ['the module is not in the binary', () => null],
    ['the module reports no locale', () => ({ getLocales: () => [] })],
    ['the tag is empty', () => ({ getLocales: () => [{ languageTag: '' }] })],
    ['the module is malformed', () => ({})],
    [
      'the probe throws',
      () => {
        throw new Error('no module');
      },
    ],
  ])('falls back to the runtime default when %s', (_label, impl) => {
    resetDeviceLocaleCacheForTests();
    mockedRequire.mockImplementation(impl);
    expect(deviceLocale()).toBeUndefined();
    expect(formatLongDate(DATE)).toBe(
      DATE.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    );
  });
});
