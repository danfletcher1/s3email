variable "domain_name" {
  description = "Domain that SES will receive email for (e.g. example.com). DNS MX/SPF records must already point to SES for this domain."
  type        = string
}

variable "ses_rule_set_name" {
  description = "Name for the SES receipt rule set. Created and activated by Terraform — use a name like 's3email-ruleset'."
  type        = string
}

variable "lambda_arn" {
  description = "ARN of the Lambda function to invoke on email receipt."
  type        = string
}

variable "bucket_name" {
  description = "Name of the S3 bucket where SES stores the raw email before Lambda processes it."
  type        = string
}
