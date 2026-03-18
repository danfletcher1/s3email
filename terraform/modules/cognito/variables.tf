variable "aws_region" {
  description = "AWS region (used to construct Hosted UI URL)."
  type        = string
}

variable "domain_name" {
  description = "Email domain being served (used in resource descriptions)."
  type        = string
}

variable "cognito_domain_prefix" {
  description = "Subdomain prefix for Cognito Hosted UI. Must be globally unique across all AWS accounts."
  type        = string
}

variable "app_callback_urls" {
  description = "OAuth callback URLs Cognito redirects to after successful login."
  type        = list(string)
}

variable "app_logout_urls" {
  description = "OAuth logout redirect URLs Cognito redirects to after sign-out."
  type        = list(string)
}

variable "bucket_arn" {
  description = "ARN of the S3 bucket (used to scope the authenticated IAM policy)."
  type        = string
}

variable "bucket_name" {
  description = "Name of the S3 bucket."
  type        = string
}
