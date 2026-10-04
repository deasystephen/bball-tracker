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

`score` is always `{ homeScore, awayScore }`. Every broadcast carries the
current score so a client can drop events and still converge.

- Handshake auth: bearer token via `socket.handshake.auth.token` (or
  `Authorization` header). Checked once at connect; see `authenticateSocket`. A rejected or
  expired token is `connect_error: Unauthorized` and is log-only (an expected client outcome), as
  is a thrown 4xx `AppError` (filtered by `isExpectedClientError`). Every other throw (a
  JWKS/WorkOS outage, a database failover) is `connect_error: Service unavailable`, so the client
  backs off and retries rather than refreshing credentials, and is reported to Sentry with
  `captureException(error, { flow: 'socket-auth', socketId })`, because middleware rejections
  never reach the Express chain and `sentryErrorHandler` (#672).
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
