/**
 * Practice scheduling helpers (#33): the team schedule merge, the labels a
 * practice shows, the local date and time a series is sent with, and the
 * create form's checks. Screens derive from these, never inline them.
 */

import { i18n } from '../i18n';
import {
  formatClockTime,
  formatWallClock,
  formatWeekdayName,
  formatZoneName,
  isOtherTimeZone,
} from './format-date';
import { childDisplayName } from './display-name';
import { guardianChildrenOnTeam, isRosteredOn, type GuardianUser, type TeamWithMembers } from './guardian';
import type { Game } from '../types/game';
import type { Practice, PracticeFrequency } from '../types/practice';

/** Most sessions one series may create; the API's `MAX_SERIES_OCCURRENCES`. */
export const MAX_SERIES_OCCURRENCES = 100;
/** Furthest a series' end date may be from its start, in days; the API's `MAX_SERIES_SPAN_DAYS`. */
export const MAX_SERIES_SPAN_DAYS = 366;
/** The API's text limits. */
export const PRACTICE_TITLE_MAX = 100;
export const PRACTICE_LOCATION_MAX = 200;
export const PRACTICE_NOTES_MAX = 1000;
export const PRACTICE_CANCEL_REASON_MAX = 500;
export const AVAILABILITY_COMMENT_MAX = 500;

/** How far ahead the team schedule looks, in days, from the start of today. */
export const SCHEDULE_WINDOW_DAYS = 90;

/** The API's start windows, in days from today: a series' first date, and a one-off practice. */
export const MAX_SERIES_BACKDATE_DAYS = 31;
export const MAX_SERIES_LEAD_DAYS = 366;
export const MAX_PRACTICE_PAST_DAYS = 31;
export const MAX_PRACTICE_FUTURE_DAYS = MAX_SERIES_LEAD_DAYS + MAX_SERIES_SPAN_DAYS;

/**
 * The start date's window, as the API checks it (in local calendar days from
 * `today`): a series starts at most 31 days back and 366 ahead, a one-off at
 * most 31 back and 732 ahead. The message for the date row, or undefined.
 */
export function validateStartDate(start: Date, recurring: boolean, today: Date = new Date()): string | undefined {
  const days = calendarDaysBetween(today, start);
  const back = recurring ? MAX_SERIES_BACKDATE_DAYS : MAX_PRACTICE_PAST_DAYS;
  const ahead = recurring ? MAX_SERIES_LEAD_DAYS : MAX_PRACTICE_FUTURE_DAYS;
  if (days < -back) return i18n.t('practices.errors.startTooEarly', { days: back });
  if (days > ahead) return i18n.t('practices.errors.startTooLate', { days: ahead });
  return undefined;
}

/** Duration choices, in minutes. */
export const PRACTICE_DURATIONS = [30, 45, 60, 75, 90, 120] as const;
export const DEFAULT_PRACTICE_DURATION = 90;

/** Weekday chips run Monday to Sunday: the API's biweekly weeks do too. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export type ScheduleItem =
  | { kind: 'game'; id: string; startsAt: string; game: Game }
  | { kind: 'practice'; id: string; startsAt: string; practice: Practice };

/**
 * One list for the team schedule, ascending by start. Both lists cover the
 * same bounded window (`SCHEDULE_WINDOW_DAYS`), which keeps them inside one
 * page each in practice. Practices come ascending: when their page is short
 * of the total, the rest start after the last one fetched, so games after
 * that point are held back too (they would otherwise sit next to a gap).
 * Games come newest first, so a short games page has lost the SOONEST ones
 * and nothing can be held back to hide that; it is flagged all the same.
 * `truncated` says either happened.
 */
export function mergeSchedule(
  games: Game[],
  gamesTotal: number,
  practices: Practice[],
  practicesTotal: number
): { items: ScheduleItem[]; truncated: boolean } {
  const practicesTruncated = practices.length < practicesTotal && practices.length > 0;
  const truncated = practicesTruncated || games.length < gamesTotal;
  const cutoff = practicesTruncated
    ? new Date(practices[practices.length - 1].startsAt).getTime()
    : Infinity;
  const items: ScheduleItem[] = [
    ...games
      .filter((game) => new Date(game.date).getTime() <= cutoff)
      .map((game) => ({ kind: 'game' as const, id: game.id, startsAt: game.date, game })),
    ...practices.map((practice) => ({
      kind: 'practice' as const,
      id: practice.id,
      startsAt: practice.startsAt,
      practice,
    })),
  ];
  items.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return { items, truncated };
}

