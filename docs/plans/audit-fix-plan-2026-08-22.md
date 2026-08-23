# Audit fix plan — 2026-08-22

Source: adversarially verified audit of `backend/` + `mobile/` at commit 71646b4 (82 ranked entries; report
artifact https://claude.ai/code/artifact/1dfe2db8-9265-4116-9b2d-95ac49f13d5f). Entry numbers below (`#n`)
refer to that ranking.

Decision already made: **#9 → self-select COACH at onboarding** (global `COACH` role stays meaningful; a
new onboarding step + endpoint sets it).

## Sequencing

```
Phase 0  PR-0  JWT verification (#1)                       ← lands alone, first
Phase 1  PR-1  Role self-select (#9)                        ← lands second; lanes A/B build on it
Phase 2  Lanes A–I in parallel (one feature branch per PR, sequential inside a lane)
Phase 3  Native iOS build (#37, #52 need a binary) + OTA for the JS-only lanes
```

Rules for every PR:
- Branch from the current `main` tip; rebase (don't merge) when a lane-mate lands.
- Conventional commit, `Closes`/`Refs` the audit entries by number in the PR body (`Audit #14`), **not**
  GitHub issue numbers.
- API test in `tests/api/` for every route change; schema test for every Zod change; service test where the
  service is where the logic lives. Mobile hook/store changes get a Jest test under `mobile/__tests__/`.
- `npm run lint && npm run type-check && npm test` clean in the touched package(s); CI green before merge.
- Docs in the same PR: `CLAUDE.md` for behavior/API changes, `docs/testing/e2e-test-plan-v2.0.md` where a
  finding cited it (H.2, N.4).
- Security fixes (PR-0, lane A, lane B, #14, #15) get a one-line entry in the PR body naming what an
  attacker could do before/after — that's what we'll paste into the issue comment at merge.

---

## Phase 0 — PR-0 `fix(auth): verify WorkOS JWT signatures` (#1)

**Files:** `backend/src/services/workos-service.ts` (`verifyToken`), `backend/src/api/auth/middleware.ts`,
`backend/src/websocket/game-events.ts` (handshake), `backend/package.json` (+`jose`).

- Replace payload-decode with `jose.jwtVerify(token, createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(WORKOS_CLIENT_ID))), { issuer: 'https://api.workos.com', audience?: … })`. Require `exp`; reject `alg:none`.
- Keep `getUser(sub)` **only** for hydrating the user record, after verification. Verification failure → 401;
  WorkOS outage during hydration → 503 (this is the backend half of #20 — do it here, not later).
- Dev-login tokens (`dev_…`) path unchanged (still `NODE_ENV=development` only).
- Tests: `tests/services/workos-service.test.ts` — valid signed token (use a test keypair + mocked JWKS),
  tampered payload, `alg:none`, expired, missing `exp`, wrong issuer; `tests/api/auth.test.ts` — `/auth/me`
  401 on forged token; socket handshake test in `tests/websocket/`.
- Mobile impact: none (real tokens were always signed). Verify on a device after deploy: login, wait >10 min,
  confirm refresh still works (regression of #350).

## Phase 1 — PR-1 `feat(auth): self-select COACH during onboarding` (#9)

**Backend:** `PATCH /api/v1/auth/me/role { role: 'PLAYER' | 'COACH' }` (authenticated, general limiter).
Only allowed while `user.role` is `PLAYER` or `COACH` (never from/to `ADMIN`/`PARENT`); idempotent.
Zod schema + API test + schema test. Document in `CLAUDE.md` auth section.

**Mobile:** new onboarding step in `mobile/app/onboarding/` ("I coach a team" / "I play on a team"), shown
once after first login when role is `PLAYER` and no `roleChosen` flag is persisted; calls the endpoint, updates
`auth-store`. Profile screen gets a "Switch to coach" row for users who picked player. Maestro flow
`.maestro/onboarding-role.yaml`. Update `docs/testing/e2e-test-plan-v2.0.md` onboarding section.

---

## Phase 2 — parallel lanes

Each lane = one agent/engineer, PRs landed in the listed order. Lanes do not share files; where a cross-lane
file touch is unavoidable it's called out.

### Lane A — Identity & account linking (#2, #3, #10, #25, #47, #51, #64)
Files: `workos-service.ts` (`syncUser` only — PR-0 owns `verifyToken`), `player-service.ts`,
`players/routes.ts` + `schemas.ts`, `notification-service.ts`, `auth/routes.ts`.
1. **A1 `fix(players): scope listing and lookups`** (#3, #64) — `listPlayers`/`getPlayer` take `userId`;
   non-admins see only users sharing a team (or self); `role`/`isManaged` filters admin-only; `search` matches
   name only for non-admins; `email` dropped from list payload for non-admins. Add `isManaged` to
   `USER_SUMMARY_SELECT`.
2. **A2 `fix(auth): safe account linking`** (#2, #25) — `syncUser` links by `workosUserId` first; by email only
   when the row has **no** `workosUserId`, and on link clears `isManaged`/`managedById`, re-evaluates
   `isAdminEmail`; `findFirst` → `findUnique` on email with explicit P2002 → 409 handling. Only set
   name/avatar on create or when the local value is null. `POST /players` requires ADMIN or team-manager
   context (managed players keep using `/teams/:id/managed-players`). Non-owner email edits forbidden (managed
   player email editable only until the account is claimed). `/auth/callback` returns `profilePictureUrl`.
3. **A3 `feat(auth): self profile endpoint`** (#10) — `PATCH /auth/me { name, profilePictureUrl }`; mobile
   Profile uses it instead of `PATCH /players/:id`.
4. **A4 `fix(auth): logout revocation + push-token ownership`** (#47, #51) — `POST /auth/logout` calls
   WorkOS `revokeSession`/refresh-token invalidation; `DELETE /push-token` scoped to caller's tokens.
   (Mobile side of calling logout lives in lane C — C2 depends on A4's endpoint; coordinate by landing A4
   early.)

### Lane B — League / season / team / game authorization (#4, #11, #13, #29, #46, #55, #80, #78)
Files: `league-service.ts`, `season-service.ts`, `team-service.ts`, `game-service.ts`, their routes.
1. **B1 `fix(leagues): gate detail endpoints`** (#4, #46, #55) — `getLeague`/`getSeason` take `userId`; full
   detail for system admin / league admin; others get league/season metadata + team names only (no staff,
   no emails). Authz failures throw `ForbiddenError` (403). Name uniqueness on `PATCH /leagues/:id`.
2. **B2 `fix(teams): unconditional access filter`** (#11, #13, #80) — `listTeams` ANDs the caller filter with
   `seasonId`/`leagueId`/`playerId`; `updateTeam.seasonId` requires league-admin on the target league;
   `GET /teams/:id` omits member emails for non-managers (keep for staff with `canManageRoster`).
3. **B3 `fix(games): access check first`** (#12, #29, #78) — `updateGame` calls `canAccessTeam` before
   field branches and rejects `{}`; `listGames` unions league-admin teams; status/score changes on a
   `FINISHED` game require `canManageRoster`-level staff.

### Lane C — Mobile session lifecycle (#5, #17, #18, #19, #20-mobile, #33, #34, #41, #62)
Files: `mobile/store/auth-store.ts`, `services/api-client.ts`, `services/socket.ts`, `app/_layout.tsx`,
`hooks/useNotifications.ts`, `hooks/useLiveGame.ts`, `app/login.tsx`, `app/auth/callback.tsx`;
backend `auth/routes.ts` + `workos-service.ts#getAuthorizationUrl` for PKCE only.
1. **C1 `fix(mobile): clean logout`** (#17, #18, #19, #41, #62) — `logout()` sequence: `DELETE /push-token`
   → `POST /auth/logout` (after A4) → `resetSocket()` → `queryClient.clear()` → clear store. Logout epoch
   counter in the refresh interceptor so an in-flight refresh can't resurrect a session. `registerForPush…`
   gets a `.catch` and depends on `isAuthenticated`, not the token string.
2. **C2 `fix(mobile): resilient refresh`** (#20, #34, #33) — only `logout()` on a **401** from
   `/auth/refresh`; 5xx/network → surface error, keep tokens. `onRehydrateStorage` clears `isLoading` in
   both branches. Login spinner resets on `AppState` active / `openAuthSessionAsync` result.
3. **C3 `fix(mobile): socket re-auth`** (#17b) — on `connect_error: Unauthorized`, refresh via the api-client
   single-flight, update `auth.token`, `socket.connect()`; cap retries.
4. **C4 `feat(auth): PKCE + state`** (#5) — client generates verifier/state (`expo-crypto`), backend
   `/auth/login` forwards `code_challenge`, `/auth/callback` requires matching `state` and passes
   `code_verifier` to `authenticateWithCode`. Callback deep link validates `state` before exchanging.
   Document in `CLAUDE.md` session section. (Universal-Link redirect is a follow-up once #37 ships.)

### Lane D — Game tracking & live score (#6, #7, #8, #38, #73, #75, #76, #77)
Files: `game-event-service.ts`, `game-service.ts#updateGame` emit path (coordinate with B3: D owns the
emit helpers, B owns the authz lines), `mobile/app/games/[id]/track.tsx`, `store/game-tracking-store.ts`,
`hooks/useLiveGame.ts`, `hooks/useGameEvents.ts`, `components/game/UndoBanner.tsx`.
1. **D1 `fix(games): server-derived home score + full broadcast`** (#6, #8, #38) — `createEvent`/`deleteEvent`
   recompute `homeScore` from events inside the transaction and emit `game-event` / new `game-event-removed`
   with the **post-change** score; `updateGame` emits `game-score-change` on score edits. Client stops
   sending `homeScore` after shots (keeps it for opponent score). Update Socket.io table in `CLAUDE.md` and
   E2E H.2.
2. **D2 `fix(mobile): undo targets the created event`** (#7, #77, #76) — `recordEvent` returns the server
   event; UNDO disabled until it resolves and deletes by that id; banner keyed on event id; fix
   invalidation key.
3. **D3 `fix(mobile): spectator merge + milestone state`** (#73, #75) — snapshot merges by id; milestone
   counters seeded from server events and reverted on undo.

### Lane E — Invitations (#14, #22, #23, #36, #58, #59, #69)
Files: `invitation-service.ts`, `invitations/routes.ts`, `public-routes.ts`, `prisma/schema.prisma` +
migration, `mobile/app/(tabs)/invitations.tsx`, `mobile/app/teams/[id]/players.tsx`.
1. **E1 `fix(invitations): never return the token`** (#14) — explicit `select` without `token` on all
   authenticated responses; public accept unchanged.
2. **E2 `fix(invitations): lifecycle`** (#22, #23, #58) — migration replaces the unique index with a partial
   unique index `WHERE status = 'PENDING'` (raw SQL); dedupe treats `expiresAt < now()` as non-blocking and
   lazily marks expired; accept uses `updateMany … where status='PENDING'` and 400s on 0 rows;
   `listInvitations(teamId)` for staff lists the team's invitations.
3. **E3 `fix(invitations): misc`** (#36, #59, #69) — dedicated limiter for `public-routes` keyed by token;
   expiry copy uses timestamp compare; create-and-invite becomes one backend call (`POST
   /teams/:id/managed-players?invite=true`) so no orphan player.

### Lane F — Stats math (#26, #27, #53, #56)
Files: `stats-service.ts`, schema (+`TeamStats` made/attempted columns), `mobile` record rendering.
1. **F1 `fix(stats): weighted season percentages`** (#26) — store made/attempted; percentages derived.
2. **F2 `fix(stats): refinalize correctness`** (#27, #53) — delete stale `PlayerStats`; re-finalize on
   post-`FINISHED` event changes; divide by finalized games.
3. **F3 `fix(stats): ties`** (#56) — `'T'` result in backend record + 3 screens.

### Lane G — Logging & Sentry hygiene (#15, #28, #48)
Files: `request-logger.ts`, `backend/src/utils/sentry.ts`, `mobile/services/sentry.ts`, `index.ts`,
`mailer/ses-mailer.ts`. Single PR **G1 `fix(observability): redact tokens, honor body-parser status`**.
Log `req.path` + redacted query; strip query strings and `by-token/<x>` segments in both `beforeSend`s; add
`beforeSendTransaction`; error handler honors `err.status` 400–499 and `isExpectedClientError` accepts them;
mailer logs hashed recipient.

### Lane H — Mobile pagination & routing (#30, #31, #32, #35, #40, #63, #65, #66, #67, #68, #79, #82)
One file each; may be split across two agents. PRs: **H1** (#30, #35, #63 — server `status` filter on
`/games`, infinite queries for games/teams/announcements, dedicated live-game query, invalidations),
**H2** (#31, #32, #65, #66 — dead routes, invite→login when logged out, ADMIN-only league entry, empty
stats state), **H3** (#40, #67, #68, #79, #82 — api error normalization incl. 402 `upgrade_required`,
`updateUser` store action, jersey `!= null`, effective permissions from API, toast stacking).

### Lane I — Backend misc (#21, #24, #37, #39, #43, #44, #45, #49, #50, #54, #57, #60, #61, #70, #71, #81)
One file each. PRs: **I1 `fix(api): correct status codes`** (#44, #45, #54 — Zod on announcements list,
`ForbiddenError`/`NotFoundError` in game route catches, nullable season dates), **I2 `fix(infra): limits and
reconnects`** (#21, #50, #61, #49 — per-user refresh limiter + 429 as transient, Redis retry/recreate, S3
size cap + lifecycle + old-avatar delete, team-create cap in a transaction), **I3 `fix(backend): hygiene`**
(#24, #43, #57, #60, #70, #71, #81 — `API_BASE_URL` env for calendar URLs, entitlement re-check on feed,
timezone in emails, push receipt pruning, `$transaction` on createTeam, scope calendar middleware, enforce or
hide `maxSeasons`), **I4** (#37, #39 — `ios.associatedDomains`, `uploadAvatar` throws on `!res.ok`).

---

## Phase 3 — ship
- Backend lanes deploy automatically on merge (ECS). Security PRs (PR-0, A, B, E1, G1) merge ahead of the
  rest — don't let them queue behind lane H.
- Mobile: lanes C/D/H + E3/F3/I4 are JS-only → one OTA after they all land
  (`npx eas-cli update --branch production --environment production --platform ios …`), **except** #37
  (`associatedDomains`) and #52 (`expo-secure-store`, folded into C1 if time allows) which need a native
  build → cut build #25 from `main` after the OTA-eligible set is verified.
- Re-run the audit workflow (`resumeFromRunId` won't help — new code) as a final pass once all lanes land.

## Out of scope (deferred)
Kafka/Flink, Terraform beyond env/S3, `web/` beyond the invite page, Maestro/CI gaps.
