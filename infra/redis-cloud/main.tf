resource "random_password" "redis" {
  length  = 32
  special = false
}

locals {
  subscription_type        = lower(var.subscription_type)
  redis_password           = coalesce(var.redis_password, random_password.redis.result)
  redis_public_endpoint    = local.subscription_type == "pro" ? rediscloud_subscription_database.demo[0].public_endpoint : rediscloud_essentials_database.demo[0].public_endpoint
  redis_tls                = local.subscription_type == "pro" ? rediscloud_subscription_database.demo[0].enable_tls : rediscloud_essentials_database.demo[0].enable_tls
  redis_database_name      = local.subscription_type == "pro" ? rediscloud_subscription_database.demo[0].name : rediscloud_essentials_database.demo[0].name
  redis_database_id        = local.subscription_type == "pro" ? rediscloud_subscription_database.demo[0].db_id : rediscloud_essentials_database.demo[0].db_id
  redis_subscription_id    = local.subscription_type == "pro" ? rediscloud_subscription.demo[0].id : rediscloud_essentials_subscription.demo[0].id
  endpoint_parts           = split(":", local.redis_public_endpoint)
  redis_host               = local.endpoint_parts[0]
  redis_port               = tonumber(local.endpoint_parts[1])
  redis_dataset_size_in_gb = local.subscription_type == "pro" ? rediscloud_subscription_database.demo[0].dataset_size_in_gb : rediscloud_essentials_database.demo[0].memory_limit_in_gb
}

data "rediscloud_payment_method" "default" {
  exclude_expired = true
}

data "rediscloud_essentials_plan" "demo" {
  count = local.subscription_type == "essentials" ? 1 : 0

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

resource "rediscloud_subscription" "demo" {
  count = local.subscription_type == "pro" ? 1 : 0

  name                   = var.subscription_name
  payment_method         = var.payment_method
  payment_method_id      = data.rediscloud_payment_method.default.id
  public_endpoint_access = var.public_endpoint_access

  cloud_provider {
    provider = var.cloud_provider

    region {
      region                      = var.region
      multiple_availability_zones = var.multiple_availability_zones
      networking_deployment_cidr  = var.networking_deployment_cidr
    }
  }

  creation_plan {
    dataset_size_in_gb           = var.dataset_size_in_gb
    quantity                     = 1
    replication                  = var.replication
    throughput_measurement_by    = var.throughput_measurement_by
    throughput_measurement_value = var.throughput_measurement_value
    support_oss_cluster_api      = false
  }
}

resource "rediscloud_subscription_database" "demo" {
  count = local.subscription_type == "pro" ? 1 : 0

  subscription_id              = tonumber(rediscloud_subscription.demo[0].id)
  name                         = var.database_name
  dataset_size_in_gb           = var.dataset_size_in_gb
  throughput_measurement_by    = var.throughput_measurement_by
  throughput_measurement_value = var.throughput_measurement_value
  data_eviction                = var.data_eviction
  data_persistence             = var.data_persistence
  enable_default_user          = true
  enable_tls                   = var.enable_tls
  protocol                     = "redis"
  redis_version                = var.redis_version
  replication                  = var.replication
  support_oss_cluster_api      = false
  password                     = local.redis_password
}

resource "rediscloud_essentials_subscription" "demo" {
  count = local.subscription_type == "essentials" ? 1 : 0

  name              = var.subscription_name
  plan_id           = data.rediscloud_essentials_plan.demo[0].id
  payment_method_id = data.rediscloud_payment_method.default.id
}

resource "rediscloud_essentials_database" "demo" {
  count = local.subscription_type == "essentials" ? 1 : 0

  subscription_id     = rediscloud_essentials_subscription.demo[0].id
  name                = var.database_name
  data_eviction       = var.data_eviction
  data_persistence    = var.data_persistence
  enable_tls          = var.enable_tls
  replication         = var.replication
  enable_default_user = true
  redis_version       = var.redis_version
  password            = local.redis_password
}
