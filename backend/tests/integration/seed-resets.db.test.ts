/**
 * REAL DATABASE test for the resets `npx prisma db seed` runs (#783, #787, #788).
 *
 * The seed is the reset between Maestro flows, so a reset that throws leaves
 * every later flow on drifted data. These run the seed's own helpers
 * (`tests/support/seed-resets.ts`) against Postgres on rows named with this
 * run's id, never on the seeded fixtures other suites and the developer share:
 *
 * - a tombstone that sent invitations is removed without P2003 (the inviter
 *   foreign keys are ON DELETE RESTRICT; the plain delete the seed used to run
 *   fails here first, to prove the hazard is real);
 * - seeded games are put back in their seeded state and lose their RSVPs,
 *   while an RSVP on any other game survives;
 * - a finished game's `homeScore` is derived from its events, run after run.
 */

jest.unmock('../../src/models');

import { randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../src/models';
import { DbFixtures, Org } from '../support/db-fixtures';
import { removeTombstones, restoreSeededGames, writeFinishedGameEvents } from '../support/seed-resets';
import { SeededGame, warriorsVsHeatEvents } from '../support/seed-fixtures';

jest.setTimeout(30000);

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
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.guardianInvitation.create({
    data: {
      token: randomBytes(24).toString('base64url'),
      childId: playerId,
      invitedEmail: `guardian.${inviterId.slice(0, 8)}.${fx.run}@example.test`,
      relationship: 'GUARDIAN',
      invitedById: inviterId,
      expiresAt: new Date(Date.now() + 86_400_000),
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

describe('restoreSeededGames (#788)', () => {
  const DAY = 86_400_000;

  function specs(ids: { scheduled: string; finished: string; missing: string }): SeededGame[] {
    const now = Date.now();
    return [
      {
        id: ids.scheduled,
        teamId: org.teamId,
        opponent: `Scheduled-${fx.run}`,
        date: new Date(now + DAY),
        status: 'SCHEDULED',
        homeScore: 0,
        awayScore: 0,
        label: 'scheduled',
      },
      {
        id: ids.finished,
        teamId: org.teamId,
        opponent: `Finished-${fx.run}`,
        date: new Date(now - 7 * DAY),
        status: 'FINISHED',
        homeScore: 112,
        awayScore: 105,
        label: 'finished',
      },
      {
        id: ids.missing,
        teamId: org.teamId,
        opponent: `Missing-${fx.run}`,
        date: new Date(now + 7 * DAY),
        status: 'SCHEDULED',
        homeScore: 0,
        awayScore: 0,
        label: 'missing',
      },
    ];
  }

  it('restores drifted games, deletes their RSVPs and scheduled-game events, and leaves other games alone', async () => {
    const fan = await fx.user('fan', 'PLAYER');
    const scheduled = await fx.game(org, { status: 'IN_PROGRESS', date: new Date(Date.now() - 10 * DAY) });
    const finished = await fx.game(org, { status: 'IN_PROGRESS' });
    const other = await fx.game(org, { opponent: `Other-${fx.run}` });
    const missing = randomUUID();
    await prisma.game.update({ where: { id: scheduled }, data: { homeScore: 7, awayScore: 4 } });
    for (const gameId of [scheduled, other]) {
      await prisma.gameRsvp.create({ data: { gameId, userId: fan, status: 'YES' } });
      await prisma.gameEvent.create({
        data: { gameId, playerId: fan, eventType: 'SHOT', timestamp: new Date(), metadata: { made: true, points: 2 } },
      });
    }

    const games = specs({ scheduled, finished, missing });
    const restored = await restoreSeededGames(prisma, games);

    expect(restored).toEqual({ rsvps: 1, events: 1 });
    for (const spec of games) {
      const row = await prisma.game.findUniqueOrThrow({ where: { id: spec.id } });
      expect(row).toMatchObject({
        teamId: spec.teamId,
        opponent: spec.opponent,
        date: spec.date,
        status: spec.status,
        homeScore: spec.homeScore,
        awayScore: spec.awayScore,
      });
    }
    expect(await prisma.gameRsvp.count({ where: { gameId: scheduled } })).toBe(0);
    expect(await prisma.gameEvent.count({ where: { gameId: scheduled } })).toBe(0);
    expect(await prisma.gameRsvp.count({ where: { gameId: other } })).toBe(1);
    expect(await prisma.gameEvent.count({ where: { gameId: other } })).toBe(1);

    // Idempotent: a second run finds nothing to remove and changes nothing.
    expect(await restoreSeededGames(prisma, games)).toEqual({ rsvps: 0, events: 0 });
  });
});

describe('writeFinishedGameEvents (#787)', () => {
  it('derives homeScore from the events on every run, whatever the row held', async () => {
    const shooter = await fx.user('shooter', 'PLAYER');
    const gameId = await fx.game(org, { status: 'FINISHED' });
    const ids = { steph: shooter, klay: shooter, draymond: shooter, wiggins: shooter, poole: shooter };
    const events = warriorsVsHeatEvents(gameId, ids, new Date(Date.now() - 7 * 86_400_000));

    await prisma.game.update({ where: { id: gameId }, data: { homeScore: 50 } });
    expect(await writeFinishedGameEvents(prisma, gameId, events)).toBe(112);
    expect(await writeFinishedGameEvents(prisma, gameId, events)).toBe(112);

    const row = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.homeScore).toBe(112);
    expect(await prisma.gameEvent.count({ where: { gameId } })).toBe(events.length);
    const shots = await prisma.gameEvent.count({ where: { gameId, eventType: 'SHOT' } });
    expect(shots).toBe(events.filter((event) => event.eventType === 'SHOT').length);
  });
});
