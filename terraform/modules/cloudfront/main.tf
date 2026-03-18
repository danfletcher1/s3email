# CloudFront distribution — serves the /app/ frontend over HTTPS.
# Origin is the S3 static website endpoint (HTTP only from CF to S3;
# CloudFront terminates TLS for the browser).
resource "aws_cloudfront_distribution" "main" {
  origin {
    domain_name = var.s3_website_endpoint
    origin_id   = "s3-website"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # S3 website endpoints don't support HTTPS
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  enabled             = true
  default_root_object = "app/index.html"
  price_class         = "PriceClass_100" # US, Canada, Europe

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-website"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Project = "s3email"
  }
}
