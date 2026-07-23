output "redis_host" {
  description = "Redis Cloud public endpoint host."
  value       = local.redis_host
}

output "redis_port" {
  description = "Redis Cloud public endpoint port."
  value       = local.redis_port
}

output "redis_tls" {
  description = "Whether the Redis Cloud endpoint has TLS enabled."
  value       = local.redis_tls
}

output "redis_database_name" {
  description = "Redis Cloud database name."
  value       = local.redis_database_name
}

output "rediscloud_subscription_id" {
  description = "Redis Cloud subscription ID."
  value       = local.redis_subscription_id
}

output "rediscloud_database_id" {
  description = "Redis Cloud database ID."
  value       = local.redis_database_id
}

output "rediscloud_subscription_type" {
  description = "Redis Cloud subscription family."
  value       = local.subscription_type
}

output "redis_dataset_size_in_gb" {
  description = "Redis Cloud dataset size in GB when reported by the selected subscription type."
  value       = local.redis_dataset_size_in_gb
}

output "redis_support_oss_cluster_api" {
  description = "Whether the Redis Cloud database exposes the Redis OSS Cluster API."
  value       = local.subscription_type == "pro" && var.support_oss_cluster_api
}

output "redis_cluster_root_nodes" {
  description = "Comma-separated root endpoint URLs for a Redis OSS Cluster API client."
  value = (
    local.subscription_type == "pro" && var.support_oss_cluster_api
    ? "${local.redis_tls ? "rediss" : "redis"}://${local.redis_public_endpoint}"
    : ""
  )
}

output "redis_password" {
  description = "Redis Cloud database password."
  value       = local.redis_password
  sensitive   = true
}

output "redis_url" {
  description = "Redis Cloud connection string for the demo app."
  value       = "${local.redis_tls ? "rediss" : "redis"}://default:${local.redis_password}@${local.redis_public_endpoint}"
  sensitive   = true
}

output "redis_backup_s3_path" {
  description = "Configured Redis Cloud scheduled remote backup path, when enabled."
  value       = var.backup_s3_path
}

output "rediscloud_aws_vpc_peering_id" {
  description = "AWS VPC peering connection created by Redis Cloud, when enabled."
  value       = try(rediscloud_subscription_peering.benchmark[0].aws_peering_id, null)
}

output "rediscloud_aws_vpc_peering_status" {
  description = "Redis Cloud's reported AWS VPC peering status, when enabled."
  value       = try(rediscloud_subscription_peering.benchmark[0].status, null)
}

output "rediscloud_aws_vpc_id" {
  description = "AWS application VPC peered with Redis Cloud, when enabled."
  value       = try(data.aws_vpc.benchmark[0].id, null)
}

output "rediscloud_aws_route_table_ids" {
  description = "AWS route tables given a route to the Redis Cloud deployment CIDR."
  value       = try(sort(data.aws_route_tables.benchmark[0].ids), [])
}
