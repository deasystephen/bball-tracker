# Basketball Tracker - Terraform Outputs
#
# These values are needed to configure the CI/CD pipeline, mobile app,
# and other services that connect to the infrastructure.

# =============================================================================
# Networking
# =============================================================================

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (for ECS tasks, RDS, Redis)"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (for ALB)"
  value       = aws_subnet.public[*].id
}

# =============================================================================
# Load Balancer
# =============================================================================

output "alb_dns_name" {
  description = "ALB DNS name - use this as the API base URL"
  value       = aws_lb.main.dns_name
}

output "alb_arn" {
  description = "ALB ARN"
  value       = aws_lb.main.arn
}

output "api_url" {
  description = "API URL on the primary domain"
  value       = "https://api.${var.primary_domain}"
}

output "domain_name" {
  description = "Primary domain"
  value       = var.primary_domain
}

output "served_domains" {
  description = "Domains that carry the API, a certificate and a mail identity"
  value       = sort(keys(local.served_domains))
}

output "name_servers" {
  description = "Route53 name servers per hosted zone. Domains registered through Route53 Domains are already delegated to these; any other registrar must be pointed at them."
  value       = { for d, z in aws_route53_zone.main : d => z.name_servers }
}

output "certificate_arn" {
  description = "ACM certificate ARN for the primary domain (HTTPS listener default)"
  value       = aws_acm_certificate.main[var.primary_domain].arn
}

output "certificate_arns" {
  description = "ACM certificate ARN per served domain"
  value       = { for d, c in aws_acm_certificate.main : d => c.arn }
}

# =============================================================================
# ECS
# =============================================================================

output "ecs_cluster_name" {
  description = "ECS cluster name (used in CI/CD deploy step)"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name (used in CI/CD deploy step)"
  value       = aws_ecs_service.app.name
}

output "ecs_task_definition_family" {
  description = "ECS task definition family name"
  value       = local.task_definition_family
}

# Every literal that infra/task-definition.json carries and Terraform owns has
# an output here, so a replaced resource can be re-read with
# `terraform output -raw <name>` (one name per invocation).
output "ecs_execution_role_arn" {
  description = "ARN of the ECS task execution role (executionRoleArn in infra/task-definition.json)"
  value       = aws_iam_role.ecs_execution.arn
}

output "ecs_task_role_arn" {
  description = "ARN of the ECS task role (taskRoleArn in infra/task-definition.json)"
  value       = aws_iam_role.ecs_task.arn
}

output "database_url_secret_arn" {
  description = "Full ARN of the DATABASE_URL secret (used in infra/task-definition.json)"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "jwt_secret_arn" {
  description = "Full ARN of the JWT_SECRET secret (used in infra/task-definition.json)"
  value       = aws_secretsmanager_secret.jwt_secret.arn
}

output "workos_api_key_secret_arn" {
  description = "Full ARN of the WORKOS_API_KEY secret (used in infra/task-definition.json)"
  value       = aws_secretsmanager_secret.workos_api_key.arn
}

output "workos_client_id_secret_arn" {
  description = "Full ARN of the WORKOS_CLIENT_ID secret (used in infra/task-definition.json)"
  value       = aws_secretsmanager_secret.workos_client_id.arn
}

output "sentry_dsn_secret_arn" {
  description = "Full ARN of the SENTRY_DSN secret (used in infra/task-definition.json)"
  value       = aws_secretsmanager_secret.sentry_dsn.arn
}

# =============================================================================
# Database
# =============================================================================

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = aws_db_instance.main.endpoint
}

output "rds_hostname" {
  description = "RDS PostgreSQL hostname"
  value       = aws_db_instance.main.address
}

output "database_url" {
  description = "Full DATABASE_URL for the backend application"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"
  sensitive   = true
}

# =============================================================================
# Redis
# =============================================================================

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint (host:port)"
  value       = "${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.cache_nodes[0].port}"
}

output "redis_url" {
  description = "Full REDIS_URL for the backend application"
  value       = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.cache_nodes[0].port}"
}

# =============================================================================
# Security Groups (for reference by other modules)
# =============================================================================

output "alb_security_group_id" {
  description = "ALB security group ID"
  value       = aws_security_group.alb.id
}

output "ecs_security_group_id" {
  description = "ECS tasks security group ID"
  value       = aws_security_group.ecs_tasks.id
}

output "rds_security_group_id" {
  description = "RDS security group ID"
  value       = aws_security_group.rds.id
}

output "redis_security_group_id" {
  description = "Redis security group ID"
  value       = aws_security_group.redis.id
}

# =============================================================================
# S3
# =============================================================================

output "s3_avatars_bucket_name" {
  description = "Name of the S3 bucket for avatar uploads"
  value       = aws_s3_bucket.avatars.id
}

output "s3_avatars_bucket_domain" {
  description = "Regional domain name of the avatars S3 bucket"
  value       = aws_s3_bucket.avatars.bucket_regional_domain_name
}

# =============================================================================
# Email events (#449) - the two values infra/task-definition.json repeats
# =============================================================================

output "ses_configuration_set_name" {
  description = "SES configuration set the API names on every send (SES_CONFIGURATION_SET in infra/task-definition.json)"
  value       = aws_sesv2_configuration_set.transactional.configuration_set_name
}

output "ses_events_queue_url" {
  description = "SQS queue the API reads SES sending events from (SES_EVENTS_QUEUE_URL in infra/task-definition.json)"
  value       = aws_sqs_queue.ses_events.url
}

output "ses_events_dlq_url" {
  description = "Dead-letter queue for SES events the API could not process (docs/runbooks/email-deliverability.md)"
  value       = aws_sqs_queue.ses_events_dlq.url
}

# =============================================================================
# Alerting
# =============================================================================

output "alerts_topic_arn" {
  description = "SNS topic every production alarm publishes to (alerting.tf). Used for the test publish in docs/runbooks/on-call.md and as the destination for any new alert source."
  value       = aws_sns_topic.alerts.arn
}

output "uptime_health_check_id" {
  description = "Route 53 health check behind the API uptime alarm"
  value       = aws_route53_health_check.api.id
}
