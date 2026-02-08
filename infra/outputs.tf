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
  description = "Full API URL (HTTP or HTTPS depending on certificate)"
  value       = var.certificate_arn != "" ? "https://${aws_lb.main.dns_name}" : "http://${aws_lb.main.dns_name}"
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
  value       = aws_ecs_task_definition.app.family
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
