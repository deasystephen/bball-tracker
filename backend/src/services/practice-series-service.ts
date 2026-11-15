/**
 * Recurring practice series (#33).
 *
 *   createSeries   $transaction: INSERT series, INSERT one session per
 *                  occurrence (expandRecurrence, at most
 *                  MAX_SERIES_OCCURRENCES). Nothing is generated later: a
 *                  series always has an end, so no job has to extend it.
 *   updateSeries   $transaction: series fields, then the same fields on every
 *                  future SCHEDULED session that is not an exception.
 *   cancelSeries   $transaction: stamp cancelledAt, DELETE the future
 *                  sessions (their availability cascades). Sessions that
 *                  already started stay, still linked, as history.
 *
 * Writes need `canManageTeam` on the series' team; reads `canAccessTeam`.
 * Detail: docs/architecture/practice-scheduling.md.
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import {
  CreatePracticeSeriesInput,
  MAX_SERIES_OCCURRENCES,
  UpdatePracticeSeriesInput,
} from '../api/practices/schemas';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { canAccessTeam } from '../utils/permissions';
import { expandRecurrence } from '../utils/practice-recurrence';
import { logger } from '../utils/logger';
import { assertCanManagePractices } from './practice-service';

const SERIES_SESSION_SELECT = {
  id: true,
  startsAt: true,
  status: true,
  isException: true,
  type: true,
  title: true,
  location: true,
  durationMinutes: true,
  timezone: true,
} satisfies Prisma.PracticeSessionSelect;

export const PRACTICE_SERIES_INCLUDE = {
  team: { select: { id: true, name: true } },
  sessions: { select: SERIES_SESSION_SELECT, orderBy: { startsAt: 'asc' } },
} satisfies Prisma.PracticeSeriesInclude;

export type PracticeSeriesView = Prisma.PracticeSeriesGetPayload<{
  include: typeof PRACTICE_SERIES_INCLUDE;
}>;

export interface PracticeSeriesUpdate {
  series: PracticeSeriesView;
  /** Future, non-exception sessions the edit was copied onto. */
  updatedSessions: number;
}

export interface PracticeSeriesCancellation {
  series: PracticeSeriesView;
  /** Future sessions removed by this call (0 on a repeat). */
  deletedSessions: number;
}

