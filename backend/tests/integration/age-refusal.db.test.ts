/**
 * The age screen's two writes (#981) against a REAL Postgres:
 * `AccountService.confirmAge` and `AccountService.refuseUnderage`.
 *
 * Proves what the under-age branch does with each kind of account: a sign-up
 * with no history is erased; a player who claimed a coach's roster record is
 * un-claimed back into a managed record (the head coach manages it, or nobody
 * when none qualifies) with no login, no email, no age confirmation; an adult
 * account (staff, teams) is deleted like a self-service deletion, or, for a
 * sole head coach, left gated for the operator with its session revoked; and
 * that the operator's conversion (#983) clears the age confirmation too.
 * Rows carry the run id and are removed in afterAll.
 */
jest.unmock('../../src/models');
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import * as uploadService from '../../src/services/upload-service';
import { WorkOSService } from '../../src/services/workos-service';
import { captureException } from '../../src/utils/sentry';
import { NotFoundError } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'agegate');

let deleteUser: jest.SpyInstance;
let revokeSession: jest.SpyInstance;
let revokeAllSessions: jest.SpyInstance;
let deleteAvatar: jest.SpyInstance;

/** A row that just signed in through WorkOS and has not answered the age question. */
async function signedIn(key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await fx.user(key, 'PLAYER');
  await prisma.user.update({
    where: { id },
    data: { workosUserId: `workos-${key}-${fx.run}`, emailVerified: true, isManaged: false, ageConfirmedAt: null, ...extra },
  });
  return id;
}

/** A child who signed in and claimed the record a coach's Add Player created, rostered on `org`. */
async function claimedPlayer(key: string, org: Org, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await signedIn(key, extra);
  await fx.member(id, org);
  return id;
}

const STATE_SELECT = {
  workosUserId: true,
  email: true,
  emailVerified: true,
  isManaged: true,
  managedById: true,
  ageConfirmedAt: true,
  ageRefusedAt: true,
  deletedAt: true,
  name: true,
} as const;

beforeAll(async () => {
  await fx.requireDatabase();
});

beforeEach(() => {
  jest.clearAllMocks();
  deleteUser = jest.spyOn(WorkOSService, 'deleteUser').mockResolvedValue(undefined);
  revokeSession = jest.spyOn(WorkOSService, 'revokeSession').mockResolvedValue(undefined);
  revokeAllSessions = jest.spyOn(WorkOSService, 'revokeAllSessions').mockResolvedValue({ revoked: 0, failed: 0 });
  deleteAvatar = jest.spyOn(uploadService, 'deleteAvatarObject').mockResolvedValue('deleted');
});

afterEach(() => {
  deleteUser.mockRestore();
  revokeSession.mockRestore();
  revokeAllSessions.mockRestore();
  deleteAvatar.mockRestore();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('AccountService.confirmAge', () => {
  it('stamps the row once and leaves a later call alone', async () => {
    const id = await signedIn('confirm');
    await AccountService.confirmAge(id);
    const first = await prisma.user.findUniqueOrThrow({ where: { id }, select: { ageConfirmedAt: true } });
    expect(first.ageConfirmedAt).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await AccountService.confirmAge(id);
    const second = await prisma.user.findUniqueOrThrow({ where: { id }, select: { ageConfirmedAt: true } });
    expect(second.ageConfirmedAt).toEqual(first.ageConfirmedAt);
  });

  it('refuses an unknown or deleted account with 401 and writes nothing', async () => {
    await expect(AccountService.confirmAge('00000000-0000-4000-a000-00000000dead')).rejects.toMatchObject({ statusCode: 401 });
    const id = await signedIn('confirmDeleted');
    await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), workosUserId: null, email: null } });
    await expect(AccountService.confirmAge(id)).rejects.toMatchObject({ statusCode: 401 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id }, select: { ageConfirmedAt: true } })).ageConfirmedAt).toBeNull();
  });
});

