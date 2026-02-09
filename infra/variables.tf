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
variable "container_image" {
  description = "Full ECR image URI (registry/repo:tag)"
  type        = string
}

variable "container_port" {
  description = "Port the backend container listens on"
  type        = number
  default     = 3000
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of ECS tasks to run"
  type        = number
  default     = 1
}

variable "min_capacity" {
  description = "Minimum number of ECS tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of ECS tasks for auto-scaling"
  type        = number
  default     = 4
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

# Domain
variable "domain_name" {
  description = "Root domain name (e.g., capyhoops.com). The API will be served at api.<domain_name>."
  type        = string
  default     = "capyhoops.com"
}

# Tags
variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default     = {}
}
