# Runbooks index

As-built reference. Moved out of `CLAUDE.md` on 2026-09-30, when that file had grown to 170K characters; `CLAUDE.md` now keeps only the rules and a pointer here. Keep this file current in the same PR as the code it describes.

# Operations / Runbooks

Production incident and recurring-ops procedures live in [`docs/runbooks/`](../runbooks/):

- **[On-call](../runbooks/on-call.md)** — where production alerts go, what each alarm means and
  the first three things to check per alert class, plus the apply-time verification (confirm the
  SNS subscription, test publish, deliberately fail the uptime check). Alerting is declared in
  `infra/alerting.tf` (#448): one SNS topic with an email subscriber (`alert_email`, set only in
  the gitignored `terraform.tfvars`; `alerts@hooplings.com` since 2026-09-29, #555. To change
  it without a gap in delivery, subscribe and confirm the new address first: the runbook's
  "Changing the subscriber"), eleven CloudWatch alarms tuned for a **single-task**
  service plus four email alarms (#449), and a Route 53 HTTPS health check on
  `api.hooplings.com/health`. Every alarm sets
  `treat_missing_data` deliberately — `breaching` for liveness signals (a vanished task stops
  emitting), `notBreaching` for counters and utilization, `ignore` for the two SES rate alarms
  (SES reports a rate only around a send) — and thresholds are `alarm_*`
  variables, so tune in tfvars rather than editing a resource. `RunningTaskCount` is a
  Container Insights metric: turning `containerInsights` off in `ecs.tf` stops it and the
  task-count alarm fires permanently, so replace that alarm in the same change. Sentry
  alert rules and Datadog monitors are **not** in Terraform (no Datadog provider is configured).
  Two Sentry rules email the members of the Sentry organization, a different list from the SNS
  subscriber: "New issue in production" (#448) and Sentry's default high-priority rule. The
  owner's Sentry account routes them to `alerts@hooplings.com` as well (a setting of that
  account, #555). The
  runbook's "Sentry alert rules" section is their only record; update it with any change.
- **[Email deliverability](../runbooks/email-deliverability.md)** — how bounces and complaints
  are handled (#449), the first three things to check when `ses-bounce-rate` /
  `ses-complaint-rate` or the event-queue alarms fire, how to release an address a coach has
  confirmed is correct (remove it from the SES suppression list; the next delivery clears the
  roster flag, there is no database step), the apply order, the simulator-based verification,
  and the answers for the SES production-access request (#23). Declared in `infra/ses-events.tf`
  (suppression list, configuration set, SNS → SQS, dead-letter queue, consume policy) and
  `infra/alerting.tf`. **`SES_CONFIGURATION_SET` must never be deployed ahead of the
  `terraform apply` that creates the set and extends the send policy to its ARN** — every send
  would fail while invitations keep being created. `tests/infra/ses-events.test.ts` pins the two
  task-definition values to the Terraform names.
  **Mail that people read is a separate path (#555):** Google Workspace at the apex
  (`support@`, `privacy@`, `alerts@`, `dmarc@hooplings.com`), declared in `infra/workspace.tf`
  (MX, SPF + verification, DKIM `google._domainkey`, apex DMARC; applied 2026-09-29). SES stays
  on `mail.hooplings.com`. Never add SES to the apex SPF or Google to the `mail.` subdomain, and
  change the DMARC policy only through `local.dmarc_policy`, which both DMARC records read;
  `tests/infra/workspace-mail.test.ts` pins all three. A record added in the Route 53 console
  must be imported before Terraform can manage it (one-shot `import` block, deleted after the
  apply). The runbook's "Do not move" table lists the accounts that stay on an address outside
  the domain (AWS root, Workspace recovery, Apple ID, GitHub, Expo, the app's ADMIN login).
- **[Data-subject requests](../runbooks/data-subject-requests.md)** — account deletion (self-serve,
  guardian, operator script) and data export: what is removed, what is retained and why, the
  7-day backup window, identity verification for emailed requests, the WorkOS fallback, and the
  post-deletion checklist (admin-less leagues). The privacy policy (#25) must match its
  "Retention" section.
- **[RDS backup & restore](../runbooks/rds-backup-restore.md)** — verify automated backups, restore from snapshot, repoint the app via Secrets Manager, rollback path, and a user-facing comms template. The app reaches RDS via the endpoint baked into `bball-tracker-production/database-url` in Secrets Manager (not via Route53), so a restore is: new instance → new secret version → `--force-new-deployment` on the ECS service.
  Its **"Major version upgrade"** section is the procedure for PostgreSQL majors (#521, 15 → 18):
  a watched CLI `modify-db-instance` with the exact minor (a bare major resolves to the RDS
  *default* minor, and `apply_immediately` defaults to false in Terraform), ECS scaled to 0 for
  the window (lower the autoscaling minimum first), `backend/scripts/pg-upgrade-checks.mjs`
  before/after (prechecks, row counts, collation version), then the major-only pin in
  `infra/rds.tf` catches up with `terraform plan` = No changes. `backend/tests/infra/postgres-version.test.ts`
  pins that major to the compose and CI images and fails CI six months before RDS ends standard
  support for it (a deliberate dated assertion — the fix is the next upgrade, not a wider window).
