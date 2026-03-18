output "function_arn" {
  description = "ARN of the Lambda router function."
  value       = aws_lambda_function.router.arn
}

output "function_name" {
  description = "Name of the Lambda router function."
  value       = aws_lambda_function.router.function_name
}

output "log_group_name" {
  description = "CloudWatch log group name for the router Lambda function."
  value       = aws_cloudwatch_log_group.main.name
}

output "pruner_function_arn" {
  description = "ARN of the pruner Lambda function."
  value       = aws_lambda_function.pruner.arn
}

output "pruner_function_name" {
  description = "Name of the pruner Lambda function."
  value       = aws_lambda_function.pruner.function_name
}

output "pruner_log_group_name" {
  description = "CloudWatch log group name for the pruner Lambda function."
  value       = aws_cloudwatch_log_group.pruner.name
}

output "router_dlq_name" {
  description = "Name of the router Lambda dead-letter queue."
  value       = aws_sqs_queue.router_dlq.name
}

output "pruner_dlq_name" {
  description = "Name of the pruner Lambda dead-letter queue."
  value       = aws_sqs_queue.pruner_dlq.name
}

output "pruner_invoke_permission_id" {
  description = "ID of the S3→pruner Lambda permission resource (used as depends_on for S3 notification)."
  value       = aws_lambda_permission.s3_invoke_pruner.id
}
