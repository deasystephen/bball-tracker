# Authorization: leagues, seasons, teams, games, staff, players

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## League / season / team / game authorization

Authorization helpers live in `backend/src/utils/permissions.ts` (`isSystemAdmin`, `isLeagueAdmin`,
`canAccessTeam`, `getTeamPermissions`). Rules enforced in the services (audit fix plan
`docs/plans/audit-fix-plan-2026-08-22.md`, lane B):

- **Leagues & seasons** (`league-service.ts`, `season-service.ts`): **both the list and the detail
  endpoints are caller-scoped (#443).**
  - `GET /leagues` / `GET /seasons` AND a caller-access clause into the `where`. The clause is an id
    set from `utils/permissions.ts#getReadableLeagueIds(userId)` = league admin OR personal owner OR
    staff/member of a team in it OR guardian of such a member. The **same `where` object feeds `count`
    and `findMany`**, so `total` is the scoped count and never the global one, and `search` /
    `leagueId` / `isActive` are ANDed alongside it, never substituted for it — search must not be a
    scoping bypass. An empty id set short-circuits to `{ total: 0 }` with no query. System ADMINs are
    unscoped, except that personal leagues (#442) are excluded by default so admin listings do not
    accumulate one row per coach; `?includePersonal=true` opts back in.
  - The id set is resolved from the **Team** side (`team.findMany` filtered by the shared
    `teamAccessWhere`, selecting `season.leagueId`), not by scanning `League` with nested `some`
    clauses: after #442 the League table grows one row per coach, while this query is bounded by the
    caller's own teams. There is deliberately **no cap** — truncating an authorization set would make
    `total` lie.
  - `getLeagueById(id, userId)` / `getSeasonById(id, userId)` **404 for a caller with no affiliation**
    (`canReadLeague`), 404 rather than 403 so ids cannot be probed, matching
    `PlayerService.getPlayerById`. Before #443 these performed *no* access check at all: `isLeagueAdmin`
    only chose which `include` to use, so any authenticated caller who knew an id got every season and
    team name — and the id is not secret, since `TEAM_INCLUDE` hands it to every member and guardian.
    An affiliated non-admin still gets the stripped payload (metadata plus team `{ id, name }`); full
    detail with emails and rosters stays limited to system ADMINs and admins of that league.
  - Authorization denials elsewhere throw `ForbiddenError` (**403**, not 400); the league/season routes
    map any `AppError` to its `statusCode`. `PATCH /leagues/:id` enforces the same name-uniqueness rule
    as create (400 on duplicate).
  - **Tested against a real database.** `backend/tests/integration/league-access.db.test.ts` unmocks
    Prisma and runs against Postgres (CI already provides one). It uses one fixture user per access
    branch, each qualifying through exactly one — a negative-only test cannot catch a *dropped* branch,
    which is verified by mutation: removing the `members` branch fails only the positive test while
    every "sees none of org B" assertion stays green.
- **League admins (decision 3)**: `POST /leagues/:id/admins { userId }` (201, `userId` must be a UUID)
  and `DELETE /leagues/:id/admins/:userId` (404 if not an admin) are **system-ADMIN-only** — an existing
  league admin can no longer grant the role to others (`LeagueService.addLeagueAdmin` was tightened to
  match `removeLeagueAdmin`; revisit if delegated league administration becomes a product decision).
  The session user payload on `GET /auth/me`, `GET /auth/callback` and `POST /auth/dev-login` carries
  `leagueAdminOf: string[]` (league ids from `LeagueAdmin` rows, sorted; empty for most users, and **not**
  populated for system ADMINs, who are implied admins of every league via `role === 'ADMIN'`).
- **Global role is never an access check.** The self-selectable `User.role` (`COACH` / `PLAYER`) is
  only read by services to (a) short-circuit for `ADMIN` and (b) allow team creation. Everything
  "on behalf of another player" goes through `utils/permissions.ts#getPlayerTeamAccess(userId, playerId)`
  → `{ memberTeamIds, manageableTeamIds }` (teams the player is on / the subset the caller has
  `canManageRoster` on). `requireRole`, `requireFeature` and `requireUsageLimit` were removed from
  `api/auth/middleware.ts` — they were unmounted and contradicted the 402 entitlement contract.
- **Managed players (role matrix B2.10)**: `PATCH/DELETE /players/:id` for a managed player requires
  the caller to be its `managedById` **and** currently have `canManageRoster` on a team the player is
  rostered on, or — so create-then-edit works — the player is on no team yet and was created < 24h ago
  (`MANAGED_PLAYER_GRACE_MS`). A creator who has left the roster loses edit/delete/email rights; system
  ADMINs are unaffected. Consequence: deleting an un-rostered managed player older than 24h is admin-only.
- **Teams** (`team-service.ts`): `listTeams` always ANDs the caller's access clause with any
  `seasonId` / `leagueId` / `playerId` filter — only system ADMINs skip it. That clause is
  `utils/permissions.ts#teamAccessWhere(userId, childIds)` (staff OR member OR league admin OR guardian
  of a member); it lives there, not inline, so the league-access predicates share one definition with it
  and the two can never drift. **A copy did drift (#589):** `StatsService.getPlayerOverallStats` decided
  access with its own three-branch version (league admin, staff, member), so a guardian got 403 on
  `GET /stats/players/:childId`, the screen every My kids row opens. It now runs the shared clause in
  one query (`getAccessibleTeamIds`). Before writing "who may read this team" anywhere, use
  `canAccessTeam` for one team or `teamAccessWhere` for a set. Proven against real Postgres in
  `tests/integration/player-stats-access.db.test.ts` and, for `listTeams` / `listGames` with every
  filter, `tests/integration/list-access.db.test.ts`, one caller per branch (#458).
  `PATCH /teams/:id { seasonId }` moving a team into a different season requires
  `isLeagueAdmin` on the **target** season's league (in addition to `canManageTeam`), otherwise 403.
  `GET /teams/:id` includes `members[].player.email` only for callers with `canManageRoster`
  (head/assistant coach, league admin, system admin); players and stats-only staff get `{ id, name }`.
  Staff emails stay in the payload for every team member (coach contact info).
  **`GET /teams` list items carry the CALLER's own staff row** (`teamListInclude(userId)` — at most one
  per team, same shape as detail rows, nobody else's). The mobile permission helpers gate the Games-tab
  create FAB and the game-create team picker on it (`canManageAnyTeam` → `hasTeamPermission` needs
  `team.staff`); #396 shipped that gate against a staff-less list payload, which hid game creation from
  every coach for a week (#469) — self-serve coaches worst of all, since personal leagues are filtered
  out of `leagueAdminOf` (#442). Don't remove the join without changing the client gate.

### Self-serve team creation and personal leagues (#442)

`POST /teams` authorization is **two independent checks**, and they must stay separate:

- **WHO may create a team at all** — system ADMIN, `role === 'COACH'`, or an admin of any league.
  Unchanged from the pre-#442 rule.
- **WHERE they may create it** — only when `seasonId` is supplied:
  `utils/permissions.ts#canWriteLeague(userId, leagueId)` = league admin OR personal owner OR staff on
  some team in that league. This replaces the old `!canCreate && role !== 'COACH'` escape hatch, which
  let **any** COACH plant a team in **any** league (whose admin then got that roster, minors' emails
  included).

They are separate because the no-`seasonId` path has no target league to check. Folding WHO into WHERE
leaves that path ungated and any authenticated PLAYER or guardian can create a team and become its Head
Coach with all five flags. **Never use a read predicate as the write gate**: a player or guardian
rostered on a coach's team is a *member* of a team in that coach's personal league.

`createTeamSchema.seasonId` is **optional**. Omitted means "my own teams":
`TeamService.createTeam` resolves (creating on first use) the caller's personal league and its
current-year season, inside the **existing** `$transaction`, after the `SELECT … FOR UPDATE` and
**after** the tier cap check (dormant since #445) so a capped user would provision nothing.

- `League.personalOwnerId String? @unique` marks the container (migration
  `20260830000000_league_personal_owner`, `onDelete: SetNull` so deleting a user never cascades into
  seasons, teams and games). It is an **internal marker and never appears in a payload** — every
  `LEAGUE_*` read carries `omit: LEAGUE_OMIT` and every nested `league:` include omits it. The
  client-facing form is the derived `isPersonal` boolean on the league list (`personalOwnerId !== null`,
  not `=== caller.id`, so an ADMIN still sees another coach's container labelled personal).
- **There is no P2002 retry and none is needed.** The transaction opens by locking the caller's `User`
  row; `personalOwnerId` is unique per user and the season lives only in that user's own league, so the
  only writer that can contend is the same `userId` and it is serialized. Do not remove the lock
  believing a retry covers it. The three writes use `upsert` with a non-empty `update` that rewrites the
  unique key to itself — writing any other field would clobber a coach's later rename.
- The owner **does** get a real `LeagueAdmin` row (so they can rename the league and add next year's
  season, which unblocks rollover, #461), but personal leagues are filtered out of the `leagueAdminOf`
  array in `getLeagueAdminOf` (`api/auth/routes.ts`). So `canAccessAdmin` stays false and no
  "Leagues & Seasons" entry appears. Deliberate client/server divergence: backend rules are unchanged,
  only the client hint list is filtered.
- Season naming is the year of creation and **does not roll over** on its own (#461).
- Mobile branches on "every visible league is personal" (`mobile/utils/league-scope.ts`), never on league
  count — after the first team the personal league exists, so a count test would show team #2 a picker
  for a concept the coach never chose. The create and edit screens hide the league/season pickers in that
  case; the disclosure always offers a "My teams" default so a member-of-someone-else's-league who
  switches to COACH still has a valid choice.
- Fixture: `dana.whitfield@example.com` is seeded **PLAYER** with no team, staff or league admin row, so
  `.maestro/coach-onboarding.yaml` exercises the real funnel including picking Coach (every WorkOS
  sign-up starts as PLAYER). The seed also deletes teams left over from a previous E2E run, so every
  run starts from a coach with no teams (the flow exercises first-team provisioning, then reuse).
- The picker only ever renders the name-only path once #443's list scoping is in: `areAllLeaguesPersonal`
  reads `GET /leagues`, so while that list is global a new coach still sees a real league. #442 and #443
  are therefore one release in two commits, and `.maestro/coach-onboarding.yaml` is the gate for the pair.

- **Games** (`game-service.ts`): `updateGame` runs `canAccessTeam` **before** any field-specific branch
  (403 `You do not have access to this game` for unaffiliated users, regardless of body) and rejects a
  body with no updatable fields (`updateGameSchema` `.refine` → 400 `At least one field must be provided`;
  the service also throws `BadRequestError('No fields to update')` as defense in depth). Changing `status`
  or a score on a `FINISHED` game requires `canManageRoster` (head/assistant coach, league admin, system
  admin) — a `canTrackStats`-only Team Manager can no longer reopen or rewrite a final. `listGames`
  resolves the caller's team set with the shared `teamAccessWhere` (it carried its own copy of the
  clause until #458) and answers 403 for a `teamId` outside that set. Lane D owns the
  socket emit block at the bottom of `updateGame`; keep authz edits at the top of the function.
  `GET /games/:id` (`GameDetailView`) and `GET /games/:id/rsvps` (`RsvpView`) apply the team-detail
  email rule (role matrix B2.5): `team.members[].player.email` / `rsvps[].user.email` only for callers
  with `canManageRoster` (RSVP keeps the caller's own row intact); staff emails stay. `listGames` uses
  `GAME_LIST_INCLUDE` (no people at all).

## Team staff management (role matrix B2.3 / B2.7 / B2.8, decision 2)

Head Coach and Assistant Coach share the same five permission **flags**
(`canManageTeam/Roster/TrackStats/ViewStats/ShareStats`), so flag checks cannot
tell them apart. Staff management is keyed off the `TeamRole.type` enum instead
(no schema change): `utils/permissions.ts` exposes `isHeadCoach(userId, teamId)`
(HEAD_COACH-type staff row exists) and `canManageStaff(userId, teamId)` =
system `ADMIN` **or** admin of the team's league **or** head coach.

| Action | Head Coach | Assistant Coach | Team Manager | League admin / ADMIN |
| --- | --- | --- | --- | --- |
| Edit team name / chat link, roster, invitations | yes | yes | no | yes |
| Track / view / share stats | yes | yes | yes | yes |
| **Add / re-role / remove staff** | yes | no (403) | no | yes |
| **Delete team** (`DELETE /teams/:id`) | yes | no (403) | no | yes |
| **Move team to another season** (`PATCH /teams/:id { seasonId }`) | yes, **and** must admin the target league | no (403) | no | yes (target league) |
| Remove **self** from staff | yes, unless last head coach | yes | yes | n/a |

Routes (all under `/api/v1/teams/:teamId`, bearer auth, UUID params validated):

- `GET /staff` → `{ success, staff: [{ id, teamId, userId, roleId, createdAt, updatedAt, user: { id, name, isManaged, email? }, role: TeamRole }] }`. Any team member/staff/admin may read; `user.email` only for callers with `canManageRoster`.
- `GET /roles` → `{ success, roles: [{ id, teamId, type, name, description, canManageTeam, canManageRoster, canTrackStats, canViewStats, canShareStats }] }` (definitions only, no holders).
- `POST /staff { userId | email, roleType: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER' }` → **201** `{ success, staff }`. Exactly one of `userId`/`email`; `email` looks up an **existing** user (case-insensitive) and 404s otherwise — never creates users. 400 if the user is already staff (one role per user; use PATCH). Gate: `canManageStaff`. Added user gets a push notification (`type: 'team_staff_added'`).
- `PATCH /staff/:userId { roleType }` → `{ success, staff }`. Same gate. 404 if not staff, 400 if already that role or if demoting the **last head coach**.
- `DELETE /staff/:userId` → `{ success, message }`. Gate: `canManageStaff` **or** `:userId === caller` (self-removal). 400 when the target is the last head coach (even on self-removal).

POST/DELETE call `invalidateUsage(<affected userId>)` — staff membership is what the usage meter (and any tier team cap) counts.

**Distinct-teams cap fix (B2.8):** the team count (and any cap on it — none since #445) uses DISTINCT `teamId`s via
`countDistinctStaffTeams(userId, db?)` (`utils/permissions.ts`) in
`requireTeamCreateLimit`, `TeamService.createTeam` (inside the transaction) and
`usage-service.computeCounts` — a user holding two roles on one team is one
team. (The legacy `api/auth/middleware.ts#requireUsageLimit` that counted raw
`teamStaff` rows was removed along with `requireRole` / `requireFeature`.)

## Announcements and threaded replies (#34)
- Announcements are created and listed under `/teams/:teamId/announcements` (`canManageTeam` to
  post, `canAccessTeam` to read). `GET /announcements/:id` returns one announcement with its author
  and `_count.replies`; same gate as the list (404 unknown, 403 without access to its team).
- Replies (`AnnouncementReply`, one level deep, never reply-to-reply) live under
  `/announcements/:id/replies`. **Anyone who can read the team may reply** (`canAccessTeam`: staff,
  rostered players, guardians of players, league admins, ADMIN); `POST` is 404 for an unknown
  announcement and 403 without access. `GET` is the thread oldest first, `limit` 1-100 (default 20),
  `offset`. `DELETE /announcements/:id/replies/:replyId` is allowed to the reply's **author** or to
  anyone with **`canManageTeam`** on the team (head and assistant coach; a team manager cannot); a
  reply under a different announcement is a 404, not a hint. Services: `announcement-service.ts`
  (`getAnnouncement`) and `announcement-reply-service.ts`.
- Reply payloads carry the author's `id`, `name`, `profilePictureUrl` and `deletedAt` and never an
  email (reply authors are players and guardians, whose addresses only roster managers see).
- A new reply notifies the announcement's author by push and email in the background
  (`AnnouncementReplyService.notifyAuthor`) unless the author replied to their own post, has
  `User.notifyOnReplies` false (`PATCH /auth/me { notifyOnReplies }`, Profile → Reply notifications),
  or is a tombstone. Push data is `{ teamId, announcementId }`; the app opens the thread from it.
- Tests: `tests/api/announcement-replies.test.ts`, `tests/schemas/announcement-replies.test.ts`,
  `tests/services/announcement-reply-service.test.ts` (access, delete rules, notification triggers and
  the opt-out), the `getAnnouncement` block in `tests/services/announcement-service.test.ts`.

## Player directory (`/api/v1/players`)

`PlayerService.listPlayers(params, caller)` / `getPlayerById(id, caller)` take the authenticated caller (`{ id, role }`) and scope by it (audit #3):

- **ADMIN**: unscoped; may filter by `role` / `isManaged`; `search` matches name *or* email; `email` is included.
- **Everyone else**: only themselves plus users who share a team with them (teams they play on or are staff of); `role` / `isManaged` filters are ignored (always `PLAYER`, non-managed); `search` matches name only; `email` is omitted from list results and is `null` on detail unless it's the caller's own record. Players outside the caller's teams are a **404**, not a 403, so ids can't be enumerated.
- Team rosters (`GET /teams/:id`) remain the place coaches see their managed players; `USER_SUMMARY_SELECT` now includes `isManaged` so clients can label roster-only players (audit #64).
