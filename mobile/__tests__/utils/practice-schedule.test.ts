/**
 * utils/practice-schedule.ts and the zone-aware helpers in utils/format-date.ts (#33).
 */

import {
  mergeSchedule,
  practiceTitle,
  formatPracticeTimeRange,
  formatRecurrence,
  toLocalDateKey,
  toLocalTimeKey,
  combineDateAndTime,
  calendarDaysBetween,
  validateRecurrence,
  practiceRespondents,
} from '../../utils/practice-schedule';
import {
  deviceTimeZone,
  formatClockTime,
  formatLongDate,
  formatWallClock,
  formatWeekdayName,
} from '../../utils/format-date';
import { i18n } from '../../i18n';
import type { Game } from '../../types/game';
import type { Practice } from '../../types/practice';

const game = (id: string, date: string): Game => ({
  id,
  teamId: 't1',
  opponent: 'Lakers',
  date,
  status: 'SCHEDULED',
  homeScore: 0,
  awayScore: 0,
  createdAt: date,
  updatedAt: date,
});

const practice = (id: string, startsAt: string, extra: Partial<Practice> = {}): Practice => ({
  id,
  teamId: 't1',
  seriesId: null,
  type: 'PRACTICE',
  title: null,
  location: null,
  notes: null,
  startsAt,
  durationMinutes: 90,
  timezone: 'America/New_York',
  status: 'SCHEDULED',
  cancelledAt: null,
  cancelReason: null,
  isException: false,
  exceptionFields: [],
  createdAt: startsAt,
  updatedAt: startsAt,
  team: { id: 't1', name: 'Warriors' },
  series: null,
  ...extra,
});

/** A zone that is certainly not the machine's, for the "viewer elsewhere" cases. */
const OTHER_ZONE = deviceTimeZone() === 'Asia/Tokyo' ? 'Europe/London' : 'Asia/Tokyo';

describe('mergeSchedule', () => {
  it('interleaves games (served newest first) and practices by start time', () => {
    const { items, truncated } = mergeSchedule(
      [game('g2', '2026-12-05T18:00:00Z'), game('g1', '2026-12-01T18:00:00Z')],
      [practice('p1', '2026-11-30T23:00:00Z'), practice('p2', '2026-12-03T23:00:00Z')],
      2
    );
    expect(items.map((i) => i.id)).toEqual(['p1', 'g1', 'p2', 'g2']);
    expect(truncated).toBe(false);
  });

  it('holds back games after the last fetched practice when practices run past one page', () => {
    const { items, truncated } = mergeSchedule(
      [game('g-late', '2027-03-01T18:00:00Z'), game('g-early', '2026-12-01T18:00:00Z')],
      [practice('p1', '2026-11-30T23:00:00Z'), practice('p2', '2026-12-03T23:00:00Z')],
      5
    );
    expect(items.map((i) => i.id)).toEqual(['p1', 'g-early', 'p2']);
    expect(truncated).toBe(true);
  });
});

describe('practiceTitle', () => {
  it('uses the title, else the type', () => {
    expect(practiceTitle({ title: 'Shooting', type: 'PRACTICE' })).toBe('Shooting');
    expect(practiceTitle({ title: null, type: 'PRACTICE' })).toBe('Practice');
    expect(practiceTitle({ title: null, type: 'OTHER' })).toBe('Team event');
  });
});

describe('time zones', () => {
  it('shows a session in its own zone, naming the zone when it is not the device zone', () => {
    // 18:00 in Tokyo is 09:00Z.
    const p = practice('p1', '2026-12-01T09:00:00Z', { timezone: 'Asia/Tokyo', durationMinutes: 90 });
    const range = formatPracticeTimeRange(p);
    if (OTHER_ZONE === 'Asia/Tokyo') {
      expect(range).toMatch(/^6:00\sPM – 7:30\sPM \S+$/);
    }
    expect(formatClockTime(p.startsAt, { timeZone: 'Asia/Tokyo' })).toMatch(/^6:00\sPM$/);
  });

  it('names no zone when the session is in the device zone', () => {
    const zone = deviceTimeZone();
    if (!zone) return;
    const p = practice('p1', '2026-12-01T09:00:00Z', { timezone: zone });
    expect(formatPracticeTimeRange(p)).toMatch(/^\d{1,2}:\d{2}\s[AP]M – \d{1,2}:\d{2}\s[AP]M$/);
  });

  it('keeps 18:00 local across a DST change (the stored instants move, the wall time does not)', () => {
    // New York: 22:00Z in October (EDT), 23:00Z in December (EST).
    expect(formatClockTime('2026-10-20T22:00:00Z', { timeZone: 'America/New_York' })).toMatch(/^6:00\sPM$/);
    expect(formatClockTime('2026-12-01T23:00:00Z', { timeZone: 'America/New_York' })).toMatch(/^6:00\sPM$/);
  });

  it('shows the date of the session zone, not the device zone', () => {
    // 23:30 in New York on Dec 1 is already Dec 2 in UTC.
    expect(formatLongDate('2026-12-02T04:30:00Z', { timeZone: 'America/New_York' })).toBe(
      'Tuesday, December 1, 2026'
    );
  });

  it('falls back to the device zone for a name the runtime does not know', () => {
    expect(() => formatClockTime('2026-12-01T23:00:00Z', { timeZone: 'Not/AZone' })).not.toThrow();
    expect(formatClockTime('2026-12-01T23:00:00Z', { timeZone: 'Not/AZone' })).toBe(
      formatClockTime('2026-12-01T23:00:00Z')
    );
  });
});

