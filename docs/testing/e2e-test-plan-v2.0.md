# E2E Test Plan — v2.0

**Created:** 2026-05-25
**Target build:** Mobile TestFlight #17, Backend ECS task-def revision 133, SES `mail.capyhoops.com`, Web — not deployed
**Owner:** sdeasy

Run-through guide for verifying v2.0 functionality end-to-end before declaring the release ready for general access. Check the `- [ ]` box for each pass, note Fail + reason in the Notes line. Tests are grouped by feature area; later sections often depend on test data created earlier (e.g., Games require a Team from D).

---

## How to use this document

1. Work top-to-bottom on first run — later sections reuse data from earlier ones.
2. For each test: read the **Steps**, do them, compare against **Expected**, tick `Pass` / `Fail` / `Skipped`. If Fail, jot why in **Notes** (don't go deep — file a follow-up issue with the detail).
3. Tests marked **🔒 Permission boundary** verify that the action is *denied* — failure means the security check is broken.
4. Tests marked **⚠ Known broken** are expected to fail in specific ways — verify they fail *as documented*, not in new surprising ways.
5. Tests marked **📧 Sandbox-limited** can only be exercised against verified SES recipients (currently just `deasystephen@gmail.com`) until B3-prod-access lands.

---

## Pre-flight setup

### P.1 — Build & environment verification
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. On iPhone, confirm TestFlight build #17 (v1.0.0) is installed
  2. From terminal: `curl -s https://api.capyhoops.com/health` → expect 200
  3. From terminal: `aws sesv2 get-email-identity --email-identity mail.capyhoops.com --region us-east-1 | jq '.VerifiedForSendingStatus'` → expect `true`
- **Notes:** ___________

### P.2 — Test data prerequisites
- [ ] Pass / Fail / Skipped
- **Steps:** Identify at least one test user per role you intend to test:
  - System ADMIN: `deasystephen@gmail.com` (per `ADMIN_EMAIL` env var on ECS)
  - COACH: dev-user `Frank Vogel` (per Maestro fixtures)
  - PLAYER: dev-user `LeBron James` (per Maestro fixtures)
  - PARENT: identify or create
- **Notes:** ___________

### P.3 — Dev-login availability
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. Open app, tap login
  2. Verify "Developer login with test users" option is present (only available in non-prod builds — confirm whether build #17 exposes it)
- **Expected:** If hidden in production builds, all subsequent tests must use real WorkOS sign-in instead — flag this and substitute personal accounts for each role.
- **Notes:** ___________

---

## A. Authentication & onboarding

### A.1 — New user sign-up via WorkOS
- [ ] Pass / Fail / Skipped
- **Role:** new user
- **Steps:**
  1. Cold-start app (or logout if logged in)
  2. Tap "Log In" → routes to WorkOS hosted page
  3. Choose "Sign up" → enter a fresh email + password
  4. Complete email verification if prompted
- **Expected:** Lands on onboarding flow (`app/onboarding/index.tsx`); session token persisted; navigating back to app shows logged-in state.
- **Notes:** ___________

### A.2 — Existing user login
- [ ] Pass / Fail / Skipped
- **Role:** any existing user
- **Steps:**
  1. Logout if logged in
  2. Tap "Log In" → WorkOS → existing credentials
- **Expected:** Skips onboarding, lands on home tab. Session persists across cold start.
- **Notes:** ___________

### A.3 — Session persistence across cold start
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Force-quit the app
  2. Re-open
- **Expected:** Still logged in; lands on last-visited tab or home (no login prompt).
- **Notes:** ___________

### A.4 — Logout
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Profile tab → swipe to Logout button → confirm
- **Expected:** Returns to login screen. Re-opening app stays on login. Push tokens cleared (verify in backend logs — no further notifications).
- **Notes:** ___________

### A.5 — ADMIN auto-assignment on first sign-up
- [ ] Pass / Fail / Skipped
- **Role:** new user using `deasystephen@gmail.com`
- **Steps:**
  1. (Only relevant if `deasystephen@gmail.com` has never signed up before — destructive, skip if already an admin)
  2. Sign up with that email
- **Expected:** UserRole is `ADMIN` (verify via `GET /api/v1/auth/me`).
- **Notes:** ___________

### A.6 — Session token included on Socket.io connect
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Navigate to any game's live view (D-section will create one)
- **Expected:** Connection succeeds. Verify in backend logs: `authenticateSocket` accepts the bearer token.
- **Notes:** ___________

### A.7 — 🔒 Unauthenticated request to protected endpoint rejected
- [ ] Pass / Fail / Skipped
- **Steps:** `curl -i https://api.capyhoops.com/api/v1/teams` (no auth header)
- **Expected:** 401 Unauthorized.
- **Notes:** ___________

---

## B. Profile & settings

### B.1 — View profile
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:** Tap Profile tab → see name, email, account section.
- **Expected:** Shows current user's details from `GET /api/v1/auth/me`.
- **Notes:** ___________

### B.2 — Update profile picture (S3 avatar upload)
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Profile tab → tap avatar
  2. Pick an image from camera roll
- **Expected:** Image uploads via presigned URL (`POST /api/v1/uploads/avatar-url` → S3 PUT). Avatar updates everywhere within ~3s.
- **Notes:** ___________

### B.3 — Toggle dark mode
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:** Profile → swipe to Appearance → tap Toggle dark mode.
- **Expected:** Theme flips immediately across all screens. Persists across cold start.
- **Notes:** ___________

### B.4 — Language picker (i18n)
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:** Profile → language picker → select non-English option (if available).
- **Expected:** UI strings update. Persists across cold start.
- **Notes:** Verify which languages are bundled (`mobile/i18n/`).

---

## C. League / season admin (ADMIN only)

### C.1 — Create league
- [ ] Pass / Fail / Skipped
- **Role:** ADMIN
- **Steps:**
  1. Admin → Leagues → Create
  2. Enter name `Test League 2026`
- **Expected:** League appears in list. ID returned matches the slug pattern (e.g., `test-league-2026`).
- **Notes:** ___________

### C.2 — Create season within league
- [ ] Pass / Fail / Skipped
- **Role:** ADMIN
- **Steps:**
  1. Admin → Seasons → Create
  2. Pick the league from C.1, name `Spring 2026`
- **Expected:** Season appears under the league.
- **Notes:** ___________

### C.3 — 🔒 Non-admin cannot create league
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:** As a COACH, attempt `POST /api/v1/leagues` via direct HTTP or via app UI (Admin tab should be hidden).
- **Expected:** Admin tab not visible; direct HTTP returns 403.
- **Notes:** ___________

### C.4 — Delete league
- [ ] Pass / Fail / Skipped
- **Role:** ADMIN
- **Steps:** Admin → Leagues → tap created league → Delete (use a *throwaway* league).
- **Expected:** League removed; associated seasons cascade or are blocked per current behavior (note which).
- **Notes:** ___________

---

## D. Team & roster management

### D.1 — Create team
- [ ] Pass / Fail / Skipped
- **Role:** COACH (or higher)
- **Prereq:** Season from C.2
- **Steps:**
  1. Teams tab → Create
  2. Name `Test Team`, link to the Spring 2026 season
- **Expected:** Team appears. Creator is auto-assigned `HEAD_COACH`.
- **Notes:** ___________

### D.2 — View team detail
- [ ] Pass / Fail / Skipped
- **Role:** COACH (creator)
- **Steps:** Teams tab → tap `Test Team`.
- **Expected:** Shows team name, league, roster (empty), staff, "View Team Stats" link.
- **Notes:** ___________

### D.3 — Add a roster player (managed)
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Steps:**
  1. Team detail → Add Player → switch to "Add Roster Player"
  2. Enter name `Test Player 1`, jersey `#99`
- **Expected:** Player added to roster (managed account — no email required). Visible in roster list.
- **Notes:** Per `POST /api/v1/teams/:teamId/managed-players`.

### D.4 — Edit team name
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageTeam`
- **Steps:** Team detail → Edit → change name → Save.
- **Expected:** Name updates everywhere immediately.
- **Notes:** ___________

### D.5 — Remove a player from roster
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Steps:** Roster → swipe / long-press on `Test Player 1` → Remove.
- **Expected:** Player removed; gone from roster; their team-stats still queryable historically.
- **Notes:** ___________

### D.6 — 🔒 Player cannot edit team they're a member of
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER (member, not staff)
- **Steps:** Join a team (via D.3 add player flow or accept an invite); attempt to tap Edit on team detail.
- **Expected:** Edit button hidden or disabled. Direct `PATCH /api/v1/teams/:id` returns 403.
- **Notes:** ___________

### D.7 — 🔒 User outside team cannot view roster
- [ ] Pass / Fail / Skipped
- **Role:** any user NOT on the team and NOT a league/system admin
- **Steps:** `curl` `GET /api/v1/teams/:id` with their bearer token.
- **Expected:** 403 (or 404 to avoid leaking team existence).
- **Notes:** ___________

---

## E. Invitations & accept flow (NEW v2.0) 📧

The marquee feature shipped this month. Includes the email path (#131) + web/mobile invite-accept screens (#130) + Universal Links (#138).

### E.1 — Send an invitation from the app
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Prereq:** Team from D.1, ECS rev 133+ deployed
- **Steps:**
  1. Team detail → Add Player → switch to "Invite by Email" (or equivalent)
  2. Enter `deasystephen@gmail.com` (the verified sandbox recipient)
  3. Optional message: `Welcome to the test`
  4. Submit
- **Expected:**
  - HTTP 201 from `POST /api/v1/teams/:teamId/invitations`
  - Invitation appears in app's "pending invitations" list for the team
  - Within ~10s an email arrives at `deasystephen@gmail.com`
- **Notes:** ___________

### E.2 — Email contents
- [ ] Pass / Fail / Skipped
- **Steps:** Open the email from E.1.
- **Expected:**
  - Subject: `You've been invited to join Test Team`
  - From: `noreply@mail.capyhoops.com`
  - HTML body has team name, inviter name, optional message, expiration date, **a styled "Accept Invitation" button**, and a plaintext fallback link
  - Both button and plaintext link target `https://capyhoops.com/invite/<token>`
  - Plain-text version (view source / view raw) also has the URL
- **Notes:** ___________

### E.3 — DKIM / SPF passes (deliverability sanity)
- [ ] Pass / Fail / Skipped
- **Steps:** View the email's full headers in Gmail (3-dot menu → Show original).
- **Expected:** `DKIM=PASS`, `SPF=PASS` for `mail.capyhoops.com`. No `dmarc=fail`.
- **Notes:** If failing, check Route53 has the DKIM CNAMEs + SPF TXT that Terraform created today.

### E.4 — iOS Universal Link opens the app (app installed)
- [ ] Pass / Fail / Skipped
- **Role:** invited user (signed in)
- **Steps:**
  1. On iPhone with TestFlight build #17, tap the "Accept Invitation" button in Gmail
- **Expected:** Safari/Mail does NOT open. Instead the app opens to `mobile/app/invite/[token].tsx` and shows "Team Invitation" with team name, inviter, accept/decline buttons.
- **Notes:** If it opens in Safari instead, AASA isn't being served correctly — but note that AASA is served from `capyhoops.com` which has no web deploy yet (see S.2). The fallback this triggers is the expected-broken path.

### E.5 — Accept invitation from in-app screen
- [ ] Pass / Fail / Skipped
- **Role:** invited user (signed in)
- **Prereq:** E.4 successful OR navigate to `bball-tracker://invite/<token>` directly
- **Steps:** On the invite screen, tap "Accept Invitation" → confirm alert.
- **Expected:** Toast confirmation. Navigates to the invitations tab. The invitation moves from PENDING to ACCEPTED. User now appears on the team roster.
- **Notes:** ___________

### E.6 — Reject invitation
- [ ] Pass / Fail / Skipped
- **Role:** another invited user
- **Steps:** Create a second invitation (per E.1) → open the invite screen → tap Decline.
- **Expected:** Invitation status changes to REJECTED. User does NOT appear on roster.
- **Notes:** ___________

### E.7 — Invitation token via direct deep-link (cold start)
- [ ] Pass / Fail / Skipped
- **Role:** signed-in user
- **Steps:** Force-quit the app. From terminal or Notes app, paste `bball-tracker://invite/<token>` and tap.
- **Expected:** App cold-starts and lands directly on the invite screen (not on home tab).
- **Notes:** Per `mobile/app/invite/[token].tsx` + Expo deep-link config.

### E.8 — Expired invitation token
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. Manually expire an invitation (DB update OR wait past the `expiresAt` from creation default of 7 days; for testing, create with `expiresInDays: 0` and wait a few seconds)
  2. Tap the link
- **Expected:** Invite screen shows "Invitation Expired" + "Go Home" CTA. No Accept button.
- **Notes:** ___________

### E.9 — Invalid (garbage) token
- [ ] Pass / Fail / Skipped
- **Steps:** Open `bball-tracker://invite/totally-fake-token-12345`.
- **Expected:** "Invitation Not Found" or 404-style screen. Does NOT crash.
- **Notes:** ___________

### E.10 — Already-accepted invitation
- [ ] Pass / Fail / Skipped
- **Steps:** Reuse the token from E.5 (already ACCEPTED). Tap the link.
- **Expected:** "Already Accepted" + "View Invitations" CTA.
- **Notes:** ___________

### E.11 — Already-rejected invitation
- [ ] Pass / Fail / Skipped
- **Steps:** Reuse the token from E.6 (already REJECTED). Tap the link.
- **Expected:** "Invitation Declined" / equivalent state. No Accept button.
- **Notes:** ___________

### E.12 — Cancelled invitation
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:**
  1. As coach, send an invitation
  2. As coach, cancel it before recipient accepts (Team detail → pending invitations → Cancel)
  3. As the invited user, tap the link
- **Expected:** Status now CANCELLED. Screen shows "Invitation Cancelled."
- **Notes:** ___________

### E.13 — 🔒 Coach cannot send invite to player already on team
- [ ] Pass / Fail / Skipped
- **Steps:** Try to invite a user who is already a team member.
- **Expected:** 400 BadRequest "Player is already on this team."
- **Notes:** ___________

### E.14 — 🔒 Duplicate pending invitation prevented
- [ ] Pass / Fail / Skipped
- **Steps:** Send invitation, don't accept. Send another to the same person.
- **Expected:** 400 BadRequest "A pending invitation already exists for this player."
- **Notes:** ___________

### E.15 — 🔒 Public invite endpoint accepts ONLY valid token (no auth bypass)
- [ ] Pass / Fail / Skipped
- **Steps:**
  - `curl -i https://api.capyhoops.com/api/v1/invitations/by-token/abc` (token too short)
  - `curl -i https://api.capyhoops.com/api/v1/invitations/by-token/<valid-token>`
- **Expected:** Short/invalid token → 400 or 404; valid token → 200 with invitation payload. No auth header required for either.
- **Notes:** ___________

### E.16 — 📧 SES bounce handling for invalid recipient
- [ ] Pass / Fail / Skipped
- **Steps:** Send an invitation to a junk address (`nonexistent12345@gmail.com`).
- **Expected:** API still returns 201 (send is fire-and-forget). Email bounces; bounce should land in SES bounce queue. **In sandbox**, sending may be rejected outright with "address not verified" — that's the expected sandbox behavior. Verify backend logs show the failure but didn't crash the request.
- **Notes:** Send to a verified address only for actual flow testing.

---

## F. Game lifecycle

### F.1 — Schedule a game
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Prereq:** Team from D.1
- **Steps:**
  1. Games tab → Create
  2. Pick team, opponent name, date/time
- **Expected:** Game appears in Games list with status SCHEDULED.
- **Notes:** ___________

### F.2 — Start game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canTrackStats`
- **Steps:** Game detail → Start.
- **Expected:** Status changes to IN_PROGRESS. Tracking screen becomes accessible. Live spectator view enters "LIVE" state.
- **Notes:** ___________

### F.3 — End game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canTrackStats`
- **Steps:** Tracking screen → End Game.
- **Expected:** Status changes to COMPLETED. Score frozen. Stats finalized.
- **Notes:** ___________

### F.4 — Cancel a scheduled game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageTeam`
- **Steps:** Game detail → Cancel.
- **Expected:** Status CANCELLED. No further events accepted.
- **Notes:** ___________

### F.5 — Delete game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageTeam`
- **Steps:** Game detail → Delete (use a *throwaway* scheduled game).
- **Expected:** Removed from list. Stats removed.
- **Notes:** ___________

---

## G. Live game tracking

### G.1 — Record a made 2-pointer
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canTrackStats`
- **Prereq:** Game from F.2 (in progress)
- **Steps:**
  1. Tracking screen → tap player `Test Player 1`
  2. Tap "2pt" (made)
- **Expected:** Event records. Score increments by 2. Event appears in live spectator view within ~1s via Socket.io.
- **Notes:** ___________

### G.2 — Record other event types
- [ ] Pass / Fail / Skipped
- **Steps:** Record at least one of each: 3pt made, 3pt missed, offensive rebound, defensive rebound, assist, steal, block, foul, turnover, free throw made/missed.
- **Expected:** Each event posts. Stats aggregate correctly.
- **Notes:** ___________

### G.3 — Undo last event
- [ ] Pass / Fail / Skipped
- **Steps:** After G.1, tap Undo banner.
- **Expected:** Event removed. Score decrements. Spectator view updates.
- **Notes:** ___________

### G.4 — Hot-streak milestone
- [ ] Pass / Fail / Skipped
- **Steps:** Have one player make 3 shots in a row.
- **Expected:** Hot-player indicator appears. (Per memory: 3+ promotes to hot list.)
- **Notes:** ___________

### G.5 — Double-double detection
- [ ] Pass / Fail / Skipped
- **Steps:** Record 10 points + 10 rebounds for the same player.
- **Expected:** Double-double indicator triggers.
- **Notes:** ___________

### G.6 — 10pt and 20pt milestones
- [ ] Pass / Fail / Skipped
- **Steps:** Cross 10 cumulative points → check for milestone. Cross 20 → check second milestone.
- **Expected:** Each fires once (verified in mobile unit tests; verify the UI in app).
- **Notes:** ___________

### G.7 — 🔒 Non-staff cannot record events
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER (team member, not staff)
- **Steps:** Attempt `POST /api/v1/games/:gameId/events` with player's token.
- **Expected:** 403 Forbidden.
- **Notes:** ___________

---

## H. Spectator (Socket.io live view)

### H.1 — Watch live game as another user
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER (team member, not the tracker)
- **Prereq:** Game in progress (F.2), coach actively tracking on another device
- **Steps:** Open the same game's `live` screen. Open via deep link if available, else navigate Games tab → game → Watch Live.
- **Expected:** Joins the Socket.io room. Sees current score, status: LIVE, last ~100 events in reverse-chronological order.
- **Notes:** ___________

### H.2 — Live event arrives within ~1s of recording
- [ ] Pass / Fail / Skipped
- **Steps:** With H.1 connected, coach records a 2-pt on the tracking screen.
- **Expected:** Spectator's score increments AND new event appears at top of timeline within ~1s.
- **Notes:** ___________

### H.3 — Snapshot cap of 100 most recent events on join
- [ ] Pass / Fail / Skipped
- **Steps:** Track 101+ events in a single game (a lot — could simulate with a dev game). Then open spectator view on a fresh client.
- **Expected:** Only the 100 most recent events show; older events not loaded.
- **Notes:** Per `SNAPSHOT_EVENT_LIMIT = 100`.

### H.4 — Reconnect after backgrounding
- [ ] Pass / Fail / Skipped
- **Steps:** Spectator view connected → background the app for 30s → foreground.
- **Expected:** Reconnects automatically; snapshot replays events that arrived during backgrounding.
- **Notes:** Per `re-emits join-game on reconnect` test.

### H.5 — Game status transitions update spectator UI
- [ ] Pass / Fail / Skipped
- **Steps:** Spectator connected; coach ends the game.
- **Expected:** Spectator sees status flip from LIVE → FINAL within ~1s.
- **Notes:** ___________

### H.6 — 🔒 Non-member cannot join spectator room
- [ ] Pass / Fail / Skipped
- **Role:** user with no team affiliation
- **Steps:** Attempt to `emit join-game` with their token.
- **Expected:** Server rejects with error ack. No game state leaked.
- **Notes:** Per memory `project_socketio.md` — all games team-private; no `isPublic` field yet (#48).

### H.7 — ⚠ Known broken: clock / period not displayed
- [ ] Verified-broken / Notes
- **Steps:** Live view.
- **Expected (intentionally broken):** No game clock visible. Tracked in #113.
- **Notes:** ___________

---

## I. RSVP

### I.1 — Player RSVPs YES to a scheduled game
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER on the team
- **Steps:** Games tab → tap scheduled game → RSVP → "Yes."
- **Expected:** RSVP saved. 📧 Confirmation email sent (subject "RSVP confirmed: Test Team vs Opponent" — only delivers to verified addresses in sandbox).
- **Notes:** ___________

### I.2 — Update RSVP from YES to NO
- [ ] Pass / Fail / Skipped
- **Steps:** Same game → change RSVP to "No."
- **Expected:** Updated. Second email with "RSVP declined" subject.
- **Notes:** ___________

### I.3 — RSVP MAYBE
- [ ] Pass / Fail / Skipped
- **Steps:** Set RSVP to "Maybe."
- **Expected:** Email subject contains "tentative."
- **Notes:** ___________

### I.4 — Coach views RSVP roster for a game
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:** Game detail → RSVPs section.
- **Expected:** List of who's YES/NO/MAYBE/NO_RESPONSE for the scheduled game.
- **Notes:** ___________

---

## J. Announcements

### J.1 — Coach posts a team announcement
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:**
  1. Team detail → Announcements → New
  2. Title `Practice tomorrow`, body `6pm sharp`
- **Expected:** Posts. 📧 Email sent to all team members + parents (sandbox-limited).
- **Notes:** ___________

### J.2 — Members see the announcement in app
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER
- **Steps:** Team detail → Announcements.
- **Expected:** New announcement at top of list with author name + timestamp.
- **Notes:** ___________

### J.3 — Email contents
- [ ] Pass / Fail / Skipped
- **Steps:** Open the email from J.1.
- **Expected:** Subject `Test Team: Practice tomorrow`. Body has title, body, author name.
- **Notes:** ___________

### J.4 — ⚠ Known broken: threaded replies not implemented (#34)
- [ ] Verified-broken / Notes
- **Steps:** Try to reply to an announcement.
- **Expected:** Feature absent; no reply UI.
- **Notes:** ___________

---

## K. Stats viewing

### K.1 — Player stats for a single game
- [ ] Pass / Fail / Skipped
- **Steps:** Stats tab → game stats → pick a completed game from F.3.
- **Expected:** Per-player stat lines (pts, reb, ast, stl, blk, fouls, TO, FG%, 3pt%).
- **Notes:** ___________

### K.2 — Player season stats
- [ ] Pass / Fail / Skipped
- **Steps:** Stats tab → Player → pick `Test Player 1`.
- **Expected:** Aggregated season averages + totals across all games.
- **Notes:** ___________

### K.3 — Team season stats
- [ ] Pass / Fail / Skipped
- **Steps:** Team detail → View Team Stats.
- **Expected:** Team-wide aggregates + per-player table.
- **Notes:** ___________

### K.4 — Career stats across seasons
- [ ] Pass / Fail / Skipped
- **Steps:** Player stats screen.
- **Expected:** Stats from all seasons (if multiple exist) aggregated separately or combined per UI.
- **Notes:** ___________

---

## L. Calendar feed (iCal subscription)

### L.1 — Get team calendar URL
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:** Team detail → "Calendar feed" → copy URL (format `https://api.capyhoops.com/api/v1/teams/:id/calendar.ics?token=...`).
- **Expected:** URL includes opaque token.
- **Notes:** ___________

### L.2 — Subscribe in Apple Calendar
- [ ] Pass / Fail / Skipped
- **Steps:** Settings → Calendar → Add Account → Other → Subscribed Calendar → paste URL.
- **Expected:** Calendar appears with scheduled games as events. Refreshes per Apple Calendar refresh schedule (~30 min).
- **Notes:** ___________

### L.3 — Rate-limit honored
- [ ] Pass / Fail / Skipped
- **Steps:** From terminal, hammer the URL: `for i in {1..70}; do curl -s -o /dev/null -w "%{http_code} " https://api.capyhoops.com/api/v1/teams/<id>/calendar.ics?token=<token>; done`
- **Expected:** After ~60 requests/hour, returns 429.
- **Notes:** Per memory: 60 req/hr/IP cap on calendar feed.

### L.4 — Revoke token
- [ ] Pass / Fail / Skipped
- **Steps:** Team → Calendar → Revoke token. Subsequent requests to old URL → 401.
- **Expected:** Old token rejected; new token generated.
- **Notes:** Soft-revocation per memory.

### L.5 — 🔒 Calendar URL without token
- [ ] Pass / Fail / Skipped
- **Steps:** `curl https://api.capyhoops.com/api/v1/teams/:id/calendar.ics` (no token).
- **Expected:** 401.
- **Notes:** ___________

---

## M. Stats export (CSV / PDF)

### M.1 — Per-game CSV export
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canShareStats` (or higher)
- **Steps:** Game detail → Export CSV. OR `curl -H "Authorization: Bearer $TOKEN" https://api.capyhoops.com/api/v1/games/:gameId/export.csv -o game.csv`.
- **Expected:** CSV download. Columns: timestamp, player, event_type, points, etc. User-controlled string cells prefixed with `'` if they start with `=`, `+`, `-`, `@`.
- **Notes:** Per memory: cursor-paginated, escapeCsvCell for formula triggers.

### M.2 — Per-game PDF box score
- [ ] Pass / Fail / Skipped
- **Steps:** Game detail → Export Box Score (PDF). OR `curl ...api/v1/games/:gameId/boxscore.pdf`.
- **Expected:** PDF downloads with both teams' stats lines. Filename has Content-Disposition with proper encoding.
- **Notes:** Per #46 + memory. **As of #172 the underlying `pdfkit` is 0.19.0 (was 0.18.0)** — eyeball text layout, column alignment, and any custom fonts for rendering regressions.

### M.3 — Team season stats CSV
- [ ] Pass / Fail / Skipped
- **Steps:** Team detail → Export season stats CSV. OR `curl ...api/v1/teams/:id/season-stats.csv`.
- **Expected:** Aggregated season stats CSV.
- **Notes:** ___________

### M.4 — 🔒 CSV injection defense
- [ ] Pass / Fail / Skipped
- **Steps:** Create a player named `=cmd|"/c calc"`. Add to a game's event. Export CSV.
- **Expected:** Player name cell in CSV is prefixed with `'` so spreadsheets treat it as text, not a formula.
- **Notes:** Per memory.

---

## N. Push notifications

### N.1 — Receive push for new invitation
- [ ] Pass / Fail / Skipped
- **Steps:** Send an invitation from a different account to your phone's signed-in user.
- **Expected:** Push notification within ~5s. Tap → opens invitations tab or invite-specific screen.
- **Notes:** Verify push token was registered earlier (via `POST /api/v1/auth/push-token` on login).

### N.2 — Receive push for new announcement
- [ ] Pass / Fail / Skipped
- **Steps:** Have coach post an announcement (J.1). On a different test user's phone (team member), check for push.
- **Expected:** Push notification with announcement title.
- **Notes:** ___________

### N.3 — Receive push for game start
- [ ] Pass / Fail / Skipped
- **Steps:** Coach starts a scheduled game. Other team members' phones notified.
- **Expected:** Push notification. Tap → opens game live screen.
- **Notes:** Verify whether game-start triggers push (check `notification-service.ts`).

### N.4 — Push token cleared on logout
- [ ] Pass / Fail / Skipped
- **Steps:** Logout (A.4). Trigger a notification from another account.
- **Expected:** No notification arrives on the logged-out device.
- **Notes:** ___________

---

## O. Email notifications (NEW v2.0) 📧

Cross-cuts E, I, J — but worth aggregating here.

### O.1 — Email sent uses `noreply@mail.capyhoops.com` as From
- [ ] Pass / Fail / Skipped
- **Steps:** Inspect any received email.
- **Expected:** `From: noreply@mail.capyhoops.com`. Matches `SES_FROM_ADDRESS` env var.
- **Notes:** ___________

### O.2 — HTML escaping defends against template injection
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. Create a team named `<script>alert(1)</script>Team` (if allowed by validation)
  2. Send an invitation
  3. Inspect raw email HTML
- **Expected:** Tags escaped (`&lt;script&gt;`). No script runs in email clients.
- **Notes:** Per `backend/src/services/mailer/escape.ts`.

### O.3 — Email send failures don't surface to API caller
- [ ] Pass / Fail / Skipped
- **Steps:** (Synthetic) — temporarily break SES creds OR send to an obviously-bounced address.
- **Expected:** `POST /invitations` still returns 201. Backend logs an error. No 500.
- **Notes:** Per `invitation-service.ts:168` catch block.

### O.4 — Per `vars.acceptUrl`: link uses `https://capyhoops.com` not localhost
- [ ] Pass / Fail / Skipped
- **Steps:** Inspect E.2 email's link.
- **Expected:** Starts with `https://capyhoops.com/invite/`. Token is base64url, 43 chars (32 bytes encoded).
- **Notes:** ___________

---

## P. Cross-cutting / non-functional

### P.4 — Error tracking (Sentry)
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. Trigger a backend error: `curl https://api.capyhoops.com/api/v1/teams/nonexistent-deadbeef -H "Authorization: Bearer $TOKEN"` (assuming 404)
  2. Check Sentry project for the event
- **Expected:** Event appears in Sentry within ~30s. Release tag matches the current git SHA. PII fields (email, name) scrubbed per memory.
- **Notes:** Per `project_sentry_wiring_2026_04.md`.

### P.5 — Mobile Sentry crash captures
- [ ] Pass / Fail / Skipped
- **Steps:** (Synthetic) In dev/preview, trigger an intentional mobile crash. Or wait for a real one.
- **Expected:** Event appears in Sentry-mobile. Release matches.
- **Notes:** ___________

### P.6 — Rate limit on auth endpoints
- [ ] Pass / Fail / Skipped
- **Steps:** Hammer `POST /api/v1/auth/dev-login` 100 times in a minute.
- **Expected:** After threshold, 429. Doesn't crash the ALB.
- **Notes:** Per memory: `app.set('trust proxy', 1)` required behind ALB.

### P.7 — Health endpoint
- [ ] Pass / Fail / Skipped
- **Steps:** `curl https://api.capyhoops.com/health` (and `/api/v1/health` if separate).
- **Expected:** 200 with simple body.
- **Notes:** Used by ECS health check.

### P.8 — App handles offline / network failure gracefully
- [ ] Pass / Fail / Skipped
- **Steps:** Toggle airplane mode. Navigate around the app. Try to record an event.
- **Expected:** No crashes. Toasts / banners on failed requests. Data restored on reconnect.
- **Notes:** ___________

### P.9 — Token expiry mid-session (Socket.io)
- [ ] ⚠ Known issue per memory — verify graceful (or document)
- **Steps:** Open spectator view. Force a JWT expiration (manipulate token TTL if possible, or wait the TTL).
- **Expected (current):** Session stays connected per memory: "Handshake-only auth. JWT is validated once at connect; tokens that expire mid-session stay connected." This is #49 deferred behavior.
- **Notes:** ___________

---

## Q. Role permission matrix (boundary checks)

These are quick `curl` checks. Each test verifies a role CANNOT do something they shouldn't.

| ID | Role | Action | Expected |
|----|------|--------|----------|
| Q.1 | PLAYER (member) | `DELETE /teams/:id` | 403 |
| Q.2 | PLAYER (member) | `PATCH /teams/:id` (rename) | 403 |
| Q.3 | PLAYER (non-member) | `GET /teams/:otherTeamId` | 403/404 |
| Q.4 | COACH (assistant) | `POST /teams/:id/managed-players` | Depends on role flags — verify per `canManageRoster` |
| Q.5 | COACH (head) of team A | `POST /teams/:teamB/invitations` | 403 (no cross-team access) |
| Q.6 | TEAM_MANAGER | `POST /games/:id/events` | Depends on `canTrackStats` — verify behavior matches the role's flags |
| Q.7 | PARENT | `GET /teams/:teamId` (child on team) | 200 (read-only) |
| Q.8 | PARENT | `POST /teams/:teamId/managed-players` | 403 |
| Q.9 | non-staff | `GET /api/v1/teams/:teamId/announcements` | 403 unless team member |
| Q.10 | unauthenticated | any `/api/v1/*` except `/invitations/by-token/*` | 401 |

Check each: - [ ] Pass / Fail / Skipped — Notes: ___________

---

## R. Edge cases (per feature)

### R.1 — Very long team name (>100 chars)
- [ ] Pass / Fail / Skipped
- **Expected:** Validation rejects with a clear error.

### R.2 — Invitation with special characters in player name
- [ ] Pass / Fail / Skipped
- **Steps:** Create a player with name `O'Brien, Connor` (apostrophe + comma) → invite.
- **Expected:** Email renders correctly; HTML escaped; accept flow works.

### R.3 — Game with 0 events ended
- [ ] Pass / Fail / Skipped
- **Steps:** Start a game → end immediately.
- **Expected:** Game completes with status COMPLETED, score 0-0, no crash on stats screen.

### R.4 — Player on multiple teams
- [ ] Pass / Fail / Skipped
- **Steps:** Add the same user to two different teams. Send invite to a third.
- **Expected:** No collision. Stats aggregate per team.

### R.5 — Concurrent stat tracking (two coaches on the same game)
- [ ] Pass / Fail / Skipped
- **Steps:** Two devices, both with COACH access, both on tracking screen for the same game.
- **Expected:** Events from both record. Race conditions don't lose events.

### R.6 — Backgrounding mid-stat-entry
- [ ] Pass / Fail / Skipped
- **Steps:** Mid-stat-entry, background the app for 30s.
- **Expected:** State restored on foreground. No crash.

### R.7 — Cold start while in spectator mode
- [ ] Pass / Fail / Skipped
- **Steps:** Spectator view → force-quit → cold-start.
- **Expected:** Returns to spectator view OR home tab (verify intended behavior). Re-joins Socket.io if returning.

### R.8 — Empty roster game
- [ ] Pass / Fail / Skipped
- **Steps:** Create a team with no players. Schedule a game. Start.
- **Expected:** Tracking screen handles empty player list gracefully — message like "Add players to your roster."

### R.9 — Time zone correctness
- [ ] Pass / Fail / Skipped
- **Steps:** Schedule a game across midnight UTC. Verify it shows the correct local date in app.
- **Expected:** Local time displayed; iCal feed has proper TZ info.

### R.10 — Deletion cascade
- [ ] Pass / Fail / Skipped
- **Steps:** Delete a team that has games + announcements + stats.
- **Expected:** Documented cascade behavior (per Prisma schema). Either cascades cleanly or refuses with clear error.

---

## S. Known-broken / expected-fail (don't be surprised)

These are documented gaps. Each should fail in the *documented* way. If they fail differently, file a follow-up.

### S.1 — ⚠ Android Universal Link
- [ ] Verified-broken / Notes
- **Issue:** #139 — production Android signing not set up; `assetlinks.json` has placeholder fingerprint
- **Expected fail mode:** On Android, tapping the invite link opens Chrome and tries to load `capyhoops.com/invite/<token>` → goes to S.2 (web not deployed).
- **Notes:** ___________

### S.2 — ⚠ Web fallback page (capyhoops.com not deployed)
- [ ] Verified-broken / Notes
- **Issue:** No web deploy target configured. `web/` Next.js app exists in code but not hosted.
- **Expected fail mode:** Browser to `https://capyhoops.com/invite/<token>` returns DNS-routes-to-nothing OR a default Route53 / hosting-not-configured error. Not the Next.js invite page yet.
- **Notes:** ___________

### S.3 — ⚠ SES production access (sandbox-only)
- [ ] Verified-broken / Notes
- **Issue:** B3-prod-access pending. Sandbox: 200/day, 1/sec, verified recipients only.
- **Expected fail mode:** Sending an invitation to a non-verified address fails or silently doesn't deliver. `aws sesv2 send-email` to a non-verified recipient returns `MessageRejected: Email address is not verified`.
- **Notes:** ___________

### S.4 — ⚠ Spectator live-update assertion (no automated coverage)
- [ ] Verified-broken / Notes
- **Issue:** #114 — Maestro doesn't run in CI; no synthetic against prod yet.
- **Expected fail mode:** This is automation-gap, not user-visible. Won't surface during manual testing.

### S.5 — ⚠ Spectator game clock / period display
- [ ] Verified-broken / Notes
- **Issue:** #113 — feature not implemented.
- **Expected fail mode:** No clock on the live spectator view.

### S.6 — ⚠ Threaded announcement replies
- [ ] Verified-broken / Notes
- **Issue:** #34 deferred.
- **Expected fail mode:** No reply UI.

### S.7 — ⚠ Multi-replica Socket.io
- [ ] Verified-broken / Notes
- **Issue:** Single-replica only (in-memory adapter). Backend logs fatal warning on startup if `NODE_ENV=production` and `REDIS_SOCKET_ADAPTER_URL` is unset.
- **Expected fail mode:** Currently 1 ECS task running. Scaling beyond would split rooms.

### S.8 — ⚠ Mid-session Socket.io JWT reauth
- [ ] Verified-broken / Notes
- **Issue:** #49 deferred.
- **Expected fail mode:** Long sessions (>2hr typical JWT TTL) stay connected with stale auth.

### S.9 — ⚠ Mobile ESLint
- [ ] Verified-broken / Notes
- **Issue:** #132 — ESLint not installed in mobile/, CI skips on `matrix.project == 'backend'`.
- **Expected fail mode:** Doesn't affect user testing. `npm run lint` in mobile/ silently no-ops.

### S.10 — ⚠ Web/ test framework absent
- [ ] Verified-broken / Notes
- **Issue:** Audit finding — no Vitest/Jest in web/. Coverage gates don't see web/.
- **Expected fail mode:** Doesn't affect user testing.

---

## T. Wrap-up

### T.1 — Document all observed bugs / surprises
- [ ] Done
- File one GitHub issue per Fail or surprise. Reference this test plan + the specific test ID.
- **Notes:** ___________

### T.2 — Confirm health metrics post-testing
- [ ] Pass / Fail / Skipped
- **Steps:** Check Datadog dashboard for the test window: 5xx rate, p95 latency, ECS CPU.
- **Expected:** Within normal ranges. No spikes attributable to test traffic.
- **Notes:** Per ECS deploy infra; Datadog API key in Secrets Manager.

### T.3 — Confirm Sentry didn't fill up with unexpected events
- [ ] Pass / Fail / Skipped
- **Steps:** Review Sentry project for unique errors during test window.
- **Notes:** ___________

### T.4 — Calculate pass rate
- [ ] Done
- Count Pass vs Fail across this document. Anything <95% pass = blocker for v2.0 GA.
- **Pass rate:** ___ / ___ = ___ %

### T.5 — Decide on GA readiness
- [ ] Done
- Based on T.4 + the severity of any failures: GA / Hold / Hotfix-and-retest.

---

## Appendix

### A. Test data cleanup
After testing, optionally tear down:
- Delete `Test Team`
- Delete `Test League 2026` (cascades to seasons)
- Delete throwaway games created in F.4, F.5

### B. Related docs
- Architecture: `docs/architecture/overview.md` (stale per audit — see B-deferred)
- Runbooks: `docs/runbooks/` (RDS backup/restore, etc.)
- Automation: `docs/automation/daily-upgrade-scan.md`
- Maestro flows: `.maestro/` (reference for what's automated)

### C. Sandbox SES recipient management
To verify additional sandbox recipients for broader testing:
```bash
aws sesv2 create-email-identity --email-identity NEW_EMAIL@example.com --region us-east-1
# Recipient must click verification email before they can receive sends.
```
After B3-prod-access lands and production access is granted, this step is no longer required.

### D. Plan revision history
- 2026-05-25: v1 — created post-v2.0-batch (PRs #131, #130, #137, #138, #150). Built #17 on TestFlight.
