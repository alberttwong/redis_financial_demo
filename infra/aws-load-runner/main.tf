locals {
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

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.runner.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound access for package installs and Redis Cloud"
}

resource "aws_instance" "runner" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.instance_type
  subnet_id                   = coalesce(var.subnet_id, data.aws_subnets.default_public.ids[0])
  associate_public_ip_address = true
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.runner.id]
  iam_instance_profile        = aws_iam_instance_profile.runner.name
  user_data_replace_on_change = true
  user_data                   = file("${path.module}/user-data.sh")
  tags = merge(local.tags, {
    Name = var.name_prefix
  })

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }
}
