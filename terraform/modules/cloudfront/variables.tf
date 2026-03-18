variable "s3_website_endpoint" {
  description = "S3 website endpoint hostname (without protocol), e.g. bucket.s3-website.eu-west-1.amazonaws.com."
  type        = string
}

variable "bucket_name" {
  description = "S3 bucket name, used for tagging."
  type        = string
}
