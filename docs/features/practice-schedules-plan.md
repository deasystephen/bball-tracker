# Team Practice Schedules — Feature Plan

> Status: **Proposed (build-ready)** — awaiting approval to implement.
> Branch: `claude/team-practice-schedules-2ouh3e`

## 1. Goal & Product Thesis

Coaches need to set and maintain a team practice schedule (location + time), and
players/parents need to mark availability. That baseline is table stakes —
TeamSnap, Spond, Heja, and TeamCord all do it, and Spond does it free.

The differentiating thesis: **this app is a tracker, not just a calendar.** We
own roster, RSVP history, attendance, and a real-time engine, so practice
scheduling should be *connected and low-friction*, not a standalone checkbox.
The prioritized differentiators (chosen by product) are:

1. **Recurring availability defaults** — players set standing constraints once
   ("never Tuesdays", "out until Aug 15"); they auto-apply to future practices.
   Removes the repetitive-RSVP grind every incumbent suffers from.
2. **Minimum-attendance alerts** — coach sets a threshold per practice; if
   confirmed turnout will fall short by a deadline, coach gets a one-tap
   *cancel & notify* / *reschedule* alert.
3. **Carpool / ride coordination** — parents offer and claim ride seats per
   practice. A real youth-sports pain point that the major apps ignore.

> Deferred (not in this plan, but data model leaves room): smart headcount /
> no-show prediction, practice plans & drills linked to in-game stats.

## 2. Competitive Landscape (summary)

| App | Availability | Recurring | Reminders | Gaps we exploit |
| --- | --- | --- | --- | --- |
| Spond | Free, Y/N/Maybe | Yes | Blanket | No standing defaults; no carpool; dumb reminders |
| TeamSnap | Paywalled | Yes | Yes | Cost; no carpool |
| Heja | Free/ad | Yes | Yes | Comms-first; no payments; no carpool |
| TeamCord | One-tap | Yes | Non-responder nudges | No standing defaults; no carpool |

Common gaps everywhere: availability is a dumb yes/no, reminders nag everyone
equally, and **carpool/ride coordination is absent**. Our three differentiators
target exactly these gaps.

## 3. Architecture Fit (high reuse)

`Feature.PRACTICE_SCHEDULING` already exists in the entitlements enum (PREMIUM
tier) — no entitlement plumbing needed. Confirmed reusable assets:

| Need | Reuse | Location |
| --- | --- | --- |
| Availability statuses | `RsvpStatus` enum (YES/NO/MAYBE) | `prisma/schema.prisma:70` |
| RSVP shape | `GameRsvp` model | `prisma/schema.prisma:424` |
| Coach vs player perms | `hasTeamPermission` / `canAccessTeam` | `backend/src/utils/permissions.ts` |
| Push notifications | `NotificationService.sendToTeam/sendToUsers` | `backend/src/services/notification-service.ts` |
| Email | `mailer` (SES + FakeMailer) | `backend/src/services/mailer/index.ts` |
| Calendar feed | `CalendarService.buildFeed` | `backend/src/services/calendar-service.ts` |
| Feature gating | `requireEntitlement(Feature.PRACTICE_SCHEDULING)` | `backend/src/api/middleware/entitlements.ts` |
| Real-time | Socket.io room pattern | `backend/src/websocket/game-events.ts` |
| API/service/test shape | mirror `games/` | `backend/src/api/games/`, `backend/src/services/game-service.ts` |

## 4. Data Model (new Prisma models)

