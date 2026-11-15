/**
 * PracticeService and PracticeSeriesService against the Prisma mock (#33).
 *
 * The access predicates are mocked here so each case states exactly which
 * gate it exercises; `tests/integration/practice-schedule.db.test.ts` runs the
 * real predicates and the real queries.
 */

import { Prisma } from '@prisma/client';
import { mockPrisma } from '../setup';
import { PracticeService, summarizeAvailability } from '../../src/services/practice-service';
import { PracticeSeriesService } from '../../src/services/practice-series-service';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../src/utils/errors';
import {
  canAccessTeam,
  hasTeamPermission,
  isGuardianOf,
  isSystemAdmin,
  readableTeamsWhere,
} from '../../src/utils/permissions';
import { domainEvent, spyOnInfo } from '../support/domain-events';

jest.mock('../../src/utils/permissions', () => ({
  canAccessTeam: jest.fn(),
  hasTeamPermission: jest.fn(),
  isGuardianOf: jest.fn(),
  isSystemAdmin: jest.fn(),
  readableTeamsWhere: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T): jest.MockedFunction<T> =>
  fn as jest.MockedFunction<T>;

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const CHILD = '1a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const TEAM = '2a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const SESSION = '3a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const SERIES = '4a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

const practiceRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SESSION,
  teamId: TEAM,
  seriesId: null,
  type: 'PRACTICE',
  title: null,
  location: 'Gym',
  notes: null,
  startsAt: new Date('2030-01-15T23:00:00Z'),
  durationMinutes: 90,
  timezone: 'America/New_York',
  status: 'SCHEDULED',
  isException: false,
  cancelledAt: null,
  cancelReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  team: { id: TEAM, name: 'Lakers' },
  series: null,
  ...overrides,
});

const availabilityRow = (userId: string, email: string | null): Record<string, unknown> => ({
  id: 'av',
  sessionId: SESSION,
  userId,
  status: 'YES',
  comment: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: { id: userId, name: 'Someone', isManaged: false, deletedAt: null, email },
});

const knownError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });

beforeEach(() => {
  mocked(canAccessTeam).mockResolvedValue(true);
  mocked(hasTeamPermission).mockResolvedValue(true);
  mocked(isGuardianOf).mockResolvedValue(false);
  mocked(isSystemAdmin).mockResolvedValue(false);
  mocked(readableTeamsWhere).mockResolvedValue({ OR: [{ staff: { some: { userId: USER } } }] });
});

describe('PracticeService.createPractice', () => {
  const input = {
    teamId: TEAM,
    type: 'PRACTICE' as const,
    title: undefined,
    location: 'Gym',
    notes: null,
    startsAt: '2030-01-15T18:00:00-05:00',
    durationMinutes: 90,
    timezone: 'America/New_York',
  };

  it('creates the session at the given instant and logs ids only', async () => {
    const spy = spyOnInfo();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    mockPrisma.practiceSession.create.mockResolvedValue(practiceRow());

    await PracticeService.createPractice(input, USER);

    expect(mockPrisma.practiceSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teamId: TEAM,
          title: null,
          location: 'Gym',
          startsAt: new Date('2030-01-15T23:00:00Z'),
          timezone: 'America/New_York',
        }),
      })
    );
    expect(mocked(hasTeamPermission)).toHaveBeenCalledWith(USER, TEAM, 'canManageTeam');
    expect(domainEvent(spy, 'Practice created')).toEqual({ practiceId: SESSION, teamId: TEAM, userId: USER });
  });

  it('404s an unknown team and 403s a caller without canManageTeam', async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);
    await expect(PracticeService.createPractice(input, USER)).rejects.toBeInstanceOf(NotFoundError);

    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    mocked(hasTeamPermission).mockResolvedValue(false);
    await expect(PracticeService.createPractice(input, USER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.practiceSession.create).not.toHaveBeenCalled();
  });
});

