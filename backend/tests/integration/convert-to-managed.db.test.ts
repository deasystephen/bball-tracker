/**
 * Converting an under-13 account back into a managed roster record (#983),
 * against a REAL Postgres. `AccountService.convertToManaged` is what
 * `scripts/convert-to-managed.ts` runs; the runbook is
 * `docs/runbooks/data-subject-requests.md`, "We learned an account holder is
 * under 13".
 *
 * Proves the row-level outcome (no login, no email, managed by the coach,
 * roster and history untouched; a photo kept only when the team's staff
 * uploaded it, any other photo in our bucket deleted from S3 unless another
 * row shows it; the child's address scrubbed from invitations that made it
 * someone's guardian and on every invitation for the child at the child's
 * own address (pending ones expired), while those at a parent's address and
 * the accepted guardian link stay; the child's announcement replies deleted),
 * an empty
 * personal league removed, the refusals that leave every row as it was (adult
 * signals, no or ambiguous coach, a coach from another team or a past season,
 * a re-run), and the WorkOS outcomes: deleted, no identity, or a failure
 * reported with the session fallback's counts. Rows carry the run id and are
 * removed in afterAll.
 */
jest.unmock('../../src/models');
import { Prisma } from '@prisma/client';
import prisma from '../../src/models';
import { AccountService } from '../../src/services/account-service';
import * as uploadService from '../../src/services/upload-service';
import { WorkOSService } from '../../src/services/workos-service';
import { logger } from '../../src/utils/logger';
import { ConvertRefusedError, NotFoundError, UnauthorizedError, type ConvertRefusalCode } from '../../src/utils/errors';
import { DbFixtures, type Org } from '../support/db-fixtures';

jest.setTimeout(30000);

const fx = new DbFixtures(prisma, 'convert');
const BUCKET = process.env.S3_AVATARS_BUCKET || 'bball-tracker-avatars-dev';

let deleteUser: jest.SpyInstance;
let revokeAllSessions: jest.SpyInstance;
let deleteAvatar: jest.SpyInstance;

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

/** A refusal with this stable code (the CLI keys its advice on it). */
function refusal(code: ConvertRefusalCode): ConvertRefusedError {
  return expect.objectContaining({ code, statusCode: 409 }) as ConvertRefusedError;
}

async function snapshot(id: string): Promise<Snapshot> {
  return prisma.user.findUnique({ where: { id }, select: SNAPSHOT_SELECT });
}

beforeAll(async () => {
  await fx.requireDatabase();
});

beforeEach(() => {
  deleteUser = jest.spyOn(WorkOSService, 'deleteUser').mockResolvedValue(undefined);
  revokeAllSessions = jest.spyOn(WorkOSService, 'revokeAllSessions').mockResolvedValue({ revoked: 0, failed: 0 });
  deleteAvatar = jest.spyOn(uploadService, 'deleteAvatarObject').mockResolvedValue('deleted');
});

