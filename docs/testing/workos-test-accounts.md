# WorkOS test accounts & roles (E2E v2.0)

Companion to [`e2e-test-plan-v2.0.md`](./e2e-test-plan-v2.0.md). Use this when **dev-login
is not available** (production / TestFlight build — the "Dev Login (Test Users)" button is
compiled in only for `__DEV__` builds and `POST /auth/dev-login` only exists when the backend
runs with `NODE_ENV=development`), so every persona must be a real WorkOS sign-in. It covers the
account scheme, SES sandbox verification, and how each account gets the role the plan needs.

## How roles are assigned (current code)

Nothing here needs a manual DB write any more — every role in the matrix is reachable through
the app/API:

| Role / linkage | How it is obtained |
|---|---|
| `PLAYER` (system role) | Default for every WorkOS sign-up (`WorkOSService.syncUser`). |
| `ADMIN` (system role) | Granted **at first sign-up only** to emails on the `ADMIN_EMAILS` allowlist (comma-separated, case-insensitive; legacy single `ADMIN_EMAIL` still honoured — `backend/src/utils/admin-emails.ts`). Re-login never changes an existing user's role. Can never be self-selected. |
| `COACH` (system role) | **Self-selected.** After the first sign-in the app shows "How will you use Capyhoops?" (`app/onboarding/role.tsx`); pick "I coach a team". Later: Profile → "Change account type". API: `PATCH /api/v1/auth/me/role { "role": "COACH" \| "PLAYER" }` (ADMIN / PARENT → 403). Team creation (`POST /teams`) requires COACH, ADMIN or a league admin. |
| `PARENT` (system role) | **Derived, never self-selected.** A coach invites a guardian for a rostered managed player (roster card → "Invite a parent", or `POST /teams/:teamId/members/:playerId/guardians { email, relationship }`). A brand-new account created by that invite is `PARENT`; an existing bare `PLAYER` (no team/staff rows) is promoted to `PARENT` on accept; a COACH stays COACH. |
| Head Coach (team staff) | Auto-assigned to whoever creates the team. |
| Assistant Coach / Team Manager (team staff) | Head coach (or league admin / ADMIN) adds an **existing** account: team detail → Staff card → "Add staff" (email + role chips), or `POST /teams/:teamId/staff { email \| userId, roleType }`. The target must have signed in once — the endpoint never creates users (404 otherwise). |
| League admin | `POST /leagues/:id/admins { userId }` — **system-ADMIN-only**. Appears as `user.leagueAdminOf: [leagueId]` on `GET /auth/me`. |
| Team member (roster) | Accept a team invitation (email link / Invitations tab), or be added as a managed roster player (`POST /teams/:id/managed-players`, no email). |

