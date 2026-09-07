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
  engine = "postgres"
  # Major version only: RDS applies minor upgrades itself during the
  # maintenance window (auto_minor_version_upgrade), and pinning a minor here
  # made `terraform apply` fail with "Cannot upgrade postgres from 15.17 to
  # 15.15" once AWS had moved ahead. The provider suppresses the diff when the
  # config is a prefix of the running version.
  #
  # MAJOR upgrades are NOT driven from here (#521, 15 -> 18 on 2026-09). A bare
  # major in a modify call resolves to the RDS *default* minor (18 -> 18.3, not
  # the newest), apply_immediately defaults to false so the change would queue
  # for the Sunday window unattended, and no 18.x minor is auto-upgrade
  # flagged. So a major is a watched CLI operation with the exact minor:
  #   aws rds modify-db-instance --engine-version 18.6 \
  #     --allow-major-version-upgrade --apply-immediately
  # then this pin is bumped to the new major and `terraform plan` must show
  # "No changes". Full procedure: docs/runbooks/rds-backup-restore.md, "Major
  # version upgrade". allow_major_version_upgrade is deliberately absent, so an
  # accidental major bump here fails loudly at apply instead of upgrading.
  # backend/tests/infra/postgres-version.test.ts pins this major to the
  # docker-compose and CI images and to the RDS end-of-standard-support date.
  engine_version             = "18"
  auto_minor_version_upgrade = true
  instance_class             = var.db_instance_class

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
  deletion_protection       = var.environment == "production" ? true : false
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name_prefix}-final-snapshot" : null

  # Performance Insights for monitoring (free tier for db.t3.micro)
  performance_insights_enabled = true

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}
