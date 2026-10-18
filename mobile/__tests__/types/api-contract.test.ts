/**
 * Client type / backend payload parity (#767).
 *
 * The mobile response types are hand-written; the backend's named
 * `*_SELECT` / `*_INCLUDE` constants are the contract. Each fixture under
 * `__tests__/fixtures/api-contract/` was recorded from a local backend at
 * `main` after PR #875 (#813, the shared `USER_SUMMARY_SELECT`; re-recorded
 * for #889 on 2026-10-17) with `POST /auth/dev-login` against the seed, and
 * trimmed to one or two list items. Assigning a fixture to its client type below is checked by
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
 * | `game-events.json` | `GET /games/:id/events` items | `EVENT_PLAYER_SELECT` (`services/game-event-service.ts`) |
 * | `box-score.json` | `GET /stats/games/:id` `boxScore` | `PlayerGameStats` (`services/stats-service.ts`) |
 * | `team-player-stats.json` | `GET /stats/teams/:id/players` item | `AggregatedPlayerStats` |
 * | `guardian-list.json` | `GET /teams/:t/members/:p/guardians` | `GuardianSummary` (`services/guardian-service.ts`) |
 * | `game-rsvps.json` | `GET /games/:id/rsvps` items | `RsvpView` (`services/rsvp-service.ts`) |
 * | `league-detail.json` | `GET /leagues/:id` (league admin view) | `LEAGUE_DETAIL_INCLUDE` (`services/league-service.ts`) |
 * | `announcement-list-item.json` | `GET /teams/:id/announcements` item | `ANNOUNCEMENT_INCLUDE` (`services/announcement-service.ts`) |
 * | `announcement-replies.json` | `GET /announcements/:id/replies` items | `REPLY_INCLUDE` (`services/announcement-reply-service.ts`) |
 * | `player-overall-stats.json` | `GET /stats/players/:id` | `getPlayerOverallStats` (`services/stats-service.ts`) |
 *
 * Recording: start the backend from `backend/` on a spare port
 * (`npx prisma db seed`, then `PORT=3101 npx tsx src/index.ts`), sign in with
 * `POST /api/v1/auth/dev-login` as `steve.kerr@` (coach: teams, games, stats,
 * guardians), `steph.curry@` (player view of `GET /games/:id`),
 * `gloria.james@` (session user with `guardianOf`) and `frank.vogel@`
 * (`GET /invitations?teamId=` for the Lakers), `admin@bball-tracker.com`
 * (league admin view of `GET /leagues/:id`), and copy each response body.
 * The seed has no RSVPs, announcements or player-less events: create them
 * through the API on the throwaway backend (Dell RSVPs for Steph and Kerr for
 * himself on the Celtics game, Kerr posts an announcement and Steph replies,
 * Kerr records a `TIMEOUT` without `playerId`), record, then delete them and
 * re-seed.
 *
 * Hand-made variants, each a value the backend types allow but the seed does
 * not produce: the second session user (Gloria's recorded payload with an avatar), the
 * second game-detail member (`jerseyNumber`, `position` and `email` null), the
 * third game-detail member (the non-manager view, recorded as a player, with
 * no `email` key) and the second invitation (`player.email` and
 * `invitedBy.email` null; `User.email` is `String?`) and the third RSVP
 * (`user.email` null: a guardian's RSVP for a managed child).
 *
 * Every user summary (`USER_SUMMARY_SELECT`: `isManaged`, `deletedAt`) and
 * every flattened tombstone field (`playerDeletedAt`, `childDeletedAt`,
 * `inviterDeletedAt`) is REQUIRED in the client types since #889, so a fixture
 * that loses one fails `tsc`, and the `Not<IsOptional<…>>` assertions below
 * fail if a type makes one optional again. Kept optional on purpose:
 * `Player.isManaged`/`deletedAt` (the `GET /players` list, `PLAYER_SELECT`,
 * omits both) and `GuardianOfEntry.isManaged` (persisted session state: a user
 * stored before #875 lacks it until `GET /auth/me` refreshes it). The
 * runtime checks pin presence and `string | null`, never the value, so a
 * hand-made tombstone variant fits. The guardian invitation views
 * (`GET /invitations` `guardianInvitations`, the public by-token lookup) have
 * no fixture; their required fields are pinned by type assertion only.
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

import type { GuardianOfEntry, User } from '../../../shared/types';
import type { Team, TeamMember, TeamStaff } from '../../hooks/useTeams';
import type { GuardianInvitationView, TeamInvitation } from '../../hooks/useInvitations';
import type { GuardianInvitationByToken, TeamInvitationByToken } from '../../hooks/useInvitationByToken';
import type { GuardianList } from '../../hooks/useGuardians';
import type { Player } from '../../hooks/usePlayers';
import type { Announcement } from '../../hooks/useAnnouncements';
import type { AnnouncementReply } from '../../hooks/useAnnouncementReplies';
import type { League, LeagueAdmin } from '../../hooks/useLeagues';
import type { Game, GameEvent, GameRosterMember, GameRsvp } from '../../types/game';
import type { AggregatedPlayerStats, BoxScore, PlayerGameStats, PlayerOverallStats } from '../../types/stats';

import sessionUsers from '../fixtures/api-contract/auth-session-user.json';
import teamListItem from '../fixtures/api-contract/team-list-item.json';
import teamDetail from '../fixtures/api-contract/team-detail.json';
import gameListItem from '../fixtures/api-contract/game-list-item.json';
import gameDetail from '../fixtures/api-contract/game-detail.json';
import invitationItems from '../fixtures/api-contract/invitation-list-item.json';
import playerDetail from '../fixtures/api-contract/player-detail.json';
import gameEventItems from '../fixtures/api-contract/game-events.json';
import boxScoreFixture from '../fixtures/api-contract/box-score.json';
import teamPlayerStats from '../fixtures/api-contract/team-player-stats.json';
import guardianList from '../fixtures/api-contract/guardian-list.json';
import rsvpItems from '../fixtures/api-contract/game-rsvps.json';
import leagueDetail from '../fixtures/api-contract/league-detail.json';
import announcementItem from '../fixtures/api-contract/announcement-list-item.json';
import replyItems from '../fixtures/api-contract/announcement-replies.json';
import overallStats from '../fixtures/api-contract/player-overall-stats.json';

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
const events: Wire<GameEvent>[] = gameEventItems;
const boxScore: Wire<BoxScore> = boxScoreFixture;
const seasonRows: Wire<AggregatedPlayerStats>[] = teamPlayerStats;
const guardians: Wire<GuardianList> = guardianList;
const rsvps: Wire<GameRsvp>[] = rsvpItems;
const league: Wire<League> = leagueDetail;
const announcement: Wire<Announcement> = announcementItem;
const replies: Wire<AnnouncementReply>[] = replyItems;
const overall: Wire<PlayerOverallStats> = overallStats;

/** Present, and a timestamp or `null` (never a fixed value: tombstone variants are allowed). */
function expectTombstoneField(value: object, key: string): void {
  expect(value).toHaveProperty(key);
  const field = (value as Record<string, unknown>)[key];
  expect(field === null || typeof field === 'string').toBe(true);
}

