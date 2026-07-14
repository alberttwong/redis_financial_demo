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
  description = "EC2 instance type for the dedicated query API host."
  type        = string
  default     = "c7i.4xlarge"
}

variable "generator_instance_type" {
  description = "EC2 instance type for the dedicated load-generator host."
  type        = string
  default     = "c7i.4xlarge"
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
  description = "CIDR blocks allowed to reach the ad hoc query workbench on web_port. Leave empty to keep the website private."
  type        = list(string)
  default     = []
}

variable "web_port" {
  description = "Port exposed by Next.js for the ad hoc query workbench."
  type        = number
  default     = 3000
}

variable "subnet_id" {
  description = "Optional public subnet ID. Defaults to the first public subnet in the default VPC."
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
