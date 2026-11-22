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
 * the session's team; availability belongs to rostered players (a player for
 * themself, a guardian for a rostered child). Detail:
 * docs/architecture/practice-scheduling.md.
 */

import { Prisma, PracticeStatus, PracticeType } from '@prisma/client';
import prisma from '../models';
import {
  CancelPracticeInput,
  CreatePracticeInput,
  MAX_PRACTICE_FUTURE_DAYS,
  MAX_PRACTICE_PAST_DAYS,
  PracticeQueryParams,
  UpdatePracticeInput,
  UpsertAvailabilityInput,
} from '../api/practices/schemas';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  canAccessTeam,
  getGuardianChildIds,
  hasTeamPermission,
  isGuardianOf,
  isSystemAdmin,
  readableTeamsWhere,
} from '../utils/permissions';
import { isForeignKeyViolation } from '../utils/prisma-errors';
import { USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';
import {
  formatLocalDate,
  localDateOf,
  localTimeOf,
  parseLocalDate,
  parseLocalTime,
  zonedTimeToUtc,
} from '../utils/zoned-time';
import { logger } from '../utils/logger';
import { toRsvpSummary, toRsvpView, type EmailProjected, type RsvpSummary } from './rsvp-service';

/**
 * The fields a single-session edit can override on a series occurrence, and
 * so the names `PracticeSession.exceptionFields` holds.
 */
export const PRACTICE_EXCEPTION_FIELDS = [
  'type',
  'title',
  'location',
  'notes',
  'startsAt',
  'durationMinutes',
  'timezone',
] as const;

/** The series fields a session can inherit, as `updatePractice` reads them under the series lock. */
const SERIES_DEFAULT_FIELDS = ['type', 'title', 'location', 'notes'] as const;
type SeriesDefaults = {
  type: PracticeType;
  title: string | null;
  location: string | null;
  notes: string | null;
};

/** A session row as `updatePractice` reads it under its lock. */
type LockedSession = {
  status: PracticeStatus;
  exceptionFields: string[];
  type: PracticeType;
  title: string | null;
  location: string | null;
  notes: string | null;
  startsAt: Date;
  durationMinutes: number;
  timezone: string;
};

/**
 * The fields of `data` whose value differs from the stored row: only those
 * become overrides, so a client that sends the whole form after changing the
 * start time pins the start time, not the location.
 */
export function changedFields(
  stored: LockedSession,
  data: UpdatePracticeInput
): Array<(typeof PRACTICE_EXCEPTION_FIELDS)[number]> {
  return PRACTICE_EXCEPTION_FIELDS.filter((field) => {
    const next = data[field];
    if (next === undefined) return false;
    if (field === 'startsAt') return new Date(next as string).getTime() !== stored.startsAt.getTime();
    return next !== stored[field];
  });
}

/**
 * The edit with a local `startDate` + `startTime` turned into a `startsAt`
 * instant (#1051). The wall time is read in `timezone` when the request sends
 * one, else in the session's own stored zone (a series occurrence carries its
 * series' zone, a one-off the zone it was created with), so the device's zone
 * never enters the arithmetic. `zonedTimeToUtc` applies the series rule: a
 * time in a spring-forward gap moves forward by the jump, a repeated time
 * takes the earlier instant. A local time the stored start already reads in
 * the same zone keeps the stored instant, so a form that sends the start back
 * unchanged never moves it (not to the earlier copy of a repeated hour, nor
 * by the seconds the local form cannot carry). An edit without the local form
 * passes through.
 */
export function resolveLocalStart(
  data: UpdatePracticeInput,
  stored: { startsAt: Date; timezone: string }
): UpdatePracticeInput {
  const { startDate, startTime, ...rest } = data;
  if (startDate === undefined || startTime === undefined) return data;
  const zone = data.timezone ?? stored.timezone;
  if (
    zone === stored.timezone &&
    formatLocalDate(localDateOf(stored.startsAt, zone)) === startDate &&
    localTimeOf(stored.startsAt, zone) === startTime
  ) {
    return { ...rest, startsAt: stored.startsAt.toISOString() };
  }
  const { hour, minute } = parseLocalTime(startTime);
  return { ...rest, startsAt: zonedTimeToUtc(parseLocalDate(startDate), hour, minute, zone).toISOString() };
}

/** The team and series context every session payload carries. */
export const PRACTICE_INCLUDE = {
  team: { select: { id: true, name: true } },
  series: {
    select: { id: true, frequency: true, weekdays: true, startTime: true, cancelledAt: true },
  },
} satisfies Prisma.PracticeSessionInclude;

const AVAILABILITY_INCLUDE = {
  // `email` is stripped by `toAvailabilityView` for callers without canManageRoster.
  user: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
} satisfies Prisma.PracticeAvailabilityInclude;

/** What a write path needs to know about the session before it acts. */
const SESSION_WRITE_SELECT = {
  id: true,
  teamId: true,
  seriesId: true,
  status: true,
} satisfies Prisma.PracticeSessionSelect;

const DAY_MS = 86_400_000;

/**
 * 400 unless `startsAt` is within the single-practice window around now (a
 * mistyped year). `field` names what the client sent: `startDate` for the
 * local form of an edit.
 */
function assertPracticeStartInRange(startsAt: Date, field: 'startsAt' | 'startDate' = 'startsAt'): void {
  const now = Date.now();
  // One day of slack each way: the series bounds count local calendar days at
  // any start time, this check counts milliseconds from now.
  if (startsAt.getTime() < now - (MAX_PRACTICE_PAST_DAYS + 1) * DAY_MS) {
    throw new BadRequestError(`${field} must be within the last ${MAX_PRACTICE_PAST_DAYS} days`);
  }
  if (startsAt.getTime() > now + (MAX_PRACTICE_FUTURE_DAYS + 1) * DAY_MS) {
    throw new BadRequestError(`${field} must be within the next ${MAX_PRACTICE_FUTURE_DAYS} days`);
  }
}
type SessionForWrite = Prisma.PracticeSessionGetPayload<{ select: typeof SESSION_WRITE_SELECT }>;

/**
 * The answers that count for a session: those of players still on its team's
 * roster. A removed player's rows stay in the table (history) but leave the
 * list and the headcount.
 */
function countedAvailabilityWhere(sessionId: string, teamId: string): Prisma.PracticeAvailabilityWhereInput {
  return { sessionId, user: { teamMembers: { some: { teamId } } } };
}

export type PracticeView = Prisma.PracticeSessionGetPayload<{ include: typeof PRACTICE_INCLUDE }>;
type AvailabilityWithUser = Prisma.PracticeAvailabilityGetPayload<{
  include: typeof AVAILABILITY_INCLUDE;
}>;
/**
 * An availability row. `user.email` only for roster managers and the row's own
 * user; the free-text `comment` (it can say where a child is) only for roster
 * managers, the row's own user and a guardian of that player, `null` for
 * everyone else.
 */
export type AvailabilityView = EmailProjected<AvailabilityWithUser>;

/** The projection above; shared by the read and the write path. */
export function toAvailabilityView(
  row: AvailabilityWithUser,
  callerId: string,
  canManageRoster: boolean,
  callerChildIds: readonly string[]
): AvailabilityView {
  const view = toRsvpView(row, callerId, canManageRoster);
  const mayReadComment = canManageRoster || row.userId === callerId || callerChildIds.includes(row.userId);
  return mayReadComment ? view : { ...view, comment: null };
}

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

/** Status counts for one session (current roster only), zero-filled. */
export async function summarizeAvailability(sessionId: string, teamId: string): Promise<RsvpSummary> {
  const counts = await prisma.practiceAvailability.groupBy({
    by: ['status'],
    where: countedAvailabilityWhere(sessionId, teamId),
    _count: { status: true },
  });
  return toRsvpSummary(counts.map((c) => ({ status: c.status, count: c._count.status })));
}

/** 403 unless the caller may manage `teamId` (create, edit, cancel, delete practices). */
export async function assertCanManagePractices(userId: string, teamId: string): Promise<void> {
  if (!(await hasTeamPermission(userId, teamId, 'canManageTeam'))) {
    throw new ForbiddenError('You do not have permission to manage practices for this team');
  }
}

/** The session's team, after a 404 for a missing id and a 403 for a non-manager. */
async function findSessionForWrite(sessionId: string, userId: string): Promise<SessionForWrite> {
  const session = await prisma.practiceSession.findUnique({
    where: { id: sessionId },
    select: SESSION_WRITE_SELECT,
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
    assertPracticeStartInRange(new Date(data.startsAt));

    let practice: PracticeView;
    try {
      practice = await prisma.practiceSession.create({
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
    } catch (err) {
      // The team was deleted between the check and the insert.
      if (isForeignKeyViolation(err)) {
        throw new NotFoundError('Team not found');
      }
      throw err;
    }

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
    // Sequential on purpose: a denied caller triggers no aggregate query.
    if (!(await canAccessTeam(userId, practice.teamId))) {
      throw new ForbiddenError('You do not have access to this practice');
    }
    return { ...practice, availabilitySummary: await summarizeAvailability(sessionId, practice.teamId) };
  }

  /**
   * GET /practices: sessions on every team the caller may read (or one team),
   * in ascending `startsAt` (no default `from`: an "upcoming" view passes
   * one). The access clause is `readableTeamsWhere`, never a copy.
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

    if (query.teamId) {
      // canAccessTeam already answers true for a system ADMIN.
      if (!(await canAccessTeam(userId, query.teamId))) {
        throw new ForbiddenError('You do not have access to this team');
      }
      where.teamId = query.teamId;
    } else if (!(await isSystemAdmin(userId))) {
      // Resolve the readable team ids first (as GameService.listGames does), so
      // the session queries filter on the indexed teamId, not a relation OR.
      const teams = await prisma.team.findMany({ where: await readableTeamsWhere(userId), select: { id: true } });
      if (teams.length === 0) {
        return { practices: [], total: 0, limit: query.limit, offset: query.offset };
      }
      where.teamId = { in: teams.map((team) => team.id) };
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
   * exception and records which fields it set (`exceptionFields`): a later
   * series-wide edit still reaches this session's other fields, never these.
   * A cancelled session, and any session of a cancelled series, is not
   * editable.
   *
   *   $transaction
   *     SELECT … FROM "PracticeSeries" FOR NO KEY UPDATE   (when in a series)
   *     SELECT … FROM "PracticeSession" FOR NO KEY UPDATE
   *     UPDATE, exceptionFields = locked ∪ edited
   *
   * Series first, then session: the order updateSeries and cancelSeries take,
   * so an edit and a series-wide write serialize instead of overwriting each
   * other's field list.
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
    const practice = await prisma.$transaction(async (tx) => {
      let seriesDefaults: SeriesDefaults | null = null;
      if (session.seriesId) {
        const series = await tx.$queryRaw<Array<SeriesDefaults & { cancelledAt: Date | null }>>`
          SELECT "cancelledAt", "type", "title", "location", "notes"
          FROM "PracticeSeries" WHERE "id" = ${session.seriesId} FOR NO KEY UPDATE`;
        if (series[0]?.cancelledAt) {
          throw new BadRequestError('This practice series was cancelled');
        }
        seriesDefaults = series[0] ?? null;
      }
      const rows = await tx.$queryRaw<Array<LockedSession>>`
        SELECT "status", "exceptionFields", "type", "title", "location", "notes", "startsAt",
               "durationMinutes", "timezone"
        FROM "PracticeSession" WHERE "id" = ${sessionId} FOR NO KEY UPDATE`;
      const locked = rows[0];
      if (!locked) {
        throw new NotFoundError('Practice not found');
      }
      if (locked.status === 'CANCELLED') {
        throw new BadRequestError('A cancelled practice cannot be edited');
      }

      // The local form is read in the zone of the row just locked.
      const edit = resolveLocalStart(data, locked);
      // Range-check startsAt only when it moves: a full-form save of an old
      // session sends its unchanged start back.
      const changed = changedFields(locked, edit);
      if (changed.includes('startsAt')) {
        assertPracticeStartInRange(new Date(edit.startsAt as string), data.startDate !== undefined ? 'startDate' : 'startsAt');
      }
      // A descriptive field set back to the series' own value follows the
      // series again; anything else edited stays overridden.
      const backToSeries = seriesDefaults
        ? SERIES_DEFAULT_FIELDS.filter((field) => edit[field] !== undefined && edit[field] === seriesDefaults[field])
        : [];
      const overrides = [...new Set([...locked.exceptionFields, ...changed])]
        .filter((field) => !(backToSeries as string[]).includes(field))
        .sort();
      return tx.practiceSession.update({
        where: { id: sessionId },
        data: {
          ...(edit.type !== undefined ? { type: edit.type } : {}),
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.location !== undefined ? { location: edit.location } : {}),
          ...(edit.notes !== undefined ? { notes: edit.notes } : {}),
          ...(edit.startsAt !== undefined ? { startsAt: new Date(edit.startsAt) } : {}),
          ...(edit.durationMinutes !== undefined ? { durationMinutes: edit.durationMinutes } : {}),
          ...(edit.timezone !== undefined ? { timezone: edit.timezone } : {}),
          // A save that changed nothing leaves the occurrence following its series.
          ...(session.seriesId ? { isException: overrides.length > 0, exceptionFields: overrides } : {}),
        },
        include: PRACTICE_INCLUDE,
      });
    });

    logger.info('Practice updated', {
      practiceId: sessionId,
      teamId: session.teamId,
      seriesId: session.seriesId,
      userId,
    });
    return practice;
  }

  /** POST /practices/:id/cancel: marks one session CANCELLED. Idempotent. */
  static async cancelPractice(
    sessionId: string,
    data: CancelPracticeInput,
    userId: string
  ): Promise<PracticeView> {
    const session = await findSessionForWrite(sessionId, userId);

    // Status-guarded so a repeat keeps the first cancellation's time and reason.
    const { count } = await prisma.practiceSession.updateMany({
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

    // A repeat changes nothing and logs nothing.
    if (count > 0) {
      logger.info('Practice cancelled', {
        practiceId: sessionId,
        teamId: session.teamId,
        seriesId: session.seriesId,
        userId,
      });
    }
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
   * PUT /practices/:id/availability. A player rostered on the team answers for
   * themself; a guardian answers for a rostered child, and the row is keyed on
   * the child (the game-RSVP rule, `RsvpService.upsertRsvp`). Unlike game
   * RSVPs, only roster members can have an answer: the summary is the coach's
   * headcount, so a coach or a guardian answering for themself would inflate
   * it (403).
   */
  static async upsertAvailability(
    sessionId: string,
    userId: string,
    data: UpsertAvailabilityInput
  ): Promise<AvailabilityView> {
    const session = await prisma.practiceSession.findUnique({
      where: { id: sessionId },
      select: SESSION_WRITE_SELECT,
    });
    if (!session) {
      throw new NotFoundError('Practice not found');
    }

    const playerId = data.playerId;
    const onBehalfOfChild = playerId !== undefined && playerId !== userId;
    const subjectId = onBehalfOfChild ? playerId : userId;
    const [isGuardian, member, canManageRoster] = await Promise.all([
      onBehalfOfChild ? isGuardianOf(userId, playerId) : Promise.resolve(true),
      prisma.teamMember.findUnique({
        where: { teamId_playerId: { teamId: session.teamId, playerId: subjectId } },
        select: { id: true },
      }),
      // Only the guardian path projects the row (the caller's own row is theirs).
      onBehalfOfChild ? hasTeamPermission(userId, session.teamId, 'canManageRoster') : Promise.resolve(true),
    ]);
    if (!isGuardian) {
      throw new ForbiddenError('You can only answer for players you are a guardian of');
    }
    if (!member) {
      throw new ForbiddenError(
        onBehalfOfChild
          ? 'This player is not on the team for this practice'
          : 'Only players on the roster answer availability; a guardian answers for their child'
      );
    }

    if (session.status === 'CANCELLED') {
      throw new BadRequestError('This practice was cancelled');
    }

    let row: AvailabilityWithUser;
    try {
      row = await prisma.$transaction(async (tx) => {
        // FOR SHARE: a cancel (an UPDATE) or a delete waits for this answer to
        // commit, or this waits for them and then sees the new state, so an
        // answer never lands on a session that was cancelled under it.
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "PracticeSession" WHERE "id" = ${sessionId} FOR SHARE`;
        if (!locked[0]) {
          throw new NotFoundError('Practice not found');
        }
        if (locked[0].status === 'CANCELLED') {
          throw new BadRequestError('This practice was cancelled');
        }
        // FOR KEY SHARE on the player too: account deletion locks the User row
        // FOR UPDATE and purges answers, so it either waits for this write (and
        // purges it) or has tombstoned the row, which is refused here. KEY
        // SHARE is enough for that and does not block ordinary profile edits.
        const player = await tx.$queryRaw<Array<{ deletedAt: Date | null }>>`
          SELECT "deletedAt" FROM "User" WHERE "id" = ${subjectId} FOR KEY SHARE`;
        if (!player[0] || player[0].deletedAt) {
          throw new NotFoundError('Player not found');
        }
        // And the membership, so a concurrent removePlayer (which purges future
        // answers with the membership) cannot be undone by this write.
        const stillMember = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "TeamMember" WHERE "teamId" = ${session.teamId} AND "playerId" = ${subjectId} FOR KEY SHARE`;
        if (!stillMember[0]) {
          throw new ForbiddenError('This player is not on the team for this practice');
        }
        // No `include`: a plain upsert compiles to INSERT … ON CONFLICT, so two
        // first answers at once (a double tap, a guardian and the player) both
        // land instead of one failing on the unique key. No P2002 retry.
        const written = await tx.practiceAvailability.upsert({
          where: { sessionId_userId: { sessionId, userId: subjectId } },
          create: { sessionId, userId: subjectId, status: data.status, comment: data.comment ?? null },
          update: {
            status: data.status,
            ...(data.comment !== undefined ? { comment: data.comment } : {}),
          },
          select: { id: true },
        });
        // Same transaction: the answer that committed is the one returned.
        return tx.practiceAvailability.findUniqueOrThrow({
          where: { id: written.id },
          include: AVAILABILITY_INCLUDE,
        });
      });
    } catch (err) {
      // Both parent rows are locked above; kept as a last guard.
      if (isForeignKeyViolation(err)) {
        throw new NotFoundError('Player not found');
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

    // The caller's own row, or their child's: the comment is theirs to see.
    return toAvailabilityView(row, userId, canManageRoster, [subjectId]);
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

    const [rows, canManageRoster] = await Promise.all([
      prisma.practiceAvailability.findMany({
        where: countedAvailabilityWhere(sessionId, session.teamId),
        include: AVAILABILITY_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      hasTeamPermission(userId, session.teamId, 'canManageRoster'),
    ]);
    // A roster manager already sees every comment; only others need their children.
    const childIds = canManageRoster ? [] : await getGuardianChildIds(userId);

    return {
      availability: rows.map((row) => toAvailabilityView(row, userId, canManageRoster, childIds)),
      // From the rows themselves, so the counts always match the list.
      summary: toRsvpSummary(rows.map((row) => ({ status: row.status, count: 1 }))),
    };
  }
}
