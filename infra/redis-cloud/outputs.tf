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
