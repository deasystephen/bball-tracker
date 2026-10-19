# Terraform remote state for ../ (the main configuration): the S3 bucket that
# holds infra/terraform.tfstate and the DynamoDB table that locks it (#641).
#
# This configuration uses LOCAL state on purpose. The bucket cannot hold the
# state that declares the bucket, and a second remote backend would need a
# third bucket. The local state file is gitignored (infra/.gitignore, *.tfstate)
# and holds nothing sensitive: bucket and table attributes only. If it is lost,
# the `import` blocks below bring every resource but the bucket policy back
# in on the next apply (an import block for a resource that is already in
# state is a no-op; the policy is simply re-put).
#
# Both resources were created by hand on 2026-02-07/08 before any Terraform
# existed and were imported here. The state object is the most sensitive
# object in the account: it carries the RDS master password and every
# third-party API key in plaintext. Hence prevent_destroy, versioning, the
# public-access block, default encryption and a TLS-only bucket policy.
#
#   cd infra/bootstrap && terraform init && terraform plan   # then apply
#
# A plan must never show a destroy. Local Terraform is 1.5.x, so S3-native
# locking (`use_lockfile`, Terraform >= 1.10) is not available and the table
# stays.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "bball-tracker"
      ManagedBy = "terraform"
    }
  }
}

locals {
  state_bucket = "bball-tracker-terraform-state"
  lock_table   = "terraform-locks"
}

# -----------------------------------------------------------------------------
# Imports (idempotent; keep them so a lost local state re-adopts everything).
# Terraform 1.5 requires literal ids here, hence no `local.` references.
# The bucket policy has no import block on purpose: Terraform 1.5 fails the
# plan when an import's remote object does not exist, and the policy did not
# exist before the first apply. After a lost local state the plan therefore
# shows "1 to add" for the policy; the apply is a PutBucketPolicy of the same
# document, which is harmless.
# -----------------------------------------------------------------------------

import {
  to = aws_s3_bucket.state
  id = "bball-tracker-terraform-state"
}

import {
  to = aws_s3_bucket_versioning.state
  id = "bball-tracker-terraform-state"
}

import {
  to = aws_s3_bucket_public_access_block.state
  id = "bball-tracker-terraform-state"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.state
  id = "bball-tracker-terraform-state"
}

import {
  to = aws_s3_bucket_ownership_controls.state
  id = "bball-tracker-terraform-state"
}

import {
  to = aws_dynamodb_table.locks
  id = "terraform-locks"
}

# -----------------------------------------------------------------------------
# State bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  tags = { Name = local.state_bucket }

  lifecycle {
    prevent_destroy = true
  }
}

# Every write keeps the previous object: a corrupted or truncated state can be
# rolled back from the version history (`aws s3api list-object-versions`).
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled       = true
    blocked_encryption_types = ["SSE-C"]
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Deny any request that is not over TLS. The public-access block already
# rejects anonymous access; this closes the plaintext-HTTP path for
# authenticated principals too (the one gap found when #641 was verified).
data "aws_iam_policy_document" "state_tls_only" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_tls_only.json
}

# -----------------------------------------------------------------------------
# Lock table
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "locks" {
  name         = local.lock_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  deletion_protection_enabled = true

  tags = { Name = local.lock_table }

  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Outputs (the values ../main.tf hard-codes in its backend block)
# -----------------------------------------------------------------------------

output "state_bucket" {
  description = "S3 bucket named in the `backend \"s3\"` block of ../main.tf"
  value       = aws_s3_bucket.state.id
}

output "lock_table" {
  description = "DynamoDB table named in the `backend \"s3\"` block of ../main.tf"
  value       = aws_dynamodb_table.locks.name
}
