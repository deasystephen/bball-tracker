# RDS Backup & Restore Runbook

Operational procedure for backing up and restoring the production RDS PostgreSQL
instance. Required reading before any data-loss incident response.

> **Out of scope:** point-in-time recovery (PITR), cross-region disaster
> recovery, logical (`pg_dump`) backups. Tracked separately if/when needed.

## At a glance

| Item | Value |
| --- | --- |
| Instance identifier | `bball-tracker-production-postgres` |
| Engine | PostgreSQL 18 (RDS applies minors in the maintenance window; the major is pinned in `infra/rds.tf` and cross-checked by `backend/tests/infra/postgres-version.test.ts`) |
| Region | `us-east-1` |
| Multi-AZ | Yes (production only) |
| Storage | gp3, 20–100 GiB autoscaling, encrypted at rest |
| Automated backup retention | 7 days |
| Daily snapshot window | 03:00–04:00 UTC |
| Maintenance window | Sun 04:00–05:00 UTC |
| Deletion protection | Enabled |
| Final snapshot on delete | `bball-tracker-production-final-snapshot` |
| Connection string source | Secrets Manager: `bball-tracker-production/database-url` |
| ECS cluster / service | `bball-tracker-production-cluster` / `bball-tracker-production-api` |
| Public DNS | App reaches RDS via the **endpoint string baked into the secret**, not via Route53. The `api.hooplings.com` Route53 record points at the ALB, not the database. |

All of the above is enforced by Terraform in `infra/rds.tf` and `infra/ecs.tf`.
Do not hand-edit the instance in the AWS console.

## TLS / CA bundle

RDS requires TLS (`rds.force_ssl = 1`, the default parameter-group value since Postgres 15). The backend
connects via the `@prisma/adapter-pg` (node-postgres) driver, which only
negotiates TLS when explicitly configured — see `backend/src/models/index.ts`.
The server certificate is verified against the **pinned Amazon RDS global CA
bundle** committed at `backend/certs/rds-global-bundle.pem` (copied into the
image by `docker/Dockerfile`, overridable at runtime via `RDS_CA_BUNDLE_PATH`).

> **Refresh expectation:** the global bundle rotates (Amazon publishes new
> regional CAs ahead of old-CA expiry). Re-download it periodically and before
> any RDS CA-rotation deadline:
> ```bash
> curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
>   -o backend/certs/rds-global-bundle.pem
> ```
> A stale or missing bundle makes the backend fail its `/health` DB ping (503),
> so a bad CA update is caught at deploy time rather than silently. History: a
> non-TLS adapter connection caused the 2026-06-21 sign-in outage (surfaced as a
> misleading Prisma "P1010 denied access"); CA pinning landed in #216.

## Verifying backups (do this monthly)

```bash
aws rds describe-db-instances \
  --db-instance-identifier bball-tracker-production-postgres \
  --query 'DBInstances[0].{Retention:BackupRetentionPeriod,Window:PreferredBackupWindow,Latest:LatestRestorableTime,Engine:EngineVersion}'
```

Expect `Retention: 7`, a recent `Latest` (within the last few minutes), the
configured backup window, and an `Engine` whose major matches `engine_version`
in `infra/rds.tf` (the parity test cannot see production, so this monthly
check is where a live divergence would show). If retention is below 7 or `Latest` is stale by more
than 24 hours, file a P1 — backups are silently broken.

List the most recent automated snapshots:

```bash
aws rds describe-db-snapshots \
  --db-instance-identifier bball-tracker-production-postgres \
  --snapshot-type automated \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:10].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
  --output table
```

Manual snapshots (taken before risky migrations etc.) live under
`--snapshot-type manual`.

## Choosing the right procedure

