/**
 * REAL DATABASE test for the resets `npx prisma db seed` runs (#782, #783, #787, #788).
 *
 * The seed is the reset between Maestro flows, so a reset that throws or
 * reaches too far leaves every later flow on drifted data. These run the
 * seed's own helpers (`tests/support/seed-resets.ts`) against Postgres on
 * rows named with this run's id, never on the seeded fixtures other suites
 * and the developer share:
 *
 * - a tombstone that sent invitations is removed without P2003 (the inviter
 *   foreign keys are ON DELETE RESTRICT; the plain delete the seed used to run
 *   fails here first, to prove the hazard is real);
 * - the managed-player reset removes a coach's flow-created players and keeps
 *   the listed fixtures;
 * - a team holding two of the three default roles gets the third, with the
 *   flags `createDefaultTeamRoles` gives every new team;
 * - seeded games are put back in their seeded state and lose their RSVPs,
 *   while an RSVP on any other game survives; a finished game keeps its
 *   events and stats for the event rewrite, and its score is derived from the
 *   events, run after run.
 */

jest.unmock('../../src/models');

import { randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import { createDefaultTeamRoles } from '../../src/utils/permissions';
import { DbFixtures, Org } from '../support/db-fixtures';
import {
  ensureDefaultTeamRoles,
  removeFlowCreatedManagedPlayers,
  removeTombstones,
  restoreSeededGames,
  writeFinishedGameEvents,
} from '../support/seed-resets';
import { FINISHED_GAME_SCORES, SeededGame, warriorsVsHeatEvents } from '../support/seed-fixtures';

jest.setTimeout(30000);

const DAY = 86_400_000;
const fx = new DbFixtures(prisma, 'SeedResets');
let org: Org;

beforeAll(async () => {
  await fx.requireDatabase();
  org = await fx.org('team');
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

async function sendInvitations(inviterId: string, playerId: string): Promise<void> {
  await prisma.teamInvitation.create({
    data: {
      teamId: org.teamId,
      playerId,
      invitedById: inviterId,
      token: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  await prisma.guardianInvitation.create({
    data: {
      token: randomBytes(24).toString('base64url'),
      childId: playerId,
      invitedEmail: `guardian.${inviterId.slice(0, 8)}.${fx.run}@example.test`,
      relationship: 'GUARDIAN',
      invitedById: inviterId,
      expiresAt: new Date(Date.now() + DAY),
    },
  });
}

describe('removeTombstones (#783)', () => {
  it('removes a tombstone that sent invitations, and nothing that is not a tombstone', async () => {
    const deleted = await fx.user('deleted-inviter', 'COACH');
    const live = await fx.user('live-inviter', 'COACH');
    const player = await fx.user('invited-player', 'PLAYER');
    const otherPlayer = await fx.user('other-player', 'PLAYER');
    await sendInvitations(deleted, player);
    // One PENDING invitation per team and player (partial unique index).
    await sendInvitations(live, otherPlayer);
    // What account deletion leaves: the row, de-identified, with deletedAt set.
    await prisma.user.update({ where: { id: deleted }, data: { deletedAt: new Date(), name: 'Deleted user' } });

    // The sweep the seed used to run: the RESTRICT foreign key refuses it.
    await expect(prisma.user.deleteMany({ where: { id: deleted, deletedAt: { not: null } } })).rejects.toMatchObject({
      code: 'P2003',
    });

    const removed = await removeTombstones(prisma, { userIds: [deleted, live, player, otherPlayer] });

    expect(removed).toEqual({ users: 1, invitations: 2 });
    expect(await prisma.user.findUnique({ where: { id: deleted } })).toBeNull();
    expect(await prisma.user.count({ where: { id: { in: [live, player, otherPlayer] } } })).toBe(3);
    expect(await prisma.teamInvitation.count({ where: { invitedById: live } })).toBe(1);
    expect(await prisma.guardianInvitation.count({ where: { invitedById: live } })).toBe(1);
  });
});

describe('removeFlowCreatedManagedPlayers (#782)', () => {
  async function managedPlayer(key: string, managerId: string): Promise<string> {
    const user = await prisma.user.create({
      data: { name: `${key}-${fx.run}`, role: 'PLAYER', isManaged: true, managedById: managerId },
      select: { id: true },
    });
    return user.id;
  }

  it("removes the coach's flow-created managed players and keeps the listed fixtures", async () => {
    const coach = await fx.user('managing-coach', 'COACH');
    const otherCoach = await fx.user('other-coach', 'COACH');
    const fixture = await managedPlayer('seeded-fixture', coach);
    const flowCreated = await managedPlayer('flow-created', coach);
    const otherCoachsPlayer = await managedPlayer('other-coachs-player', otherCoach);
    // A fixture with history: the old guard's hard delete cascaded these away.
    const gameId = await fx.game(org, { status: 'FINISHED' });
    await prisma.playerStats.create({ data: { playerId: fixture, gameId, points: 9 } });

    expect(await removeFlowCreatedManagedPlayers(prisma, coach, [fixture])).toBe(1);

    expect(await prisma.user.findUnique({ where: { id: flowCreated } })).toBeNull();
    expect(await prisma.user.count({ where: { id: { in: [fixture, otherCoachsPlayer] } } })).toBe(2);
    expect(await prisma.playerStats.count({ where: { playerId: fixture, gameId } })).toBe(1);
    // A second reseed finds nothing more to remove.
    expect(await removeFlowCreatedManagedPlayers(prisma, coach, [fixture])).toBe(0);
  });
});

describe('ensureDefaultTeamRoles (#787)', () => {
  const FLAGS = { canManageTeam: true, canManageRoster: true, canTrackStats: true, canViewStats: true, canShareStats: true };

  it('creates only the missing default role, with the flags a team created through the API gets', async () => {
    // The reference: a team set up by the service function itself.
    const reference = await fx.org('reference-team');
    await prisma.teamRole.deleteMany({ where: { teamId: reference.teamId } });
    await createDefaultTeamRoles(reference.teamId, prisma);

    // The seeded-team case: two of the three roles present, staff on one.
    const partial = await fx.org('partial-team', { roleType: 'HEAD_COACH' });
    await prisma.teamRole.update({ where: { id: partial.roleId }, data: { name: 'Head Coach', ...FLAGS } });
    await prisma.teamRole.create({
      data: { teamId: partial.teamId, type: 'ASSISTANT_COACH', name: 'Assistant Coach', ...FLAGS },
    });
    const coach = await fx.user('partial-coach', 'COACH');
    await fx.staff(coach, partial);

    expect(await ensureDefaultTeamRoles(prisma, partial.teamId)).toBe(1);
    expect(await ensureDefaultTeamRoles(prisma, partial.teamId)).toBe(0);

    const shape = async (teamId: string): Promise<unknown[]> =>
      prisma.teamRole.findMany({
        where: { teamId },
        orderBy: { name: 'asc' },
        select: {
          type: true,
          name: true,
          canManageTeam: true,
          canManageRoster: true,
          canTrackStats: true,
          canViewStats: true,
          canShareStats: true,
        },
      });
    expect(await shape(partial.teamId)).toEqual(await shape(reference.teamId));
    expect(await prisma.teamStaff.count({ where: { teamId: partial.teamId, roleId: partial.roleId } })).toBe(1);
  });
});

describe('restoreSeededGames and writeFinishedGameEvents (#787, #788)', () => {
  function specs(ids: { scheduled: string; finished: string; missing: string }): SeededGame[] {
    const now = Date.now();
    return [
      {
        id: ids.scheduled,
        teamId: org.teamId,
        opponent: `Scheduled-${fx.run}`,
        date: new Date(now + DAY),
        status: 'SCHEDULED',
        awayScore: 0,
        label: 'scheduled',
      },
      {
        id: ids.finished,
        teamId: org.teamId,
        opponent: `Finished-${fx.run}`,
        date: new Date(now - 7 * DAY),
        status: 'FINISHED',
        awayScore: FINISHED_GAME_SCORES.WARRIORS_VS_HEAT.away,
        label: 'finished',
      },
      {
        id: ids.missing,
        teamId: org.teamId,
        opponent: `Missing-${fx.run}`,
        date: new Date(now + 7 * DAY),
        status: 'SCHEDULED',
        awayScore: 0,
        label: 'missing',
      },
    ];
  }

  it('restores drifted games, sweeps RSVPs and scheduled-game rows, and leaves other games alone', async () => {
    const fan = await fx.user('fan', 'PLAYER');
    const scheduled = await fx.game(org, { status: 'IN_PROGRESS', date: new Date(Date.now() - 10 * DAY) });
    const finished = await fx.game(org, { status: 'IN_PROGRESS' });
    const other = await fx.game(org, { opponent: `Other-${fx.run}` });
    const missing = randomUUID();
    await prisma.game.update({ where: { id: scheduled }, data: { homeScore: 7, awayScore: 4 } });
    await prisma.game.update({ where: { id: finished }, data: { homeScore: 50, awayScore: 1 } });
    // Drift on every game: an RSVP, a shot and a stats row.
    for (const gameId of [scheduled, finished, other]) {
      await prisma.gameRsvp.create({ data: { gameId, userId: fan, status: 'YES' } });
      await prisma.gameEvent.create({
        data: { gameId, playerId: fan, eventType: 'SHOT', timestamp: new Date(), metadata: { made: true, points: 2 } },
      });
      await prisma.playerStats.create({ data: { gameId, playerId: fan, points: 2 } });
    }

    const games = specs({ scheduled, finished, missing });
    const restored = await restoreSeededGames(prisma, games);

    expect(restored).toEqual({ rsvps: 2, events: 1 });
    for (const spec of games) {
      const row = await prisma.game.findUniqueOrThrow({ where: { id: spec.id } });
      expect(row).toMatchObject({
        teamId: spec.teamId,
        opponent: spec.opponent,
        date: spec.date,
        status: spec.status,
        homeScore: 0,
        awayScore: spec.awayScore,
      });
    }
    const counts = async (gameId: string): Promise<number[]> => [
      await prisma.gameRsvp.count({ where: { gameId } }),
      await prisma.gameEvent.count({ where: { gameId } }),
      await prisma.playerStats.count({ where: { gameId } }),
    ];
    // [RSVPs, events, stats rows]
    expect(await counts(scheduled)).toEqual([0, 0, 0]);
    // A finished game loses its RSVP; its events and stats wait for the rewrite.
    expect(await counts(finished)).toEqual([0, 1, 1]);
    expect(await counts(other)).toEqual([1, 1, 1]);

    // Idempotent: a second run finds nothing to remove.
    expect(await restoreSeededGames(prisma, games)).toEqual({ rsvps: 0, events: 0 });

    // The rest of the full reset: the finished game's events are rewritten and
    // its score derived from them, run after run.
    const shooter = await fx.user('shooter', 'PLAYER');
    const ids = { steph: shooter, klay: shooter, draymond: shooter, wiggins: shooter, poole: shooter };
    const events = warriorsVsHeatEvents(finished, ids, new Date(Date.now() - 7 * DAY));
    const expected = FINISHED_GAME_SCORES.WARRIORS_VS_HEAT.home;
    expect(await writeFinishedGameEvents(prisma, finished, events)).toBe(expected);
    expect(await writeFinishedGameEvents(prisma, finished, events)).toBe(expected);

    const row = await prisma.game.findUniqueOrThrow({ where: { id: finished } });
    expect(row.homeScore).toBe(expected);
    expect(await prisma.gameEvent.count({ where: { gameId: finished } })).toBe(events.length);
    expect(await prisma.gameEvent.count({ where: { gameId: finished, playerId: fan } })).toBe(0);
  });
});
