# Basketball Tracker - RDS PostgreSQL
#
# Managed PostgreSQL database in private subnets. Uses db.t3.micro by default
# for cost efficiency in small/medium deployments.

# =============================================================================
# DB Subnet Group - Places the database in private subnets
# =============================================================================

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-db-subnet"
  }
}

# =============================================================================
# RDS PostgreSQL Instance
# =============================================================================

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  # Engine configuration
  engine         = "postgres"
  engine_version = "15.4"
  instance_class = var.db_instance_class

  # Storage - start small with autoscaling enabled
  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database credentials
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  # Networking - private subnets only, no public access
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # Backup and maintenance
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  # High availability - enable for production, disable for staging to save cost
  multi_az = var.environment == "production" ? true : false

  # Deletion protection - prevent accidental destruction
  deletion_protection = var.environment == "production" ? true : false
  skip_final_snapshot = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name_prefix}-final-snapshot" : null

  # Performance Insights for monitoring (free tier for db.t3.micro)
  performance_insights_enabled = true

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}
