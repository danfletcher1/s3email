output "rule_name" {
  description = "Name of the SES receipt rule created."
  value       = aws_ses_receipt_rule.main.name
}

output "domain_verification_token" {
  description = "TXT record value for manual domain verification (typically handled via MX/SPF DNS records already set)."
  value       = aws_ses_domain_identity.main.verification_token
}

output "dkim_tokens" {
  description = "The three DKIM CNAME record values to add to DNS. Each token maps to a CNAME: {token}._domainkey.{domain} → {token}.dkim.amazonses.com"
  value       = aws_ses_domain_dkim.main.dkim_tokens
}
