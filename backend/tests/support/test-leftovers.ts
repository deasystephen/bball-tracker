/**
 * Finding and removing the rows that real-database suites create (#584).
 *
 * `tests/integration/*.db.test.ts` write real rows. Each suite names every row
 * with a per-run id, 8 hex characters:
 *
 *     user    name `<key>-<run>`, email `<local>.<run>@example.test`
 *     league  name `ZZ-<label>-<run>`
 *     team    name `<label>-<run>`
 *
 * Two callers:
 *
 * - **A suite, in `afterAll`:** `removeTestRows(prisma, { run })`. It finds its
 *   rows by the run id, not by a list of ids collected along the way, so a
 *   test that throws before it records what it created still cleans up.
 * - **The seed:** `removeTestRows(prisma, 'all')`, for what an interrupted run
 *   left behind. `npx prisma db seed` is documented as the complete reset
 *   between Maestro flows; before this it left such rows in place, and 26 of
 *   them once filled the developer login list.
 *
 * Never run the `'all'` scope from a test: suites run in parallel against one
 * database, and it would delete the rows of a suite that is still running.
 *
 * WHAT IS NEVER MATCHED. Seeded fixtures use `@example.com` and
 * `@bball-tracker.com` addresses and plain names. Nothing here matches an
 * address outside `@example.test`, and a row with no address is matched only
 * when its name ends in `-` plus 8 hex characters.
 */

import type { PrismaClient } from '@prisma/client';

export const TEST_EMAIL_DOMAIN = 'example.test';

/** Rows of one run, or everything any run left behind. */
export type TestRowScope = 'all' | { run: string; alsoUserIds?: string[] };

export interface TestRowIds {
  userIds: string[];
  leagueIds: string[];
  teamIds: string[];
  lineageIds: string[];
}

export interface RemovedTestRows {
  users: number;
  leagues: number;
  teams: number;
  games: number;
  invitations: number;
}

/** The subset of the client this module needs; a transaction client fits too. */
type Db = Pick<
  PrismaClient,
  '$queryRaw' | 'user' | 'league' | 'team' | 'teamLineage' | 'game' | 'teamInvitation' | 'guardianInvitation'
>;

const RUN_ID = /^[0-9a-f]{8}$/;
const ANY_RUN = '[0-9a-f]{8}';

/** POSIX patterns, used by Postgres (`~`) and, in the tests, by JavaScript. */
export function testRowPatterns(scope: TestRowScope): { email: string; suffix: string; league: string } {
  const run = scope === 'all' ? ANY_RUN : scope.run;
  if (scope !== 'all' && !RUN_ID.test(run)) {
    throw new Error(`A run id is 8 lower-case hex characters, got "${run}"`);
  }
  return {
    // Compared with the lower-cased address: suites store mixed case on purpose.
    email: `\\.${run}@example\\.test$`,
    suffix: `-${run}$`,
    league: `^ZZ-.*-${run}$`,
  };
}

/**
 * Refuses to touch anything but a local or test database. Same two signals as
 * the seed: the realistic accident is a local shell with DATABASE_URL pointed
 * at production, not NODE_ENV=production.
 */
export function assertNotProductionDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const looksLikeProdDb = /rds\.amazonaws\.com/i.test(env.DATABASE_URL ?? '');
  if (env.NODE_ENV === 'production' || looksLikeProdDb) {
    throw new Error(
      'Refusing to remove test rows: NODE_ENV=production or DATABASE_URL points at an RDS host.'
    );
  }
}

/** The rows a scope covers. Reads only. */
export async function findTestRows(db: Db, scope: TestRowScope): Promise<TestRowIds> {
  const patterns = testRowPatterns(scope);
  const extraUserIds = scope === 'all' ? [] : (scope.alsoUserIds ?? []);

  const users = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User"
    WHERE lower("email") ~ ${patterns.email}
       OR ("email" IS NULL AND "name" ~ ${patterns.suffix})
  `;
  const userIds = [...new Set([...users.map((row) => row.id), ...extraUserIds])];

  // A suite that creates a team through TeamService gets a personal league
  // for its coach; that league carries no run id, only its owner.
  const leagues = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "League" WHERE "name" ~ ${patterns.league}
  `;
  const personal =
    userIds.length > 0
      ? await db.league.findMany({ where: { personalOwnerId: { in: userIds } }, select: { id: true } })
      : [];
  const leagueIds = [...new Set([...leagues.map((row) => row.id), ...personal.map((row) => row.id)])];

  const named = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Team" WHERE "name" ~ ${patterns.suffix}
  `;
  const teams = await db.team.findMany({
    where: {
      OR: [
        { id: { in: named.map((row) => row.id) } },
        ...(leagueIds.length > 0 ? [{ season: { leagueId: { in: leagueIds } } }] : []),
      ],
    },
    select: { id: true, lineageId: true },
  });

  return {
    userIds,
    leagueIds,
    teamIds: teams.map((team) => team.id),
    lineageIds: [...new Set(teams.map((team) => team.lineageId))],
  };
}

/** Removes the rows a scope covers, in the order the foreign keys allow. */
export async function removeTestRows(db: Db, scope: TestRowScope): Promise<RemovedTestRows> {
  assertNotProductionDatabase();
  const { userIds, leagueIds, teamIds, lineageIds } = await findTestRows(db, scope);

  // `invitedById` has no cascade on either invitation table, so these go first.
  const guardianInvitations = await db.guardianInvitation.deleteMany({
    where: {
      OR: [
        { invitedById: { in: userIds } },
        { childId: { in: userIds } },
        { teamId: { in: teamIds } },
      ],
    },
  });
  const teamInvitations = await db.teamInvitation.deleteMany({
    where: {
      OR: [
        { invitedById: { in: userIds } },
        { playerId: { in: userIds } },
        { teamId: { in: teamIds } },
      ],
    },
  });

  const games = await db.game.deleteMany({ where: { teamId: { in: teamIds } } });
  // A league takes its seasons and their teams with it.
  const leagues = await db.league.deleteMany({ where: { id: { in: leagueIds } } });
  // Teams a suite created in a league that is not its own.
  await db.team.deleteMany({ where: { id: { in: teamIds } } });
  // A lineage survives its teams; remove the ones nothing refers to any more.
  await db.teamLineage.deleteMany({ where: { id: { in: lineageIds }, teams: { none: {} } } });
  const users = await db.user.deleteMany({ where: { id: { in: userIds } } });

  return {
    users: users.count,
    leagues: leagues.count,
    teams: teamIds.length,
    games: games.count,
    invitations: guardianInvitations.count + teamInvitations.count,
  };
}
