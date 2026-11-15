/**
 * Zod schemas for practice scheduling (#33): single practices, recurring
 * series and per-session availability. Detail:
 * docs/architecture/practice-scheduling.md.
 */

import { z } from 'zod';
import { PracticeFrequency, PracticeStatus, PracticeType, RsvpStatus } from '@prisma/client';
import { canonicalTimeZone, isValidTimeZone, parseLocalDate, daysBetween } from '../../utils/zoned-time';

/** Most sessions one series may materialize. */
export const MAX_SERIES_OCCURRENCES = 100;
/** Furthest a series' endDate may be from its startDate, in days. */
export const MAX_SERIES_SPAN_DAYS = 366;
/**
 * Furthest in the past a series may start, in days: room to record the last
 * few weeks, but not a year of past sessions that a series cancel (which
 * deletes only future ones) could not clear.
 */
export const MAX_SERIES_BACKDATE_DAYS = 31;

export const PRACTICE_TITLE_MAX = 100;
export const PRACTICE_LOCATION_MAX = 200;
export const PRACTICE_NOTES_MAX = 1000;
export const PRACTICE_CANCEL_REASON_MAX = 500;
export const AVAILABILITY_COMMENT_MAX = 500;
/** 5 minutes to 12 hours. */
export const PRACTICE_DURATION_MIN = 5;
export const PRACTICE_DURATION_MAX = 720;

type OptionalTextSchema = z.ZodOptional<
  z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string | null, string>>>
>;

/** Optional free text: trimmed; an empty string clears the field (null). */
function optionalText(max: number, label: string): OptionalTextSchema {
  return z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
}

const TIMEZONE_MESSAGE = 'timezone must be an IANA zone name, e.g. America/New_York';

/** An IANA zone, stored under its canonical name (see `canonicalTimeZone`). */
const timezoneSchema = z
  .string()
  .min(1, 'timezone is required')
  .max(64, TIMEZONE_MESSAGE)
  .refine(isValidTimeZone, { message: TIMEZONE_MESSAGE })
  .transform((value) => canonicalTimeZone(value) ?? value);

const durationSchema = z
  .number()
  .int('durationMinutes must be a whole number')
  .min(PRACTICE_DURATION_MIN, `durationMinutes must be at least ${PRACTICE_DURATION_MIN}`)
  .max(PRACTICE_DURATION_MAX, `durationMinutes must be at most ${PRACTICE_DURATION_MAX}`);

/** An instant with an explicit zone ("Z" or an offset), never a floating local time. */
const instantSchema = z.iso.datetime({
  offset: true,
  message: 'startsAt must be an ISO 8601 date-time with Z or an offset',
});

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written "YYYY-MM-DD" (2027-02-30 is refused). */
function localDateSchema(label: string): z.ZodString {
  return z
    .string()
    .regex(LOCAL_DATE_RE, `${label} must be YYYY-MM-DD`)
    .refine(
      (value) => {
        const { year, month, day } = parseLocalDate(value);
        const d = new Date(Date.UTC(year, month - 1, day));
        return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
      },
      { message: `${label} must be a real calendar date` }
    );
}

const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'startTime must be HH:MM (24-hour)');

const practiceFields = {
  type: z.enum(PracticeType).optional().default(PracticeType.PRACTICE),
  title: optionalText(PRACTICE_TITLE_MAX, 'title'),
  location: optionalText(PRACTICE_LOCATION_MAX, 'location'),
  notes: optionalText(PRACTICE_NOTES_MAX, 'notes'),
};

/** POST /practices: one practice that belongs to no series. */
export const createPracticeSchema = z.object({
  teamId: z.uuid('Invalid team ID format'),
  ...practiceFields,
  startsAt: instantSchema,
  durationMinutes: durationSchema,
  timezone: timezoneSchema,
});

/** PATCH /practices/:id: edits one session; on a series occurrence it becomes an exception. */
export const updatePracticeSchema = z
  .object({
    type: z.enum(PracticeType).optional(),
    title: optionalText(PRACTICE_TITLE_MAX, 'title'),
    location: optionalText(PRACTICE_LOCATION_MAX, 'location'),
    notes: optionalText(PRACTICE_NOTES_MAX, 'notes'),
    startsAt: instantSchema.optional(),
    durationMinutes: durationSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field must be provided',
  });

