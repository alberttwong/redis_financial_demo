variable "aws_region" {
  description = "AWS region for the direct Redis load generators."
  type        = string
  default     = "us-west-2"
}

variable "name_prefix" {
  description = "Name prefix for direct Redis benchmark resources."
  type        = string
  default     = "lpl-redis-direct"
}

variable "generator_instance_type" {
  description = "EC2 instance type for each direct Redis generator."
  type        = string
  default     = "c7i.2xlarge"
}

variable "generator_instance_count" {
  description = "Number of direct Redis generator instances."
  type        = number
  default     = 32

  validation {
    condition     = var.generator_instance_count >= 1 && var.generator_instance_count <= 64
    error_message = "generator_instance_count must be between 1 and 64."
  }
}

variable "key_name" {
  description = "Existing EC2 key pair used to manage the generators."
  type        = string
  default     = null
  nullable    = true
}

variable "ssh_ingress_cidr_blocks" {
  description = "CIDR blocks allowed to SSH to generators."
  type        = list(string)
  default     = []
}

variable "subnet_id" {
  description = "Optional public subnet. By default generators are spread across public subnets in the default VPC."
  type        = string
  default     = null
  nullable    = true
}

variable "root_volume_size_gb" {
  description = "Encrypted gp3 root volume size for each generator."
  type        = number
  default     = 32
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default = {
    owner = "albert_wong"
  }
}
