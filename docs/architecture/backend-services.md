# Backend services: structure and smaller subsystems

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

## Backend Structure (`/backend/src/`)
- **api/**: Route handlers organized by resource (auth, games, teams, leagues, players, invitations, seasons, stats, uploads, admin, middleware). `admin/` holds system-ADMIN-only operator routes (today: setting a subscription tier, #445). `invitations/public-routes.ts` exposes the unauthenticated token lookup + accept used by the web invite page.
- **services/**: Business logic layer (game-service.ts, team-service.ts, etc.) plus `mailer/` (Mailer interface + FakeMailer + SesMailer + templates, shipped in #131; SES bounce/complaint event handling and its queue consumer, #449) and `usage-service.ts` (usage metering, #43)
- **websocket/**: Socket.io handlers for real-time updates
- **models/**: Prisma ORM models
- **utils/**: Helpers (logger, errors, workos-client, redis caching helpers)

## Key Patterns
- Layered architecture: API routes → Services → Models (Prisma)
- Real-time: Socket.io WebSocket for live game updates
- State management: Zustand (client) + TanStack Query (server state) in mobile
- Authentication: WorkOS (AuthKit). JWT is the session token format — WorkOS is the identity provider.

## Redis (`utils/redis.ts`)
Best-effort cache only — every helper fails open. The ioredis `retryStrategy` (`redisRetryDelay`) never returns `null`: it backs off 200 ms → 30 s and keeps reconnecting for the life of the process; if the connection ends anyway (`quit()`), the client is dropped and recreated lazily on next use (audit #50). Commands still fail fast while disconnected (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`).

## Avatar uploads (`services/upload-service.ts`, `api/uploads/`)
`POST /api/v1/uploads/avatar-url { contentType, contentLength? }` returns a **presigned S3 POST** (`{ uploadUrl, fields, imageUrl }`), not a PUT URL — a presigned PUT can't bind `Content-Length`, a POST policy can. The policy enforces `content-length-range` 1..`MAX_AVATAR_BYTES` (5 MB) and pins `Content-Type`; `contentLength` is an optional early 400. Mobile `services/upload-service.ts` posts a multipart form (policy fields first, `file` part last) and **throws on `!res.ok`** so a failed upload never persists a dangling URL (audit #39). **The file part is an `expo-file-system` `File` (`new File(localUri)`), never React Native's `{ uri, name, type }` object (#576):** since Expo SDK 57 the global `fetch` is Expo's own, which encodes a multipart body in JavaScript and takes only a string, a Blob or a File for a part; the old object failed every upload on build #33 with "Unsupported FormDataPart implementation". No test saw it, because every test stubbed `fetch` and never encoded the body; `__tests__/services/upload-service.test.ts` now runs the form through Expo's real encoder (`expo/src/winter/fetch/convertFormData`). The same goes for any future upload: build the form, then prove it encodes. When a profile's `profilePictureUrl` changes, `deletePreviousAvatar(old, new)` best-effort deletes the replaced object if it lives in our bucket (WorkOS photo URLs are never touched) — call it from any new path that sets `profilePictureUrl` (audit #61). `infra/s3.tf` allows `POST` in CORS and aborts incomplete multipart uploads after 1 day.

## Environment URLs & time zone
- `API_BASE_URL` — the host that serves `/api/v1/*` (`https://api.hooplings.com` in prod via `infra/task-definition.json`). Used for the calendar feed/webcal URLs. `PUBLIC_APP_URL` stays the web apex (`https://hooplings.com`) for human-facing links (invite pages, "View game"). They were conflated before (audit #24) — feeds pointed at the apex, which serves no API. **Both are read ONLY via `utils/urls.ts`** (`publicAppUrl()` / `apiBaseUrl()`, trailing slash stripped) — never `process.env.PUBLIC_APP_URL` inline. The fallback for both is `http://localhost:3000` on purpose: a localhost link in a production email is obviously broken, whereas the old per-service brand-domain fallbacks emitted plausible links to the wrong host with nothing in the logs; `warnMissingUrlConfig()` runs at boot and warns in production when either is unset (domain migration #501). The iCal `uid` domain / `productId` are the exported `ICAL_UID_DOMAIN` / `ICAL_PRODUCT_ID` in `calendar-service.ts` — frozen once anyone subscribes (changing a UID duplicates every event in a subscriber's calendar). Email copy names the product only through `mailer/templates/brand.ts#APP_NAME`; `tests/services/mailer.test.ts` fails on any retired brand name in a rendered template.
- `DEFAULT_TIMEZONE` — IANA zone used to format dates in outbound email (`utils/format-date.ts#formatEmailDate/formatEmailDateTime`; default `America/Los_Angeles`). Never call `toLocaleDateString()` bare in a template variable — ECS runs in UTC (audit #57). Teams/leagues have no time-zone column yet; pass one through the helper's `timeZone` arg once they do.
- `CORS_ORIGIN` — comma-separated list of **exact** browser origins (scheme + host, no wildcard) that
  `backend/src/index.ts` hands to both `cors()` and Socket.io. Production
  (`infra/task-definition.json`) lists `https://api.hooplings.com,https://hooplings.com,https://www.hooplings.com`;
  the apex + www entries exist because the web invite page (`web/app/invite/[token]/invite-client.tsx`)
  `POST`s the accept cross-origin from `hooplings.com`, which is a preflighted request (#447). No old-domain origins were carried through the domain migration: no browser ever sent one, because nothing has ever served that host (#501). The list
  is always passed as an **array** — `cors` stamps a plain-string origin on every response regardless
  of the request `Origin`, while an array reflects only listed origins — so behaviour never depends on
  how many entries are configured. CORS here is browser hygiene, not access control: the accept route is
  an unauthenticated bearer-token endpoint reachable from any curl. `tests/api/cors.test.ts` reads the
  production value out of `task-definition.json` and asserts the apex preflight, so dropping the apex
  from the deploy file fails CI; `tests/infra/task-definition.test.ts` does the same for every other
  domain-bearing env value (`PUBLIC_APP_URL`, `API_BASE_URL`, `SES_FROM_ADDRESS`, `WORKOS_REDIRECT_URI`). The mobile app sends no `Origin` header and is unaffected. The web
  deploy (#30) separately needs `API_URL` (server-side GET) **and** `NEXT_PUBLIC_API_URL` (browser
  POST, baked at build time) pointed at the API host.

## Calendar feed (`services/calendar-service.ts`, `api/teams/calendar.ts`)
- `resolveToken` checks, on **every** fetch: token exists, not revoked, team matches, user still has team access, and the user's *current* effective tier still includes `CALENDAR_SYNC` (system ADMINs bypass) — a downgraded/expired subscription stops the feed with 403 instead of serving forever (audit #43).
- The calendar router is mounted on `/teams` ahead of the main teams router so the public `GET /teams/:id/calendar.ics` skips auth. Because of that ordering, `authenticate` is attached **per route** to `subscribe`/`revoke` — never `router.use(authenticate)` there, or every `/teams/*` request verifies the JWT twice (audit #71).

## Push notifications (`services/notification-service.ts`)
`sendMessages` inspects Expo tickets immediately and schedules `checkReceipts()` ~15 min later (unref'd timer); any ticket/receipt with `DeviceNotRegistered` deletes that `PushToken` (`pruneDeadTokens`). Other receipt errors are logged only (audit #60). The jest mock in `tests/__mocks__/expo-server-sdk.js` stubs both the send and receipt APIs.

## Logging (#617)
- **One JSON object per line** from `utils/logger.ts` (`console.log`; `console.error` for level `error`), picked up by the awslogs driver (`/ecs/bball-tracker-production`) and forwarded to Datadog by `infra/datadog.tf`. Query with `service:bball-tracker-api`, filter on `@level`, `@requestId`, `@userId`, `@teamId`, `@gameId`.
- **`LOG_LEVEL`** (`debug` | `info` | `warn` | `error`, default `info`) is the threshold. It is read on every call, so it can be flipped without a restart in dev; in production it lives in `infra/task-definition.json` (the only source of truth for env vars), so a diagnosis means a task-definition change to `debug` and a second one back. An unknown value falls back to `info`. `debug` was previously gated on `NODE_ENV === 'development'` and could never be turned on in production.
- **Request context:** `api/middleware/request-context.ts` opens an `AsyncLocalStorage` store (`utils/log-context.ts`) holding `requestId`; `authenticate` adds `userId` once the token resolves. The logger merges the store into every entry written while the request is handled, so services log domain events with ids only and the line still says which request and user caused it. Explicit context wins over the store. Socket.io handlers and background work (SES consumer, push receipts) run outside any store and carry only what they pass.
- **Request log** (`api/middleware/request-logger.ts`): one `HTTP request` line per request on `finish` with `method`, redacted `path` (`loggablePath`, never `req.originalUrl`), `statusCode`, `duration`, `requestId` and `userId` when `req.user` is set. `/health` is never logged. `tests/api/request-log.test.ts` pins the `userId`.
- **Domain events** at `info`, ids only, never a name, an email (`hashRecipient()` if an address must appear) or a token: `Team created` / `Team moved to season` / `Team deleted` (season rollover, #461, is not built; the move is the only lineage-level change today), `Roster player added` (`via`: `add-player-managed`, `add-player-invited`, `existing-user`) / `Roster player removed`, `Invitation sent` / `superseded` / `accepted` (`via`: `app` or `token`) / `declined` / `cancelled`, `Guardian invitation sent` / `declined`, `Guardian linked` / `unlinked`, `Game created` / `started` / `finished` / `status changed` / `deleted`, `Stats finalized` (`players`, `duration`), `Entitlement denied` (402, `feature`, `currentTier`, `requiredTier`), `Socket connected` / `disconnected` / `joined game room`, `Calendar feed served`, `Export generated` (`kind`). A new service method that mutates data logs one such line; a new external call (SES, S3, WorkOS, Redis) logs its failures at `warn`/`error` with the operation named.
- Expected client outcomes (4xx) are logged at `warn` by the error handler in `src/index.ts`; `error` is reserved for 5xx and failed external calls, so the error stream stays meaningful.
- The one `console.*` outside the logger was the missing-`.env` warning in `config/env.ts`; it goes through the logger too (the logger reads nothing from the environment at import time).

## Transactions (audit #70)
`InvitationService.addRosterPlayer` creates the managed user + team membership (and, with an email, the invitation) inside one `$transaction` so a failed later insert can't leave an orphan managed user (`TeamService.addManagedPlayer`, where the rule started, was removed in #418; the `createTeam` half — team + roles + staff row — landed with audit #49 in `fix/infra-limits-and-reconnects`).
