resource "random_password" "redis" {
  length  = 32
  special = false
}

locals {
  redis_password = coalesce(var.redis_password, random_password.redis.result)
  endpoint_parts = split(":", rediscloud_essentials_database.demo.public_endpoint)
  redis_host     = local.endpoint_parts[0]
  redis_port     = tonumber(local.endpoint_parts[1])
}

data "rediscloud_payment_method" "default" {
  exclude_expired = true
}

data "rediscloud_essentials_plan" "demo" {
  id                  = var.essentials_plan_id
  name                = var.essentials_plan_name
  cloud_provider      = var.cloud_provider
  region              = var.region
  availability        = var.essentials_plan_availability
  support_replication = var.replication
  support_data_persistence = (
    var.data_persistence == "none"
    ? null
    : true
  )
}

resource "rediscloud_essentials_subscription" "demo" {
  name              = var.subscription_name
  plan_id           = data.rediscloud_essentials_plan.demo.id
  payment_method_id = data.rediscloud_payment_method.default.id
}

resource "rediscloud_essentials_database" "demo" {
  subscription_id     = rediscloud_essentials_subscription.demo.id
  name                = var.database_name
  data_eviction       = var.data_eviction
  data_persistence    = var.data_persistence
  enable_tls          = var.enable_tls
  replication         = var.replication
  enable_default_user = true
  password            = local.redis_password
}
