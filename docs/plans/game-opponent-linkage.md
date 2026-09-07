# Game opponent linkage: two rows, one Matchup (#494)

Source: `/plan-eng-review` of issue #494 on 2026-09-07, with an outside-voice challenge (Claude
subagent, fresh context; Codex not installed) whose accepted corrections are folded in below.
Resolves **trigger 1** of the competition build (#492). Parent issue: #462. Companion design:
`docs/plans/team-lineage-and-competition.md` (the `Competition` / `CompetitionEntry` half, which
this plan assumes and extends).

**Deliverable of #494 is this document.** The schema, migration and behaviour below are built
inside #492 (its PR 2 and PR 3), because the only place an in-system opponent can be *picked* is a
competition's entry list. Nothing here ships on its own, and PR 2 does not start until a real
organizer has two teams entered (#492 trigger 2).

## Problem

`Game.opponent` is free text and `Game` keys on one `teamId`. A game between two in-system teams
is two rows today, each with the other as text, each with its own derived `homeScore` and a
client-typed `awayScore`, and the two rows can disagree. Standings and fixtures need one result
per real game.

Three facts, verified in code, settle the one-row-or-two question:

| Fact | Where | Consequence |
|------|-------|-------------|
| Opponents are undiscoverable outside a competition | `listTeams` ANDs `teamAccessWhere` (#443) | An opponent picker exists only over `CompetitionEntry`; `opponentTeamId` alone is dead schema |
| Events may carry no player | `GameEvent.playerId String?`; `createEvent` writes `playerId \|\| null` | One row cannot attribute a player-less SHOT to a side; every event would need a `teamId` |
| Every binary reads one perspective | `game.team` = "my team", `homeScore` = "my score" in 5 screens + `utils/game-result.ts` | One row needs a per-caller payload for one game id, undefined for admins |

One row also makes `status` shared: coach A ending the game while coach B still tracks has no
good answer. Two rows keep status, events, undo, streak seeding and the socket room per side, so
`GameEventService`, `track.tsx` and the Socket.io payload shapes do not change.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D2 | **Two `Game` rows, linked by a `Matchup` parent.** `Game.matchupId?` only; **no** denormalized `Game.opponentTeamId` | One home for "who is the opponent"; a second copy has no reader and is a drift class |
| D2 | `Matchup.competitionId` is **required** | Linkage exists only where a picker exists (entry list). Outside a competition nothing changes |
| D3/D11 | **Linked `awayScore` is PROJECTED at read**, never written across rows: for a linked game the payload's `awayScore` = the other row's `homeScore` when that row has SHOT events, else the stored client value; `awayScoreDerived` says which. **The SHOT write path is unchanged** (one row, one lock) | Same "derived beats manual" rule as `homeScore` today, implemented like the `opponent` projection (D8). Outside voice: a persisted mirror needed a cross-row lock that deadlocks with the FK `KEY SHARE` taken by the event INSERT, rewrote FINISHED rows under another team's fingers, and forced `updateGame` into a transaction. Projection removes the whole class |
| D4 | **Matchup is a shared schedule entry.** `date` and `status` (SCHEDULED / CANCELLED) live on `Matchup` and propagate to both `Game` rows in one transaction; the **mirror row is auto-created** for the other team | Two schedules never disagree on when, or whether, the game happens. Accepted cost: cross-team writes (mirror row at create, `date`/cancel later), each gated, pushed to both teams, tested |
| D5 | **Both doors, one code path:** organizer creates fixtures (`canWriteCompetition`), a coach picks an opponent from entries (`canManageTeam` on own side). `Matchup.source` records which | The write is identical; only the gate differs, and standings need to know who proposed the game |
| D12 | **Consent posture.** Joining a competition consents to the ORGANIZER's fixtures appearing on your schedule. A COACH-created matchup is a *proposal*: the mirror row is created and the other team's staff get a push with a Decline action; **declining = deleting your row, which deletes the matchup** (the proposer's game becomes a plain free-text game). Standings: ORGANIZER matchups count `ONE_SIDED` (provisional); COACH matchups count only `AGREED` or `RULED` | Without this a coach could create a fixture, hand-enter 50-0 on their own row and farm wins the other team cannot refuse |
| D6 | **Ruling stored on `Matchup`; result status derived at read** (`PENDING / ONE_SIDED / AGREED / DISPUTED / RULED / CANCELLED`). A ruling never overrides tracked scores | Scores, usage and W/L are already read-time derivations; only the ruling is not derivable |
| D7 | `recomputeHomeScore` **stays as is** (single row). The only change on the SHOT path is a second `game-score-change` emit to the linked row's room, carrying that room's projected perspective | Superseded the "lock both rows" plan after D11 |
| D8 | **`opponent` is projected at read** from the matchup's other team name; the stored column is written at creation as fallback for detached rows and old binaries. `PATCH { opponent }` on a linked row → 400 | Rename-proof; the join already exists for the matchup payload |
| D9 | **Real-Postgres test** for two concurrent trackers on one matchup, plus matchup access one fixture per branch | With D11 it proves the *absence* of cross-row interaction (both rows converge to their own derived scores, no `40P01`); the mocked suite cannot fail for that |
| D13 | Entry withdrawal detaches that team's matchups in the same transaction; standings iterate **current entries** only; reschedule and cancel push to **both teams'** members and guardians (`sendToTeam`, RSVPs kept); create asserts `teamId ∈ {host, visitor}` | Every one a silent wrong state in standings or a parent at the wrong gym otherwise |
| — | `Matchup` sides are `hostTeamId` / `visitorTeamId`, **not** home/away | `Game.homeScore` already means "my team" (perspective); reusing home/away on the matchup would collide |
| — | A `Matchup` dies with its **last** `Game` (ORGANIZER source) or with the **other side's** delete (COACH source, D12); a delete never touches the other team's events | A delete must never cross team boundaries or destroy another team's tracked data |

## Target shape

```
Competition (organizer's season; #492)
   │
   ├─< CompetitionEntry (competitionId, teamId)
   │
   └─< Matchup (competitionId, hostTeamId, visitorTeamId, date, status, source, ruling*)
           │
           ├── Game (teamId = host,    matchupId)   ← host coach's row: own events, own status, RSVPs
           └── Game (teamId = visitor, matchupId)   ← visitor coach's row: own events, own status, RSVPs

   Game.homeScore  = derived from OWN shots (unchanged, written)
   Game.awayScore  = stored client value; PROJECTED on read from the linked row's homeScore when
                     that row has SHOT events (D11) — never written across rows
   Game.date       = copy of Matchup.date (D4), kept in step by MatchupService.reschedule
   Game.status     = own (SCHEDULED → IN_PROGRESS → FINISHED); Matchup.status CANCELLED propagates
                     CANCELLED to both rows (D13)
   Game.opponent   = stored at creation; projected from the other team's live name on read (D8)
   @@unique([matchupId, teamId]) on Game: at most one row per side; create asserts the side is host or visitor
```

### Score flow (D3, D7, D10, D11)

```
coach A taps SHOT on row A ──► POST /games/A/events                         (UNCHANGED write path)
                                   │  $transaction
                                   ├── INSERT GameEvent
                                   └── recomputeHomeScore(tx, A)   lock A FOR UPDATE, A.homeScore = Σ A.shots
                                   emit game-score-change → room game:A  { home: A.homeScore, away: project(A) }
                                   emit game-score-change → room game:B  { home: B.homeScore, away: A.homeScore }   (NEW)

serializeGame(row, linked):                                                  (READ projection)
   awayScoreDerived = linked != null && linked.shotCount > 0
   awayScore        = awayScoreDerived ? linked.homeScore : row.awayScore
   opponent         = linked ? otherTeam.name : row.opponent

coach A taps "+2 opponent" ──► PATCH /games/A { awayScore }                  (stored as today)
                               shown only while B has no SHOT events; the tracker disables the buttons on
                               awayScoreDerived, and a stale tap is stored but never shown
```

`linked.shotCount` is a filtered relation count (`_count: { events: { where: { eventType: 'SHOT' } } }`)
in the same include that fetches the matchup, so a list read of linked games costs one join, not N
queries. `stats-service.ts` (`record[gameResult(...)]`, `recentGames`) reads through the same
projection, so a team's W/L follows the tracked truth when the other side tracked.

### Result state (D6, D12, D13)

```
                 ┌── Matchup.status CANCELLED ─────────────────────► CANCELLED  (excluded; both rows CANCELLED)
                 │
                 ├── no row FINISHED ──────────────────────────────► PENDING    (excluded)
                 │
 Matchup ────────┼── exactly one row FINISHED ─────────────────────► ONE_SIDED  (counted iff source = ORGANIZER,
 (H, V rows;     │                                                                flagged provisional)
  either may be  │                 ┌── projected points agree ─────► AGREED     (counted)
  missing)       └── both FINISHED ┤   (derived beats manual)
                                   └── manual vs manual differ ────► DISPUTED   (excluded; in disputedCount)
                                                                        │
                                             organizer POST …/ruling ───┴──► RULED  (counted)
                                             400 if either side has SHOT events (never overrides tracked)

 Points for side S = Σ S.row.shots                     if S.row has SHOT events
                     else the FINISHED manual value(s): S.row.homeScore and/or other.row.awayScore
                     (equal or single → that value; differing → DISPUTED; ruling* wins when set and no side tracked)
 Standings iterate CURRENT CompetitionEntry rows; a withdrawn team's matchups were detached at withdrawal (D13).
```

`deriveMatchupResult(matchup, rows)` is the ONLY implementation (backend
`utils/matchup-result.ts`; mobile mirrors labels/colours in `utils/matchup-result.ts`, same
never-inline rule as `game-result.ts`). Standings = a pure function over a competition's matchups.

### Access model

```
                      host/visitor staff+members+guardians   competition readers        organizer admins   anyone else
                      (canAccessTeam on OWN row)             (competitionAccessWhere)   (canWriteCompetition)
Own Game row          full (as today)                        —                          —                  404/403 as today
Other side's row      never (canAccessTeam fails)            never                      never              never
matchup summary on    yes: teams {id,name}, date, source,    yes (via competition       yes                no
  GET /games/:id        otherSide {status, homeScore},         matchups list)
                        result, awayScoreDerived
GET /competitions/:id/matchups, /standings   yes (own team entered)  yes                yes (+ ruling*)    404
POST matchups (fixture)                       coach: canManageTeam on own side, both entered   organizer   403
PATCH date / cancel                           coach: canManageTeam on own side (propagates)    organizer   403
DELETE own Game row                           coach: canManageTeam (existing)                  —           —
DELETE matchup                                —                                                organizer   403
POST …/ruling                                 no (403)                                          yes        403
```

No people fields ever cross a team boundary: the matchup summary carries team `{ id, name }`,
status and scores only. `GAME_DETAIL_INCLUDE.team.members` stays scoped to the caller's own row.

## Schema

```prisma
enum MatchupSource { ORGANIZER COACH }
enum MatchupStatus { SCHEDULED CANCELLED }

model Matchup {
  id              String        @id @default(uuid())
  competitionId   String
  hostTeamId      String
  visitorTeamId   String
  date            DateTime
  status          MatchupStatus @default(SCHEDULED)
  // Who proposed it (D5/D12): ORGANIZER fixtures count ONE_SIDED results
  // provisionally; COACH proposals count only AGREED/RULED, and the other
  // side declines by deleting its row, which deletes the matchup.
  source          MatchupSource
  // Organizer ruling for DISPUTED results only (D6). Never applied while either
  // side has SHOT events. rulingNote covers forfeits ("visitor forfeit, 20-0").
  rulingHostScore    Int?
  rulingVisitorScore Int?
  rulingNote         String?    // trimmed, max 200
  ruledById          String?
  ruledAt            DateTime?
  createdById     String
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  competition Competition @relation(fields: [competitionId], references: [id], onDelete: Cascade)
  hostTeam    Team        @relation("MatchupHost",    fields: [hostTeamId],    references: [id], onDelete: Cascade)
  visitorTeam Team        @relation("MatchupVisitor", fields: [visitorTeamId], references: [id], onDelete: Cascade)
  ruledBy     User?       @relation("MatchupRuledBy",   fields: [ruledById],   references: [id], onDelete: SetNull)
  createdBy   User        @relation("MatchupCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  games       Game[]

  @@index([competitionId])
  @@index([hostTeamId])
  @@index([visitorTeamId])
}

model Game {
  // existing fields …
  matchupId String?
  matchup   Matchup? @relation(fields: [matchupId], references: [id], onDelete: SetNull)
  // At most one row per side of a matchup. Postgres treats NULLs as distinct,
  // so unlinked games are unaffected. The create path additionally asserts
  // teamId ∈ { hostTeamId, visitorTeamId } (the index cannot).
  @@unique([matchupId, teamId])
  @@index([matchupId])
}
```

Delete semantics, all by FK: competition deleted → matchups cascade → games detach (`SetNull`,
events intact, scores stay as persisted); team deleted → its games cascade (today) and its
matchups cascade → the other side's game detaches; user deleted → `ruledById` nulls,
`createdById` restricts (same posture as `Team.lineage`). Application rules: `deleteGame` on a
linked row deletes the `Matchup` in the same transaction when it was the last game (ORGANIZER) or
when the deleter is the non-proposing side (COACH, D12); entry withdrawal detaches every matchup
of that team (`updateMany matchupId = null` on its games, delete the matchups) in the
withdrawal transaction (D13).

### Migration (hand-written; additive, no backfill)

Depends on the `Competition` table from #492's migration, so it is the second file in that PR
(or the same file, after `CompetitionEntry`).

```sql
CREATE TYPE "MatchupSource" AS ENUM ('ORGANIZER', 'COACH');
CREATE TYPE "MatchupStatus" AS ENUM ('SCHEDULED', 'CANCELLED');
CREATE TABLE "Matchup" (
  "id"                 TEXT NOT NULL,
  "competitionId"      TEXT NOT NULL,
  "hostTeamId"         TEXT NOT NULL,
  "visitorTeamId"      TEXT NOT NULL,
  "date"               TIMESTAMP(3) NOT NULL,
  "status"             "MatchupStatus" NOT NULL DEFAULT 'SCHEDULED',
  "source"             "MatchupSource" NOT NULL,
  "rulingHostScore"    INTEGER,
  "rulingVisitorScore" INTEGER,
  "rulingNote"         TEXT,
  "ruledById"          TEXT,
  "ruledAt"            TIMESTAMP(3),
  "createdById"        TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Matchup_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Matchup"
  ADD CONSTRAINT "Matchup_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Matchup_hostTeamId_fkey"    FOREIGN KEY ("hostTeamId")    REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Matchup_visitorTeamId_fkey" FOREIGN KEY ("visitorTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Matchup_ruledById_fkey"     FOREIGN KEY ("ruledById")     REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Matchup_createdById_fkey"   FOREIGN KEY ("createdById")   REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Matchup_competitionId_idx" ON "Matchup"("competitionId");
CREATE INDEX "Matchup_hostTeamId_idx"    ON "Matchup"("hostTeamId");
CREATE INDEX "Matchup_visitorTeamId_idx" ON "Matchup"("visitorTeamId");

ALTER TABLE "Game" ADD COLUMN "matchupId" TEXT;
ALTER TABLE "Game" ADD CONSTRAINT "Game_matchupId_fkey"
  FOREIGN KEY ("matchupId") REFERENCES "Matchup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Game_matchupId_teamId_key" ON "Game"("matchupId", "teamId");
CREATE INDEX "Game_matchupId_idx" ON "Game"("matchupId");
```

No `UPDATE … SET`, no `SET NOT NULL`: the empty-DB CI run is sufficient evidence and the #29
snapshot rehearsal is not required for this file. Production applies it in `docker/entrypoint.sh`
under the #455 circuit breaker like every other migration.

## Service and API

`services/matchup-service.ts` (new; header comment carries the state diagram and the
delete/race table). `GameService` calls into it; `GameEventService` only gains the second emit
and never imports it.

| Route | Gate | Behaviour |
|-------|------|-----------|
| `POST /games { teamId, opponentTeamId, competitionId, date, … }` | `canManageTeam(teamId)`; **both** teams entered in `competitionId`; `opponentTeamId !== teamId` else 400 | One `$transaction`: `Matchup` (host = caller's team, `source: COACH`) + caller's `Game` + mirror `Game` for the opponent (`SCHEDULED`, scores 0, `opponent` = other name snapshot, `competitionId` from the matchup). Returns the caller's row with `matchup`. Push `matchup_proposed` (with Decline) to the other team's staff. **Without `opponentTeamId` the route is byte-identical to today.** |
| `POST /competitions/:id/matchups { hostTeamId, visitorTeamId, date }` | `canWriteCompetition`; both entered; host ≠ visitor | Same transaction, `source: ORGANIZER`, `createdById` = organizer. Push `matchup_created` to both teams (staff, members, guardians). |
| `GET /competitions/:id/matchups` | competition readers | Fixtures: `{ id, date, status, source, hostTeam {id,name}, visitorTeam {id,name}, result: deriveMatchupResult(…), sides: [{ teamId, status, homeScore }] }`. Ruling fields only for `canWriteCompetition`. No people. |
| `GET /competitions/:id/standings` | competition readers | Per **current** entry: `{ team {id,name}, played, wins, losses, ties, pointsFor, pointsAgainst, provisional }` from AGREED + RULED + (ORGANIZER-source) ONE_SIDED; `disputedCount`, `pendingCount` alongside. Teams with no matchups appear with zeros. |
| `PATCH /games/:id { date }` on a linked row | existing gate (`canManageTeam`) | `MatchupService.reschedule`: one transaction updates `Matchup.date` + both `Game.date`; push `matchup_rescheduled` to **both** teams via `sendToTeam` (RSVPs kept). `{ status: 'CANCELLED' }` on a linked row → `MatchupService.cancel` (same shape, `Matchup.status` + both rows). `{ competitionId }` or `{ opponent }` on a linked row → 400 `Change this through the matchup` (v1: delete and recreate). |
| `PATCH /competitions/:id/matchups/:mid { date? , status? }` | `canWriteCompetition` | Same `reschedule` / `cancel`. |
| `DELETE /games/:id` on a linked row | existing gate | Deletes own row. ORGANIZER source: matchup deleted iff no other game references it (the other side keeps its row → ONE_SIDED/PENDING). COACH source: if the deleter is the non-proposing side this is the **decline** → matchup deleted, proposer's row detaches to a plain game; if the proposer deletes, the matchup is deleted too (a proposal withdrawn) and the mirror row is **deleted with it** (it was never accepted). |
| `DELETE /competitions/:id/matchups/:mid` | `canWriteCompetition` | Deletes the matchup; both games detach (`SetNull`) and survive as plain games with their persisted scores. |
| `DELETE /competitions/:id/entries/:teamId` (#492) | as designed | **Also** detaches that team's matchups (both sides' games `matchupId = null`, matchups deleted) in the same transaction (D13). |
| `POST /competitions/:id/matchups/:mid/ruling { hostScore, visitorScore, note? }` | `canWriteCompetition` | 400 `Result is derived from tracked events` if either side has SHOT events; 400 on CANCELLED; else sets ruling fields. |
| `POST /games/:id/events`, `DELETE /games/:id/events/:eid` (SHOT) | unchanged | `recomputeHomeScore` unchanged; **one additional** `game-score-change` emit to the linked row's room with that room's projected perspective. |
| `GET /games`, `GET /games/:id`, `GET /stats/teams/:id` (`recentGames`, record) | unchanged | Payload passes through `serializeGame`: `opponent` projected (D8), `awayScore` projected (D11), plus `matchup` summary and `awayScoreDerived`. Additive: build #31 ignores the new fields and sees correct strings/numbers in the old ones. |

`utils/permissions.ts` gains no new predicate: matchup writes reuse `canManageTeam` (own side)
and `canWriteCompetition` (organizer); reads reuse `canAccessTeam` (own row) and
`competitionAccessWhere` (fixtures/standings). The league-access comment block gets a
"Matchup" row saying exactly that.

### Race and delete rules (header comment of `matchup-service.ts`)

| Event | Rule |
|-------|------|
| Two trackers, same matchup, overlapping SHOT writes | Each transaction locks and writes ONLY its own row (unchanged). No cross-row lock exists, so no deadlock class (D11; D9 test proves both rows converge). |
| Double create (coach taps twice) | Pre-check "an active matchup between these teams on this date in this competition" → 400 `A matchup between these teams already exists for this date`; a lost race creates a duplicate the proposer or organizer can delete (accepted: same-second double-tap, visible, reversible). |
| Mirror row insert conflicts | `@@unique([matchupId, teamId])` P2002 → transaction rollback → 400 (cannot happen without a bug; asserted). |
| Third team's row pointing at a matchup | Create asserts `teamId ∈ {host, visitor}` → 400 (the unique index cannot express it). |
| Delete one side while the other tracks | Own row goes per the source rules; the other's SHOT path never looked at it. |
| Organizer rules, then a coach starts tracking | Derived beats ruling at read; ruling fields stay for audit; result flips to AGREED/ONE_SIDED. Documented, tested. |
| Cancel while a side is IN_PROGRESS | Allowed for the organizer (their fixture); a coach cancelling a COACH matchup while the other side is IN_PROGRESS → 400 `The other team is tracking this game`. |
| Team withdraws from the competition | Its matchups detached in the withdrawal transaction; standings iterate current entries so the team disappears from the table. |
| Team renamed | Projection (D8) shows the new name everywhere; stored snapshot only surfaces on detached rows. |
| Competition deleted | Matchups cascade, games detach, nothing else changes. |

## Mobile

- **Create game** (`app/games/create.tsx`): when the selected team has ≥1 competition with other
  entries (`useTeam(teamId).competitions` from #492 + `useCompetitionEntries`), the Opponent
  field becomes a picker (competition → entered team) with an "Other team (type a name)" escape to
  today's text input. Hidden entirely when there are no entries. Derivation in
  `utils/matchup-scope.ts#opponentChoices(team, competitions)`, never inline.
- **Game detail** (`app/games/[id]/index.tsx`): "Competition · vs <team>" badge with a
  "Proposed by <team>" line for COACH matchups the caller's team did not create, and a **Decline**
  action (= delete own row, confirm dialog names the consequence); other side's status/score line
  when the linked row exists; result label via `utils/matchup-result.ts`.
- **Tracker** (`app/games/[id]/track.tsx`): opponent +1/+2/+3/−1 buttons disabled with helper
  text "<team> is tracking their own score" when `game.awayScoreDerived`; `awayScore` renders from
  the detail cache exactly like `homeScore` does today (the second `game-score-change` emit keeps
  it live).
- **Live** (`live.tsx`): no change; the room already receives both numbers.
- **Competition screens** (#492): fixtures list (date, teams, source, result chip), standings
  table (W-L-T, PF/PA, provisional marker, disputed count), organizer: create fixture, reschedule,
  cancel, delete, **Rule result** sheet on DISPUTED rows (`components/ActionMenu` pattern).
- Push copy for `matchup_proposed` / `matchup_created` / `matchup_rescheduled` /
  `matchup_cancelled`; i18n keys in `en.json` and `es.json`; brand guard untouched.

## Tests

Backend (Jest; CI already provides Postgres):

- `tests/schemas/matchups.test.ts`: create/ruling/reschedule/cancel schemas; host ≠ visitor; note max 200.
- `tests/services/matchup-service.test.ts`: every gate branch (organizer 403 elsewhere, coach 403
  on unmanaged team, 400 not entered, 400 same team, 400 third team, 400 duplicate same-date
  pre-check); the three-row transaction rolls back together; `source` set per door; reschedule and
  cancel write three rows + push both teams; delete-own per source rule (ORGANIZER last-row,
  COACH decline, COACH withdraw deletes the mirror); entry withdrawal detaches; ruling 400 when
  tracked or cancelled.
- `tests/services/game-event-service.test.ts` (**REGRESSION**): every existing case passes
  unchanged; new: linked row → second emit to the other room with projected perspective; unlinked
  row → exactly one emit as today.
- `tests/services/game-service.test.ts` (**REGRESSION**): unlinked `PATCH awayScore` / `date` /
  `opponent` / `status` unchanged; linked `PATCH date` propagates; linked `PATCH competitionId` and
  `opponent` → 400; linked `CANCELLED` propagates; `serializeGame` projection (opponent, awayScore,
  awayScoreDerived, fallback when detached).
- `tests/utils/matchup-result.test.ts`: PENDING / ONE_SIDED (both sources) / AGREED / DISPUTED /
  RULED / CANCELLED, ties, derived-beats-manual, derived-beats-ruling, missing row.
- `tests/api/matchups.test.ts`: full request cycle for every route; `joinCode` absent from every
  new payload (mirror `tests/api/invitations.test.ts`); 404 vs 400 vs 403 per the gate table;
  standings shape with a zero-game team, a withdrawn team absent, disputed/pending counts.
- `tests/api/games.test.ts`: `POST /games` with `opponentTeamId` (both entered / not entered /
  same team / no picker path unchanged); payload carries `matchup` + `awayScoreDerived`;
  `opponent` projection after a team rename; `awayScore` projection when the other side tracked.
- `tests/api/stats.test.ts`: `record` and `recentGames` follow the projection.
- `tests/integration/matchup-scores.db.test.ts` (**real Postgres**, `jest.unmock`): two concurrent
  `createEvent` SHOT calls on the paired rows both commit with no `40P01`/P2034 and each row's
  `homeScore` equals its own shots; the `Game_matchupId_teamId_key` index rejects a second row per
  side; matchup access one fixture per branch (host staff, visitor member, visitor guardian,
  organizer, admin of an unrelated league, unaffiliated), positive and negative each.

Mobile (Jest, real i18n): picker shown/hidden; "Other team" escape; tracker buttons disabled on
`awayScoreDerived`; badge, Proposed-by line and Decline confirm; result labels; `matchup-scope` /
`matchup-result` helpers. Maestro: `.maestro/matchup.yaml` (Frank Vogel proposes a Lakers game
against the seeded Warriors inside the seeded competition; asserts the row-anchored fixture chip;
Dell Curry opens the Warriors mirror row and sees "Proposed by Lakers"; seed deletes matchups and
mirror rows every run). `.maestro/competition-standings.yaml` for the organizer ruling path.

## Failure modes

| Path | Realistic failure | Test | Handling | User sees |
|------|-------------------|------|----------|-----------|
| Two trackers, one matchup | Deadlock | db test | No cross-row lock exists | Nothing; each row converges |
| Projection | Linked row deleted mid-game | service test | `linked == null` → stored values, `awayScoreDerived: false` | Opponent buttons re-enable |
| Mirror row create | Second insert fails | service test | One transaction, rollback | 500 → toast, retry creates all three |
| Reschedule / cancel | Push fan-out fails | service test (mock) | Logged, never thrown | Date/status still move on both |
| Ruling after tracking starts | Stale ruling | util test | Derived beats ruling | Standings follow tracked |
| Standings read | Withdrawn team's matchups | service + api test | Detached at withdrawal; iterate current entries | Team gone from table |
| Coach proposal, other side ignores it | Ghost win | util test | COACH ONE_SIDED not counted | Fixture shows "awaiting <team>" |
| Coach proposal declined | Proposer's schedule | service test | Row detaches to a plain game | Same game, no badge |
| Old binary reads linked game | Unknown fields | manual (#31) | Additive payload; `opponent`/`awayScore` still plain values | Correct name and score, no badge |
| Picker | Team in a competition with no other entries | mobile test | Picker hidden; text input as today | Today's screen |
| Double-tap create | Duplicate fixture | service test (pre-check) | 400 on the second; lost race leaves a deletable duplicate | Error toast / organizer sees two rows |
| Cancel vs IN_PROGRESS other side | Cancelling a live game | service test | Organizer allowed; coach 400 | Clear message |

No failure mode is untested, unhandled and silent. **Critical gaps: 0.**

## NOT in scope

- **One-row games** (`homeTeamId`/`awayTeamId` on one `Game`): rejected above for the three
  verified reasons; not a deferral.
- **Persisting the mirrored `awayScore`**: rejected (D11); the projection is the design.
- **Matchups outside a competition** (two teams in one club, a coach's own two teams; #524): no picker
  exists for them; `competitionId` is required. Revisit only with a discovery mechanism.
- **An explicit accept step / invitation table for COACH proposals** (#525): decline-by-delete plus
  "counts only when AGREED" covers consent without new rows; revisit if proposals are abused.
- **Home/away records, head-to-head screens, opponent filter on `GET /games`**: standings first;
  all derivable from `Matchup` later without schema change.
- **Changing a linked game's competition or opponent**: delete and recreate in v1 (400 today).
- **Resetting RSVPs on reschedule**: kept; both teams are notified.
- **Venue / location, game clock, periods**: unrelated (#113).
- **Organizer overriding tracked scores**: a ruling never beats SHOT events by design.
- **Season rollover carrying matchups (#461)**: a new team-season joins the new competition and
  gets new fixtures.
- **Cross-team player stats / competition leaderboards** (#523): needs this linkage first.
- **Backfilling existing free-text games into matchups**: no reliable key; not attempted.

## What already exists

| Sub-problem | Existing code | Plan |
|-------------|---------------|------|
| Per-team game record with derived score | `Game`, `computeHomeScore`, `recomputeHomeScore` (`game-event-service.ts:77-120`) | **Unchanged** (D11) |
| Derived-beats-client rule | `updateGame` `shots.length === 0 ? data.homeScore : computeHomeScore(shots)` | Same rule applied to `awayScore` as a read projection |
| Read-time projection of a stored column | (new pattern, `serializeGame`) | Used for `opponent` and `awayScore` |
| W/L/T from a row | `stats-service.ts#gameResult`, mobile `utils/game-result.ts` | Unchanged; fed projected values |
| Opponent discovery | `CompetitionEntry` + `competitionAccessWhere` (designed, #492) | The only picker source; `competitionId` required |
| Organizer write gate | `canWriteCompetition` (designed, #492) | Reused for fixtures, reschedule, cancel, delete, ruling |
| Own-row gates | `canAccessTeam`, `canManageTeam`, `canTrackStats` | Unchanged; the mirror row is just another team's game |
| Socket rooms + score broadcast | `emitGameScoreChange`, `gameRoom()` | Second emit to the linked room, own perspective |
| Push to a team | `NotificationService.sendToTeam` (staff + members + guardians) | `matchup_proposed/created/rescheduled/cancelled` |
| Transaction + P2002 mapping | `createTeam`, `createInvitationRow` | Same shape for the three-row create |
| Real-DB test harness | `tests/integration/league-access.db.test.ts` | Pattern copied for convergence + access |
| Secret strip | `omitSecret` | `joinCode` stays out of every matchup payload |
| Hand-written migration discipline | `20260906120000_team_lineage` | Additive file, no backfill |
| Consent-by-deletion precedent | Invitation reject strips email; cancel keeps roster (roster/invite spec) | Decline = delete own row, proposer's game survives detached |

## Sequencing and worktrees

```
#492 PR 1  Competition + CompetitionEntry + join code + Game.competitionId   (as designed)
           ── wait: a real organizer with two entered teams (#492 trigger 2) ──
#492 PR 2  Matchup backend: schema+migration, matchup-service, serializeGame projection, second
           emit, routes, tests incl. db test                                  (this plan)
#492 PR 3  Mobile: picker, detail badge + Decline, tracker gate, competition screens, Maestro, OTA
#494       closes when this document merges (decision + schema + migration + scoping + tracker
           behaviour all recorded); #492's issue body gets "trigger 1 satisfied: see this plan"
```

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| PR 2 backend | `prisma/`, `services/matchup-service`, `services/game-service`, `services/game-event-service` (emit only), `services/stats-service` (projection), `api/games`, `api/competitions`, `utils/matchup-result`, `tests/` | #492 PR 1 + trigger 2 |
| PR 3 mobile | `app/games`, `app/admin/competitions`, `hooks/useMatchups`, `utils/matchup-*`, `types/game.ts`, `__tests__`, `.maestro` | PR 2 deployed |

Lane A: PR 2. Lane B: PR 3 can start against PR 2's API contract in a parallel worktree but must
not merge before PR 2 is deployed and `/health` reports `db: ok`. Conflict flag: none (disjoint
packages); keep `mobile/types/game.ts` edits in PR 3.

## Diagrams to embed in code

- `prisma/schema.prisma`: the target-shape block as a comment on `Matchup`.
- `services/matchup-service.ts`: the result-state diagram and the race/delete table in the header.
- `services/game-service.ts#serializeGame`: the projection block from "Score flow".
- `utils/matchup-result.ts`: the points-for-side rule and the source rule as a comment.
- `mobile/app/games/[id]/track.tsx`: one-line comment above the opponent buttons naming
  `awayScoreDerived` and this plan.

## Acceptance criteria (mapped to #494)

- [x] Written decision with the reasoning resolved, recorded in `docs/plans/` — this document.
- [x] Schema delta with a hand-written migration — `Matchup` + `Game.matchupId`, SQL above (built in #492 PR 2).
- [x] List/read scoping: the opponent's team sees **its own row** through today's `listGames` / `canAccessTeam`; both rows and the matchup are visible to competition readers via `competitionAccessWhere`; no people fields cross.
- [x] Tracker and spectator behaviour when both sides track: linked `awayScore` is projected from the other row's tracked score, buttons gate on `awayScoreDerived`, both rooms receive every score change.
- [x] Unblocks competition fixtures (`POST …/matchups`, `GET …/matchups`) and standings (`GET …/standings`).

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Built in #492 PR 2 / PR 3; checkbox as you ship.

- [ ] **T1 (P1, human: ~4h / CC: ~20 min)** — backend — `serializeGame` projection (`opponent`, `awayScore`, `awayScoreDerived`, `matchup` summary) on list/detail/recentGames/record; bounded matchup select with filtered SHOT `_count`; second `game-score-change` emit to the linked room.
  - Surfaced by: D3/D8/D11 (outside-voice finding 2)
  - Files: `backend/src/services/game-service.ts`, `backend/src/services/stats-service.ts`, `backend/src/services/game-event-service.ts`, `backend/src/websocket/emit.ts`
  - Verify: `tests/services/game-event-service.test.ts` (all existing + emit cases), `tests/api/games.test.ts`, `tests/api/stats.test.ts`
- [ ] **T2 (P1, human: ~2 days / CC: ~1h)** — backend — `Matchup` model (+ `MatchupSource`, `MatchupStatus`) + additive migration + `matchup-service.ts`: create via both gates with `source`, side assertion, duplicate pre-check; reschedule; cancel; delete-own per source rule; delete-matchup; entry-withdrawal detach; ruling; header diagrams.
  - Surfaced by: D2, D4, D5, D6, D12, D13
  - Files: `backend/prisma/schema.prisma`, `backend/prisma/migrations/<ts>_matchup/`, `backend/src/services/matchup-service.ts`, `backend/src/api/competitions/`, `backend/src/api/games/{routes,schemas}.ts`, `backend/src/services/competition-service.ts` (withdrawal hook)
  - Verify: `tests/services/matchup-service.test.ts`, `tests/api/matchups.test.ts`, `tests/schemas/matchups.test.ts`
- [ ] **T3 (P1, human: ~4h / CC: ~20 min)** — backend — `utils/matchup-result.ts#deriveMatchupResult` (six states, source rule, derived-beats-manual/ruling) + standings over current entries; `disputedCount` / `pendingCount`; zero-game teams listed.
  - Surfaced by: D6, D12, D13
  - Files: `backend/src/utils/matchup-result.ts`, `backend/src/api/competitions/`
  - Verify: `tests/utils/matchup-result.test.ts`, standings cases in `tests/api/matchups.test.ts`
- [ ] **T4 (P1, human: ~2h / CC: ~10 min)** — backend — `updateGame` linked-row rules: `date` → reschedule, `CANCELLED` → cancel, `competitionId`/`opponent` → 400; push fan-out to both teams.
  - Surfaced by: D4, D13 (findings 5, 9, 10)
  - Files: `backend/src/services/game-service.ts`, `backend/src/services/notification-service.ts`
  - Verify: `tests/services/game-service.test.ts` regression + linked cases
- [ ] **T5 (P1, human: ~3h / CC: ~15 min)** — backend — Real-Postgres suite: concurrent trackers both commit and converge on their own rows; unique per-side index; matchup access one fixture per branch.
  - Surfaced by: D9
  - Files: `backend/tests/integration/matchup-scores.db.test.ts`
  - Verify: `npm test -- --testPathPattern=matchup-scores`
- [ ] **T6 (P1, human: ~1 day / CC: ~45 min)** — mobile — Opponent picker with "Other team" escape, `matchup-scope` helper, game detail badge + Proposed-by + Decline, tracker opponent-button gate on `awayScoreDerived`, `matchup-result` labels, push copy, i18n.
  - Surfaced by: D3/D5/D12 mobile consequences
  - Files: `mobile/app/games/create.tsx`, `mobile/app/games/[id]/{index,track}.tsx`, `mobile/utils/matchup-{scope,result}.ts`, `mobile/types/game.ts`, `mobile/i18n/`
  - Verify: `__tests__/app/game-create-opponent-picker.test.tsx`, `__tests__/app/game-detail-matchup.test.tsx`, `__tests__/app/track-away-derived.test.tsx`, `__tests__/utils/matchup-*.test.ts`
- [ ] **T7 (P2, human: ~1 day / CC: ~45 min)** — mobile — Competition fixtures + standings screens, organizer create/reschedule/cancel/delete/ruling sheet.
  - Surfaced by: D5, D6
  - Files: `mobile/app/admin/competitions/[id].tsx`, `mobile/hooks/useMatchups.ts`
  - Verify: Jest per screen; Maestro `.maestro/competition-standings.yaml`
- [ ] **T8 (P2, human: ~3h / CC: ~15 min)** — e2e — `.maestro/matchup.yaml` + seed fixtures (competition, entries, per-run cleanup of matchups and mirror rows).
  - Surfaced by: Test review (E2E matrix: 3+ services, cross-team flow)
  - Files: `.maestro/matchup.yaml`, `backend/prisma/seed.ts`
  - Verify: `npx prisma db seed && maestro test .maestro/matchup.yaml`
- [ ] **T9 (P2, human: ~1h / CC: ~10 min)** — docs — CLAUDE.md "Game score" + "Socket.io" sections gain the projection rule and second emit; `utils/permissions.ts` comment block gains the Matchup row; #492 issue body updated (trigger 1 satisfied; PR 2 waits for trigger 2).
  - Surfaced by: Required outputs
  - Files: `CLAUDE.md`, `backend/src/utils/permissions.ts`, GitHub #492
  - Verify: docs hook prints nothing; issue comment posted

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (2026-08-30, the #442/#443 plan that spawned #462 → #494; stale for this plan) | — | 5 proposals, 2 accepted, 6 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 5 (outside voice, Claude subagent; latest 2026-09-07 for this plan) | issues_found | 11 findings (4 P1): 3 tensions raised and resolved with the user, 6 corrections folded, 2 dissolved by D11 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 for this plan (2026-09-07) | CLEAR (PLAN) | 8 findings (4 arch, 2 code quality, 1 test, 1 perf) + 11 outside-voice, all folded; 0 critical gaps; mode FULL_REVIEW (scope trim: no `opponentTeamId` column) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** Outside voice (Claude subagent, same model family) reversed the persisted-mirror design: the event INSERT's `FOR KEY SHARE` defeats any sorted `FOR UPDATE`, so the linked `awayScore` is now a read-time projection (D11) and the SHOT write path is unchanged; standings manipulation via coach self-reports closed by the `source` rule (D12); cancellation, entry withdrawal, reschedule fan-out, `opponent` edits and the side assertion folded (D13).
- **CROSS-MODEL:** Both reviewers agree on two rows + `Matchup` parent, competition-scoped linkage, ruling-on-matchup with derived status, and the shared-schedule coupling the user chose; they disagreed on persisting vs projecting the mirrored score and on who may count a one-sided result, both resolved in favour of the outside voice by the user.
- **VERDICT:** ENG CLEARED — #494 closes when this document merges; the build is #492 PR 2/3, gated on trigger 2 (a real organizer with two entered teams).

NO UNRESOLVED DECISIONS
