# =============================================================================
# Datadog Forwarder - Ships CloudWatch logs to Datadog
# =============================================================================
# Deploys the official Datadog Forwarder Lambda via CloudFormation and
# subscribes it to two ECS log groups: the API's (every line) and the web
# site's (our JSON lines only, #966). All resources are gated behind the
# datadog_api_key variable so they are only created when a key is provided.
# =============================================================================

variable "datadog_api_key" {
  description = "Datadog API key. Leave empty to disable Datadog integration."
  type        = string
  sensitive   = true
  default     = ""
}

variable "datadog_site" {
  description = "Datadog site to send data to."
  type        = string
  default     = "datadoghq.com"
}

# -----------------------------------------------------------------------------
# Secrets Manager - Store the Datadog API key
# -----------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "datadog_api_key" {
  count       = var.datadog_api_key != "" ? 1 : 0
  name        = "${local.name_prefix}-datadog-api-key"
  description = "Datadog API key for the Forwarder Lambda"
}

resource "aws_secretsmanager_secret_version" "datadog_api_key" {
  count         = var.datadog_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.datadog_api_key[0].id
  secret_string = var.datadog_api_key
}

# -----------------------------------------------------------------------------
# Datadog Forwarder Lambda via CloudFormation
# -----------------------------------------------------------------------------

locals {
  # The forwarder version the stack runs. Pinned (#966): with `latest.yaml`,
  # any parameter change re-reads the template and silently upgrades the
  # Lambda (5.2.2 was installed from `latest` on 2026-02-15; `latest` had moved
  # to 5.4.17 by 2026-10-24). Upgrade by changing this in a PR of its own and
  # reading the forwarder's release notes first.
  datadog_forwarder_version = "5.2.2"

  datadog_forwarder_name = "${local.name_prefix}-datadog-forwarder"

  # Built from the function name (the stack's FunctionName parameter), not
  # read from the stack's outputs: Terraform marks every output unknown while
  # the stack updates, which would force-replace each subscription filter and
  # permission below on any stack change and drop log lines in the gap.
  datadog_forwarder_arn = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.datadog_forwarder_name}"
}

resource "aws_cloudformation_stack" "datadog_forwarder" {
  count        = var.datadog_api_key != "" ? 1 : 0
  name         = "${local.name_prefix}-datadog-forwarder"
  capabilities = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"]
  template_url = "https://datadog-cloudformation-template.s3.amazonaws.com/aws/forwarder/${local.datadog_forwarder_version}.yaml"

  parameters = {
    DdApiKeySecretArn = aws_secretsmanager_secret.datadog_api_key[0].arn
    DdSite            = var.datadog_site
    FunctionName      = local.datadog_forwarder_name
    # Every forwarded line is tagged env:<environment> (#966), so Datadog's
    # env facet is set on the API's and the web site's lines alike; the
    # deployed commit is the `commit` attribute each logger writes.
    DdTags = "env:${var.environment}"
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Subscription - Forward ECS logs to Datadog
# -----------------------------------------------------------------------------

resource "aws_lambda_permission" "allow_cloudwatch" {
  count         = var.datadog_api_key != "" ? 1 : 0
  statement_id  = "AllowCloudWatchInvoke"
  action        = "lambda:InvokeFunction"
  function_name = local.datadog_forwarder_arn
  principal     = "logs.amazonaws.com"
  source_arn    = "${aws_cloudwatch_log_group.app.arn}:*"

  # The ARN is a string built from the name, so the ordering is declared.
  depends_on = [aws_cloudformation_stack.datadog_forwarder]
}

resource "aws_cloudwatch_log_subscription_filter" "datadog" {
  count           = var.datadog_api_key != "" ? 1 : 0
  name            = "${local.name_prefix}-datadog-forwarder"
  log_group_name  = aws_cloudwatch_log_group.app.name
  filter_pattern  = ""
  destination_arn = local.datadog_forwarder_arn

  depends_on = [aws_lambda_permission.allow_cloudwatch]
}

# -----------------------------------------------------------------------------
# The web site's log group (#966)
# -----------------------------------------------------------------------------
# Only the JSON lines web/lib/log.ts writes are forwarded: the filter matches
# `service = "bball-tracker-web"`, so Next.js's own free-text output (startup
# lines and its error dumps, which could one day quote a URL carrying an
# invitation token) stays in CloudWatch. The site's logger masks invitation
# tokens in every value it writes, and its request-error line names the route
# pattern, never the path. backend/tests/infra/datadog-forwarding.test.ts pins
# the filter to the logger's service name.

resource "aws_lambda_permission" "allow_cloudwatch_web" {
  count         = var.datadog_api_key != "" ? 1 : 0
  statement_id  = "AllowCloudWatchInvokeWeb"
  action        = "lambda:InvokeFunction"
  function_name = local.datadog_forwarder_arn
  principal     = "logs.amazonaws.com"
  source_arn    = "${aws_cloudwatch_log_group.web.arn}:*"

  # The ARN is a string built from the name, so the ordering is declared.
  depends_on = [aws_cloudformation_stack.datadog_forwarder]
}

resource "aws_cloudwatch_log_subscription_filter" "datadog_web" {
  count           = var.datadog_api_key != "" ? 1 : 0
  name            = "${local.name_prefix}-web-datadog-forwarder"
  log_group_name  = aws_cloudwatch_log_group.web.name
  filter_pattern  = "{ $.service = \"bball-tracker-web\" }"
  destination_arn = local.datadog_forwarder_arn

  depends_on = [aws_lambda_permission.allow_cloudwatch_web]
}
