/**
 * Client type / backend payload parity (#767).
 *
 * The mobile response types are hand-written; the backend's named
 * `*_SELECT` / `*_INCLUDE` constants are the contract. Each fixture under
 * `__tests__/fixtures/api-contract/` was recorded from a local backend
 * (`POST /auth/dev-login` against the seed, 2026-10-17) and trimmed to one or
 * two list items. They predate PR #875 (#813: `inviterDeletedAt`,
 * `playerDeletedAt` and friends); re-record them once it is deployed. Assigning a fixture to its client type below is checked by
 * `npm run type-check` (`tsc --noEmit`). It fails CI on a REQUIRED client
 * field the API never sends and on a field typed non-null (or required) where
 * the API sends `null` (or omits the key). It does not catch an OPTIONAL
 * client field the API never sends: assigning a non-literal value performs no
 * excess-property check, and fixtures legitimately omit optional keys that
 * other endpoints send (a list item has no `members`). The explicit
 * assertions below pin the optional fields this test was written for:
 *
 * | Fixture | Endpoint | Backend shape |
 * | --- | --- | --- |
 * | `auth-session-user.json` | `/auth/callback`, `/auth/dev-login`, `GET /auth/me` | `SESSION_USER_SELECT` + `leagueAdminOf` + `guardianOf` (`api/auth/routes.ts`) |
 * | `team-list-item.json` | `GET /teams` item | `TEAM_LIST_INCLUDE` (`services/team-service.ts`) |
 * | `team-detail.json` | `GET /teams/:id` | `TEAM_DETAIL_INCLUDE` (trimmed lists) |
 * | `game-list-item.json` | `GET /games` item | `GAME_LIST_INCLUDE` (`services/game-service.ts`) |
 * | `game-detail.json` | `GET /games/:id` | `GameDetailView` |
 * | `invitation-list-item.json` | `GET /invitations` item | `INVITATION_SELECT` (`services/invitation-service.ts`) |
 * | `player-detail.json` | `GET /players/:id` | `PLAYER_DETAIL_SELECT` (`services/player-service.ts`) |
 *
 * Hand-made variants, each a value the backend types allow but the seed does
 * not produce: the second session user (a guardian with an avatar), the
 * second game-detail member (`jerseyNumber`, `position` and `email` null), the
 * third game-detail member (the non-manager view, recorded as a player, with
 * no `email` key) and the second invitation (`player.email` and
 * `invitedBy.email` null; `User.email` is `String?`).
 *
 * Why fixtures and not a type import from `backend/src/services`: CI's mobile
 * lint-and-typecheck job installs only `mobile/` dependencies, so a relative
 * import of a backend service pulls in `@prisma/client` and `express`, which
 * that job cannot resolve. When a backend constant changes, re-record the
 * matching fixture (run the backend locally, call the endpoint, trim lists).
 *
 * JSON imports widen string literals to `string`, so `Wire<T>` widens the
 * client's string unions the same way; everything else (presence, optional
 * keys, `null`) is compared exactly.
 */

import type { User } from '../../../shared/types';
import type { Team } from '../../hooks/useTeams';
import type { TeamInvitation } from '../../hooks/useInvitations';
import type { Player } from '../../hooks/usePlayers';
import type { Game, GameRosterMember } from '../../types/game';

import sessionUsers from '../fixtures/api-contract/auth-session-user.json';
import teamListItem from '../fixtures/api-contract/team-list-item.json';
import teamDetail from '../fixtures/api-contract/team-detail.json';
import gameListItem from '../fixtures/api-contract/game-list-item.json';
import gameDetail from '../fixtures/api-contract/game-detail.json';
import invitationItems from '../fixtures/api-contract/invitation-list-item.json';
import playerDetail from '../fixtures/api-contract/player-detail.json';

/** The client type as it looks after a JSON round trip: string unions widen to `string`. */
type Wire<T> = T extends string
  ? string
  : T extends (infer E)[]
    ? Wire<E>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

type GameMember = GameRosterMember;

/** Compile-time assertion; the call is a runtime no-op. */
function assertType<T extends true>(): T | undefined {
  return undefined;
}
type AcceptsNull<T> = null extends T ? true : false;
type IsOptional<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<B extends boolean> = B extends true ? false : true;

// Each assignment is the parity check (tsc); the runtime expectations pin the
// fixture facts the client types were corrected for, so a re-recorded fixture
// that loses a variant fails here instead of weakening the check.
const users: Wire<User>[] = sessionUsers;
const teamItem: Wire<Team> = teamListItem;
const teamFull: Wire<Team> = teamDetail;
const gameItem: Wire<Game> = gameListItem;
const gameFull: Wire<Game> = gameDetail;
const invitations: Wire<TeamInvitation>[] = invitationItems;
const player: Wire<Player> = playerDetail;

describe('client types match the recorded backend payloads', () => {
  it('auth user: timestamps are strings, no updatedAt, email nullable', () => {
    assertType<AcceptsNull<User['email']>>();
    assertType<IsOptional<User, 'createdAt'>>();
    assertType<Not<HasKey<User, 'updatedAt'>>>();
    for (const user of users) {
      expect(typeof user.createdAt).toBe('string');
      expect(user).not.toHaveProperty('updatedAt');
    }
  });

  it('GET /teams list items carry no season.isActive; the detail does', () => {
    assertType<IsOptional<NonNullable<Team['season']>, 'isActive'>>();
    expect(teamItem.season).not.toHaveProperty('isActive');
    expect(typeof teamFull.season?.isActive).toBe('boolean');
  });

  it('GET /games/:id roster members: nullable jersey/position, email only for roster managers', () => {
    assertType<AcceptsNull<GameMember['jerseyNumber']>>();
    assertType<AcceptsNull<GameMember['position']>>();
    assertType<AcceptsNull<GameMember['player']['email']>>();
    assertType<IsOptional<GameMember['player'], 'email'>>();
    assertType<IsOptional<NonNullable<NonNullable<Game['team']>['season']>, 'isActive'>>();

    const members = gameFull.team?.members ?? [];
    expect(members.some((m) => m.jerseyNumber === null)).toBe(true);
    expect(members.some((m) => !('email' in m.player))).toBe(true);
    expect(members.every((m) => 'isManaged' in m.player && 'deletedAt' in m.player)).toBe(true);
    expect(gameItem.team?.season).not.toHaveProperty('isActive');
  });

  it('GET /invitations items: user emails nullable, no season.isActive', () => {
    assertType<AcceptsNull<TeamInvitation['player']['email']>>();
    // `GET /invitations/:id` omits it for a caller who is neither manager nor invitee.
    assertType<IsOptional<TeamInvitation['player'], 'email'>>();
    assertType<AcceptsNull<TeamInvitation['invitedBy']['email']>>();
    assertType<Not<HasKey<TeamInvitation['team']['season'], 'isActive'>>>();
    expect(invitations.some((i) => i.player.email === null && i.invitedBy.email === null)).toBe(true);
    for (const invitation of invitations) {
      expect(invitation.team.season).not.toHaveProperty('isActive');
    }
  });

  it('GET /players/:id teamMembers nest team.season.league', () => {
    const membership = player.teamMembers?.[0];
    expect(membership?.team.season.league.name).toEqual(expect.any(String));
    expect(membership?.team).not.toHaveProperty('league');
  });
});