| Symptom | Procedure |
| --- | --- |
| App is reading wrong data after a bad migration / mass update / deploy | Procedure A — restore latest pre-incident snapshot to a new instance, repoint the secret |
| The RDS instance itself is unreachable or corrupt | Procedure A, then file an AWS support case for the broken instance |
| You restored to the wrong snapshot or the new instance is misconfigured | Procedure B — rollback by repointing the secret at the previous instance |
| Single table dropped, rest of the DB is fine and you have a recent snapshot | Procedure A into a temporary instance, then `pg_dump`/`pg_restore` the table back into prod (don't repoint the secret) |

Default to Procedure A. Ad-hoc fixes against the live instance are how
incidents become two incidents.

## Procedure A — Restore from snapshot to a new instance

**Estimated wall-clock:** ~15–30 min for the restore + ~2 min for the
secret/ECS flip. Fill in the actual time on each run in the [Drill log](#drill-log).

1. **Pick the snapshot.** From the listing above, pick the most recent snapshot
   created **before** the incident. Set:

   ```bash
   SNAPSHOT_ID=<the snapshot identifier from the list>
   NEW_INSTANCE_ID=bball-tracker-production-postgres-restore-$(date -u +%Y%m%d%H%M)
   ```

2. **Kick off the restore.** Match the source instance's class and networking
   exactly so the app can reach it:

   ```bash
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier "$NEW_INSTANCE_ID" \
     --db-snapshot-identifier "$SNAPSHOT_ID" \
     --db-instance-class db.t3.micro \
     --db-subnet-group-name bball-tracker-production-db-subnet \
     --vpc-security-group-ids "$(aws ec2 describe-security-groups \
        --filters Name=group-name,Values=bball-tracker-production-rds-sg \
        --query 'SecurityGroups[0].GroupId' --output text)" \
     --no-publicly-accessible \
     --multi-az \
     --storage-type gp3 \
     --copy-tags-to-snapshot \
     --deletion-protection
   ```

   **Match the size class to whatever production is running.** Run
   `terraform output db_instance_class` (or check `terraform.tfvars`) if you're
   not sure.

3. **Wait for it to come up.** The restore finishes when the instance is
   `available`. Poll:

   ```bash
   aws rds wait db-instance-available --db-instance-identifier "$NEW_INSTANCE_ID"
   aws rds describe-db-instances \
     --db-instance-identifier "$NEW_INSTANCE_ID" \
     --query 'DBInstances[0].{Status:DBInstanceStatus,Endpoint:Endpoint.Address,Port:Endpoint.Port}'
   ```

4. **Smoke-test connectivity from a private subnet.** Easiest path is to start
   a one-shot ECS task in the same VPC that runs `psql -c 'SELECT now();'`
   against the new endpoint. If you don't have one handy, run `psql` from a
   bastion or from the running backend container (`aws ecs execute-command …
   --container api -- psql "$DATABASE_URL"`). You're checking for: TCP
   reachability, auth working with the existing credentials (snapshots preserve
   them), and that key tables (`users`, `teams`, `games`) exist with non-zero
   row counts as expected.

5. **Repoint the application.** The app reads `DATABASE_URL` from Secrets
   Manager. Build the new value and write a new secret version:

   ```bash
   NEW_ENDPOINT=$(aws rds describe-db-instances \
     --db-instance-identifier "$NEW_INSTANCE_ID" \
     --query 'DBInstances[0].Endpoint.Address' --output text)
   NEW_PORT=$(aws rds describe-db-instances \
     --db-instance-identifier "$NEW_INSTANCE_ID" \
     --query 'DBInstances[0].Endpoint.Port' --output text)

   # Pull current creds + db name out of the existing secret rather than
   # retyping them. AWSCURRENT is the live version.
   OLD_URL=$(aws secretsmanager get-secret-value \
     --secret-id bball-tracker-production/database-url \
     --version-stage AWSCURRENT --query SecretString --output text)
   DB_USER=$(echo "$OLD_URL" | sed -E 's|^postgresql://([^:]+):.*|\1|')
   DB_PASS=$(echo "$OLD_URL" | sed -E 's|^postgresql://[^:]+:([^@]+)@.*|\1|')
   DB_NAME=$(echo "$OLD_URL" | sed -E 's|.*/([^/?]+)$|\1|')

   NEW_URL="postgresql://${DB_USER}:${DB_PASS}@${NEW_ENDPOINT}:${NEW_PORT}/${DB_NAME}"

   aws secretsmanager put-secret-value \
     --secret-id bball-tracker-production/database-url \
     --secret-string "$NEW_URL"
   ```

   The previous secret value is kept as `AWSPREVIOUS` — that is the rollback
   anchor for Procedure B. Do not delete or overwrite it more than once during
   an incident.

6. **Force the ECS service to pick up the new secret.** Secrets are read at
   task start, so existing tasks keep using the old endpoint until they're
   replaced.

   ```bash
   aws ecs update-service \
     --cluster bball-tracker-production-cluster \
     --service bball-tracker-production-api \
     --force-new-deployment

   aws ecs wait services-stable \
     --cluster bball-tracker-production-cluster \
     --services bball-tracker-production-api
   ```

7. **Verify.** Hit the health endpoint and watch error rates:

   ```bash
   curl -fsS https://api.hooplings.com/health
   ```

   In Sentry, watch the `prod` environment for new error spikes. In CloudWatch,
   the ECS service's task count should match desired count and ALB 5xx should
   be flat.

8. **Reconcile Terraform.** The live instance identifier no longer matches
   `aws_db_instance.main`. Two acceptable paths:
   - **Short-term (during the incident):** leave Terraform out of sync. Do
     **not** run `terraform apply` until step 9.
   - **Permanent fix (within a few days):** update `infra/rds.tf` so
     `identifier` is the new ID, then `terraform import` the restored
     instance. Or rename the restored instance back to the original ID with
     `aws rds modify-db-instance --new-db-instance-identifier …`, then update
     the secret again. Renaming is the cleanest long-term answer because it
     keeps Terraform state and the canonical name aligned.

9. **Decommission the old instance.** Only after the new instance has been
   serving traffic cleanly for at least 24 hours and a fresh snapshot has been
   taken of the new instance:

   ```bash
   # Take a final snapshot of the dead instance for forensics
   aws rds delete-db-instance \
     --db-instance-identifier bball-tracker-production-postgres \
     --final-db-snapshot-identifier bball-tracker-production-postincident-$(date -u +%Y%m%d) \
     --no-skip-final-snapshot
   ```

   Deletion protection is on by default — disable it via
   `aws rds modify-db-instance --no-deletion-protection` immediately before the
   delete call if AWS rejects the delete.

### Variant — rehearse a schema migration on a restored copy (no repoint)

CI applies migrations to an **empty** database (`ci.yml` starts a bare `postgres:18`), so a
migration that backfills data (`UPDATE … SET`, `INSERT … SELECT`, then `SET NOT NULL`) first
meets real rows at the production container start. Rehearse it here before merging; the
permanent CI guard is #493. Steps 1–4 of Procedure A apply unchanged, except restore
**single-AZ, no deletion protection** (`--no-multi-az --no-deletion-protection`) so the
copy is cheap and deletable in one call. Then, instead of step 5:

1. **Run the migration from inside the VPC.** The restored instance is private, so run it as
   a one-off Fargate task in the service's subnets and security group. Two gotchas, both hit
   on 2026-09-06:
   - `ecs run-task` **cannot override `entryPoint`**, and the image's `ENTRYPOINT
     ["./entrypoint.sh"]` ignores a `command` override (it runs `migrate deploy` against the
     real `DATABASE_URL` secret, then the server). So register a **throwaway task-definition
     revision**: `describe-task-definition` the live revision, strip the read-only fields,
     set `entryPoint: ["sh","-c"]` and `command: [<script>]`, keep image and secrets, drop
     `healthCheck`, and `register-task-definition`. The service is pinned to its own revision
     (`ignore_changes`), so an extra revision changes nothing; deregister it afterwards.
   - The script must **rewrite the host** in `$DATABASE_URL` to the restored endpoint
     (`sed -E "s#@[^/@]+/#@${NEW_HOST}:5432/#"`), so no password ever appears in the task
     definition. Apply the SQL with `DATABASE_URL="$URL" ./node_modules/.bin/prisma db execute
     --file <migration.sql>` (Prisma 7's `db execute` reads the URL from `prisma.config.ts`,
     there is no `--url` flag) — the live image does not contain the unmerged migration, so
     embed the file's contents in the script via a heredoc. For before/after counts use
     `NODE_PATH=/app/node_modules node <script>` with `pg` and the pinned CA bundle at
     `certs/rds-global-bundle.pem`.
2. **Read the result** from CloudWatch: log group `/ecs/bball-tracker-production`, stream
   `api/api/<task id>`. Assert the migration's own invariant (for #462:
   `SELECT count(*) FROM "Team" WHERE "lineageId" IS NULL` = 0).
3. **Tear down.** `aws rds delete-db-instance --skip-final-snapshot --delete-automated-backups`
   and `aws ecs deregister-task-definition` for each throwaway revision. Record the run in the
   [Drill log](#drill-log).

## Procedure B — Rollback to the previous instance

Use this when the restore in Procedure A turned out to be the wrong snapshot
(or otherwise wrong) and the previous production instance is still alive.

1. **Confirm the previous instance is still there.**

   ```bash
   aws rds describe-db-instances \
     --db-instance-identifier bball-tracker-production-postgres \
     --query 'DBInstances[0].DBInstanceStatus'
   ```

   If you already deleted it in Procedure A step 9, this rollback path is
   closed — go restore the pre-incident snapshot again with a fresh ID.

2. **Restore the previous secret value.** Secrets Manager keeps the prior
   value at `AWSPREVIOUS`:

   ```bash
   PREV_URL=$(aws secretsmanager get-secret-value \
     --secret-id bball-tracker-production/database-url \
     --version-stage AWSPREVIOUS --query SecretString --output text)

   aws secretsmanager put-secret-value \
     --secret-id bball-tracker-production/database-url \
     --secret-string "$PREV_URL"
   ```

3. **Force a new ECS deployment** (same command as Procedure A step 6) and
   verify (step 7).

4. **Tear down the bad restore** so it doesn't accrue cost or confusion:

   ```bash
   aws rds delete-db-instance \
     --db-instance-identifier "$NEW_INSTANCE_ID" \
     --skip-final-snapshot
   ```

## Major version upgrade

First run: PostgreSQL 15.17 → 18.6, #521, 2026-09. Reuse this section for every major; the
engineering-review decision trail is on the issue.

**Why it is a CLI operation, not a `terraform apply`.** A bare major (`--engine-version 18`,
or `engine_version = "18"` in Terraform) resolves to the RDS *default* minor for that major
(18 → 18.3), not the newest, and no 18.x minor is auto-upgrade flagged, so it would sit there.
`apply_immediately` defaults to false in the provider, so a Terraform-driven upgrade would also
queue for the Sunday window unattended. So: upgrade with the exact minor from the CLI while
watching, then bump the major-only pin in `infra/rds.tf`; `terraform plan` must print
**No changes**. `allow_major_version_upgrade` is deliberately absent from `rds.tf`.

**What actually breaks.** `pg_upgrade` preserves rows and indexes but carries no planner
statistics (run `ANALYZE`), and an OS update bundled with the upgrade can move the glibc
**collation version**, after which every text index (`User.email`, `Team.name`, invitation
tokens) can mis-order silently until `REINDEX DATABASE` + `ALTER DATABASE … REFRESH COLLATION
VERSION`. `backend/scripts/pg-upgrade-checks.mjs` reports AWS's pre-upgrade blockers, core-table
row counts and the recorded-vs-actual collation version as JSON; run it before and after (with
`--compare before.json`) on the rehearsal copy and on production. The API image has no `psql`
and `prisma db execute` prints no rows, so it runs as `NODE_PATH=/app/node_modules node
/tmp/pg-upgrade-checks.mjs` inside the one-off task from the variant above (embed the script
via heredoc; it reads `DATABASE_URL` and the pinned CA bundle like the API).

**Do not choose `engine_lifecycle_support = "…-disabled"` to "fail loudly".** With it
disabled RDS auto-upgrades the major *unattended* at end of standard support; with the default
it silently bills. Neither warns — `backend/tests/infra/postgres-version.test.ts` turns CI red
six months before the pinned major's date instead. If downtime matters by the next major, use
RDS Blue/Green (logical replication to a green instance, switchover in seconds) rather than
this in-place procedure.

### 1. Open the PR first, merge it last

Bump `docker-compose.yml` (image **and** mount: the `postgres:18` image moved `PGDATA` to
`/var/lib/postgresql/18/docker` and its `VOLUME` to `/var/lib/postgresql`), `ci.yml`, and
`infra/rds.tf`; add the new major's end-of-support date to the parity test. Open the PR: its CI
run is the whole backend suite on the new major, including the real-database
`league-access.db.test.ts`. **Merge only after production is upgraded** — merging first makes
CI validate migrations against an engine production does not run (dependabot deploys
`backend/**` merges unattended).

### 2. Rehearse on a Multi-AZ restored copy

Procedure A steps 1–4 with `--multi-az` (single-AZ under-reports the timing), no deletion
protection. From the one-off task:

1. `pg-upgrade-checks.mjs > before.json` — prechecks must be clean.
2. `aws rds modify-db-instance --db-instance-identifier "$COPY" --engine-version 18.6
   --allow-major-version-upgrade --apply-immediately`; poll `describe-db-instances` and
   `describe-events --source-type db-instance --source-identifier "$COPY"`; **record the
   wall-clock from `upgrading` to `available`** — that is the production window.
3. `./node_modules/.bin/prisma migrate deploy` → "No pending migrations".
4. `pg-upgrade-checks.mjs --compare before.json` → exit 0 (counts equal, collation versions
   equal). On a collation mismatch: `REINDEX DATABASE`, `ALTER DATABASE … REFRESH COLLATION
   VERSION`, time it, and plan the same for production.
5. `ANALYZE VERBOSE;` timed.
6. Tear down; record the run in the Drill log.

### 3. Production window (about 30 minutes, watched)

**Preconditions:** rehearsal done; the PR is open and green; no other change is about to
merge — `aws ecs describe-services … deployments[0].rolloutState` is `COMPLETED`, and nothing
merges to `main` until the window closes. A merge mid-window either rolls back red (service
up, health check fails against the unavailable DB) or passes green while running nothing
(service scaled to 0 — 0/0 is "stable"). Both mislead whoever merged.

1. **Snapshot**: `aws rds create-db-snapshot --db-instance-identifier
   bball-tracker-production-postgres --db-snapshot-identifier
   bball-tracker-production-pre-pg18-$(date -u +%Y%m%d%H%M)`; `aws rds wait
   db-snapshot-completed`. (RDS also snapshots before and after because retention > 0.)
2. **Scale the API to 0.** The autoscaling target has `min_capacity = 1`, so a bare
   `--desired-count 0` is scaled straight back; lower the minimum first:
   ```bash
   aws application-autoscaling register-scalable-target --service-namespace ecs \
     --scalable-dimension ecs:service:DesiredCount \
     --resource-id service/bball-tracker-production-cluster/bball-tracker-production-api \
     --min-capacity 0
   aws ecs update-service --cluster bball-tracker-production-cluster \
     --service bball-tracker-production-api --desired-count 0
   ```
   Wait for `runningCount` 0. Otherwise the task crash-loops on `prisma migrate deploy`
   against a database that refuses connections for the whole window — harmless but it buries
   the one start you want to read.
3. **Apply pending maintenance** (OS update, engine patch) now that nothing is connected, so
   the major upgrade is the only remaining variable: `aws rds describe-pending-maintenance-actions`,
   then `aws rds apply-pending-maintenance-action --resource-identifier <arn> --apply-action
   system-update --opt-in-type immediate` (and `db-upgrade`); `aws rds wait db-instance-available`.
4. **Upgrade**: the same `modify-db-instance … --engine-version 18.6
   --allow-major-version-upgrade --apply-immediately` as the rehearsal; poll. If the precheck
   fails the instance stays on the old version — read `pg_upgrade_precheck.log` via
   `aws rds describe-db-log-files` / `download-db-log-file-portion`.
5. **Checks + ANALYZE** from the one-off task: `pg-upgrade-checks.mjs --compare before.json`,
   REINDEX if it says so, then `ANALYZE VERBOSE;`.
6. **Scale back**: `--desired-count 1`, then `--min-capacity 1`. The single task start on the
   new engine is the smoke result: `runningCount` 1, `curl -fsS https://api.hooplings.com/health`
   reports `db: ok`, then sign in on a device and load Teams / Games / Stats.
7. `aws rds describe-db-instances … --query 'DBInstances[0].EngineVersion'` → `18.6`; the
   parameter group is now `default.postgres18`.
8. **Merge the PR**; `terraform plan` → No changes; close the issue with the measured timings.

**Rollback:** restore the pre-upgrade snapshot per Procedure A (including step 8's Terraform
reconcile) and repoint the secret; writes made after the upgrade are lost; a restored 18
instance cannot be downgraded in place. Do not merge the PR on that branch.

## Communication template

Replace the bracketed parts. Send via the most-active channel for users, plus
status page if/when one exists.

> **Subject:** Hooplings — temporary data issue, currently restoring
>
> Hi all — at approximately **[HH:MM TZ]** we identified that some data in
> Hooplings was incorrect / unreachable due to **[one-line
> description]**. We have stopped the cause and are restoring the database
> from this morning's automated backup, taken at **[backup timestamp]**.
>
> **What this means for you:**
> - Any games, events, or roster changes recorded between
>   **[backup time]** and **[incident time]** will need to be re-entered. We
>   know this is frustrating; we're sorry.
> - Profile pictures, team setup, and historical games before that window are
>   unaffected.
> - The app may be unavailable for the next **[~30 minutes]** while the
>   restore completes.
>
> We'll send a follow-up the moment service is restored, and a full write-up
> within 48 hours covering what happened and what we're changing so it doesn't
> happen again.
>
> — Hooplings team

## Drill log

Procedure A is only useful if it has been executed at least once against a
real snapshot. Run a drill against the latest dev/staging snapshot at least
quarterly and record the actual wall-clock here.

| Date (UTC) | Operator | Snapshot ID | New instance ID | Time-to-restore | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-06 | sdeasy (Claude Code session) | `rds:bball-tracker-production-postgres-2026-09-06-03-14` | `bball-tracker-production-postgres-drill-202609061747` | **5 min 57 s** to `available` (single-AZ `db.t3.micro`, 20 GB); migration applied in 10 s | First drill, run as the migration rehearsal for #497 (`TeamLineage` backfill, #462). Procedure A steps 1–4 only (no repoint); the migration ran from a one-off ECS task per the variant below. Before: 4 teams, no `lineageId`. After: 4 teams, 4 lineages, 0 nulls, unique index present. Instance deleted and throwaway task-definition revisions 271–273 deregistered afterwards. Closes #29. |
