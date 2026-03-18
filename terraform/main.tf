terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# S3 — email storage + static frontend hosting
# ---------------------------------------------------------------------------
module "s3" {
  source = "./modules/s3"

  bucket_name               = var.bucket_name
  trash_retention_days      = var.trash_retention_days
  spam_retention_days       = var.spam_retention_days
  quarantine_retention_days = var.quarantine_retention_days
  pruner_function_arn        = module.lambda.pruner_function_arn
  pruner_invoke_permission_id = module.lambda.pruner_invoke_permission_id
  cold_ia_days              = var.cold_ia_days
  cold_glacier_days         = var.cold_glacier_days
}

# ---------------------------------------------------------------------------
# CloudFront — HTTPS distribution in front of the S3 static website
# ---------------------------------------------------------------------------
module "cloudfront" {
  source              = "./modules/cloudfront"

  s3_website_endpoint = module.s3.website_endpoint
  bucket_name         = var.bucket_name
}

# ---------------------------------------------------------------------------
# Lambda — SES-invoked email router and processor
# ---------------------------------------------------------------------------
module "lambda" {
  source = "./modules/lambda"

  bucket_name = var.bucket_name
  bucket_arn  = module.s3.bucket_arn
}

# ---------------------------------------------------------------------------
# SES — receipt rule attaching Lambda action to existing rule set
# ---------------------------------------------------------------------------
module "ses" {
  source = "./modules/ses"

  domain_name       = var.domain_name
  ses_rule_set_name = var.ses_rule_set_name
  lambda_arn        = module.lambda.function_arn
  bucket_name       = var.bucket_name
}

# ---------------------------------------------------------------------------
# Cognito — User Pool, Hosted UI, Identity Pool with per-user IAM scoping
# ---------------------------------------------------------------------------
module "cognito" {
  source = "./modules/cognito"

  aws_region            = var.aws_region
  domain_name           = var.domain_name
  cognito_domain_prefix = var.cognito_domain_prefix
  app_callback_urls     = ["https://${module.cloudfront.domain_name}/app/"]
  app_logout_urls       = ["https://${module.cloudfront.domain_name}/app/"]
  bucket_arn            = module.s3.bucket_arn
  bucket_name           = var.bucket_name
}

# ---------------------------------------------------------------------------
# Monitoring — CloudWatch Log Group, Metric Filters, Alarms, Dashboard
# ---------------------------------------------------------------------------
module "monitoring" {
  source = "./modules/monitoring"

  aws_region               = var.aws_region
  lambda_function_name     = module.lambda.function_name
  lambda_log_group_name    = module.lambda.log_group_name
  pruner_function_name     = module.lambda.pruner_function_name
  pruner_log_group_name    = module.lambda.pruner_log_group_name
  router_dlq_name          = module.lambda.router_dlq_name
  pruner_dlq_name          = module.lambda.pruner_dlq_name
  alarm_notification_email = var.alarm_notification_email
}
