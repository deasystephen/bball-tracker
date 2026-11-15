/**
 * Recurrence expansion and zone arithmetic for practice series (#33).
 *
 * The point of the series design is that the LOCAL wall clock holds across a
 * daylight-saving change while the UTC instant moves; these cases pin that for
 * both hemispheres, the skipped and the repeated hour, BIWEEKLY week counting
 * and both end conditions.
 */

import { expandRecurrence, type RecurrenceRule } from '../../src/utils/practice-recurrence';
import {
  addDays,
  canonicalTimeZone,
  daysBetween,
  formatLocalDate,
  isValidTimeZone,
  parseLocalDate,
  weekdayOf,
  zonedTimeToUtc,
} from '../../src/utils/zoned-time';

const iso = (d: Date): string => d.toISOString();

describe('zonedTimeToUtc', () => {
  it('uses the offset of the day itself, not of today', () => {
    // New York: EDT (-4) in July, EST (-5) in January.
    expect(iso(zonedTimeToUtc({ year: 2027, month: 7, day: 6 }, 18, 0, 'America/New_York'))).toBe(
      '2027-07-06T22:00:00.000Z'
    );
    expect(iso(zonedTimeToUtc({ year: 2027, month: 1, day: 5 }, 18, 0, 'America/New_York'))).toBe(
      '2027-01-05T23:00:00.000Z'
    );
  });

  it('handles a southern-hemisphere zone, whose summer is in January', () => {
    // Sydney: AEDT (+11) in January, AEST (+10) in July.
    expect(iso(zonedTimeToUtc({ year: 2027, month: 1, day: 5 }, 17, 30, 'Australia/Sydney'))).toBe(
      '2027-01-05T06:30:00.000Z'
    );
    expect(iso(zonedTimeToUtc({ year: 2027, month: 7, day: 6 }, 17, 30, 'Australia/Sydney'))).toBe(
      '2027-07-06T07:30:00.000Z'
    );
  });

  it('handles a zone with a non-hour offset and UTC itself', () => {
    expect(iso(zonedTimeToUtc({ year: 2027, month: 3, day: 2 }, 18, 0, 'Asia/Kolkata'))).toBe(
      '2027-03-02T12:30:00.000Z'
    );
    expect(iso(zonedTimeToUtc({ year: 2027, month: 3, day: 2 }, 18, 0, 'UTC'))).toBe('2027-03-02T18:00:00.000Z');
  });

  it('moves a time inside the skipped spring-forward hour to after the jump', () => {
    // 2027-03-14 02:30 does not exist in New York; 03:30 EDT is 07:30Z.
    expect(iso(zonedTimeToUtc({ year: 2027, month: 3, day: 14 }, 2, 30, 'America/New_York'))).toBe(
      '2027-03-14T07:30:00.000Z'
    );
  });

  it('resolves the repeated fall-back hour to its first occurrence', () => {
    // 2026-11-01 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1 }, 1, 30, 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z'
    );
  });

  it('is exact on the transition day for an ordinary evening time', () => {
    expect(iso(zonedTimeToUtc({ year: 2027, month: 3, day: 14 }, 18, 0, 'America/New_York'))).toBe(
      '2027-03-14T22:00:00.000Z'
    );
    expect(iso(zonedTimeToUtc({ year: 2026, month: 11, day: 1 }, 18, 0, 'America/New_York'))).toBe(
      '2026-11-01T23:00:00.000Z'
    );
  });
});

