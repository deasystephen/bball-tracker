# Hooplings - Production alerting (#448)
#
# One SNS topic, one email subscriber, and a deliberately small set of
# CloudWatch alarms that publish to it. Everything here is tuned for a
# SINGLE-TASK service: the signals are absolute ("fewer than one task",
# "one unhealthy target"), never percentages of a fleet.
#
# Response procedure for every alarm below: docs/runbooks/on-call.md
#
# Rules this file follows - keep them when adding an alarm:
#
#   1. Every alarm sends BOTH `alarm_actions` and `ok_actions` to the topic, so
#      the inbox shows when an incident ended, not only when it started.
#   2. `treat_missing_data` is chosen per alarm and commented. A task that
#      vanishes stops emitting metrics, so for liveness signals (task count,
#      target health, uptime) missing data is `breaching`. For counters and
#      utilization, no data means "nothing happened" and is `notBreaching` -
#      the liveness alarms own the "it is gone" case, so an outage pages once
#      per real cause instead of once per metric.
#   3. Thresholds are variables with defaults (bottom of this file). Tune in
#      terraform.tfvars, never by editing a resource.
#   4. Do not add an alarm nobody can act on. Five alarms someone reads beat
#      twenty that get muted.
#
# Variables live in this file (same pattern as datadog.tf) rather than in
# variables.tf, so the alerting surface is readable in one place.

# =============================================================================
# SNS topic - where every alert goes
# =============================================================================

# Not KMS-encrypted on purpose: CloudWatch alarms cannot publish to a topic
# encrypted with the AWS-managed `alias/aws/sns` key (the key policy cannot be
# edited to admit cloudwatch.amazonaws.com), and a customer-managed key is a
# monthly cost plus a key policy to maintain for messages that contain alarm
# names and metric values, no user data.
resource "aws_sns_topic" "alerts" {
  name         = "${local.name_prefix}-alerts"
  display_name = "Hooplings ${var.environment} alerts"

  tags = {
    Name = "${local.name_prefix}-alerts"
  }
}

# Email subscription. AWS sends a confirmation message to the address; the
# subscription delivers NOTHING until the link in it is clicked
# (`PendingConfirmation`). Terraform cannot confirm it - see the apply steps in
# docs/runbooks/on-call.md. The address comes from the gitignored
# terraform.tfvars and is never committed.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  # AWS services allowed to publish to the alerts topic, each pinned to this
  # account and to a source-ARN pattern. To let another service publish, add
  # ONE entry here - the policy document below is generated from this map.
  #
  # Only things a person should read belong on this topic. SES sending events
  # (#449) are machine-read and have their own topic in ses-events.tf; what
  # reaches this one from email is the four alarms at the bottom of this file.
  alert_topic_publishers = {
    CloudWatchAlarms = {
      service    = "cloudwatch.amazonaws.com"
      source_arn = "arn:aws:cloudwatch:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:alarm:*"
    }
  }
}

data "aws_iam_policy_document" "alerts_topic" {
  dynamic "statement" {
    for_each = local.alert_topic_publishers

    content {
      sid       = "Allow${statement.key}Publish"
      effect    = "Allow"
      actions   = ["sns:Publish"]
      resources = [aws_sns_topic.alerts.arn]

      principals {
        type        = "Service"
        identifiers = [statement.value.service]
      }

      # Confused-deputy guards: only resources in this account may publish.
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = [statement.value.source_arn]
      }
    }
  }
}

# Principals in this account (an operator running `aws sns publish` for the
# test message) are authorized by their IAM identity policy; they need no
# statement here.
resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

locals {
  alert_actions = [aws_sns_topic.alerts.arn]

  alb_dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  alb_target_dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }

  ecs_service_dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app.name
  }

  rds_dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  # Approximate `max_connections` per instance class. RDS PostgreSQL computes
  # LEAST(DBInstanceClassMemory / 9531392, 5000), and DBInstanceClassMemory is
  # the instance RAM minus what the OS and RDS agents reserve, so the real
  # figure is below RAM / 9531392 (about 112 for 1 GiB). These are conservative
  # round-downs; check the live value with `SHOW max_connections;`. An unlisted
  # class falls back to the smallest figure, which errs toward alarming early.
  rds_max_connections_estimate = {
    "db.t3.micro"   = 80
    "db.t4g.micro"  = 80
    "db.t3.small"   = 160
    "db.t4g.small"  = 160
    "db.t3.medium"  = 340
    "db.t4g.medium" = 340
  }

  rds_connections_threshold = coalesce(
    var.alarm_rds_connections_threshold,
    floor(lookup(local.rds_max_connections_estimate, var.db_instance_class, 80) * 0.75),
  )

  uptime_check_fqdn = "api.${var.primary_domain}"
}

