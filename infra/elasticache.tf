# Basketball Tracker - ElastiCache Redis
#
# Managed Redis cluster for caching and session storage.
# Uses cache.t3.micro by default for cost efficiency.

# =============================================================================
# ElastiCache Subnet Group - Places Redis in private subnets
# =============================================================================

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-redis-subnet"
  }
}

# =============================================================================
# ElastiCache Redis Cluster
# =============================================================================

resource "aws_elasticache_cluster" "main" {
  cluster_id = "${local.name_prefix}-redis"

  # Engine configuration
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  # Networking - private subnets only
  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  # Maintenance window
  maintenance_window = "sun:05:00-sun:06:00"

  # Snapshot for disaster recovery (1 day retention)
  snapshot_retention_limit = var.environment == "production" ? 3 : 1
  snapshot_window          = "02:00-03:00"

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
