# RDS Backup & Restore Runbook

Operational procedure for backing up and restoring the production RDS PostgreSQL
instance. Required reading before any data-loss incident response.

> **Out of scope:** point-in-time recovery (PITR), cross-region disaster
> recovery, logical (`pg_dump`) backups. Tracked separately if/when needed.

## At a glance

| Item | Value |
| --- | --- |
| Instance identifier | `bball-tracker-production-postgres` |
| Engine | PostgreSQL 15.15 |
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
| Public DNS | App reaches RDS via the **endpoint string baked into the secret**, not via Route53. The `api.capyhoops.com` Route53 record points at the ALB, not the database. |

All of the above is enforced by Terraform in `infra/rds.tf` and `infra/ecs.tf`.
Do not hand-edit the instance in the AWS console.

## Verifying backups (do this monthly)

```bash
aws rds describe-db-instances \
  --db-instance-identifier bball-tracker-production-postgres \
  --query 'DBInstances[0].{Retention:BackupRetentionPeriod,Window:PreferredBackupWindow,Latest:LatestRestorableTime}'
```

Expect `Retention: 7`, a recent `Latest` (within the last few minutes), and the
configured backup window. If retention is below 7 or `Latest` is stale by more
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
   curl -fsS https://api.capyhoops.com/health
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

## Communication template

Replace the bracketed parts. Send via the most-active channel for users, plus
status page if/when one exists.

> **Subject:** Basketball Tracker — temporary data issue, currently restoring
>
> Hi all — at approximately **[HH:MM TZ]** we identified that some data in
> Basketball Tracker was incorrect / unreachable due to **[one-line
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
> — Basketball Tracker team

## Drill log

Procedure A is only useful if it has been executed at least once against a
real snapshot. Run a drill against the latest dev/staging snapshot at least
quarterly and record the actual wall-clock here.

| Date (UTC) | Operator | Snapshot ID | New instance ID | Time-to-restore | Notes |
| --- | --- | --- | --- | --- | --- |
| _pending_ | | | | | First drill — see issue #29 acceptance criteria |
