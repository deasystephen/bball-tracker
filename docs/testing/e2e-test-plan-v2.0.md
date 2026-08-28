# E2E Test Plan — v2.0

**Created:** 2026-05-25
**Target build:** Mobile — latest TestFlight build (v1.2.0; build #25 or newer, cut from `main` at or after `b14901a` / #401 — #24 and older are 1.1.0 binaries without `expo-secure-store` or the `applinks:capyhoops.com` entitlement, and OTAs no longer reach them), Backend — the ECS revision CI auto-deployed for that same `main` commit (check `GET /health` → `{"status":"ok","db":"ok"}` and the task-def image tag), SES `mail.capyhoops.com`, Web — not deployed
**Checkboxes:** 129 `- [ ]` items (count with `grep -c '^- \[ \]' docs/testing/e2e-test-plan-v2.0.md`); none are pre-ticked.
**Companion:** [`workos-test-accounts.md`](./workos-test-accounts.md) — personas, how each role is obtained (self-select COACH, guardian invite → PARENT, "Add staff"), PKCE sign-in, dev-login limits, seeded users.
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
  1. On iPhone, confirm the **latest** TestFlight build (v1.2.0) is installed. (iOS build numbers are auto-incremented by EAS on each production build and aren't tracked in-repo, so there's no fixed number to match — always take the newest TestFlight build.) **Do not test on #24 or older** — `expo-secure-store` (audit #52, runtime 1.2.0) and the `ios.associatedDomains` entitlement (Universal Links, audit #37) are native changes that landed after #24; OTA updates cannot carry them, so an older binary would not reflect `main`.
  2. From terminal: `curl -s https://api.capyhoops.com/health` → expect 200
  3. From terminal: `aws sesv2 get-email-identity --email-identity mail.capyhoops.com --region us-east-1 | jq '.VerifiedForSendingStatus'` → expect `true`
- **Notes:** ___________

### P.2 — Test data prerequisites
- [ ] Pass / Fail / Skipped
- **Steps:** Identify at least one test user per role you intend to test. Against production use the WorkOS personas from `workos-test-accounts.md`; against a local `NODE_ENV=development` backend + dev build use the seeded dev-login users (`backend/prisma/seed.ts`, `npx prisma db seed`):
  - System ADMIN: `deasystephen@gmail.com` (on the `ADMIN_EMAILS` allowlist on ECS) / seed `System Admin` (`admin@bball-tracker.com`, also league admin of the seeded league)
  - COACH (head coach): `+headcoach` alias after self-selecting "I coach a team" / seed `Frank Vogel` (Lakers head coach, used by most Maestro flows) or `Steve Kerr` (Warriors head coach)
  - Assistant Coach / Team Manager (team staff; system role stays PLAYER): `+asstcoach`, `+manager` added via "Add staff" / seed `Mike Brown` (Warriors assistant, COACH) and `Dell Curry` (Warriors Team Manager, PARENT)
  - PLAYER (rostered, no staff row): `+player` alias / seed `Steph Curry` (Warriors) or `LeBron James` (Lakers)
  - PARENT (guardian, no staff row): `+parent` alias created through a guardian invite (E.12a) / seed `Sonya Curry` (MOTHER of Steph) or `Gloria James` (MOTHER of LeBron). `Dell Curry` is FATHER of Steph **and** Warriors staff, so he is not a pure-guardian fixture.
  - Outsider (no affiliation): `+outsider` alias — the seed has no unaffiliated user.
- **Notes:** ___________

### P.3 — Dev-login availability
- [ ] Pass / Fail / Skipped
- **Steps:**
  1. Open app, tap login
  2. Look for the "Dev Login (Test Users)" button (accessibilityLabel "Developer login with test users").
- **Expected:** **Hidden on TestFlight / production builds** — the button is compiled in only for `__DEV__` builds and `POST /auth/dev-login` exists only when the backend runs with `NODE_ENV=development`. All subsequent tests against production use real WorkOS sign-in with the personas in `workos-test-accounts.md`. Dev-login is available on a simulator dev client (`npx expo run:ios`) against a local seeded backend.
- **Notes:** ___________

---

## A. Authentication & onboarding

### A.1 — New user sign-up via WorkOS
- [ ] Pass / Fail / Skipped
- **Role:** new user
- **Steps:**
  1. Cold-start app (or logout if logged in)
  2. Skip the intro carousel (`app/onboarding/index.tsx`, shown before login) → tap the sign-in button → the system browser opens the WorkOS AuthKit page (the app sent `state` + `code_challenge`, PKCE audit #5)
  3. Choose "Sign up" → enter a fresh email + password
  4. Complete email verification if prompted
- **Expected:** Browser redirects to `bball-tracker://auth/callback?code=…&state=…`; the app exchanges the code (with `code_verifier`) and lands on the **"How will you use Capyhoops?"** account-type screen (A.1b) because every new sign-up is created as `PLAYER`. `GET /auth/me` → `role: PLAYER`, `leagueAdminOf: []`, `guardianOf: []`. Access + refresh tokens persisted; returning to the app shows the logged-in state.
- **Notes:** ___________

### A.1b — Account type selection after first sign-in
- [ ] Pass / Fail / Skipped
- **Role:** new user (created as PLAYER)
- **Steps:**
  1. Complete A.1 sign-up
  2. After the callback, the "How will you use Capyhoops?" screen appears
  3. Choose "I coach a team" → Continue
  4. Profile tab → role badge reads COACH; Teams tab → Create Team succeeds (no 403)
  5. Logout, log in again → screen does NOT reappear
  6. Profile → "Change account type" → pick "I play on a team" → Continue → role badge reads PLAYER
- **Expected:** `PATCH /auth/me/role` 200 each time; ADMIN accounts never see the screen or the Profile row, and a guardian (non-empty `guardianOf`) has no "Change account type" row either (PARENT is derived — `PATCH /auth/me/role { role: 'PARENT' }` → 403). Maestro: `.maestro/onboarding-role.yaml` (dev-login as seeded PLAYER Steph Curry).
- **Notes:** ___________

### A.2 — Existing user login
- [ ] Pass / Fail / Skipped
- **Role:** any existing user
- **Steps:**
  1. Logout if logged in
  2. Tap "Log In" → WorkOS → existing credentials
- **Expected:** Skips onboarding, lands on home tab. Session persists across cold start (force-quit and relaunch → still on home tab, no login screen). On a 1.2.0+ build the tokens are read back from the Keychain (`expo-secure-store`, audit #52), not AsyncStorage.
- **Upgrade path (audit #52):** install build #24 (1.1.0) signed in, then install build #25+ (1.2.0) over it without signing out → first launch lands on the home tab still signed in (the legacy AsyncStorage tokens are migrated into the Keychain, not lost). Logout afterwards → relaunch shows the login screen (keychain entries wiped).
- **Regression checks (fixed since v1 of this plan):**
  - The WorkOS redirect `bball-tracker://auth/callback?code=…` must resolve to the callback screen — **not** an Expo Router "Unmatched Route" page (fixed in #213 via `app/auth/callback.tsx`).
  - The callback screen must not hang or crash with "Maximum update depth exceeded" (Zustand v5 `useShallow` fix, #218).
  - Also try the error branch: `xcrun simctl openurl booted "bball-tracker://auth/callback?error=access_denied"` (or the `.maestro/auth-callback.yaml` flow) → "Sign In Failed" screen renders.
  - PKCE/CSRF (audit #5): open `bball-tracker://auth/callback?code=bogus&state=wrong` while no sign-in is pending → "Sign In Failed" with **no** network call to `/auth/callback` (the `state` must match the pending login stored on the device).
- **Notes:** ___________

### A.3 — Session persistence across cold start
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Force-quit the app
  2. Re-open
- **Expected:** Still logged in; lands on last-visited tab or home (no login prompt).
- **Regression (#349 / audit #20):** repeat after leaving the app closed for longer than the WorkOS access-token lifetime (≥ 10 min is safe). Teams/Home must load normally — the client should silently call `POST /auth/refresh` (visible in backend logs as a 200) rather than show a 401 `ErrorState` or report `Invalid or expired token` to Sentry. Also confirm that when a session truly cannot be recovered (e.g. revoke the session in the WorkOS dashboard → `/auth/refresh` 401) the app lands on the login screen instead of sitting on a tab with failing requests. A 429 / 503 from `/auth/refresh` (WorkOS rate limit / outage) must **not** log the user out.
- **Notes:** ___________

### A.4 — Logout
- [ ] Pass / Fail / Skipped
- **Role:** any logged-in user
- **Steps:**
  1. Profile tab → swipe to Logout button → confirm
- **Expected:** Returns to login screen. Re-opening app stays on login. Backend log shows `DELETE /auth/push-token` then `POST /auth/logout` → `{ success: true, revoked: true }` (WorkOS session revoked; see N.4). Maestro: `.maestro/logout.yaml`.
- **Notes:** ___________

### A.5 — ADMIN auto-assignment on first sign-up
- [ ] Pass / Fail / Skipped
- **Role:** new user whose email is on `ADMIN_EMAILS` (comma-separated allowlist on the ECS task def; legacy `ADMIN_EMAIL` still honoured)
- **Steps:**
  1. (Only relevant for an allowlisted email that has never signed up — skip if `deasystephen@gmail.com` is already an admin; see "Adding an admin tester" in `workos-test-accounts.md`)
  2. Sign up with that email
- **Expected:** `GET /api/v1/auth/me` → `role: ADMIN`; the account-type screen (A.1b) is skipped. Re-login never changes an existing user's role.
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
- **Expected:** `POST /api/v1/uploads/avatar-url { contentType, contentLength? }` returns a **presigned S3 POST** (`{ uploadUrl, fields, imageUrl }`, 5 MB cap enforced by the policy); the app posts the multipart form, then `PATCH /api/v1/auth/me { profilePictureUrl }` (never `PATCH /players/:id`). Avatar updates everywhere within ~3s; the previously uploaded object is deleted from the avatars bucket (audit #61). A failed S3 upload shows an error toast and does **not** persist a dangling URL (audit #39).
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
  1. Profile tab → "Leagues & Seasons" (visible only to ADMIN or users with `leagueAdminOf`) → Leagues → Create
  2. Enter name `Test League 2026`
- **Expected:** League appears in list. ID returned matches the slug pattern (e.g., `test-league-2026`).
- **Notes:** ___________

### C.2 — Create season within league
- [ ] Pass / Fail / Skipped
- **Role:** ADMIN
- **Steps:**
  1. Profile → "Leagues & Seasons" → Seasons → Create
  2. Pick the league from C.1, name `Spring 2026`
- **Expected:** Season appears under the league.
- **Notes:** ___________

### C.3 — 🔒 Non-admin cannot create league
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:** As a COACH, attempt `POST /api/v1/leagues` via direct HTTP; in the app check Profile.
- **Expected:** No "Leagues & Seasons" entry on Profile (it appears only for ADMIN or a user with a non-empty `leagueAdminOf`); direct HTTP returns 403. A league admin (added by ADMIN via `POST /leagues/:id/admins { userId }`) sees only their own leagues and still cannot create/delete leagues.
- **Notes:** ___________

### C.4 — Delete league
- [ ] Pass / Fail / Skipped
- **Role:** ADMIN
- **Steps:** Profile → "Leagues & Seasons" → Leagues → tap created league → Delete (use a *throwaway* league; ADMIN only).
- **Expected:** League removed; associated seasons cascade or are blocked per current behavior (note which).
- **Notes:** ___________

---

## D. Team & roster management

### D.1 — Create team
- [ ] Pass / Fail / Skipped
- **Role:** COACH (self-selected in A.1b), ADMIN, or a league admin — a PLAYER sees no "Create new team" control at all (Teams tab and Home "Create Team" card are hidden, #389) and `POST /teams` returns 403
- **Prereq:** Season from C.2
- **Steps:**
  1. Teams tab → "Create new team"
  2. Name `Test Team`, link to the Spring 2026 season
- **Expected:** Team appears. Back from the new team's detail returns to the Teams list — never the spent create form (create is `replace`d, #421, matching games/create). Creator is auto-assigned the `HEAD_COACH` staff row and the three default roles (Head Coach / Assistant Coach / Team Manager) exist. FREE tier: a 4th distinct team → 402 `upgrade_required` toast (Profile `UsageMeter` shows `1 / 3`). Maestro: `.maestro/create-team.yaml`.
- **Notes:** ___________

### D.2 — View team detail
- [ ] Pass / Fail / Skipped
- **Role:** COACH (creator)
- **Steps:** Teams tab → tap `Test Team`.
- **Expected:** Shows team name, league/season, empty roster with "Add Player", the **Staff** card (head coach name + count → staff screen), "Announcements", "View Team Stats". Maestro: `.maestro/team-detail.yaml`.
- **Notes:** ___________

### D.3 — Add a player (unified form — roster/invite unification)
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Steps:**
  1. Team detail → "Add Player" → tap "Add Player" (the single form — the old
     "Create New Player" / "Add Roster Player" split is gone)
  2. **Name only:** enter `Test Player 1`, jersey `99` → "Add Player"
  3. **With email:** repeat with name + a verified sandbox email
  4. **With parent email:** repeat with a parent email + relationship chip
- **Expected:**
  - Every added player appears on the roster **immediately** (2) with a
    "Not invited" chip; (3) shows "Invited"; the invite email uses the
    "You've been added — Activate Access" copy. A failed send toasts an
    error (per-send `emails` flags) — never silent.
  - (3) with an email that already has an account: toast explains, player
    appears in the separate "Invited" section (not the roster) until accept.
  - (4) parent gets a guardian invitation in the same step (rostered cases
    only; for an existing-account player the toast explains the deferral).
  - Maestro: `.maestro/roster-management.yaml`, `.maestro/roster-invite-status.yaml`.
- **Notes:** Per `POST /api/v1/teams/:teamId/players` (unified endpoint; the
  old managed-players and create-and-invite arms stay mounted for old builds).

### D.3a — Invite-status chips, resend & cancel (NEW)
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Steps:** Lakers roster (seeded fixtures: Iris Invited / Xander Expired /
  Wendy WebAccept / Marcus Johnson).
- **Expected:**
  - Chips: Invited (live PENDING), Invite expired (lapsed PENDING), Active
    (ACCEPTED via web link, never signed in — must NOT read "Not invited"),
    Not invited (no invitation). Non-managers see no chips (join stripped).
  - Resend (mail icon) on Invited/Expired → fresh invitation, old link dead
    (supersede); toast reports the email result.
  - Cancel (on Invited only) → confirm dialog → chip flips to "Not invited",
    the player STAYS on the roster, and their email survives (rejection-only
    strip — re-invite works without creating a duplicate account).

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
- **Expected:** 403 `You do not have access to this team`. `GET /api/v1/teams` never lists it (access clause is ANDed server-side for non-admins). A guardian of a rostered player **does** get 200 (read-only, emails stripped) — see E.12b.
- **Notes:** ___________

### D.8 — Head coach adds an assistant (staff management, role matrix decision 2 / B2.3)
- [ ] Pass / Fail / Skipped
- **Role:** COACH who is the team's **head coach** (e.g. Frank Vogel on Lakers)
- **Prereq:** the assistant already has an account (sign up once as `assistant@example.com` or use seeded
  Mike Brown) — `POST /teams/:id/staff { email }` never creates users.
- **Steps:**
  1. Team detail → tap the **Staff** card (shows coach names + count) → staff screen lists name, role and
     email (email is only present for callers with `canManageRoster`).
  2. Tap **Add staff** → enter a made-up email → Add. Expect the inline hint
     "No account with that email — ask them to sign up first, then invite" (API 404) and no toast.
  3. Enter the assistant's real email, pick **Assistant Coach** → Add.
  4. On the new row tap the role-change icon → choose **Team Manager**; then tap the remove icon → confirm.
- **Expected:** Step 3 → toast "Staff member added", row appears with "Assistant Coach · <email>", the team
  detail Staff card count increments. Step 4 → "Role updated", then "Staff member removed". The head coach's own
  row has **no** remove / "Leave team" control while they are the last head coach (hint "Last head coach — add
  another head coach before removing"). Signed in as the assistant instead: no **Add staff**, no role-change
  icons, only **Leave team** on their own row.
- **Notes:** Automated: `maestro test .maestro/team-staff.yaml` (read-only); Jest
  `__tests__/app/team-staff-gating.test.tsx`, `__tests__/hooks/useTeamStaff.runtime.test.tsx`.

---

## E. Invitations & accept flow (NEW v2.0) 📧

The marquee feature shipped this month. Includes the email path (#131) + web/mobile invite-accept screens (#130) + Universal Links (#138).

### E.1 — Send an invitation from the app
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageRoster`
- **Prereq:** Team from D.1, ECS rev 133+ deployed
- **Steps:**
  1. Team detail → "Add Player" → "Add Player" (unified form)
  2. Enter name + `deasystephen+player@gmail.com` (a verified sandbox recipient) → "Add Player". (For a user already visible in the player search, select them and tap "Send Invitation" instead.)
- **Expected:**
  - One HTTP 201 from `POST /api/v1/teams/:teamId/players { name, playerEmail }` (unified Add Player — the player is rostered immediately for a new/unclaimed email, invitation-only for a claimed account; an existing account with that email is reused). The response carries **no** `token` (audit #14) and reports `emails.player` delivery.
  - Invitation appears in the coach's pending list (`GET /invitations?teamId=`) and on the invitee's Invitations tab
  - Within ~10s an email arrives at that address
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
  1. On iPhone with the latest TestFlight build, tap the "Accept Invitation" button in Gmail
- **Expected:** Safari/Mail does NOT open. Instead the app opens to `mobile/app/invite/[token].tsx` and shows "Team Invitation" with team name, inviter, accept/decline buttons.
- **Notes:** If it opens in Safari instead, AASA isn't being served correctly — but note that AASA is served from `capyhoops.com` which has no web deploy yet (see S.2). The fallback this triggers is the expected-broken path. Also requires a build that carries the `applinks:capyhoops.com` associated-domains entitlement (added to `app.config.js` in audit #37 — builds ≤ #24 do **not** have it; test on build #25 or later).

### E.5 — Accept invitation from in-app screen
- [ ] Pass / Fail / Skipped
- **Role:** invited user (signed in)
- **Prereq:** E.4 successful OR navigate to `bball-tracker://invite/<token>` directly
- **Steps:** On the invite screen, tap "Accept Invitation" → confirm alert.
- **Expected:** Toast confirmation. Navigates to the Invitations tab. The invitation moves from PENDING to ACCEPTED (`POST /invitations/by-token/:token/accept` when opened from the link while signed out, or the authenticated `POST /invitations/:id/accept`). User now appears on the team roster. If the link was opened while signed out, the app routes through `/login` and returns to `/invite/<token>` afterwards (`setPendingReturnPath`).
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
  1. Expire an invitation: `expiresInDays` is validated to 1..30 (default 7), so either `UPDATE "TeamInvitation" SET "expiresAt" = now() - interval '1 minute' WHERE id = …` or wait it out. Nothing schedules expiry — the row stays `PENDING` until touched (lazy expiry, audit #22).
  2. Tap the link
- **Expected:** Invite screen shows "Invitation Expired" + "Go Home" CTA (timestamp compare, never "Expires today", #59). No Accept button. The row flips to `EXPIRED` on contact, and the coach can re-invite the same player (E.14).
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

### E.12a — Coach invites a guardian for a managed player (PARENT role)
- [ ] Pass / Fail / Skipped
- **Role:** COACH (canManageRoster)
- **Prereq:** D.3 (a managed player on the roster)
- **Steps:** Team detail → "Add Player" roster screen → on `Test Player 1`'s card tap **"Invite a parent"** → `/teams/<id>/players/<playerId>/guardians` → email `deasystephen+parent@gmail.com`, relationship chip **Mother** → Invite. API: `POST /api/v1/teams/<teamId>/members/<managedPlayerId>/guardians { email, relationship: "MOTHER" }` (#398/#399).
- **Expected:** 201 with `invitation` (`status: PENDING`, `invitedEmail`, `relationship`, no `token`). A `User` row with `role: PARENT` is created for the email (not `isManaged`). 📧 Email "You've been invited as <child>'s guardian on <team>" with a `capyhoops.com/invite/<token>` link. `GET …/guardians` lists it under `pendingInvitations`.
- **Notes:** ___________

### E.12b — Guardian accepts the invite link
- [ ] Pass / Fail / Skipped
- **Role:** invited adult (web page or deep link, unauthenticated)
- **Steps:** Open the link from E.12a → `GET /invitations/by-token/<token>` shows `kind: "guardian"`, `childName`, `teamName` → accept (`POST /invitations/by-token/<token>/accept`).
- **Expected:** 200 `{ kind: "guardian", guardian: { childId, isPrimary: true } }`. Sign in with that email → `GET /auth/me` returns `guardianOf: [{ childId, childName, relationship: "MOTHER", isPrimary: true }]`. The child's team is visible on the Teams tab (read-only); roster shows names without emails.
- **Notes:** ___________

### E.12c — 🔒 Guardian cannot manage the team
- [ ] Pass / Fail / Skipped
- **Role:** guardian from E.12b (no staff row)
- **Steps:** Try to record a game event (`POST /games/<id>/events`), send a team invitation, post an announcement, export stats.
- **Expected:** 403 on each (`getTeamPermissions` → `canViewStats` only); in the app no Start/End/Delete/Continue Tracking/Add Player/Add staff controls render. Second guardian invited for the same child is `isPrimary: false`. Re-inviting the same email while PENDING → 400 "A pending guardian invitation already exists for this email".
- **Notes:** ___________

### E.12d — Remove a guardian
- [ ] Pass / Fail / Skipped
- **Role:** COACH, then guardian
- **Steps:** `DELETE /teams/<teamId>/members/<playerId>/guardians/<guardianUserId>` as coach; invite again and have the guardian call the same DELETE on themself.
- **Expected:** 200 both times; a non-manager deleting *another* guardian → 403. Removing the last guardian leaves the child on the roster. If the primary leaves, the next guardian becomes primary.
- **Notes:** ___________

### E.13 — 🔒 Coach cannot send invite to player already on team
- [ ] Pass / Fail / Skipped
- **Steps:** Try to invite a user who is already a team member.
- **Expected:** 400 BadRequest "Player is already on this team."
- **Notes:** ___________

### E.14 — 🔒 Duplicate pending invitation prevented
- [ ] Pass / Fail / Skipped
- **Steps:** Send invitation, don't accept. Send another to the same person. Then reject (or cancel) it and invite once more.
- **Expected:** 400 BadRequest "A pending invitation already exists for this player." After reject/cancel the re-invite succeeds (201) — uniqueness is a partial index on `status = 'PENDING'` only (audit #22/#23/#58).
- **Notes:** ___________

### E.15 — 🔒 Public invite endpoint accepts ONLY valid token (no auth bypass)
- [ ] Pass / Fail / Skipped
- **Steps:**
  - `curl -i https://api.capyhoops.com/api/v1/invitations/by-token/abc` (token too short)
  - `curl -i https://api.capyhoops.com/api/v1/invitations/by-token/<valid-token>`
- **Expected:** Short/invalid token → 400 or 404; valid token → 200 with `invitation.kind: "team"` (or `"guardian"`) and never the token itself. No auth header required for either. The lookup is limited to 30 requests / 15 min **per token** (audit #36); the accept `POST` uses the IP-keyed write limiter.
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
- **Steps:** Tracking screen → "End game" (or game detail → "End Game" → confirm).
- **Expected:** Status changes to **FINISHED** (detail shows "Game completed"). Score frozen. `PlayerStats` / `TeamStats` finalized. Maestro: `.maestro/game-lifecycle.yaml`, `.maestro/game-tracking.yaml`.
- **Post-finish edit (audit #27):** after finishing, delete (undo) one of player A's shots. The box score and
  A's season line drop that shot immediately; if A has no events left, A disappears from the box score
  rather than lingering with stale numbers.
- **Notes:** ___________

### F.4 — Cancel a scheduled game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageTeam` (or `canTrackStats` — status changes need `canManageTeam || canTrackStats`)
- **Steps:** The app has no Cancel control; `curl -X PATCH …/api/v1/games/:id -d '{"status":"CANCELLED"}'`.
- **Expected:** Status CANCELLED (detail badge "Cancelled"). No further events accepted; an unaffiliated user gets 403 `You do not have access to this game` regardless of body, and an empty body → 400 `At least one field must be provided`.
- **Notes:** ___________

### F.5 — Delete game
- [ ] Pass / Fail / Skipped
- **Role:** COACH with `canManageTeam`
- **Steps:** Game detail → trash icon ("Delete game") → confirm (use a *throwaway* scheduled game). Rendered only with `canManage` (`canManageTeam`).
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
- **Steps:** After G.1, record a made 2-pt and tap the Undo banner. Then record two events back-to-back (made 3, then a rebound) and watch the banner.
- **Expected:** The banner shows "SAVING…" (disabled) until the event is persisted, then "UNDO (5s)". Undo removes **that** event (not an earlier one): timeline drops it, home score decrements, spectator view updates. The second back-to-back event restarts the countdown at 5s with the new message. Tapping the banner while it still says "SAVING…" does nothing.
- **Notes:** Audit #7 — previously undo deleted `events[0]` from the cache, i.e. the *previous* play, if tapped before the create resolved.

### G.4 — Hot-streak milestone
- [ ] Pass / Fail / Skipped
- **Steps:** Have one player make 3 shots in a row. Then: undo the 3rd (flame should clear), re-record it, leave the tracker with "Leave" and re-open it via Continue Tracking, and make one more shot (flame should still be on — counters are seeded from the server's events on open, audit #75).
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

### G.8 — 🔒 Player cannot track (mobile gating)
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER (team member, not staff — e.g. seeded Steph Curry on the Warriors)
- **Steps:**
  1. Sign in as the player. Open the Games tab.
  2. Open a SCHEDULED team game, then (after a coach starts one) an IN_PROGRESS team game.
  3. Deep-link straight to `bball-tracker://games/<inProgressGameId>/track`.
  4. Open Profile.
- **Expected:**
  - Games tab has no "Create new game" FAB; the empty state does not say "Create your first game".
  - SCHEDULED game: RSVP buttons visible; no "Start Game", no "Delete game" icon.
  - IN_PROGRESS game: "Watch Live" visible; no "Continue Tracking", no "End Game".
  - Tracker deep link: toast "You do not have permission to track stats for this game" and the app lands on the
    game detail — no stat buttons ever render.
  - Profile has no "Leagues & Seasons" entry (unless the user is in `leagueAdminOf`).
  - Automated: `maestro test .maestro/player-no-tracking.yaml`; Jest `__tests__/app/game-detail-gating.test.tsx`
    and `__tests__/app/track-gating.test.tsx`.
- **Notes:** ___________

---

## H. Spectator (Socket.io live view)

### H.1 — Watch live game as another user
- [ ] Pass / Fail / Skipped
- **Role:** PLAYER (team member, not the tracker)
- **Prereq:** Game in progress (F.2), coach actively tracking on another device
- **Steps:** Games tab → game → "Watch Live" (`/games/:id/live`). Maestro: `.maestro/live-spectator.yaml` (render + connect only).
- **Expected:** Joins the Socket.io room. Sees current score, status: LIVE, last ~100 events in reverse-chronological order.
- **Notes:** ___________

### H.2 — Live event arrives within ~1s of recording
- [ ] Pass / Fail / Skipped
- **Steps:** With H.1 connected, coach records a made 3-pt on the tracking screen; then taps **+2** for the opponent; then records a made 2-pt and taps **UNDO** within 5s.
- **Expected:**
  - Made 3: spectator's home score goes 0→3 **and** the event appears at the top of the timeline within ~1s (the `game-event` payload carries the post-insert score — no one-play lag).
  - Opponent +2: spectator's away score goes 0→2 within ~1s (`game-score-change`).
  - Undo: the undone 2-pt disappears from the spectator timeline and home score returns to 3 (`game-event-removed`).
  - Tracker header and spectator show the same score throughout; the tracker sends no `homeScore` PATCH (server-derived, audit #6/#8).
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

### I.5 — Guardian RSVPs for their child (PARENT role)
- [ ] Pass / Fail / Skipped
- **Role:** guardian from E.12b
- **Prereq:** a scheduled game on the child's team
- **Steps:** `POST /api/v1/games/<gameId>/rsvp { status: "YES", playerId: <childId> }`. **Mobile:** sign in as the guardian (prod: `+parent`; seed: Sonya Curry — *not* Dell Curry, who is also Warriors staff) → Games tab lists the child's team's games → open the scheduled game → RSVP card shows **Responding for** chips (child; plus "Me" only if the guardian is rostered) → pick the child → tap **Going**. Profile → **My kids** lists the child → tap opens `/players/<childId>/stats`. Maestro: `.maestro/guardian-rsvp.yaml`.
- **Expected:** 200; `rsvp.userId` is the **child's** id. Coach's RSVP roster (I.4) shows the child as YES. 📧 Confirmation email goes to the guardian's address (the managed child has none). Repeating with `NO` updates the same row.
- **Notes:** ___________

### I.6 — 🔒 Non-guardian cannot RSVP for someone else
- [ ] Pass / Fail / Skipped
- **Role:** a rostered PLAYER (or a guardian of a different child)
- **Steps:** `POST /games/<gameId>/rsvp { status: "YES", playerId: <someone else's id> }`.
- **Expected:** 403 "You can only RSVP for players you are a guardian of". A guardian passing a child who is **not** on that game's team → 403 "This player is not on the team playing this game". A non-UUID `playerId` → 400. **Mobile:** a rostered PLAYER with no `guardianOf` sees no "Responding for" row; a guardian opening a game of a team none of their children play on sees no picker either.
- **Notes:** ___________

### I.7 — Guardian accepts a team invitation addressed to the child
- [ ] Pass / Fail / Skipped
- **Role:** guardian
- **Steps:** As a coach of another team, invite the child (`POST /teams/<otherTeam>/invitations { playerId: <childId> }`). As the guardian, `GET /invitations` → the child's invitation is listed → `POST /invitations/<id>/accept`.
- **Expected:** Accepted; the child appears on the other team's roster and the guardian can now see that team too. Team push notifications for the child's teams are delivered to the guardian (if a push token is registered). **Mobile:** Invitations tab shows the card labelled "For <child>" with **Accept for <child>**; a pending *guardian* invitation for the signed-in adult (coach → roster card "Invite a parent" → `/teams/<id>/players/<childId>/guardians`) shows "Become <relationship> of <child> on <team>" with **Accept for <child>** / Decline, and "My kids" appears on Profile immediately after accepting. The same guardian invitation opened from the email link (`/invite/<token>`, app or web) shows Child / Relationship / Team rows and "Accept for <child>".
- **Notes:** ___________

---

## J. Announcements

### J.1 — Coach posts a team announcement
- [ ] Pass / Fail / Skipped
- **Role:** COACH
- **Steps:**
  1. Team detail → "Announcements" → "+" (accessibilityLabel "New announcement")
  2. Title `Practice tomorrow`, body `6pm sharp` → "Post Announcement"
- **Expected:** Posts. 📧 Email + push sent to all team members and the guardians of members (deduped; sandbox-limited). Dates in emails render in `DEFAULT_TIMEZONE` (`America/Los_Angeles`), not UTC (audit #57).
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
- **Steps:** Team detail → View Team Stats. For the percentage check, finish one game with a single made
  FG (1/1) and a second with 1 made of 9 attempts (1/9), then reopen this screen.
- **Expected:** Team-wide aggregates + per-player table. Season FG% reads **20.0%** (2/10, attempt-weighted),
  not 55.6% (mean of the per-game percentages). Fixed in audit #26.
- **Tie (audit #56):** finish a game with equal scores (e.g. 40-40). The record shows a third, grey **T**
  column (e.g. `1 - 0 - 1`); the Games tab, Home recent-activity row, box score header, and the streak dots on
  the Stats tab all render that game as a grey **T**, not a red L.
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
- **Role:** ADMIN (bypasses entitlements) or a PREMIUM user — `CALENDAR_SYNC` is PREMIUM-gated; a FREE coach gets 402 `upgrade_required`
- **Steps:** The app has no calendar UI. `curl -X POST -H "Authorization: Bearer $TOKEN" https://api.capyhoops.com/api/v1/teams/:id/calendar/subscribe` → copy the returned URL (format `https://api.capyhoops.com/api/v1/teams/:id/calendar.ics?token=...`; the host comes from `API_BASE_URL`, audit #24 — never `capyhoops.com`).
- **Expected:** URL includes an opaque token and uses the API host. As a FREE-tier coach → 402.
- **Notes:** ___________

### L.2 — Subscribe in Apple Calendar
- [ ] Pass / Fail / Skipped
- **Steps:** Settings → Calendar → Add Account → Other → Subscribed Calendar → paste URL.
- **Expected:** Calendar appears with scheduled games as events. Refreshes per Apple Calendar refresh schedule (~30 min).
- **Notes:** ___________

### L.3 — Rate-limit honored
- [ ] Pass / Fail / Skipped
- **Steps:** From terminal, hammer the URL: `for i in {1..70}; do curl -s -o /dev/null -w "%{http_code} " https://api.capyhoops.com/api/v1/teams/<id>/calendar.ics?token=<token>; done`
- **Expected:** After 60 requests in an hour, returns 429 `Too many calendar feed requests`.
- **Notes:** `calendarFeedRateLimit` — 60 req / 60 min / IP.

### L.4 — Revoke token
- [ ] Pass / Fail / Skipped
- **Steps:** `curl -X POST -H "Authorization: Bearer $TOKEN" …/api/v1/teams/:id/calendar/revoke`. Subsequent requests to the old URL → 401/403.
- **Expected:** Old token rejected; subscribing again issues a new token. Also: a feed whose owner lost team access or whose tier no longer includes `CALENDAR_SYNC` answers 403 on the next fetch (audit #43).
- **Notes:** Soft-revocation (`revokedAt`).

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
- **Steps:** The app has no export UI (entitlement UI removed in #392) — `curl -H "Authorization: Bearer $TOKEN" https://api.capyhoops.com/api/v1/games/:gameId/export.csv -o game.csv`.
- **Expected:** CSV download. Columns: timestamp, player, event_type, points, etc. User-controlled string cells prefixed with `'` if they start with `=`, `+`, `-`, `@`.
- **Notes:** Per memory: cursor-paginated, escapeCsvCell for formula triggers.

### M.2 — Per-game PDF box score
- [ ] Pass / Fail / Skipped
- **Steps:** `curl -H "Authorization: Bearer $TOKEN" …/api/v1/games/:gameId/boxscore.pdf -o box.pdf` (no app UI).
- **Expected:** PDF downloads with both teams' stats lines. Filename has Content-Disposition with proper encoding.
- **Notes:** Per #46 + memory. **As of #172 the underlying `pdfkit` is 0.19.1 (was 0.18.0)** — eyeball text layout, column alignment, and any custom fonts for rendering regressions.

### M.3 — Team season stats CSV
- [ ] Pass / Fail / Skipped
- **Steps:** `curl -H "Authorization: Bearer $TOKEN" …/api/v1/teams/:id/season-stats.csv` (no app UI). Run as ADMIN or a PREMIUM user; then repeat as a FREE-tier coach.
- **Expected:** Aggregated season stats CSV (percentages are Σmade/Σattempted, ties counted). FREE-tier coach → 402 `{ code: 'upgrade_required', feature: 'STATS_EXPORT' }` (`requireEntitlement`).
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
- **Expected:** No notification arrives on the logged-out device. Backend log shows `DELETE /auth/push-token` (this device's token) followed by `POST /auth/logout` (`revoked: true`) *before* the app lands on the login screen; no `POST /auth/push-token` re-registration after the token refresh that follows a later sign-in.
- **Notes:** Implemented by the mobile logout sequence (audit #18, lane C1 — `services/session-logout.ts`). Logging out while offline must still reach the login screen within ~8s (two 4s best-effort calls). ___________

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
- **Notes:** Per `invitation-service.ts:171` catch block.

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
- **Steps:** `/auth/dev-login` does not exist in production. Hammer `GET /api/v1/auth/login?format=json` 25 times in a minute from one IP; separately `POST /api/v1/auth/refresh` with the same bogus `refreshToken` 65 times.
- **Expected:** `/auth/login`: 429 after 20 requests / 15 min / IP (`authRateLimit`, also on `/auth/callback`). `/auth/refresh`: 429 after 60 / 15 min **per refresh token** (keyed by token hash, audit #21). `/auth/me` and other session routes use the general limiter (100 / min / IP). Doesn't crash the ALB.
- **Notes:** `app.set('trust proxy', 1)` required behind ALB.

### P.7 — Health endpoint
- [ ] Pass / Fail / Skipped
- **Steps:** `curl https://api.capyhoops.com/health` (there is no `/api/v1/health`).
- **Expected:** 200 `{"status":"ok","db":"ok","timestamp":…}`; 503 `{"status":"degraded","db":"down"}` if the DB ping fails.
- **Notes:** Used by ECS health check.

### P.8 — App handles offline / network failure gracefully
- [ ] Pass / Fail / Skipped
- **Steps:** Toggle airplane mode. Navigate around the app. Try to record an event.
- **Expected:** No crashes. Toasts / banners on failed requests. Data restored on reconnect.
- **Notes:** ___________

### P.9 — Token expiry mid-session (Socket.io)
- [ ] ⚠ Known issue per memory — verify graceful (or document)
- **Steps:** Open spectator view. Force a JWT expiration (manipulate token TTL if possible, or wait the TTL).
- **Expected (current):** An already-connected socket stays connected (handshake-only auth; #49 deferred). A **re**connect with an expired token is rejected with `Unauthorized` → the client refreshes via `/auth/refresh` and reconnects (max 2 tries; audit #17b); backend JWKS outage → `Service unavailable` → exponential back-off, `useLiveGame` shows `reconnecting`.
- **Notes:** ___________

---

## Q. Role permission matrix (boundary checks)

These are quick `curl` checks. Each test verifies a role CANNOT do something they shouldn't.

| ID | Role | Action | Expected |
|----|------|--------|----------|
| Q.1 | PLAYER (member) | `DELETE /teams/:id` | 403 |
| Q.2 | PLAYER (member) | `PATCH /teams/:id` (rename) | 403 |
| Q.3 | PLAYER (non-member) | `GET /teams/:otherTeamId` | 403/404 |
| Q.4 | Assistant Coach | `POST /teams/:id/managed-players` | 201 (Assistant Coach has `canManageRoster`) |
| Q.5 | COACH (head) of team A | `POST /teams/:teamB/invitations` | 403 (no cross-team access) |
| Q.6 | Team Manager | `POST /games/:id/events` | 201 (`canTrackStats: true`) |
| Q.7 | PARENT (guardian of a rostered child) | `GET /teams/:teamId` | 200, read-only; `members[].player` has no `email` |
| Q.8 | PARENT | `POST /teams/:teamId/managed-players` | 403 |
| Q.9 | non-member | `GET /api/v1/teams/:teamId/announcements` | 403 unless team member / staff / guardian |
| Q.10 | unauthenticated | any `/api/v1/*` except `/invitations/by-token/*`, `/teams/:id/calendar.ics`, `/auth/login`, `/auth/callback`, `/auth/refresh` | 401 |
| Q.11 | Assistant Coach | `POST /teams/:id/staff`, `DELETE /teams/:id`, `PATCH /teams/:id { seasonId }` | 403 (head-coach-only; self `DELETE /teams/:id/staff/:ownId` → 200) |
| Q.12 | Head Coach (last one) | `DELETE /teams/:id/staff/:ownId` | 400 "last head coach" |
| Q.13 | Team Manager | `PATCH /games/:finishedId { status: 'IN_PROGRESS' }` | 403 (reopening a FINISHED game needs `canManageRoster`) |
| Q.14 | any non-admin | `PATCH /auth/me/role { role: 'ADMIN' }` (or `PARENT`) | 403 |
| Q.15 | PLAYER | `GET /invitations?playerId=<other user>` | 403 (role matrix B2.4) |
| Q.16 | PLAYER | `GET /players/:id` for a user on none of their teams | 404 (not 403 — no id enumeration) |
| Q.17 | PLAYER | `POST /players { name, email }` | 403 (ADMIN or roster-managing staff only) |
| Q.18 | league admin of the team's league (no staff row) | `PATCH /teams/:id`, `POST /teams/:id/staff` | 200 / 201 |
| Q.19 | PLAYER | `POST /auth/push-token` with a token bound to another account (< 24h) | 409 |

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
- **Expected:** Game completes with status FINISHED, score 0-0, no `PlayerStats`/`TeamStats` rows; it counts in the record (`gamesPlayed`) but not in `trackedGames`, so averages are not deflated; no crash on stats screen.

### R.4 — Player on multiple teams
- [ ] Pass / Fail / Skipped
- **Steps:** Add the same user to two different teams. Send invite to a third.
- **Expected:** No collision. Stats aggregate per team. A coach of team A who is not staff on team B cannot read B's invitations for that player (`GET /invitations?playerId=` is scoped to teams they can manage).

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

### S.9 — ✓ Mobile ESLint
- Resolved in #132 (ESLint + eslint-config-expo wired up in `mobile/eslint.config.mjs`, CI lints mobile) and #346 (all warnings burned down; `--max-warnings 0` enforced in both packages). Nothing to verify manually.

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
- Maestro flows: `.maestro/` (reference for what's automated — run locally with `maestro test .maestro/` against a simulator dev client + seeded local backend; **not** run in CI). All flows dev-login and skip the intro carousel:
  - `login.yaml`, `logout.yaml`, `navigation.yaml`, `profile.yaml` — session + tab smoke (Frank Vogel)
  - `auth-callback.yaml` — `bball-tracker://auth/callback?error=…` deep link renders "Sign In Failed" (A.2)
  - `onboarding-role.yaml` — account-type self-select + "Change account type" (A.1b, Steph Curry)
  - `create-team.yaml`, `team-detail.yaml`, `roster-management.yaml` — D.1 / D.2 / D.3
  - `team-staff.yaml` — staff screen + "Add staff" form for the head coach, read-only (D.8)
  - `game-lifecycle.yaml`, `game-tracking.yaml`, `live-spectator.yaml`, `stats-viewing.yaml` — F.1–F.3, G.1/G.2, H.1, K
  - `player-no-tracking.yaml` — PLAYER sees RSVP but no lifecycle/tracking controls (G.8, Steph Curry)
  - `guardian-rsvp.yaml` — "My kids" + "Responding for" RSVP as a pure guardian (I.5, Sonya Curry)
  - Not covered: invite accept (E), announcements (J), exports (M), push (N), any WorkOS sign-in

### C. Sandbox SES recipient management
To verify additional sandbox recipients for broader testing:
```bash
aws sesv2 create-email-identity --email-identity NEW_EMAIL@example.com --region us-east-1
# Recipient must click verification email before they can receive sends.
```
After B3-prod-access lands and production access is granted, this step is no longer required.

### D. Plan revision history
- 2026-05-25: v1 — created post-v2.0-batch (PRs #131, #130, #137, #138, #150). Built #17 on TestFlight.
- 2026-06-08: M.2 — noted pdfkit version bump (#173).
- 2026-06-14: accuracy pass — pdfkit note → 0.19.1, invitation-service catch line → :171.
- 2026-06-20: de-pinned the Mobile build reference — was "TestFlight #17", now "latest TestFlight build" (iOS build numbers are auto-incremented remotely by EAS and not tracked in-repo, so the `#17` pin went stale as newer builds shipped). Marketing version is still v1.0.0.
- 2026-08-20: pre-testing refresh. Marketing version → v1.1.0 (bumped for build #19/#21 in June). Backend target → ECS rev 223 / `71ec39d` (auto-deployed by CI on every backend-touching merge; verified `GET /health` → `{"status":"ok","db":"ok"}`). A.2 gained regression checks for the auth/callback route (#213) and Zustand render-loop (#218) fixes that shipped after v1. Since #21 only dependency bumps have landed in `mobile/` (~40 daily patch-bump PRs, incl. `@sentry/react-native` 8.15→8.23 and Expo SDK 55 point releases) — a fresh native build (#22+) is required before running this plan. Known-broken items S.1–S.8, S.10 re-verified as still open (#139, #114, #113, #34, #49, #48).
- 2026-08-23: audit #52 — session tokens moved to `expo-secure-store` (native). Marketing version → v1.2.0 (runtimeVersion policy `appVersion`: OTAs now target 1.2.0 builds only; build #24 stays on its last 1.1.0 OTA). A.2 gained the cold-start persistence check and the #24→#25 upgrade-migration check. Build #25+ required for A.2.
- 2026-08-23: refresh for the authz/role-matrix batch on `main` (#370–#401): JWKS-verified access tokens + PKCE (A.1/A.2), self-selected COACH (A.1b), presigned-POST avatars (B.2), "Leagues & Seasons" replaces the Admin tab (C), player-hidden team creation + 402 cap (D.1), staff management (D.8, Q.11/Q.12), create-and-invite + tokenless invitation responses + lazy expiry/partial unique index (E.1/E.8/E.14/E.15), PARENT role (E.12a–d, I.5–I.7, Q.7), `FINISHED` status and server-derived score (F.3/F.4/H.2/R.3), calendar/export have no app UI and are PREMIUM-gated (L, M), rate limiters (P.6), health body (P.7), Q.13–Q.19 boundary rows, Maestro flow list. Dev-login is dev-build-only (P.3). Target build → v1.2.0 / #25+ (set by #401, kept). Seeded fixtures re-verified against `backend/prisma/seed.ts` (Dell Curry is Warriors staff, Sonya Curry is the pure guardian). Nothing marked passed.
