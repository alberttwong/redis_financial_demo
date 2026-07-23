output "bucket_name" {
  description = "Persistent bucket that stores Redis Cloud shard RDB files."
  value       = aws_s3_bucket.redis_rdb.id
}

output "backup_prefix" {
  description = "Object prefix used by scripts/redis-cloud-rdb.sh."
  value       = var.backup_prefix
}

output "redis_cloud_backup_path" {
  description = "S3 path suitable for Redis Cloud remote backup configuration."
  value       = "s3://${aws_s3_bucket.redis_rdb.id}"
}

output "latest_manifest_uri" {
  description = "Stable pointer to the latest completed ad-hoc backup manifest."
  value       = "s3://${aws_s3_bucket.redis_rdb.id}/${var.backup_prefix}/latest.json"
}
