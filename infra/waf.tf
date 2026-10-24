# Basketball Tracker - AWS WAF on the ALB (#764)
#
# The API is single-replica and every rate limit is in process, so nothing
# upstream of the one Fargate task could shed traffic. This web ACL sits in
# front of the ALB with AWS's two baseline managed rule groups and a per-IP
# rate-based rule, ALL IN COUNT MODE: it measures what it would block and
# blocks nothing. Promoting a rule to block is a reviewed edit here plus an
# apply, after reading its CountedRequests metric (infra/README.md, "Edge: ALB
# and WAF"). Cost: about USD 5 per month for the ACL, USD 1 per rule per month
# and USD 0.60 per million requests (about 0.5 million a month in 2026-10).
#
# Privacy: no logging configuration and `sampled_requests_enabled = false`
# everywhere. Sampled requests would keep full URLs and headers (bearer
# tokens, invitation and calendar tokens) in the WAF console for three hours;
# CloudWatch metrics carry counts only. backend/tests/infra/edge-hardening.test.ts
# pins both.

locals {
  # Requests per client IP per 5-minute window before the rate rule matches.
  # Mobile clients behind one gym or carrier NAT share an IP, so read the
  # counted metric during a busy game day before choosing to block.
  waf_rate_limit_per_5_minutes = 2000
}

resource "aws_wafv2_web_acl" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "ALB edge rules, count mode (#764)"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 0

    action {
      count {}
    }

    statement {
      rate_based_statement {
        limit                 = local.waf_rate_limit_per_5_minutes
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-rate-limit-per-ip"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-common-rule-set"
    priority = 10

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-aws-common-rule-set"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-aws-known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-alb"
    sampled_requests_enabled   = false
  }

  tags = {
    Name = "${local.name_prefix}-alb-waf"
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.alb.arn
}
