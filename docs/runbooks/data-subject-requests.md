# Data-subject requests: account deletion & data export

How a person's data leaves Hooplings, and how an operator handles a request that arrives by
email instead of through the app. Backend design: `docs/plans/account-deletion.md` (#444).
The privacy policy (#25) must describe **exactly** what "Retention" below says.

## At a glance

| Path | Who | How | Result |
| --- | --- | --- | --- |
| Self-serve | any signed-in user, ADMIN included | Profile → Account → **Delete account** → type `DELETE` | `DELETE /api/v1/auth/me` → anonymized in place, WorkOS user deleted |
| Guardian | a guardian of a **managed, unclaimed** child | Profile → My kids → ⋯ → **Delete <child>'s record** | `DELETE /api/v1/players/:id/account` → child record anonymized |
| Operator (delete) | you, after verifying identity | `scripts/data-subject-request.ts delete <email>` | same transaction in `operator` mode |
| Operator (export) | you, after verifying identity | `scripts/data-subject-request.ts export <email>` | one JSON document to stdout |

A claimed account (one that has signed in) can be deleted **only** by its owner through the
app, or by an operator through the script. Guardians cannot delete a claimed child's account and
system ADMINs cannot delete anyone through the API — that is deliberate (D5), so a stolen admin
token cannot erase users.

## What deletion does (anonymize in place, never a hard delete)

The `User` row stays as a tombstone so that game events, box scores and season stats recorded
for the person's teams remain consistent for everyone else. In ONE transaction:

- **Removed:** login (`workosUserId`), email, name (→ `Deleted user`), photo (S3 object deleted
  best-effort), email-verified flag, subscription, push tokens, calendar-feed tokens, every staff
  role, every league-admin role, RSVPs, guardian links in both directions (the next guardian of
  each child becomes primary), pending team invitations addressed to them (→ `CANCELLED`),
  pending guardian invitations addressed to them (→ `EXPIRED`), and the email on **every**
  guardian invitation that carried it (overwritten with `deleted-<id>@invalid`). A self-serve
  coach's personal league is renamed to `Former coach's teams` if it still holds teams, or
  deleted outright if it is empty. Roster players they had created stay managed but lose their
  `managedById`.
- **Kept, without the name:** `TeamMember` rows (the roster shows "Deleted user" until a coach
  removes it — Remove-from-roster is stats-safe), `GameEvent`, `PlayerStats`, announcements they
  authored, and team invitations they **sent**.
- **After the transaction commits (best-effort):** the WorkOS user is deleted, which also kills
  every session and refresh token. If that call fails the response says `identityDeleted: false`
  and Sentry gets an event tagged `flow: account-delete` — see "When WorkOS deletion fails".

The identity cannot come back: the old token no longer resolves to a user (401), and a fresh
sign-in with the same email creates a brand-new, empty account. Every write path onto a user row
(`PATCH /auth/me`, `/me/role`, push-token registration, both `syncUser` branches) is conditioned
on `deletedAt IS NULL`, so a request that raced the deletion cannot re-identify the tombstone.

### Refusals

| Response | Meaning | What to tell the person |
| --- | --- | --- |
| 400 `code: last_head_coach` + `teams` | they are the only Head Coach of a team in an **active** season | Make someone else Head Coach (Team → Staff) or delete those teams first. Past seasons never block; they go headless. |
| 403 "Only the account owner can delete a claimed account" | a guardian tried to delete a child who has signed in | The child deletes their own account from the app. |
| 401 after a delete | the account is already gone | Nothing — the app signs out. |

## Retention (this is what the privacy policy must say)

- The tombstone keeps only the internal id, the role, the creation date and the deletion date.
- Game events, box scores and season statistics recorded for the person's teams are retained,
  attributed to "Deleted user".
- RDS automated backups retain the pre-deletion data for up to **7 days**
  (`backup_retention_period` in `infra/rds.tf`); they are not edited.
- Error reports (Sentry) and usage analytics (Amplitude) are keyed on the internal user id and
  keep their records for those vendors' retention windows (Sentry: 90 days by default; Amplitude:
  per plan). No name, email or photo is stored there and, after deletion, nothing maps the id back
  to a person. Application logs hash email addresses.
- Email delivery logs at SES keep hashed recipients only.

## Operator procedure (request by email)

1. **Verify identity before anything else.** Accept the request only when it comes from the
   account's email address (reply-to matches), or — for a child's record — from a guardian whose
   email is on a `Guardian`/`GuardianInvitation` row for that child. Do not act on a request from
   a third address, and never on a request relayed through a coach.
2. Get a shell with the production env (`DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`):
   either the RDS tunnel described in `docs/runbooks/rds-backup-restore.md` with the values from
   Secrets Manager / the task definition, or a one-off ECS task from the current image (the way
   the pg-adapter incident was diagnosed).
3. **Export** (do this first for a deletion request too — the person may ask what was held):
   ```bash
   cd backend && NODE_ENV=production npx tsx scripts/data-subject-request.ts export <email> > export-<date>.json
   ```
   `NODE_ENV=production` silences Prisma's query log, which otherwise lands on stdout. Send the
   file to the verified address and delete your local copy. Never commit it or upload it to S3.
   The export contains: `user`, `personalLeague`, `teamMembers`, `teamStaff`, `leagueAdmins`,
   `guardiansAsParent`, `guardiansAsChild`, `receivedInvitations`, `sentInvitations`,
   `guardianInvitations`, `sentGuardianInvitations`, `gameRsvps`, `gameEvents`, `playerStats`,
   `pushTokens`, `calendarFeedTokens`, `announcements` (`AccountService.exportUserData`; the
   integration test asserts this list).
4. **Delete:**
   ```bash
   cd backend && NODE_ENV=production npx tsx scripts/data-subject-request.ts delete <email>
   ```
   Output: `{ userId, deleted, identityDeleted, adminlessLeagueIds }`. The last-head-coach rule
   still applies: if it refuses, ask the person to hand the team over, or (with their consent)
   re-role another staff member yourself via `PATCH /teams/:id/staff/:userId`.
5. Run the post-deletion checklist below, then record the request in the log table.

## Post-deletion checklist

- `identityDeleted: false` → see "When WorkOS deletion fails".
- `adminlessLeagueIds` non-empty (also in the API log line `Account deleted`) → a real league
  lost its only admin. Appoint one: `POST /leagues/:id/admins { userId }` (system ADMIN only).
  The league keeps working meanwhile; only renames and new seasons are blocked.
- A team in a **past** season may now have no head coach. That is expected (past seasons are
  read-only in practice); a league admin or ADMIN can still edit it.
- If the deleted user was a system ADMIN: the `ADMIN_EMAIL` allowlist re-promotes the same email
  on its next sign-up, so admin access is recoverable by signing up again.

## When WorkOS deletion fails

The local row is already unreachable; the person just cannot sign in to a *new* account until
the provider record is gone, and WorkOS still holds their email. Finish it by hand in the WorkOS
dashboard (User Management → the email → Delete). Two known causes:

- WorkOS outage or rate limit — retry the dashboard delete later.
- The row carried a **staging** WorkOS id after the #24 production-key cutover — the production
  environment has no such user; delete it from the *staging* environment's dashboard instead.

## Reversal

There is none. The transaction is not reversible after commit; the only copy of the pre-deletion
data is the RDS automated backup (7 days), and restoring one to un-delete a single account is not
a supported operation.

## Request log

| Date | Type | Verified via | Ran by | `identityDeleted` | Follow-ups |
| --- | --- | --- | --- | --- | --- |
| _(none yet)_ | | | | | |