/** The practice's own title, or "Practice" / "Team event" by type. */
export function practiceTitle(practice: Pick<Practice, 'title' | 'type'>): string {
  if (practice.title) return practice.title;
  return practice.type === 'OTHER' ? i18n.t('practices.typeOther') : i18n.t('practices.typePractice');
}

/** The end instant: start plus duration. */
export function practiceEndsAt(practice: Pick<Practice, 'startsAt' | 'durationMinutes'>): Date {
  return new Date(new Date(practice.startsAt).getTime() + practice.durationMinutes * 60_000);
}

/**
 * "6:00 PM – 7:30 PM", in the session's zone, so the coach's wall time reads
 * the same for everyone; a viewer in another zone also gets the zone's name
 * ("6:00 PM – 7:30 PM EST").
 */
export function formatPracticeTimeRange(
  practice: Pick<Practice, 'startsAt' | 'durationMinutes' | 'timezone'>
): string {
  const timeZone = practice.timezone;
  const range = i18n.t('practices.timeRange', {
    start: formatClockTime(practice.startsAt, { timeZone }),
    end: formatClockTime(practiceEndsAt(practice), { timeZone }),
  });
  if (!isOtherTimeZone(timeZone, practice.startsAt)) return range;
  const zone = formatZoneName(practice.startsAt, timeZone);
  return zone ? `${range} ${zone}` : range;
}

/** Weekday names in chip order, e.g. "Tue, Thu". */
export function formatWeekdayList(weekdays: readonly number[]): string {
  return WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => formatWeekdayName(day))
    .join(', ');
}

/**
 * "Weekly on Tue, Thu at 6:00 PM" / "Every 2 weeks on …" for a series
 * occurrence. The start time is the series' wall time in its zone, so, like
 * the time range, it names the zone for a viewer elsewhere (`zone.at` is the
 * occurrence the line sits next to).
 */
