/**
 * Converting an under-13 account back into a managed roster record (#983),
 * against a REAL Postgres. `AccountService.convertToManaged` is what
 * `scripts/convert-to-managed.ts` runs; the runbook is
 * `docs/runbooks/data-subject-requests.md`, "We learned an account holder is
 * under 13".
 *
 * Proves the row-level outcome (no login, no email, managed by the coach,
 * roster and history untouched), the refusals that leave every row as it was
 * (adult accounts, no or ambiguous coach, a coach from another team), and that
 * the WorkOS user is deleted after commit, with a failure reported and not
 * thrown. Rows carry the run id and are removed in afterAll.
 */
jest.unmock('../../src/models');
import { Prisma } from '@prisma/client';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import { WorkOSService } from '../../src/services/workos-service';
import { ConflictError, NotFoundError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'convert');
const BUCKET = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';

let deleteUser: jest.SpyInstance;

/** A child who signed in and claimed the row a coach's Add Player created, rostered on `org`. */
async function claimedPlayer(key: string, org: Org, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await fx.user(key, 'PLAYER');
  await prisma.user.update({
    where: { id },
    data: { workosUserId: `workos-${key}-${fx.run}`, emailVerified: true, isManaged: false, ...extra },
  });
  await fx.member(id, org);
  return id;
}

const SNAPSHOT_SELECT = {
  workosUserId: true,
  email: true,
  emailVerified: true,
  isManaged: true,
  managedById: true,
  role: true,
  profilePictureUrl: true,
} satisfies Prisma.UserSelect;

type Snapshot = Prisma.UserGetPayload<{ select: typeof SNAPSHOT_SELECT }> | null;

async function snapshot(id: string): Promise<Snapshot> {
  return prisma.user.findUnique({ where: { id }, select: SNAPSHOT_SELECT });
}

beforeAll(async () => {
  await fx.requireDatabase();
});

beforeEach(() => {
  deleteUser = jest.spyOn(WorkOSService, 'deleteUser').mockResolvedValue(undefined);
});