# =============================================================================
# Uptime - Route 53 health check from outside the VPC
# =============================================================================

# The only check that exercises the whole path a phone uses: public DNS, the
# ACM certificate, the ALB listener, the task and (because /health pings
# Postgres) the database. Every alarm further down watches one component from
# the inside; this one answers "can a user reach the API".
#
# Route 53 over Datadog/CloudWatch Synthetics: pure AWS, so no new provider and
# no new credentials, and it costs a couple of dollars a month instead of a
# canary's per-run pricing.
#
# /health is excluded from the request logger (IGNORED_PATHS), so the checkers
# add no log volume.
resource "aws_route53_health_check" "api" {
  type              = "HTTPS"
  fqdn              = local.uptime_check_fqdn
  port              = 443
  resource_path     = var.uptime_check_path
  request_interval  = 30
  failure_threshold = 3

  # Three regions is the minimum Route 53 accepts. The user base is in North
  # America, and fewer checker regions means fewer requests to a single task.
  regions = ["us-east-1", "us-west-1", "us-west-2"]

  tags = {
    Name = "${local.name_prefix}-api-uptime"
  }
}

resource "aws_cloudwatch_metric_alarm" "uptime" {
  alarm_name        = "${local.name_prefix}-api-uptime"
  alarm_description = "https://${local.uptime_check_fqdn}${var.uptime_check_path} is failing from outside AWS: users cannot reach the API. Runbook: docs/runbooks/on-call.md#api-is-down"

  namespace   = "AWS/Route53"
  metric_name = "HealthCheckStatus"
  dimensions = {
    HealthCheckId = aws_route53_health_check.api.id
  }

  # HealthCheckStatus is 1 when healthy, 0 when not. Minimum < 1 over two
  # consecutive minutes, on top of the health check's own 3 failed probes.
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 2

  # breaching: a health check that stops reporting is indistinguishable from an
  # outage, and silence must never read as "up".
  treat_missing_data = "breaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions

  lifecycle {
    # Route 53 publishes health-check metrics to us-east-1 only. An alarm
    # created in any other region would sit in INSUFFICIENT_DATA forever.
    precondition {
      condition     = var.aws_region == "us-east-1"
      error_message = "Route 53 health-check metrics exist only in us-east-1; the uptime alarm must be created there."
    }
  }
}

# =============================================================================
# ECS service - is the one task running, and is it starved
# =============================================================================

# RunningTaskCount is a Container Insights metric (namespace
# ECS/ContainerInsights), NOT a default AWS/ECS metric. It exists because the
# cluster in ecs.tf sets containerInsights = enabled. If that setting is ever
# turned off, this metric stops and the alarm fires (missing = breaching) -
# replace it with ALB HealthyHostCount < 1 in the same change.
resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  alarm_name        = "${local.name_prefix}-ecs-no-running-task"
  alarm_description = "The API service has no running task (or stopped reporting one). With a single task this is a full outage. Runbook: docs/runbooks/on-call.md#api-is-down"

  namespace   = "ECS/ContainerInsights"
  metric_name = "RunningTaskCount"
  dimensions  = local.ecs_service_dimensions

  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3

  # breaching: a service with zero tasks can stop emitting the metric entirely
  # rather than reporting 0, so missing data is the outage signal itself.
  treat_missing_data = "breaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  alarm_name        = "${local.name_prefix}-ecs-cpu-high"
  alarm_description = "API task CPU has been above ${var.alarm_ecs_cpu_percent}% for ${var.alarm_sustained_minutes} minutes. Runbook: docs/runbooks/on-call.md#api-is-slow-or-saturated"

  namespace   = "AWS/ECS"
  metric_name = "CPUUtilization"
  dimensions  = local.ecs_service_dimensions

  # Average, not Maximum: a task routinely touches ~100% for a few seconds at
  # start-up and during a deploy. Sustained load is the signal.
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_ecs_cpu_percent
  period              = 300
  evaluation_periods  = local.sustained_periods

  # notBreaching: no task means no CPU use. The running-task alarm owns the
  # "task is gone" case.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  alarm_name        = "${local.name_prefix}-ecs-memory-high"
  alarm_description = "API task memory has been above ${var.alarm_ecs_memory_percent}% for ${var.alarm_sustained_minutes} minutes; the next step is an OOM kill and a restart. Runbook: docs/runbooks/on-call.md#api-is-slow-or-saturated"

  namespace   = "AWS/ECS"
  metric_name = "MemoryUtilization"
  dimensions  = local.ecs_service_dimensions

  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_ecs_memory_percent
  period              = 300
  evaluation_periods  = local.sustained_periods

  # notBreaching: same reasoning as CPU.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# =============================================================================
