# Hooplings - the web app at https://<primary_domain> (#30)
#
# The Next.js site in web/ (invitation accept page, support, privacy, terms and
# the .well-known/ Universal Link files) runs as its own Fargate service behind
# the API's ALB. The HTTPS listener sends the apex to it by host header and
# redirects www to the apex; every other host still reaches the API through
# the listener's default action. The certificate already lists the apex and
# the wildcard (dns.tf), so nothing there changes.
#
# Like the API, the task definition is NOT declared here: CI registers
# revisions of infra/web-task-definition.json into the family below and points
# the service at them (the `build-and-deploy-web` job in ci.yml).
#
# Bring-up is two applies, because ECS cannot create a service before the
# family has a revision (infra/README.md "Web app"):
#   1. web_enabled = false (the default): apply creates the repository, target
#      group, security group and log group; the merge then builds the first
#      image and registers the first revision (the CI job finds no service and
#      stops after registering).
#   2. web_enabled = true: apply creates the service, the listener rules and
#      the apex and www records; every later merge under web/ deploys.

locals {
  web_family     = "${local.name_prefix}-web"
  web_port       = 3000
  web_www_domain = "www.${var.primary_domain}"
}

# =============================================================================
# Image repository
# =============================================================================

# Immutable tags: CI pushes only the commit tag, so the running image always
# names the commit it was built from and can never be overwritten in place.
resource "aws_ecr_repository" "web" {
  name                 = "bball-tracker-web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${local.name_prefix}-web"
  }
}

# Keep the 20 most recent images: enough to roll back weeks of deploys, and
# the repository never grows without bound.
resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# =============================================================================
# Logs - its own group, so the web site's lines never mix with the API's
# =============================================================================

# Not subscribed to Datadog (datadog.tf forwards the API group only). Next.js
# logs no request URLs in production; the one app log line is
# `Invitation lookup unavailable` (reason and status, never the token).
resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.web_family}"
  retention_in_days = 30

  tags = {
    Name = "${local.web_family}-logs"
  }
}

# =============================================================================
# Network - reachable from the ALB only, and reaches only HTTPS
# =============================================================================

# Its own group, not ecs_tasks: the RDS and Redis groups admit ecs_tasks, and
# the web server has no business with either. It calls the public API
# (https://api.<primary_domain>) for the invitation lookup, so egress is 443.
# DNS goes to the VPC resolver, which security groups do not filter.
resource "aws_security_group" "web_tasks" {
  name        = "${local.name_prefix}-web-sg"
  description = "Security group for the web app Fargate tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Traffic from ALB only"
    from_port       = local.web_port
    to_port         = local.web_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "HTTPS to the API and the internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-web-sg"
  }
}

# =============================================================================
# Load balancing
# =============================================================================

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = local.web_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # Plain request/response pages, no long-lived connections: 30 s drains any
  # request in flight during a deploy (the 300 s default only slows rollouts).
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  tags = {
    Name = "${local.name_prefix}-web-tg"
  }
}

resource "aws_lb_listener_rule" "web_www_redirect" {
  count = var.web_enabled ? 1 : 0

  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type = "redirect"

    redirect {
      host        = var.primary_domain
      status_code = "HTTP_301"
    }
  }

  condition {
    host_header {
      values = [local.web_www_domain]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  count = var.web_enabled ? 1 : 0

  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.primary_domain]
    }
  }
}

# =============================================================================
# ECS service
# =============================================================================

resource "aws_ecs_service" "web" {
  count = var.web_enabled ? 1 : 0

  name            = local.web_family
  cluster         = aws_ecs_cluster.main.id
  task_definition = local.web_family
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = local.web_port
  }

  # Start the new task before stopping the old one, so a deploy never takes the
  # site down. No Socket.io here, so two tasks overlapping is harmless.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  # The server is ready in well under a second; this covers image pull and
  # the ALB's two healthy checks.
  health_check_grace_period_seconds = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # task_definition is CI's (build-and-deploy-web), as for the API (#53).
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.web]
}

# =============================================================================
# DNS - the apex and www, both to the ALB
# =============================================================================

resource "aws_route53_record" "web_apex" {
  count = var.web_enabled ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = var.primary_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "web_www" {
  count = var.web_enabled ? 1 : 0

  zone_id = aws_route53_zone.main[var.primary_domain].zone_id
  name    = local.web_www_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# =============================================================================
# Uptime - the site from outside AWS, like the API's check in alerting.tf
# =============================================================================

# /health answers without calling the API, so this alarm means "the site is
# down", never "the API is down" (the API has its own). The invitation links
# in every email land here.
resource "aws_route53_health_check" "web" {
  count = var.web_enabled ? 1 : 0

  type              = "HTTPS"
  fqdn              = var.primary_domain
  port              = 443
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
  regions           = ["us-east-1", "us-west-1", "us-west-2"]

  tags = {
    Name = "${local.name_prefix}-web-uptime"
  }
}

resource "aws_cloudwatch_metric_alarm" "web_uptime" {
  count = var.web_enabled ? 1 : 0

  alarm_name        = "${local.name_prefix}-web-uptime"
  alarm_description = "https://${var.primary_domain}/health is failing from outside AWS: invitation links and the support, privacy and terms pages are down. Runbook: docs/runbooks/on-call.md#web-site-is-down"

  namespace   = "AWS/Route53"
  metric_name = "HealthCheckStatus"
  dimensions = {
    HealthCheckId = aws_route53_health_check.web[0].id
  }

  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 2
  treat_missing_data  = "breaching"

  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions

  lifecycle {
    precondition {
      condition     = var.aws_region == "us-east-1"
      error_message = "Route 53 health-check metrics exist only in us-east-1; the web uptime alarm must be created there."
    }
  }
}
