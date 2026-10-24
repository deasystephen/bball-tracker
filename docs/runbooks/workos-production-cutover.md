# WorkOS Staging → Production cutover (#24)

The procedure for moving the production API from the WorkOS **Staging** environment
(`sk_test_…`) to the **Production** environment (`sk_live_…`). It is owner work: WorkOS
dashboard access, a Terraform apply and a production deploy. Nothing in this repository runs it.

## At a glance

| Item | Value |
| --- | --- |
| What changes | The two Secrets Manager values `bball-tracker-production/workos-api-key` and `bball-tracker-production/workos-client-id`, and with them every WorkOS identity |
| What does not change | Every `User` row, team, membership, game and stat. No database write is needed |
| Who is affected | Every signed-in user is signed out once, and must **sign up again with the same email** (production WorkOS has no users and no passwords) |
| How accounts are kept | `WorkOSService.syncUser` relinks each row by verified email on its first production sign-in (branch 3a, below) |
| Window | About 10 minutes of operator time; users are signed out from the moment the new task serves until they next open the app |
| Rollback | Put the staging values back and redeploy. No snapshot restore: the same relink runs in reverse |
| Read-only check | `backend/scripts/workos-cutover-check.mjs` (case collisions, counts, which rows have relinked) |

## Why no relink script

Every production `User` row holds a **staging** WorkOS user id. On a production sign-in the
identity's id matches no row, and the email lookup finds the person's row still bound to the
staging id. Before #24's preparation that was a 409 (`Auth callback email linked to a different
WorkOS user`) for every existing account.

Two designs were considered:

1. **A hand-run script that clears every staging `workosUserId`** so the next sign-in claims the
   row like a pre-provisioned one. Rejected: it has to run in a narrow gap between the key switch
   and the first sign-in (run too early and a staging sign-in on the old task re-links a staging
   id; run too late and those sign-ins get the 409), it needs a record of what it cleared to roll
   back, and a claim also clears `isManaged`/`managedById`, re-runs the ADMIN allowlist and
   reports `claimedInvite: true` to analytics, none of which is true of a returning user.
2. **A code path that recognises an identity the current environment does not know. Chosen.**
   When the email matches a row bound to a *different* WorkOS id, `syncUser` asks WorkOS for
   that id (`WorkOSService.identityExists`, `GET /user_management/users/:id`). A **404** means
   the id belongs to another environment (or was deleted in the dashboard). If WorkOS also
   reports the email **verified**, the row is moved to the new identity with a compare-and-set on
   the old id (`relinkUnknownIdentity`), guarded by `deletedAt IS NULL`; role, name, memberships
   and `isManaged` are untouched, and the callback answers 200 with `claimedInvite: false`. It
   logs `Relinked user to a new WorkOS identity` (`userId` only).

   Everything else keeps the 409: the old identity still exists (two live identities for one
   address), the email is not verified, or the row changed underneath the sign-in. Any WorkOS
   failure other than 404 is a 503, never a relink on a guess.

Consequences:

- **Inert until the keys change.** On staging keys every stored id is known to staging, so the
  branch never fires; the only extra work is one `getUser` call on a path that was already a 409.
- **No timing gap.** The relink happens when each person signs in, whenever that is.
- **No spurious cutover alarm.** A relinked sign-in never reaches the 409, so the Sentry capture
  `flow: auth-callback-conflict` (the "New issue in production" email) keeps meaning "something
  is really wrong".
- **Rollback needs no restore.** Back on staging keys, each production id is unknown to staging
  and the next staging sign-in relinks the same way.
- **Tombstones are never touched.** A deleted account has no email, so the lookup cannot reach it.
- **Coach-added players are unaffected.** A row with no `workosUserId` is claimed by the existing
  branch 2, exactly as before (gated on a verified email once #952 is merged).
- **Case.** The lookup is case-insensitive (`emailEquals`) and a new account stores the
  lower-cased address (#955). Two live rows that differ only by case are refused with 409 rather
  than guessed at; the check script finds them before the cutover.

## Preconditions

- [ ] This preparation PR is merged and deployed (`curl -s https://api.hooplings.com/health`
      shows its commit or a later one).
- [ ] #952 (verified-email gate on the claim) is merged, or knowingly deferred.
- [ ] Docker Postgres available on the machine that runs Rehearsal B (`docker-compose up -d`).
- [ ] The owner can reach the WorkOS dashboard, run `terraform apply` from `infra/`, and run a
      one-off ECS task (the variant in [RDS backup & restore](rds-backup-restore.md)).

## 1. Set up the WorkOS Production environment

In the WorkOS dashboard, switch to (or activate) the **Production** environment. Screen names
below are those of the staging dashboard; check each against the live UI.

