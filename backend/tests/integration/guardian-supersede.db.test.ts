/**
 * Guardian Resend (supersede, #420) against a REAL Postgres.
 *
 * The mocked service suite cannot prove what matters here: that the expire and
 * the create commit together; that the resend holds the child row as accept
 * does, so an accept that commits first turns the resend into a 400; that two
 * resends serialise on that lock (the second answers the cooldown 429); that
 * the expire is scoped to the caller's team; and that an insert colliding on
 * `GuardianInvitation_pending_childId_invitedEmail_key` is recognised under
 * the name Prisma 7 reports (`meta.driverAdapterError.cause.constraint.index`),
 * so it answers the dedupe 400 instead of a 500.
 *
 * Every row is namespaced by the fixture run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../src/models';
import { GuardianService } from '../../src/services/guardian-service';
import { INVITATION_RESEND_COOLDOWN_MS } from '../../src/utils/resend-cooldown';
import { BadRequestError, ResendCooldownError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { classifyDbError } from '../../src/models/pool-config';
import { dbBusyOutcome } from '../../src/utils/db-busy';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { backendPid, pause, track, waitForBlockedBy } from '../support/db-locks';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'guardian-supersede');
let org: Org;
let coachId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function emailOf(userId: string): Promise<string> {
  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (!email) throw new Error('fixture user has no email');
  return email;
}

/** A rostered child, an adult, and one PENDING invitation for the pair created `ageMs` ago. */
async function childWithPending(
  key: string,
  ageMs: number
): Promise<{ childId: string; parentId: string; email: string; liveId: string }> {
  const childId = await fx.user(`${key}-child`, 'PLAYER');
  await fx.member(childId, org);
  const parentId = await fx.user(`${key}-parent`, 'PLAYER');
  const email = await emailOf(parentId);
  const live = await prisma.guardianInvitation.create({
    data: {
      token: randomBytes(32).toString('base64url'),
      childId,
      teamId: org.teamId,
      invitedEmail: email,
      relationship: 'MOTHER',
      invitedById: coachId,
      createdAt: new Date(Date.now() - ageMs),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      status: 'PENDING',
    },
    select: { id: true },
  });
  return { childId, parentId, email, liveId: live.id };
}

async function rowsFor(childId: string): Promise<{ id: string; status: string }[]> {
  return prisma.guardianInvitation.findMany({
    where: { childId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true },
  });
}

/**
 * Waits until a backend of this database sits in a lock wait on the
 * `GuardianInvitation` expire and returns how many do (0 on timeout).
 */
