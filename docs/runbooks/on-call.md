# On-call Runbook

Where production alerts go, what each one means, and the first three things to check.
Everything here is declared in [`infra/alerting.tf`](../../infra/alerting.tf) (#448) — do not
create or edit alarms in the AWS console. The four email alarms (#449) are declared there too;
their procedures are in the [email deliverability runbook](email-deliverability.md).

## At a glance

| Item | Value |
| --- | --- |
| Alert destination | SNS topic `bball-tracker-production-alerts` (`terraform output alerts_topic_arn`) |
| Subscriber | One email address, set as `alert_email` in the gitignored `infra/terraform.tfvars`. It is deliberately not recorded in the repo. |
| Who responds | Whoever owns that inbox. There is no rotation and no escalation path: one responder, best effort. |
| What arrives | One email when an alarm enters `ALARM`, one when it returns to `OK`. The subject carries the alarm name. |
| Region | `us-east-1` (Route 53 health-check metrics exist only there) |
| API | `https://api.hooplings.com` — health endpoint `/health` (pings Postgres; 503 when the DB is unreachable) |
| ECS | cluster `bball-tracker-production-cluster`, service `bball-tracker-production-api`, **one task by design** |
| RDS | `bball-tracker-production-postgres` |
| Logs | Datadog, **US5** site (`us5.datadoghq.com`), query `service:bball-tracker-api` |
| Errors | Sentry org `satsun-ventures`, projects `bball-tracker-backend` and `bball-tracker-mobile` |
| Error emails | Two Sentry alert rules, see [Sentry alert rules](#sentry-alert-rules). They go to the members of the Sentry organization, **not** to the SNS subscriber above. |

Because the service runs a single task, there is no redundancy to absorb a failure: "one task is
unhealthy" and "the API is down" are the same event.

## The alarms

Alarm names are prefixed `bball-tracker-production-`. Thresholds are the defaults of the `alarm_*`
variables in `infra/alerting.tf`; tune them in `terraform.tfvars`, never by editing a resource.

| Alarm | Fires when | No data counts as | Section |
| --- | --- | --- | --- |
| `api-uptime` | Route 53 cannot get a 2xx/3xx from `https://api.hooplings.com/health` for 2 min | failing | [API is down](#api-is-down) |
| `ecs-no-running-task` | Running task count < 1 for 3 min | failing | [API is down](#api-is-down) |
| `alb-unhealthy-host` | The target fails its health check for 3 min, or no target is registered | failing | [API is down](#api-is-down) |
| `alb-elb-5xx` | The load balancer itself returned > 5 5xx in 5 min | fine | [API is returning errors](#api-is-returning-errors) |
| `alb-target-5xx` | The application returned > 5 5xx in 5 min | fine | [API is returning errors](#api-is-returning-errors) |
| `alb-response-time-p99` | p99 response time > 3 s for 15 min | fine | [API is slow or saturated](#api-is-slow-or-saturated) |
| `ecs-cpu-high` | Task CPU > 85% average for 15 min | fine | [API is slow or saturated](#api-is-slow-or-saturated) |
| `ecs-memory-high` | Task memory > 85% average for 15 min | fine | [API is slow or saturated](#api-is-slow-or-saturated) |
| `rds-free-storage-low` | Free storage < 2 GiB for 15 min | fine | [Database](#database) |
| `rds-connections-high` | > 60 open connections for 10 min (about 75% of the `db.t3.micro` limit) | fine | [Database](#database) |
| `rds-cpu-high` | RDS CPU > 80% average for 15 min | fine | [Database](#database) |
| `ses-bounce-rate` | SES account bounce rate > 3% (AWS reviews the account at 5%) | unchanged | [Email deliverability](email-deliverability.md#bounce-or-complaint-rate-alarm) |
| `ses-complaint-rate` | SES account complaint rate > 0.1% | unchanged | [Email deliverability](email-deliverability.md#bounce-or-complaint-rate-alarm) |
| `ses-events-queue-stalled` | The oldest SES event has waited > 15 min: the API is not reading the queue | fine | [Email deliverability](email-deliverability.md#events-are-not-being-processed) |
| `ses-events-dlq-not-empty` | An SES event failed 5 times and is in the dead-letter queue | fine | [Email deliverability](email-deliverability.md#events-are-not-being-processed) |

"No data counts as failing" is deliberate: a task that vanishes stops emitting metrics, so silence
on a liveness signal must never read as healthy. Counters and utilization treat silence as fine,
so a real outage pages once per cause instead of once per metric. The two SES rate alarms keep
their state on no data ("unchanged"): SES reports a rate only around a send, and a rate does not
improve because sending stopped.

Expect several emails for one incident. A crashed task trips `ecs-no-running-task`,
`alb-unhealthy-host`, `api-uptime` and usually `alb-elb-5xx` within a few minutes of each other.

## API is down

`api-uptime`, `ecs-no-running-task`, `alb-unhealthy-host`

1. **Confirm from outside.** A 503 with `"db":"down"` means the task is running and the database
   is not reachable — go to [Database](#database). No response at all means the task or the ALB.
   ```bash
   curl -sS -m 10 -w '\n%{http_code}\n' https://api.hooplings.com/health
   ```
2. **Look at the service and its recent events.** `runningCount` 0 with events that repeat
   "unable to place" or "stopped" is a crash loop; a deployment stuck `IN_PROGRESS` is a bad
   rollout (the circuit breaker rolls it back on its own — check the **Build & Deploy to ECS**
   job in GitHub Actions for the failing commit).
   ```bash
   aws ecs describe-services --cluster bball-tracker-production-cluster \
     --services bball-tracker-production-api \
     --query 'services[0].{running:runningCount,desired:desiredCount,deployments:deployments[].{status:status,rollout:rolloutState,taskDef:taskDefinition},events:events[:5].message}'
   ```
3. **Read why the last task stopped.** `stoppedReason` and the container `exitCode` / `reason`
   separate an OOM kill (`OutOfMemoryError`), a failed health check, and an application crash at
   start-up (a failed `prisma migrate deploy` exits before the server listens).
   ```bash
   TASK=$(aws ecs list-tasks --cluster bball-tracker-production-cluster \
     --service-name bball-tracker-production-api --desired-status STOPPED \
     --query 'taskArns[0]' --output text)
   aws ecs describe-tasks --cluster bball-tracker-production-cluster --tasks "$TASK" \
     --query 'tasks[0].{stopped:stoppedReason,containers:containers[].{name:name,exit:exitCode,reason:reason}}'
   ```
   Then read the task's last log lines in Datadog (`service:bball-tracker-api status:error`) or
   directly: `aws logs tail /ecs/bball-tracker-production --since 30m`.

To restart a task that is running but wedged:
`aws ecs update-service --cluster bball-tracker-production-cluster --service bball-tracker-production-api --force-new-deployment`.

## API is returning errors

`alb-elb-5xx`, `alb-target-5xx`

The two alarms point at different places. **ELB 5xx** are generated by the load balancer (502,
503, 504): the application never saw the request, so Sentry has nothing. **Target 5xx** are
responses the application itself produced.

1. **Which one fired?** ELB 5xx together with an [API is down](#api-is-down) alarm is the same
   incident — work that section. ELB 5xx alone usually means requests exceeding the ALB's idle
   timeout (504) or the task closing connections while restarting (502).
2. **Target 5xx: open Sentry**, project `bball-tracker-backend`, environment `production`, sorted
   by last seen. Expected client errors (4xx) are filtered out before they reach Sentry, so what
   is there is a real defect. Check whether the first event lines up with a deploy.
3. **Read the failing requests in Datadog** (US5): `service:bball-tracker-api status:error`, then
   narrow by path. If the errors started with a deploy, revert the commit on `main`; the merge
   redeploys the previous behaviour.

## API is slow or saturated

`alb-response-time-p99`, `ecs-cpu-high`, `ecs-memory-high`

1. **Is it load or a leak?** Compare request volume with CPU and memory over the last few hours
   (CloudWatch → ECS service metrics, ALB `RequestCount`). Memory that climbs steadily with flat
   traffic is a leak; a restart buys time (`--force-new-deployment`, above) while it is found.
2. **Is the database the slow part?** Check `rds-cpu-high` / `rds-connections-high` and
   Performance Insights for the instance. Slow queries show up as slow requests first.
3. **Find the slow endpoints.** Datadog `service:bball-tracker-api`, sort by duration. Invite and
   guardian-invite routes await an SES send bounded at 5 s, so a degraded SES shows up as slow
   invites, not as errors.

At this traffic level p99 is close to the slowest single request in the window, which is why the
alarm needs three consecutive 5-minute periods over the threshold. Do not scale the service out
as a remedy: Socket.io runs on an in-memory adapter and is single-replica only (#26).

## Database

`rds-free-storage-low`, `rds-connections-high`, `rds-cpu-high`

1. **Check the instance state and storage.** Storage autoscaling grows the volume (20 → 100 GiB
   maximum) when free space drops below 10%; this alarm staying in `ALARM` means it has not —
   the volume is at its maximum, or it was resized within the last 6 hours.
   ```bash
   aws rds describe-db-instances --db-instance-identifier bball-tracker-production-postgres \
     --query 'DBInstances[0].{status:DBInstanceStatus,allocatedGiB:AllocatedStorage,maxGiB:MaxAllocatedStorage,class:DBInstanceClass,pending:PendingModifiedValues}'
   ```
2. **Connections: count the tasks.** One task holds a small pool (the two-week peak before these
   alarms existed was 9). Dozens of connections means more tasks than intended are running, or
   an operator session or script was left open. Confirm `runningCount` with the
   `describe-services` command above.
3. **CPU: open Performance Insights** for the instance and look at top SQL. `db.t3.micro` is
   burstable — sustained CPU also drains the credit balance (`CPUCreditBalance`), after which the
   instance is throttled and everything slows at once.

Restoring from a snapshot, repointing the app and major-version upgrades are in
[RDS backup & restore](rds-backup-restore.md).

## Applying and verifying (one-time, and after any change)

Terraform is applied by hand from `infra/` — **apply first, then merge**. Merging any
non-markdown file under `infra/` also triggers a full ECS deploy, which applies none of the
Terraform change.

1. **Set the subscriber** in `infra/terraform.tfvars` (gitignored): `alert_email = "<address>"`.
2. **Plan and apply.** The plan must show only additions: the topic, its policy and
   subscription, the health check and the alarms (fifteen: eleven from #448, four email alarms
   from #449).
   ```bash
   cd infra && terraform plan -out alerting.tfplan && terraform apply alerting.tfplan
   ```
3. **Confirm the subscription.** AWS emails "AWS Notification - Subscription Confirmation" to
   the address; click the link. Until then nothing is delivered. This must not read
   `PendingConfirmation`:
   ```bash
   aws sns list-subscriptions-by-topic --topic-arn "$(terraform output -raw alerts_topic_arn)" \
     --query 'Subscriptions[].SubscriptionArn'
   ```
4. **Test publish** and confirm it reaches the inbox:
   ```bash
   aws sns publish --topic-arn "$(terraform output -raw alerts_topic_arn)" \
     --subject "Hooplings alerting test" --message "Test publish from the on-call runbook."
   ```
5. **Fail the uptime check once on purpose.** Point it at a path that 404s, apply, and wait for
   the `api-uptime` ALARM email (about 3–5 minutes). Then apply again without the override and
   wait for the OK email.
   ```bash
   terraform apply -var 'uptime_check_path=/bogus-uptime-test'
   # ALARM email arrives
   terraform apply
   # OK email arrives
   ```
6. **Check every alarm settled.** Nothing should be left in `ALARM` or `INSUFFICIENT_DATA`
   (except `ses-bounce-rate` and `ses-complaint-rate`, which read `INSUFFICIENT_DATA` until the
   first email is sent after they are created):
   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix bball-tracker-production- \
     --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
   ```

## Sentry alert rules

CloudWatch tells you the service is down or slow. Sentry tells you the code threw. Two rules
send email; both cover `bball-tracker-backend` and `bball-tracker-mobile`.

| Rule | Fires when | Environment | Created |
| --- | --- | --- | --- |
| **New issue in production** (id `6086584`) | An issue is seen for the first time | `production` only | 2026-09-29, for #448 |
| **Send a notification for high priority issues** (id `3278785`) | A new or existing issue that Sentry ranks high priority | Any | 2026-04-13, Sentry's default |

- **Who gets the email:** the owners of the issue, and when it has none, every active member of
  the Sentry organization. Add a responder by inviting them to the organization. This is a
  different list from the SNS subscriber: changing `alert_email` does not change it.
- **A new high-priority issue sends two emails**, one per rule. That is accepted: the rules
  overlap on purpose, so that a low-priority new issue is not silent and a known issue that
  becomes urgent is not either.
- **"New issue in production" sends at most one email per issue every 30 minutes**, and an issue
  is new only once, so it does not repeat for an error that keeps happening. A resolved issue
  that comes back is a *regression*, which this rule does not cover; the high-priority rule
  does when Sentry ranks it so.
- **Both projects report `production`** as their environment: the API through
  `SENTRY_ENVIRONMENT` in `infra/task-definition.json`, the app through the EAS `production`
  environment. An event from a preview build or a simulator carries another name and does not
  trigger the first rule.
- **Expected client errors never reach Sentry** (4xx `AppError`s are filtered in
  `utils/sentry.ts`), so neither rule fires for an expired token or a validation error.
- **Not proven by a real event.** The rule was read back after it was created and is enabled,
  but no new issue has occurred in production since. Its first email is the proof; check
  "Last triggered" on the rule's page.

The rules live in Sentry, not in this repository. They were created through Sentry's API; to
change one, edit it in Sentry (Alerts) and update the table above in the same change.

## Not yet automated

One item from #448 lives outside Terraform and is done by hand. Its status is tracked on the
issue, not here.

- **The seven placeholder Datadog monitors.** The default host-monitor pack (CPU, load, disk,
  memory, network) queries `system.*` host metrics that Fargate never emits, so all seven sit in
  "No Data", and each notifies the literal placeholder `@your-team-handle`. Delete or retarget
  them. No Datadog Terraform provider is configured — `infra/datadog.tf` only ships logs.

Also not covered by any alarm today: a failed automated RDS backup, and Redis memory or
evictions (the cache is best-effort and fails open).
