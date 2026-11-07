# Data-subject requests: account deletion & data export

How a person's data leaves Hooplings, and how an operator handles a request that arrives by
email instead of through the app. Backend design: `docs/plans/account-deletion.md` (#444).
The privacy policy (#25) must describe **exactly** what "Retention" below says.

## At a glance

| Path | Who | How | Result |
| --- | --- | --- | --- |
| Self-serve | any signed-in user, ADMIN included | Profile → Account → **Delete account** → type `DELETE` | `DELETE /api/v1/auth/me` → anonymized in place (or erased outright, see below), WorkOS user deleted |
| Guardian | a guardian of a **managed, unclaimed** child | Profile → My kids → ⋯ → **Delete <child>'s record** | `DELETE /api/v1/players/:id/account` → child record anonymized (or erased, if never rostered) |
| Operator (delete) | you, after verifying identity | `scripts/data-subject-request.ts delete <email>` | same transaction in `operator` mode |
| Operator (export) | you, after verifying identity | `scripts/data-subject-request.ts export <email>` | one JSON document to stdout |
| Operator (under 13, convert) | you, after verifying the reporter | `scripts/convert-to-managed.ts <userId> [--coach <coachUserId>]` | the account becomes a managed roster record again, WorkOS user deleted; see [We learned an account holder is under 13](#we-learned-an-account-holder-is-under-13) |

A claimed account (one that has signed in) can be deleted **only** by its owner through the
app, or by an operator through the script. Guardians cannot delete a claimed child's account and
system ADMINs cannot delete anyone through the API — that is deliberate (D5), so a stolen admin
token cannot erase users.

## What deletion does (anonymize in place; erase outright when nothing is left)

The `User` row stays as a tombstone so that game events, box scores and season stats recorded
for the person's teams remain consistent for everyone else. **The tombstone exists for other
people's data, so an account that never touched any is erased instead (#529):** once the removals
below are done, the transaction counts every row that still points at the user (roster
memberships, game events, box scores, invitations sent or received, guardian invitations,
announcements, sessions — every relation on the `User` model, checked in one query that a test
keeps in step with the schema). If nothing remains, the row itself is deleted and no record of
the account survives; the response says `erased: true`. A person who signed up, looked around and
left, or a coach who only ever held staff roles, ends up here. If anything remains, the row is
tombstoned as described next and the response says `erased: false`. In ONE transaction:

- **Removed:** login (`workosUserId`), email, name (→ `Deleted user`), photo (S3 object deleted
  best-effort), email-verified flag, the email's bounce/complaint state (`emailSuppressedAt` /
  `emailSuppressedReason`, #449), subscription, push tokens, calendar-feed tokens, every staff
  role, every league-admin role, RSVPs, guardian links in both directions (the next guardian of
  each child becomes primary), pending team invitations addressed to them (→ `CANCELLED`), the
  `recipientHash` (hash of the address an invitation went to, #715) on every team invitation addressed to them,
  pending guardian invitations addressed to them (→ `EXPIRED`), and the email on **every**
  guardian invitation that carried it (overwritten with `deleted-<id>@invalid`). A self-serve
  coach's personal league is renamed to `Former coach's teams` if it still holds teams, or
  deleted outright if it is empty. Roster players they had created stay managed but lose their
  `managedById`.
- **Kept, without the name:** `TeamMember` rows (the roster shows "Deleted user" until a coach
  removes it — Remove-from-roster is stats-safe), `GameEvent`, `PlayerStats`, announcements they
  authored, and team invitations they **sent**. Any of these is what keeps the tombstone; with
  none of them the row is erased.
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

- An account with no history — never on a roster, no game events or statistics, no invitations
  sent or received, no announcements — is **erased**: the record is deleted and nothing about it
  remains in the application database. Outside the database, the request-log lines and the
  vendor records described below still carry the internal id until their windows expire.
- Otherwise the tombstone keeps only the internal id, the role, the creation date and the
  deletion date.
- Game events, box scores and season statistics recorded for the person's teams are retained,
  attributed to "Deleted user".
- **Profile photos.** Once pending-upload expiry is enabled (`AVATAR_PENDING_TAG_ENABLED`), a
  photo that is uploaded but never saved to a profile (a cancelled edit, an abandoned Add Player)
  is deleted automatically **3 days after upload**, whether or not the person keeps their account
  (S3 counts from upload and rounds up to the next midnight UTC, so up to 4 days). While it is not
  enabled, such a photo is not deleted. Either way, until it is deleted it is readable by anyone
  who has its URL (the bucket is public-read; URLs are unguessable). On account deletion the current photo is deleted. A photo someone
  uploaded for a child or player they manage stays while that profile shows it. Mechanism:
  `docs/architecture/backend-services.md#avatar-uploads-servicesupload-servicets-apiuploads`.
- RDS automated backups retain the pre-deletion data for up to **7 days**
  (`backup_retention_period` in `infra/rds.tf`); they are not edited.
- **Error reports (Sentry)** are kept for Sentry's retention window (90 days by default). No name,
  email or photo is sent (`sendDefaultPii: false` on both sides).
  - Backend reports carry the internal user id of the caller (`scope.setUser({ id })` in
    `backend/src/utils/sentry.ts`).
  - Mobile reports carry **no** user id: `setSentryUser` in `mobile/services/sentry.ts` is never
    called. They hold device model, OS version, app release and redacted breadcrumbs. API
    request breadcrumbs and captured network/5xx events carry a `request_id`: a random
    per-request UUID, not a user or device identifier, so it does not link a report to a person
    by itself. Anyone with Datadog access can join it to that request's API log line, which does
    carry the user id; the join stays inside our own systems (#963).
- **Usage analytics (Amplitude)** are kept for the window of the Amplitude plan. Every event
  (the catalogue in `docs/architecture/analytics.md`: screens viewed as route patterns, and the
  teams, rosters, invitations, games and game events the person created, changed or deleted)
  carries the internal user id, a device id, `identifierForVendor`, device and OS details,
  language, carrier, and the IP address of the request, from which Amplitude derives **city,
  region and country**. Event properties are internal ids, enums, counts and flags (which fields
  changed, never their values; an error's code, never its message). The user record at Amplitude
  also holds **user properties**: global role, head-coach / assistant-coach / parent / player
  flags, team count, subscription tier, app version and the running OTA's update id (or
  `embedded`, #967). That set is fixed in code
  (`AMPLITUDE_TRACKING_OPTIONS`, `AnalyticsEventProps`, `AnalyticsUserProperties` in
  `mobile/services/analytics.ts`) and pinned by tests. No name, email, jersey number, message or
  photo is sent, and the advertising id is never sent. Whether Amplitude keeps the raw IP address
  after the lookup is a setting in the Amplitude project; confirm it there before the privacy
  policy states it.
- **Application logs** (one line per API request with method, redacted path, status and
  duration, plus domain events such as `Account deleted`) carry the caller's **internal user id**
  and `requestId` whenever the request was authenticated (`setLogContextUser` from
  `backend/src/utils/log-context.ts`, called by `backend/src/api/auth/middleware.ts`;
  `backend/src/api/middleware/request-logger.ts`). The
  `Account deleted` event logs the deleted user's id, the actor's id and the mode. At the
  production log level (`LOG_LEVEL=info` in `infra/task-definition.json`) log lines carry no name
  and no secret URL (paths and query strings go through `utils/redact.ts`), and email addresses
  are hashed with `hashRecipient()` at every level, `debug` included. A failed send is logged by
  error name, never the SES message that quotes the recipient (`services/mailer/ses-mailer.ts`,
  #640). Lines written before #640 was deployed may still carry a recipient address (a raw SES
  error, or a `debug` line if that level was on) until they age out. Log lines are kept **30 days** in CloudWatch Logs
  (`retention_in_days` on `/ecs/bball-tracker-production` in `infra/ecs.tf`), and every line is
  also forwarded to **Datadog** (`infra/datadog.tf`, an unfiltered subscription on that log group
  that exists only while `datadog_api_key` is set in the Terraform variables; it is set in
  production), where it is kept for **15 days**: the retention of the org's default log index, which
  nothing in `infra/` manages. It is read in Datadog under Logs → Configuration → Indexes and was
  confirmed on 2026-10-04 from the oldest retained `service:bball-tracker-api` line; re-check it
  there before the privacy policy repeats the number. Supersedes D8 of
  `docs/plans/account-deletion.md` on this point, which named only the hashing. Every line also
  carries the deployed commit and an `env` tag, and, inside a request, the client's app version
  (`client`, for example `ios/1.6.0+<update id>` or `web`, #963), which is not a user or device
  identifier.
- **Website server logs (hooplings.com, #966)** are kept **30 days** in CloudWatch Logs
  (`/ecs/bball-tracker-production-web`, `retention_in_days` on `aws_cloudwatch_log_group.web` in
  `infra/web.tf`). The site has no sign-in, so its lines carry **no user id**, no IP address and no
  invitation token: the server logs only a failed invitation lookup (reason and status) and a
  server error (the route pattern such as `/invite/[token]`, the error's type and an error id),
  through `web/lib/log.ts`, which masks tokens in every value. Those lines, and only those, are
  also forwarded to **Datadog** (a subscription filtered on `service = "bball-tracker-web"` in
  `infra/datadog.tf`) and kept there for the same **15 days** as the API's. Next.js's own output
  (start-up lines and its error dumps) stays in CloudWatch for the 30 days. A data-subject request
  has nothing to find here: no line can be tied to a person.
- **Database server log (PostgreSQL, #757)** is kept **30 days** in CloudWatch Logs
  (`/aws/rds/instance/bball-tracker-production-postgres/postgresql`, `retention_in_days` on
  `aws_cloudwatch_log_group.rds_postgresql` in `infra/rds.tf`) and **3 days** on the database
  instance itself (`rds.log_retention_period`). It stays in the AWS account (not forwarded to
  Datadog). It records server events (start-up, checkpoints, autovacuum, rejected connections
  with the client's private network address and the database role) and, for each failed
  statement, the error message and the statement text. It is configured to hold no personal data: no statement or duration logging, no bind
  values, and no DETAIL line, which is where a failed write would quote the row or the key value,
  an email address for instance (`aws_db_parameter_group.postgres`, pinned by
  `backend/tests/infra/rds-parameters.test.ts`). The application sends every value as a bind
  parameter, so a failed statement's text carries placeholders, not values. A failed statement's
  error message can still quote a malformed input value (PostgreSQL's "invalid input syntax"
  errors do); inputs are validated before they reach the database, so this is not expected.
- **The load balancer and its firewall keep no per-request records** (#764): the ALB has no
  access or connection logs, and the AWS WAF web ACL in front of it keeps per-rule counts only (no
  logging configuration, sampled requests off). `backend/tests/infra/edge-hardening.test.ts` pins
  both; turning either on adds client IP addresses and full URLs to what is held, and needs an
  entry here first.
- After deletion nothing in the application maps the internal id back to a person, but the
  analytics, backend error and log records above remain at the vendors (Amplitude, Sentry,
  Datadog) and in CloudWatch, keyed on that id, until their windows expire. To remove them sooner,
  use each vendor's own deletion request for that id (CloudWatch has none short of deleting the
  log stream).
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
   `NODE_ENV=production` silences Prisma's query log, which otherwise lands on stdout. The script
   matches the address exactly: case-insensitive, `_` and `%` literal (`emailEquals`, #648), after
   trimming and lower-casing what you typed. If more than one active account matches (legacy
   mixed-case duplicates), it exits non-zero without exporting or deleting; pick the row by id in
   the database by hand before going on. Send the
   file to the verified address and delete your local copy. Never commit it or upload it to S3.
   The export contains: `user`, `personalLeague`, `teamMembers`, `teamStaff`, `leagueAdmins`,
   `guardiansAsParent`, `guardiansAsChild`, `receivedInvitations`, `sentInvitations`,
   `guardianInvitations`, `sentGuardianInvitations`, `gameRsvps`, `gameEvents`, `playerStats`,
   `pushTokens`, `calendarFeedTokens`, `announcements`, `announcementReplies`
   (`AccountService.exportUserData`; the integration test asserts this list).
4. **Delete:**
   ```bash
   cd backend && NODE_ENV=production npx tsx scripts/data-subject-request.ts delete <email>
   ```
   Output: `{ userId, deleted, identityDeleted, erased, adminlessLeagueIds }` (`erased: true` means
   the row was deleted outright because nothing referenced it; `false` means it was tombstoned —
   record which in the log table). The last-head-coach rule
   still applies: if it refuses, ask the person to hand the team over, or (with their consent)
   re-role another staff member yourself via `PATCH /teams/:id/staff/:userId`.
5. Run the post-deletion checklist below, then record the request in the log table.

## We learned an account holder is under 13

Account holders must be 13 or older (#980); a younger player is a roster record kept by a coach
or a parent. When we **learn** after the fact that someone holding an account is under 13 (a
parent writes to `privacy@hooplings.com`, a coach tells support, or a support thread plus a team's
age group makes it plain), we have actual knowledge under COPPA and must stop holding what was
collected from the child. Follow these steps every time; no code is written at the time.

1. **Acknowledge within 1 business day.** Reply to the reporter that we have received the report
   and will act within 5 business days. Do not ask the child for anything.
2. **Verify the reporter** with the identity rules of [Operator procedure](#operator-procedure-request-by-email)
   step 1: the account's own address, or a guardian whose address is on a `Guardian` /
   `GuardianInvitation` row for the child. A coach's report is acted on too (the coach is staff on
   the child's team), but confirm with the coach from the address on their own account. A report
   from anyone else: thank them and check the account yourself (the roster, the team's age group,
   the support thread); act when it is plain, without needing their identity.
3. **Find the user id and export.** Run the `export` command of the
   [Operator procedure](#operator-procedure-request-by-email) step 3 with the account's email; it
   prints `user.id`, and `teamMembers` says whether the child is on a roster. A coach's report
   usually names the team and the player instead: find the row on that team's roster. Keep the
   export only until the case is closed (a parent may ask what was held), then delete it.
4. **Within 5 business days, do ONE of the following.**
   - **(a) Convert** (the child is on a roster and the team wants to keep them): run
     ```bash
     cd backend && NODE_ENV=production npx tsx scripts/convert-to-managed.ts <userId>
     # or, to choose the managing coach:
     cd backend && NODE_ENV=production npx tsx scripts/convert-to-managed.ts <userId> --coach <coachUserId>
     ```
     The script needs the WorkOS credentials (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`) and
     `S3_AVATARS_BUCKET`, and refuses to start without them. Output: `{ userId, converted,
     managedById, identityDeleted, photoDeletion, expiredGuardianInvitations, deletedReplyCount }`.
     `identityDeleted` is `true` (WorkOS user deleted; with `identityNote: not_found_at_workos`
     when WorkOS had no such user, for example a Staging id left after the production-key
     cutover, which needs nothing) or `false` (deletion failed: the output adds `workosUserId` and
     `sessions`, see step 5). `photoDeletion` is `none` (no photo object of ours to delete),
     `deleted`, `not_ours` (the stored URL is not an upload key of ours; nothing to delete), or
     `failed`: the script then exits **4** (3 if the WorkOS deletion failed as well) and the
     object must be deleted by hand, see step 5.

     One transaction (`AccountService.convertToManaged`, the un-claim in `unclaimManagedRow`)
     turns the account into a roster record kept by `managedById`. That is the one head coach of
     the child's teams in active seasons, or the staff member `--coach` names, who must be on the
     staff of one of the child's teams **in an active season**. Not everything the child touched
     is deleted: the record keeps what a roster needs.

     **Deleted** (what identifies or reaches the child, or what the child wrote):
     - the login (`workosUserId`), the email and its verified flag, so a new sign-up with the same
       address cannot claim the record again;
     - push tokens and calendar-feed tokens;
     - pending team invitations (→ `CANCELLED`);
     - the announcement replies the child wrote (`deletedReplyCount`);
     - the photo, unless the managing coach or another staff member of the child's active-season
       teams uploaded it. Every other photo is cleared, **including an external URL a coach typed
       in**: the sign-in provider's photo of the child (a Google profile picture, say) is copied
       onto the row when the child signs in, and an external URL cannot be told apart from it, so
       it is treated as collected from the child. The coach can set the photo again. A cleared
       photo stored with us is deleted from S3 whoever uploaded it (the child, a parent, a past
       coach), unless another account still shows it;
     - the child's address on **every** guardian invitation that carries it, whatever its status
       and whichever child it is for (overwritten with a placeholder, as deletion does), after
       every pending one is expired. Each expired one is listed in `expiredGuardianInvitations`
       with the child it was for: one for this child cannot be told apart from a family inbox and
       accepting it would create a parent account at the child's address, and one for another
       child was waiting on this child to become that child's guardian;
     - an **empty** personal league the child once created.

     **Reset:** role back to `PLAYER`, subscription to free.

     **Kept:** the **name** (a roster record needs one, and it is what the coach entered or sees on
     the roster; the coach can edit it), roster memberships, game events, statistics, RSVPs,
     guardian links (an accepted link survives the scrub of its invitation's address), and
     guardian invitations for the child at other addresses. The coach's roster looks the same.

     After commit the WorkOS user is deleted, which ends its WorkOS sessions and refresh tokens.
     The old access token fails on every new API call (no row has its id), and a sign-in that was
     already under way when the conversion committed is refused instead of writing the email or
     photo back. A request authenticated just before the commit can still finish its write, and a
     live-game connection the child has open stays connected and keeps receiving that game's
     updates until the access token expires (minutes); nothing closes either sooner yet (#1004).

     **Refusals** (exit 1, nothing written; the script prints the reason and the next step, keyed
     on the refusal code):

     | Code | Meaning | Next step |
     | --- | --- | --- |
     | `already_managed` | already a managed record (a re-run) | nothing to do |
     | `never_signed_in` | an invited row the child never claimed | nothing to convert; nothing to un-claim |
     | `adult_account` (checked before the coach lookup, so an unrostered adult gets this, not `no_active_team`) | system ADMIN role, a staff role, admin of a league other than its own personal league, a guardian-of link, players it manages, announcements it posted, or team or guardian invitations it sent and did not cancel (a former coach); the COACH account type alone is not a signal, a child can pick it at sign-up | verify again; if the report holds, delete with (b) |
     | `personal_league_in_use` | its personal league holds teams or has another admin | verify again; if the report holds, delete with (b) |
     | `no_active_team` | the child is on no team in an active season at all: no roster to keep the record on | delete with (b); `--coach` cannot help |
     | `no_head_coach` | the child's active-season teams have staff but no head coach | pass `--coach` with one of those staff members |
     | `several_head_coaches` | more than one head coach qualifies | pass `--coach` |
     | `coach_not_on_team` | the `--coach` is not staff on one of the child's active-season teams | pass a staff member of those teams |
     | `coach_unavailable`, `coaches_changed` | the coach was deleted or the staff changed while it ran | run it again |

     If `expiredGuardianInvitations` is not empty (the script also prints a note with the child
     ids), contact the coach of **each** child listed: tell them a parent invitation went to an
     address that cannot be used, and ask them to re-invite the parent at the **parent's own**
     address. If **no guardian is linked** to this child, ask the managing coach to invite the
     parent from the child's roster entry (the guardian flow, `docs/architecture/guardians.md`);
     give the coach the parent's address only if the parent asked us to.
   - **(b) Delete** (the parent asks for deletion, the child is on no team in an active
     season, or conversion is refused): run the `delete` command of the [Operator procedure](#operator-procedure-request-by-email)
     step 4. It erases or anonymises by the usual rules and deletes the WorkOS user.
5. **WorkOS and the photo: finish both before you reply.** Either path deletes the WorkOS user best-effort. When
   it fails, `identityDeleted` is `false`; the convert script then prints `workosUserId` (the row
   no longer holds it, nor the email to search by; the id is also in the `Account converted to
   managed` log line and the `Failed to delete WorkOS user …` error line) and the stopgap's
   outcome: `sessions: { revoked, failed }` (the active sessions it revoked and the ones it could
   not; anything but `failed: 0` means the child is **not** fully signed out) or `sessions:
   null` (the sessions could not even be listed, nothing was revoked). It writes a `!!!` warning
   to stderr and exits **3**. Delete that WorkOS user by hand in the dashboard **before step 7**
   ([When WorkOS deletion fails](#when-workos-deletion-fails)): until it is gone the child can
   still sign in, and a sign-in would create a fresh account.
   If `photoDeletion` is `failed` (exit 4), the photo object is still in S3 but no record points
   at it any more: take its URL from the `Failed to delete avatar object` log line (or the export
   from step 3) and delete the object by hand (`aws s3 rm s3://<bucket>/avatars/<id>/<file>`)
   before step 7.
6. **Vendor deletion requests** for the internal user id, per [Retention](#retention-this-is-what-the-privacy-policy-must-say):
   Amplitude (user deletion by user id), Sentry (backend events carry the user id) and Datadog (log
   lines carry the user id). CloudWatch has no per-id deletion; its 30-day window applies. File
   all three the same day.
7. **Reply to the reporter** with what was done: converted to a record their coach keeps (and
   whether a parent invitation is on its way) or deleted, and that our vendors were asked to
   delete their copies.
8. **Record the case, ids only** (user id, path a/b, `managedById`, `identityDeleted` (`true`, or `false` and the date
   you deleted the WorkOS user by hand), the dates
   of steps 1, 4 and 6), in the private operations log. **Never** in a GitHub issue, a pull
   request or this repository: the record says a named account belonged to a child.

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
- The row carried a **staging** WorkOS id after the #24 production-key cutover (the person never
  signed in again, so it was never relinked) — the production environment has no such user;
  delete it from the *staging* environment's dashboard instead. The cutover runbook's
  "Afterwards" step deletes real people's staging identities once the rollback window closes
  ([WorkOS production cutover](workos-production-cutover.md)).

## When a saved avatar upload is still pending

After a profile photo is saved, the API removes the upload's `pending=true` tag (#1005). If that
fails, Sentry reports it (`flow: avatar-promote`). The API log line
`Could not untag a saved avatar upload; it will expire unless untagged by hand` carries the object
`key`. Remove the tag within 3 days of the upload, or S3 deletes the photo:

```bash
aws s3api delete-object-tagging --bucket bball-tracker-avatars-production --key "avatars/<userId>/<file>"
```

If it already expired, the profile shows a broken image; ask the person to choose the photo again.

## Reversal

There is none. The transaction is not reversible after commit; the only copy of the pre-deletion
data is the RDS automated backup (7 days), and restoring one to un-delete a single account is not
a supported operation.

## Request log

| Date | Type | Verified via | Ran by | `identityDeleted` | `erased` | Follow-ups |
| --- | --- | --- | --- | --- | --- | --- |
| _(none yet)_ | | | | | | |