async function lockWaiters(tx: Prisma.TransactionClient, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // pg_stat_activity is snapshotted once per transaction; the holder polls
    // from inside one, so drop the snapshot before every read.
    await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE 'UPDATE "public"."GuardianInvitation"%'`;
    if (n >= 1 || Date.now() > deadline) {
      return n;
    }
    await pause(25);
  }
}

const PAST_COOLDOWN = INVITATION_RESEND_COOLDOWN_MS + 60_000;

beforeAll(async () => {
  await fx.requireDatabase();
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  org = await fx.org('team');
  coachId = await fx.user('coach', 'COACH');
  await fx.staff(coachId, org);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
  jest.restoreAllMocks();
});

describe('guardian resend (supersede, #420)', () => {
  it('expires the live invitation and creates the replacement, leaving exactly one PENDING row', async () => {
    const { childId, email, liveId } = await childWithPending('resend', PAST_COOLDOWN);

    const result = await GuardianService.inviteGuardian(
      org.teamId,
      childId,
      { email, relationship: 'MOTHER', supersede: true },
      coachId
    );

    expect(result.emailSent).toBe(true);
    expect(result.id).not.toBe(liveId);
    expect(await rowsFor(childId)).toEqual([
      { id: liveId, status: 'EXPIRED' },
      { id: result.id, status: 'PENDING' },
    ]);
  });

  it('without supersede, a live invitation still answers the dedupe 400', async () => {
    const { childId, email, liveId } = await childWithPending('plain', PAST_COOLDOWN);

    await expect(
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER' }, coachId)
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it('refuses a resend inside the cooldown and leaves the live row untouched', async () => {
    const { childId, email, liveId } = await childWithPending('cooldown', 30_000);

    await expect(
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER', supersede: true }, coachId)
    ).rejects.toBeInstanceOf(ResendCooldownError);
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it('two concurrent resends queue on the child lock: one sends, the other answers the cooldown 429', async () => {
    const { childId, email, liveId } = await childWithPending('double', PAST_COOLDOWN);
    const resend = (): Promise<unknown> =>
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'MOTHER', supersede: true }, coachId);

    const settled = await Promise.allSettled([resend(), resend()]);

    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ResendCooldownError);
    const rows = await rowsFor(childId);
    expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
    expect(rows.find((r) => r.id === liveId)?.status).toBe('EXPIRED');
  });

  it('a PENDING row committed under the resend answers the dedupe 400 from the partial index, never a 500', async () => {
    const { childId, email, liveId } = await childWithPending('index', PAST_COOLDOWN);

    // Hold the live invitation so the resend passes its reads and queues on
    // the expire. Meanwhile the holder expires it and commits a new PENDING
    // row for the same child + address (what a plain invite, which takes no
    // row locks, can do). The resend's expire then matches nothing it can see
    // and its insert collides on the partial index, under the index name
    // `createOrConflict` must recognise (Prisma 7 driver-adapter meta).
    let resend: ReturnType<typeof track<unknown>> | undefined;
    let intruderId: string | undefined;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "GuardianInvitation" WHERE "id" = ${liveId} FOR UPDATE`;
        resend = track(
          GuardianService.inviteGuardian(
            org.teamId,
            childId,
            { email, relationship: 'MOTHER', supersede: true },
            coachId
          )
        );
        resend.promise.catch(() => undefined);
        expect(await lockWaiters(holder)).toBeGreaterThanOrEqual(1);

        await holder.guardianInvitation.update({ where: { id: liveId }, data: { status: 'EXPIRED' } });
        const intruder = await holder.guardianInvitation.create({
          data: {
            token: randomBytes(32).toString('base64url'),
            childId,
            teamId: org.teamId,
            invitedEmail: email,
            relationship: 'MOTHER',
            invitedById: coachId,
            expiresAt: new Date(Date.now() + 7 * DAY_MS),
            status: 'PENDING',
          },
          select: { id: true },
        });
        intruderId = intruder.id;
      },
      { timeout: 10_000 }
    );

    const err = await resend!.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe('A pending guardian invitation already exists for this email');
    expect(await rowsFor(childId)).toEqual([
      { id: liveId, status: 'EXPIRED' },
      { id: intruderId, status: 'PENDING' },
    ]);
  });

  it("a resend stuck behind a lock holder is cancelled by PostgreSQL's lock_timeout and answers the retryable 503 (#908)", async () => {
    const { childId, email, liveId } = await childWithPending('lock-timeout', PAST_COOLDOWN);

    let err: unknown;
    let elapsedMs = 0;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${childId} FOR NO KEY UPDATE`;
        const startedAt = Date.now();
        // The holder stays open for the whole wait: the resend must give up on
        // its own, before Prisma's 5 s transaction timeout.
        err = await GuardianService.inviteGuardian(
          org.teamId,
          childId,
          { email, relationship: 'MOTHER', supersede: true },
          coachId
        ).catch((e: unknown) => e);
        elapsedMs = Date.now() - startedAt;
      },
      { timeout: 15_000 }
    );

    // The service lets the database error through; the error handlers map it.
    expect(classifyDbError(err)).toBe('lock_wait');
    expect(dbBusyOutcome(err)?.body).toMatchObject({ code: 'transaction_timeout' });
    expect(elapsedMs).toBeGreaterThanOrEqual(3500);
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it('waits on the child row lock, so an accept committing first makes the resend answer 400, not a second invitation', async () => {
    const { childId, parentId, email, liveId } = await childWithPending('accept', PAST_COOLDOWN);

    // The holder plays an accept: it holds the child row as accept's lockUsers
    // does, and once the resend is queued behind it, links the parent and
    // marks the invitation ACCEPTED, then commits.
    let resend: ReturnType<typeof track<unknown>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${childId} FOR NO KEY UPDATE`;
        resend = track(
          GuardianService.inviteGuardian(
            org.teamId,
            childId,
            { email, relationship: 'MOTHER', supersede: true },
            coachId
          )
        );
        resend.promise.catch(() => undefined);

        // Without the lock the resend would read "not linked" now and go on.
        const blocked = await waitForBlockedBy(holder, await backendPid(holder), {
          timeoutMs: 4000,
          settled: resend,
        });
        expect(blocked).toHaveLength(1);
        expect(resend.settled()).toBe(false);

        await holder.guardianInvitation.update({
          where: { id: liveId },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
        await holder.guardian.create({ data: { parentId, childId, relationship: 'MOTHER', isPrimary: true } });
      },
      { timeout: 10_000 }
    );

    const err = await resend!.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe('This person is already a guardian of this player');
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'ACCEPTED' }]);
  });

  it("a coach of another club (another lineage) cannot expire this club's live invitation; their resend answers the dedupe 400", async () => {
    const { childId, email, liveId } = await childWithPending('crossteam', PAST_COOLDOWN);
    const otherOrg = await fx.org('other');
    const otherCoachId = await fx.user('other-coach', 'COACH');
    await fx.staff(otherCoachId, otherOrg);
    await fx.member(childId, otherOrg);

    const err = await GuardianService.inviteGuardian(
      otherOrg.teamId,
      childId,
      { email, relationship: 'MOTHER', supersede: true },
      otherCoachId
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe('A pending guardian invitation already exists for this email');
    expect(await rowsFor(childId)).toEqual([{ id: liveId, status: 'PENDING' }]);
  });

  it("after a season rollover, the club's new team-season resends last season's pending invitation (lineage scope)", async () => {
    const { childId, email, liveId } = await childWithPending('rollover', PAST_COOLDOWN);
    const { lineageId } = await prisma.team.findUniqueOrThrow({ where: { id: org.teamId }, select: { lineageId: true } });
    // Rollover creates a new Team row with the same lineage in the next season
    // of the league (a Team row is a team-season; one per lineage per season).
    const nextSeason = await prisma.season.create({
      data: { leagueId: org.leagueId, name: `S-next-${fx.run}`, isActive: false },
      select: { id: true },
    });
    const next = await prisma.team.create({
      data: {
        name: `rollover-next-${fx.run}`,
        season: { connect: { id: nextSeason.id } },
        lineage: { connect: { id: lineageId } },
      },
      select: { id: true },
    });
    const role = await prisma.teamRole.create({
      data: {
        teamId: next.id,
        type: 'HEAD_COACH',
        name: 'Head Coach',
        canManageTeam: true,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      select: { id: true },
    });
    await prisma.teamStaff.create({ data: { teamId: next.id, userId: coachId, roleId: role.id } });
    await prisma.teamMember.create({ data: { teamId: next.id, playerId: childId } });

    // The list on the new team-season offers Resend for last season's row.
    const listed = await GuardianService.listGuardians(next.id, childId, coachId);
    expect(listed.pendingInvitations).toEqual([expect.objectContaining({ id: liveId, canResend: true })]);

    const result = await GuardianService.inviteGuardian(
      next.id,
      childId,
      { email, relationship: 'MOTHER', supersede: true },
      coachId
    );

    expect(await rowsFor(childId)).toEqual([
      { id: liveId, status: 'EXPIRED' },
      { id: result.id, status: 'PENDING' },
    ]);
  });

  it("another club's listing shows the row without Resend", async () => {
    const { childId } = await childWithPending('listing', PAST_COOLDOWN);
    const otherOrg = await fx.org('listing-other');
    const otherCoachId = await fx.user('listing-other-coach', 'COACH');
    await fx.staff(otherCoachId, otherOrg);
    await fx.member(childId, otherOrg);

    const listed = await GuardianService.listGuardians(otherOrg.teamId, childId, otherCoachId);

    expect(listed.pendingInvitations).toEqual([expect.objectContaining({ canResend: false })]);
  });

  it("expires a lapsed PENDING row on another team before inserting, as the plain invite's lazy expiry does", async () => {
    const childId = await fx.user('lapsed-child', 'PLAYER');
    await fx.member(childId, org);
    const email = await emailOf(await fx.user('lapsed-parent', 'PLAYER'));
    const lapsedOrg = await fx.org('lapsed-other');
    await fx.member(childId, lapsedOrg);
    const lapsed = await prisma.guardianInvitation.create({
      data: {
        token: randomBytes(32).toString('base64url'),
        childId,
        teamId: lapsedOrg.teamId,
        invitedEmail: email,
        relationship: 'MOTHER',
        invitedById: coachId,
        createdAt: new Date(Date.now() - 9 * DAY_MS),
        expiresAt: new Date(Date.now() - 2 * DAY_MS),
        status: 'PENDING',
      },
      select: { id: true },
    });

    const result = await GuardianService.inviteGuardian(
      org.teamId,
      childId,
      { email, relationship: 'MOTHER', supersede: true },
      coachId
    );

    expect(await rowsFor(childId)).toEqual([
      { id: lapsed.id, status: 'EXPIRED' },
      { id: result.id, status: 'PENDING' },
    ]);
  });

  it('a resend refused by the cooldown for an address with no account creates no account', async () => {
    const childId = await fx.user('noacct-child', 'PLAYER');
    await fx.member(childId, org);
    const email = `noacct.${fx.run}@example.test`;
    const recent = await prisma.guardianInvitation.create({
      data: {
        token: randomBytes(32).toString('base64url'),
        childId,
        teamId: org.teamId,
        invitedEmail: email,
        relationship: 'FATHER',
        invitedById: coachId,
        createdAt: new Date(Date.now() - 20_000),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        status: 'PENDING',
      },
      select: { id: true },
    });

    await expect(
      GuardianService.inviteGuardian(org.teamId, childId, { email, relationship: 'FATHER', supersede: true }, coachId)
    ).rejects.toBeInstanceOf(ResendCooldownError);

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await rowsFor(childId)).toEqual([{ id: recent.id, status: 'PENDING' }]);
  });

  it("a resend refused by another club's live invitation (dedupe) for an address with no account creates no account", async () => {
    const childId = await fx.user('noacct-dedupe-child', 'PLAYER');
    await fx.member(childId, org);
    const otherOrg = await fx.org('noacct-dedupe-other');
    await fx.member(childId, otherOrg);
    const email = `noacct-dedupe.${fx.run}@example.test`;
    const theirs = await prisma.guardianInvitation.create({
      data: {
        token: randomBytes(32).toString('base64url'),
        childId,
        teamId: otherOrg.teamId,
        invitedEmail: email,
        relationship: 'FATHER',
        invitedById: coachId,
        createdAt: new Date(Date.now() - PAST_COOLDOWN),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        status: 'PENDING',
      },
      select: { id: true },
    });

    const err = await GuardianService.inviteGuardian(
      org.teamId,
      childId,
      { email, relationship: 'FATHER', supersede: true },
      coachId
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toBe('A pending guardian invitation already exists for this email');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await rowsFor(childId)).toEqual([{ id: theirs.id, status: 'PENDING' }]);
  });
});