The old `backend/scripts/promote-test-users.ts` ("bump `+headcoach` to COACH, insert
`TeamStaff`/`Guardian` rows") was deleted — all of those are now ordinary app actions.

## Personas & alias scheme

All personas use `+alias` addresses on the verified inbox so they (a) sign in as distinct
WorkOS identities, (b) all deliver to one Gmail inbox, and (c) never collide with the ADMIN
allowlist match.

| Persona | Sign-in email | System `User.role` | Team linkage | Receives email? |
|---|---|---|---|---|
| ADMIN | `deasystephen@gmail.com` | `ADMIN` (allowlist) | also seeded league admin of the test league via `POST /leagues/:id/admins` if you want to exercise `leagueAdminOf` | already verified |
| Head Coach | `deasystephen+headcoach@gmail.com` | `COACH` (self-select at first sign-in) | creates `Test Team` → `TeamStaff` Head Coach | announcements (J) |
| On-team Player | `deasystephen+player@gmail.com` | `PLAYER` (default) | `TeamMember` via invite accept (E.5) | invitation (E), RSVP (I), announcements (J), push (N) |
| Assistant Coach | `deasystephen+asstcoach@gmail.com` | `PLAYER` (default — staff role is what matters) | `TeamStaff` Assistant Coach via "Add staff" (D.8) | no |
| Team Manager | `deasystephen+manager@gmail.com` | `PLAYER` (default) | `TeamStaff` Team Manager via "Add staff" | no |
| Outsider Player | `deasystephen+outsider@gmail.com` | `PLAYER` (default) | none (control) | no |
| Parent | `deasystephen+parent@gmail.com` | `PARENT` (created by the guardian invite) | `Guardian` → managed roster player `Test Player 1` (E.12a/b) | guardian invite (E.12a), RSVP confirmation (I.5), announcements (J) |
| Second invitee | `deasystephen+invitee2@gmail.com` | `PLAYER` | invited then declines (E.6) | invitation (E.6) |

> The 3 "no email" boundary personas (asst coach, manager, outsider) don't need SES verification.

### Adding more testers

The same persona set works for any number of tester inboxes: each tester gets their own
`<their-local>+headcoach@<their-domain>`, `+player`, `+asstcoach`, `+manager`, `+parent`,
`+invitee2` aliases. The SES helper script takes the list of **base** inboxes (no `+alias`)
via the `TEST_ACCOUNTS` env var — comma- or space-separated — and defaults to
`deasystephen@gmail.com`.

```bash
export TEST_ACCOUNTS="deasystephen@gmail.com tester@example.com"
```

## Step 1 — SES sandbox verification (email-receiving aliases only)

SES sandbox verifies **exact** addresses; verifying the base inbox does **not** cover
`+aliases`. Verify each receiver, then click the confirmation link (it lands in that tester's
inbox):

```bash
for alias in headcoach player parent invitee2; do
  aws sesv2 create-email-identity \
    --email-identity "deasystephen+${alias}@gmail.com" --region us-east-1
done
```

Confirm status is `SUCCESS` before testing:

```bash
for alias in headcoach player parent invitee2; do
  printf '%-40s ' "deasystephen+${alias}@gmail.com"
  aws sesv2 get-email-identity --email-identity "deasystephen+${alias}@gmail.com" \
    --region us-east-1 --query 'VerifiedForSendingStatus' --output text
done
```

Both steps are wrapped by [`backend/scripts/verify-ses-test-recipients.sh`](../../backend/scripts/verify-ses-test-recipients.sh):

```bash
backend/scripts/verify-ses-test-recipients.sh create   # request verification for each alias
backend/scripts/verify-ses-test-recipients.sh status   # show verified/pending per alias
# several testers at once (each clicks the confirmation links in their own inbox):
TEST_ACCOUNTS="deasystephen@gmail.com tester@example.com" backend/scripts/verify-ses-test-recipients.sh create
```

## Step 2 — Role set-up sequence (all in-app / via API)

Order matters because later steps need data from earlier ones:

1. **ADMIN** signs in (must be on `ADMIN_EMAILS` *before* first sign-up — see below) and
   creates the League + Season (Profile → "Leagues & Seasons"; tests C.1–C.2).
2. **`+headcoach`** signs in → on the "How will you use Capyhoops?" screen picks
   **"I coach a team"** (A.1b) → Teams tab → Create Team `Test Team` in that season (D.1).
   Creator becomes Head Coach; the team's default roles (Head Coach / Assistant Coach / Team
   Manager) are created with it.