afterEach(() => {
  deleteUser.mockRestore();
  revokeAllSessions.mockRestore();
  deleteAvatar.mockRestore();
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
      emailSuppressedAt: new Date(),
      emailSuppressedReason: 'BOUNCE',
    });
    const ownUpload = `https://${BUCKET}.s3.amazonaws.com/avatars/${kid}/selfie.jpg`;
    await prisma.user.update({ where: { id: kid }, data: { profilePictureUrl: ownUpload } });
    const kidEmail = `kid.${fx.run}@example.test`;
    const sibling = await fx.user('kidSibling', 'PLAYER');
    const expires = new Date(Date.now() + 86_400_000);
    // An invitation that named the child's address as a sibling's guardian
    // (D17 scrub); one inviting the child's parent (stays); a pending one for
    // the child at the child's own address (expired: accepting it would make a
    // PARENT account at the child's address); accepted and rejected ones there
    // (address scrubbed, status kept, the Guardian link survives).
    const toKidAddress = await prisma.guardianInvitation.create({
      data: { token: `gi-a-${fx.run}`, childId: sibling, invitedEmail: kidEmail, relationship: 'GUARDIAN', invitedById: head, expiresAt: expires },
      select: { id: true },
    });
    const toParent = await prisma.guardianInvitation.create({
      data: { token: `gi-b-${fx.run}`, childId: kid, invitedEmail: `kidparent.${fx.run}@example.test`, relationship: 'MOTHER', invitedById: head, expiresAt: expires },
      select: { id: true },
    });
    const sharedAddress = await prisma.guardianInvitation.create({
      data: { token: `gi-c-${fx.run}`, childId: kid, invitedEmail: kidEmail, relationship: 'FATHER', invitedById: head, expiresAt: expires },
      select: { id: true },
    });
    const acceptedAtKidAddress = await prisma.guardianInvitation.create({
      data: { token: `gi-d-${fx.run}`, childId: kid, invitedEmail: kidEmail, relationship: 'OTHER', invitedById: head, expiresAt: expires, status: 'ACCEPTED', acceptedAt: new Date() },
      select: { id: true },
    });
    const rejectedAtKidAddress = await prisma.guardianInvitation.create({
      data: { token: `gi-e-${fx.run}`, childId: kid, invitedEmail: kidEmail, relationship: 'OTHER', invitedById: head, expiresAt: expires, status: 'REJECTED' },
      select: { id: true },
    });
    const parent = await fx.user('kidParent', 'PARENT');
    await fx.guardian(parent, kid);
    // Free text: the child's reply goes, a teammate's reply and the coach's
    // announcement stay.
    const announcement = await prisma.announcement.create({
      data: { teamId: org.teamId, authorId: head, title: `T-${fx.run}`, body: 'Practice moved' },
      select: { id: true },
    });
    await prisma.announcementReply.create({ data: { announcementId: announcement.id, authorId: kid, body: 'ok!' } });
    await prisma.announcementReply.create({ data: { announcementId: announcement.id, authorId: parent, body: 'Thanks' } });
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

    expect(result).toEqual({
      success: true,
      managedById: head,
      identityDeleted: true,
      photoDeletion: 'deleted',
      expiredGuardianInvitations: expect.arrayContaining([
        { id: sharedAddress.id, childId: kid },
        { id: toKidAddress.id, childId: sibling },
      ]),
      deletedReplyCount: 1,
    });
    expect(result.expiredGuardianInvitations).toHaveLength(2);
    expect(deleteUser).toHaveBeenCalledWith(`workos-kid-${fx.run}`);
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(deleteAvatar).toHaveBeenCalledWith(ownUpload);
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
    expect(
      await prisma.guardianInvitation.findUniqueOrThrow({
        where: { id: toKidAddress.id },
        select: { status: true, invitedEmail: true },
      })
    ).toEqual({ status: 'EXPIRED', invitedEmail: `deleted-${toKidAddress.id}@invalid` });
    expect(
      await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: toParent.id }, select: { status: true } })
    ).toEqual({ status: 'PENDING' });
    expect(
      await prisma.guardianInvitation.findUniqueOrThrow({
        where: { id: sharedAddress.id },
        select: { status: true, invitedEmail: true },
      })
    ).toEqual({ status: 'EXPIRED', invitedEmail: `deleted-${sharedAddress.id}@invalid` });
    expect(
      await prisma.guardianInvitation.findUniqueOrThrow({
        where: { id: acceptedAtKidAddress.id },
        select: { status: true, invitedEmail: true },
      })
    ).toEqual({ status: 'ACCEPTED', invitedEmail: `deleted-${acceptedAtKidAddress.id}@invalid` });
    expect(
      await prisma.guardianInvitation.findUniqueOrThrow({
        where: { id: rejectedAtKidAddress.id },
        select: { status: true, invitedEmail: true },
      })
    ).toEqual({ status: 'REJECTED', invitedEmail: `deleted-${rejectedAtKidAddress.id}@invalid` });
    // Scrubbing the accepted invitation's address leaves the link it created.
    expect(await prisma.guardian.count({ where: { parentId: parent, childId: kid } })).toBe(1);
    expect(await prisma.announcementReply.count({ where: { authorId: kid } })).toBe(0);
    expect(await prisma.announcementReply.count({ where: { authorId: parent } })).toBe(1);
    expect(await prisma.announcement.count({ where: { id: announcement.id } })).toBe(1);
  });

  it('clears an external photo (it may be the identity provider’s copy of the child) without deleting any object', async () => {
    const org = await fx.org('external');
    const head = await fx.user('externalHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('externalKid', org, {
      profilePictureUrl: 'https://lh3.googleusercontent.example.test/a/child-photo',
    });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(await snapshot(kid)).toMatchObject({ isManaged: true, profilePictureUrl: null });
    expect(deleteAvatar).not.toHaveBeenCalled();
  });

  it('clears and deletes an upload by someone not on the player’s current staff (a parent, a past coach)', async () => {
    const org = await fx.org('foreignPhoto');
    const head = await fx.user('foreignPhotoHead', 'COACH');
    const outsider = await fx.user('foreignPhotoOutsider', 'PARENT');
    await fx.staff(head, org);
    const photo = `https://${BUCKET}.s3.amazonaws.com/avatars/${outsider}/photo.jpg`;
    const kid = await claimedPlayer('foreignPhotoKid', org, { profilePictureUrl: photo });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(await snapshot(kid)).toMatchObject({ profilePictureUrl: null });
    expect(deleteAvatar).toHaveBeenCalledWith(photo);
  });

  it('clears but keeps the object of a photo another user row still shows', async () => {
    const org = await fx.org('sharedPhoto');
    const head = await fx.user('sharedPhotoHead', 'COACH');
    const sibling = await fx.user('sharedPhotoSibling', 'PLAYER');
    await fx.staff(head, org);
    const photo = `https://${BUCKET}.s3.amazonaws.com/avatars/${sibling}/family.jpg`;
    await prisma.user.update({ where: { id: sibling }, data: { profilePictureUrl: photo } });
    const kid = await claimedPlayer('sharedPhotoKid', org, { profilePictureUrl: photo });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(await snapshot(kid)).toMatchObject({ profilePictureUrl: null });
    expect(deleteAvatar).not.toHaveBeenCalled();
  });

  it('does not treat a cancelled invitation the child once sent as an adult signal', async () => {
    const org = await fx.org('cancelled');
    const head = await fx.user('cancelledHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('cancelledKid', org);
    const invitee = await fx.user('cancelledInvitee', 'PLAYER');
    await prisma.teamInvitation.create({
      data: {
        teamId: org.teamId,
        playerId: invitee,
        invitedById: kid,
        token: `inv-cancelled-${fx.run}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        status: 'CANCELLED',
      },
    });

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result.managedById).toBe(head);
    expect(await snapshot(kid)).toMatchObject({ isManaged: true });
  });

  it('removes an empty personal league the child once created, with its admin row', async () => {
    const org = await fx.org('personal');
    const head = await fx.user('personalHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('personalKid', org);
    const leagueId = await fx.personalLeague('personalKidLeague', kid);
    await fx.leagueAdmin(kid, { leagueId });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(await prisma.league.count({ where: { id: leagueId } })).toBe(0);
    expect(await prisma.leagueAdmin.count({ where: { userId: kid } })).toBe(0);
    expect(await snapshot(kid)).toMatchObject({ isManaged: true, managedById: head });
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
    expect(deleteAvatar).not.toHaveBeenCalled();
    expect(await snapshot(kid)).toMatchObject({ managedById: assistant, profilePictureUrl: coachPhoto });
  });

  it('a sign-in that read the row before the conversion committed writes nothing back and is refused', async () => {
    const org = await fx.org('stale');
    const head = await fx.user('staleHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('staleKid', org);
    const workosId = `workos-staleKid-${fx.run}`;
    const kidEmail = `stalekid.${fx.run}@example.test`;
    const staleRead = await prisma.user.findUniqueOrThrow({ where: { id: kid } });

    await AccountService.convertToManaged(kid, { actorId: 'operator' });
    const after = await snapshot(kid);

    // The sync's branch-1 read ran before the commit and saw the linked row.
    const findUnique = jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(staleRead as never);
    try {
      await expect(
        WorkOSService.syncUser({
          id: workosId,
          email: kidEmail,
          emailVerified: true,
          profilePictureUrl: 'https://lh3.googleusercontent.example.test/a/child',
        })
      ).rejects.toThrow(UnauthorizedError);
    } finally {
      findUnique.mockRestore();
    }

    expect(await snapshot(kid)).toEqual(after);
    expect(await prisma.user.count({ where: { email: kidEmail } })).toBe(0);
  });

  it('counts a WorkOS 404 as already deleted (a Staging id after the cutover), with a note and no fallback', async () => {
    const org = await fx.org('gone404');
    const head = await fx.user('gone404Head', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('gone404Kid', org);
    deleteUser.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result).toMatchObject({ identityDeleted: true, identityNote: 'not_found_at_workos' });
    expect(result).not.toHaveProperty('workosUserId');
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('reports a failed S3 delete of the child’s photo after commit', async () => {
    const org = await fx.org('s3fail');
    const head = await fx.user('s3failHead', 'COACH');
    await fx.staff(head, org);
    const kid = await fx.user('s3failKid', 'PLAYER');
    const photo = `https://${BUCKET}.s3.amazonaws.com/avatars/${kid}/selfie.jpg`;
    await prisma.user.update({
      where: { id: kid },
      data: { workosUserId: `workos-s3failKid-${fx.run}`, profilePictureUrl: photo },
    });
    await fx.member(kid, org);
    deleteAvatar.mockResolvedValue('failed');

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result).toMatchObject({ photoDeletion: 'failed', identityDeleted: true });
    expect(await snapshot(kid)).toMatchObject({ profilePictureUrl: null, isManaged: true });
  });

  it('reports a failed WorkOS deletion and a partial session revocation without undoing the conversion', async () => {
    const org = await fx.org('wfail');
    const head = await fx.user('wfailHead', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('wfailKid', org);
    deleteUser.mockRejectedValue(new Error('WorkOS down'));
    revokeAllSessions.mockResolvedValue({ revoked: 2, failed: 1 });
    const info = jest.spyOn(logger, 'info');

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result).toEqual({
      success: true,
      managedById: head,
      identityDeleted: false,
      photoDeletion: 'none',
      expiredGuardianInvitations: [],
      deletedReplyCount: 0,
      workosUserId: `workos-wfailKid-${fx.run}`,
      sessions: { revoked: 2, failed: 1 },
    });
    expect(revokeAllSessions).toHaveBeenCalledWith(`workos-wfailKid-${fx.run}`);
    // The provider id reaches the logs, so the operator can finish without the terminal output.
    expect(info).toHaveBeenCalledWith(
      'Account converted to managed',
      expect.objectContaining({ userId: kid, identityDeleted: false, workosUserId: `workos-wfailKid-${fx.run}` })
    );
    expect(await snapshot(kid)).toMatchObject({ workosUserId: null, isManaged: true, managedById: head });
    info.mockRestore();
  });

  it('reports sessions: null when the sessions cannot even be listed', async () => {
    const org = await fx.org('wfail2');
    const head = await fx.user('wfail2Head', 'COACH');
    await fx.staff(head, org);
    const kid = await claimedPlayer('wfail2Kid', org);
    deleteUser.mockRejectedValue(new Error('WorkOS down'));
    revokeAllSessions.mockRejectedValue(new Error('WorkOS down'));

    const result = await AccountService.convertToManaged(kid, { actorId: 'operator' });

    expect(result).toMatchObject({ identityDeleted: false, sessions: null });
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

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
      await expectUntouched(kid, before);
    });

    it('refuses a league admin', async () => {
      const org = await fx.org('admin');
      const head = await fx.user('adminHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('adminKid', org);
      await fx.leagueAdmin(kid, org);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
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

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
      await expectUntouched(kid, before);
    });

    it('refuses a player on no team in an active season', async () => {
      const kid = await fx.user('loneKid', 'PLAYER');
      await prisma.user.update({ where: { id: kid }, data: { workosUserId: `workos-lone-${fx.run}` } });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('no_active_team'));
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

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('several_head_coaches'));
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
      ).rejects.toEqual(refusal('coach_not_on_team'));
      await expectUntouched(kid, before);
    });

    it('refuses a named coach who coached the player only in a past season', async () => {
      const current = await fx.org('pastNow');
      const past = await fx.org('pastThen');
      await prisma.season.update({ where: { id: past.seasonId }, data: { isActive: false } });
      const head = await fx.user('pastHead', 'COACH');
      const formerCoach = await fx.user('pastCoach', 'COACH');
      await fx.staff(head, current);
      await fx.staff(formerCoach, past);
      const kid = await claimedPlayer('pastKid', current);
      await fx.member(kid, past);
      const before = await snapshot(kid);

      await expect(
        AccountService.convertToManaged(kid, { actorId: 'operator', managedById: formerCoach })
      ).rejects.toEqual(refusal('coach_not_on_team'));
      await expectUntouched(kid, before);
    });

    it('refuses an account whose personal league holds teams, and keeps the league', async () => {
      const org = await fx.org('ownTeams');
      const head = await fx.user('ownTeamsHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('ownTeamsKid', org);
      const leagueId = await fx.personalLeague('ownTeamsLeague', kid);
      await fx.leagueAdmin(kid, { leagueId });
      const season = await prisma.season.create({ data: { leagueId, name: `S-${fx.run}` }, select: { id: true } });
      await fx.org('ownTeamsTeam', { league: { leagueId, leagueName: 'personal', seasonId: season.id } });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('personal_league_in_use'));
      await expectUntouched(kid, before);
      expect(await prisma.league.count({ where: { id: leagueId } })).toBe(1);
      expect(await prisma.leagueAdmin.count({ where: { userId: kid } })).toBe(1);
    });

    it('asks for --coach when the active team has staff but no head coach', async () => {
      const org = await fx.org('noHead', { roleType: 'ASSISTANT_COACH' });
      const assistant = await fx.user('noHeadAsst', 'COACH');
      await fx.staff(assistant, org);
      const kid = await claimedPlayer('noHeadKid', org);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('no_head_coach'));
      await expectUntouched(kid, before);
    });

    it('refuses an account that posted an announcement', async () => {
      const org = await fx.org('poster');
      const head = await fx.user('posterHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('posterKid', org);
      await prisma.announcement.create({ data: { teamId: org.teamId, authorId: kid, title: `P-${fx.run}`, body: 'hi' } });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
      await expectUntouched(kid, before);
    });

    it('answers adult_account, not no_active_team, for an adult on no active team', async () => {
      const elsewhere = await fx.org('unrosteredAdult');
      const adult = await fx.user('unrosteredAdult', 'COACH');
      await prisma.user.update({ where: { id: adult }, data: { workosUserId: `workos-unrostered-${fx.run}` } });
      await prisma.announcement.create({
        data: { teamId: elsewhere.teamId, authorId: adult, title: `U-${fx.run}`, body: 'hi' },
      });
      const managed = await fx.user('unrosteredManaged', 'PLAYER');
      await prisma.user.update({ where: { id: managed }, data: { isManaged: true, managedById: adult } });
      const before = await snapshot(adult);

      await expect(AccountService.convertToManaged(adult, { actorId: 'operator' })).rejects.toEqual(
        refusal('adult_account')
      );
      await expectUntouched(adult, before);
    });

    it('refuses a system admin', async () => {
      const org = await fx.org('sysAdmin');
      const head = await fx.user('sysAdminHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('sysAdminKid', org, { role: 'ADMIN' });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
      await expectUntouched(kid, before);
    });

    it('refuses a former coach who manages players or sent invitations', async () => {
      const org = await fx.org('formerCoach');
      const head = await fx.user('formerCoachHead', 'COACH');
      await fx.staff(head, org);
      const managing = await claimedPlayer('formerCoachA', org);
      const managed = await fx.user('formerCoachManaged', 'PLAYER');
      await prisma.user.update({ where: { id: managed }, data: { isManaged: true, managedById: managing } });
      const inviter = await claimedPlayer('formerCoachB', org);
      const invitee = await fx.user('formerCoachInvitee', 'PLAYER');
      await prisma.teamInvitation.create({
        data: {
          teamId: org.teamId,
          playerId: invitee,
          invitedById: inviter,
          token: `inv-former-${fx.run}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      for (const kid of [managing, inviter]) {
        const before = await snapshot(kid);
        await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('adult_account'));
        await expectUntouched(kid, before);
      }
    });

    it('refuses a personal league that has another admin, and keeps it', async () => {
      const org = await fx.org('sharedLeague');
      const head = await fx.user('sharedLeagueHead', 'COACH');
      await fx.staff(head, org);
      const kid = await claimedPlayer('sharedLeagueKid', org);
      const leagueId = await fx.personalLeague('sharedLeagueOwn', kid);
      await fx.leagueAdmin(kid, { leagueId });
      await fx.leagueAdmin(head, { leagueId });
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('personal_league_in_use'));
      await expectUntouched(kid, before);
      expect(await prisma.leagueAdmin.count({ where: { leagueId } })).toBe(2);
    });

    it('answers a re-run with "already a managed roster record", even with no head coach left', async () => {
      const org = await fx.org('rerun', { roleType: 'ASSISTANT_COACH' });
      const assistant = await fx.user('rerunAsst', 'COACH');
      await fx.staff(assistant, org);
      const kid = await claimedPlayer('rerunKid', org);
      await AccountService.convertToManaged(kid, { actorId: 'operator', managedById: assistant });
      deleteUser.mockClear();
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('already_managed'));
      await expectUntouched(kid, before);
    });

    it('refuses an invited row that never signed in: nothing to convert', async () => {
      const org = await fx.org('neverSigned');
      const head = await fx.user('neverSignedHead', 'COACH');
      await fx.staff(head, org);
      const kid = await fx.user('neverSignedKid', 'PLAYER');
      await fx.member(kid, org);
      const before = await snapshot(kid);

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(
        refusal('never_signed_in')
      );
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

      await expect(AccountService.convertToManaged(kid, { actorId: 'operator' })).rejects.toEqual(refusal('already_managed'));
      await expect(AccountService.convertToManaged(tomb, { actorId: 'operator' })).rejects.toThrow(NotFoundError);
      await expect(
        AccountService.convertToManaged('00000000-0000-4000-8000-000000000000', { actorId: 'operator' })
      ).rejects.toThrow(NotFoundError);
      expect(deleteUser).not.toHaveBeenCalled();
    });
  });
});
