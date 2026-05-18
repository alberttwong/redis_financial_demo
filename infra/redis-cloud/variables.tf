variable "subscription_name" {
  description = "Redis Cloud Essentials subscription name."
  type        = string
  default     = "lpl-redis-demo"
}

variable "database_name" {
  description = "Redis Cloud database name."
  type        = string
  default     = "lpl-query-patterns"
}

variable "cloud_provider" {
  description = "Redis Cloud Essentials cloud provider."
  type        = string
  default     = "AWS"
}

variable "region" {
  description = "Redis Cloud Essentials region."
  type        = string
  default     = "us-west-2"
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