/** "YYYY-MM-DD" -> the Date Prisma stores in a `@db.Date` column (UTC midnight). */
function dateColumn(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function findSeriesForWrite(
  seriesId: string,
  userId: string
): Promise<{ id: string; teamId: string; cancelledAt: Date | null }> {
  const series = await prisma.practiceSeries.findUnique({
    where: { id: seriesId },
    select: { id: true, teamId: true, cancelledAt: true },
  });
  if (!series) {
    throw new NotFoundError('Practice series not found');
  }
  await assertCanManagePractices(userId, series.teamId);
  return series;
}

export class PracticeSeriesService {
  /** POST /practice-series: the rule plus every session it produces, in one transaction. */
  static async createSeries(data: CreatePracticeSeriesInput, userId: string): Promise<PracticeSeriesView> {
    const team = await prisma.team.findUnique({ where: { id: data.teamId }, select: { id: true } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    await assertCanManagePractices(userId, data.teamId);

    const occurrences = expandRecurrence(data, MAX_SERIES_OCCURRENCES);
    if (occurrences.length === 0) {
      throw new BadRequestError('This schedule has no practices: no chosen weekday falls in the date range');
    }
    if (occurrences.length > MAX_SERIES_OCCURRENCES) {
      throw new BadRequestError(
        `This schedule would create more than ${MAX_SERIES_OCCURRENCES} practices; choose an earlier endDate or fewer weekdays`
      );
    }

    const shared = {
      teamId: data.teamId,
      type: data.type,
      title: data.title ?? null,
      location: data.location ?? null,
      notes: data.notes ?? null,
      durationMinutes: data.durationMinutes,
      timezone: data.timezone,
    };

    const series = await prisma.$transaction(async (tx) => {
      const created = await tx.practiceSeries.create({
        data: {
          ...shared,
          frequency: data.frequency,
          weekdays: [...data.weekdays].sort((a, b) => a - b),
          startDate: dateColumn(data.startDate),
          startTime: data.startTime,
          endDate: data.endDate ? dateColumn(data.endDate) : null,
          occurrenceCount: data.occurrenceCount ?? null,
        },
        select: { id: true },
      });
      await tx.practiceSession.createMany({
        data: occurrences.map((o) => ({ ...shared, seriesId: created.id, startsAt: o.startsAt })),
      });
      return tx.practiceSeries.findUniqueOrThrow({
        where: { id: created.id },
        include: PRACTICE_SERIES_INCLUDE,
      });
    });

    logger.info('Practice series created', {
      seriesId: series.id,
      teamId: series.teamId,
      sessionCount: series.sessions.length,
      userId,
    });
    return series;
  }

  /** GET /practice-series/:id: the rule and all of its sessions. */
  static async getSeries(seriesId: string, userId: string): Promise<PracticeSeriesView> {
    const series = await prisma.practiceSeries.findUnique({
      where: { id: seriesId },
      include: PRACTICE_SERIES_INCLUDE,
    });
    if (!series) {
      throw new NotFoundError('Practice series not found');
    }
    if (!(await canAccessTeam(userId, series.teamId))) {
      throw new ForbiddenError('You do not have access to this practice series');
    }
    return series;
  }

  /**
   * PATCH /practice-series/:id: "edit all future practices". Sessions that
   * already started, cancelled ones and exceptions keep their values.
   */
  static async updateSeries(
    seriesId: string,
    data: UpdatePracticeSeriesInput,
    userId: string
  ): Promise<PracticeSeriesUpdate> {
    const existing = await findSeriesForWrite(seriesId, userId);
    if (existing.cancelledAt) {
      throw new BadRequestError('This practice series was cancelled');
    }

    const fields = {
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.location !== undefined ? { location: data.location } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    };
    const now = new Date();

    const { series, updatedSessions } = await prisma.$transaction(async (tx) => {
      // Guarded on cancelledAt: a cancel that committed after the read above
      // wins, and this edit becomes a 400 rather than touching history.
      const { count } = await tx.practiceSeries.updateMany({
        where: { id: seriesId, cancelledAt: null },
        data: fields,
      });
      if (count === 0) {
        throw new BadRequestError('This practice series was cancelled');
      }
      const sessions = await tx.practiceSession.updateMany({
        where: { seriesId, isException: false, status: 'SCHEDULED', startsAt: { gt: now } },
        data: fields,
      });
      const updated = await tx.practiceSeries.findUniqueOrThrow({
        where: { id: seriesId },
        include: PRACTICE_SERIES_INCLUDE,
      });
      return { series: updated, updatedSessions: sessions.count };
    });

    logger.info('Practice series updated', {
      seriesId,
      teamId: existing.teamId,
      updatedSessions,
      userId,
    });
    return { series, updatedSessions };
  }

  /**
   * DELETE /practice-series/:id: cancels the series. Every session that has
   * not started yet is deleted, exceptions and cancelled ones included; the
   * ones that already started stay as history. Idempotent: a repeat deletes
   * nothing and answers the same series.
   */
  static async cancelSeries(seriesId: string, userId: string): Promise<PracticeSeriesCancellation> {
    const existing = await findSeriesForWrite(seriesId, userId);
    const now = new Date();

    const { series, deletedSessions } = await prisma.$transaction(async (tx) => {
      const { count } = await tx.practiceSeries.updateMany({
        where: { id: seriesId, cancelledAt: null },
        data: { cancelledAt: now },
      });
      const deleted =
        count === 0
          ? { count: 0 }
          : await tx.practiceSession.deleteMany({ where: { seriesId, startsAt: { gt: now } } });
      const updated = await tx.practiceSeries.findUniqueOrThrow({
        where: { id: seriesId },
        include: PRACTICE_SERIES_INCLUDE,
      });
      return { series: updated, deletedSessions: deleted.count };
    });

    logger.info('Practice series cancelled', {
      seriesId,
      teamId: existing.teamId,
      deletedSessions,
      userId,
    });
    return { series, deletedSessions };
  }
}
