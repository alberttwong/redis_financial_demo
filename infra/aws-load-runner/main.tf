locals {
  public_subnet_ids = sort(data.aws_subnets.default_public.ids)
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
  description       = "SSH access to the benchmark runner"
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = toset(var.web_ingress_cidr_blocks)

  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = each.value
  from_port         = var.web_port
  ip_protocol       = "tcp"
  to_port           = var.web_port
  description       = "HTTP access to the ad hoc query workbench"
}

resource "aws_vpc_security_group_ingress_rule" "web_from_generator" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Private query API access from the load generator to the load balancer"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound access for package installs and Redis Cloud"
}

resource "aws_security_group" "load_balancer" {
  name        = "${var.name_prefix}-alb-sg"
  description = "Internal load balancer access for the horizontally scaled query API."
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_api" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.runner.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Forward query traffic to API workers"
}

resource "aws_vpc_security_group_ingress_rule" "web_from_load_balancer" {
  security_group_id            = aws_security_group.runner.id
  referenced_security_group_id = aws_security_group.load_balancer.id
  from_port                    = var.web_port
  ip_protocol                  = "tcp"
  to_port                      = var.web_port
  description                  = "Query traffic from the internal load balancer"
}

moved {
  from = aws_instance.runner
  to   = aws_instance.api[0]
}

resource "aws_instance" "api" {
  count                       = var.api_instance_count
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = coalesce(var.subnet_id, element(local.public_subnet_ids, count.index % length(local.public_subnet_ids)))
  associate_public_ip_address = true
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.runner.id]
  iam_instance_profile        = aws_iam_instance_profile.runner.name
  monitoring                  = true
  user_data_replace_on_change = true
  user_data                   = file("${path.module}/user-data.sh")
  tags = merge(local.tags, {
    Name = "${var.name_prefix}-api-${format("%02d", count.index + 1)}"
    Role = "redis-query-api"
  })

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }
}

moved {
  from = aws_instance.generator
  to   = aws_instance.generator[0]
}

resource "aws_instance" "generator" {
  count                       = var.generator_instance_count
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.generator_instance_type
  subnet_id                   = coalesce(var.subnet_id, element(data.aws_subnets.default_public.ids, count.index % length(data.aws_subnets.default_public.ids)))
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

resource "aws_lb" "api" {
  name               = "${var.name_prefix}-api"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = local.public_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "api" {
  name                          = "${var.name_prefix}-api"
  port                          = var.web_port
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.default.id
  deregistration_delay          = 15
  load_balancing_algorithm_type = "round_robin"
  tags                          = local.tags

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

resource "aws_lb_target_group_attachment" "api" {
  count            = var.api_instance_count
  target_group_arn = aws_lb_target_group.api.arn
  target_id        = aws_instance.api[count.index].id
  port             = var.web_port
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = var.web_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