- [ ] **Redirect URIs: exactly two.** `https://api.hooplings.com/api/v1/auth/callback` (the
      default; it is `WORKOS_REDIRECT_URI` in `infra/task-definition.json`) and
      `hooplings://auth/callback` (the mobile app). **Never** add `bball-tracker://auth/callback`:
      the old scheme stays in Staging only for the #504 overlap. Never add `localhost`.
- [ ] **Authentication methods.** Enable **Email + Password**: the App Store reviewer signs in
      with a username and password from the review notes (#451) and cannot read a Magic Auth
      code. Mirror any other method enabled in Staging; if a third-party social login is
      offered, Apple's guideline 4.8 also expects Sign in with Apple.
- [ ] **Email verification: required** for every enabled method (#956). The relink (branch 3a)
      and the pre-provisioned claim (#952) both act only on `emailVerified === true`; without it,
      every returning user gets the 409. Record the setting in `docs/architecture/auth-sessions.md`
      if it differs from what is written there.
- [ ] **Sign-up enabled** (every existing user signs up again).
- [ ] **Branding.** App name Hooplings, logo, colours, matching Staging. **Do not configure a custom
      AuthKit domain in this window**: it can change the access token `iss`, and the API accepts
      only `WORKOS_JWT_ISSUER` (default `https://api.workos.com`). Every request would be a 401.
      If you want one later, set `WORKOS_JWT_ISSUER` in `infra/task-definition.json` in the same PR.
- [ ] **Session settings** (access-token lifetime, refresh-token lifetime) the same as Staging.
- [ ] Copy the **API key** (`sk_live_…`) and **Client ID** (`client_…`) into your password
      manager. Never paste either into a terminal that echoes it, a chat or a file in the repo.
- [ ] Look up one real **staging** user id (Staging → Users → your own user, `user_01…`) for the
      404 check in Rehearsal B.

## 2. Rehearsal A: the data, on a restored snapshot (doubles as the restore drill)

This is a run of [RDS backup & restore](rds-backup-restore.md) Procedure A steps 1–4 with the
"rehearse on a restored copy" variant (single-AZ, no deletion protection, a throwaway
task-definition revision whose script rewrites the host in `$DATABASE_URL`). **Record it in that
runbook's Drill log**: it is also the periodic restore drill.

1. Restore the latest automated snapshot to `bball-tracker-production-postgres-cutover-$(date -u +%Y%m%d%H%M)`
   and time it to `available`.
2. From the one-off task, run the check with `/app` as the working directory (embed the file
   via heredoc like `pg-upgrade-checks.mjs`):

   ```bash
   cd /app && node /tmp/workos-cutover-check.mjs
   cd /app && node /tmp/workos-cutover-check.mjs --check-workos --no-fail   # task env = staging key
   ```

3. Read the result in CloudWatch (`/ecs/bball-tracker-production`, stream `api/api/<task id>`):
   - Exit 0 and `caseCollisions: []`. **Any group is a blocker**: each lists the user ids of live
     accounts whose emails differ only by case. Decide with the person which row is theirs and
     merge or delete the other (data-subject runbook, operator delete by id) *on production*,
     then re-run.
   - Note `users.total`, `users.linked` (accounts that will relink), `users.linkedAdmins`.
   - With the staging key, `workos.unknown` should be 0. A non-zero value lists rows whose staging
     identity was deleted in the dashboard; they already relink on their next staging sign-in.
4. Tear down the copy and the throwaway revisions (variant step 3).

## 3. Rehearsal B: the code path, end to end, on a local stack

Proves the three WorkOS behaviours that no test can see: production answers **404** for a staging
id, a staging refresh token is **refused with a 4xx** by the production client (so the app lands
on sign-in instead of looping), and production access tokens carry `iss = https://api.workos.com`.

1. **404 for a staging id** (read-only call to production WorkOS):

   ```bash
   read -rs WORKOS_PROD_KEY            # paste sk_live_…, Enter; nothing is echoed
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $WORKOS_PROD_KEY" \
     https://api.workos.com/user_management/users/<a staging user id>
   unset WORKOS_PROD_KEY
   ```

   Expect `404`. **Anything else (400, 403, 422) stops the cutover**: `identityExists` would answer
   503 to every returning user. Report it on #24.
2. Local stack: `docker-compose up -d`, backend with the **staging** keys in `backend/.env`,
   `npx expo run:ios`. Sign in with your own email (a real WorkOS sign-in, not dev-login). Note
   your user id and teams.
3. Stop the backend. Put the **production** API key and client id in `backend/.env` (keep a copy
   of the staging values). Start the backend.
4. Open the app. Expect: the stored session fails (401 on the first request, `/auth/refresh` 401),
   and the app lands on **sign-in** with no crash and no request storm. A 503 from `/auth/refresh`
   instead means WorkOS reports the foreign refresh token as an outage: stop and report it.
5. Sign up with the **same email** in production AuthKit and verify it. Expect: you land in the
   app with your teams; the backend log shows `Relinked user to a new WorkOS identity` with your
   user id and no `Auth callback email linked to a different WorkOS user`.
6. Decode the new access token's payload (any JWT decoder, locally) and confirm
   `iss = https://api.workos.com`.
7. **Rollback rehearsal:** restore the staging values in `backend/.env`, restart, reopen the app:
   sign-in again, sign in with staging, and the log shows the relink back.
8. Delete the local test data (`npx prisma db seed` resets it) and put the staging keys back in
   `backend/.env`.

## 4. Cutover

Pick a quiet hour. Tell testers beforehand (template below).

| Step | Time | Action |
| --- | --- | --- |
| 1 | T−1 day | Run the check against **production** from a one-off task (read-only, same command as Rehearsal A step 2). `caseCollisions` must be `[]`. |
| 2 | T−10 min | **Live-game check.** No `IN_PROGRESS` game (Datadog US5 `service:bball-tracker-api ("Game created" OR "Game event created")` over the last hours, or ask the testers). The redeploy in step 4 splits live games like any deploy. |
| 3 | T0 | **Secrets, through Terraform** (see below). No effect on the running task. |
| 4 | T+2 min | `--force-new-deployment` and wait for `services-stable` (about 3–5 min). |
| 5 | T+7 min | Verify (section 5). |

**Why Terraform and not a bare `put-secret-value`.** Both secret versions are Terraform resources
(`aws_secretsmanager_secret_version.workos_api_key` / `.workos_client_id` in `infra/ecs.tf`, values
from `workos_api_key` / `workos_client_id` in the gitignored `infra/terraform.tfvars`). A value
written with `aws secretsmanager put-secret-value` alone is moved back to `AWSPREVIOUS` by the next
`terraform apply` of anything, and the task after that starts on the **staging** keys again. So
the values go into `terraform.tfvars` and one apply writes both versions.

Step 3, from `infra/` (nothing is echoed; the values never reach the transcript):

```bash
cd infra
read -rs WORKOS_PROD_KEY        # paste sk_live_…, Enter
read -rs WORKOS_PROD_CLIENT     # paste client_…, Enter
sed -i '' "s/^workos_api_key *=.*/workos_api_key = \"${WORKOS_PROD_KEY}\"/" terraform.tfvars
sed -i '' "s/^workos_client_id *=.*/workos_client_id = \"${WORKOS_PROD_CLIENT}\"/" terraform.tfvars
unset WORKOS_PROD_KEY WORKOS_PROD_CLIENT
grep -c '^workos_api_key = "sk_live_' terraform.tfvars     # 1
grep -c '^workos_client_id = "client_' terraform.tfvars    # 1
terraform plan -input=false
terraform apply -input=false
```

The plan must be exactly `aws_secretsmanager_secret_version.workos_api_key` and
`aws_secretsmanager_secret_version.workos_client_id` **replaced** (`-/+`). Anything else: stop.
The staging values become `AWSPREVIOUS` of each secret, which is the rollback anchor.

If Terraform is unavailable and the switch cannot wait, the equivalent direct write is below; then
update `terraform.tfvars` to the same values **in the same session**, or the next apply reverts it:

```bash
read -rs WORKOS_PROD_KEY
aws secretsmanager put-secret-value --secret-id bball-tracker-production/workos-api-key \
  --secret-string "$WORKOS_PROD_KEY" --query VersionId --output text
read -rs WORKOS_PROD_CLIENT
aws secretsmanager put-secret-value --secret-id bball-tracker-production/workos-client-id \
  --secret-string "$WORKOS_PROD_CLIENT" --query VersionId --output text
unset WORKOS_PROD_KEY WORKOS_PROD_CLIENT
```

Step 4:

```bash
aws ecs update-service \
  --cluster bball-tracker-production-cluster \
  --service bball-tracker-production-api \
  --force-new-deployment
aws ecs wait services-stable \
  --cluster bball-tracker-production-cluster \
  --services bball-tracker-production-api
```

**What users see.** During the rolling overlap the old task (staging) and the new one
(production) both serve. A sign-in begun on one and finished on the other fails the code exchange
(400, "Invalid or expired authorization code. Please sign in again."); signing in again works.
Once the new task serves alone, every stored session is dead: the access token fails the
production JWKS (401), `/auth/refresh` is refused (401), `clearSession()` runs and
`useAuthRedirect` routes to the login screen. Each person signs up again with the same email,
verifies it, and is back in their own account. Nobody is signed out for longer than it takes
them to do that. Push tokens stay bound to the account, so pushes keep arriving meanwhile.

**Expected log noise** (all `warn`, none of it an alarm): `Rejected WorkOS access token` and
`Refresh token rejected`, one or two per device, and `WorkOS rejected authorization code` during
the overlap.

## 5. Verify

- [ ] `curl -s https://api.hooplings.com/health` — 200, expected commit; the deployment is
      `PRIMARY` / `COMPLETED` with no circuit-breaker rollback.
- [ ] `aws secretsmanager describe-secret --secret-id bball-tracker-production/workos-api-key --query VersionIdsToStages`
      — new id `AWSCURRENT`, old id `AWSPREVIOUS` (same for `workos-client-id`).
- [ ] On a device with the latest TestFlight build: the app opens on sign-in; sign up with your own
      email; you land on Home with your teams, your ADMIN role intact (Profile).
- [ ] Datadog (US5) `service:bball-tracker-api "Relinked user to a new WorkOS identity"` — one line
      per returning user. `"Auth callback email linked to a different WorkOS user"` — none.
      `"WorkOS getUser failed while checking a linked identity"` — none.
- [ ] Sentry `bball-tracker-backend`, `production`: no new `auth-callback-conflict` issue.
- [ ] From a one-off task (the live task env now has the production key):
      `cd /app && node /tmp/workos-cutover-check.mjs --check-workos --no-fail`. `workos.environment`
      is `production`; `workos.unknown` is the number of accounts that have not signed in again,
      and falls as they do. `workos.failed` must be 0.
- [ ] Create the App Store **demo account** (#451) in production WorkOS (Users → Create user, email
      + password, email marked verified), sign in once on a device so its row exists, then seed
      its team per `docs/release/app-store-submission.md`.

## 6. Rollback

Use it when sign-in is broken for everyone after the switch (for example a 503 on every sign-in,
which means `identityExists` cannot read WorkOS) and the cause is not obvious within minutes.

1. Put the staging values back into `terraform.tfvars` from `AWSPREVIOUS`, without printing them:

   ```bash
   cd infra
   OLD_KEY=$(aws secretsmanager get-secret-value --secret-id bball-tracker-production/workos-api-key \
     --version-stage AWSPREVIOUS --query SecretString --output text)
   OLD_CLIENT=$(aws secretsmanager get-secret-value --secret-id bball-tracker-production/workos-client-id \
     --version-stage AWSPREVIOUS --query SecretString --output text)
   sed -i '' "s/^workos_api_key *=.*/workos_api_key = \"${OLD_KEY}\"/" terraform.tfvars
   sed -i '' "s/^workos_client_id *=.*/workos_client_id = \"${OLD_CLIENT}\"/" terraform.tfvars
   unset OLD_KEY OLD_CLIENT
   grep -c '^workos_api_key = "sk_test_' terraform.tfvars     # 1
   terraform apply -input=false
   ```

2. Force a new deployment (step 4) and verify `/health`.
3. Nothing in the database needs reversing. Accounts that relinked to a production id relink back
   on their next staging sign-in, because staging does not know the production id. Accounts that
   were created during the window (new emails) get a staging identity the same way.
4. Comment on #24 with what failed.

## 7. Afterwards

- [ ] Leave the Staging environment untouched for **14 days** (the rollback window).
- [ ] Then, in **Staging**: delete the identities of real people (everyone not in
      `docs/testing/workos-test-accounts.md`'s dev personas), so Staging stops holding their
      email and name. Until then, an account deletion for a row that never relinked reports
      `identityDeleted: false` (the production delete 404s), and the staging identity is removed by
      hand ([data-subject requests](data-subject-requests.md), "When WorkOS deletion fails").
- [ ] Roll the **staging** API key (Staging → API Keys) and update `backend/.env` on every
      developer machine: the old one sat in production Secrets Manager (`AWSPREVIOUS`) and in
      Terraform state.
- [ ] `mobile/app.config.js` needs no change: the client id never reaches the app.
- [ ] Tick #24's acceptance criteria and record the run below.

## Communication template

> **Hooplings sign-in is moving to our production login service on <date> around <time>.**
> You will be signed out once. Open the app, choose **Sign up**, and use the **same email address**
> you use today (you will set a new password and confirm the email). Your teams, games and stats
> are all still there. Reply to this email if anything looks wrong.

## Run log

| Date | Ran by | Rehearsal A (restore time, collisions, linked) | Rehearsal B (404, refresh 4xx, `iss`) | Cutover (window, relinked in 24 h) | Notes |
| --- | --- | --- | --- | --- | --- |
