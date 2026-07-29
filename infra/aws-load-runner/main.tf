locals {
  public_subnet_ids = sort(data.aws_subnets.default_public.ids)
  api_subnet_ids    = var.subnet_id == null ? local.public_subnet_ids : [var.subnet_id]
  redis_cluster_node_count = (
    var.enable_redis_oss_cluster
    ? var.redis_cluster_primary_count * (1 + var.redis_cluster_replicas_per_primary)
    : 0
  )
  redis_cluster_root_nodes = join(",", [
    for instance in aws_instance.redis_oss : "redis://${instance.private_ip}:6379"
  ])
  api_pattern_pool = {
    positionsByAccount     = "positions"
    transactionsByAccount  = "transactions"
    transactionsBySecurity = "transactions"
    accountPortfolioJoin   = "portfolio"
    accountActivityJoin    = "activity"
    accountSnapshot        = "snapshot"
  }
  api_pattern_priorities = {
    positionsByAccount     = 100
    transactionsByAccount  = 101
    transactionsBySecurity = 102
    accountPortfolioJoin   = 103
    accountActivityJoin    = 104
    accountSnapshot        = 105
  }
  tags = merge(
    {
      Project = "lpl-redis-demo"
      Role    = "redis-load-runner"
    },
    var.tags
  )
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "random_password" "redis_oss" {
  count   = var.enable_redis_oss_cluster ? 1 : 0
  length  = 32
  special = false
}

resource "aws_security_group" "redis_oss" {
  count       = var.enable_redis_oss_cluster ? 1 : 0
  name        = "${var.name_prefix}-redis-oss-sg"
  description = "Private Redis OSS Cluster client and cluster-bus access."
  vpc_id      = data.aws_vpc.default.id
  tags = merge(local.tags, {
    Role = "redis-oss-cluster"
  })
}

resource "aws_vpc_security_group_ingress_rule" "redis_oss_ssh" {
  for_each = var.enable_redis_oss_cluster ? toset(var.ssh_ingress_cidr_blocks) : toset([])

  security_group_id = aws_security_group.redis_oss[0].id
  cidr_ipv4         = each.value
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
  description       = "SSH bootstrap access from the benchmark operator"
}

resource "aws_vpc_security_group_ingress_rule" "redis_oss_client" {
  count = var.enable_redis_oss_cluster ? 1 : 0

  security_group_id            = aws_security_group.redis_oss[0].id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = 6379
  ip_protocol                  = "tcp"
  to_port                      = 6379
  description                  = "Redis clients on API and generator hosts"
}

resource "aws_vpc_security_group_ingress_rule" "redis_oss_node_ports" {
  count = var.enable_redis_oss_cluster ? 1 : 0

  security_group_id            = aws_security_group.redis_oss[0].id
  referenced_security_group_id = aws_security_group.redis_oss[0].id
  from_port                    = 6379
  ip_protocol                  = "tcp"
  to_port                      = 16379
  description                  = "Redis client and cluster-bus traffic between cluster nodes"
}

resource "aws_vpc_security_group_egress_rule" "redis_oss_all" {
  count = var.enable_redis_oss_cluster ? 1 : 0

  security_group_id = aws_security_group.redis_oss[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Package and official Redis image downloads"
}

resource "aws_instance" "redis_oss" {
  count                       = local.redis_cluster_node_count
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.redis_cluster_instance_type
  subnet_id                   = coalesce(var.subnet_id, element(local.public_subnet_ids, count.index % length(local.public_subnet_ids)))
  associate_public_ip_address = true
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.redis_oss[0].id]
  monitoring                  = true
  # User-data fixes can be reconciled without discarding a populated cluster.
  user_data_replace_on_change = false
  user_data = templatefile("${path.module}/redis-oss-user-data.sh.tftpl", {
    redis_password     = random_password.redis_oss[0].result
    redis_docker_image = var.redis_cluster_docker_image
  })

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size = 32
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-redis-oss-${format("%02d", count.index + 1)}"
    Role = count.index < var.redis_cluster_primary_count ? "redis-oss-primary" : "redis-oss-replica"
  })
}

