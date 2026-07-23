variable "aws_region" {
  description = "AWS region for the retained Redis Cloud RDB backup bucket."
  type        = string
  default     = "us-west-2"
}

variable "bucket_prefix" {
  description = "Globally unique bucket name prefix; AWS adds a suffix."
  type        = string
  default     = "lpl-redis-benchmark-rdb-"
}

variable "backup_prefix" {
  description = "Object prefix used for versioned backup runs and manifests."
  type        = string
  default     = "redis-cloud"
}

variable "backup_retention_days" {
  description = "Optional days to retain dated RDB backups. Null keeps the seed backup until explicitly removed."
  type        = number
  default     = null

  validation {
    condition     = var.backup_retention_days == null || var.backup_retention_days >= 1
    error_message = "backup_retention_days must be null or at least 1."
  }
}

variable "force_destroy" {
  description = "Allow Terraform to delete a non-empty backup bucket. Keep false for benchmark teardown safety."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags for the retained benchmark dataset bucket."
  type        = map(string)
  default     = {}
}
