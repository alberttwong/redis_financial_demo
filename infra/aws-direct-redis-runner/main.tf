locals {
  public_subnet_ids = sort(data.aws_subnets.default_public.ids)
  tags = merge(
    {
      Project      = "lpl-redis-demo"
      Role         = "redis-direct-load-generator"
      Architecture = "direct-resp"
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

resource "aws_iam_role" "generator" {
  name = "${var.name_prefix}-role"
  tags = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.generator.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "network_allowance_metrics" {
  name = "${var.name_prefix}-network-allowance-metrics"
  role = aws_iam_role.generator.id
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

resource "aws_iam_instance_profile" "generator" {
  name = "${var.name_prefix}-profile"
  role = aws_iam_role.generator.name
  tags = local.tags
}

resource "aws_security_group" "generator" {
  name        = "${var.name_prefix}-sg"
  description = "Direct Redis generator egress and operator SSH."
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.ssh_ingress_cidr_blocks)

  security_group_id = aws_security_group.generator.id
  cidr_ipv4         = each.value
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
  description       = "Benchmark operator SSH"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.generator.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Redis Cloud, package, and SSM access"
}

resource "aws_instance" "generator" {
  count                       = var.generator_instance_count
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.generator_instance_type
  subnet_id                   = coalesce(var.subnet_id, element(local.public_subnet_ids, count.index % length(local.public_subnet_ids)))
  associate_public_ip_address = true
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.generator.id]
  iam_instance_profile        = aws_iam_instance_profile.generator.name
  monitoring                  = true
  user_data_replace_on_change = true
  user_data                   = file("${path.module}/../aws-load-runner/user-data.sh")

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.tags, {
    Name = "${var.name_prefix}-generator-${format("%02d", count.index + 1)}"
  })
}
