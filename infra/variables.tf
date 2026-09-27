# Variables for Basketball Tracker infrastructure

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  default     = "staging"
}

variable "app_name" {
  description = "Application name used for resource naming"
  type        = string
  default     = "bball-tracker"
}

# Networking
variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones for multi-AZ deployment"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# ECS / Fargate
variable "container_port" {
  description = "Port the backend container listens on"
  type        = number
  default     = 3000
}

variable "desired_count" {
  description = "Number of ECS tasks to run"
  type        = number
  default     = 1
}

variable "min_capacity" {
  description = "Minimum number of ECS tasks for auto-scaling. 1 in normal operation; 0 is accepted only so a maintenance window can scale the API down (docs/runbooks/rds-backup-restore.md). Never above 1: the API is single-replica until the Redis adapter lands (#452)."
  type        = number
  default     = 1

  validation {
    condition     = contains([0, 1], var.min_capacity)
    error_message = "min_capacity must be 0 or 1. The API is single-replica by construction (in-memory Socket.io adapter and in-memory rate-limit stores), so a floor above 1 splits live-game rooms across tasks. Land the Redis adapter (#452) before raising it (#446)."
  }
}

# Pinned to 1 (#446). The API keeps Socket.io rooms and every rate-limit counter
# in process memory, so a second task silently splits a live game: the coach
# tracks on task A, the parents watch on task B, and nobody sees an error.
# Raising this is NOT a fix for load. Order of work: Redis adapter plus a
# Redis-backed rate-limit store first (#452), capacity second. When that lands,
# change this validation, MAX_REPLICAS in infra/task-definition.json and the
# startup guard in backend/src/utils/replica-guard.ts together;
# backend/tests/infra/replica-ceiling.test.ts fails if they drift.
variable "max_capacity" {
  description = "Maximum number of ECS tasks for auto-scaling. Pinned to 1: the API is single-replica by construction until the Redis adapter lands (#452). Must equal MAX_REPLICAS in infra/task-definition.json."
  type        = number
  default     = 1

  validation {
    condition     = var.max_capacity == 1
    error_message = "max_capacity must be 1. The API is single-replica by construction (in-memory Socket.io adapter and in-memory rate-limit stores): a second task silently splits live-game rooms and multiplies every rate limit. Land the Redis adapter (#452) before raising it (#446)."
  }
}

# RDS
variable "db_instance_class" {
  description = "RDS instance type"
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "bball_tracker"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
}

# ElastiCache
variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

# Application secrets
variable "jwt_secret" {
  description = "JWT signing secret for authentication"
  type        = string
  sensitive   = true
}

variable "workos_api_key" {
  description = "WorkOS API key for authentication"
  type        = string
  sensitive   = true
  default     = ""
}

variable "workos_client_id" {
  description = "WorkOS client ID for authentication"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_dsn" {
  description = "Sentry DSN for backend error tracking. Leave empty to disable Sentry (init no-ops)."
  type        = string
  sensitive   = true
  default     = ""
}

# Domains
#
# Every registered domain gets a Route53 hosted zone. `serve = true` additionally
# provisions the ACM certificate, the api.<domain> record and the SES identity
# (see dns.tf / ses.tf). Retire a domain by flipping `serve` to false — the zone
# stays so the registrar delegation never dangles.
variable "domains" {
  description = "Registered domains → { serve = bool }. Served domains carry the API, certificate and mail identity."
  type        = map(object({ serve = bool }))
  default = {
    "hooplings.com" = { serve = true }
    # Retired 2026-09-07 (PR4, #503) once every TestFlight device had taken the
    # hooplings OTA: certificate, api record, SES identity and mail records are
    # gone; the zone stays so the registrar delegation never goes lame.
    "capyhoops.com" = { serve = false }
  }
}

variable "primary_domain" {
  description = "Served domain whose certificate is the HTTPS listener default and whose URLs the outputs report."
  type        = string
  default     = "hooplings.com"
}

# Tags
variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default     = {}
}
