# Basketball Tracker - ECS Fargate, ALB, and Auto-Scaling
#
# Runs the backend API as Fargate tasks behind an Application Load Balancer
# with CPU-based auto-scaling.

# =============================================================================
# CloudWatch Log Group - Centralized logging for ECS tasks
# =============================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30

  tags = {
    Name = "${local.name_prefix}-logs"
  }
}

# =============================================================================
# ECS Cluster
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${local.name_prefix}-cluster"
  }
}

# =============================================================================
# IAM Roles for ECS
# =============================================================================

# Task execution role - used by ECS agent to pull images and write logs
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow ECS execution role to read secrets from Secrets Manager
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${local.name_prefix}-ecs-secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue"
      ]
      Resource = [
        aws_secretsmanager_secret.database_url.arn,
        aws_secretsmanager_secret.jwt_secret.arn,
        aws_secretsmanager_secret.workos_api_key.arn,
        aws_secretsmanager_secret.workos_client_id.arn,
      ]
    }]
  })
}

# =============================================================================
# Secrets Manager - Application secrets stored securely
# =============================================================================

resource "aws_secretsmanager_secret" "database_url" {
  name = "${local.name_prefix}/database-url"
  tags = { Name = "${local.name_prefix}-database-url" }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "${local.name_prefix}/jwt-secret"
  tags = { Name = "${local.name_prefix}-jwt-secret" }
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = var.jwt_secret
}

resource "aws_secretsmanager_secret" "workos_api_key" {
  name = "${local.name_prefix}/workos-api-key"
  tags = { Name = "${local.name_prefix}-workos-api-key" }
}

resource "aws_secretsmanager_secret_version" "workos_api_key" {
  count         = var.workos_api_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.workos_api_key.id
  secret_string = var.workos_api_key
}

resource "aws_secretsmanager_secret" "workos_client_id" {
  name = "${local.name_prefix}/workos-client-id"
  tags = { Name = "${local.name_prefix}-workos-client-id" }
}

resource "aws_secretsmanager_secret_version" "workos_client_id" {
  count         = var.workos_client_id != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.workos_client_id.id
  secret_string = var.workos_client_id
}

# Task role - used by the application container itself
resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

# =============================================================================
# ECS Task Definition
# =============================================================================

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "api"
    image = var.container_image

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.cache_nodes[0].port}" },
      { name = "WORKOS_REDIRECT_URI", value = "https://api.${var.domain_name}/api/v1/auth/callback" },
      { name = "CORS_ORIGIN", value = "https://api.${var.domain_name}" },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
      { name = "WORKOS_API_KEY", valueFrom = aws_secretsmanager_secret.workos_api_key.arn },
      { name = "WORKOS_CLIENT_ID", valueFrom = aws_secretsmanager_secret.workos_client_id.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }

    # Health check at the container level
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q --spider http://localhost:${var.container_port}/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    essential = true
  }])

  tags = {
    Name = "${local.name_prefix}-task-def"
  }
}

# =============================================================================
# Application Load Balancer
# =============================================================================

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

# Target group for ECS tasks - health checked via /health endpoint
resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

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
    Name = "${local.name_prefix}-tg"
  }
}

# HTTP listener - always redirects to HTTPS
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS listener - uses ACM-managed certificate
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# =============================================================================
# ECS Service - Runs the Fargate tasks behind the ALB
# =============================================================================

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  # Allow ECS to manage task placement during deployments
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 50

  # Ignore changes to desired_count since auto-scaling manages it
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
}

# =============================================================================
# Auto-Scaling - Scale ECS tasks based on CPU utilization
# =============================================================================

resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Scale up when average CPU exceeds 70%
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name_prefix}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
