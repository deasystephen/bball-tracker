/**
 * Expands a practice series rule into its occurrences (#33). Pure: no
 * database, no clock. `PracticeSeriesService.createSeries` writes one
 * `PracticeSession` per occurrence returned here.
 *
 * The rule is the simplified subset the issue scoped (no RFC 5545 RRULE):
 * one or more weekdays, every week (WEEKLY) or every other week (BIWEEKLY),
 * from a local start date until a local end date or a number of occurrences.
 * BIWEEKLY weeks are counted from the Sunday-to-Saturday week that holds the
 * start date: that week is "on", the next is "off", and so on.
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
  // Sunday of the start date's week: week numbers count from here.
  const anchor = addDays(start, -weekdayOf(start));

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
