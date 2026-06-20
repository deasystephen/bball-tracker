# WorkOS test accounts & role promotion (E2E v2.0)

Companion to [`e2e-test-plan-v2.0.md`](./e2e-test-plan-v2.0.md). Use this when **dev-login
is not available** (production / TestFlight build), so every persona must be a real WorkOS
sign-in. It covers the account scheme, SES sandbox verification, and how to promote each
account to the role the plan needs.

## Personas & alias scheme

All personas use `+alias` addresses on the verified inbox so they (a) sign in as distinct
WorkOS identities, (b) all deliver to one Gmail inbox, and (c) never collide with the ADMIN
auto-assignment (which is an exact match on `ADMIN_EMAIL`, see `workos-service.ts`).

| Persona | Sign-in email | System `User.role` | Team linkage | Receives email? |
|---|---|---|---|---|
| ADMIN | `deasystephen@gmail.com` | `ADMIN` (auto) | — | already verified |
| Head Coach | `deasystephen+headcoach@gmail.com` | `COACH` (bump in DB) | `TeamStaff` → Head Coach | announcements (J) |
| On-team Player | `deasystephen+player@gmail.com` | `PLAYER` (default) | `TeamMember` | RSVP (I), announcements (J), push (N) |
| Assistant Coach | `deasystephen+asstcoach@gmail.com` | `PLAYER` (default) | `TeamStaff` → Assistant Coach | no |
| Team Manager | `deasystephen+manager@gmail.com` | `PLAYER` (default) | `TeamStaff` → Team Manager | no |
| Outsider Player | `deasystephen+outsider@gmail.com` | `PLAYER` (default) | none (control) | no |
| Parent | `deasystephen+parent@gmail.com` | `PARENT` (bump in DB) | `Guardian` → on-team player | announcements (J) |

> The 3 "no email" boundary personas (asst coach, manager, outsider) don't need SES verification.

## Step 1 — SES sandbox verification (email-receiving aliases only)

SES sandbox verifies **exact** addresses; verifying the base inbox does **not** cover
`+aliases`. Verify each receiver, then click the confirmation link (it lands in your inbox):

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

(`+invitee2` is the second invitee used in test E.6.)

Both steps above are wrapped by [`backend/scripts/verify-ses-test-recipients.sh`](../../backend/scripts/verify-ses-test-recipients.sh):

```bash
backend/scripts/verify-ses-test-recipients.sh create   # request verification for each alias
backend/scripts/verify-ses-test-recipients.sh status   # show verified/pending per alias
```

## Step 2 — Role promotion sequence

Only **ADMIN** (auto via `ADMIN_EMAIL`) and **Head Coach** (after a role bump + creating a team
in-app) can be set through the app. Assistant Coach, Team Manager, and Parent have **no API
endpoints** (the staff/guardian routes are unimplemented — only Zod schemas are stubbed in
`backend/src/api/teams/schemas.ts`), so they require direct DB writes. The
[`promote-test-users.ts`](../../backend/scripts/promote-test-users.ts) script does these writes.

Order matters:

1. **All 6 aliases sign in once** via WorkOS (creates the `User` rows; everyone starts `PLAYER`).
2. **`--phase=pre`** — bump `+headcoach` → `COACH` and `+parent` → `PARENT`.
   (Head coach *must* be `COACH` before step 4: `createTeam` 403s otherwise — `team-service.ts`.)
3. **ADMIN** creates the League + Season in-app (tests C.1–C.2; admin-only).
4. **Head coach** creates `Test Team` linked to that season (test D.1) → auto-assigned Head Coach
   and the team's default roles ("Head Coach", "Assistant Coach", "Team Manager") now exist.
5. **`+player`** joins the team — easiest via the invite-accept flow the plan already tests
   (E.1 → E.5), which creates the `TeamMember`. (A manual `TeamMember` insert also works.)
6. **`--phase=post`** — insert `TeamStaff` rows for `+asstcoach` and `+manager`, and the
   `Guardian` link `+parent` → `+player`.

### Running the script

⚠️ You are testing against the **production** backend (ECS / RDS). Point `DATABASE_URL` at the
production database (from `bball-tracker-production/database-url` in Secrets Manager) and
double-check before writing. The script is idempotent (role updates + `skipDuplicates` inserts).

```bash
cd backend
DATABASE_URL="<prod-url>" npx tsx scripts/promote-test-users.ts --phase=pre   # before team creation
# ... admin creates league+season, head coach creates "Test Team", player accepts invite ...
DATABASE_URL="<prod-url>" npx tsx scripts/promote-test-users.ts --phase=post  # after team + player
```

Edit the constants at the top of the script if your alias scheme or team name differs.

## Heads-up: v1.2.0 entitlement gating (merged in #202)

The v1.2.0 release (#202, now on `main`) adds usage metering + entitlement gating. It does **not**
change the role model or add the missing staff/guardian routes, so the promotion sequence above is
unaffected. Being on `main` is not the same as being deployed — confirm the production ECS task you
are testing against is running a v1.2.0+ revision before assuming these gates are live. Once they
are, three things to know:

- **Team creation** is gated by `requireTeamCreateLimit()` — FREE-tier users get HTTP 402 once
  they are staff on `FREE_TEAM_LIMIT` (3) teams. The plan only creates one `Test Team`, so the
  head coach stays under the cap; **no PREMIUM tier needed for D.1**.
- **Stats export** (test plan §M) now requires `requireEntitlement(STATS_EXPORT)`, which is
  **PREMIUM-only**. A FREE-tier coach gets 402, so run §M as a PREMIUM user or as ADMIN.
- **System ADMIN bypasses all entitlement and usage checks** (`req.user.role === 'ADMIN'`), which
  is the simplest way to exercise the export paths.

See `backend/src/services/entitlements/` and `backend/src/api/middleware/entitlements.ts`.

## Gotchas

- **Re-login never overwrites `User.role`** — `syncUser` only sets `role` on first create, so DB
  promotions persist across logins (`workos-service.ts`).
- **Head coach needs `COACH` before creating a team**, or test D.1 returns 403.
- **Parent read access (test Q.7 → 200)** resolves through `Guardian → child → TeamMember`, so the
  guardian's `childId` must be the `+player` who is actually on the team.
- **Permission flags come from the team role**, not the system role: Assistant Coach has full perms
  incl. `canManageRoster` (so Q.4 roster ops should succeed); Team Manager has only
  `canTrackStats` / `canViewStats` / `canShareStats`, no `canManageRoster` (so Q.6 depends on
  `canTrackStats=true`). See `backend/src/utils/permissions.ts`.
