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

/** Duration choices, in minutes. */
export const PRACTICE_DURATIONS = [30, 45, 60, 75, 90, 120] as const;
export const DEFAULT_PRACTICE_DURATION = 90;

/** Weekday chips run Monday to Sunday: the API's biweekly weeks do too. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export type ScheduleItem =
  | { kind: 'game'; id: string; startsAt: string; game: Game }
  | { kind: 'practice'; id: string; startsAt: string; practice: Practice };

/**
 * One list for the team schedule, ascending by start. Practices come a page
 * at a time in ascending order: when the page is short of the total, the rest
 * start after the last one fetched, so games after that point are held back
 * too (they would otherwise sit next to a gap). `truncated` says so.
 */
export function mergeSchedule(
  games: Game[],
  practices: Practice[],
  practicesTotal: number
): { items: ScheduleItem[]; truncated: boolean } {
  const truncated = practices.length < practicesTotal && practices.length > 0;
  const cutoff = truncated ? new Date(practices[practices.length - 1].startsAt).getTime() : Infinity;
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
  if (!isOtherTimeZone(timeZone)) return range;
  const zone = formatZoneName(practice.startsAt, timeZone);
  return zone ? `${range} ${zone}` : range;
}

/** Weekday names in chip order, e.g. "Tue, Thu". */
export function formatWeekdayList(weekdays: readonly number[]): string {
  return WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => formatWeekdayName(day))
    .join(', ');
}

/** "Weekly on Tue, Thu at 6:00 PM" / "Every 2 weeks on …" for a series occurrence. */
export function formatRecurrence(series: {
  frequency: PracticeFrequency;
  weekdays: number[];
  startTime: string;
}): string {
  const key = series.frequency === 'BIWEEKLY' ? 'practices.recurrenceBiweekly' : 'practices.recurrenceWeekly';
  return i18n.t(key, { days: formatWeekdayList(series.weekdays), time: formatWallClock(series.startTime) });
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
  weekdays?: string;
  endDate?: string;
  count?: string;
}

/** The create form's recurrence checks, mirroring the API's (it stays the authority). */
export function validateRecurrence(input: {
  weekdays: readonly number[];
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
    }
  } else {
    const count = Number(input.count);
    if (!/^\d+$/.test(input.count.trim()) || count < 1 || count > MAX_SERIES_OCCURRENCES) {
      errors.count = i18n.t('practices.errors.countRange', { max: MAX_SERIES_OCCURRENCES });
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