resource "terraform_data" "redis_oss_cluster_bootstrap" {
  count = var.enable_redis_oss_cluster ? 1 : 0

  triggers_replace = [
    join(",", aws_instance.redis_oss[*].id),
    sha256(random_password.redis_oss[0].result),
  ]

  connection {
    type        = "ssh"
    host        = aws_instance.redis_oss[0].public_ip
    user        = "ec2-user"
    private_key = file(coalesce(var.ssh_private_key_path, "/dev/null"))
    timeout     = "20m"
  }

  provisioner "remote-exec" {
    inline = [
      "for i in $(seq 1 120); do test -f /opt/redis-oss-node-ready && break; sleep 5; done",
      "test -f /opt/redis-oss-node-ready",
      "sudo docker exec redis-oss redis-cli -a '${random_password.redis_oss[0].result}' --cluster create ${join(" ", formatlist("%s:6379", aws_instance.redis_oss[*].private_ip))} --cluster-replicas ${var.redis_cluster_replicas_per_primary} --cluster-yes",
      "for i in $(seq 1 120); do sudo docker exec redis-oss redis-cli -a '${random_password.redis_oss[0].result}' cluster info | grep -q 'cluster_state:ok' && break; sleep 5; done",
      "sudo docker exec redis-oss redis-cli -a '${random_password.redis_oss[0].result}' cluster info | grep -q 'cluster_state:ok'",
      "sudo touch /opt/redis-oss-cluster-ready",
    ]
  }

  lifecycle {
    precondition {
      condition     = var.ssh_private_key_path != null && var.key_name != null && length(var.ssh_ingress_cidr_blocks) > 0
      error_message = "Redis OSS Cluster bootstrap requires key_name, ssh_private_key_path, and at least one SSH ingress CIDR."
    }
  }

  depends_on = [
    aws_instance.redis_oss,
    aws_vpc_security_group_egress_rule.redis_oss_all,
    aws_vpc_security_group_ingress_rule.redis_oss_client,
    aws_vpc_security_group_ingress_rule.redis_oss_node_ports,
    aws_vpc_security_group_ingress_rule.redis_oss_ssh,
  ]
}

