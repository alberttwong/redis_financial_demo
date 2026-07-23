locals {
  aws_vpc_peering_enabled = (
    var.enable_aws_vpc_peering
    && local.subscription_type == "pro"
    && upper(var.cloud_provider) == "AWS"
  )
}

data "aws_caller_identity" "benchmark" {
  count = local.aws_vpc_peering_enabled ? 1 : 0
}

data "aws_vpc" "benchmark" {
  count = local.aws_vpc_peering_enabled ? 1 : 0

  id      = var.aws_vpc_id
  default = var.aws_vpc_id == null ? true : null
}

data "aws_route_tables" "benchmark" {
  count = local.aws_vpc_peering_enabled ? 1 : 0

  vpc_id = data.aws_vpc.benchmark[0].id
}

resource "rediscloud_subscription_peering" "benchmark" {
  count = local.aws_vpc_peering_enabled ? 1 : 0

  subscription_id = tonumber(rediscloud_subscription.demo[0].id)
  provider_name   = "AWS"
  region          = var.region
  aws_account_id  = data.aws_caller_identity.benchmark[0].account_id
  vpc_id          = data.aws_vpc.benchmark[0].id
  vpc_cidr        = data.aws_vpc.benchmark[0].cidr_block

  timeouts {
    create = "20m"
    delete = "20m"
  }
}

resource "aws_vpc_peering_connection_accepter" "rediscloud" {
  count = local.aws_vpc_peering_enabled ? 1 : 0

  vpc_peering_connection_id = rediscloud_subscription_peering.benchmark[0].aws_peering_id
  auto_accept               = true

  tags = {
    Name      = "${var.subscription_name}-redis-cloud"
    ManagedBy = "terraform"
    Purpose   = "redis-cloud-private-metrics"
  }
}

resource "aws_route" "rediscloud" {
  for_each = local.aws_vpc_peering_enabled ? toset(data.aws_route_tables.benchmark[0].ids) : toset([])

  route_table_id            = each.value
  destination_cidr_block    = var.networking_deployment_cidr
  vpc_peering_connection_id = rediscloud_subscription_peering.benchmark[0].aws_peering_id

  depends_on = [aws_vpc_peering_connection_accepter.rediscloud]
}
