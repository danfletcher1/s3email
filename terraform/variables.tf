variable "aws_region" {
  description = "AWS region to deploy all resources into."
  type        = string
}

variable "bucket_name" {
  description = "Name of the S3 bucket (must be globally unique). Stores both email data and the static frontend app."
  type        = string
}

variable "domain_name" {
  description = "Domain name that SES is already configured to receive email for (e.g. example.com)."
  type        = string
}

variable "ses_rule_set_name" {
  description = "Name for the SES receipt rule set (created and activated by Terraform). Use a name like 's3email-ruleset'."
  type        = string
}

variable "cognito_domain_prefix" {
  description = "Subdomain prefix for the Cognito Hosted UI. Must be globally unique across all AWS accounts."
  type        = string
}

variable "trash_retention_days" {
  description = "Number of days to keep soft-deleted emails before S3 permanently removes them."
  type        = number
  default     = 30
}

variable "spam_retention_days" {
  description = "Number of days to keep spam emails before S3 permanently removes them."
  type        = number
  default     = 30
}

variable "quarantine_retention_days" {
  description = "Number of days to keep quarantined emails before S3 permanently removes them."
  type        = number
  default     = 30
}

variable "cold_ia_days" {
  description = "Days before body/attachment objects (>128 KB, tagged tier=cold) transition from Standard to Standard-IA."
  type        = number
  default     = 60
}

variable "cold_glacier_days" {
  description = "Days before body/attachment objects (>128 KB, tagged tier=cold) transition from Standard-IA to Glacier Instant Retrieval."
  type        = number
  default     = 210
}

variable "alarm_notification_email" {
  description = "Email address to receive CloudWatch alarm notifications (virus detected, processing errors, etc.)."
  type        = string
}
