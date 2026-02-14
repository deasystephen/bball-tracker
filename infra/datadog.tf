# =============================================================================
# Datadog Forwarder - Ships CloudWatch logs to Datadog
# =============================================================================
# Deploys the official Datadog Forwarder Lambda via CloudFormation and
# subscribes it to the ECS application log group. All resources are gated
# behind the datadog_api_key variable so they are only created when a key
# is provided.
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

resource "aws_cloudformation_stack" "datadog_forwarder" {
  count        = var.datadog_api_key != "" ? 1 : 0
  name         = "${local.name_prefix}-datadog-forwarder"
  capabilities = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"]
  template_url = "https://datadog-cloudformation-template.s3.amazonaws.com/aws/forwarder/latest.yaml"

  parameters = {
    DdApiKeySecretArn = aws_secretsmanager_secret.datadog_api_key[0].arn
    DdSite            = var.datadog_site
    FunctionName      = "${local.name_prefix}-datadog-forwarder"
  }
}

# -----------------------------------------------------------------------------
# CloudWatch Log Subscription - Forward ECS logs to Datadog
# -----------------------------------------------------------------------------

resource "aws_lambda_permission" "allow_cloudwatch" {
  count         = var.datadog_api_key != "" ? 1 : 0
  statement_id  = "AllowCloudWatchInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_cloudformation_stack.datadog_forwarder[0].outputs["DatadogForwarderArn"]
  principal     = "logs.amazonaws.com"
  source_arn    = "${aws_cloudwatch_log_group.app.arn}:*"
}

resource "aws_cloudwatch_log_subscription_filter" "datadog" {
  count           = var.datadog_api_key != "" ? 1 : 0
  name            = "${local.name_prefix}-datadog-forwarder"
  log_group_name  = aws_cloudwatch_log_group.app.name
  filter_pattern  = ""
  destination_arn = aws_cloudformation_stack.datadog_forwarder[0].outputs["DatadogForwarderArn"]

  depends_on = [aws_lambda_permission.allow_cloudwatch]
}
