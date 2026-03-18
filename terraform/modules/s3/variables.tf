variable "bucket_name" {
  description = "Name of the S3 bucket (must be globally unique)."
  type        = string
}

variable "trash_retention_days" {
  description = "Days before objects tagged lifecycle=trash are permanently deleted by S3 lifecycle rule."
  type        = number
  default     = 30
}

variable "spam_retention_days" {
  description = "Days before objects tagged lifecycle=spam are permanently deleted by S3 lifecycle rule."
  type        = number
  default     = 30
}

variable "quarantine_retention_days" {
  description = "Days before objects tagged lifecycle=quarantine are permanently deleted by S3 lifecycle rule."
  type        = number
  default     = 30
}

variable "pruner_function_arn" {
  description = "ARN of the pruner Lambda function to invoke on S3 lifecycle expiry events."
  type        = string
}

variable "pruner_invoke_permission_id" {
  description = "ID of the Lambda permission resource that allows S3 to invoke the pruner (used as depends_on)."
  type        = string
}

variable "cold_ia_days" {
  description = "Days after write before body/attachment objects (tagged tier=cold, >128 KB) transition to Standard-IA."
  type        = number
  default     = 60
}

variable "cold_glacier_days" {
  description = "Days after write before body/attachment objects (tagged tier=cold, >128 KB) transition to Glacier Instant Retrieval."
  type        = number
  default     = 210
}
