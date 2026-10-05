/**
 * Resets the seed runs on every `npx prisma db seed` that are worth proving
 * against a real database (#782, #783, #787, #788).
 *
 * `backend/prisma/seed.ts` calls these; `tests/integration/seed-resets.db.test.ts`
 * runs them against Postgres on rows named with a run id. They live here,
 * not in the seed, so the test can call them without running the whole seed
 * against fixtures other suites share. A reset that would otherwise sweep the
 * whole database takes a scope, so its test touches only its own rows.
 */

import type { PrismaClient } from '@prisma/client';
import { computeHomeScore } from '../../src/services/game-event-service';
import { lockGameRow } from '../../src/utils/game-row-lock';
import { createDefaultTeamRoles } from '../../src/utils/permissions';
import { SEEDED_LAKERS_MANAGED_IDS, type SeededGame, type SeedEvent } from './seed-fixtures';
import { deleteUsersWhere, type DeletedUsers } from './test-leftovers';

/**
 * Hard-deletes account-deletion tombstones (`deletedAt IS NOT NULL`).
 *
 * Account deletion keeps the invitations a user SENT
 * (`services/account-service.ts`), and those reference the tombstone through
 * ON DELETE RESTRICT foreign keys, so the old plain `user.deleteMany` aborted
 * the whole seed with P2003 (#783). `deleteUsersWhere` deletes the sent
 * invitations first; this runs it in one transaction.
 *
 * The seed passes no scope (every tombstone goes). A test passes the ids of
 * its own users: suites run in parallel against one database.
 */
export async function removeTombstones(
  db: PrismaClient,
  scope?: { userIds: string[] }
): Promise<DeletedUsers> {
  return db.$transaction((tx) =>
    deleteUsersWhere(tx, { deletedAt: { not: null }, ...(scope ? { id: { in: scope.userIds } } : {}) })
  );
}

/**
 * Removes the managed players a coach owns other than `keepIds`: the ones the
 * roster flows add ("E2E Test Player" from roster-management.yaml). The seed
 * passes Frank Vogel and `SEEDED_LAKERS_MANAGED_IDS`, so his six seeded
 * fixtures survive every reseed with their stats and RSVPs (#782: a dead
 * `'managed-'` id-prefix guard deleted all six). Never widen this to all of a
 * coach's managed players. Tombstones are left to `removeTombstones`.
 */
export async function removeFlowCreatedManagedPlayers(
  db: PrismaClient,
  managerId: string,
  keepIds: readonly string[] = SEEDED_LAKERS_MANAGED_IDS
): Promise<number> {
  const removed = await db.$transaction((tx) =>
    deleteUsersWhere(tx, {
      managedById: managerId,
      isManaged: true,
      deletedAt: null,
      id: { notIn: [...keepIds] },
    })
  );
  return removed.users;
}

/**
 * Gives a team the three default roles `TeamService.createTeam` creates, with
 * the same function (#787), creating only the ones it lacks: a team that lost
 * one (say the Team Manager role a person deleted) gets it back while the
 * roles its staff rows point at stay. Returns how many were created.
 */
export async function ensureDefaultTeamRoles(db: PrismaClient, teamId: string): Promise<number> {
  const before = await db.teamRole.count({ where: { teamId } });
  await createDefaultTeamRoles(teamId, db, { skipDuplicates: true });
  return (await db.teamRole.count({ where: { teamId } })) - before;
}

export interface RestoredGames {
  rsvps: number;
  events: number;
}

/**
 * Puts each seeded game back in its seeded state, whatever a flow or a
 * person did to it since (#788): `teamId`, `opponent`, `date`, `status` and
 * `awayScore` are written on update as well as on create. `homeScore` is
 * reset to 0 here and never written from a fixture: a FINISHED game gets its
 * score from `writeFinishedGameEvents`, which derives it from the events.
 *
 * Also deletes every RSVP on those games (`guardian-rsvp.yaml` leaves Steph
 * Curry "Going" on Warriors vs Lakers) and every event and stats row on the
 * SCHEDULED ones (a game started by hand and tracked would otherwise come
 * back SCHEDULED with a live box score). A FINISHED game's events and stats
 * are left for `writeFinishedGameEvents` and `finalizeGameStats` to rewrite.
 * Only the ids in `games` are touched.
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
        homeScore: 0,
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
 * with (#787). Same invariant as the event writers: the game row is locked
 * (`lockGameRow`, `SELECT … FOR UPDATE`) first, and the events and the score
 * change in one transaction. Runs on every seed, so an edit to the seeded
 * events cannot leave the game card and the box score disagreeing. Returns
 * the score.
 */
export async function writeFinishedGameEvents(
  db: PrismaClient,
  gameId: string,
  events: readonly SeedEvent[]
): Promise<number> {
  const homeScore = computeHomeScore(events);
  await db.$transaction(async (tx) => {
    await lockGameRow(tx, gameId);
    await tx.gameEvent.deleteMany({ where: { gameId } });
    await tx.gameEvent.createMany({ data: [...events] });
    await tx.game.update({ where: { id: gameId }, data: { homeScore } });
  });
  return homeScore;
}
