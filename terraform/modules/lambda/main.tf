data "aws_caller_identity" "current" {}

# Package the Lambda source directory into a zip at plan/apply time.
# deploy.sh runs `npm install` in lambda/router/ before calling terraform apply,
# so node_modules is present when this archive is built.
data "archive_file" "router" {
  type        = "zip"
  source_dir  = "${path.root}/../lambda/router"
  output_path = "${path.module}/router.zip"
}

# Manage the log group explicitly so Terraform controls retention and metric filters
# (prevents Lambda auto-creating an unmanaged group on first invocation)
resource "aws_cloudwatch_log_group" "main" {
  name              = "/aws/lambda/s3email-router"
  retention_in_days = 90
}

# IAM execution role for Lambda
resource "aws_iam_role" "lambda" {
  name = "s3email-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Allow Lambda to write logs to CloudWatch
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---------------------------------------------------------------------------
# Dead-letter queues — catch events that exhaust Lambda async retries
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "router_dlq" {
  name                      = "s3email-router-dlq"
  message_retention_seconds = 604800 # 7 days — full operational window to investigate failures
}

resource "aws_sqs_queue" "pruner_dlq" {
  name                      = "s3email-pruner-dlq"
  message_retention_seconds = 604800 # 7 days — full operational window to investigate failures
}

# Allow Lambda to read, write, delete, list objects, tag objects, and send to DLQs
resource "aws_iam_role_policy" "lambda_s3" {
  name = "s3email-lambda-s3"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:PutObjectTagging",
          "s3:DeleteObjectTagging"
        ]
        Resource = [
          "${var.bucket_arn}",
          "${var.bucket_arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = [
          aws_sqs_queue.router_dlq.arn,
          aws_sqs_queue.pruner_dlq.arn,
        ]
      }
    ]
  })
}

resource "aws_lambda_function" "router" {
  function_name                  = "s3email-router"
  role                           = aws_iam_role.lambda.arn
  handler                        = "index.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.router.output_path
  source_code_hash               = data.archive_file.router.output_base64sha256
  timeout                        = 60
  memory_size                    = 256
  reserved_concurrent_executions = 1 # sequential only — prevents concurrent index.json writes

  dead_letter_config {
    target_arn = aws_sqs_queue.router_dlq.arn
  }

  environment {
    variables = {
      BUCKET_NAME = var.bucket_name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.main
  ]
}

# Router async invoke config — 2 retries, failures land in DLQ
resource "aws_lambda_function_event_invoke_config" "router" {
  function_name          = aws_lambda_function.router.function_name
  maximum_retry_attempts = 2
}

# Allow SES to invoke the router Lambda function
resource "aws_lambda_permission" "ses_invoke" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.router.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# ---------------------------------------------------------------------------
# Pruner Lambda — triggered by S3 lifecycle expiry events on header.json keys
# ---------------------------------------------------------------------------

data "archive_file" "pruner" {
  type        = "zip"
  source_dir  = "${path.root}/../lambda/pruner"
  output_path = "${path.module}/pruner.zip"
}

resource "aws_cloudwatch_log_group" "pruner" {
  name              = "/aws/lambda/s3email-pruner"
  retention_in_days = 90
}

resource "aws_lambda_function" "pruner" {
  function_name                  = "s3email-pruner"
  role                           = aws_iam_role.lambda.arn
  handler                        = "index.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.pruner.output_path
  source_code_hash               = data.archive_file.pruner.output_base64sha256
  timeout                        = 60
  memory_size                    = 128
  reserved_concurrent_executions = 1 # sequential only — prevents concurrent index.json writes

  dead_letter_config {
    target_arn = aws_sqs_queue.pruner_dlq.arn
  }

  environment {
    variables = {
      BUCKET_NAME = var.bucket_name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.pruner
  ]
}

# Pruner async invoke config — 2 retries, failures land in DLQ
resource "aws_lambda_function_event_invoke_config" "pruner" {
  function_name          = aws_lambda_function.pruner.function_name
  maximum_retry_attempts = 2
}

# Allow S3 to invoke the pruner Lambda on lifecycle expiry events
resource "aws_lambda_permission" "s3_invoke_pruner" {
  statement_id   = "AllowS3LifecycleInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.pruner.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = var.bucket_arn
  source_account = data.aws_caller_identity.current.account_id
}