describe('PracticeService.getPractice', () => {
  it('returns the session with zero-filled availability counts', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue(practiceRow());
    mockPrisma.practiceAvailability.groupBy.mockResolvedValue([
      { status: 'YES', _count: { status: 3 } },
      { status: 'NO', _count: { status: 1 } },
    ]);

    const practice = await PracticeService.getPractice(SESSION, USER);
    expect(practice.availabilitySummary).toEqual({ yes: 3, no: 1, maybe: 0 });
    expect(mocked(canAccessTeam)).toHaveBeenCalledWith(USER, TEAM);
  });

  it('404s an unknown id and 403s a caller without team access', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue(null);
    await expect(PracticeService.getPractice(SESSION, USER)).rejects.toBeInstanceOf(NotFoundError);

    mockPrisma.practiceSession.findUnique.mockResolvedValue(practiceRow());
    mocked(canAccessTeam).mockResolvedValue(false);
    await expect(PracticeService.getPractice(SESSION, USER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('summarizeAvailability', () => {
  it('counts every status', async () => {
    mockPrisma.practiceAvailability.groupBy.mockResolvedValue([{ status: 'MAYBE', _count: { status: 2 } }]);
    expect(await summarizeAvailability(SESSION)).toEqual({ yes: 0, no: 0, maybe: 2 });
  });
});

describe('PracticeService.listPractices', () => {
  const page = { limit: 50, offset: 0 };

  beforeEach(() => {
    mockPrisma.practiceSession.count.mockResolvedValue(1);
    mockPrisma.practiceSession.findMany.mockResolvedValue([practiceRow()]);
  });

  it('scopes a non-admin to readableTeamsWhere and applies the window and status', async () => {
    const result = await PracticeService.listPractices(
      { ...page, status: 'SCHEDULED', from: '2030-01-01T00:00:00Z', to: '2030-02-01T00:00:00Z' },
      USER
    );
    expect(result).toEqual(expect.objectContaining({ total: 1, limit: 50, offset: 0 }));
    const where = mockPrisma.practiceSession.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: 'SCHEDULED',
      startsAt: { gte: new Date('2030-01-01T00:00:00Z'), lte: new Date('2030-02-01T00:00:00Z') },
      team: { OR: [{ staff: { some: { userId: USER } } }] },
    });
    expect(mockPrisma.practiceSession.findMany.mock.calls[0][0].orderBy).toEqual([{ startsAt: 'asc' }, { id: 'asc' }]);
  });

  it('checks canAccessTeam for a teamId filter and 403s without it', async () => {
    await PracticeService.listPractices({ ...page, teamId: TEAM, from: '2030-01-01T00:00:00Z' }, USER);
    expect(mockPrisma.practiceSession.findMany.mock.calls[0][0].where).toEqual({
      teamId: TEAM,
      startsAt: { gte: new Date('2030-01-01T00:00:00Z') },
    });

    mocked(canAccessTeam).mockResolvedValue(false);
    await expect(PracticeService.listPractices({ ...page, teamId: TEAM }, USER)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('leaves a system admin unscoped, with or without a teamId', async () => {
    mocked(isSystemAdmin).mockResolvedValue(true);
    await PracticeService.listPractices({ ...page, to: '2030-01-01T00:00:00Z' }, USER);
    expect(mockPrisma.practiceSession.findMany.mock.calls[0][0].where).toEqual({
      startsAt: { lte: new Date('2030-01-01T00:00:00Z') },
    });
    await PracticeService.listPractices({ ...page, teamId: TEAM }, USER);
    expect(mockPrisma.practiceSession.findMany.mock.calls[1][0].where).toEqual({ teamId: TEAM });
    expect(mocked(readableTeamsWhere)).not.toHaveBeenCalled();
  });
});

describe('PracticeService.updatePractice', () => {
  it('marks a series occurrence as an exception', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceSession.findUnique.mockResolvedValue({
      id: SESSION,
      teamId: TEAM,
      seriesId: SERIES,
      status: 'SCHEDULED',
    });
    mockPrisma.practiceSession.update.mockResolvedValue(practiceRow({ seriesId: SERIES, isException: true }));

    await PracticeService.updatePractice(
      SESSION,
      {
        type: 'OTHER',
        title: 'Scrimmage',
        location: 'Gym B',
        notes: null,
        startsAt: '2030-01-16T23:00:00Z',
        durationMinutes: 60,
        timezone: 'America/Chicago',
      },
      USER
    );

    expect(mockPrisma.practiceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SESSION, status: 'SCHEDULED' },
        data: {
          type: 'OTHER',
          title: 'Scrimmage',
          location: 'Gym B',
          notes: null,
          startsAt: new Date('2030-01-16T23:00:00Z'),
          durationMinutes: 60,
          timezone: 'America/Chicago',
          isException: true,
        },
      })
    );
    expect(domainEvent(spy, 'Practice updated')).toEqual({
      practiceId: SESSION,
      teamId: TEAM,
      seriesId: SERIES,
      userId: USER,
    });
  });

  it('does not mark a standalone session, and writes only the fields given', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' });
    mockPrisma.practiceSession.update.mockResolvedValue(practiceRow());
    await PracticeService.updatePractice(SESSION, { location: 'Gym C' }, USER);
    expect(mockPrisma.practiceSession.update.mock.calls[0][0].data).toEqual({ location: 'Gym C' });
  });

  it('refuses a cancelled session, a missing one and a non-manager', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: null, status: 'CANCELLED' });
    await expect(PracticeService.updatePractice(SESSION, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      BadRequestError
    );

    mockPrisma.practiceSession.findUnique.mockResolvedValue(null);
    await expect(PracticeService.updatePractice(SESSION, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      NotFoundError
    );

    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' });
    mocked(hasTeamPermission).mockResolvedValue(false);
    await expect(PracticeService.updatePractice(SESSION, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockPrisma.practiceSession.update).not.toHaveBeenCalled();
  });

  it('maps a row that vanished or was cancelled mid-request to 404, and rethrows anything else', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' });
    mockPrisma.practiceSession.update.mockRejectedValueOnce(knownError('P2025'));
    await expect(PracticeService.updatePractice(SESSION, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      NotFoundError
    );
    mockPrisma.practiceSession.update.mockRejectedValueOnce(new Error('db down'));
    await expect(PracticeService.updatePractice(SESSION, { title: 'x' }, USER)).rejects.toThrow('db down');
  });
});