/** True when `K` is a required key of `T` (the #889 tombstone fields). */
type IsRequired<T, K extends keyof T> = Not<IsOptional<T, K>>;

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

  it('user summaries carry isManaged and deletedAt, required in every client type (#889)', () => {
    assertType<IsRequired<TeamStaff['user'], 'isManaged'>>();
    assertType<IsRequired<TeamStaff['user'], 'deletedAt'>>();
    assertType<IsRequired<TeamMember['player'], 'isManaged'>>();
    assertType<IsRequired<TeamMember['player'], 'deletedAt'>>();
    assertType<IsRequired<GameMember['player'], 'isManaged'>>();
    assertType<IsRequired<GameMember['player'], 'deletedAt'>>();
    assertType<IsRequired<NonNullable<GameEvent['player']>, 'isManaged'>>();
    assertType<IsRequired<NonNullable<GameEvent['player']>, 'deletedAt'>>();
    assertType<IsRequired<TeamInvitation['player'], 'isManaged'>>();
    assertType<IsRequired<TeamInvitation['player'], 'deletedAt'>>();
    assertType<IsRequired<TeamInvitation['invitedBy'], 'isManaged'>>();
    assertType<IsRequired<TeamInvitation['invitedBy'], 'deletedAt'>>();
    assertType<IsRequired<Announcement['author'], 'isManaged'>>();
    assertType<IsRequired<Announcement['author'], 'deletedAt'>>();
    assertType<IsRequired<AnnouncementReply['author'], 'isManaged'>>();
    assertType<IsRequired<AnnouncementReply['author'], 'deletedAt'>>();
    assertType<IsRequired<GameRsvp['user'], 'isManaged'>>();
    assertType<IsRequired<GameRsvp['user'], 'deletedAt'>>();
    assertType<IsRequired<LeagueAdmin['user'], 'isManaged'>>();
    assertType<IsRequired<LeagueAdmin['user'], 'deletedAt'>>();
    assertType<IsRequired<PlayerOverallStats['player'], 'isManaged'>>();
    assertType<IsRequired<PlayerOverallStats['player'], 'deletedAt'>>();
    // `GET /players` (PLAYER_SELECT) omits both; only the detail sends them.
    assertType<IsOptional<Player, 'isManaged'>>();
    assertType<IsOptional<Player, 'deletedAt'>>();
    assertType<AcceptsNull<Player['deletedAt']>>();
    expectTombstoneField(player, 'deletedAt');
    // A player-less event (a timeout) carries `player: null`.
    assertType<AcceptsNull<GameEvent['player']>>();
    assertType<IsRequired<GameEvent, 'player'>>();
    expect(events.some((e) => e.player === null)).toBe(true);
    // A user without an address: `null`, like the sibling summaries.
    assertType<AcceptsNull<GameRsvp['user']['email']>>();
    assertType<AcceptsNull<LeagueAdmin['user']['email']>>();
    expect(rsvps.some((r) => r.user.email === null)).toBe(true);
    expect(rsvps.some((r) => !('email' in r.user))).toBe(true);

    const summaries = [
      ...(teamItem.staff ?? []).map((s) => s.user),
      ...(teamFull.staff ?? []).map((s) => s.user),
      ...(teamFull.members ?? []).map((m) => m.player),
      ...(gameFull.team?.staff ?? []).map((s) => s.user),
      ...(gameFull.team?.members ?? []).map((m) => m.player),
      ...events.flatMap((e) => (e.player ? [e.player] : [])),
      ...invitations.flatMap((i) => [i.player, i.invitedBy]),
      ...rsvps.map((r) => r.user),
      ...(league.admins ?? []).map((a) => a.user),
      announcement.author,
      ...replies.map((r) => r.author),
      overall.player,
    ];
    expect(summaries.length).toBeGreaterThan(15);
    for (const summary of summaries) {
      expect(typeof summary.isManaged).toBe('boolean');
      expectTombstoneField(summary, 'deletedAt');
    }
  });

  it('stats rows carry playerDeletedAt (#889)', () => {
    assertType<IsRequired<PlayerGameStats, 'playerDeletedAt'>>();
    assertType<IsRequired<AggregatedPlayerStats, 'playerDeletedAt'>>();
    const rows = [...boxScore.team.players, ...seasonRows, overall.careerTotals, ...overall.teams.map((t) => t.stats)];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expectTombstoneField(row, 'playerDeletedAt');
    }
  });

  it('guardian payloads carry their tombstone fields; guardian rows carry no isManaged (#889)', () => {
    assertType<IsRequired<GuardianOfEntry, 'childDeletedAt'>>();
    // Persisted session state: a user stored before #875 lacks it until `GET /auth/me` refreshes it.
    assertType<IsOptional<GuardianOfEntry, 'isManaged'>>();
    assertType<IsRequired<GuardianInvitationView, 'childDeletedAt'>>();
    assertType<IsRequired<GuardianInvitationView, 'inviterDeletedAt'>>();
    assertType<IsRequired<GuardianInvitationByToken, 'childDeletedAt'>>();
    assertType<IsRequired<GuardianInvitationByToken, 'inviterDeletedAt'>>();
    assertType<IsRequired<TeamInvitationByToken, 'inviterDeletedAt'>>();
    assertType<IsRequired<GuardianList['guardians'][number], 'deletedAt'>>();
    assertType<Not<HasKey<GuardianList['guardians'][number], 'isManaged'>>>();

    const guardianOf = users.flatMap((u) => u.guardianOf ?? []);
    expect(guardianOf.length).toBeGreaterThan(0);
    for (const entry of guardianOf) {
      expectTombstoneField(entry, 'childDeletedAt');
      expect(typeof entry.isManaged).toBe('boolean');
    }
    expect(guardians.guardians.length).toBeGreaterThan(0);
    for (const row of guardians.guardians) {
      expectTombstoneField(row, 'deletedAt');
      expect(row).not.toHaveProperty('isManaged');
    }
  });
});