describe('zoned-time helpers', () => {
  it('validates zone names and resolves them to the canonical one', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
    expect(canonicalTimeZone('america/NEW_york')).toBe('America/New_York');
    expect(canonicalTimeZone('Etc/GMT+5')).toBeNull(); // a fixed offset, no DST
    expect(canonicalTimeZone('Etc/UTC')).toBe('UTC');
    expect(canonicalTimeZone('+05:30')).toBeNull();
  });

  it('does calendar arithmetic across month and year ends', () => {
    expect(formatLocalDate(addDays(parseLocalDate('2026-12-30'), 3))).toBe('2027-01-02');
    expect(formatLocalDate(addDays(parseLocalDate('2028-02-28'), 1))).toBe('2028-02-29');
    expect(daysBetween(parseLocalDate('2026-12-30'), parseLocalDate('2027-01-02'))).toBe(3);
    expect(daysBetween(parseLocalDate('2027-01-02'), parseLocalDate('2026-12-30'))).toBe(-3);
    expect(weekdayOf(parseLocalDate('2026-11-17'))).toBe(2); // a Tuesday
  });
});

describe('expandRecurrence', () => {
  const tuesdays: RecurrenceRule = {
    frequency: 'WEEKLY',
    weekdays: [2],
    startDate: '2026-10-20',
    startTime: '18:00',
    timezone: 'America/New_York',
    endDate: '2026-11-10',
  };

  it('keeps 18:00 local across the November DST change (UTC moves from 22:00 to 23:00)', () => {
    const occurrences = expandRecurrence(tuesdays, 100);
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10']);
    expect(occurrences.map((o) => iso(o.startsAt))).toEqual([
      '2026-10-20T22:00:00.000Z',
      '2026-10-27T22:00:00.000Z',
      '2026-11-03T23:00:00.000Z',
      '2026-11-10T23:00:00.000Z',
    ]);
  });

  it('keeps 18:00 local across the March DST change the other way', () => {
    const occurrences = expandRecurrence(
      { ...tuesdays, startDate: '2027-03-09', endDate: '2027-03-16' },
      100
    );
    expect(occurrences.map((o) => iso(o.startsAt))).toEqual(['2027-03-09T23:00:00.000Z', '2027-03-16T22:00:00.000Z']);
  });

  it('includes the end date and starts on the first matching weekday on or after the start date', () => {
    // 2026-10-21 is a Wednesday: the first Tuesday is the 27th.
    const occurrences = expandRecurrence({ ...tuesdays, startDate: '2026-10-21' }, 100);
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-10-27', '2026-11-03', '2026-11-10']);
  });

  it('expands several weekdays in date order', () => {
    const occurrences = expandRecurrence({ ...tuesdays, weekdays: [4, 2], endDate: '2026-10-29' }, 100);
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29']);
  });

  it('BIWEEKLY skips every other week, counted from the start date week', () => {
    // Start on Thursday 2026-10-22 with Tue+Thu: the week of Oct 18 is "on"
    // (its Tuesday is before the start, so only Thursday), Oct 25 is off,
    // Nov 1 is on, Nov 8 off, Nov 15 on.
    const occurrences = expandRecurrence(
      { ...tuesdays, frequency: 'BIWEEKLY', weekdays: [2, 4], startDate: '2026-10-22', endDate: '2026-11-21' },
      100
    );
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-10-22', '2026-11-03', '2026-11-05', '2026-11-17', '2026-11-19']);
  });

  it('stops after occurrenceCount', () => {
    const occurrences = expandRecurrence(
      { ...tuesdays, endDate: null, occurrenceCount: 3, frequency: 'BIWEEKLY' },
      100
    );
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-10-20', '2026-11-03', '2026-11-17']);
  });

  it('returns max + 1 occurrences at most, so the caller can refuse an oversized rule', () => {
    const daily: RecurrenceRule = {
      ...tuesdays,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      endDate: '2027-10-20',
    };
    expect(expandRecurrence(daily, 100)).toHaveLength(101);
    expect(expandRecurrence({ ...daily, endDate: null, occurrenceCount: 100 }, 100)).toHaveLength(100);
  });

  it('returns nothing when no chosen weekday falls in the range', () => {
    expect(expandRecurrence({ ...tuesdays, startDate: '2026-10-21', endDate: '2026-10-23' }, 100)).toEqual([]);
  });
});