describe('recurrence labels', () => {
  it('names weekdays and the wall-clock start', () => {
    expect(formatWeekdayName(0)).toBe('Sun');
    expect(formatWeekdayName(2, 'long')).toBe('Tuesday');
    expect(formatWallClock('18:00')).toMatch(/^6:00\sPM$/);
    expect(formatRecurrence({ frequency: 'WEEKLY', weekdays: [4, 2], startTime: '18:00' })).toMatch(
      /^Weekly on Tue, Thu at 6:00\sPM$/
    );
    expect(formatRecurrence({ frequency: 'BIWEEKLY', weekdays: [0, 6], startTime: '09:30' })).toMatch(
      /^Every 2 weeks on Sat, Sun at 9:30\sAM$/
    );
  });

  it('is Spanish on a Spanish device', async () => {
    await i18n.changeLanguage('es');
    try {
      expect(formatRecurrence({ frequency: 'WEEKLY', weekdays: [2], startTime: '18:00' })).toMatch(/^Cada semana: /);
      expect(practiceTitle({ title: null, type: 'PRACTICE' })).toBe('Entrenamiento');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('local date keys', () => {
  it('writes the device-local date and time the series is sent with', () => {
    const date = new Date(2027, 0, 5, 18, 7);
    expect(toLocalDateKey(date)).toBe('2027-01-05');
    expect(toLocalTimeKey(date)).toBe('18:07');
  });

  it('combines a date and a time', () => {
    const combined = combineDateAndTime(new Date(2027, 0, 5, 9, 0), new Date(2026, 5, 1, 18, 30));
    expect(toLocalDateKey(combined)).toBe('2027-01-05');
    expect(toLocalTimeKey(combined)).toBe('18:30');
  });

  it('counts calendar days', () => {
    expect(calendarDaysBetween(new Date(2027, 0, 1, 23), new Date(2027, 0, 2, 1))).toBe(1);
    expect(calendarDaysBetween(new Date(2027, 0, 2), new Date(2027, 0, 1))).toBe(-1);
  });
});

describe('validateRecurrence', () => {
  const base = {
    weekdays: [2],
    startDate: new Date(2027, 0, 1),
    endMode: 'date' as const,
    endDate: new Date(2027, 2, 1),
    count: '10',
  };

  it('accepts a sound rule', () => {
    expect(validateRecurrence(base)).toEqual({});
  });

  it('needs a weekday', () => {
    expect(validateRecurrence({ ...base, weekdays: [] }).weekdays).toBe('Pick at least one day');
  });

  it('refuses an end before the start, or more than 366 days after it', () => {
    expect(validateRecurrence({ ...base, endDate: new Date(2026, 11, 31) }).endDate).toBeTruthy();
    expect(validateRecurrence({ ...base, endDate: new Date(2028, 0, 3) }).endDate).toBe(
      'The last date must be within 366 days of the first'
    );
  });

  it('takes a count of 1 to 100', () => {
    const count = (value: string) => validateRecurrence({ ...base, endMode: 'count', count: value }).count;
    expect(count('1')).toBeUndefined();
    expect(count('100')).toBeUndefined();
    expect(count('0')).toBeTruthy();
    expect(count('101')).toBeTruthy();
    expect(count('ten')).toBeTruthy();
  });
});

describe('practiceRespondents', () => {
  const team = { members: [{ playerId: 'steph' }, { playerId: 'seth' }, { playerId: 'klay' }] };
  const child = (childId: string, childName: string) => ({
    childId,
    childName,
    childDeletedAt: null,
    relationship: 'FATHER' as const,
    isPrimary: true,
    isManaged: false,
  });

  it('a rostered player answers for themself only', () => {
    expect(practiceRespondents({ id: 'klay' }, team)).toEqual([{ id: null, name: 'Me' }]);
  });

  it('a guardian answers for each child on the roster, never for themself when not rostered', () => {
    const user = { id: 'dell', guardianOf: [child('steph', 'Steph Curry'), child('seth', 'Seth Curry'), child('x', 'Off Roster')] };
    expect(practiceRespondents(user, team)).toEqual([
      { id: 'steph', name: 'Steph Curry' },
      { id: 'seth', name: 'Seth Curry' },
    ]);
  });

  it('a coach who is neither gets nobody', () => {
    expect(practiceRespondents({ id: 'coach' }, team)).toEqual([]);
  });
});
