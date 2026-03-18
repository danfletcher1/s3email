output "aws_region" {
  description = "AWS region all resources are deployed into."
  value       = var.aws_region
}

output "account_id" {
  description = "AWS account ID — used in config.json for Cognito Identity GetId."
  value       = data.aws_caller_identity.current.account_id
}

output "bucket_name" {
  description = "Name of the S3 bucket."
  value       = module.s3.bucket_name
}

output "app_url" {
  description = "HTTPS URL of the frontend via CloudFront."
  value       = module.cloudfront.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID, used for cache invalidations."
  value       = module.cloudfront.distribution_id
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID — used in config.json."
  value       = module.cognito.user_pool_id
}

output "cognito_app_client_id" {
  description = "Cognito App Client ID — used in config.json."
  value       = module.cognito.app_client_id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain — used in config.json."
  value       = module.cognito.hosted_ui_domain
}

output "cognito_identity_pool_id" {
  description = "Cognito Identity Pool ID — used in config.json."
  value       = module.cognito.identity_pool_id
}

output "lambda_function_arn" {
  description = "ARN of the email router Lambda function."
  value       = module.lambda.function_arn
}

output "ses_dkim_tokens" {
  description = "Three DKIM CNAME values to add to DNS. For each token, add: {token}._domainkey.{domain} CNAME {token}.dkim.amazonses.com"
  value       = module.ses.dkim_tokens
}

output "cloudwatch_dashboard_url" {
  description = "URL to the CloudWatch monitoring dashboard."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${module.monitoring.dashboard_name}"
}
