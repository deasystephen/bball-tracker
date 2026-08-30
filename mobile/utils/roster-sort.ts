/**
 * Roster ordering helpers.
 *
 * The backend returns team members jersey-sorted (asc, nulls last, name
 * tiebreak, then `id` — `TEAM_INCLUDE.members` in team-service.ts and the
 * game-detail mirror in game-service.ts), so screens fed by those two
 * payloads inherit the order; other roster queries are still unordered.
 * Screens that offer a sort choice derive it ONLY through
 * `sortRosterMembers` — same never-inline rule as `utils/game-result.ts`.
 */

export type RosterSortKey = 'jersey' | 'name';

export function isRosterSortKey(value: unknown): value is RosterSortKey {
  return value === 'jersey' || value === 'name';
}

interface SortableMember {
  jerseyNumber?: number | null;
  player: { name: string };
}

function compareName(a: SortableMember, b: SortableMember): number {
  return a.player.name.localeCompare(b.player.name, undefined, { sensitivity: 'base' });
}

function compareJersey(a: SortableMember, b: SortableMember): number {
  // Jersey 0 is a valid number — test `!= null`, never truthiness.
  const av = a.jerseyNumber;
  const bv = b.jerseyNumber;
  if (av != null && bv != null) return av - bv;
  if (av != null) return -1;
  if (bv != null) return 1;
  return 0;
}

/** Returns a new array; the input is never mutated. */
export function sortRosterMembers<T extends SortableMember>(
  members: T[],
  key: RosterSortKey
): T[] {
  return [...members].sort((a, b) =>
    key === 'name'
      ? compareName(a, b) || compareJersey(a, b)
      : compareJersey(a, b) || compareName(a, b)
  );
}