resource "aws_s3_bucket" "deployment" {
  bucket_prefix = "${var.name_prefix}-deploy-"
  force_destroy = true
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "deployment" {
  bucket = aws_s3_bucket.deployment.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deployment" {
  bucket = aws_s3_bucket.deployment.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "deployment" {
  bucket = aws_s3_bucket.deployment.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_object" "deployment_bundle" {
  bucket                 = aws_s3_bucket.deployment.id
  key                    = var.deployment_bundle_key
  source                 = "${path.module}/${var.deployment_bundle_source}"
  etag                   = filemd5("${path.module}/${var.deployment_bundle_source}")
  server_side_encryption = "AES256"

  depends_on = [
    aws_s3_bucket_public_access_block.deployment,
    aws_s3_bucket_server_side_encryption_configuration.deployment,
    aws_s3_bucket_versioning.deployment,
  ]

  # The benchmark runner publishes the current bundle before a fleet refresh.
  # Preserve that known-good object during unrelated Terraform changes.
  lifecycle {
    ignore_changes = [etag]
  }
}

resource "aws_iam_role" "runner" {
  name = "${var.name_prefix}-role"
  tags = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "network_allowance_metrics" {
  name = "${var.name_prefix}-network-allowance-metrics"
  role = aws_iam_role.runner.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "CWAgent"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "deployment_bundle" {
  name = "${var.name_prefix}-deployment-bundle"
  role = aws_iam_role.runner.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.deployment.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.deployment.arn}/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "runner" {
  name = "${var.name_prefix}-profile"
  role = aws_iam_role.runner.name
  tags = local.tags
}

resource "aws_security_group" "runner" {
  name        = "${var.name_prefix}-sg"
  description = "Redis benchmark runner egress and optional SSH ingress."
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidr_blocks)

  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = each.value
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
  description       = "SSH access to benchmark hosts"
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = toset(var.web_ingress_cidr_blocks)

  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = each.value
  from_port         = var.web_port
  ip_protocol       = "tcp"
  to_port           = var.web_port
  description       = "Optional direct HTTP access to API targets"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound access for package installs, S3, and Redis Cloud"
}

resource "aws_security_group" "load_balancer" {
  name        = "${var.name_prefix}-alb-sg"
  description = "Internal load balancer access for the query API pools."
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "web_from_generator" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Private query API access from load generators"
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_api" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Forward query traffic to API targets"
}

resource "aws_vpc_security_group_ingress_rule" "web_from_load_balancer" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.load_balancer.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Query traffic from the internal load balancer"
}

resource "aws_launch_template" "api" {
  for_each = var.api_pool_capacity

  name_prefix            = "${var.name_prefix}-${each.key}-"
  image_id               = data.aws_ami.al2023.id
  instance_type          = lookup(var.api_pool_instance_types, each.key, var.instance_type)
  key_name               = var.key_name
  update_default_version = true
  vpc_security_group_ids = [aws_security_group.runner.id]

  iam_instance_profile {
    name = aws_iam_instance_profile.runner.name
  }

  monitoring {
    enabled = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = var.root_volume_size_gb
      volume_type           = "gp3"
    }
  }

  user_data = base64encode(templatefile("${path.module}/api-user-data.sh.tftpl", {
    aws_region                   = var.aws_region
    bundle_bucket                = aws_s3_bucket.deployment.id
    bundle_key                   = var.deployment_bundle_key
    api_pool                     = each.key
    redis_pool_size              = each.value.redis_pool_size
    web_port                     = var.web_port
    max_concurrency_light        = var.api_pool_capacity["light"].max_concurrency
    max_concurrency_positions    = var.api_pool_capacity["positions"].max_concurrency
    max_concurrency_transactions = var.api_pool_capacity["transactions"].max_concurrency
    max_concurrency_portfolio    = var.api_pool_capacity["portfolio"].max_concurrency
    max_concurrency_activity     = var.api_pool_capacity["activity"].max_concurrency
    max_concurrency_snapshot     = var.api_pool_capacity["snapshot"].max_concurrency
    redis_cluster_environment = var.enable_redis_oss_cluster ? join("\n", [
      "REDIS_CLUSTER_ROOT_NODES=${local.redis_cluster_root_nodes}",
      "REDIS_PASSWORD=${random_password.redis_oss[0].result}",
      "REDIS_TLS=false",
    ]) : ""
  }))

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.tags, {
      Name    = "${var.name_prefix}-api-${each.key}"
      Role    = "redis-query-api-${each.key}"
      ApiPool = each.key
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = local.tags
  }

  tags = local.tags

  depends_on = [aws_s3_object.deployment_bundle, terraform_data.redis_oss_cluster_bootstrap]
}

resource "aws_lb" "api" {
  name               = substr("${var.name_prefix}-api", 0, 32)
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = local.public_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "api" {
  for_each = var.api_pool_capacity

  name                          = substr("${var.name_prefix}-${each.key}", 0, 32)
  port                          = var.web_port
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.default.id
  deregistration_delay          = 15
  load_balancing_algorithm_type = "least_outstanding_requests"
  tags = merge(local.tags, {
    ApiPool = each.key
  })

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
    matcher             = "200"
    path                = "/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
  }
}

resource "aws_autoscaling_group" "api" {
  for_each = var.api_pool_capacity

  name                = "${var.name_prefix}-api-${each.key}"
  min_size            = each.value.min_size
  desired_capacity    = each.value.desired_capacity
  max_size            = each.value.max_size
  vpc_zone_identifier = local.api_subnet_ids
  target_group_arns   = [aws_lb_target_group.api[each.key].arn]
  # The runner performs explicit application and target-group readiness checks.
  # EC2 health prevents a missing or broken bundle from causing unbounded
  # replacement churn while those bounded checks fail closed.
  health_check_type         = "EC2"
  health_check_grace_period = 900
  wait_for_capacity_timeout = "25m"

  launch_template {
    id      = aws_launch_template.api[each.key].id
    version = aws_launch_template.api[each.key].latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      instance_warmup        = 900
      min_healthy_percentage = 50
    }
    triggers = ["tag"]
  }

  dynamic "tag" {
    for_each = merge(local.tags, {
      Name    = "${var.name_prefix}-api-${each.key}"
      Role    = "redis-query-api-${each.key}"
      ApiPool = each.key
    })
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_policy" "api_request_count" {
  for_each = var.enable_api_autoscaling ? var.api_pool_capacity : {}

  name                   = "${var.name_prefix}-${each.key}-request-count"
  autoscaling_group_name = aws_autoscaling_group.api[each.key].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label = join("/", [
        aws_lb.api.arn_suffix,
        aws_lb_target_group.api[each.key].arn_suffix
      ])
    }
    target_value = each.value.request_count_target_per_minute
  }
}

resource "aws_instance" "generator" {
  count                       = var.generator_instance_count
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.generator_instance_type
  subnet_id                   = coalesce(var.subnet_id, element(local.public_subnet_ids, count.index % length(local.public_subnet_ids)))
  associate_public_ip_address = true
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.runner.id]
  iam_instance_profile        = aws_iam_instance_profile.runner.name
  monitoring                  = true
  user_data_replace_on_change = true
  user_data                   = file("${path.module}/user-data.sh")
  tags = merge(local.tags, {
    Name = "${var.name_prefix}-generator-${format("%02d", count.index + 1)}"
    Role = "redis-load-generator"
  })

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = var.web_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api["light"].arn
  }
}

resource "aws_lb_listener_rule" "api_pool" {
  for_each = local.api_pattern_pool

  listener_arn = aws_lb_listener.api.arn
  priority     = local.api_pattern_priorities[each.key]

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[each.value].arn
  }

  condition {
    query_string {
      key   = "pattern"
      value = each.key
    }
  }
}
