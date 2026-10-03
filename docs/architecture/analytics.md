# Mobile analytics: the Amplitude event catalogue

The mobile app sends behavioural analytics to Amplitude through one module,
`mobile/services/analytics.ts`. This file is the catalogue: every event the app can send, when it
fires, what it carries and where it is emitted from. The code and this table are held together by
`mobile/__tests__/analytics/catalogue-guard.test.ts` (see "Enforcement"). Issue: #616. The
tracking options the SDK attaches to every event (device context, IP for coarse location) are a
separate decision, documented in `mobile-app.md` under "Analytics tracking options (#559)".

## Rules

- **Names** are `snake_case`, `<object>_<past-tense verb>` (`team_created`, `invitation_sent`).
  They live in `AnalyticsEvents`; `trackEvent` accepts nothing else, and `AnalyticsEventProps`
  types each event's properties, so a wrong or missing property fails `npm run type-check`.
- **No property may carry PII.** Never a name, an email, a jersey number, a message, a URL path
  with ids in it, or any free text a user typed. Ids (`team_id`, `game_id`), enums, counts and
  booleans only. An update event says *which fields* changed (`fields: "name,status"`), never the
  values. Errors send their `code`, `status` and route pattern, never the message.
- **Emit from the hook or store that performs the mutation**, never from a screen, so every screen
  that uses the hook is covered. The only screen-level emitters are the onboarding steps, which
  have no hook of their own, and the root layout's screen-view tracker.
- **Every call goes through `trackEvent`**, which swallows every SDK error: analytics can never
  crash the app. Events tracked before `initAnalytics` has resolved are held in a bounded buffer
  (`PRE_INIT_BUFFER_LIMIT`, 50) and sent in order once init succeeds, so the launch route's
  `screen_viewed` (fired by a child of the root layout, before its init effect) is not lost; they
  are dropped when there is no API key or init fails.
- **Identity is stamped at call time.** `amplitude.track` only enqueues, the SDK fills `user_id`
  on a later tick, and `reset()` is synchronous, so `trackEvent` passes the current user and
  device id as event options. That is what lets `user_logged_out` and `account_deleted`, tracked
  immediately before `resetUser()`, stay attributed to the account that ended.
- **A new event is a doc change in the same PR**: add the row here and, if it introduces a
  property name, the glossary entry. The guard test fails otherwise.
- **The privacy label follows the catalogue.** "Usage Data: Product Interaction" and
  "Identifiers: User ID" in `docs/release/app-store-submission.md` and the Amplitude bullet in
  the "Retention" section of `docs/runbooks/data-subject-requests.md` describe what is sent; a
  new category of property (anything beyond ids, enums, counts, flags) changes them too.

## User properties

Set through Amplitude `identify`, never as event properties. `identifyUser(user.id, props)` runs at
login (`store/auth-store.ts#setUser`); `setUserProperties(partial)` refreshes a subset whenever its
source changes. `undefined` values are skipped, so a partial refresh never clears a property.

