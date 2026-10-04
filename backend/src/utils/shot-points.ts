/**
 * The one rule for what a SHOT event is worth (#723).
 *
 * `Game.homeScore` (`GameEventService.computeHomeScore`) and the box score
 * (`StatsService.calculatePlayerStats`) both read SHOT metadata through these
 * helpers, so the derived score and the team's box-score points are the same
 * function of the event log. The API only accepts `{ made: boolean, points:
 * 1 | 2 | 3 }` (`api/games/schemas.ts#shotMetadataSchema`); the defensive
 * handling here is for rows already in the database.
 */

import type { Prisma } from '@prisma/client';

export type ShotValue = 1 | 2 | 3;

function asObject(metadata: Prisma.JsonValue | undefined): Record<string, unknown> {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * The shot's point value: `points` when it is 1, 2 or 3; 2 when `points` is
 * absent or `null` (legacy rows: the pre-#723 schema accepted `null`, and both
 * old scorers counted it as 2 via `points || 2`); `null` for any other value,
 * in which case the shot counts nowhere (neither score nor attempts).
 */
export function shotValue(metadata: Prisma.JsonValue | undefined): ShotValue | null {
  const { points } = asObject(metadata);
  if (points == null) return 2;
  return points === 1 || points === 2 || points === 3 ? points : null;
}

/** True only for a boolean `made: true`; a truthy string is not a make. */
export function shotMade(metadata: Prisma.JsonValue | undefined): boolean {
  return asObject(metadata).made === true;
}

/** Points the shot adds to the score: its value when made, otherwise 0. */
export function shotPoints(metadata: Prisma.JsonValue | undefined): 0 | ShotValue {
  const value = shotValue(metadata);
  return value !== null && shotMade(metadata) ? value : 0;
}
