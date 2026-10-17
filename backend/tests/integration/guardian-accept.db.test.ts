/**
 * Guardian invitation races against a REAL Postgres (#664, #726, #727).
 *
 * #664: two parents of one child accepting at the same moment both counted 0
 * guardians under READ COMMITTED and both became `isPrimary`. The accept
 * transaction now takes `FOR UPDATE` on the child's `User` row first, so the
 * second accept counts the first one's link.
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
import { GuardianService } from '../../src/services/guardian-service';
import { BadRequestError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { DbFixtures, type Org } from '../support/db-fixtures';
import { backendPid, track, waitForBlockedBy } from '../support/db-locks';

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

    let accept: ReturnType<typeof track<Awaited<ReturnType<typeof GuardianService.acceptInvitation>>>> | undefined;
    await prisma.$transaction(async (holder) => {
      await holder.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${childId} FOR UPDATE`;
      accept = track(GuardianService.acceptInvitation(invitationIds[0], parentIds[0]));
      accept.promise.catch(() => undefined);

      const blocked = await waitForBlockedBy(holder, await backendPid(holder), {
        tables: ['GuardianInvitation', 'Guardian'],
      });
      expect(blocked).toHaveLength(1);
      // Blocked before its first write: no lock on the invitation or link tables yet.
      expect(blocked[0].relations).toEqual([]);
      expect(accept.settled()).toBe(false);
    });
    // The holder committed and released the lock: the accept now completes.
    await accept?.promise;

    const invitation = await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: invitationIds[0] } });
    expect(invitation.status).toBe('ACCEPTED');
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
