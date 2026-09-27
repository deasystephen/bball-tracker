# On-call Runbook

Where production alerts go, what each one means, and the first three things to check.
Everything here is declared in [`infra/alerting.tf`](../../infra/alerting.tf) (#448) — do not
create or edit alarms in the AWS console.

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

"No data counts as failing" is deliberate: a task that vanishes stops emitting metrics, so silence
on a liveness signal must never read as healthy. Counters and utilization treat silence as fine,
so a real outage pages once per cause instead of once per metric.

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
   subscription, the health check and eleven alarms.
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
6. **Check every alarm settled.** Nothing should be left in `ALARM` or `INSUFFICIENT_DATA`:
   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix bball-tracker-production- \
     --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
   ```

## Not yet automated

Two items from #448 live outside Terraform and are done by hand. Their status is tracked on the
issue, not here.

- **Sentry issue alerts.** One rule per project (`bball-tracker-backend`,
  `bball-tracker-mobile`): a new issue is created in environment `production` → email. Sentry
  alert rules are not version-controlled in this repo.
- **The seven placeholder Datadog monitors.** The default host-monitor pack (CPU, load, disk,
  memory, network) queries `system.*` host metrics that Fargate never emits, so all seven sit in
  "No Data", and each notifies the literal placeholder `@your-team-handle`. Delete or retarget
  them. No Datadog Terraform provider is configured — `infra/datadog.tf` only ships logs.

Also not covered by any alarm today: a failed automated RDS backup, Redis memory or evictions
(the cache is best-effort and fails open), and SES bounce or complaint rates (#449, which reuses
this SNS topic).
