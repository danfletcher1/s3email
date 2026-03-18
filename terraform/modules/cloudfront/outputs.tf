output "domain_name" {
  description = "CloudFront distribution domain name (e.g. d1234abcd.cloudfront.net)."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID, used for cache invalidations."
  value       = aws_cloudfront_distribution.main.id
}
