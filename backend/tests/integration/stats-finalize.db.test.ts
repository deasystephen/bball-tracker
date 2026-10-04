/**
 * REAL DATABASE test: overlapping writes to a game converge on one box score (#724).
 *
 * `finalizeGameStats` used to read the event log on the bare client and write
 * `PlayerStats`/`TeamStats` in a later batch transaction, so two overlapping
 * finalizations could commit in the opposite order from their reads and leave
 * a box score missing the later event. A `PATCH status=FINISHED` racing a late
 * event could also leave no finalization that ever saw the event, because the
 * event path decided whether to re-finalize from a status read before its
 * insert.
 *
 * Every writer now takes `utils/game-row-lock.ts#lockGameRow` first and
 * finalization reads and writes under it. This suite runs the real races
 * against Postgres and asserts, after each round, that the stored team points
 * equal `Game.homeScore` and that every shooter's `PlayerStats` row counts
 * every attempt. A third case holds the lock while a `PATCH { homeScore }` is
 * in flight and asserts the client value never lands over a shot (#666). The
 * service tests mock Prisma call by call and cannot see an interleaving.
 *
 * All three fail on the pre-fix code: the first with a Postgres deadlock
 * (`40P01`, two inserts each holding KEY SHARE and then asking FOR UPDATE),
 * the second with a box score missing the late shot, the third with
 * `homeScore` 10 instead of 2.
 */

jest.unmock('../../src/models');

import prisma from '../../src/models';
import { GameEventService } from '../../src/services/game-event-service';
import { GameService } from '../../src/services/game-service';
import { DbFixtures, Org } from '../support/db-fixtures';
import { backendPid, waitForBlockedBy } from '../support/db-locks';

jest.setTimeout(60000);

const ROUNDS = 10;

const fx = new DbFixtures(prisma, 'StatsFinalize');
let org: Org;
let coachId: string;
let shooterA: string;
let shooterB: string;

const shot = (playerId: string, points: 2 | 3) =>
  ({ playerId, eventType: 'SHOT', metadata: { made: true, points } }) as const;

interface StoredState {
  homeScore: number;
  teamPoints: number | null;
  byPlayer: Map<string, { playerId: string; points: number; fieldGoalsAttempted: number }>;
}

/** The stored box score and the derived score of one game. */
async function storedState(gameId: string): Promise<StoredState> {
  const [game, teamStats, playerStats] = await Promise.all([
    prisma.game.findUniqueOrThrow({ where: { id: gameId }, select: { homeScore: true } }),
    prisma.teamStats.findUnique({
      where: { teamId_gameId: { teamId: org.teamId, gameId } },
      select: { points: true, fieldGoalsAttempted: true },
    }),
    prisma.playerStats.findMany({
      where: { gameId },
      select: { playerId: true, points: true, fieldGoalsAttempted: true },
    }),
  ]);
  return {
    homeScore: game.homeScore,
    teamPoints: teamStats?.points ?? null,
    byPlayer: new Map(playerStats.map((row) => [row.playerId, row])),
  };
}

beforeAll(async () => {
  await fx.requireDatabase();
  org = await fx.org('team');
  coachId = await fx.user('coach', 'COACH');
  await fx.staff(coachId, org);
  shooterA = await fx.user('shooter-a', 'PLAYER');
  shooterB = await fx.user('shooter-b', 'PLAYER');
  await fx.member(shooterA, org);
  await fx.member(shooterB, org);
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('finalizeGameStats under overlapping writes (#724)', () => {
  it('two concurrent SHOT creates on a FINISHED game leave TeamStats equal to homeScore every round', async () => {
    const gameId = await fx.game(org, { status: 'FINISHED' });

    for (let round = 1; round <= ROUNDS; round++) {
      await Promise.all([
        GameEventService.createEvent(gameId, shot(shooterA, 2), coachId),
        GameEventService.createEvent(gameId, shot(shooterB, 3), coachId),
      ]);

      const state = await storedState(gameId);
      expect(state.homeScore).toBe(round * 5);
      expect({ round, teamPoints: state.teamPoints }).toEqual({ round, teamPoints: state.homeScore });
      expect(state.byPlayer.get(shooterA)).toMatchObject({ points: round * 2, fieldGoalsAttempted: round });
      expect(state.byPlayer.get(shooterB)).toMatchObject({ points: round * 3, fieldGoalsAttempted: round });
    }
  });

  it('a PATCH status=FINISHED racing a late SHOT create still stores a box score that includes the shot', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const gameId = await fx.game(org, { status: 'IN_PROGRESS' });

      await Promise.all([
        GameService.updateGame(gameId, { status: 'FINISHED' }, coachId),
        GameEventService.createEvent(gameId, shot(shooterA, 2), coachId),
      ]);

      const state = await storedState(gameId);
      expect(state.homeScore).toBe(2);
      expect({ round, teamPoints: state.teamPoints }).toEqual({ round, teamPoints: 2 });
      expect(state.byPlayer.get(shooterA)).toMatchObject({ points: 2, fieldGoalsAttempted: 1 });
    }
  });

  it('a PATCH homeScore that read the log before a SHOT committed cannot persist the client value (#666)', async () => {
    const gameId = await fx.game(org, { status: 'IN_PROGRESS' });
    let patch: Promise<unknown> | undefined;

    // Hold the game-row lock the way an in-flight SHOT write does, start the
    // PATCH while it is held, then insert the shot and commit. Unlocked, the
    // PATCH reads "no shots", waits only at its UPDATE, and writes 10 over the
    // derived 2; under the lock it waits before reading and sees the shot.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Game" WHERE "id" = ${gameId} FOR UPDATE`;
      const pid = await backendPid(tx);
      patch = GameService.updateGame(gameId, { homeScore: 10, awayScore: 20 }, coachId);
      patch.catch(() => undefined); // awaited below; keeps a rejection from going unhandled meanwhile
      // Proceed once the PATCH is actually waiting on this lock, not after a guess.
      await waitForBlockedBy(tx, pid, { timeoutMs: 2000 });
      await tx.gameEvent.create({
        data: { gameId, playerId: shooterA, eventType: 'SHOT', metadata: { made: true, points: 2 } },
      });
      await tx.game.update({ where: { id: gameId }, data: { homeScore: 2 } });
    });
    await patch;

    const game = await prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { homeScore: true, awayScore: true },
    });
    expect(game).toEqual({ homeScore: 2, awayScore: 20 });
  });
});
