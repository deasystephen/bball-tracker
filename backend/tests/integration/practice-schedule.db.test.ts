/**
 * REAL DATABASE test: practice scheduling (#33) end to end through the
 * services, the real access predicates and Postgres.
 *
 *   orgA  coach (HEAD_COACH, every flag), player, kid (+ parent, a guardian)
 *   orgB  statsCoach (staff, canManageTeam = false)
 *   outsider, no affiliation
 *
 * The series runs every Tuesday at 18:00 America/New_York for 52 weeks,
 * starting four weeks ago: a year always crosses both DST changes, and "now"
 * (the clock is not faked) falls inside it, so some sessions are history and
 * the rest are future whatever day the suite runs.
 * The cases run in order, each building on the last.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { DbFixtures } from '../support/db-fixtures';
import { PracticeService } from '../../src/services/practice-service';
import { PracticeSeriesService } from '../../src/services/practice-series-service';
import { CalendarService } from '../../src/services/calendar-service';
import { AccountService } from '../../src/services/account-service';
import { TeamService } from '../../src/services/team-service';
import { ForbiddenError } from '../../src/utils/errors';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'Practice');
const { users, orgs } = fx;

/** The wall-clock "HH:MM" of `d` in New York. */
const newYorkTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

const DAY_MS = 86_400_000;
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const START_DATE = isoDate(Date.now() - 28 * DAY_MS);
const END_DATE = isoDate(Date.now() + (364 - 28) * DAY_MS);

let seriesId: string;
let sessionCount: number;
let pastSessionId: string;
let futureSessionIds: string[];

