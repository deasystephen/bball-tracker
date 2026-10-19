/**
 * Guardian invitation races against a REAL Postgres (#664, #726, #727).
 *
 * #664: two parents of one child accepting at the same moment both counted 0
 * guardians under READ COMMITTED and both became `isPrimary`. Every primacy
 * writer now locks the child's `User` row (`utils/user-row-lock.ts#lockUsers`):
 * accept (child and parent in one sorted statement), removeGuardian, and
 * account deletion (its own row plus its children, one sorted statement). So
 * a second accept counts the first one's link, a removal never promotes
 * nobody while an accept lands as non-primary, and two adults accepting to
 * guard each other wait instead of deadlocking.
 *
 * #726: reject flips the row only while it is still PENDING, so a reject that
 * loses to a concurrent accept answers 400 instead of overwriting ACCEPTED.
 *
 * #727: two invites for one child and address both pass the dedupe; the loser
 * hits the partial PENDING index and answers the dedupe's 400, never a P2002.
 *
 * Every row is named with the run id and removed in afterAll.
 */
jest.unmock('../../src/models');
import { randomBytes } from 'node:crypto';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import { GuardianService } from '../../src/services/guardian-service';
import { BadRequestError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { spyOnInfo } from '../support/domain-events';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { backendPid, track, waitForBlockedBy } from '../support/db-locks';
import { lockUsers } from '../../src/utils/user-row-lock';

jest.mock('../../src/services/mailer', () => ({
  mailer: { send: jest.fn().mockResolvedValue({ messageId: 'fake' }) },
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'guardian-accept');
let org: Org;
let coachId: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function emailOf(userId: string): Promise<string> {
  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (!email) throw new Error('fixture user has no email');
  return email;
}

/** Wait for each promise; the test fails on the first rejection with its real error. */
async function bothSucceed<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  return Promise.all([a, b]);
}

/**
 * Holds the child's row lock from the test, starts `call`, and proves from
 * Postgres's lock tables that it waits on that lock before its first write to
 * the guardian tables (`heldWhileWaiting` lists any table the waiting statement
 * itself reads); then releases it and lets the call finish. Deterministic,
 * unlike a race: without the lock under test the call never blocks and
 * `waitForBlockedBy` throws.
 */
async function expectWaitsOnChildLock(
  childId: string,
  call: () => Promise<unknown>,
  heldWhileWaiting: string[] = []
): Promise<void> {
  let started: ReturnType<typeof track<unknown>> | undefined;
  await prisma.$transaction(
    async (holder) => {
      await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${childId} FOR UPDATE`;
      started = track(call());
      started.promise.catch(() => undefined);

      const blocked = await waitForBlockedBy(holder, await backendPid(holder), {
        tables: ['GuardianInvitation', 'Guardian'],
        settled: started,
      });
      expect(blocked).toHaveLength(1);
      expect(blocked[0].relations).toEqual(heldWhileWaiting);
      expect(started.settled()).toBe(false);
    },
    // Above the helper's default deadline plus the holder's own work (db-locks.ts).
    { timeout: 10_000 }
  );
  // The holder committed and released the lock: the call now completes.
  await started?.promise;
}

/** A child on the roster plus `parents` adults, each holding a PENDING invitation for that child. */
async function childWithInvitations(
  key: string,
  parents: number
): Promise<{ childId: string; parentIds: string[]; invitationIds: string[] }> {
  const childId = await fx.user(`${key}-child`, 'PLAYER');
  await fx.member(childId, org);
  const parentIds: string[] = [];
  const invitationIds: string[] = [];
  for (let i = 0; i < parents; i++) {
    const parentId = await fx.user(`${key}-parent${i}`, 'PLAYER');
    const invitation = await prisma.guardianInvitation.create({
      data: {
        token: randomBytes(32).toString('base64url'),
        childId,
        teamId: org.teamId,
        invitedEmail: await emailOf(parentId),
        relationship: i === 0 ? 'MOTHER' : 'FATHER',
        invitedById: coachId,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        status: 'PENDING',
      },
      select: { id: true },
    });
    parentIds.push(parentId);
    invitationIds.push(invitation.id);
  }
  return { childId, parentIds, invitationIds };
}

beforeEach(() => {
  spyOnInfo();
});

beforeAll(async () => {
  await fx.requireDatabase();
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  org = await fx.org('team');
  coachId = await fx.user('coach', 'COACH');
  await fx.staff(coachId, org);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('concurrent guardian accepts for one child (#664)', () => {
  it('links both parents and makes exactly one of them primary', async () => {
    // Several children, so an unlocked count-then-insert would show up even
    // when one interleaving happens to serialise by luck.
    for (let round = 0; round < 5; round++) {
      const { childId, parentIds, invitationIds } = await childWithInvitations(`race${round}`, 2);

      const results = await Promise.all([
        GuardianService.acceptInvitation(invitationIds[0], parentIds[0]),
        GuardianService.acceptInvitation(invitationIds[1], parentIds[1]),
      ]);

      expect(results.map((r) => r.invitation.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
      const links = await prisma.guardian.findMany({ where: { childId }, select: { parentId: true, isPrimary: true } });
      expect(links).toHaveLength(2);
      expect(links.filter((l) => l.isPrimary)).toHaveLength(1);
    }
  });

  it('waits on the child row lock before it touches the invitation', async () => {
    const { childId, parentIds, invitationIds } = await childWithInvitations('lock', 1);

    await expectWaitsOnChildLock(childId, () => GuardianService.acceptInvitation(invitationIds[0], parentIds[0]));

    const invitation = await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: invitationIds[0] } });
    expect(invitation.status).toBe('ACCEPTED');
  });
});

describe('removal of the primary takes the child lock (#664)', () => {
  it('removeGuardian waits on the child row before it reads the link', async () => {
    const childId = await fx.user('rmlock-child', 'PLAYER');
    await fx.member(childId, org);
    const primaryId = await fx.user('rmlock-primary', 'PARENT');
    await fx.guardian(primaryId, childId);

    await expectWaitsOnChildLock(childId, () => GuardianService.removeGuardian(org.teamId, childId, primaryId, primaryId));

    expect(await prisma.guardian.count({ where: { childId } })).toBe(0);
  });

  it('account deletion of a guardian waits on each child row in its first statement', async () => {
    const childId = await fx.user('dellock-child', 'PLAYER');
    const primaryId = await fx.user('dellock-primary', 'PARENT');
    await fx.guardian(primaryId, childId);

    // Its lock statement reads Guardian (to find the children) while it waits:
    // an AccessShare lock, no write has happened yet.
    await expectWaitsOnChildLock(
      childId,
      () => AccountService.deleteAccount(primaryId, { actorId: primaryId, mode: 'self' }),
      ['Guardian']
    );

    expect(await prisma.guardian.count({ where: { childId } })).toBe(0);
  });
});

describe('accept racing a removal of the primary for one child (#664, end state)', () => {
  async function primariesAfter(race: (ctx: { childId: string; primaryId: string; parentIds: string[]; invitationIds: string[] }) => Promise<unknown>): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const ctx = await childWithInvitations(`rm${round}-${race.name}`, 1);
      const primaryId = await fx.user(`rm${round}-${race.name}-primary`, 'PARENT');
      await fx.guardian(primaryId, ctx.childId);

      await race({ ...ctx, primaryId });

      const links = await prisma.guardian.findMany({ where: { childId: ctx.childId }, select: { parentId: true, isPrimary: true } });
      expect(links).toEqual([{ parentId: ctx.parentIds[0], isPrimary: true }]);
    }
  }

  it('removeGuardian: the remaining (new) guardian ends up primary', async () => {
    await primariesAfter(async function remove({ childId, primaryId, parentIds, invitationIds }) {
      await bothSucceed(
        GuardianService.acceptInvitation(invitationIds[0], parentIds[0]),
        GuardianService.removeGuardian(org.teamId, childId, primaryId, primaryId)
      );
    });
  });

  it('account deletion of the primary: the remaining (new) guardian ends up primary', async () => {
    await primariesAfter(async function erase({ primaryId, parentIds, invitationIds }) {
      await bothSucceed(
        GuardianService.acceptInvitation(invitationIds[0], parentIds[0]),
        AccountService.deleteAccount(primaryId, { actorId: primaryId, mode: 'self' })
      );
    });
  });
});

describe('two adults accepting to guard each other (#664)', () => {
  it('both links land; the sorted lock statement never deadlocks', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await fx.user(`mutual${round}-a`, 'PLAYER');
      const b = await fx.user(`mutual${round}-b`, 'PLAYER');
      const invite = async (childId: string, adultId: string): Promise<string> =>
        (
          await prisma.guardianInvitation.create({
            data: {
              token: randomBytes(32).toString('base64url'),
              childId,
              teamId: org.teamId,
              invitedEmail: await emailOf(adultId),
              relationship: 'OTHER',
              invitedById: coachId,
              expiresAt: new Date(Date.now() + 7 * DAY_MS),
              status: 'PENDING',
            },
            select: { id: true },
          })
        ).id;
      const aGuardsB = await invite(b, a);
      const bGuardsA = await invite(a, b);

      await bothSucceed(GuardianService.acceptInvitation(aGuardsB, a), GuardianService.acceptInvitation(bGuardsA, b));

      expect(await prisma.guardian.count({ where: { OR: [{ parentId: a, childId: b }, { parentId: b, childId: a }] } })).toBe(2);
    }
  });
});

describe('the primacy lock strength (#664)', () => {
  it('does not block a foreign-key insert naming the child (FOR NO KEY UPDATE, not FOR UPDATE)', async () => {
    const childId = await fx.user('fk-child', 'PLAYER');
    const other = await fx.org('fk-team');

    await prisma.$transaction(async (holder) => {
      await lockUsers(holder, [childId]);
      // A roster insert takes FOR KEY SHARE on the child's row; it must not
      // wait for the holder (a live game's GameEvent inserts are the same).
      await prisma.teamMember.create({ data: { teamId: other.teamId, playerId: childId } });
    });

    expect(await prisma.teamMember.count({ where: { playerId: childId } })).toBe(1);
  });
});

describe('accept racing reject for one invitation (#726)', () => {
  it('lets exactly one win, and the invitation status agrees with the link', async () => {
    for (let round = 0; round < 5; round++) {
      const { childId, parentIds, invitationIds } = await childWithInvitations(`ar${round}`, 1);

      const [accepted, rejected] = await Promise.allSettled([
        GuardianService.acceptInvitation(invitationIds[0], parentIds[0]),
        GuardianService.rejectInvitation(invitationIds[0], parentIds[0]),
      ]);

      const outcomes = [accepted.status, rejected.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
      const loser = accepted.status === 'rejected' ? accepted : rejected;
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError);

      const invitation = await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: invitationIds[0] } });
      const links = await prisma.guardian.count({ where: { childId } });
      expect(invitation.status).toBe(accepted.status === 'fulfilled' ? 'ACCEPTED' : 'REJECTED');
      expect(links).toBe(invitation.status === 'ACCEPTED' ? 1 : 0);
    }
  });
});

describe('concurrent guardian invites for one child and address (#727)', () => {
  it('creates one PENDING row and answers the loser with the dedupe 400', async () => {
    const childId = await fx.user('invite-child', 'PLAYER');
    await fx.member(childId, org);
    const parentId = await fx.user('invite-parent', 'PLAYER');
    const input = { email: await emailOf(parentId), relationship: 'MOTHER' as const };

    const settled = await Promise.allSettled([
      GuardianService.inviteGuardian(org.teamId, childId, input, coachId),
      GuardianService.inviteGuardian(org.teamId, childId, input, coachId),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(BadRequestError);
    expect((failure?.reason as BadRequestError).message).toBe(
      'A pending guardian invitation already exists for this email'
    );
    const pending = await prisma.guardianInvitation.count({ where: { childId, status: 'PENDING' } });
    expect(pending).toBe(1);
  });
});
