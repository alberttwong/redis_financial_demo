variable "aws_region" {
  description = "AWS region for the load-test runner."
  type        = string
  default     = "us-west-2"
}

variable "name_prefix" {
  description = "Name prefix for load-runner resources."
  type        = string
  default     = "lpl-redis-load-runner"
}

variable "instance_type" {
  description = "EC2 instance type for each query API target."
  type        = string
  default     = "c7i.large"
}

variable "api_pool_capacity" {
  description = "Independent capacity, Redis connections, admission limits, and target-tracking thresholds for each API pool. Request targets are requests per target per minute."
  type = map(object({
    min_size                        = number
    desired_capacity                = number
    max_size                        = number
    redis_pool_size                 = number
    max_concurrency                 = number
    request_count_target_per_minute = number
  }))
  default = {
    light = {
      min_size                        = 16
      desired_capacity                = 16
      max_size                        = 128
      redis_pool_size                 = 32
      max_concurrency                 = 128
      request_count_target_per_minute = 30000
    }
    positions = {
      min_size                        = 4
      desired_capacity                = 4
      max_size                        = 128
      redis_pool_size                 = 32
      max_concurrency                 = 32
      request_count_target_per_minute = 6000
    }
    transactions = {
      min_size                        = 8
      desired_capacity                = 8
      max_size                        = 128
      redis_pool_size                 = 32
      max_concurrency                 = 32
      request_count_target_per_minute = 12000
    }
    portfolio = {
      min_size                        = 16
      desired_capacity                = 16
      max_size                        = 128
      redis_pool_size                 = 32
      max_concurrency                 = 16
      request_count_target_per_minute = 30000
    }
    activity = {
      min_size                        = 16
      desired_capacity                = 16
      max_size                        = 256
      redis_pool_size                 = 32
      max_concurrency                 = 16
      request_count_target_per_minute = 12000
    }
    snapshot = {
      min_size                        = 4
      desired_capacity                = 4
      max_size                        = 128
      redis_pool_size                 = 32
      max_concurrency                 = 32
      request_count_target_per_minute = 6000
    }
  }

  validation {
    condition = length(keys(var.api_pool_capacity)) == 6 && alltrue([
      for pool in ["light", "positions", "transactions", "portfolio", "activity", "snapshot"] :
      contains(keys(var.api_pool_capacity), pool)
    ])
    error_message = "api_pool_capacity must define exactly light, positions, transactions, portfolio, activity, and snapshot."
  }

  validation {
    condition = alltrue([
      for pool in values(var.api_pool_capacity) :
      pool.min_size >= 1 &&
      pool.desired_capacity >= pool.min_size &&
      pool.max_size >= pool.desired_capacity &&
      pool.max_size <= 256 &&
      pool.redis_pool_size >= 1 &&
      pool.max_concurrency >= 1 &&
      pool.request_count_target_per_minute >= 1
    ])
    error_message = "Each API pool must have 1 <= min <= desired <= max <= 256 and positive pool, concurrency, and request-target values."
  }
}

variable "enable_api_autoscaling" {
  description = "Enable ALB request-count target tracking for each API pool. Keep false until per-target staircase calibration establishes safe thresholds."
  type        = bool
  default     = false
}

variable "deployment_bundle_key" {
  description = "Private S3 object key used to bootstrap and refresh API instances."
  type        = string
  default     = "deploy/api-bundle.tgz"
}

variable "deployment_bundle_source" {
  description = "Bundle path relative to this Terraform module. Build it before planning so API instances cannot launch ahead of their application."
  type        = string
  default     = "api-bundle.tgz"
}

variable "generator_instance_type" {
  description = "EC2 instance type for each dedicated load-generator host."
  type        = string
  default     = "c7i.large"
}

variable "generator_instance_count" {
  description = "Number of dedicated load-generator hosts distributed across the available public subnets."
  type        = number
  default     = 9

  validation {
    condition     = var.generator_instance_count >= 1 && var.generator_instance_count <= 32
    error_message = "generator_instance_count must be between 1 and 32."
  }
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH access. Leave null when using SSM only."
  type        = string
  default     = null
}

variable "ssh_ingress_cidr_blocks" {
  description = "CIDR blocks allowed to SSH to the runner. Leave empty to keep SSH closed."
  type        = list(string)
  default     = []
}

variable "web_ingress_cidr_blocks" {
  description = "CIDR blocks allowed to reach API targets directly on web_port. Leave empty to keep direct access closed."
  type        = list(string)
  default     = []
}

variable "web_port" {
  description = "Port exposed by each Next.js API target."
  type        = number
  default     = 3000
}

variable "subnet_id" {
  description = "Optional public subnet ID. Defaults to all public subnets in the default VPC."
  type        = string
  default     = null
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size for repo, Node modules, and benchmark artifacts."
  type        = number
  default     = 64
}

variable "tags" {
  description = "Extra tags to add to all resources. The default owner tag is required by the AWS account cleanup automation."
  type        = map(string)
  default = {
    owner = "albert_wong"
  }
}