describe('PracticeService.cancelPractice', () => {
  it('status-guards the write so a repeat keeps the first cancellation', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceSession.findUnique
      .mockResolvedValueOnce({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' })
      .mockResolvedValueOnce(practiceRow({ status: 'CANCELLED', cancelReason: 'Snow' }));
    mockPrisma.practiceSession.updateMany.mockResolvedValue({ count: 1 });

    const practice = await PracticeService.cancelPractice(SESSION, { reason: 'Snow' }, USER);

    expect(practice.status).toBe('CANCELLED');
    expect(mockPrisma.practiceSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), cancelReason: 'Snow' },
    });
    expect(domainEvent(spy, 'Practice cancelled')).toEqual({
      practiceId: SESSION,
      teamId: TEAM,
      seriesId: null,
      userId: USER,
    });
  });

  it('404s when the row is gone after the write', async () => {
    mockPrisma.practiceSession.findUnique
      .mockResolvedValueOnce({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' })
      .mockResolvedValueOnce(null);
    mockPrisma.practiceSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(PracticeService.cancelPractice(SESSION, {}, USER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('PracticeService.deletePractice', () => {
  it('deletes the session and logs it', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: SERIES, status: 'SCHEDULED' });
    mockPrisma.practiceSession.deleteMany.mockResolvedValue({ count: 1 });
    await PracticeService.deletePractice(SESSION, USER);
    expect(mockPrisma.practiceSession.deleteMany).toHaveBeenCalledWith({ where: { id: SESSION } });
    expect(domainEvent(spy, 'Practice deleted')).toEqual({
      practiceId: SESSION,
      teamId: TEAM,
      seriesId: SERIES,
      userId: USER,
    });
  });

  it('404s when a concurrent delete got there first', async () => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, seriesId: null, status: 'SCHEDULED' });
    mockPrisma.practiceSession.deleteMany.mockResolvedValue({ count: 0 });
    await expect(PracticeService.deletePractice(SESSION, USER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('PracticeService.upsertAvailability', () => {
  beforeEach(() => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, status: 'SCHEDULED' });
  });

  it('writes the caller’s own row and returns it with their email', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceAvailability.upsert.mockResolvedValue(availabilityRow(USER, 'me@example.test'));

    const row = await PracticeService.upsertAvailability(SESSION, USER, { status: 'YES', comment: 'Late' });

    expect(mockPrisma.practiceAvailability.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId_userId: { sessionId: SESSION, userId: USER } },
        create: { sessionId: SESSION, userId: USER, status: 'YES', comment: 'Late' },
        update: { status: 'YES', comment: 'Late' },
      })
    );
    expect(row.user.email).toBe('me@example.test');
    expect(domainEvent(spy, 'Practice availability upserted')).toEqual({
      practiceId: SESSION,
      teamId: TEAM,
      playerId: USER,
      status: 'YES',
      onBehalfOfChild: false,
      userId: USER,
    });
  });

  it('keeps an existing comment when none is sent', async () => {
    mockPrisma.practiceAvailability.upsert.mockResolvedValue(availabilityRow(USER, null));
    await PracticeService.upsertAvailability(SESSION, USER, { status: 'NO' });
    expect(mockPrisma.practiceAvailability.upsert.mock.calls[0][0].update).toEqual({ status: 'NO' });
  });

  it('lets a guardian answer for a rostered child, keyed on the child, without the child’s email', async () => {
    mocked(isGuardianOf).mockResolvedValue(true);
    mocked(hasTeamPermission).mockResolvedValue(false);
    mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'm' });
    mockPrisma.practiceAvailability.upsert.mockResolvedValue(availabilityRow(CHILD, 'kid@example.test'));

    const row = await PracticeService.upsertAvailability(SESSION, USER, { status: 'MAYBE', playerId: CHILD });

    expect(mockPrisma.practiceAvailability.upsert.mock.calls[0][0].where).toEqual({
      sessionId_userId: { sessionId: SESSION, userId: CHILD },
    });
    expect(row.user).not.toHaveProperty('email');
    expect(mocked(canAccessTeam)).not.toHaveBeenCalled();
  });

  it('refuses a non-guardian and a child who is not on the team', async () => {
    await expect(
      PracticeService.upsertAvailability(SESSION, USER, { status: 'YES', playerId: CHILD })
    ).rejects.toBeInstanceOf(ForbiddenError);

    mocked(isGuardianOf).mockResolvedValue(true);
    mockPrisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(
      PracticeService.upsertAvailability(SESSION, USER, { status: 'YES', playerId: CHILD })
    ).rejects.toThrow('This player is not on the team for this practice');
    expect(mockPrisma.practiceAvailability.upsert).not.toHaveBeenCalled();
  });

  it('refuses a caller without access, a missing session and a cancelled one', async () => {
    mocked(canAccessTeam).mockResolvedValue(false);
    await expect(PracticeService.upsertAvailability(SESSION, USER, { status: 'YES' })).rejects.toBeInstanceOf(
      ForbiddenError
    );

    mocked(canAccessTeam).mockResolvedValue(true);
    mockPrisma.practiceSession.findUnique.mockResolvedValue(null);
    await expect(PracticeService.upsertAvailability(SESSION, USER, { status: 'YES' })).rejects.toBeInstanceOf(
      NotFoundError
    );

    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM, status: 'CANCELLED' });
    await expect(PracticeService.upsertAvailability(SESSION, USER, { status: 'YES' })).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it('maps a session deleted mid-request (P2003) to 404 and rethrows anything else', async () => {
    mockPrisma.practiceAvailability.upsert.mockRejectedValueOnce(knownError('P2003'));
    await expect(PracticeService.upsertAvailability(SESSION, USER, { status: 'YES' })).rejects.toBeInstanceOf(
      NotFoundError
    );
    mockPrisma.practiceAvailability.upsert.mockRejectedValueOnce(knownError('P2002'));
    await expect(PracticeService.upsertAvailability(SESSION, USER, { status: 'YES' })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError
    );
  });
});

