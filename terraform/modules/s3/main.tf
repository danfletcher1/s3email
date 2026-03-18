data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "main" {
  bucket = var.bucket_name
}

# Enforce bucket owner for all objects — disables ACLs entirely (modern S3 best practice)
resource "aws_s3_bucket_ownership_controls" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Allow the /app/* public-read bucket policy but block all public ACLs
resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false

  depends_on = [aws_s3_bucket_ownership_controls.main]
}

# Static website hosting — serves the /app/ frontend.
# The app lives at app/index.html.
# Requests to the bucket root 404 → fall through to error_document (app/index.html).
# Direct access to /app/ or /app/index.html works naturally via the index_document suffix.
resource "aws_s3_bucket_website_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "app/index.html"
  }
}

# Public read restricted to /app/* prefix only — all email data remains private.
# SES is permitted to PutObject under raw/* so it can stage emails for Lambda to read.
resource "aws_s3_bucket_policy" "main" {
  bucket     = aws_s3_bucket.main.id
  depends_on = [aws_s3_bucket_public_access_block.main]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadAppPrefix"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.main.arn}/app/*"
      },
      {
        Sid       = "SESPutRaw"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.main.arn}/raw/*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# CORS — required for browser AWS SDK to make requests to the S3 REST API endpoint
resource "aws_s3_bucket_cors_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "DELETE", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag", "x-amz-request-id", "x-amz-id-2"]
    max_age_seconds = 3000
  }
}

# Lifecycle rules — expire objects by tag. header.json is tagged by Lambda (spam/quarantine)
# or by the browser (trash) at action time. S3 expiry fires the pruner Lambda which cleans
# up remaining {uuid}/* objects and patches the relevant *.index.json file.
resource "aws_s3_bucket_lifecycle_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  rule {
    id     = "expire-trash"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "trash"
      }
    }
    expiration { days = var.trash_retention_days }
  }

  rule {
    id     = "expire-spam"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "spam"
      }
    }
    expiration { days = var.spam_retention_days }
  }

  rule {
    id     = "expire-quarantine"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "quarantine"
      }
    }
    expiration { days = var.quarantine_retention_days }
  }

  # Safety net: expire raw MIME staging objects if Lambda crashes before deleting them.
  # Under normal operation Lambda deletes raw/{messageId} immediately after parsing.
  rule {
    id     = "expire-raw"
    status = "Enabled"
    filter { prefix = "raw/" }
    expiration { days = 1 }
  }

  # Transition body and attachment objects (tagged tier=cold) to cheaper storage over time.
  # Objects < 128 KB are excluded — IA and Glacier IR both charge a 128 KB minimum,
  # so tiering small text bodies or tiny attachments would cost more, not less.
  rule {
    id     = "cold-to-ia"
    status = "Enabled"
    filter {
      and {
        tags                     = { tier = "cold" }
        object_size_greater_than = 131072
      }
    }
    transition {
      days          = var.cold_ia_days
      storage_class = "STANDARD_IA"
    }
  }

  rule {
    id     = "cold-to-glacier"
    status = "Enabled"
    filter {
      and {
        tags                     = { tier = "cold" }
        object_size_greater_than = 131072
      }
    }
    transition {
      days          = var.cold_glacier_days
      storage_class = "GLACIER_IR"
    }
  }
}

# Notify the pruner Lambda when S3 lifecycle expires a header.json object.
# Suffix filter ensures exactly one event per email (body/attachment expiry is silent).
resource "aws_s3_bucket_notification" "lifecycle_expiry" {
  bucket = aws_s3_bucket.main.id

  lambda_function {
    lambda_function_arn = var.pruner_function_arn
    events              = ["s3:LifecycleExpiration:Delete"]
    filter_suffix       = "/header.json"
  }

  depends_on = [var.pruner_invoke_permission_id]
}