# ALB - what users actually receive
# =============================================================================

# 5xx generated BY THE LOAD BALANCER: 502/503/504 when there is no healthy
# target, the target closed the connection, or it timed out. The application
# never saw these requests, so Sentry cannot report them.
resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name        = "${local.name_prefix}-alb-elb-5xx"
  alarm_description = "The load balancer itself returned more than ${var.alarm_5xx_count} 5xx responses in 5 minutes (no healthy target, or the target timed out). Runbook: docs/runbooks/on-call.md#api-is-returning-errors"

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_ELB_5XX_Count"
  dimensions  = local.alb_dimensions

  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_5xx_count
  period              = 300
  evaluation_periods  = 1

  # notBreaching: the metric is only emitted when a 5xx happens. No data means
  # no errors.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# 5xx returned BY THE APPLICATION. Both 5xx alarms are kept because they point
# at different first steps: ELB 5xx means "look at the task and target health",
# target 5xx means "look at Sentry and the logs". Sentry reports each error
# individually; this alarm is the volume signal, and it still works when the
# failure is in Sentry reporting itself.
resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name        = "${local.name_prefix}-alb-target-5xx"
  alarm_description = "The API returned more than ${var.alarm_5xx_count} 5xx responses in 5 minutes. Runbook: docs/runbooks/on-call.md#api-is-returning-errors"

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  dimensions  = local.alb_target_dimensions

  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_5xx_count
  period              = 300
  evaluation_periods  = 1

  # notBreaching: emitted only when a 5xx happens.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  alarm_name        = "${local.name_prefix}-alb-unhealthy-host"
  alarm_description = "The API target is failing its /health check (or no target is registered). /health pings Postgres, so this also fires when the database is unreachable. Runbook: docs/runbooks/on-call.md#api-is-down"

  namespace   = "AWS/ApplicationELB"
  metric_name = "UnHealthyHostCount"
  dimensions  = local.alb_target_dimensions

  # Three consecutive minutes, so a target that is slow to pass its first
  # health check during a deploy does not page.
  statistic           = "Maximum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3

  # breaching: the ALB reports this metric every minute while a target is
  # registered. It goes missing when the target group is empty, which for a
  # single-task service means nothing is serving.
  treat_missing_data = "breaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_response_time_p99" {
  alarm_name        = "${local.name_prefix}-alb-response-time-p99"
  alarm_description = "p99 API response time has been above ${var.alarm_response_time_p99_seconds}s for ${var.alarm_sustained_minutes} minutes. Runbook: docs/runbooks/on-call.md#api-is-slow-or-saturated"

  namespace   = "AWS/ApplicationELB"
  metric_name = "TargetResponseTime"
  dimensions  = local.alb_dimensions

  extended_statistic  = "p99"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_response_time_p99_seconds
  period              = 300
  evaluation_periods  = local.sustained_periods

  # notBreaching: no requests, no latency.
  treat_missing_data = "notBreaching"

  # `evaluate`, deliberately. With `ignore`, CloudWatch skips any period with
  # fewer than 10 / (1 - 0.99) = 1000 samples, and this service does not see
  # 1000 requests in 5 minutes - the alarm would never evaluate. The cost is
  # that at low traffic p99 is close to the slowest single request, which is
  # why the alarm needs every period in the window to breach.
  evaluate_low_sample_count_percentiles = "evaluate"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# =============================================================================
# RDS - the failures that are slow to arrive and expensive to discover late
# =============================================================================
#
# All three are notBreaching on missing data: an unreachable database already
# fails /health, which trips the uptime and unhealthy-host alarms. A gap in RDS
# metrics (failover, maintenance window) is not evidence of a full disk.

resource "aws_cloudwatch_metric_alarm" "rds_free_storage_low" {
  alarm_name        = "${local.name_prefix}-rds-free-storage-low"
  alarm_description = "RDS free storage is below ${var.alarm_rds_free_storage_gib} GiB. Storage autoscaling should already have grown the volume at this level; if this stays in ALARM it has not. A full disk stops all writes. Runbook: docs/runbooks/on-call.md#database"

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions  = local.rds_dimensions

  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = var.alarm_rds_free_storage_gib * 1024 * 1024 * 1024
  period              = 300
  evaluation_periods  = local.sustained_periods

  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name        = "${local.name_prefix}-rds-connections-high"
  alarm_description = "RDS has more than ${local.rds_connections_threshold} open connections (about 75% of max_connections for ${var.db_instance_class}). At the limit every new connection is refused. Runbook: docs/runbooks/on-call.md#database"

  namespace   = "AWS/RDS"
  metric_name = "DatabaseConnections"
  dimensions  = local.rds_dimensions

  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.rds_connections_threshold
  period              = 300
  evaluation_periods  = 2

  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name        = "${local.name_prefix}-rds-cpu-high"
  alarm_description = "RDS CPU has been above ${var.alarm_rds_cpu_percent}% for ${var.alarm_sustained_minutes} minutes. On a burstable (t3/t4g) class sustained CPU also drains the credit balance. Runbook: docs/runbooks/on-call.md#database"

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  dimensions  = local.rds_dimensions

  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_rds_cpu_percent
  period              = 300
  evaluation_periods  = local.sustained_periods

  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# =============================================================================
# Email - sender reputation, and the pipeline that records bounces (#449)
# =============================================================================
#
# AWS puts an account under review at a 5% bounce rate or a 0.1% complaint
# rate, and pauses sending at 10% / 0.5%. The thresholds below are set under
# the review line so the email arrives while there is still room to act. The
# metrics are account-wide (no dimensions), which is the level AWS enforces at.
#
# `ignore` on missing data, unlike every other alarm in this file, and on
# purpose: SES publishes a reputation datapoint only around a send, so silence
# is the normal state. A rate does not improve because sending stopped -
# `notBreaching` would turn a real ALARM back to OK at the first quiet hour.
# The cost is that a fresh alarm sits in INSUFFICIENT_DATA until the first
# send after apply.

resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name        = "${local.name_prefix}-ses-bounce-rate"
  alarm_description = "SES account bounce rate is above ${var.alarm_ses_bounce_rate_percent}%. AWS reviews the account at 5% and pauses sending at 10%. Runbook: docs/runbooks/email-deliverability.md#bounce-or-complaint-rate-alarm"

  namespace   = "AWS/SES"
  metric_name = "Reputation.BounceRate"

  # The metric is a fraction (0.03 = 3%).
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_ses_bounce_rate_percent / 100
  period              = 3600
  evaluation_periods  = 1

  treat_missing_data = "ignore"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name        = "${local.name_prefix}-ses-complaint-rate"
  alarm_description = "SES account complaint rate is above ${var.alarm_ses_complaint_rate_percent}%. AWS reviews the account at 0.1% and pauses sending at 0.5%. Runbook: docs/runbooks/email-deliverability.md#bounce-or-complaint-rate-alarm"

  namespace   = "AWS/SES"
  metric_name = "Reputation.ComplaintRate"

  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_ses_complaint_rate_percent / 100
  period              = 3600
  evaluation_periods  = 1

  treat_missing_data = "ignore"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# The API stopped reading SES events: the consumer is not running (the task
# has no SES_EVENTS_QUEUE_URL, or lost sqs:ReceiveMessage), or every message
# fails. Nothing is lost - the queue keeps 14 days - but no bounce reaches a
# roster until it is fixed.
resource "aws_cloudwatch_metric_alarm" "ses_events_queue_stalled" {
  alarm_name        = "${local.name_prefix}-ses-events-queue-stalled"
  alarm_description = "The oldest SES event has waited more than ${var.alarm_ses_events_queue_age_minutes} minutes: the API is not consuming the ses-events queue, so bounces are not reaching rosters. Runbook: docs/runbooks/email-deliverability.md#events-are-not-being-processed"

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions = {
    QueueName = aws_sqs_queue.ses_events.name
  }

  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_ses_events_queue_age_minutes * 60
  period              = 300
  evaluation_periods  = 1

  # notBreaching: SQS stops reporting for a queue with no activity, and an
  # empty, idle queue has no oldest message.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# A message the consumer could not handle or parse five times in a row. It
# stays in ALARM until someone reads the message and empties the queue, which
# is the point.
resource "aws_cloudwatch_metric_alarm" "ses_events_dlq" {
  alarm_name        = "${local.name_prefix}-ses-events-dlq-not-empty"
  alarm_description = "An SES event could not be processed after 5 attempts and is in the dead-letter queue. Runbook: docs/runbooks/email-deliverability.md#events-are-not-being-processed"

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.ses_events_dlq.name
  }

  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1

  # notBreaching: an idle queue stops reporting; no data means nothing is in it.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
}

# =============================================================================
# Variables
# =============================================================================

variable "alert_email" {
  description = "Email address subscribed to the alerts SNS topic. Required, no default: set it in the gitignored terraform.tfvars, never in a committed file. AWS emails a confirmation link to this address after apply; nothing is delivered until it is clicked."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "uptime_check_path" {
  description = "Path the Route 53 uptime check requests on api.<primary_domain>. Set it to a path that 404s (for example /bogus-uptime-test) for one apply to prove the alarm reaches the inbox, then remove the override."
  type        = string
  default     = "/health"

  validation {
    condition     = startswith(var.uptime_check_path, "/")
    error_message = "uptime_check_path must start with a slash."
  }
}

variable "alarm_sustained_minutes" {
  description = "How long a utilization or latency metric must stay over its threshold before alarming. Multiple of 5."
  type        = number
  default     = 15

  validation {
    condition     = var.alarm_sustained_minutes >= 5 && var.alarm_sustained_minutes % 5 == 0
    error_message = "alarm_sustained_minutes must be a multiple of 5, at least 5."
  }
}

variable "alarm_5xx_count" {
  description = "5xx responses in a 5-minute window above which the ELB and target 5xx alarms fire."
  type        = number
  default     = 5
}

variable "alarm_response_time_p99_seconds" {
  description = "p99 ALB target response time, in seconds, above which the latency alarm fires once sustained. The mobile client times out at 10s."
  type        = number
  default     = 3
}

variable "alarm_ecs_cpu_percent" {
  description = "ECS service average CPU utilization (%) above which the CPU alarm fires once sustained. Auto-scaling targets 70%."
  type        = number
  default     = 85
}

variable "alarm_ecs_memory_percent" {
  description = "ECS service average memory utilization (%) above which the memory alarm fires once sustained."
  type        = number
  default     = 85
}

variable "alarm_rds_free_storage_gib" {
  description = "RDS free storage, in GiB, below which the storage alarm fires. The default is 10% of the 20 GiB allocation, the level at which RDS storage autoscaling acts."
  type        = number
  default     = 2
}

variable "alarm_rds_connections_threshold" {
  description = "Open RDS connections above which the connections alarm fires. Null derives 75% of the estimated max_connections for var.db_instance_class."
  type        = number
  default     = null
}

variable "alarm_rds_cpu_percent" {
  description = "RDS average CPU utilization (%) above which the CPU alarm fires once sustained."
  type        = number
  default     = 80
}

variable "alarm_ses_bounce_rate_percent" {
  description = "SES account bounce rate (%) above which the bounce-rate alarm fires. AWS places the account under review at 5% and pauses sending at 10%."
  type        = number
  default     = 3

  validation {
    condition     = var.alarm_ses_bounce_rate_percent > 0 && var.alarm_ses_bounce_rate_percent < 5
    error_message = "alarm_ses_bounce_rate_percent must be above 0 and below 5, the rate at which AWS reviews the account: an alarm at or over it fires too late."
  }
}

variable "alarm_ses_complaint_rate_percent" {
  description = "SES account complaint rate (%) above which the complaint-rate alarm fires. AWS places the account under review at 0.1% and pauses sending at 0.5%. The default sits at the review line because one complaint in a small sending volume already exceeds any lower figure."
  type        = number
  default     = 0.1

  validation {
    condition     = var.alarm_ses_complaint_rate_percent > 0 && var.alarm_ses_complaint_rate_percent < 0.5
    error_message = "alarm_ses_complaint_rate_percent must be above 0 and below 0.5, the rate at which AWS pauses sending."
  }
}

variable "alarm_ses_events_queue_age_minutes" {
  description = "Age of the oldest unprocessed SES event, in minutes, above which the queue-stalled alarm fires. A message that keeps failing reaches the dead-letter queue in about 5 minutes, so anything older means nothing is consuming."
  type        = number
  default     = 15

  validation {
    condition     = var.alarm_ses_events_queue_age_minutes >= 10
    error_message = "alarm_ses_events_queue_age_minutes must be at least 10: below that a message on its way to the dead-letter queue trips the alarm."
  }
}

locals {
  # 5-minute periods in the sustained window.
  sustained_periods = var.alarm_sustained_minutes / 5
}