```prisma
enum PracticeStatus {
  SCHEDULED
  CANCELLED
}

// A recurrence template. One row per recurring practice "rule".
model PracticeSeries {
  id          String   @id @default(uuid())
  teamId      String
  seasonId    String?
  title       String
  location    String
  locationNotes String?
  // RFC 5545 RRULE, e.g. "FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20260901T000000Z"
  rrule       String
  startTime   String   // "16:00" local wall-clock
  durationMinutes Int
  timezone    String   // IANA tz, e.g. "America/New_York" (see §9)
  createdById String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  team     Team             @relation(fields: [teamId], references: [id], onDelete: Cascade)
  sessions PracticeSession[]

  @@index([teamId])
}

// A concrete, dated practice. Standalone (seriesId null) OR a series occurrence.
// Occurrences are materialized on series create and on edit, so single-occurrence
// overrides ("this one moved to the gym") and per-session availability just work.
model PracticeSession {
  id            String         @id @default(uuid())
  teamId        String
  seriesId      String?
  title         String
  location      String
  locationNotes String?
  startsAt      DateTime       // stored UTC; rendered in series/team tz
  durationMinutes Int
  status        PracticeStatus @default(SCHEDULED)
  minAttendance Int?           // differentiator #2
  cancelReason  String?
  createdById   String
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  team         Team                   @relation(fields: [teamId], references: [id], onDelete: Cascade)
  series       PracticeSeries?        @relation(fields: [seriesId], references: [id], onDelete: SetNull)
  availability PracticeAvailability[]
  rides        PracticeRide[]

  @@index([teamId])
  @@index([startsAt])
  @@index([status])
}

model PracticeAvailability {
  id         String     @id @default(uuid())
  sessionId  String
  userId     String
  status     RsvpStatus
  comment    String?
  // true when this row was auto-filled from a recurring default (differentiator #1)
  fromDefault Boolean   @default(false)
  createdAt  DateTime   @default(now())
  updatedAt  DateTime   @updatedAt

  session PracticeSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  user    User            @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([sessionId, userId])
  @@index([sessionId])
}

// Differentiator #1: standing availability constraints per player per team.
model AvailabilityDefault {
  id        String     @id @default(uuid())
  teamId    String
  userId    String
  // Recurring weekly rule (e.g. "every Tuesday I'm out") ...
  weekday   Int?       // 0-6, null if this is a date-range rule
  // ... or a date range ("out until Aug 15")
  fromDate  DateTime?
  untilDate DateTime?
  status    RsvpStatus // typically NO, but MAYBE supported
  note      String?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([teamId, userId])
}

// Differentiator #3: carpool. A parent offers seats; others claim them.
model PracticeRide {
  id          String   @id @default(uuid())
  sessionId   String
  driverId    String   // offering user
  seatsTotal  Int
  direction   String   // "TO" | "FROM" | "BOTH"
  notes       String?  // pickup area, departure time
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  session PracticeSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  driver  User            @relation("RideDriver", fields: [driverId], references: [id], onDelete: Cascade)
  claims  PracticeRideClaim[]

  @@index([sessionId])
}

model PracticeRideClaim {
  id        String   @id @default(uuid())
  rideId    String
  riderId   String   // player/parent claiming a seat
  seats     Int      @default(1)
  createdAt DateTime @default(now())

  ride  PracticeRide @relation(fields: [rideId], references: [id], onDelete: Cascade)
  rider User         @relation("RideRider", fields: [riderId], references: [id], onDelete: Cascade)

  @@unique([rideId, riderId])
}
```

Back-relations (`practiceSeries`, `practiceSessions`, `availabilityDefaults`,
`rides`, etc.) get added to `Team` and `User`. Migration via
`npm run prisma:migrate`.

## 5. Backend API

New resource dir `backend/src/api/practice-schedules/` (`routes.ts`,
`schemas.ts`), service `backend/src/services/practice-schedule-service.ts`,
mirroring `games/` and `game-service.ts`. All routes behind `authenticate`;
**write routes** additionally behind `requireEntitlement(Feature.PRACTICE_SCHEDULING)`
and a `canManageTeam` permission check; **read/availability/ride routes** behind
`canAccessTeam`.

### Practices
- `POST   /api/v1/teams/:teamId/practices` — create one-off or series (coach). Body
  optionally includes `rrule` → materializes sessions. `402` if not entitled.
- `GET    /api/v1/teams/:teamId/practices?from&to&status` — list sessions for a window.
- `GET    /api/v1/practices/:sessionId` — detail incl. availability summary + rides.
- `PATCH  /api/v1/practices/:sessionId` — edit a single occurrence (coach).
- `PATCH  /api/v1/practices/series/:seriesId` — edit whole series going forward (coach).
- `POST   /api/v1/practices/:sessionId/cancel` — cancel + notify (coach).
- `DELETE /api/v1/practices/:sessionId` — delete (coach).

### Availability
- `PUT    /api/v1/practices/:sessionId/availability` — upsert my status `{status, comment}`.
- `GET    /api/v1/practices/:sessionId/availability` — roster breakdown (coach + members).

### Availability defaults (differentiator #1)
- `GET/PUT /api/v1/teams/:teamId/availability-defaults` — my standing rules.
- On practice/session creation, the service seeds `PracticeAvailability`
  (`fromDefault=true`) from matching defaults; an explicit player response always
  overrides a default.

### Carpool (differentiator #3)
- `POST   /api/v1/practices/:sessionId/rides` — offer ride `{seatsTotal, direction, notes}`.
- `POST   /api/v1/rides/:rideId/claim` — claim seat(s); rejects if no seats left.
- `DELETE /api/v1/rides/:rideId/claim` — release my claim.
- `DELETE /api/v1/rides/:rideId` — driver withdraws offer.

### Response & validation conventions
- Responses: `{ success: true, ... }` / `{ error }` (matches `games/`).
- Zod schemas in `schemas.ts` with inferred input types; **schema tests required**.
- Validate: rrule format, `durationMinutes > 0`, `minAttendance >= 0`, IANA tz,
  ride `seats > 0`, claim seats not exceeding remaining.

