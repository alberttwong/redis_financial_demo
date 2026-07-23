locals {
  tags = merge(
    {
      Project   = "lpl-redis-demo"
      Role      = "redis-cloud-rdb-backup"
      Retention = "persistent"
    },
    var.tags
  )
}

resource "aws_s3_bucket" "redis_rdb" {
  bucket_prefix = var.bucket_prefix
  force_destroy = var.force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id

  rule {
    id     = "expire-dated-backups"
    status = "Enabled"

    filter {
      prefix = "${var.backup_prefix}/runs/"
    }

    dynamic "expiration" {
      for_each = var.backup_retention_days == null ? [] : [var.backup_retention_days]
      content {
        days = expiration.value
      }
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }

  depends_on = [aws_s3_bucket_versioning.redis_rdb]
}

resource "aws_s3_bucket_policy" "redis_rdb" {
  bucket = aws_s3_bucket.redis_rdb.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RedisCloudRdbAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::168085023892:root"
        }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.redis_rdb.arn}/*"
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.redis_rdb]
}
