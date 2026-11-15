# Practice scheduling (#33)

As-built reference for practices, other non-game team events, recurring series and per-session
availability. Backend only so far: the mobile screens are a later PR (see "What the mobile PR builds").
The product plan, competitive notes and the three follow-ups (#331 availability defaults, #332
minimum-attendance alerts, #333 carpool) are in `docs/features/practice-schedules-plan.md`.

## Data model: separate tables, never `Game`

`PracticeSeries`, `PracticeSession` and `PracticeAvailability` (`backend/prisma/schema.prisma`,
migration `20261115181655_practice_scheduling`). The issue offered a `type` column on `Game`
instead; that was rejected because a `Game` row carries behaviour a practice must never trip:

- `homeScore` derived from SHOT events under a row lock, `PATCH /games/:id` score rules;
- `finalizeGameStats` / `TeamStats` / `PlayerStats`, season aggregates, exports and box scores;
- live Socket.io rooms (`game:<id>`), the tracker, game-status pushes;
- `GameRsvp` emails worded for a game against an `opponent`;
- every game list (`GET /games`, team detail, stats, the calendar `game-` UIDs), and the app builds
  already in the field, which render every row of `GET /games` as a game.

A `type` column would have meant auditing and filtering every one of those readers, and an old
build would still have shown practices as games. Separate tables change no existing response.

| Model | What it is |
| --- | --- |
| `PracticeSeries` | The rule: `frequency` (`WEEKLY`/`BIWEEKLY`), `weekdays` (0 = Sunday … 6), `startDate` (local date, `@db.Date`), `startTime` (local `"HH:MM"`), `durationMinutes`, `timezone` (IANA), and exactly one of `endDate` (local, inclusive) or `occurrenceCount`. `cancelledAt` once cancelled. |
| `PracticeSession` | One dated event: `startsAt` (UTC instant), `durationMinutes`, `timezone`, `type` (`PRACTICE`/`OTHER`), optional `title`/`location`/`notes`, `status` (`SCHEDULED`/`CANCELLED`, `cancelledAt`, `cancelReason`), `seriesId` (null for a standalone practice), `isException`. |
| `PracticeAvailability` | One answer per (session, player): `status` (the shared `RsvpStatus` YES/NO/MAYBE), optional `comment`. Keyed on the player, as `GameRsvp` is. |

`type` is `PRACTICE | OTHER`: games stay in `Game`, so the issue's `GAME` value has no row to
describe. Recurring games were not built (the issue calls them rare).

Cascades: deleting a `Team` (a team-season) deletes its series, sessions and answers; deleting a
session deletes its answers; a series is never hard-deleted (cancel keeps it), and its sessions'
`seriesId` is `SET NULL` if it ever were. `PracticeAvailability.user` is a `User` relation: it is in
`USER_REFERENCE_COUNT_SELECT`, account deletion purges it with the RSVPs, and the data-subject
export carries it as `practiceAvailability`.

## Recurrence and time zones

No team or league stores a time zone, and ECS runs in UTC, so a series carries its own IANA
`timezone` (the client sends the device zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`).
`utils/practice-recurrence.ts#expandRecurrence` walks the local calendar from `startDate`, keeps the
chosen weekdays (BIWEEKLY: every other Sunday-to-Saturday week, counting the week that holds
`startDate` as "on"), stops at `endDate` or `occurrenceCount`, and turns each local date plus
`startTime` into a UTC instant with `utils/zoned-time.ts#zonedTimeToUtc`, using the zone's offset on
that day. "Tuesdays at 18:00 New York" is 22:00Z in October and 23:00Z in November.
`zoned-time.ts` uses `Intl.DateTimeFormat` (Node's ICU zone data); no date library. A time that
does not exist (inside the spring-forward hour) moves forward by the jump; a time that happens twice
takes the first.

**Materialization is eager and bounded.** `createSeries` writes the series and every session in one
`$transaction`. A series must end: `endDate` at most 366 days after `startDate`, or
`occurrenceCount` 1 to 100, and the expansion may produce at most `MAX_SERIES_OCCURRENCES` (100)
sessions (400 otherwise; 400 too when no chosen weekday falls in the range). Nothing regenerates a
series later, so there is no job and no horizon to extend, and a session edited or deleted on its
own stays as the coach left it. A season-long weekly practice is ~40 rows.

**Season rollover** does not copy series: a series belongs to the team-season row it was created
on, like games. The coach creates a new series on the new season's team.

## Edit and cancel semantics

| Action | Effect |
| --- | --- |
| `PATCH /practices/:id` | Edits one session. On a series occurrence it sets `isException = true`. A cancelled session is not editable (400). |
| `PATCH /practice-series/:id` | "Edit all future": `type`, `title`, `location`, `notes` on the series and on every session with `startsAt > now`, `status = SCHEDULED`, `isException = false`, in one transaction. Dates, times and weekdays are not editable on a series (cancel it and create a new one). 400 on a cancelled series. Answers `{ series, updatedSessions }`. |
| `POST /practices/:id/cancel` | `status = CANCELLED`, `cancelledAt`, optional `reason`. Status-guarded, so a repeat keeps the first time and reason. The row and its answers stay. |
| `DELETE /practices/:id` | Deletes the session and its answers. |
| `DELETE /practice-series/:id` | Cancels the series: stamps `cancelledAt` and deletes every session with `startsAt > now` (exceptions and cancelled ones included; their answers cascade). Sessions that already started stay, still linked, as history. Idempotent: a repeat deletes nothing. Answers `{ series, deletedSessions }`. |

Both series writes are guarded on `cancelledAt IS NULL` inside the transaction, so a cancel that
commits first wins and a concurrent series edit answers 400 instead of touching history.

## Access

All through `utils/permissions.ts`, never a copy:

- **Read** (`GET /practices`, `/practices/:id`, `/practices/:id/availability`,
  `/practice-series/:id`): `canAccessTeam` on the session's team (staff, member, league admin,
  guardian of a member); the list uses `readableTeamsWhere` and leaves a system ADMIN unscoped.
  Denial 403 (as for games), unknown id 404.
- **Write** (create, edit, cancel, delete; single or series): `hasTeamPermission(…, 'canManageTeam')`,
  the same gate as game create. Staff whose role lacks `canManageTeam` get 403.
- **Availability** (`PUT /practices/:id/availability { status, comment?, playerId? }`): the game-RSVP
  rule. A reader answers for themself; with `playerId`, a guardian (`isGuardianOf`) answers for a
  child rostered on the team and the row is keyed on the child. A cancelled session refuses answers
  (400). Rows are projected with `rsvp-service.ts#toRsvpView` (now generic): `user.email` only for
  callers with `canManageRoster` and on the caller's own row.

## Entitlement

Creating a practice (`POST /practices`) or a series (`POST /practice-series`) requires
`Feature.PRACTICE_SCHEDULING` (PREMIUM; `requireEntitlement`, 402 `upgrade_required`, ADMIN
bypass). Editing, cancelling, deleting, reading and answering are not gated, so a lapsed
subscription never leaves a coach unable to cancel what they scheduled. Practices count against no
usage meter (`USAGE_LIMITS` has none that fits). FREE has no purchase path today (#41), so making
practices free is a one-line move of `PRACTICE_SCHEDULING` in `services/entitlements/index.ts`.

## Calendar feed

`CalendarService.buildFeed` lists every session of the team after the games:
UID `practice-<id>@hooplings.com` (frozen, like `game-`), `DTSTART`/`DTEND` in UTC from `startsAt`
and `durationMinutes`, `SUMMARY` `<team>: <title>` or `<team> practice` / `<team> team event`,
`LOCATION`, notes in `DESCRIPTION`, `STATUS:CONFIRMED` or `STATUS:CANCELLED` with the reason.
Deleted sessions (a cancelled series' future) simply leave the feed.

## API

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| POST | `/api/v1/practices` | `{ teamId, startsAt (ISO with Z/offset), durationMinutes 5–720, timezone, type?, title? ≤100, location? ≤200, notes? ≤1000 }` | 201 `{ practice }` |
| GET | `/api/v1/practices` | `?teamId&status&from&to&limit (1–200, 50)&offset` | `{ practices, total, limit, offset }`, soonest first |
| GET | `/api/v1/practices/:id` | | `{ practice }` incl. `availabilitySummary { yes, no, maybe }` |
| PATCH | `/api/v1/practices/:id` | any of the create fields but `teamId` | `{ practice }` |
| POST | `/api/v1/practices/:id/cancel` | `{ reason? ≤500 }` | `{ practice }` |
| DELETE | `/api/v1/practices/:id` | | `{ success, message }` |
| PUT | `/api/v1/practices/:id/availability` | `{ status, comment? ≤500, playerId? }` | `{ availability }` |
| GET | `/api/v1/practices/:id/availability` | | `{ availability[], summary }` |
| POST | `/api/v1/practice-series` | `{ teamId, frequency, weekdays[], startDate, startTime, durationMinutes, timezone, endDate \| occurrenceCount, type?, title?, location?, notes? }` | 201 `{ series }` with `sessions[]` |
| GET | `/api/v1/practice-series/:id` | | `{ series }` |
| PATCH | `/api/v1/practice-series/:id` | `{ type?, title?, location?, notes? }` | `{ series, updatedSessions }` |
| DELETE | `/api/v1/practice-series/:id` | | `{ series, deletedSessions }` |

Every practice payload carries `team { id, name }` and, for a series occurrence,
`series { id, frequency, weekdays, startTime, cancelledAt }` (`PRACTICE_INCLUDE`). Empty strings in
the optional text fields clear them (`null`). Domain events: `Practice created` / `updated` /
`cancelled` / `deleted`, `Practice availability upserted`, `Practice series created`
(`sessionCount`) / `updated` (`updatedSessions`) / `cancelled` (`deletedSessions`), ids only.

## Not built yet

- Notifications: nothing pushes or emails on create, change or cancel (game create does not either).
  The plan's targeted nudges and minimum-attendance alerts are #332 and need a job runner.
- Mobile UI, `mobile/` types and the Maestro flow (the next PR).
- Socket.io updates for practices.

## What the mobile PR builds

- Hooks over the endpoints above (TanStack Query; invalidate the list, the detail and the
  availability query on every mutation) and an Amplitude event per mutation hook.
- A team schedule that merges `GET /games?teamId` and `GET /practices?teamId&from` by start time,
  with a recurring indicator when `seriesId` is set and a cancelled state.
- Practice detail: one-tap YES/NO/MAYBE (`PUT …/availability`, `playerId` for a guardian's child),
  the summary, and the coach's roster breakdown (`GET …/availability`).
- Coach create form (one-off or recurring: weekdays, weekly/biweekly, start date and time, duration,
  end date or count), sending the device zone; "edit this practice" vs "edit all future practices";
  cancel one / cancel series. Coach UI gates on `hasTeamPermission(…, 'canManageTeam')`.
- Dates through `utils/format-date.ts` in the session's `timezone`; the create form through
  `DateTimePickerSheet`; 402 handling on create (or the entitlement decision above first).
- A Maestro flow (create a series, answer availability, cancel), with a seed reset if it mutates.

## Tests

`tests/utils/practice-recurrence.test.ts` (zones, both DST directions, both hemispheres, the
skipped and repeated hour, BIWEEKLY, both end conditions, the cap), `tests/schemas/practices.test.ts`,
`tests/services/practice-service.test.ts` (both services against the Prisma mock, domain events),
`tests/api/practices.test.ts` (routes with the real services, 402/403/400/404), and the real-database
`tests/integration/practice-schedule.db.test.ts` (a year-long series materialized in Postgres at
18:00 local on both sides of DST, access through the real predicates for staff, member, guardian and
outsider, exceptions surviving a series edit, series cancel keeping history, the ICS feed, account
deletion purging answers). `tests/services/calendar-service.test.ts` covers the feed entries.