describe('AccountService.refuseUnderage', () => {
  it('erases a sign-up with no history and deletes its WorkOS user', async () => {
    const id = await signedIn('fresh');

    const result = await AccountService.refuseUnderage(id, { sessionId: 'sess_fresh' });

    expect(result).toEqual({ outcome: 'erased', identityDeleted: true });
    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
    expect(deleteUser).toHaveBeenCalledWith(`workos-fresh-${fx.run}`);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('un-claims a rostered player back to the head coach: no login, no email, no age confirmation, roster kept', async () => {
    const org = await fx.org('unclaim');
    const head = await fx.user('unclaimHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('unclaimKid', org, {
      profilePictureUrl: `https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/PLACEHOLDER/selfie.jpg`,
    });
    await prisma.user.update({
      where: { id: kid },
      data: { profilePictureUrl: `https://bball-tracker-avatars-dev.s3.amazonaws.com/avatars/${kid}/selfie.jpg` },
    });
    await prisma.pushToken.create({ data: { userId: kid, token: `ExponentPushToken[age-${fx.run}]`, platform: 'ios' } });

    const result = await AccountService.refuseUnderage(kid, { sessionId: 'sess_kid' });

    expect(result).toEqual({ outcome: 'unclaimed', identityDeleted: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toEqual({
      workosUserId: null,
      email: null,
      emailVerified: false,
      isManaged: true,
      managedById: head,
      ageConfirmedAt: null,
      ageRefusedAt: null,
      deletedAt: null,
      name: `unclaimKid-${fx.run}`,
    });
    expect(await prisma.teamMember.count({ where: { playerId: kid, teamId: org.teamId } })).toBe(1);
    expect(await prisma.pushToken.count({ where: { userId: kid } })).toBe(0);
    expect(deleteAvatar).toHaveBeenCalledWith(expect.stringContaining(`/avatars/${kid}/selfie.jpg`));
    expect(deleteUser).toHaveBeenCalledWith(`workos-unclaimKid-${fx.run}`);
  });

  it('un-claims to nobody when the player’s active teams have two head coaches (an ADMIN can still edit the record)', async () => {
    const org = await fx.org('twoHeads');
    const headA = await fx.user('twoHeadsA', 'COACH');
    const headB = await fx.user('twoHeadsB', 'COACH');
    await fx.staff(headA, org);
    await fx.staff(headB, org);
    const kid = await claimedPlayer('twoHeadsKid', org);

    const result = await AccountService.refuseUnderage(kid, {});

    expect(result.outcome).toBe('unclaimed');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toMatchObject({
      workosUserId: null,
      isManaged: true,
      managedById: null,
      ageConfirmedAt: null,
    });
    expect(await prisma.teamMember.count({ where: { playerId: kid } })).toBe(1);
  });

  it('un-claims to nobody when the player is rostered only in a past season', async () => {
    const org = await fx.org('pastSeason');
    await prisma.season.update({ where: { id: org.seasonId }, data: { isActive: false } });
    const head = await fx.user('pastSeasonHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('pastSeasonKid', org);

    const result = await AccountService.refuseUnderage(kid, {});

    expect(result.outcome).toBe('unclaimed');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toMatchObject({
      isManaged: true,
      managedById: null,
      workosUserId: null,
    });
  });

  it('deletes an adult account (an assistant coach with history) like a self-service deletion', async () => {
    const org = await fx.org('adult');
    const head = await fx.user('adultHead', 'COACH');
    await fx.staff(head, org);
    const assistantRole = await prisma.teamRole.create({
      data: {
        teamId: org.teamId,
        type: 'ASSISTANT_COACH',
        name: 'ASSISTANT_COACH',
        canManageTeam: false,
        canManageRoster: true,
        canTrackStats: true,
        canViewStats: true,
        canShareStats: true,
      },
      select: { id: true },
    });
    const adult = await signedIn('adultAssistant', { role: 'COACH' });
    await fx.staff(adult, org, assistantRole.id);
    await prisma.announcement.create({ data: { teamId: org.teamId, authorId: adult, title: `A-${fx.run}`, body: 'hi' } });

    const result = await AccountService.refuseUnderage(adult, { sessionId: 'sess_adult' });

    expect(result).toEqual({ outcome: 'deleted', identityDeleted: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: adult }, select: STATE_SELECT })).toMatchObject({
      workosUserId: null,
      email: null,
      ageConfirmedAt: null,
      deletedAt: expect.any(Date),
    });
    expect(await prisma.teamStaff.count({ where: { userId: adult } })).toBe(0);
    expect(deleteUser).toHaveBeenCalledWith(`workos-adultAssistant-${fx.run}`);
  });

  it('leaves a sole head coach gated for the operator, revokes the session, and alarms', async () => {
    const org = await fx.org('soleHead');
    const head = await signedIn('soleHead', { role: 'COACH' });
    await fx.staff(head, org);

    const result = await AccountService.refuseUnderage(head, { sessionId: 'sess_head' });

    expect(result).toEqual({ outcome: 'pending_operator', identityDeleted: false });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: head }, select: STATE_SELECT })).toMatchObject({
      workosUserId: `workos-soleHead-${fx.run}`,
      ageConfirmedAt: null,
      ageRefusedAt: expect.any(Date),
      deletedAt: null,
    });
    expect(await prisma.teamStaff.count({ where: { userId: head, teamId: org.teamId } })).toBe(1);
    expect(revokeSession).toHaveBeenCalledWith('sess_head');
    expect(deleteUser).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ flow: 'age-refusal', userId: head }));

    // The refusal is final: a second answer does nothing more, and confirming is refused.
    jest.clearAllMocks();
    expect(await AccountService.refuseUnderage(head, { sessionId: 'sess_head' })).toEqual({
      outcome: 'pending_operator',
      identityDeleted: false,
    });
    expect(revokeSession).not.toHaveBeenCalled();
    await expect(AccountService.confirmAge(head)).rejects.toMatchObject({ code: 'under_minimum_age', statusCode: 403 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: head }, select: STATE_SELECT })).ageConfirmedAt).toBeNull();

    // The operator's conversion is refused for an adult account, so the runbook hands the team
    // over and deletes; with no history left the row is erased, marker and all.
    const other = await fx.user('soleHeadSuccessor', 'COACH');
    await fx.staff(other, org);
    await prisma.teamStaff.deleteMany({ where: { userId: head, teamId: org.teamId } });
    const deleted = await AccountService.deleteAccount(head, { actorId: 'operator', mode: 'operator' });
    expect(deleted.erased).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: head } })).toBeNull();
  });

  it('keeps the record with no manager when the coach it would go to disappears before the lock', async () => {
    const org = await fx.org('coachGone');
    const head = await fx.user('coachGoneHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('coachGoneKid', org);
    // The coach is deleted between the unlocked read and the lock: simulate by
    // tombstoning the coach's row while the kid's refusal runs its first read.
    const original = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(async (fn: unknown, opts?: unknown) => {
      return original(async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, prop) {
            if (prop === '$queryRaw') {
              return async (...args: unknown[]) => {
                await prisma.user.update({ where: { id: head }, data: { deletedAt: new Date(), workosUserId: null, email: null } });
                return (target.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
              };
            }
            return Reflect.get(target, prop);
          },
        });
        return (fn as (t: typeof tx) => Promise<unknown>)(wrapped);
      }, opts as never);
    });
    try {
      const result = await AccountService.refuseUnderage(kid, {});
      expect(result.outcome).toBe('unclaimed');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toMatchObject({
      isManaged: true,
      managedById: null,
      workosUserId: null,
    });
  });

  it('handles a dev-login row (no WorkOS user) without touching the provider', async () => {
    const id = await fx.user('devRow', 'PLAYER');

    const result = await AccountService.refuseUnderage(id, {});

    expect(result).toEqual({ outcome: 'erased', identityDeleted: false });
    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or deleted account', async () => {
    await expect(AccountService.refuseUnderage('00000000-0000-4000-a000-00000000dead', {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('falls back to revoking every session when the WorkOS deletion fails after an un-claim', async () => {
    const org = await fx.org('wosFail');
    const head = await fx.user('wosFailHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('wosFailKid', org);
    deleteUser.mockRejectedValue(Object.assign(new Error('down'), { status: 500 }));
    revokeAllSessions.mockResolvedValue({ revoked: 2, failed: 0 });

    const result = await AccountService.refuseUnderage(kid, {});

    expect(result).toEqual({ outcome: 'unclaimed', identityDeleted: false });
    expect(revokeAllSessions).toHaveBeenCalledWith(`workos-wosFailKid-${fx.run}`);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toMatchObject({ isManaged: true, workosUserId: null });
  });
});

describe('the operator conversion (#983) and the age confirmation', () => {
  it('convertToManaged clears ageConfirmedAt and ageRefusedAt along with the login', async () => {
    const org = await fx.org('convert');
    const head = await fx.user('convertHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('convertKid', org, { ageConfirmedAt: new Date(), ageRefusedAt: new Date() });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: kid }, select: STATE_SELECT })).toMatchObject({
      isManaged: true,
      managedById: head,
      ageConfirmedAt: null,
      ageRefusedAt: null,
    });
  });

  it('account deletion clears ageConfirmedAt on the tombstone', async () => {
    const org = await fx.org('tombstone');
    const player = await claimedPlayer('tombstoneKid', org, { ageConfirmedAt: new Date() });

    await AccountService.deleteAccount(player, { actorId: player, mode: 'self' });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: player }, select: STATE_SELECT })).toMatchObject({
      deletedAt: expect.any(Date),
      ageConfirmedAt: null,
    });
  });
});
