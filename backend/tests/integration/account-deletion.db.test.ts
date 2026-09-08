/**
 * Account deletion against a REAL Postgres (#444, docs/plans/account-deletion.md).
 *
 * The mocked suite (tests/services/account-service.test.ts) proves the
 * decision logic; this one proves the row-level outcomes the privacy policy
 * will promise, plus the things a mock cannot: transaction rollback, the
 * FOR UPDATE serialization of concurrent deletes, the guarded writes that
 * stop a stale request from re-identifying the tombstone, and that the
 * export names every table the runbook lists.
 *
 * CI provides Postgres and runs `prisma migrate deploy`; locally it uses
 * whatever DATABASE_URL points at (docker-compose). Every row is namespaced
 * by a per-run id and removed in afterAll.
 *
 *   coach ── HEAD_COACH ── teamActive (co-head: other)        ← not blocking
 *         ── HEAD_COACH ── teamPast   (season inactive, sole) ← headless after, not blocking
 *         ── ASSISTANT  ── teamOther
 *         ── personal league (empty)  → deleted
 *         ── guardian of kid (primary; kid also has otherParent)
 *         ── child of parentOfCoach
 *         ── events + stats on a FINISHED game of teamActive, an RSVP,
 *            a PENDING team invitation, PENDING + ACCEPTED guardian invitations
 *            addressed to coach's email
 *   soleHead ── HEAD_COACH ── teamActive2 (sole, active)      ← blocked, rollback proof
 */
