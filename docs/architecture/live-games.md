# Live games: Socket.io broadcast and the server-derived score

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Socket.io (Live Game Broadcast)

Real-time game updates use Socket.io with an in-memory adapter. **Single-replica
only**: rooms and every rate-limit counter live in process memory, so a second
task silently splits a live game (coach on task A, spectators on task B, no
error anywhere). The Redis adapter and shared rate-limit store are the open
follow-up **#452** (#26, which shipped the handlers, was closed without them).

Three things pin the replica count, and they change together (#446):

- **Autoscaling:** `max_capacity` in `infra/variables.tf` defaults to 1 and its
  `validation` block rejects any other value, so a `terraform.tfvars` override
  cannot raise it (`min_capacity` accepts 0 or 1; 0 is for maintenance windows).
- **`MAX_REPLICAS=1`** in `infra/task-definition.json` — the process cannot
  observe the autoscaling target, so the ceiling is explicit configuration.
  `tests/infra/replica-ceiling.test.ts` pins it to the `max_capacity` default
  and runs the real guard against the production env block.
- **Hard startup guard:** `utils/replica-guard.ts` — pure
  `evaluateReplicaGuard(env)` plus `enforceReplicaGuard()`, which `index.ts`
  calls **before** `httpServer.listen`. Only evaluated when
  `NODE_ENV=production`:

  | `MAX_REPLICAS` | Result |
  | --- | --- |
  | `1` | starts (info log) |
  | unset / blank | starts, logs at **error** level (the pre-guard behaviour, so a rollback to an older task definition cannot crash-loop) |
  | not a positive integer | **exits 1** before listening |
  | `> 1` | **exits 1** before listening |

  `REDIS_SOCKET_ADAPTER_URL` is **not** accepted as an escape hatch:
  `@socket.io/redis-adapter` is not installed and nothing reads the URL, so
  honouring it would be false assurance. #452 flips `MULTI_REPLICA_SUPPORTED`
  in the guard module; from then on a ceiling above 1 requires the URL. The
  guard is configuration-based, so the two tasks of a rolling deploy do not
  trip it — see the deploy-window caveat under "ECS deploy safety".

Do not raise capacity as a fix for load: adapter and shared rate-limit store
first (#452), capacity second.

| Direction       | Event                | Payload                                                        |
| --------------- | -------------------- | -------------------------------------------------------------- |
| client → server | `join-game`          | `{ gameId }` (ack with success/error)                          |
| client → server | `leave-game`         | `{ gameId }`                                                   |
| server → client | `game-snapshot`      | `{ game, events }` (on join / rejoin)                          |
| server → client | `game-event`         | `{ event, score }` (on persist; score is **post-insert**)      |
| server → client | `game-event-removed` | `{ gameId, eventId, score }` (on delete/undo; post-delete score) |
| server → client | `game-score-change`  | `{ gameId, score }` (on `PATCH /games/:id` score edits)        |
| server → client | `game-status-change` | `{ gameId, previousStatus, status, score }` (on transition)    |
| client → server | `refresh-auth`       | `{ token }` after each token refresh (ack `{ success, code? }`, #49) |
| server → client | `reauth_required`    | `{}` (no valid token by expiry; the transport closes next, #49) |

`score` is always `{ homeScore, awayScore }`. Every broadcast carries the
current score so a client can drop events and still converge.

- Handshake auth: bearer token via `socket.handshake.auth.token` (or
  `Authorization` header). Checked at connect by `authenticateSocket`, which also records the
  token's expiry in `socket.data.tokenExpiresAt` (WorkOS `exp` in seconds and dev-token `exp` in
  milliseconds are both stored as epoch ms), and re-checked mid-session (next bullet). A rejected or
  expired token is `connect_error: Unauthorized` and is log-only (an expected client outcome), as
  is a thrown 4xx `AppError` (filtered by `isExpectedClientError`). Every other throw (a
  JWKS/WorkOS outage, a database failover) is `connect_error: Service unavailable`, so the client
  backs off and retries rather than refreshing credentials, and is reported to Sentry with
  `captureException(error, { flow: 'socket-auth', socketId })`, because middleware rejections
  never reach the Express chain and `sentryErrorHandler` (#672). A deleted account (tombstone,
  `deletedAt` set) is refused like REST refuses it: both lookups in `resolveSocketSession` filter on
  `deletedAt: null`, so a still-valid dev token for a deleted user cannot join a game room (#667).
- **Mid-session re-verification (#49).** A socket keeps its handshake for life, so the server
  tracks the token it holds for each socket (`socket.data.authToken`, server memory only, never
  logged) and its expiry. Two mechanisms, both in `websocket/game-events.ts`:
  - **In-band refresh, the normal path.** The client emits `refresh-auth { token }` whenever it
    holds a newer access token. `handleRefreshAuth` runs it through `resolveSocketSession`: a
    valid token for the same user replaces the held token and expiry, re-checks room access and
    reschedules the timer below, with no disconnect, handshake or snapshot (ack
    `{ success: true }`). A rejected token is acked `unauthorized` and leaves the socket on its
    current token and timer (info log `Socket refresh-auth rejected`); a token for another user
    ends the connection like a failed re-check (`user_changed`); a verifier outage is acked
    `unavailable` and reported to Sentry (`flow: 'socket-refresh-auth'`); a malformed payload is
    `bad_request`. `refresh-auth` is limited to `MAX_REFRESH_AUTHS_PER_WINDOW` (10) per minute
    per socket (`websocket/rate-limit.ts`, ack `rate_limited`), checked before any verification.
  - **Re-check timer, the fallback.** `scheduleSocketReauth` keeps one timer per socket, due at
    the held token's expiry plus `REAUTH_GRACE_MS` (35s: the verifier's 30s clock tolerance,
    `JWT_CLOCK_TOLERANCE_SECONDS`, plus 5s, so the re-check really fails) plus a per-socket
    jitter of 0–20s (`REAUTH_JITTER_MAX_MS`, fixed per socket, so expiries that cluster at
    tip-off do not all close in the same second), and never more than `REAUTH_MAX_INTERVAL_MS`
    (15 min) away; a token without `exp` is re-checked every 15 min. A valid token is never cut
    off early. When it fires, `reverifySocket` re-runs the held token through
    `resolveSocketSession`:
    - still valid → `socket.data` is refreshed, room access is re-checked and the next check is
      scheduled;
    - rejected (expired, revoked, account deleted, now a different user) or a thrown 4xx
      `AppError` → the server emits `reauth_required` and closes the Engine.IO connection
      (`socket.conn.close()`). It deliberately does **not** call `socket.disconnect()`: with or
      without `true` that sends a namespace DISCONNECT, which socket.io-client reports as `io
      server disconnect` and never auto-reconnects from. A transport close is `transport close`
      on the client, which auto-reconnects, so a client that never sends `refresh-auth` (built
      before #49) still recovers through the `Unauthorized` path below;
    - any other throw (JWKS or database outage) → reported to Sentry
      (`flow: 'socket-reauth'`); a token already past expiry is rejected as above, otherwise the
      check is retried after `REAUTH_RETRY_MS` (60s), so an outage never cuts off a valid
      session.
  - **Logging.** The expected cycle is `debug` (`Socket auth refreshed`, `Socket reauth check
    passed`, and `Socket reauth required` with `reason: 'expired'`). Anomalies are `info`:
    `Socket reauth required` with `reason: 'rejected'` (the verifier refused an unexpired token,
    or the account was deleted) or `'user_changed'`, `Socket refresh-auth rejected`, and `Socket
    evicted from game room`. Ids only.
  - **Room access (audit #72).** Every accepted `refresh-auth` and every passing re-check runs
    `pruneGameRooms`, which leaves each `game:<id>` room whose team the user can no longer
    access (`canAccessTeam`), so a removed coach stops receiving broadcasts within one token
    lifetime even though the socket stays connected. A lookup failure keeps the rooms and is
    reported to Sentry; the next refresh or re-check tries again. The client is not told it was
    evicted; it simply stops receiving that game's broadcasts.

  Timers are cleared on `disconnect` (`clearSocketReauth`) and `unref`'d, and live in process
  memory like rooms (single replica). Tests: `tests/websocket/socket-reauth.test.ts` (fake
  timers) and the "mid-session re-auth" block of `tests/websocket/game-events.integration.test.ts`
  (real transport: timer cleared on disconnect, `refresh-auth` keeps the connection past the
  handshake token's expiry, `reauth_required` then `transport close`, automatic reconnect with
  a fresh token).
- Rate limits (audit #16, `websocket/rate-limit.ts` — in-memory, single-replica like the adapter):
  handshake attempts 60/min per IP, checked **before** auth so connect spam never reaches JWKS/DB;
  max 50 concurrent sockets per IP; `join-game` 20/min per socket (ack `code: 'rate_limited'`).
  A limited handshake rejects with `connect_error: Rate limited`, which mobile `services/socket.ts`
  backs off and retries exactly like `Service unavailable`. The IP key is the rightmost
  `x-forwarded-for` entry (the ALB-appended hop, same trust rule as `trust proxy: 1`), falling back
  to the peer address.
- Room naming: `game:<gameId>` (see `GAME_ROOM_PREFIX` / `gameRoom()`).
- Snapshot cap: `SNAPSHOT_EVENT_LIMIT = 100` most-recent events returned on
  join, in chronological order.
- Handshake rejection recovery (mobile `services/socket.ts`, audit #17b): a
  middleware rejection arrives as `connect_error` and socket.io does **not**
  auto-reconnect from it. `Unauthorized` → refresh via the api-client's
  single-flight `refreshAccessToken()` then `socket.connect()` (the `auth`
  callback reads the new token), max `MAX_AUTH_REFRESHES` (2) in a row; a
  rejected refresh token is left to the next REST 401 to log out. `Service
  unavailable` (backend cannot reach JWKS) → exponential back-off
  (2s·2ⁿ, max `MAX_UNAVAILABLE_RETRIES` = 5). A successful `connect` resets
  both budgets; `resetSocket()` cancels any pending retry. `useLiveGame`
  reports `reconnecting` while `isSocketRecovering()` and `error` otherwise.
- Mid-session re-auth, client side (mobile `services/socket.ts`, #49). The module remembers the
  token the server holds for the open connection (the handshake token, then each token it
  sent).
  - **In-band:** an auth-store subscription calls `syncSocketToken` whenever the stored access
    token changes (any `refreshAccessToken()`, REST-triggered or not) while connected, and
    emits `refresh-auth`; `connect` does the same if a refresh landed during the handshake.
  - **Proactive:** while connected, a timer refreshes `PROACTIVE_REFRESH_LEAD_MS` (60s) before
    the held token expires (expiry read by `utils/token-expiry.ts`, unverified), because a
    spectator who makes no REST calls would otherwise never refresh and the server would close
    the socket every token lifetime. The resulting store change sends `refresh-auth`. The timer
    is cleared on `disconnect` and by `resetSocket()`.
  - **Fallback (`handleReauthRequired`):** on `reauth_required`, if the stored token is newer
    than the held one and unexpired, nothing is refreshed: socket.io reconnects by itself and
    the `auth` callback carries it. Otherwise it starts the single-flight
    `refreshAccessToken()` (a refresh rotates the WorkOS refresh token, so it is never spent
    for nothing). It never calls `connect()`. A reconnect that wins the race is refused
    `Unauthorized` and `handleConnectError` awaits the same in-flight refresh. A `rejected`
    refresh ends recovery (the next REST 401 logs out). `useLiveGame` rejoins its room on
    `connect`, and the snapshot merge keeps events streamed meanwhile.

## Game score (server-derived, audit #6/#8/#38)

- **The game-row lock.** Every write that derives state from the event log
  runs in one interactive transaction that **first** takes
  `utils/game-row-lock.ts#lockGameRow` (`SELECT "status", "homeScore",
  "awayScore" FROM "Game" … FOR UPDATE`): event create and delete, the
  `PATCH { homeScore }` check below, and stats finalization
  (`docs/architecture/stats-and-lineage.md`). The lock comes **before** the
  event insert or delete: an insert holds a `KEY SHARE` lock on the game row
  through the foreign key, so two shots that insert first and lock second
  deadlock (`40P01`; reproduced on the pre-#665 code by
  `tests/integration/stats-finalize.db.test.ts`).
- **Why non-SHOT writes take the lock too.** A rebound or a timeout doesn't change
  the score, so the lock looks like a cost with no benefit: every tap on a game
  queues behind any in-flight shot recompute or finalization. It stays because the
  `status` that decides re-finalization must be read under the same lock as the
  write, or a `PATCH status=FINISHED` committing around a non-SHOT insert leaves a
  box score without that event (the #724 race applies to every event type, not just
  shots). A cheaper unlocked post-write read would still race the PATCH. The lock
  also lets `deleteEvent` look the event up under it, so a double undo is a 404, not
  a 500. The hold is short: one lock statement, one insert or delete, and for SHOT
  one read and one update; finalization holds it for two reads and four writes.
- `Game.homeScore` is **derived from the event log**: `GameEventService.createEvent`
  / `deleteEvent` recompute it from made `SHOT` events inside that transaction,
  so concurrent shots can't race to an undercount. Non-SHOT writes don't change
  the score and return the one read under the lock, which no other writer can
  move before they commit (#665); neither path ever returns the unlocked
  access-check row. Both endpoints return the post-change `score`
  (`POST /games/:id/events` → `{ event, score }`,
  `DELETE /games/:id/events/:eventId` → `{ success, score }`) and broadcast it.
- **SHOT metadata is validated (#723).** `createGameEventSchema` is a
  discriminated union on `eventType`: `SHOT` requires exactly
  `{ made: boolean, points: 1 | 2 | 3 }`, `REBOUND` requires exactly
  `{ type: 'offensive' | 'defensive' }`, and every other type keeps a flat
  record of primitives (default `{}`). Anything else is a 400. The point rule
  lives once, in `utils/shot-points.ts` (`shotValue`, `shotMade`,
  `shotPoints`), and both `computeHomeScore` and `StatsService` use it, so the
  derived score always equals the box score's team points. For rows already
  stored, a missing or `null` `points` counts as 2 (as `points || 2` did), an
  out-of-range value counts nowhere (neither score nor attempts), and only a
  boolean `made: true` is a make. The last two changed how such legacy rows score;
  see `docs/architecture/stats-and-lineage.md` for the query that finds them.
- `PATCH /games/:id { homeScore }` is honoured **only while the game has no
  SHOT events** (score entered for a game not tracked in-app). Once shots
  exist the client value is ignored and the derived score re-persisted (old
  clients keep working; under-counted games self-heal on their next PATCH).
  The SHOT check and the write run in one transaction under the game-row lock,
  so a shot committed in between cannot be overwritten by the client value
  (#666); a PATCH without `homeScore` takes no lock. `awayScore` is always
  client-supplied (opponent points).
- **The database enforces non-negative scores (#825):** migration
  `20261018000000_game_score_non_negative` adds the CHECK constraint
  `Game_score_non_negative_check` (`homeScore >= 0 AND awayScore >= 0`). Prisma does
  not model CHECK constraints, so it lives only in the migration SQL. A write path
  that bypasses Zod and the derivation fails with a constraint error instead of
  storing a negative score (`tests/integration/game-score-check.db.test.ts` proves
  it). The error reaches the API as a `PrismaClientUnknownRequestError` (500 plus
  Sentry), so the constraint is defence in depth and the Zod `.min(0)` in
  `api/games/schemas.ts` stays the client-facing 400 layer. The migration adds it
  `NOT VALID` and then validates, so it does not block live-game writes.
- Mobile tracker (`app/games/[id]/track.tsx`) never sends `homeScore`; it
  renders `game.homeScore` from the detail cache, which
  `useCreateGameEvent`/`useDeleteGameEvent` update from the response score.
- **Undo targets the created event (audit #7/#77/#76):** `recordEvent` returns
  a `LocalEvent`; once the create resolves the screen calls
  `confirmEvent(localId, event.id)` which attaches `serverId`. The
  `UndoBanner` is rendered `pending` (button disabled, countdown held, label
  "SAVING…") until then, and is `key`ed by `localId` so the 5s countdown
  restarts per event. `handleUndo` deletes `lastEvent.serverId` — never
  `events[0]` from the TanStack cache. A failed create calls
  `discardEvent(localId)`.
- **One event per selection (#730):** `submitEvent` in the tracker deselects
  the player synchronously on tap, right after `recordEvent` and before the
  POST, so the shot and stat buttons disable in the same tick and at most one
  event is in flight per selection. It reads the selection from the live store
  (`useGameTrackingStore.getState()`), not the render's closure, so a second
  tap that lands before React re-renders finds no selection and is dropped
  silently. A failed create discards the local event and shows an error naming
  the play and the player ("Could not save 2pt made for <name>."). It
  re-selects that player for a one-tap retry only when nothing was recorded
  since (a per-submit counter) and nobody else is selected: after "A taps,
  B taps, A's POST fails" re-selecting A would make the next tap, meant for
  B, record for A. Test: `mobile/__tests__/app/track-double-tap.test.tsx`. Invalidate event lists with
  `gameEventKeys.listsFor(gameId)` (`list(gameId)` ends in `undefined`, which
  TanStack's partial matcher does not treat as a wildcard).
- **Spectator snapshot merge (audit #73):** `useLiveGame` merges a
  `game-snapshot` with the events already in state by id (streamed-but-not-
  in-snapshot events stay at the top and their score wins) instead of
  replacing, so an event broadcast while the server was building the
  snapshot isn't lost.
- **Hot-streak / milestone counters (audit #75):** `game-tracking-store`
  counters are derived = `seedCounters` (folded once from the server's event
  page via `seedFromEvents` when the tracker opens) + remaining local events.
  `undoLast`/`discardEvent` re-fold, so undoing a miss restores the streak
  and undoing a rebound/assist reverts the double-double math. Seeding never
  toasts. The seed is bounded by the 100-event page the tracker loads.
  **Free throws** (SHOT with `points: 1`, the "FT" column in `ShotButtons` —
  the grid is a MADE row and a MISS row of 2PT/3PT/FT so it keeps its
  pre-FT height and stays above the fold on 667pt-class devices) never
  touch `playerStreaks` in either direction — a made FT doesn't extend a hot
  streak, a missed FT doesn't reset one — but made-FT points do count toward
  `playerPoints` (10/20-point milestones and double-doubles include them).
  Shot display text ("FT made" / "2pt miss") derives ONLY via
  `utils/shot-label.ts#formatShotDescription` (EventTimeline + the tracker's
  undo message; same never-inline rule as `game-result.ts`).
