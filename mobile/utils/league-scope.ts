/**
 * Personal-league scoping (#442).
 *
 * A coach who creates a team without picking a league gets a personal league +
 * season auto-provisioned by the backend, which flags those rows
 * `isPersonal: true` on `GET /leagues`. Such a coach never opted into the
 * league concept, so the league/season pickers are hidden from them entirely
 * (create) or not offered at all (edit — `team-service.ts` gates a `seasonId`
 * change on `isLeagueAdmin` of the target, which a personal-league coach never
 * has, so the picker would only ever produce a 403).
 *
 * Branch on "every visible league is personal", NEVER on league count: after
 * the first team the personal league exists, so a count test would show the
 * coach a picker for a concept they never chose when they create team #2.
 *
 * Derived values are never inlined in a screen (same rule as
 * `utils/game-result.ts`) — both the create and the edit screen import this.
 */

import type { League } from '../hooks/useLeagues';

/** Just the field the check needs, so callers can pass any league-ish row. */
type PersonalFlag = Pick<League, 'isPersonal'>;

export function isPersonalLeague(league: PersonalFlag): boolean {
  return league.isPersonal === true;
}

/**
 * True when the caller sees no league they actually chose — either nothing at
 * all, or only auto-provisioned personal containers.
 *
 * An empty list counts as all-personal (a brand-new coach has no league yet).
 * A backend predating #442 omits `isPersonal`, which reads as `false`, so
 * version skew degrades to showing the picker — the pre-#442 behaviour.
 */
export function areAllLeaguesPersonal(leagues: PersonalFlag[] | undefined | null): boolean {
  return (leagues ?? []).every(isPersonalLeague);
}