jest.unmock('../../src/models');
import { randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import { AccountService, DELETED_USER_NAME, DELETED_LEAGUE_NAME } from '../../src/services/account-service';
import { WorkOSService } from '../../src/services/workos-service';
import { LastHeadCoachError, NotFoundError } from '../../src/utils/errors';
import { lastHeadCoachTeams } from '../../src/utils/permissions';

jest.setTimeout(30000);

const RUN = randomUUID().slice(0, 8);
const ids = {
  users: {} as Record<string, string>,
  leagues: [] as string[],
  lineages: [] as string[],
  games: [] as string[],
};

async function mkUser(key: string, role: 'PLAYER' | 'COACH' | 'PARENT', extra: Record<string, unknown> = {}): Promise<string> {
  const u = await prisma.user.create({
    data: { name: `${key}-${RUN}`, email: `${key}.${RUN}@example.test`, role, ...extra },
    select: { id: true },
  });
  ids.users[key] = u.id;
  return u.id;
}

interface TeamFixture {
  leagueId: string;
  seasonId: string;
  teamId: string;
  headRoleId: string;
  assistantRoleId: string;
}

async function mkLeagueSeasonTeam(label: string, isActive: boolean, personalOwnerId?: string): Promise<TeamFixture> {
  const league = await prisma.league.create({
    data: { name: `ZZ-${label}-${RUN}`, ...(personalOwnerId && { personalOwnerId }) },
    select: { id: true },
  });
  ids.leagues.push(league.id);
  const season = await prisma.season.create({
    data: { leagueId: league.id, name: `S-${RUN}`, isActive },
    select: { id: true },
  });
  const team = await prisma.team.create({
    data: { name: `${label}-${RUN}`, season: { connect: { id: season.id } }, lineage: { create: {} } },
    select: { id: true, lineageId: true },
  });
  ids.lineages.push(team.lineageId);
  const head = await prisma.teamRole.create({
    data: { teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach', canManageTeam: true, canManageRoster: true },
    select: { id: true },
  });
  const assistant = await prisma.teamRole.create({
    data: { teamId: team.id, type: 'ASSISTANT_COACH', name: 'Assistant Coach', canManageTeam: true },
    select: { id: true },
  });
  return { leagueId: league.id, seasonId: season.id, teamId: team.id, headRoleId: head.id, assistantRoleId: assistant.id };
}

let teamActive: TeamFixture;
let teamPast: TeamFixture;
let teamOther: TeamFixture;
let teamActive2: TeamFixture;
let personalLeagueId: string;
let gameId: string;
let acceptedInviteId: string;
let pendingInviteId: string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    throw new Error(
      'This suite needs a real Postgres. Start one and apply migrations:\n' +
        '  docker-compose up -d && cd backend && npx prisma migrate deploy\n' +
        `DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}`,
      { cause: err }
    );
  }

  const coach = await mkUser('coach', 'COACH', { workosUserId: `workos-${RUN}`, profilePictureUrl: null });
  const other = await mkUser('other', 'COACH');
  const soleHead = await mkUser('soleHead', 'COACH');
  const kid = await mkUser('kid', 'PLAYER', { isManaged: true, managedById: coach, email: null });
  const otherParent = await mkUser('otherParent', 'PARENT');
  const parentOfCoach = await mkUser('parentOfCoach', 'PARENT');
  const teammate = await mkUser('teammate', 'PLAYER');

  teamActive = await mkLeagueSeasonTeam('Active', true);
  teamPast = await mkLeagueSeasonTeam('Past', false);
  teamOther = await mkLeagueSeasonTeam('Other', true);
  teamActive2 = await mkLeagueSeasonTeam('Active2', true);

  // Personal league for coach: empty (no teams) → must be deleted outright
  const pl = await prisma.league.create({
    data: { name: `${coach}'s Teams`, personalOwnerId: coach },
    select: { id: true },
  });
  personalLeagueId = pl.id;
  ids.leagues.push(pl.id);
  await prisma.leagueAdmin.create({ data: { leagueId: pl.id, userId: coach } });

  // Staff rows
  await prisma.teamStaff.createMany({
    data: [
      { teamId: teamActive.teamId, userId: coach, roleId: teamActive.headRoleId },
      { teamId: teamActive.teamId, userId: other, roleId: teamActive.headRoleId },
      { teamId: teamPast.teamId, userId: coach, roleId: teamPast.headRoleId },
      { teamId: teamOther.teamId, userId: coach, roleId: teamOther.assistantRoleId },
      { teamId: teamOther.teamId, userId: other, roleId: teamOther.headRoleId },
      { teamId: teamActive2.teamId, userId: soleHead, roleId: teamActive2.headRoleId },
    ],
  });

  // Roster: coach and teammate play on teamActive; kid plays on teamActive
  await prisma.teamMember.createMany({
    data: [
      { teamId: teamActive.teamId, playerId: coach, jerseyNumber: 7 },
      { teamId: teamActive.teamId, playerId: teammate, jerseyNumber: 8 },
      { teamId: teamActive.teamId, playerId: kid, jerseyNumber: 9 },
    ],
  });

  // Guardians: coach is primary guardian of kid; otherParent also guardian; parentOfCoach guards coach
  await prisma.guardian.createMany({
    data: [
      { parentId: coach, childId: kid, relationship: 'FATHER', isPrimary: true },
      { parentId: otherParent, childId: kid, relationship: 'MOTHER', isPrimary: false },
      { parentId: parentOfCoach, childId: coach, relationship: 'MOTHER', isPrimary: true },
    ],
  });

  // A finished game with events + stats for coach and teammate, and an RSVP
  const game = await prisma.game.create({
    data: {
      teamId: teamActive.teamId,
      opponent: `Opp-${RUN}`,
      date: new Date('2026-01-01T00:00:00Z'),
      status: 'FINISHED',
      homeScore: 4,
      awayScore: 0,
    },
    select: { id: true },
  });
  gameId = game.id;
  ids.games.push(game.id);
  await prisma.gameEvent.createMany({
    data: [
      { gameId: game.id, playerId: coach, eventType: 'SHOT', metadata: { made: true, points: 2 } },
      { gameId: game.id, playerId: teammate, eventType: 'SHOT', metadata: { made: true, points: 2 } },
    ],
  });
  await prisma.playerStats.createMany({
    data: [
      { playerId: coach, gameId: game.id, points: 2 },
      { playerId: teammate, gameId: game.id, points: 2 },
    ],
  });
  await prisma.gameRsvp.create({ data: { gameId: game.id, userId: coach, status: 'YES' } });

  // Tokens
  await prisma.pushToken.create({ data: { userId: coach, token: `ExponentPushToken[${RUN}]`, platform: 'ios' } });
  await prisma.calendarFeedToken.create({ data: { userId: coach, teamId: teamActive.teamId, token: `cal-${RUN}` } });

  // Invitations: a PENDING team invitation addressed to coach (sent by other),
  // and guardian invitations addressed to coach's email (one PENDING, one ACCEPTED)
  await prisma.teamInvitation.create({
    data: {
      teamId: teamOther.teamId,
      playerId: coach,
      invitedById: other,
      token: `ti-${RUN}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const coachEmail = `coach.${RUN}@example.test`;
  const pending = await prisma.guardianInvitation.create({
    data: {
      token: `gi-p-${RUN}`,
      childId: teammate,
      teamId: teamActive.teamId,
      invitedEmail: coachEmail.toUpperCase(),
      relationship: 'GUARDIAN',
      invitedById: other,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  pendingInviteId = pending.id;
  const accepted = await prisma.guardianInvitation.create({
    data: {
      token: `gi-a-${RUN}`,
      childId: kid,
      invitedEmail: coachEmail,
      relationship: 'FATHER',
      invitedById: other,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  acceptedInviteId = accepted.id;
});

afterAll(async () => {
  const userIds = Object.values(ids.users);
  // `invitedById` has no cascade on either invitation table
  await prisma.guardianInvitation.deleteMany({ where: { invitedById: { in: userIds } } });
  await prisma.teamInvitation.deleteMany({ where: { invitedById: { in: userIds } } });
  await prisma.game.deleteMany({ where: { id: { in: ids.games } } });
  await prisma.league.deleteMany({ where: { id: { in: ids.leagues } } });
  await prisma.teamLineage.deleteMany({ where: { id: { in: ids.lineages } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('AccountService.deleteAccount (real Postgres)', () => {
  it('blocks a sole head coach of an active-season team and leaves every row untouched (rollback)', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids.users.soleHead } });

    const error = await AccountService.deleteAccount(ids.users.soleHead, {
      actorId: ids.users.soleHead,
      mode: 'self',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(LastHeadCoachError);
    expect((error as LastHeadCoachError).details.teams).toEqual([{ id: teamActive2.teamId, name: `Active2-${RUN}` }]);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids.users.soleHead } });
    expect(after).toEqual(before);
    expect(await prisma.teamStaff.count({ where: { userId: ids.users.soleHead } })).toBe(1);
  });

  it('lastHeadCoachTeams: scopes to active seasons in one query and ignores co-headed teams', async () => {
    // coach: sole head on teamPast (inactive) and co-head on teamActive
    expect(await lastHeadCoachTeams(ids.users.coach, prisma, { activeSeasonsOnly: true })).toEqual([]);
    expect(await lastHeadCoachTeams(ids.users.coach)).toEqual([{ id: teamPast.teamId, name: `Past-${RUN}` }]);
    expect(await lastHeadCoachTeams(ids.users.coach, prisma, { teamIds: [teamActive.teamId] })).toEqual([]);
  });

  it('anonymizes the coach: tombstone, purge, scrub, keep stats — and the identity cannot come back', async () => {
    const coach = ids.users.coach;
    const deleteUserSpy = jest.spyOn(WorkOSService, 'deleteUser').mockResolvedValue(undefined);

    const result = await AccountService.deleteAccount(coach, { actorId: coach, mode: 'self' });
    expect(result).toEqual({ success: true, identityDeleted: true, adminlessLeagueIds: [] });
    expect(deleteUserSpy).toHaveBeenCalledWith(`workos-${RUN}`);

    // Tombstone columns
    const row = await prisma.user.findUniqueOrThrow({ where: { id: coach } });
    expect(row).toMatchObject({
      workosUserId: null,
      email: null,
      name: DELETED_USER_NAME,
      emailVerified: false,
      profilePictureUrl: null,
      managedById: null,
      subscriptionTier: 'FREE',
    });
    expect(row.deletedAt).toBeInstanceOf(Date);

    // Purged
    expect(await prisma.teamStaff.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.leagueAdmin.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.gameRsvp.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.pushToken.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.calendarFeedToken.count({ where: { userId: coach } })).toBe(0);
    expect(await prisma.guardian.count({ where: { OR: [{ parentId: coach }, { childId: coach }] } })).toBe(0);
    // The co-head keeps the active team; the past team is headless and still exists
    expect(await prisma.teamStaff.count({ where: { teamId: teamActive.teamId, userId: ids.users.other } })).toBe(1);
    expect(await prisma.team.findUnique({ where: { id: teamPast.teamId }, select: { id: true } })).not.toBeNull();

    // Kept, de-identified
    expect(await prisma.teamMember.count({ where: { playerId: coach } })).toBe(1);
    expect(await prisma.gameEvent.count({ where: { playerId: coach } })).toBe(1);
    expect(await prisma.playerStats.count({ where: { playerId: coach } })).toBe(1);
    // …and the teammate's stats are untouched
    expect(await prisma.playerStats.count({ where: { playerId: ids.users.teammate, gameId } })).toBe(1);

    // Invitations flipped and scrubbed (D17: every matching invitedEmail, not only PENDING)
    expect(await prisma.teamInvitation.findFirst({ where: { playerId: coach }, select: { status: true } })).toEqual({
      status: 'CANCELLED',
    });
    const pending = await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: pendingInviteId } });
    const accepted = await prisma.guardianInvitation.findUniqueOrThrow({ where: { id: acceptedInviteId } });
    expect(pending.status).toBe('EXPIRED');
    expect(accepted.status).toBe('ACCEPTED');
    expect(pending.invitedEmail).toBe(`deleted-${pendingInviteId}@invalid`);
    expect(accepted.invitedEmail).toBe(`deleted-${acceptedInviteId}@invalid`);
    expect(await prisma.guardianInvitation.count({ where: { invitedEmail: { contains: `coach.${RUN}` } } })).toBe(0);

    // Guardian promotion: otherParent is now kid's primary
    const kidLinks = await prisma.guardian.findMany({ where: { childId: ids.users.kid } });
    expect(kidLinks).toHaveLength(1);
    expect(kidLinks[0]).toMatchObject({ parentId: ids.users.otherParent, isPrimary: true });

    // Empty personal league deleted outright (D16)
    expect(await prisma.league.findUnique({ where: { id: personalLeagueId } })).toBeNull();

    // Managed child stays managed, but nobody owns it now
    const kid = await prisma.user.findUniqueOrThrow({ where: { id: ids.users.kid } });
    expect(kid).toMatchObject({ isManaged: true, managedById: null });

    // Second call → 404
    await expect(AccountService.deleteAccount(coach, { actorId: coach, mode: 'self' })).rejects.toBeInstanceOf(
      NotFoundError
    );

    // The identity cannot come back: a sign-in with the old WorkOS id / email creates a NEW row
    const fresh = await WorkOSService.syncUser({
      id: `workos-${RUN}`,
      email: `coach.${RUN}@example.test`,
      emailVerified: true,
    });
    expect(fresh.id).not.toBe(coach);
    ids.users.fresh = fresh.id;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: coach } })).workosUserId).toBeNull();

    // A stale self-write (already past `authenticate`) finds zero rows (D9)
    const stale = await prisma.user.updateMany({
      where: { id: coach, deletedAt: null },
      data: { name: 'Back From The Dead' },
    });
    expect(stale.count).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: coach } })).name).toBe(DELETED_USER_NAME);

    deleteUserSpy.mockRestore();
  });

  it('renames a personal league that still holds teams and marks it non-personal (D16)', async () => {
    const owner = await mkUser('owner', 'COACH');
    const own = await mkLeagueSeasonTeam('Own', true, owner);
    await prisma.leagueAdmin.create({ data: { leagueId: own.leagueId, userId: owner } });
    // Another head coach on the team so the owner is not blocked
    const coHead = await mkUser('coHead', 'COACH');
    await prisma.teamStaff.createMany({
      data: [
        { teamId: own.teamId, userId: owner, roleId: own.headRoleId },
        { teamId: own.teamId, userId: coHead, roleId: own.headRoleId },
      ],
    });

    await AccountService.deleteAccount(owner, { actorId: owner, mode: 'self' });

    const league = await prisma.league.findUniqueOrThrow({ where: { id: own.leagueId } });
    expect(league).toMatchObject({ name: DELETED_LEAGUE_NAME, personalOwnerId: null });
    expect(await prisma.team.count({ where: { id: own.teamId } })).toBe(1);
  });

  it('guardian mode deletes a managed, unclaimed child and refuses a claimed one under the lock', async () => {
    const parent = await mkUser('gParent', 'PARENT');
    const managed = await mkUser('gKidManaged', 'PLAYER', { isManaged: true, email: null });
    const claimed = await mkUser('gKidClaimed', 'PLAYER', { isManaged: false, workosUserId: `workos-kid-${RUN}` });
    await prisma.guardian.createMany({
      data: [
        { parentId: parent, childId: managed, relationship: 'MOTHER', isPrimary: true },
        { parentId: parent, childId: claimed, relationship: 'MOTHER', isPrimary: true },
      ],
    });

    await AccountService.deleteAccount(managed, { actorId: parent, mode: 'guardian' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: managed } })).deletedAt).toBeInstanceOf(Date);
    expect(await prisma.guardian.count({ where: { childId: managed } })).toBe(0);

    await expect(
      AccountService.deleteAccount(claimed, { actorId: parent, mode: 'guardian' })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: claimed } })).deletedAt).toBeNull();
  });

  it('serializes two concurrent deletes: one succeeds, the other gets 404', async () => {
    const dup = await mkUser('dup', 'PLAYER');

    const outcomes = await Promise.allSettled([
      AccountService.deleteAccount(dup, { actorId: dup, mode: 'self' }),
      AccountService.deleteAccount(dup, { actorId: dup, mode: 'self' }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(NotFoundError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: dup } })).deletedAt).toBeInstanceOf(Date);
  });

  it('exportUserData names every table the runbook lists', async () => {
    const data = await AccountService.exportUserData(ids.users.teammate);
    expect(Object.keys(data).sort()).toEqual(
      [
        'announcements', 'calendarFeedTokens', 'exportedAt', 'gameEvents', 'gameRsvps', 'guardianInvitations',
        'guardiansAsChild', 'guardiansAsParent', 'leagueAdmins', 'personalLeague', 'playerStats', 'pushTokens',
        'receivedInvitations', 'sentGuardianInvitations', 'sentInvitations', 'teamMembers', 'teamStaff', 'user',
      ].sort()
    );
    expect(data.gameEvents).toHaveLength(1);
    expect(data.playerStats).toHaveLength(1);
    expect(data.teamMembers[0].team).toMatchObject({ id: teamActive.teamId, season: { league: { name: `ZZ-Active-${RUN}` } } });
    expect(data.user).not.toHaveProperty('workosUserId');
  });
});