describe('PracticeService.getAvailability', () => {
  beforeEach(() => {
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION, teamId: TEAM });
    mockPrisma.practiceAvailability.findMany.mockResolvedValue([
      availabilityRow(USER, 'me@example.test'),
      availabilityRow(CHILD, 'other@example.test'),
    ]);
    mockPrisma.practiceAvailability.groupBy.mockResolvedValue([{ status: 'YES', _count: { status: 2 } }]);
  });

  it('shows other people’s email only to roster managers', async () => {
    mocked(hasTeamPermission).mockResolvedValue(false);
    const asPlayer = await PracticeService.getAvailability(SESSION, USER);
    expect(asPlayer.summary).toEqual({ yes: 2, no: 0, maybe: 0 });
    expect(asPlayer.availability[0].user.email).toBe('me@example.test');
    expect(asPlayer.availability[1].user).not.toHaveProperty('email');

    mocked(hasTeamPermission).mockResolvedValue(true);
    const asCoach = await PracticeService.getAvailability(SESSION, USER);
    expect(asCoach.availability[1].user.email).toBe('other@example.test');
  });

  it('404s an unknown session and 403s a caller without access', async () => {
    mocked(canAccessTeam).mockResolvedValue(false);
    await expect(PracticeService.getAvailability(SESSION, USER)).rejects.toBeInstanceOf(ForbiddenError);
    mockPrisma.practiceSession.findUnique.mockResolvedValue(null);
    await expect(PracticeService.getAvailability(SESSION, USER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

const seriesInput = {
  teamId: TEAM,
  type: 'PRACTICE' as const,
  title: 'Practice',
  location: 'Gym',
  notes: undefined,
  frequency: 'WEEKLY' as const,
  weekdays: [4, 2],
  startDate: '2026-10-20',
  startTime: '18:00',
  durationMinutes: 90,
  timezone: 'America/New_York',
  endDate: '2026-11-10',
};

const seriesRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SERIES,
  teamId: TEAM,
  cancelledAt: null,
  team: { id: TEAM, name: 'Lakers' },
  sessions: [{ id: SESSION }],
  ...overrides,
});

describe('PracticeSeriesService.createSeries', () => {
  it('writes the series and one session per occurrence in one transaction, at DST-correct instants', async () => {
    const spy = spyOnInfo();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    mockPrisma.practiceSeries.create.mockResolvedValue({ id: SERIES });
    mockPrisma.practiceSession.createMany.mockResolvedValue({ count: 7 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow({ sessions: new Array(7).fill({}) }));

    await PracticeSeriesService.createSeries(seriesInput, USER);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.practiceSeries.create.mock.calls[0][0].data).toEqual({
      teamId: TEAM,
      type: 'PRACTICE',
      title: 'Practice',
      location: 'Gym',
      notes: null,
      durationMinutes: 90,
      timezone: 'America/New_York',
      frequency: 'WEEKLY',
      weekdays: [2, 4],
      startDate: new Date('2026-10-20T00:00:00.000Z'),
      startTime: '18:00',
      endDate: new Date('2026-11-10T00:00:00.000Z'),
      occurrenceCount: null,
    });
    const sessions = mockPrisma.practiceSession.createMany.mock.calls[0][0].data as Array<{
      startsAt: Date;
      seriesId: string;
    }>;
    // Tue 20, Thu 22, Tue 27, Thu 29 (EDT), Tue 3, Thu 5, Tue 10 (EST).
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-20T22:00:00.000Z',
      '2026-10-22T22:00:00.000Z',
      '2026-10-27T22:00:00.000Z',
      '2026-10-29T22:00:00.000Z',
      '2026-11-03T23:00:00.000Z',
      '2026-11-05T23:00:00.000Z',
      '2026-11-10T23:00:00.000Z',
    ]);
    expect(sessions.every((s) => s.seriesId === SERIES)).toBe(true);
    expect(domainEvent(spy, 'Practice series created')).toEqual({
      seriesId: SERIES,
      teamId: TEAM,
      sessionCount: 7,
      userId: USER,
    });
  });

  it('stores a count rule without an endDate', async () => {
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    mockPrisma.practiceSeries.create.mockResolvedValue({ id: SERIES });
    mockPrisma.practiceSession.createMany.mockResolvedValue({ count: 3 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow());
    await PracticeSeriesService.createSeries({ ...seriesInput, endDate: undefined, occurrenceCount: 3 }, USER);
    expect(mockPrisma.practiceSeries.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ endDate: null, occurrenceCount: 3 })
    );
    expect(mockPrisma.practiceSession.createMany.mock.calls[0][0].data).toHaveLength(3);
  });

  it('refuses a rule with no occurrences or more than the cap, before any write', async () => {
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    await expect(
      PracticeSeriesService.createSeries({ ...seriesInput, weekdays: [1], startDate: '2026-10-20', endDate: '2026-10-25' }, USER)
    ).rejects.toThrow('no chosen weekday');
    await expect(
      PracticeSeriesService.createSeries(
        { ...seriesInput, weekdays: [0, 1, 2, 3, 4, 5, 6], endDate: '2027-10-20' },
        USER
      )
    ).rejects.toThrow('more than 100 practices');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s an unknown team and 403s a non-manager', async () => {
    mockPrisma.team.findUnique.mockResolvedValue(null);
    await expect(PracticeSeriesService.createSeries(seriesInput, USER)).rejects.toBeInstanceOf(NotFoundError);
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM });
    mocked(hasTeamPermission).mockResolvedValue(false);
    await expect(PracticeSeriesService.createSeries(seriesInput, USER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('PracticeSeriesService.getSeries', () => {
  it('returns the series to a reader, 403 to anyone else, 404 for an unknown id', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    expect((await PracticeSeriesService.getSeries(SERIES, USER)).id).toBe(SERIES);

    mocked(canAccessTeam).mockResolvedValue(false);
    await expect(PracticeSeriesService.getSeries(SERIES, USER)).rejects.toBeInstanceOf(ForbiddenError);

    mockPrisma.practiceSeries.findUnique.mockResolvedValue(null);
    await expect(PracticeSeriesService.getSeries(SERIES, USER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('PracticeSeriesService.updateSeries', () => {
  it('copies the edit onto future, scheduled, non-exception sessions only', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.practiceSession.updateMany.mockResolvedValue({ count: 5 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow());

    const result = await PracticeSeriesService.updateSeries(
      SERIES,
      { type: 'OTHER', title: 'Shootaround', location: 'Gym B', notes: null },
      USER
    );

    expect(result.updatedSessions).toBe(5);
    const fields = { type: 'OTHER', title: 'Shootaround', location: 'Gym B', notes: null };
    expect(mockPrisma.practiceSeries.updateMany).toHaveBeenCalledWith({
      where: { id: SERIES, cancelledAt: null },
      data: fields,
    });
    expect(mockPrisma.practiceSession.updateMany).toHaveBeenCalledWith({
      where: { seriesId: SERIES, isException: false, status: 'SCHEDULED', startsAt: { gt: expect.any(Date) } },
      data: fields,
    });
    expect(domainEvent(spy, 'Practice series updated')).toEqual({
      seriesId: SERIES,
      teamId: TEAM,
      updatedSessions: 5,
      userId: USER,
    });
  });

  it('refuses a cancelled series, before and inside the transaction', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow({ cancelledAt: new Date() }));
    await expect(PracticeSeriesService.updateSeries(SERIES, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      BadRequestError
    );

    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 0 });
    await expect(PracticeSeriesService.updateSeries(SERIES, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(mockPrisma.practiceSession.updateMany).not.toHaveBeenCalled();
  });

  it('404s an unknown series and 403s a non-manager', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(null);
    await expect(PracticeSeriesService.updateSeries(SERIES, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      NotFoundError
    );
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mocked(hasTeamPermission).mockResolvedValue(false);
    await expect(PracticeSeriesService.updateSeries(SERIES, { title: 'x' }, USER)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});

describe('PracticeSeriesService.cancelSeries', () => {
  it('stamps the series and deletes only sessions that have not started', async () => {
    const spy = spyOnInfo();
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.practiceSession.deleteMany.mockResolvedValue({ count: 4 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow({ cancelledAt: new Date() }));

    const result = await PracticeSeriesService.cancelSeries(SERIES, USER);

    expect(result.deletedSessions).toBe(4);
    expect(mockPrisma.practiceSession.deleteMany).toHaveBeenCalledWith({
      where: { seriesId: SERIES, startsAt: { gt: expect.any(Date) } },
    });
    expect(domainEvent(spy, 'Practice series cancelled')).toEqual({
      seriesId: SERIES,
      teamId: TEAM,
      deletedSessions: 4,
      userId: USER,
    });
  });

  it('is idempotent: a repeat deletes nothing', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow({ cancelledAt: new Date() }));
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow({ cancelledAt: new Date() }));
    const result = await PracticeSeriesService.cancelSeries(SERIES, USER);
    expect(result.deletedSessions).toBe(0);
    expect(mockPrisma.practiceSession.deleteMany).not.toHaveBeenCalled();
  });

  it('403s a non-manager', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mocked(hasTeamPermission).mockResolvedValue(false);
    await expect(PracticeSeriesService.cancelSeries(SERIES, USER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
