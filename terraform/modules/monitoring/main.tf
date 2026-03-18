# ---------------------------------------------------------------------------
# SNS topic for alarm notifications
# ---------------------------------------------------------------------------
resource "aws_sns_topic" "alarms" {
  name = "s3email-alarms"
}

# NOTE: After `terraform apply`, AWS sends a confirmation email to this address.
# Alarm notifications will not be delivered until the subscription is confirmed.
resource "aws_sns_topic_subscription" "email_alerts" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_notification_email
}

# ---------------------------------------------------------------------------
# CloudWatch Log Metric Filters — extract custom metrics from Lambda JSON logs.
# Lambda emits one JSON line per email: { "event": "email_processed"|"email_error", ... }
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "emails_received" {
  name           = "s3email-emails-received"
  pattern        = "{ $.event = \"email_processed\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "EmailsReceived"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "virus_detected" {
  name           = "s3email-virus-detected"
  pattern        = "{ $.verdicts.virus = \"FAIL\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "VirusDetected"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "spam_detected" {
  name           = "s3email-spam-detected"
  pattern        = "{ $.verdicts.spam = \"FAIL\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "SpamDetected"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "spf_failed" {
  name           = "s3email-spf-failed"
  pattern        = "{ $.verdicts.spf = \"FAIL\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "SpfFailed"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "dkim_failed" {
  name           = "s3email-dkim-failed"
  pattern        = "{ $.verdicts.dkim = \"FAIL\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "DkimFailed"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "dmarc_failed" {
  name           = "s3email-dmarc-failed"
  pattern        = "{ $.verdicts.dmarc = \"FAIL\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "DmarcFailed"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "processing_errors" {
  name           = "s3email-processing-errors"
  pattern        = "{ $.event = \"email_error\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "ProcessingErrors"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "emails_quarantined" {
  name           = "s3email-quarantined"
  pattern        = "{ $.routed_to = \"quarantine\" }"
  log_group_name = var.lambda_log_group_name
  metric_transformation {
    name          = "EmailsQuarantined"
    namespace     = "S3Email"
    value         = "1"
    default_value = "0"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "virus_detected" {
  alarm_name          = "s3email-virus-detected"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "VirusDetected"
  namespace           = "S3Email"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "CRITICAL: Virus detected in incoming email — check quarantine folder"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "processing_errors" {
  alarm_name          = "s3email-processing-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ProcessingErrors"
  namespace           = "S3Email"
  period              = 300
  statistic           = "Sum"
  threshold           = 2
  alarm_description   = "ERROR: Multiple email processing failures — check Lambda logs"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "s3email-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "ERROR: Lambda router function threw an unhandled exception"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = var.lambda_function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "s3email-lambda-duration-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = 48000 # 80% of 60 second timeout
  alarm_description   = "WARNING: Lambda average duration exceeding 80% of 60s timeout"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = var.lambda_function_name
  }
}

# Spam surge alarm — fires when spam exceeds 50% of total volume over 1 hour
resource "aws_cloudwatch_metric_alarm" "spam_surge" {
  alarm_name          = "s3email-spam-surge"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.5
  alarm_description   = "WARNING: Spam exceeding 50% of email volume over the last hour"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id    = "spam"
    label = "Spam Count"
    metric {
      metric_name = "SpamDetected"
      namespace   = "S3Email"
      period      = 3600
      stat        = "Sum"
    }
  }
  metric_query {
    id    = "total"
    label = "Total Emails"
    metric {
      metric_name = "EmailsReceived"
      namespace   = "S3Email"
      period      = 3600
      stat        = "Sum"
    }
  }
  metric_query {
    id          = "spam_rate"
    label       = "Spam Rate"
    expression  = "IF(total > 0, spam/total, 0)"
    return_data = true
  }
}

# ---------------------------------------------------------------------------
# Pruner Lambda alarms
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "pruner_errors" {
  alarm_name          = "s3email-pruner-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "ERROR: Pruner Lambda threw an unhandled exception — email cleanup may be incomplete"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = var.pruner_function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "pruner_duration" {
  alarm_name          = "s3email-pruner-duration-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = 48000 # 80% of 60 second timeout
  alarm_description   = "WARNING: Pruner average duration exceeding 80% of 60s timeout"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = var.pruner_function_name
  }
}

# ---------------------------------------------------------------------------
# DLQ alarms — alert immediately when any message lands in either DLQ
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "router_dlq" {
  alarm_name          = "s3email-router-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "ERROR: Messages in router DLQ — email processing failures need investigation (7-day window)"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = var.router_dlq_name
  }
}

resource "aws_cloudwatch_metric_alarm" "pruner_dlq" {
  alarm_name          = "s3email-pruner-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "ERROR: Messages in pruner DLQ — email cleanup failures need investigation (7-day window)"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = var.pruner_dlq_name
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Dashboard
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "s3email"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Emails Received"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          metrics = [
            ["S3Email", "EmailsReceived", { stat = "Sum", label = "Per Hour" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Security Verdicts"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          period  = 3600
          metrics = [
            ["S3Email", "SpamDetected",     { stat = "Sum", color = "#FF9900" }],
            ["S3Email", "VirusDetected",    { stat = "Sum", color = "#D13212" }],
            ["S3Email", "EmailsQuarantined", { stat = "Sum", color = "#7B241C" }],
            ["S3Email", "SpfFailed",        { stat = "Sum", color = "#FF7F0E" }],
            ["S3Email", "DkimFailed",       { stat = "Sum", color = "#FFC300" }],
            ["S3Email", "DmarcFailed",      { stat = "Sum", color = "#F39C12" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 8
        height = 6
        properties = {
          title   = "Lambda Invocations & Errors"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 300
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", var.lambda_function_name, { stat = "Sum" }],
            ["AWS/Lambda", "Errors", "FunctionName", var.lambda_function_name, { stat = "Sum", color = "#D13212" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 6
        width  = 8
        height = 6
        properties = {
          title   = "Lambda Duration (ms)"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 300
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", var.lambda_function_name, { stat = "Average", label = "Average" }],
            ["AWS/Lambda", "Duration", "FunctionName", var.lambda_function_name, { stat = "Maximum", label = "Max" }]
          ]
          annotations = {
            horizontal = [{ value = 48000, label = "80% of timeout", color = "#FF7F0E" }]
          }
        }
      },
      {
        type   = "alarm"
        x      = 16
        y      = 6
        width  = 8
        height = 6
        properties = {
          title = "Active Alarms"
          alarms = [
            aws_cloudwatch_metric_alarm.virus_detected.arn,
            aws_cloudwatch_metric_alarm.processing_errors.arn,
            aws_cloudwatch_metric_alarm.lambda_errors.arn,
            aws_cloudwatch_metric_alarm.lambda_duration.arn,
            aws_cloudwatch_metric_alarm.spam_surge.arn,
            aws_cloudwatch_metric_alarm.pruner_errors.arn,
            aws_cloudwatch_metric_alarm.pruner_duration.arn,
            aws_cloudwatch_metric_alarm.router_dlq.arn,
            aws_cloudwatch_metric_alarm.pruner_dlq.arn
          ]
        }
      }
    ]
  })
}