## 6. Notifications & Scheduled Jobs

Reuse `NotificationService.sendToTeam` (push) + `mailer` (email):

- **Practice created / changed / cancelled** → notify team (exclude actor).
- **Targeted non-responder nudge** → `sendToUsers([unresponded])` only, N hours
  before start (beats Spond's blanket reminders). Not the whole team.
- **Min-attendance alert (differentiator #2)** → scheduled check at the response
  deadline; if `confirmed (YES) < minAttendance`, push to coaches with deep-link
  to cancel/reschedule.
- **Carpool** → notify a player with no ride when seats open; notify driver on claim.

Scheduling: add a lightweight job runner. Confirm whether one exists (cron /
BullMQ / Flink timer) before adding a dependency — see §10 open question. MVP
fallback: compute nudges/alerts lazily on read + a single periodic sweep.

## 7. Calendar & Real-time

- **ICS:** extend `CalendarService.buildFeed` to include `SCHEDULED` practices
  (`uid: practice-<id>@capyhoops.com`, title "Practice — <location>",
  `CANCELLED` → ICS `CANCELLED`). Gated by existing `CALENDAR_SYNC`.
- **Real-time (optional, Phase B):** Socket.io room `practice:<sessionId>`,
  event `practice-availability-change` and `practice-ride-change`, mirroring
  `game-events.ts`. Coaches watching the roster see live updates.

## 8. Mobile (Expo / React Native)

- Hooks: `mobile/hooks/usePracticeSchedules.ts` (TanStack Query +
  `apiClient`), `useAvailabilityDefaults.ts`, `usePracticeRides.ts`, with
  `invalidateQueries` on mutations.
- Screens under `mobile/app/teams/[id]/`:
  - `practices/index.tsx` — upcoming list, headcount chips, my status.
  - `practices/[sessionId].tsx` — detail: one-tap Yes/No/Maybe, roster
    breakdown (coach), carpool section, cancel/edit (coach).
  - `practices/create.tsx` — coach form (one-off or recurring, min-attendance).
  - `availability-defaults.tsx` — "I can never make…" standing rules.
- Permissions gate coach-only UI via `hasTeamPermission`. Coach create UI shows
  the upgrade prompt path on `402` (PREMIUM gate).
- **Maestro E2E** in `.maestro/` (repo requires it for major mobile features):
  login → team → create practice → set availability → assert headcount.

## 9. Timezone Handling

Games currently store `DateTime` as UTC with no tz field; for *recurring*
practices that's not enough ("4pm every Tuesday" must survive DST). Plan:
`PracticeSeries.timezone` (IANA) + wall-clock `startTime`; materialize each
`PracticeSession.startsAt` to a correct UTC instant per occurrence. Render in the
series tz on mobile/ICS. This is additive and does not change game behavior.

## 10. Testing (repo conventions — all three layers)

- `tests/schemas/` — Zod edge cases (rrule, tz, durations, seats, min-attendance).
- `tests/services/` — `practice-schedule-service` incl. recurrence materialization,
  default-seeding override logic, min-attendance computation, ride seat math.
- `tests/api/` — full request/response through routes incl. entitlement `402`,
  permission `403`, availability upsert, carpool claim contention.
- Add factories (`createPractice`, `createPracticeSeries`, etc.).
- CI must pass clean (lint + types + tests), no `eslint-disable`.

## 11. Phased Delivery

- **Phase 1 — Backend core:** models + migration; service; practice CRUD +
  availability API; entitlement/permission gating; full test suite. *Ships a
  working coach-CRUD + availability API.*
- **Phase 2 — Differentiators (backend):** availability defaults + seeding;
  min-attendance alerts; carpool endpoints; targeted non-responder nudges;
  notifications; ICS extension.
- **Phase 3 — Mobile:** hooks + screens + one-tap availability + carpool UI +
  defaults UI + Maestro flow.
- **Phase 4 (optional):** real-time roster via Socket.io; deferred
  smart-headcount and practice-plans/drills.

Docs (`CLAUDE.md` architecture section, this file, calendar/runbook notes)
updated in the same change set per repo hygiene rules.

## 12. Open Questions (resolve before/early in implementation)

1. **Scheduled jobs:** does a runner exist (cron/BullMQ/Flink timer) for nudges &
   min-attendance checks, or do we add one? Affects Phase 2.
2. **Who can RSVP for whom?** Parents with managed players (`isManaged`/
   `managedById`) presumably respond on a child's behalf — confirm the actor→
   subject mapping for availability and carpool.
3. **Recurrence edit semantics:** confirm "this occurrence" vs "this and future"
   vs "all" — plan implements one-off override + series-going-forward.
4. **Notification volume / quiet hours:** any global preference/opt-out we must
   respect before adding practice nudges?