| Property | Type | Source | Refreshed |
| --- | --- | --- | --- |
| `role` | `ADMIN` / `COACH` / `PLAYER` / `PARENT` | `auth-store.ts#userPropertiesFrom` | login; `updateUser` with `role` or `guardianOf` |
| `is_parent` | boolean | role `PARENT`, or any guardian link (a coach can also be a parent) | same |
| `is_player` | boolean | role `PLAYER` | same |
| `app_version` | string | `expoConfig.version` (the binary's version; an OTA keeps it) | same |
| `is_head_coach` | boolean | a `HEAD_COACH` staff row of the caller's on any team | an unfiltered first page of `GET /teams` that holds every team (`teams.length >= total`, e.g. the `TEAMS_MAX_LIMIT` picker fetch), via `hooks/useTeams.ts#reportTeamUserProperties`; a partial page reports only the count, so the flag never flaps between page sizes |
| `is_assistant_coach` | boolean | an `ASSISTANT_COACH` staff row, same source | same |
| `team_count` | number | `total` of the unfiltered `GET /teams` | every unfiltered first page |
| `tier` | `FREE` / `PREMIUM` / `LEAGUE` | `GET /auth/me/usage` (`hooks/useUsage.ts`) | every usage fetch |

Logout (`clearSession`) calls `resetUser()`, which drops the user id and starts a new anonymous
device session.

## Screen views

`hooks/useScreenViews.ts#useScreenViewTracking` is mounted once in `app/_layout.tsx`
(`ScreenViewHandler`). It fires `screen_viewed` on every change of `usePathname()` with the
properties built by `screenViewFromSegments(useSegments())`: the **route pattern**
(`/teams/[id]/players`), never the path, so a team id or an invite token never leaves the device.
Moving from one team to another is a new view (the path changed) with the same `screen`. Re-renders
on the same path do not repeat it. Stats views (`/(tabs)/stats`, `/teams/[id]/stats`,
`/games/[id]/stats`, `/players/[id]/stats`) are read from this event; there is no separate
`stats_viewed`.

## Event catalogue

| Event | Fires when | Properties | Emitted from |
| --- | --- | --- | --- |
| `app_opened` | `initAnalytics` has succeeded on launch | none | `app/_layout.tsx` |
| `screen_viewed` | the route changes | `screen`, `params_kind` | `hooks/useScreenViews.ts` via `app/_layout.tsx` |
| `user_logged_in` | the signed-in user is stored (`setUser`) | none | `store/auth-store.ts` |
| `user_logged_out` | a session that was signed in ends | `reason`: `user`, `session_expired`, `account_deleted` | `store/auth-store.ts#clearSession` (reason passed by `logout`, `useDeleteAccount`, default for the api-client) |
| `onboarding_step_completed` | a first-login prompt is saved (not the Profile edit paths) | `step`: `name` / `role`; `role` (on the role step) | `app/onboarding/name.tsx`, `app/onboarding/role.tsx` |
| `profile_updated` | `PATCH /auth/me` succeeds | `name_changed`, `photo_changed`, `photo_cleared`, `reply_notifications_changed` | `hooks/useProfile.ts` |
| `account_deleted` | `DELETE /auth/me` succeeds, before the session is cleared | `erased` (hard-deleted rather than tombstoned) | `hooks/useAccount.ts` |
| `child_record_deleted` | a guardian deletes a managed child's record | none | `hooks/useAccount.ts` |
| `team_created` | `POST /teams` succeeds | `team_id`, `league_scope`: `personal` / `league`, `has_bracket` | `hooks/useTeams.ts` |
| `team_updated` | `PATCH /teams/:id` succeeds | `team_id`, `fields` | `hooks/useTeams.ts` |
| `team_deleted` | `DELETE /teams/:id` succeeds | `team_id` | `hooks/useTeams.ts` |
| `roster_player_added` | unified Add Player succeeds | `team_id`, `rostered`, `invited`, `guardian_invited`, `has_jersey`, `has_position`, `has_photo` | `hooks/useTeams.ts` |
| `roster_player_updated` | a roster entry's jersey or position is edited | `team_id`, `fields` | `hooks/useTeams.ts` |
| `roster_player_removed` | a player is removed from a roster | `team_id` | `hooks/useTeams.ts` |
| `player_updated` | `PATCH /players/:id` succeeds (coach edits a managed player) | `fields` | `hooks/usePlayers.ts` |
| `staff_added` | a staff member is added | `team_id`, `role_type`, `by`: `user_id` / `email` | `hooks/useTeamStaff.ts` |
| `staff_role_updated` | a staff member's role changes | `team_id`, `role_type` | `hooks/useTeamStaff.ts` |
| `staff_removed` | a staff member is removed | `team_id` | `hooks/useTeamStaff.ts` |
| `invitation_sent` | an invitation is created or re-sent | `team_id`, `invitation_id`, `resend`, `email_sent` (null when the player has no email) | `hooks/useInvitations.ts` |
| `invitation_accepted` | an invitation is accepted, in-app or from a link | `kind`: `team` / `guardian`, `source`: `in_app` / `link` | `hooks/useInvitations.ts`, `hooks/useInvitationByToken.ts` |
| `invitation_declined` | the invitee rejects | `invitation_id` | `hooks/useInvitations.ts` |
| `invitation_cancelled` | a coach cancels a pending invitation | `team_id`, `invitation_id` | `hooks/useInvitations.ts` |
| `guardian_invited` | a parent is invited for a roster player | `team_id`, `relationship` | `hooks/useGuardians.ts` |
| `guardian_removed` | a guardian link is removed | `team_id` | `hooks/useGuardians.ts` |
| `announcement_created` | a team announcement is posted | `team_id` | `hooks/useAnnouncements.ts` |
| `announcement_reply_created` | a reply is posted under an announcement (#34) | `team_id`, `announcement_id` | `hooks/useAnnouncementReplies.ts` |
| `announcement_reply_deleted` | a reply is removed by its author or a coach | `team_id`, `announcement_id`, `own` (the caller wrote it) | `hooks/useAnnouncementReplies.ts` |
| `league_created` | `POST /leagues` succeeds | `league_id` | `hooks/useLeagues.ts` |
| `league_updated` | `PATCH /leagues/:id` succeeds | `league_id` | `hooks/useLeagues.ts` |
| `league_deleted` | `DELETE /leagues/:id` succeeds | `league_id` | `hooks/useLeagues.ts` |
| `season_created` | `POST /seasons` succeeds | `season_id`, `league_id`, `has_dates` | `hooks/useSeasons.ts` |
| `season_updated` | `PATCH /seasons/:id` succeeds | `season_id`, `fields` | `hooks/useSeasons.ts` |
| `season_deleted` | `DELETE /seasons/:id` succeeds | `season_id` | `hooks/useSeasons.ts` |
| `game_created` | `POST /games` succeeds | `game_id`, `team_id` | `hooks/useGames.ts` |
| `game_updated` | `PATCH /games/:id` succeeds with no status change (opponent, date, away score) | `game_id`, `fields` | `hooks/useGames.ts` |
| `game_started` | `PATCH /games/:id { status: IN_PROGRESS }` succeeds | `game_id` | `hooks/useGames.ts` |
| `game_finished` | `PATCH /games/:id { status: FINISHED }` succeeds | `game_id` | `hooks/useGames.ts` |
| `game_deleted` | `DELETE /games/:id` succeeds | `game_id` | `hooks/useGames.ts` |
| `game_event_recorded` | the tracker's shot or stat is persisted | `game_id`, `event_type`; for a shot `shot_made`, `shot_points` | `hooks/useGameEvents.ts` |
| `game_event_undone` | the tracker's undo deletes an event | `game_id`, `event_type` (when the tracker knows it) | `hooks/useGameEvents.ts` |
| `rsvp_submitted` | an RSVP is saved | `game_id`, `status`, `on_behalf_of_child` | `hooks/useGames.ts` |
| `push_permission_answered` | the OS push prompt was shown and answered (not when already granted) | `granted` | `hooks/useNotifications.ts` |
| `notification_opened` | the user taps a push notification | `target`: `game` / `announcement` / `team` / `none` | `hooks/useNotifications.ts` |
| `entitlement_denied` | the API answers 402 `upgrade_required` | `endpoint_pattern`, `feature`, `current_tier`, `required_tier` | `services/api-client.ts#normalizeApiError` |
| `error_shown` | a screen asks for an error's message to show it (`getApiErrorMessage`) | `code`, `status` (null for a network failure), `endpoint_pattern` | `services/api-client.ts#getApiErrorMessage` |

### Not events (and why)

- **Stats viewed**: `screen_viewed` on the stats routes (above).
- **Box-score export** and **calendar subscribe**: the backend serves CSV export (#36) and the
  iCal feed (#32), but the app has no control for either today. Add `box_score_exported` /
  `calendar_subscribed` from the hook that gains the call.
- **Team rollover**: no mobile control yet (#461 lineage work); add `team_rolled_over` with it.
- **Profile photo**: part of `profile_updated` (`photo_changed`, `photo_cleared`); the roster
  photo is `has_photo` on `roster_player_added`. Picking the image is not an event, only saving it.
- **Sign-in started / dev login**: the only outcome that matters is `user_logged_in`.

## Properties glossary

| Property | Type | Meaning |
| --- | --- | --- |
| `team_id`, `game_id`, `league_id`, `season_id`, `invitation_id` | string (uuid) | the row the action touched |
| `screen` | string | Expo Router route pattern, `/teams/[id]` |
| `params_kind` | string | names of the route's dynamic segments (`id`, `id,playerId`, `token`) or `none` |
| `fields` | string | sorted, comma-joined keys of the payload that was sent (`changedFields`), never values |
| `reason` | enum | why a session ended: `user`, `session_expired`, `account_deleted` |
| `step` | enum | onboarding step: `name`, `role` |
| `role`, `role_type` | enum | global role (`COACH`, …); staff role type (`HEAD_COACH`, `ASSISTANT_COACH`, `TEAM_MANAGER`) |
| `league_scope` | enum | `personal` (caller's auto-provisioned league) or `league` (an explicit season) |
| `kind` | enum | invitation model: `team` or `guardian` |
| `source` | enum | where an invitation was accepted: `in_app` (Invitations tab) or `link` (`/invite/[token]`) |
| `by` | enum | how a staff member was identified: `user_id` (picker) or `email` |
| `relationship` | enum | `MOTHER`, `FATHER`, `GUARDIAN`, `OTHER` |
| `status` | string or number | RSVP answer (`YES`/`NO`/`MAYBE`) on `rsvp_submitted`; HTTP status on `error_shown` |
| `event_type` | enum | game event type (`SHOT`, `REBOUND`, …) |
| `shot_made`, `shot_points` | boolean, 1/2/3 | shot outcome; only on `event_type: SHOT` |
| `on_behalf_of_child` | boolean | a guardian answered for a child |
| `rostered`, `invited`, `guardian_invited` | boolean | what Add Player did (case 1–3 of the unification spec) |
| `has_*` | boolean | an optional input was supplied (`has_jersey`, `has_position`, `has_photo`, `has_bracket`, `has_dates`) |
| `*_changed`, `*_cleared` | boolean | which optional profile fields the save carried |
| `resend` | boolean | the invitation superseded a pending one |
| `email_sent` | boolean or null | per-send delivery flag from the API; null when there was no address |
| `erased` | boolean | the account row was deleted outright rather than tombstoned (#529) |
| `granted` | boolean | push permission outcome |
| `target` | enum | what a tapped notification opened: `game`, `team`, `none` |
| `endpoint_pattern` | string | `endpointPattern(url)`: redacted route with ids collapsed to `:id` (`/api/v1/teams/:id/players`) |
| `code` | string | server error code (`upgrade_required`, `last_head_coach`), axios code (`ECONNABORTED`), `http_error`, an Error's name, or `unknown` |
| `feature`, `current_tier`, `required_tier` | string | the 402 body's `feature`, `currentTier`, `requiredTier` (`unknown` when absent) |

## Enforcement

- `mobile/__tests__/analytics/catalogue-guard.test.ts` reads the source and fails when (a) an
  `AnalyticsEvents` entry has no row in the table above or a row names no entry, (b) an entry is
  never referenced as `AnalyticsEvents.KEY` anywhere in `mobile/` source, or (c) a `useMutation`
  in `mobile/hooks/` has no `trackEvent(` inside its `onSuccess` or `onSettled`. A hook may be
  exempt only through `MUTATIONS_WITHOUT_EVENTS` in that test, with a reason; the list fails when
  an entry no longer matches a silent hook. Today: `useCreatePlayer` and `useDeletePlayer`, which
  no screen calls.
- `mobile/__tests__/services/analytics.test.ts` pins the typed props map (`@ts-expect-error` on
  an ad-hoc name, a missing property, an extra property), the user-property helpers and the
  screen-view builder. `__tests__/hooks/useScreenViews.test.tsx` proves a path with a team id or
  an invite token never reaches `trackEvent`. `__tests__/services/api-client-analytics.test.ts`
  proves `error_shown` carries no message and `entitlement_denied` fires on every 402.
- The rule in `CLAUDE.md` (Mobile) and `.claude/rules/mobile.md`: every new user-facing mutation
  hook fires a catalogued event; new events go here in the same PR.

## Verifying live

On a dev build with `AMPLITUDE_API_KEY` set, sign in, create a team, add a player, send an
invitation, create a game, record a shot and finish the game; Amplitude's live stream should show
`user_logged_in` with the user properties, then `team_created`, `roster_player_added`,
`invitation_sent`, `game_created`, `game_started`, `game_event_recorded { event_type: SHOT }` and
`game_finished`, each with ids only, plus a `screen_viewed` per route pattern.
