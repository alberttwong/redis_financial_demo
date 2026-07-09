variable "subscription_name" {
  description = "Redis Cloud subscription name."
  type        = string
  default     = "lpl-redis-demo"
}

variable "database_name" {
  description = "Redis Cloud database name."
  type        = string
  default     = "lpl-query-patterns"
}

variable "cloud_provider" {
  description = "Redis Cloud cloud provider."
  type        = string
  default     = "AWS"
}

variable "region" {
  description = "Redis Cloud region."
  type        = string
  default     = "us-west-2"
}

variable "subscription_type" {
  description = "Redis Cloud subscription family. Pro is the default target for the 300 GB / 180k ops/sec demo; Essentials remains available for smaller local demos."
  type        = string
  default     = "pro"

  validation {
    condition     = contains(["pro", "essentials"], lower(var.subscription_type))
    error_message = "subscription_type must be pro or essentials."
  }
}

variable "payment_method" {
  description = "Payment method type for Pro/Flexible subscriptions. credit-card uses the Redis Cloud account default payment method."
  type        = string
  default     = "credit-card"
}

variable "public_endpoint_access" {
  description = "Enable public endpoint access for the Redis Cloud Pro/Flexible subscription."
  type        = bool
  default     = true
}

variable "networking_deployment_cidr" {
  description = "Redis Cloud Pro/Flexible deployment CIDR for the managed VPC."
  type        = string
  default     = "10.90.0.0/24"
}

variable "multiple_availability_zones" {
  description = "Deploy the Redis Cloud Pro/Flexible subscription across multiple availability zones."
  type        = bool
  default     = false
}

variable "dataset_size_in_gb" {
  description = "Redis Cloud Pro/Flexible database dataset size in GB."
  type        = number
  default     = 300
}

variable "throughput_measurement_by" {
  description = "Redis Cloud Pro/Flexible throughput sizing method."
  type        = string
  default     = "operations-per-second"

  validation {
    condition     = contains(["operations-per-second", "number-of-shards"], var.throughput_measurement_by)
    error_message = "throughput_measurement_by must be operations-per-second or number-of-shards."
  }
}

variable "throughput_measurement_value" {
  description = "Redis Cloud Pro/Flexible throughput target. With operations-per-second, this is the requested ops/sec capacity."
  type        = number
  default     = 180000
}

variable "redis_version" {
  description = "Redis database version to provision."
  type        = string
  default     = "8.4"
}

variable "essentials_plan_id" {
  description = "Optional Redis Cloud Essentials plan ID. When null, Terraform looks up a paid Essentials plan by filters."
  type        = string
  default     = null
}

variable "essentials_plan_name" {
  description = "Redis Cloud Essentials plan name used when essentials_plan_id is null."
  type        = string
  default     = "250MB"
}

variable "essentials_plan_availability" {
  description = "Redis Cloud Essentials plan availability."
  type        = string
  default     = "No replication"

  validation {
    condition     = contains(["No replication", "Single-zone", "Multi-zone"], var.essentials_plan_availability)
    error_message = "essentials_plan_availability must be No replication, Single-zone, or Multi-zone."
  }
}

variable "data_persistence" {
  description = "Redis Cloud database persistence policy."
  type        = string
  default     = "none"
}

variable "data_eviction" {
  description = "Redis Cloud database eviction policy."
  type        = string
  default     = "noeviction"
}

variable "enable_tls" {
  description = "Enable TLS for the Redis Cloud database endpoint."
  type        = bool
  default     = true
}

variable "replication" {
  description = "Enable Redis Cloud database replication when supported by the selected plan."
  type        = bool
  default     = false
}

variable "redis_password" {
  description = "Optional Redis database password. A random password is generated when unset."
  type        = string
  sensitive   = true
  default     = null
}
