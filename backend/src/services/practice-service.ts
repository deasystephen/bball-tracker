/**
 * Practice sessions and per-session availability (#33).
 *
 * A session is one dated practice (or other non-game team event). It is
 * either standalone or one occurrence of a `PracticeSeries`
 * (`practice-series-service.ts` materializes those). Sessions never touch
 * `Game`: no score, stats, live room or game list sees them.
 *
 * Access: reads go through `canAccessTeam` / `readableTeamsWhere` (staff,
 * member, league admin, guardian of a member); writes need `canManageTeam` on
 * the session's team; availability follows the game-RSVP rule (any reader
 * answers for themself, a guardian for a rostered child). Detail:
 * docs/architecture/practice-scheduling.md.
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import {
  CancelPracticeInput,
  CreatePracticeInput,
  PracticeQueryParams,
  UpdatePracticeInput,
  UpsertAvailabilityInput,
} from '../api/practices/schemas';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  canAccessTeam,
  hasTeamPermission,
  isGuardianOf,
  isSystemAdmin,
  readableTeamsWhere,
} from '../utils/permissions';
import { isRecordNotFound } from '../utils/prisma-errors';
import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';
import { logger } from '../utils/logger';
import { toRsvpView, type EmailProjected, type RsvpSummary } from './rsvp-service';

/** The team and series context every session payload carries. */
export const PRACTICE_INCLUDE = {
  team: { select: { id: true, name: true } },
  series: {
    select: { id: true, frequency: true, weekdays: true, startTime: true, cancelledAt: true },
  },
} satisfies Prisma.PracticeSessionInclude;

const AVAILABILITY_INCLUDE = {
  // `email` is stripped by `toRsvpView` for callers without canManageRoster.
  user: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
} satisfies Prisma.PracticeAvailabilityInclude;

export type PracticeView = Prisma.PracticeSessionGetPayload<{ include: typeof PRACTICE_INCLUDE }>;
type AvailabilityWithUser = Prisma.PracticeAvailabilityGetPayload<{
  include: typeof AVAILABILITY_INCLUDE;
}>;
/** An availability row; `user.email` only for roster managers and the row's own user. */
export type AvailabilityView = EmailProjected<AvailabilityWithUser>;

export type PracticeDetail = PracticeView & { availabilitySummary: RsvpSummary };

export interface PracticeList {
  practices: PracticeView[];
  total: number;
  limit: number;
  offset: number;
}

export interface PracticeAvailabilityList {
  availability: AvailabilityView[];
  summary: RsvpSummary;
}

/** Status counts for one session, zero-filled. */
export async function summarizeAvailability(sessionId: string): Promise<RsvpSummary> {
  const counts = await prisma.practiceAvailability.groupBy({
    by: ['status'],
    where: { sessionId },
    _count: { status: true },
  });
  const summary: RsvpSummary = { yes: 0, no: 0, maybe: 0 };
  for (const count of counts) {
    summary[count.status.toLowerCase() as keyof RsvpSummary] = count._count.status;
  }
  return summary;
}

/** 403 unless the caller may manage `teamId` (create, edit, cancel, delete practices). */
export async function assertCanManagePractices(userId: string, teamId: string): Promise<void> {
  if (!(await hasTeamPermission(userId, teamId, 'canManageTeam'))) {
    throw new ForbiddenError('You do not have permission to manage practices for this team');
  }
}

/** The session's team, after a 404 for a missing id and a 403 for a non-manager. */
async function findSessionForWrite(
  sessionId: string,
  userId: string
): Promise<{ id: string; teamId: string; seriesId: string | null; status: string }> {
  const session = await prisma.practiceSession.findUnique({
    where: { id: sessionId },
    select: { id: true, teamId: true, seriesId: true, status: true },
  });
  if (!session) {
    throw new NotFoundError('Practice not found');
  }
  await assertCanManagePractices(userId, session.teamId);
  return session;
}

