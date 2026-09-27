# Hooplings - SES sending events: suppression, configuration set, SNS -> SQS (#449)
#
#   API ──SendEmail(ConfigurationSetName)──► SES
#                                             │  Bounce / Complaint / Delivery / Reject
#                                             ▼
#                                     SNS  ses-events
#                                             │  raw message delivery
#                                             ▼
#                                     SQS  ses-events ──(5 failed receives)──► ses-events-dlq
#                                             │  long poll, task role
#                                             ▼
#                     API  services/mailer/ses-event-consumer.ts ──► User.emailSuppressedAt
#
# What stops mail to a dead address is the ACCOUNT-LEVEL SUPPRESSION LIST, not
# the application: SES accepts a send to a suppressed address, never delivers
# it, and does not count it toward Reputation.BounceRate. Everything below the
# suppression list exists so a coach can be told which address bounced, and so
# an operator is told before AWS acts on the account.
#
# The alarms on these resources live in alerting.tf with every other alarm.
# Procedures: docs/runbooks/email-deliverability.md

# =============================================================================
# Account-level suppression list
# =============================================================================

# Accounts created after 2019-11-25 have this on by default, and this one did
# before it was declared here. It is declared anyway: a default is not a
# decision, and the deliverability answer to AWS (#23) rests on it.
resource "aws_sesv2_account_suppression_attributes" "main" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}

# =============================================================================
# Configuration set - what makes a send publish events
# =============================================================================

# ONE set for the account, not one per served domain: reputation and
# suppression are account-wide. The API names it on every send
# (SES_CONFIGURATION_SET in infra/task-definition.json); a send without it
# publishes nothing and its bounce is invisible.
resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "${local.name_prefix}-transactional"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Restated at the set level so the behaviour does not depend on the account
  # default staying what it is.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = {
    Name = "${local.name_prefix}-transactional"
  }
}

locals {
  # DELIVERY is what lets the recorded state heal: once an operator removes an
  # address from the suppression list, the next delivery clears the flag. It
  # costs one event per email sent. SEND / OPEN / CLICK are not published.
  ses_published_event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"]
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name
  event_destination_name = "sns-ses-events"

  event_destination {
    enabled              = true
    matching_event_types = local.ses_published_event_types

    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  # SES checks that it may publish when the destination is created.
  depends_on = [aws_sns_topic_policy.ses_events]
}

# =============================================================================
# SNS topic - machine-read, separate from the alerts topic on purpose
# =============================================================================

# NOT the alerts topic (alerting.tf). That one has a human subscribed by email;
# publishing here would send one raw JSON email per message the app sends.
# Not KMS-encrypted: SES cannot publish to a topic under the AWS-managed
# `alias/aws/sns` key, and messages only transit the topic - they rest in the
# queue, which is encrypted.
resource "aws_sns_topic" "ses_events" {
  name         = "${local.name_prefix}-ses-events"
  display_name = "Hooplings ${var.environment} SES sending events"

  tags = {
    Name = "${local.name_prefix}-ses-events"
  }
}

data "aws_iam_policy_document" "ses_events_topic" {
  statement {
    sid       = "AllowSesPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ses_events.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    # Confused-deputy guards: only this account's configuration set.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sesv2_configuration_set.transactional.arn]
    }
  }
}

resource "aws_sns_topic_policy" "ses_events" {
  arn    = aws_sns_topic.ses_events.arn
  policy = data.aws_iam_policy_document.ses_events_topic.json
}

# =============================================================================
# SQS queue + dead-letter queue
# =============================================================================

# A queue rather than an SNS -> HTTPS subscription to the API: the service is
# one task, so a webhook loses events during every deploy and outage once SNS
# gives up retrying, and it needs a public route plus signature verification.
# The queue keeps events for 14 days and needs no inbound surface.

resource "aws_sqs_queue" "ses_events_dlq" {
  name = "${local.name_prefix}-ses-events-dlq"

  # The maximum: a message here is waiting for a person.
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "${local.name_prefix}-ses-events-dlq"
  }
}

resource "aws_sqs_queue" "ses_events" {
  name = "${local.name_prefix}-ses-events"

  message_retention_seconds = 1209600

  # Long enough for a batch of 10 to be handled against a slow database before
  # any of it is redelivered; the handler's writes are idempotent either way.
  visibility_timeout_seconds = 60

  # Long polling by default, matching the consumer's own WaitTimeSeconds.
  receive_wait_time_seconds = 20

  # Events carry recipient addresses.
  sqs_managed_sse_enabled = true

  # The consumer never deletes a message it could not handle or parse, so a
  # poison message lands here intact after 5 receives instead of looping.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ses_events_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Name = "${local.name_prefix}-ses-events"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "ses_events_dlq" {
  queue_url = aws_sqs_queue.ses_events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ses_events.arn]
  })
}

data "aws_iam_policy_document" "ses_events_queue" {
  statement {
    sid       = "AllowSesEventsTopicSend"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ses_events.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.ses_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "ses_events" {
  queue_url = aws_sqs_queue.ses_events.id
  policy    = data.aws_iam_policy_document.ses_events_queue.json
}

resource "aws_sns_topic_subscription" "ses_events_queue" {
  topic_arn = aws_sns_topic.ses_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ses_events.arn

  # The queue message body is the SES event itself, not an SNS envelope. The
  # consumer unwraps an envelope anyway, so flipping this cannot break parsing.
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.ses_events]
}

# =============================================================================
# IAM - the API task consumes the queue
# =============================================================================

data "aws_iam_policy_document" "ses_events_consume" {
  statement {
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.ses_events.arn]
  }
}

resource "aws_iam_policy" "ses_events_consume" {
  name        = "${local.name_prefix}-ses-events-consume"
  description = "Allow ECS tasks to read SES sending events from the ses-events queue"
  policy      = data.aws_iam_policy_document.ses_events_consume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_ses_events" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ses_events_consume.arn
}