beforeAll(async () => {
  await fx.requireDatabase();
  const a = await fx.org('A');
  const b = await fx.org('B', { roleType: 'ASSISTANT_COACH', roleFlags: { canManageTeam: false } });

  await fx.staff(await fx.user('coach', 'COACH'), a);
  await fx.member(await fx.user('player', 'PLAYER'), a);
  await fx.member(await fx.user('kid', 'PLAYER'), a);
  await fx.guardian(await fx.user('parent', 'PARENT'), users.kid);
  await fx.staff(await fx.user('statsCoach', 'COACH'), b);
  await fx.user('outsider', 'COACH');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('practice scheduling (real Postgres)', () => {
  it('materializes the series in one go, 18:00 local on both sides of each DST change', async () => {
    const series = await PracticeSeriesService.createSeries(
      {
        teamId: orgs.A.teamId,
        type: 'PRACTICE',
        title: undefined,
        location: 'Main gym',
        notes: undefined,
        frequency: 'WEEKLY',
        weekdays: [2],
        startDate: START_DATE,
        startTime: '18:00',
        durationMinutes: 90,
        timezone: 'America/New_York',
        endDate: END_DATE,
      },
      users.coach
    );
    seriesId = series.id;

    // 365 days hold 52 Tuesdays, or 53.
    sessionCount = series.sessions.length;
    expect([52, 53]).toContain(sessionCount);
    // The wall clock holds; the UTC hour is 22 under EDT and 23 under EST.
    expect(new Set(series.sessions.map((s) => newYorkTime(s.startsAt)))).toEqual(new Set(['18:00']));
    expect(new Set(series.sessions.map((s) => s.startsAt.getUTCHours()))).toEqual(new Set([22, 23]));
    // The date columns round-trip as calendar dates.
    expect(series.startDate).toBe(START_DATE);
    expect(series.endDate).toBe(END_DATE);

    const now = Date.now();
    const past = series.sessions.filter((s) => s.startsAt.getTime() <= now);
    const future = series.sessions.filter((s) => s.startsAt.getTime() > now);
    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(2);
    pastSessionId = past[0].id;
    futureSessionIds = future.map((s) => s.id);
  });

  it('lets a FREE assistant coach (staff with canManageTeam on the head coach’s team) create', async () => {
    const assistantRole = await prisma.teamRole.create({
      data: { teamId: orgs.A.teamId, type: 'ASSISTANT_COACH', name: 'ASSISTANT_COACH', canManageTeam: true, canManageRoster: true },
      select: { id: true },
    });
    await fx.staff(await fx.user('assistant', 'COACH'), orgs.A, assistantRole.id);
    const practice = await PracticeService.createPractice(
      {
        teamId: orgs.A.teamId,
        type: 'OTHER',
        title: 'Team meeting',
        startsAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
        durationMinutes: 30,
        timezone: 'America/New_York',
      },
      users.assistant
    );
    expect(practice.teamId).toBe(orgs.A.teamId);
    await PracticeService.deletePractice(practice.id, users.assistant);
  });

  it('refuses practice writes to staff without canManageTeam and to outsiders', async () => {
    const input = {
      teamId: orgs.B.teamId,
      type: 'PRACTICE' as const,
      startsAt: '2030-01-15T23:00:00Z',
      durationMinutes: 60,
      timezone: 'UTC',
    };
    await expect(PracticeService.createPractice(input, users.statsCoach)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      PracticeService.updatePractice(futureSessionIds[0], { title: 'x' }, users.player)
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(PracticeSeriesService.cancelSeries(seriesId, users.parent)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets members and guardians read through canAccessTeam / readableTeamsWhere, and nobody else', async () => {
    const page = { limit: 200, offset: 0 };
    for (const reader of ['coach', 'player', 'parent']) {
      const list = await PracticeService.listPractices(page, users[reader]);
      expect(list.total).toBe(sessionCount);
    }
    expect((await PracticeService.listPractices(page, users.outsider)).total).toBe(0);
    expect((await PracticeService.listPractices(page, users.statsCoach)).total).toBe(0);
    await expect(
      PracticeService.listPractices({ ...page, teamId: orgs.A.teamId }, users.outsider)
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(PracticeService.getPractice(futureSessionIds[0], users.outsider)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect((await PracticeSeriesService.getSeries(seriesId, users.parent)).id).toBe(seriesId);
  });

  it('records availability per session, a guardian answering for the child', async () => {
    await PracticeService.upsertAvailability(futureSessionIds[0], users.player, { status: 'YES' });
    const forKid = await PracticeService.upsertAvailability(futureSessionIds[0], users.parent, {
      status: 'NO',
      comment: 'Dentist',
      playerId: users.kid,
    });
    expect(forKid.userId).toBe(users.kid);
    expect(forKid.user).not.toHaveProperty('email');
    // Two first answers at once (a double tap) both land: the upsert is a
    // native INSERT … ON CONFLICT, so neither fails on the unique key.
    await Promise.all(
      [1, 2, 3, 4].map(() => PracticeService.upsertAvailability(futureSessionIds[3], users.player, { status: 'YES' }))
    );
    expect(await prisma.practiceAvailability.count({ where: { sessionId: futureSessionIds[3] } })).toBe(1);

    // A repeat updates the same row.
    await PracticeService.upsertAvailability(futureSessionIds[0], users.player, { status: 'MAYBE' });
    await PracticeService.upsertAvailability(pastSessionId, users.player, { status: 'YES' });

    const result = await PracticeService.getAvailability(futureSessionIds[0], users.coach);
    expect(result.summary).toEqual({ yes: 0, no: 1, maybe: 1 });
    expect(result.availability.find((a) => a.userId === users.kid)?.user.email).toBe(
      `kid.${fx.run}@example.test`
    );
    // Teammates see the answer but neither the address nor the comment.
    const asTeammate = await PracticeService.getAvailability(futureSessionIds[0], users.player);
    const kidRow = asTeammate.availability.find((a) => a.userId === users.kid);
    expect(kidRow?.comment).toBeNull();
    expect(kidRow?.user).not.toHaveProperty('email');
    const asParent = await PracticeService.getAvailability(futureSessionIds[0], users.parent);
    expect(asParent.availability.find((a) => a.userId === users.kid)?.comment).toBe('Dentist');

    // Only roster members have an answer: the coach, and the parent without
    // playerId, would inflate the headcount.
    await expect(
      PracticeService.upsertAvailability(futureSessionIds[0], users.coach, { status: 'YES' })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      PracticeService.upsertAvailability(futureSessionIds[0], users.parent, { status: 'YES' })
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The parent is a guardian, but not of the player.
    await expect(
      PracticeService.upsertAvailability(futureSessionIds[0], users.parent, { status: 'YES', playerId: users.player })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('turns a single edit into an exception whose own fields a later series edit leaves alone', async () => {
    const moved = new Date(Date.now() + 60 * DAY_MS).toISOString();
    const exception = await PracticeService.updatePractice(
      futureSessionIds[1],
      { location: 'Gym B', startsAt: moved },
      users.coach
    );
    expect(exception.isException).toBe(true);
    expect(exception.exceptionFields).toEqual(['location', 'startsAt']);
    expect(exception.seriesId).toBe(seriesId);

    const { updatedSessions } = await PracticeSeriesService.updateSeries(
      seriesId,
      { location: 'New gym', notes: 'Bring water' },
      users.coach
    );
    expect(updatedSessions).toBe(futureSessionIds.length);

    const rows = await prisma.practiceSession.findMany({ where: { seriesId }, select: { id: true, location: true, notes: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The exception keeps its own location but takes the new notes.
    expect(byId.get(futureSessionIds[1])?.location).toBe('Gym B');
    expect(byId.get(futureSessionIds[1])?.notes).toBe('Bring water');
    expect(byId.get(futureSessionIds[0])?.location).toBe('New gym');
    expect(byId.get(pastSessionId)?.location).toBe('Main gym');
    expect(byId.get(pastSessionId)?.notes).toBeNull();
  });

  it('cancels one session without touching the series', async () => {
    const cancelled = await PracticeService.cancelPractice(futureSessionIds[2], { reason: 'Gym closed' }, users.coach);
    expect(cancelled.status).toBe('CANCELLED');
    const again = await PracticeService.cancelPractice(futureSessionIds[2], { reason: 'other' }, users.coach);
    expect(again.cancelReason).toBe('Gym closed');
    expect(again.cancelledAt).toEqual(cancelled.cancelledAt);
  });

  it('puts the practices in the team calendar feed', async () => {
    const ics = await CalendarService.buildFeed(orgs.A.teamId);
    expect((ics.match(/UID:practice-/g) ?? []).length).toBe(sessionCount);
    expect(ics).toContain('LOCATION:Gym B');
    expect(ics).toContain('Reason: Gym closed');
  });

  it('removing a player from the roster drops their future answers and keeps past ones', async () => {
    await PracticeService.upsertAvailability(pastSessionId, users.parent, { status: 'NO', playerId: users.kid });
    expect(await prisma.practiceAvailability.count({ where: { userId: users.kid } })).toBe(2);
    await TeamService.removePlayer(orgs.A.teamId, users.kid, users.coach);
    const left = await prisma.practiceAvailability.findMany({ where: { userId: users.kid }, select: { sessionId: true } });
    expect(left).toEqual([{ sessionId: pastSessionId }]);
    // Re-added later, the kid starts from no answer on the future session.
    await fx.member(users.kid, orgs.A);
    const after = await PracticeService.getAvailability(futureSessionIds[0], users.coach);
    expect(after.availability.some((a) => a.userId === users.kid)).toBe(false);
  });

  it('cancelling the series deletes the future sessions (and their answers) and keeps history', async () => {
    const { series, deletedSessions } = await PracticeSeriesService.cancelSeries(seriesId, users.coach);
    expect(deletedSessions).toBe(futureSessionIds.length);
    expect(series.cancelledAt).not.toBeNull();
    expect(series.sessions.every((s) => s.startsAt.getTime() <= Date.now())).toBe(true);
    expect(series.sessions.map((s) => s.id)).toContain(pastSessionId);

    expect(await prisma.practiceAvailability.count({ where: { sessionId: futureSessionIds[0] } })).toBe(0);
    // The player's and the kid's answers on the past session stay.
    expect(await prisma.practiceAvailability.count({ where: { sessionId: pastSessionId } })).toBe(2);

    const repeat = await PracticeSeriesService.cancelSeries(seriesId, users.coach);
    expect(repeat.deletedSessions).toBe(0);
    await expect(
      PracticeSeriesService.updateSeries(seriesId, { title: 'late edit' }, users.coach)
    ).rejects.toThrow('This practice series was cancelled');
    // History of a cancelled series cannot be moved back into the schedule.
    await expect(
      PracticeService.updatePractice(pastSessionId, { startsAt: new Date(Date.now() + DAY_MS).toISOString() }, users.coach)
    ).rejects.toThrow('This practice series was cancelled');
  });

  it('account deletion purges the person’s availability answers', async () => {
    expect(await prisma.practiceAvailability.count({ where: { userId: users.player } })).toBe(1);
    await AccountService.deleteAccount(users.player, { actorId: users.player, mode: 'self' });
    expect(await prisma.practiceAvailability.count({ where: { userId: users.player } })).toBe(0);
  });
});
