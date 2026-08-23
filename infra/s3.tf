# S3 bucket for user avatar uploads
resource "aws_s3_bucket" "avatars" {
  bucket = "${var.app_name}-avatars-${var.environment}"

  tags = var.tags
}

resource "aws_s3_bucket_public_access_block" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "avatars_public_read" {
  bucket     = aws_s3_bucket.avatars.id
  depends_on = [aws_s3_bucket_public_access_block.avatars]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadAvatars"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.avatars.arn}/avatars/*"
      }
    ]
  })
}

resource "aws_s3_bucket_cors_configuration" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["POST", "PUT", "GET"]
    allowed_origins = ["*"]
    max_age_seconds = 3600
  }
}

# Avatars are uploaded with presigned POST policies (size-capped). Incomplete
# multipart uploads are the one class of orphan S3 can expire on its own; the
# previous avatar object is deleted by the API when a user replaces it.
resource "aws_s3_bucket_lifecycle_configuration" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  rule {
    id     = "abort-incomplete-avatar-uploads"
    status = "Enabled"

    filter {
      prefix = "avatars/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
