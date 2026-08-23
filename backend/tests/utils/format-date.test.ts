/**
 * Unit tests for the email date helpers (audit #57).
 */

import { formatEmailDate, formatEmailDateTime, getDefaultTimeZone } from '../../src/utils/format-date';

describe('format-date', () => {
  const ORIGINAL = process.env.DEFAULT_TIMEZONE;
  // 2026-03-16T02:30:00Z == 2026-03-15 7:30 PM PDT == 2026-03-16 11:30 AM JST
  const instant = new Date('2026-03-16T02:30:00Z');

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEFAULT_TIMEZONE;
    else process.env.DEFAULT_TIMEZONE = ORIGINAL;
  });

  it('defaults to America/Los_Angeles (not the server zone)', () => {
    delete process.env.DEFAULT_TIMEZONE;
    expect(getDefaultTimeZone()).toBe('America/Los_Angeles');
    expect(formatEmailDate(instant)).toBe('Mar 15, 2026');
    expect(formatEmailDateTime(instant)).toMatch(/^Mar 15, 2026, 7:30\u202fPM$|^Mar 15, 2026, 7:30 PM$/);
  });

  it('honours DEFAULT_TIMEZONE', () => {
    process.env.DEFAULT_TIMEZONE = 'Asia/Tokyo';
    expect(formatEmailDate(instant)).toBe('Mar 16, 2026');
    expect(formatEmailDateTime(instant)).toMatch(/Mar 16, 2026, 11:30/);
  });

  it('an explicit zone overrides the default', () => {
    process.env.DEFAULT_TIMEZONE = 'Asia/Tokyo';
    expect(formatEmailDate(instant, 'America/New_York')).toBe('Mar 15, 2026');
  });

  it('falls back to Los Angeles for an unknown zone instead of throwing', () => {
    process.env.DEFAULT_TIMEZONE = 'Not/AZone';
    expect(formatEmailDate(instant)).toBe('Mar 15, 2026');
    expect(formatEmailDate(instant, 'Also/Bogus')).toBe('Mar 15, 2026');
  });
});
