/**
 * Resets the seed runs on every `npx prisma db seed` that are worth proving
 * against a real database (#783, #787, #788).
 *
 * `backend/prisma/seed.ts` calls these; `tests/integration/seed-resets.db.test.ts`
 * runs them against Postgres on rows named with a run id. They live here,
 * not in the seed, so the test can call them without running the whole seed
 * against fixtures other suites share.
 */

import type { PrismaClient } from '@prisma/client';
import { computeHomeScore } from '../../src/services/game-event-service';
import type { SeededGame, SeedEvent } from './seed-fixtures';

export interface RemovedTombstones {
  users: number;
  invitations: number;
}

/**
 * Hard-deletes account-deletion tombstones (`deletedAt IS NOT NULL`).
 *
 * `invitedById` is ON DELETE RESTRICT on both `TeamInvitation` and
 * `GuardianInvitation`, and account deletion keeps the invitations a user
 * SENT (`services/account-service.ts`): those rows are one of the things that
 * make it a tombstone instead of an erasure. So the invitations a tombstone
 * sent go first, then the tombstone, in one transaction; every other relation
 * onto `User` cascades or sets null. Without that order the delete fails with
 * P2003 and the whole seed exits before it resets anything (#783).
 *
 * The seed passes no scope (every tombstone goes). A test passes the ids of
 * its own users: suites run in parallel against one database.
 */
export async function removeTombstones(
  db: PrismaClient,
  scope?: { userIds: string[] }
): Promise<RemovedTombstones> {
  const tombstone = {
    deletedAt: { not: null },
    ...(scope ? { id: { in: scope.userIds } } : {}),
  };
  return db.$transaction(async (tx) => {
    const guardianInvitations = await tx.guardianInvitation.deleteMany({ where: { invitedBy: tombstone } });
    const teamInvitations = await tx.teamInvitation.deleteMany({ where: { invitedBy: tombstone } });
    const users = await tx.user.deleteMany({ where: tombstone });
    return { users: users.count, invitations: guardianInvitations.count + teamInvitations.count };
  });
}

export interface RestoredGames {
  rsvps: number;
  events: number;
}

/**
 * Puts each seeded game back in its seeded state, whatever a flow or a
 * person did to it since (#788): `teamId`, `opponent`, `date`, `status` and
 * both scores are written on update as well as on create. It also deletes
 * every RSVP on those games (`guardian-rsvp.yaml` leaves Steph Curry "Going"
 * on Warriors vs Lakers) and every event and stats row on the SCHEDULED ones
 * (a game started by hand and tracked would otherwise come back SCHEDULED
 * with a live box score). The FINISHED games' events are rewritten by
 * `writeFinishedGameEvents`. Only the ids in `games` are touched.
 */
export async function restoreSeededGames(db: PrismaClient, games: readonly SeededGame[]): Promise<RestoredGames> {
  const ids = games.map((game) => game.id);
  const scheduledIds = games.filter((game) => game.status === 'SCHEDULED').map((game) => game.id);
  return db.$transaction(async (tx) => {
    for (const game of games) {
      const state = {
        teamId: game.teamId,
        opponent: game.opponent,
        date: game.date,
        status: game.status,
        homeScore: game.homeScore,
        awayScore: game.awayScore,
      };
      await tx.game.upsert({ where: { id: game.id }, update: state, create: { id: game.id, ...state } });
    }
    const rsvps = await tx.gameRsvp.deleteMany({ where: { gameId: { in: ids } } });
    const events = await tx.gameEvent.deleteMany({ where: { gameId: { in: scheduledIds } } });
    await tx.playerStats.deleteMany({ where: { gameId: { in: scheduledIds } } });
    await tx.teamStats.deleteMany({ where: { gameId: { in: scheduledIds } } });
    return { rsvps: rsvps.count, events: events.count };
  });
}

/**
 * Replaces a FINISHED game's event log and writes `homeScore` from it with
 * `GameEventService.computeHomeScore`, the rule production derives the score
 * with (#787). Runs on every seed, so an edit to the seeded events cannot
 * leave the game card and the box score disagreeing. Returns the score.
 */
export async function writeFinishedGameEvents(
  db: PrismaClient,
  gameId: string,
  events: readonly SeedEvent[]
): Promise<number> {
  const homeScore = computeHomeScore(events);
  await db.$transaction(async (tx) => {
    await tx.gameEvent.deleteMany({ where: { gameId } });
    await tx.gameEvent.createMany({ data: [...events] });
    await tx.game.update({ where: { id: gameId }, data: { homeScore } });
  });
  return homeScore;
}
