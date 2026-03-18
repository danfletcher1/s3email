variable "aws_region" {
  description = "AWS region (used in dashboard URLs and metric queries)."
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the Lambda router function."
  type        = string
}

variable "lambda_log_group_name" {
  description = "CloudWatch log group name for the router Lambda function (used for metric filters)."
  type        = string
}

variable "pruner_function_name" {
  description = "Name of the pruner Lambda function."
  type        = string
}

variable "pruner_log_group_name" {
  description = "CloudWatch log group name for the pruner Lambda function."
  type        = string
}

variable "router_dlq_name" {
  description = "Name of the router Lambda dead-letter queue (used for the DLQ alarm dimension)."
  type        = string
}

variable "pruner_dlq_name" {
  description = "Name of the pruner Lambda dead-letter queue (used for the DLQ alarm dimension)."
  type        = string
}

variable "alarm_notification_email" {
  description = "Email address to send CloudWatch alarm notifications to."
  type        = string
}