/** POST /practices/:id/cancel. */
export const cancelPracticeSchema = z
  .object({
    reason: optionalText(PRACTICE_CANCEL_REASON_MAX, 'reason'),
  })
  .strict();

/** POST /practice-series: a recurring rule, materialized into sessions at once. */
export const createPracticeSeriesSchema = z
  .object({
    teamId: z.uuid('Invalid team ID format'),
    ...practiceFields,
    frequency: z.enum(PracticeFrequency, { error: 'frequency must be WEEKLY or BIWEEKLY' }),
    weekdays: z
      .array(
        z
          .number()
          .int('weekdays must be whole numbers')
          .min(0, 'weekdays run 0 (Sunday) to 6 (Saturday)')
          .max(6, 'weekdays run 0 (Sunday) to 6 (Saturday)')
      )
      .min(1, 'Pick at least one weekday')
      .max(7, 'weekdays has at most 7 entries')
      .refine((days) => new Set(days).size === days.length, { message: 'weekdays must not repeat' }),
    startDate: localDateSchema('startDate'),
    startTime: localTimeSchema,
    durationMinutes: durationSchema,
    timezone: timezoneSchema,
    endDate: localDateSchema('endDate').optional(),
    occurrenceCount: z
      .number()
      .int('occurrenceCount must be a whole number')
      .min(1, 'occurrenceCount must be at least 1')
      .max(MAX_SERIES_OCCURRENCES, `occurrenceCount must be at most ${MAX_SERIES_OCCURRENCES}`)
      .optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.endDate === undefined) === (data.occurrenceCount === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'Give exactly one of endDate or occurrenceCount',
      });
      return;
    }
    if (data.endDate !== undefined && LOCAL_DATE_RE.test(data.endDate) && LOCAL_DATE_RE.test(data.startDate)) {
      const span = daysBetween(parseLocalDate(data.startDate), parseLocalDate(data.endDate));
      if (span < 0) {
        ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must not be before startDate' });
      } else if (span > MAX_SERIES_SPAN_DAYS) {
        ctx.addIssue({
          code: 'custom',
          path: ['endDate'],
          message: `endDate must be within ${MAX_SERIES_SPAN_DAYS} days of startDate`,
        });
      }
    }
  });

/**
 * PATCH /practice-series/:id: the descriptive fields, applied to the series and
 * to every future SCHEDULED session that is not an exception. Dates and times
 * are not editable on a series (cancel it and create a new one).
 */
export const updatePracticeSeriesSchema = z
  .object({
    type: z.enum(PracticeType).optional(),
    title: optionalText(PRACTICE_TITLE_MAX, 'title'),
    location: optionalText(PRACTICE_LOCATION_MAX, 'location'),
    notes: optionalText(PRACTICE_NOTES_MAX, 'notes'),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field must be provided',
  });

/** GET /practices. */
export const practiceQuerySchema = z
  .object({
    teamId: z.uuid('Invalid team ID format').optional(),
    status: z.enum(PracticeStatus).optional(),
    from: z.iso.datetime({ offset: true, message: 'from must be an ISO 8601 date-time' }).optional(),
    to: z.iso.datetime({ offset: true, message: 'to must be an ISO 8601 date-time' }).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    message: 'from must not be after to',
    path: ['to'],
  });

/** PUT /practices/:id/availability. */
export const upsertAvailabilitySchema = z.object({
  status: z.enum(RsvpStatus, { error: 'Status must be YES, NO, or MAYBE' }),
  comment: optionalText(AVAILABILITY_COMMENT_MAX, 'comment'),
  /**
   * Answer for a child: allowed when the caller is a guardian of `playerId`
   * and the player is rostered on the session's team (same rule as game RSVP).
   */
  playerId: z.uuid('Invalid player ID format').optional(),
});

export type CreatePracticeInput = z.infer<typeof createPracticeSchema>;
export type UpdatePracticeInput = z.infer<typeof updatePracticeSchema>;
export type CancelPracticeInput = z.infer<typeof cancelPracticeSchema>;
export type CreatePracticeSeriesInput = z.infer<typeof createPracticeSeriesSchema>;
export type UpdatePracticeSeriesInput = z.infer<typeof updatePracticeSeriesSchema>;
export type PracticeQueryParams = z.infer<typeof practiceQuerySchema>;
export type UpsertAvailabilityInput = z.infer<typeof upsertAvailabilitySchema>;
