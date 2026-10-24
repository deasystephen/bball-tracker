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
# DB Parameter Group - owns the settings the backend and the exported log depend on
# =============================================================================
#
# Until #757 the instance ran the AWS-managed `default.postgres18` group, so the
# one setting the backend's connection depends on (`rds.force_ssl = 1`, see
# backend/src/models/index.ts and the 2026-06-21 TLS outage) was inherited, not
# declared. Every parameter below is dynamic, but RDS applies a NEWLY
# ASSOCIATED group only after a manual reboot: the apply that attaches it
# leaves the instance `pending-reboot` (no outage) until the owner reboots it
# (docs/runbooks/rds-backup-restore.md, "Parameter group").
#
# The logging parameters keep personal data out of the PostgreSQL log, which
# `enabled_cloudwatch_logs_exports` below ships to CloudWatch. Prisma sends
# every value as a bind parameter, so statement text carries placeholders
# only; the leaks would be the DETAIL line of a constraint error ("Key
# (email)=(...) already exists", "Failing row contains (...)") and bind values
# printed on error. backend/tests/infra/rds-parameters.test.ts pins all five,
# and the retention section of docs/runbooks/data-subject-requests.md (which
# the privacy policy must match) relies on them.
#
# `family` follows the engine major (postgres-version.test.ts fails when they
# differ); a major upgrade switches groups as part of the runbook procedure.
resource "aws_db_parameter_group" "postgres" {
  name        = "${local.name_prefix}-postgres18"
  family      = "postgres18"
  description = "Managed by Terraform: TLS enforcement and log privacy"

  # Reject every connection that does not negotiate TLS (28000 "no encryption").
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # ERROR / FATAL lines without DETAIL, HINT, QUERY or CONTEXT: the primary
  # message keeps the cause (a 28000 rejection, a lock timeout, the violated
  # constraint's name), the row values stay out.
  parameter {
    name  = "log_error_verbosity"
    value = "terse"
  }

  # Engine defaults, restated so that changing one is a reviewed diff: no
  # statement logging, no duration logging, no bind values on error.
  parameter {
    name  = "log_statement"
    value = "none"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }

  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.name_prefix}-postgres18"
  }
}

# =============================================================================
# PostgreSQL server log in CloudWatch
# =============================================================================
#
# Declared ahead of the export so RDS writes into a group with bounded
# retention (RDS would otherwise create it with never-expire). Not subscribed
# to the Datadog forwarder (datadog.tf forwards the API log group only), so the
# log stays in this account. The retention is listed in
# docs/runbooks/data-subject-requests.md; change both together.
resource "aws_cloudwatch_log_group" "rds_postgresql" {
  name              = "/aws/rds/instance/${local.name_prefix}-postgres/postgresql"
  retention_in_days = 30

  tags = {
    Name = "${local.name_prefix}-postgres-log"
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
  # then this pin is bumped to the new major AND the stored engine_version in
  # state is patched to the same major (state pull / jq / state push — the
  # provider only keeps a major-only value while "<stored>." prefixes the live
  # version, so the first refresh after a major upgrade stores the full "18.6"
  # and config "18" would plan as a change forever). `terraform plan` must then
  # show "No changes". Full procedure: docs/runbooks/rds-backup-restore.md,
  # "Major version upgrade". allow_major_version_upgrade is deliberately absent, so an
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

  # TLS enforcement and log privacy (aws_db_parameter_group.postgres above).
  parameter_group_name = aws_db_parameter_group.postgres.name

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

  # The server log (28000 rejections, failed logins, lock timeouts) in
  # CloudWatch, instead of only on the instance for three days
  # (rds.log_retention_period). Takes effect without a reboot.
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Automated snapshots and the final snapshot carry Project / Environment.
  copy_tags_to_snapshot = true

  depends_on = [aws_cloudwatch_log_group.rds_postgresql]

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}