export function formatRecurrence(
  series: { frequency: PracticeFrequency; weekdays: number[]; startTime: string },
  zone?: { timeZone: string; at: Date | string }
): string {
  const key = series.frequency === 'BIWEEKLY' ? 'practices.recurrenceBiweekly' : 'practices.recurrenceWeekly';
  const line = i18n.t(key, { days: formatWeekdayList(series.weekdays), time: formatWallClock(series.startTime) });
  if (!zone || !isOtherTimeZone(zone.timeZone, zone.at)) return line;
  const name = formatZoneName(zone.at, zone.timeZone);
  return name ? `${line} ${name}` : line;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The device-local calendar date of `date`, "YYYY-MM-DD" (a series' `startDate` / `endDate`). */
export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The device-local wall time of `date`, "HH:MM" (a series' `startTime`). */
export function toLocalTimeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A device-local Date that only carries a calendar date "YYYY-MM-DD" to and
 * from a date picker (read back with `toLocalDateKey`). Noon, so no
 * daylight-saving change on the device can move it to another day. It is a
 * container for the picker's fields, never an instant sent to the API.
 */
export function pickerDateFor(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/**
 * A device-local Date that only carries a wall time "HH:MM" to and from a
 * time picker (read back with `toLocalTimeKey`). It sits on a fixed mid-January
 * day, when no zone changes its clocks, so every HH:MM exists on it (on the
 * practice's own date the device might skip that hour). Never sent to the API.
 */
export function pickerTimeFor(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':').map((part) => Number(part));
  return new Date(2001, 0, 15, hours, minutes, 0, 0);
}

/** `date`'s day with `time`'s hours and minutes, both device-local. */
export function combineDateAndTime(date: Date, time: Date): Date {
  const result = new Date(date);
  result.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return result;
}

/** Whole local calendar days from `from` to `to` (DST-proof: counted on dates, not milliseconds). */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

export interface RecurrenceErrors {
  /** The start date's window (`validateStartDate`); set by the form, one-off or series. */
  startDate?: string;
  weekdays?: string;
  endDate?: string;
  count?: string;
}

/**
 * Days from `startDate` to the `count`-th occurrence, walking the local
 * calendar as the API's `expandRecurrence` does (BIWEEKLY: every other
 * Monday-to-Sunday week, counted from the week of the first chosen weekday on
 * or after the start); `null` when it is not reached within twice the span
 * limit (already too far).
 */
export function daysToOccurrence(
  startDate: Date,
  weekdays: readonly number[],
  frequency: PracticeFrequency,
  count: number
): number | null {
  if (count < 1) return null;
  return occurrenceOffsets(startDate, weekdays, frequency, 2 * MAX_SERIES_SPAN_DAYS)[count - 1] ?? null;
}

/**
 * Day offsets from `startDate` of every occurrence up to `maxDays` days later
 * (inclusive), walking the local calendar as the API's `expandRecurrence` does.
 */
export function occurrenceOffsets(
  startDate: Date,
  weekdays: readonly number[],
  frequency: PracticeFrequency,
  maxDays: number
): number[] {
  const mondayIndex = (date: Date) => {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return Math.round(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / (7 * 86_400_000));
  };
  const offsets: number[] = [];
  let firstWeek: number | null = null;
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + offset);
    if (!weekdays.includes(date.getDay())) continue;
    const week = mondayIndex(date);
    if (firstWeek === null) firstWeek = week;
    if (frequency === 'BIWEEKLY' && (week - firstWeek) % 2 !== 0) continue;
    offsets.push(offset);
  }
  return offsets;
}

/** The create form's recurrence checks, mirroring the API's (it stays the authority). */
export function validateRecurrence(input: {
  weekdays: readonly number[];
  frequency: PracticeFrequency;
  startDate: Date;
  endMode: 'date' | 'count';
  endDate: Date;
  count: string;
}): RecurrenceErrors {
  const errors: RecurrenceErrors = {};
  if (input.weekdays.length === 0) errors.weekdays = i18n.t('practices.errors.weekdaysRequired');
  if (input.endMode === 'date') {
    const span = calendarDaysBetween(input.startDate, input.endDate);
    if (span < 0) errors.endDate = i18n.t('practices.errors.endBeforeStart');
    else if (span > MAX_SERIES_SPAN_DAYS) {
      errors.endDate = i18n.t('practices.errors.endTooFar', { max: MAX_SERIES_SPAN_DAYS });
    } else if (input.weekdays.length > 0) {
      // As the API: the range must hold at least one practice and at most the cap.
      const sessions = occurrenceOffsets(input.startDate, input.weekdays, input.frequency, span).length;
      if (sessions === 0) errors.endDate = i18n.t('practices.errors.noSessions');
      else if (sessions > MAX_SERIES_OCCURRENCES) {
        errors.endDate = i18n.t('practices.errors.tooManySessions', { n: sessions, max: MAX_SERIES_OCCURRENCES });
      }
    }
  } else {
    const count = Number(input.count);
    if (!/^\d+$/.test(input.count.trim()) || count < 1 || count > MAX_SERIES_OCCURRENCES) {
      errors.count = i18n.t('practices.errors.countRange', { max: MAX_SERIES_OCCURRENCES });
    } else if (input.weekdays.length > 0) {
      // The API also refuses a count whose last practice falls past the span limit.
      const days = daysToOccurrence(input.startDate, input.weekdays, input.frequency, count);
      if (days === null || days > MAX_SERIES_SPAN_DAYS) {
        errors.count = i18n.t('practices.errors.countTooFar', { max: MAX_SERIES_SPAN_DAYS });
      }
    }
  }
  return errors;
}

export interface Respondent {
  /** `null` = the signed-in user themself. */
  id: string | null;
  name: string;
}

/**
 * Who this user can answer availability for on `team`: themself when they
 * are on the roster (the API refuses anyone else's own answer), then each of
 * their children on it. Empty when they can answer for nobody.
 */
export function practiceRespondents(
  user: (GuardianUser & { id?: string }) | null | undefined,
  team: TeamWithMembers | null | undefined
): Respondent[] {
  const list: Respondent[] = [];
  if (isRosteredOn(user, team)) list.push({ id: null, name: i18n.t('games.rsvp.me') });
  for (const child of guardianChildrenOnTeam(user, team)) {
    list.push({ id: child.childId, name: childDisplayName(child) });
  }
  return list;
}
