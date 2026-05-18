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
  value       = rediscloud_essentials_database.demo.enable_tls
}

output "redis_database_name" {
  description = "Redis Cloud database name."
  value       = rediscloud_essentials_database.demo.name
}

output "rediscloud_subscription_id" {
  description = "Redis Cloud Essentials subscription ID."
  value       = rediscloud_essentials_subscription.demo.id
}

output "rediscloud_database_id" {
  description = "Redis Cloud database ID."
  value       = rediscloud_essentials_database.demo.db_id
}

output "redis_password" {
  description = "Redis Cloud database password."
  value       = local.redis_password
  sensitive   = true
}

output "redis_url" {
  description = "Redis Cloud connection string for the demo app."
  value       = "${rediscloud_essentials_database.demo.enable_tls ? "rediss" : "redis"}://default:${local.redis_password}@${rediscloud_essentials_database.demo.public_endpoint}"
  sensitive   = true
}
