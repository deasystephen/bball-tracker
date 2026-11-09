/**
 * Row lock on a `League` row that serialises every writer of its seasons.
 */

import type { Prisma } from '@prisma/client';

/**
 * `SELECT … FOR NO KEY UPDATE` on the league's row inside an interactive
 * transaction.
 *
 * Every path that minds the season name rule takes this lock before it reads
 * the league's seasons and writes one: `findOrCreateSeason` (every season
 * create, the personal-league provisioning included), the season rollover
 * (`TeamService.rolloverTeam`, which takes it before the lineage lock) and the
 * season rename (`SeasonService.updateSeason`, #1008). Behind it a check and
 * its write are one unit, so two creates, or a rename and a create, can never
 * both land on case variants of one name.
 *
 * Lock order: User before League before Team/TeamLineage wherever several are
 * taken (the rollover's order). `FOR NO KEY UPDATE`, not `FOR UPDATE`: it
 * conflicts with itself, which is all the serialisation needs, but not with
 * the `FOR KEY SHARE` of a foreign-key insert naming the league (a season or
 * league-admin insert never waits on a sibling's name check; same reasoning
 * as `utils/team-row-lock.ts`).
 *
 * Returns whether the row exists.
 */
export async function lockLeagueRow(tx: Prisma.TransactionClient, leagueId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "League" WHERE "id" = ${leagueId} FOR NO KEY UPDATE`;
  return rows.length > 0;
}
