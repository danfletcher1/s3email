output "bucket_name" {
  description = "Name of the S3 bucket."
  value       = aws_s3_bucket.main.bucket
}

output "bucket_arn" {
  description = "ARN of the S3 bucket."
  value       = aws_s3_bucket.main.arn
}

output "website_endpoint" {
  description = "S3 static website hostname (deploy.sh prepends http://)."
  value       = aws_s3_bucket_website_configuration.main.website_endpoint
}