3. **`+asstcoach`** and **`+manager`** sign in once (keep the default PLAYER role — tap "I play
   on a team"), so the head coach can add them: team detail → Staff → "Add staff" → their
   email + role (D.8).
4. **`+player`** signs in once, then the head coach invites `deasystephen+player@gmail.com`
   (team detail → Add Player → "Invite Player" → "Create New Player" with that email; E.1) and
   the player accepts from the email link / Invitations tab (E.4–E.5) → `TeamMember`.
5. Head coach adds a **managed roster player** `Test Player 1` (D.3) and, from its roster card,
   **"Invite a parent"** → `deasystephen+parent@gmail.com`, relationship MOTHER (E.12a).
   `+parent` opens the link, accepts, then signs in → account is `PARENT` with
   `guardianOf: [Test Player 1]` (E.12b).
6. **`+outsider`** signs in once and is never linked to anything (control for D.7, Q.3, H.6).

Verify any account with `GET /api/v1/auth/me` → `user.role`, `user.leagueAdminOf`,
`user.guardianOf`.

## PKCE sign-in flow (what a "real" sign-in does, audit #5)

1. `app/login.tsx` calls `beginPkceLogin()` → stores `{ state, verifier }` in AsyncStorage
   (`auth:pending-login`, 10-min TTL) and calls `GET /auth/login?format=json&redirect_uri=
   bball-tracker://auth/callback&state=…&code_challenge=…` (S256).
2. The app opens the returned WorkOS AuthKit URL in the system browser; the user signs up /
   signs in (email + password, email verification if prompted).
3. WorkOS redirects to `bball-tracker://auth/callback?code=…&state=…`; `app/auth/callback.tsx`
   consumes the pending login (state must match, single use) **before** any network call, then
   calls `GET /auth/callback?code=…&state=…&code_verifier=…`.
4. The backend exchanges the code with the verifier (WorkOS refuses a mismatch) and returns
   `{ accessToken, refreshToken, user }` — `user` carries `role`, `leagueAdminOf`, `guardianOf`,
   `profilePictureUrl`. On 1.2.0+ builds (#25+) both tokens are stored in the iOS Keychain via
   `expo-secure-store` (`services/secure-storage.ts`, audit #52) — not AsyncStorage; non-secret
   profile state stays in AsyncStorage. Upgrading #24 → #25 migrates the old tokens once.
5. Access tokens are short-lived (~10 min, verified locally against the WorkOS JWKS);
   `POST /auth/refresh { refreshToken }` rotates the pair. A 401 from refresh logs the user out;
   429/503 are treated as transient.
6. Logout: `DELETE /auth/push-token` → `POST /auth/logout` (revokes the WorkOS session) →
   local clear.

An email already bound to a different WorkOS identity is a **409** from `/auth/callback`; a
pre-provisioned row (managed player / guardian-invite account) is claimed by email on first
sign-in and keeps its role.

## Dev-login (local / simulator only)

- Backend: `POST /api/v1/auth/dev-login { email }` and `GET /api/v1/auth/dev-users` exist only
  when `NODE_ENV=development`. The token is an unsigned `dev_…` blob (24 h, no refresh token).
- Mobile: the "Dev Login (Test Users)" button (accessibilityLabel "Developer login with test
  users") renders only in `__DEV__` builds — never in TestFlight / App Store binaries, so P.3 in
  the plan will be "hidden" on a production build.
- Seeded users (`backend/prisma/seed.ts`, `npx prisma db seed`): System Admin
  `admin@bball-tracker.com` (ADMIN + league admin), Steve Kerr (COACH, Warriors head coach),
  Mike Brown (COACH, Warriors assistant), Frank Vogel (COACH, Lakers head coach), Warriors
  players Steph Curry / Klay Thompson / Draymond Green / Andrew Wiggins / Jordan Poole, Lakers
  players LeBron James / Anthony Davis / Russell Westbrook / Austin Reaves (all PLAYER), managed
  roster players (Warriors: Tommy Wilson, Jake Martinez, Ryan Chen; Lakers: Marcus Johnson,
  Ethan Williams), and PARENTs Dell Curry (FATHER of Steph, **also Warriors Team Manager**),
  Sonya Curry (MOTHER of Steph, no staff row) and Gloria James (MOTHER of LeBron, no staff row).
  Games: Warriors vs Lakers / vs Celtics (SCHEDULED), vs Heat (FINISHED 112-105); Lakers vs
  Warriors (SCHEDULED), vs Suns (FINISHED 98-102).

## Entitlement gating reminder

- **Team creation** is capped for FREE-tier users at `FREE_TEAM_LIMIT` (3) **distinct** teams
  the user is staff on → HTTP 402 `upgrade_required`. ADMINs bypass. The plan creates one team,
  so no PREMIUM tier is needed for D.1.
- **Team season-stats CSV** (`GET /teams/:id/season-stats.csv`) requires the PREMIUM
  `STATS_EXPORT` feature (402 for FREE); per-game `export.csv` / `boxscore.pdf` are open.
  Calendar subscribe requires `CALENDAR_SYNC` (PREMIUM). Run those as ADMIN, who bypasses all
  entitlement checks. The mobile app has **no entitlement UI** and no entry point for the
  exports or calendar feed — exercise them with `curl`.

See `backend/src/services/entitlements/` and `backend/src/api/middleware/entitlements.ts`.

## Adding an admin tester

ADMIN is granted **only at first sign-up** to emails on `ADMIN_EMAILS`. There is no in-app
"make admin" action, and re-login never changes an existing user's role.

1. **If they have NOT signed up yet** — add their email to `ADMIN_EMAILS` and deploy *before*
   they sign up. Set it in `infra/task-definition.json` (and `admin_emails` in your Terraform
   vars / `infra/ecs.tf`), then roll the ECS service.
2. **If they have ALREADY signed up** — the allowlist won't retroactively promote them. This is
   the one remaining case that needs a DB write (point at
   `bball-tracker-production/database-url` from Secrets Manager):

   ```sql
   UPDATE "User" SET role = 'ADMIN' WHERE email = 'their-email@example.com';
   ```

## Gotchas

- **Re-login never overwrites `User.role`** — `syncUser` only sets `role` on first create
  (and re-checks the admin allowlist when claiming a pre-provisioned row).
- **Head coach must be `COACH` before creating a team**, or D.1 returns 403 — pick
  "I coach a team" on the role screen first. Players never see "Create Team".
- **Parent read access (Q.7 → 200)** resolves through `Guardian → child → TeamMember`, so the
  guardian's child must actually be rostered on the team. Guardians get `canViewStats` only —
  no tracking, roster or announcement writes (403).
- **Permission flags come from the team role**, not the system role: Assistant Coach has the
  same five flags as Head Coach (so Q.4 roster ops succeed), but only a `HEAD_COACH`-type row
  (or league admin / ADMIN) can add/re-role/remove staff, delete the team, or move it to
  another season. Team Manager has only `canTrackStats` / `canViewStats` / `canShareStats`
  (so Q.6 → 201, Q.2 → 403). See `backend/src/utils/permissions.ts`.
- **Seeded Dell Curry is both a guardian and Warriors staff** — for a "pure guardian" use
  Sonya Curry (or a `+parent` alias created through a guardian invite).