afterEach(() => {
  deleteUser.mockRestore();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('AccountService.convertToManaged', () => {
  it('un-claims the row, hands it to the head coach and deletes the WorkOS user', async () => {
    const org = await fx.org('main');
    const head = await fx.user('head', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('kid', org, {
      role: 'COACH',
      profilePictureUrl: 'https://workoscdn.example.test/photo.jpg',
      emailSuppressedAt: new Date(),
      emailSuppressedReason: 'BOUNCE',
    });
    const game = await fx.game(org);
    await prisma.gameRsvp.create({ data: { gameId: game, userId: kid, status: 'YES' } });
    await prisma.pushToken.create({ data: { userId: kid, token: `ExponentPushToken[${fx.run}]`, platform: 'ios' } });
    await prisma.calendarFeedToken.create({ data: { userId: kid, teamId: org.teamId, token: `cal-${fx.run}` } });
    const invite = await prisma.teamInvitation.create({
      data: {
        teamId: org.teamId,
        playerId: kid,
        invitedById: head,
        token: `inv-${fx.run}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        recipientHash: 'abc123abc123',
      },
      select: { id: true },
    });

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result).toEqual({ success: true, managedById: head, identityDeleted: true });
    expect(deleteUser).toHaveBeenCalledWith(`workos-kid-${fx.run}`);
    expect(await snapshot(kid)).toEqual({
      workosUserId: null,
      email: null,
      emailVerified: false,
      isManaged: true,
      managedById: head,
      role: 'PLAYER',
      profilePictureUrl: null,
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: kid },
      select: { emailSuppressedAt: true, deletedAt: true, name: true },
    });
    expect(after).toEqual({ emailSuppressedAt: null, deletedAt: null, name: `kid-${fx.run}` });

    // Device and feed bindings go; the coach's view (roster, RSVP) stays.
    expect(await prisma.pushToken.count({ where: { userId: kid } })).toBe(0);
    expect(await prisma.calendarFeedToken.count({ where: { userId: kid } })).toBe(0);
    expect(await prisma.teamMember.count({ where: { playerId: kid, teamId: org.teamId } })).toBe(1);
    expect(await prisma.gameRsvp.count({ where: { userId: kid } })).toBe(1);
    expect(
      await prisma.teamInvitation.findUniqueOrThrow({
        where: { id: invite.id },
        select: { status: true, recipientHash: true },
      })
    ).toEqual({ status: 'CANCELLED', recipientHash: null });
  });

  it('uses the coach the operator names when they are on the player’s team, and keeps a photo the coach uploaded', async () => {
    const org = await fx.org('named');
    const head = await fx.user('namedHead', 'COACH');
    const assistant = await fx.user('namedAsst', 'COACH');
    await fx.staff(head, org);
    await fx.staff(assistant, org);
    const coachPhoto = `https://${BUCKET}.s3.amazonaws.com/avatars/${head}/photo.jpg`;
    const kid = await claimedPlayer('namedKid', org, { profilePictureUrl: coachPhoto });

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator', managedById: assistant });

    expect(result.managedById).toBe(assistant);
    expect(await snapshot(kid)).toMatchObject({ managedById: assistant, profilePictureUrl: coachPhoto });
  });

  it('reports a failed WorkOS deletion without undoing the conversion', async () => {
    const org = await fx.org('wfail');
    const head = await fx.user('wfailHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('wfailKid', org);
    deleteUser.mockRejectedValue(new Error('WorkOS down'));

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result.identityDeleted).toBe(false);
    expect(await snapshot(kid)).toMatchObject({ workosUserId: null, isManaged: true, managedById: head });
  });

  describe('refusals write nothing', () => {
    async function expectUntouched(id: string, before: Snapshot): Promise<void> {
      expect(await snapshot(id)).toEqual(before);
      expect(deleteUser).not.toHaveBeenCalled();
    }

    it('refuses an account with a staff role', async () => {
      const org = await fx.org('staffed');
      const other = await fx.org('staffedOther');
      const head = await fx.user('staffedHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('staffedKid', org);
      await fx.staff(kid, other);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(ConflictError);
      await expectUntouched(kid, before);
    });

    it('refuses a league admin', async () => {
      const org = await fx.org('admin');
      const head = await fx.user('adminHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('adminKid', org);
      await fx.leagueAdmin(kid, org);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(ConflictError);
      await expectUntouched(kid, before);
    });

    it('refuses a guardian of another player', async () => {
      const org = await fx.org('parent');
      const head = await fx.user('parentHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('parentKid', org);
      const sibling = await fx.user('parentSibling', 'PLAYER');
      await fx.guardian(kid, sibling);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(ConflictError);
      await expectUntouched(kid, before);
    });

    it('refuses a player on no team in an active season', async () => {
      const kid = await fx.user('loneKid', 'PLAYER');
      await prisma.user.update({ where: { id: kid }, data: { workosUserId: `workos-lone-${fx.run}` } });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(/no team/);
      await expectUntouched(kid, before);
    });

    it('refuses when two different head coaches could take the record', async () => {
      const a = await fx.org('twoA');
      const b = await fx.org('twoB');
      const headA = await fx.user('twoHeadA', 'COACH');
      const headB = await fx.user('twoHeadB', 'COACH');
      await fx.staff(headA, a);
      await fx.staff(headB, b);
      const kid = await claimedPlayer('twoKid', a);
      await fx.member(kid, b);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(/more than one/);
      await expectUntouched(kid, before);
    });

    it('refuses a named coach who is not on any of the player’s teams', async () => {
      const org = await fx.org('stranger');
      const elsewhere = await fx.org('strangerElse');
      const head = await fx.user('strangerHead', 'COACH');
      const stranger = await fx.user('strangerCoach', 'COACH');
      await fx.staff(head, org);
      await fx.staff(stranger, elsewhere);
      const kid = await claimedPlayer('strangerKid', org);
      const before = await snapshot(kid);

      await expect(
        AccountService.convertToManaged(kid, { actorId: 'operator', managedById: stranger })
      ).rejects.toThrow(/not on the staff/);
      await expectUntouched(kid, before);
    });

    it('refuses a row that is already a managed record, and a deleted or unknown account', async () => {
      const org = await fx.org('managed');
      const head = await fx.user('managedHead', 'COACH');
      await fx.staff(head, org);
      const kid = await fx.user('managedKid', 'PLAYER');
      await prisma.user.update({ where: { id: kid }, data: { isManaged: true, managedById: head } });
      await fx.member(kid, org);
      const tomb = await fx.user('tombKid', 'PLAYER');
      await prisma.user.update({ where: { id: tomb }, data: { deletedAt: new Date() } });

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toThrow(/already/);
      await expect(AccountService.convertToManaged(tomb, { actorId: 'operator' })).rejects.toThrow(NotFoundError);
      await expect(
        AccountService.convertToManaged('00000000-0000-4000-8000-000000000000', { actorId: 'operator' })
      ).rejects.toThrow(NotFoundError);
      expect(deleteUser).not.toHaveBeenCalled();
    });
  });
});