export class PracticeService {
  /** POST /practices: one standalone session. */
  static async createPractice(data: CreatePracticeInput, userId: string): Promise<PracticeView> {
    const team = await prisma.team.findUnique({ where: { id: data.teamId }, select: { id: true } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    await assertCanManagePractices(userId, data.teamId);

    const practice = await prisma.practiceSession.create({
      data: {
        teamId: data.teamId,
        type: data.type,
        title: data.title ?? null,
        location: data.location ?? null,
        notes: data.notes ?? null,
        startsAt: new Date(data.startsAt),
        durationMinutes: data.durationMinutes,
        timezone: data.timezone,
      },
      include: PRACTICE_INCLUDE,
    });

    logger.info('Practice created', { practiceId: practice.id, teamId: practice.teamId, userId });
    return practice;
  }

  /** GET /practices/:id: the session plus its availability counts. */
  static async getPractice(sessionId: string, userId: string): Promise<PracticeDetail> {
    const practice = await prisma.practiceSession.findUnique({
      where: { id: sessionId },
      include: PRACTICE_INCLUDE,
    });
    if (!practice) {
      throw new NotFoundError('Practice not found');
    }
    if (!(await canAccessTeam(userId, practice.teamId))) {
      throw new ForbiddenError('You do not have access to this practice');
    }
    return { ...practice, availabilitySummary: await summarizeAvailability(sessionId) };
  }

  /**
   * GET /practices: sessions on every team the caller may read (or one team),
   * soonest first. The access clause is `readableTeamsWhere`, never a copy.
   */
  static async listPractices(query: PracticeQueryParams, userId: string): Promise<PracticeList> {
    const where: Prisma.PracticeSessionWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.from || query.to) {
      where.startsAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (await isSystemAdmin(userId)) {
      if (query.teamId) where.teamId = query.teamId;
    } else if (query.teamId) {
      if (!(await canAccessTeam(userId, query.teamId))) {
        throw new ForbiddenError('You do not have access to this team');
      }
      where.teamId = query.teamId;
    } else {
      where.team = await readableTeamsWhere(userId);
    }

    const [total, practices] = await Promise.all([
      prisma.practiceSession.count({ where }),
      prisma.practiceSession.findMany({
        where,
        include: PRACTICE_INCLUDE,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
    ]);
    return { practices, total, limit: query.limit, offset: query.offset };
  }

  /**
   * PATCH /practices/:id. Editing one occurrence of a series marks it an
   * exception: the series keeps its other sessions, and a later series-wide
   * edit leaves this one alone. A cancelled session is not editable.
   */
  static async updatePractice(
    sessionId: string,
    data: UpdatePracticeInput,
    userId: string
  ): Promise<PracticeView> {
    const session = await findSessionForWrite(sessionId, userId);
    if (session.status === 'CANCELLED') {
      throw new BadRequestError('A cancelled practice cannot be edited');
    }

    try {
      const practice = await prisma.practiceSession.update({
        where: { id: sessionId, status: 'SCHEDULED' },
        data: {
          ...(data.type !== undefined ? { type: data.type } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.location !== undefined ? { location: data.location } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          ...(data.startsAt !== undefined ? { startsAt: new Date(data.startsAt) } : {}),
          ...(data.durationMinutes !== undefined ? { durationMinutes: data.durationMinutes } : {}),
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          ...(session.seriesId ? { isException: true } : {}),
        },
        include: PRACTICE_INCLUDE,
      });
      logger.info('Practice updated', {
        practiceId: sessionId,
        teamId: session.teamId,
        seriesId: session.seriesId,
        userId,
      });
      return practice;
    } catch (err) {
      // Deleted, or cancelled, between the read and the write.
      if (isRecordNotFound(err)) {
        throw new NotFoundError('Practice not found');
      }
      throw err;
    }
  }

  /** POST /practices/:id/cancel: marks one session CANCELLED. Idempotent. */
  static async cancelPractice(
    sessionId: string,
    data: CancelPracticeInput,
    userId: string
  ): Promise<PracticeView> {
    const session = await findSessionForWrite(sessionId, userId);

    // Status-guarded so a repeat keeps the first cancellation's time and reason.
    await prisma.practiceSession.updateMany({
      where: { id: sessionId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: data.reason ?? null },
    });
    const practice = await prisma.practiceSession.findUnique({
      where: { id: sessionId },
      include: PRACTICE_INCLUDE,
    });
    if (!practice) {
      throw new NotFoundError('Practice not found');
    }

    logger.info('Practice cancelled', {
      practiceId: sessionId,
      teamId: session.teamId,
      seriesId: session.seriesId,
      userId,
    });
    return practice;
  }

  /** DELETE /practices/:id: removes one session and its availability rows. */
  static async deletePractice(sessionId: string, userId: string): Promise<void> {
    const session = await findSessionForWrite(sessionId, userId);
    const { count } = await prisma.practiceSession.deleteMany({ where: { id: sessionId } });
    if (count === 0) {
      throw new NotFoundError('Practice not found');
    }
    logger.info('Practice deleted', {
      practiceId: sessionId,
      teamId: session.teamId,
      seriesId: session.seriesId,
      userId,
    });
  }

  /**
   * PUT /practices/:id/availability. Any reader of the team answers for
   * themself; a guardian answers for a child rostered on the team, and the row
   * is keyed on the child (the game-RSVP rule, `RsvpService.upsertRsvp`).
   */
  static async upsertAvailability(
    sessionId: string,
    userId: string,
    data: UpsertAvailabilityInput
  ): Promise<AvailabilityView> {
    const session = await prisma.practiceSession.findUnique({
      where: { id: sessionId },
      select: { id: true, teamId: true, status: true },
    });
    if (!session) {
      throw new NotFoundError('Practice not found');
    }

    const playerId = data.playerId;
    const onBehalfOfChild = playerId !== undefined && playerId !== userId;
    if (onBehalfOfChild) {
      const [isGuardian, member] = await Promise.all([
        isGuardianOf(userId, playerId),
        prisma.teamMember.findUnique({
          where: { teamId_playerId: { teamId: session.teamId, playerId } },
          select: { id: true },
        }),
      ]);
      if (!isGuardian) {
        throw new ForbiddenError('You can only answer for players you are a guardian of');
      }
      if (!member) {
        throw new ForbiddenError('This player is not on the team for this practice');
      }
    } else if (!(await canAccessTeam(userId, session.teamId))) {
      throw new ForbiddenError('You do not have access to this practice');
    }

    if (session.status === 'CANCELLED') {
      throw new BadRequestError('This practice was cancelled');
    }

    const subjectId = onBehalfOfChild ? playerId : userId;
    let row: AvailabilityWithUser;
    try {
      row = await prisma.practiceAvailability.upsert({
        where: { sessionId_userId: { sessionId, userId: subjectId } },
        create: { sessionId, userId: subjectId, status: data.status, comment: data.comment ?? null },
        update: {
          status: data.status,
          ...(data.comment !== undefined ? { comment: data.comment } : {}),
        },
        include: AVAILABILITY_INCLUDE,
      });
    } catch (err) {
      // The session was deleted (series cancel, coach delete) after the read.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new NotFoundError('Practice not found');
      }
      throw err;
    }

    logger.info('Practice availability upserted', {
      practiceId: sessionId,
      teamId: session.teamId,
      playerId: subjectId,
      status: data.status,
      onBehalfOfChild,
      userId,
    });

    if (!onBehalfOfChild) {
      return row;
    }
    const canManageRoster = await hasTeamPermission(userId, session.teamId, 'canManageRoster');
    return toRsvpView(row, userId, canManageRoster);
  }

  /** GET /practices/:id/availability: every response plus the counts. */
  static async getAvailability(sessionId: string, userId: string): Promise<PracticeAvailabilityList> {
    const session = await prisma.practiceSession.findUnique({
      where: { id: sessionId },
      select: { id: true, teamId: true },
    });
    if (!session) {
      throw new NotFoundError('Practice not found');
    }
    if (!(await canAccessTeam(userId, session.teamId))) {
      throw new ForbiddenError('You do not have access to this practice');
    }

    const [rows, summary, canManageRoster] = await Promise.all([
      prisma.practiceAvailability.findMany({
        where: { sessionId },
        include: AVAILABILITY_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      summarizeAvailability(sessionId),
      hasTeamPermission(userId, session.teamId, 'canManageRoster'),
    ]);

    return {
      availability: rows.map((row) => toRsvpView(row, userId, canManageRoster)),
      summary,
    };
  }
}
