/**
 * Expands a practice series rule into its occurrences (#33). Pure: no
 * database, no clock. `PracticeSeriesService.createSeries` writes one
 * `PracticeSession` per occurrence returned here.
 *
 * The rule is the simplified subset the issue scoped (no RFC 5545 RRULE):
 * one or more weekdays, every week (WEEKLY) or every other week (BIWEEKLY),
 * from a local start date until a local end date or a number of occurrences.
 * BIWEEKLY weeks are Monday to Sunday (RFC 5545's default WKST=MO, so a
 * Saturday and the Sunday after it are one weekend), counted from the week of
 * the FIRST chosen weekday on or after the start date: that week is "on", the
 * next "off", and so on. "Every other Monday from Sunday the 15th" starts on
 * Monday the 16th, not the 23rd.
 *
 * Every occurrence is computed in the series' zone (`zonedTimeToUtc`), so a
 * 18:00 practice in America/New_York is 22:00Z in October and 23:00Z in
 * November: the wall clock holds, the UTC instant moves.
 */

import type { PracticeFrequency } from '@prisma/client';
import {
  addDays,
  daysBetween,
  formatLocalDate,
  parseLocalDate,
  parseLocalTime,
  weekdayOf,
  zonedTimeToUtc,
  type LocalDate,
} from './zoned-time';

export interface RecurrenceRule {
  frequency: PracticeFrequency;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** "YYYY-MM-DD", local. */
  startDate: string;
  /** "HH:MM", local. */
  startTime: string;
  timezone: string;
  /** "YYYY-MM-DD", local, inclusive. Exactly one of endDate / occurrenceCount. */
  endDate?: string | null;
  occurrenceCount?: number | null;
}

export interface Occurrence {
  /** The occurrence's local calendar date, "YYYY-MM-DD". */
  localDate: string;
  startsAt: Date;
}

/**
 * The occurrences of `rule`, in order. Stops at the end condition or after
 * `max + 1` occurrences, whichever comes first, so a caller can tell "exactly
 * max" from "more than max" without the loop running unbounded.
 */
export function expandRecurrence(rule: RecurrenceRule, max: number): Occurrence[] {
  const start = parseLocalDate(rule.startDate);
  const end: LocalDate | null = rule.endDate ? parseLocalDate(rule.endDate) : null;
  const limit = Math.min(rule.occurrenceCount ?? Number.POSITIVE_INFINITY, max + 1);
  const { hour, minute } = parseLocalTime(rule.startTime);
  const days = new Set(rule.weekdays);
  const step = rule.frequency === 'BIWEEKLY' ? 2 : 1;
  // Monday of the week holding the first matching date: weeks count from here.
  let first = start;
  for (let i = 0; i < 7 && !days.has(weekdayOf(first)); i++) first = addDays(first, 1);
  if (!days.has(weekdayOf(first))) return []; // no weekday in 0–6 at all
  const anchor = addDays(first, -((weekdayOf(first) + 6) % 7));

  const occurrences: Occurrence[] = [];
  // A count-ended rule needs at most `limit` matching weeks; every week has at
  // least one matching day, so this bounds the walk either way.
  const maxDays = end ? daysBetween(start, end) : limit * 7 * step;
  for (let offset = 0; offset <= maxDays && occurrences.length < limit; offset++) {
    const date = addDays(start, offset);
    if (!days.has(weekdayOf(date))) continue;
    const week = Math.floor(daysBetween(anchor, date) / 7);
    if (week % step !== 0) continue;
    occurrences.push({
      localDate: formatLocalDate(date),
      startsAt: zonedTimeToUtc(date, hour, minute, rule.timezone),
    });
  }
  return occurrences;
}
