output "user_pool_id" {
  description = "Cognito User Pool ID."
  value       = aws_cognito_user_pool.main.id
}

output "app_client_id" {
  description = "Cognito App Client ID."
  value       = aws_cognito_user_pool_client.main.id
}

output "hosted_ui_domain" {
  description = "Full Cognito Hosted UI base URL."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "identity_pool_id" {
  description = "Cognito Identity Pool ID."
  value       = aws_cognito_identity_pool.main.id
}
