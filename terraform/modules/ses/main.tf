# ---------------------------------------------------------------------------
# SES domain identity — verifies ownership of the sending/receiving domain.
# DNS is assumed to already have MX records pointing to SES for this domain.
# Terraform creates the identity and outputs the DKIM CNAME records that must
# be added to DNS to complete DKIM verification.
# ---------------------------------------------------------------------------

resource "aws_ses_domain_identity" "main" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# ---------------------------------------------------------------------------
# SES receipt rule set — created and activated by Terraform.
# For a fresh account this is the first (and only) rule set.
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = var.ses_rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

# ---------------------------------------------------------------------------
# SES receipt rule — invokes Lambda for every email received on the domain.
# scan_enabled = true enables SES spam and virus scanning; verdicts are passed
# directly to Lambda in the event object at no extra cost.
# ---------------------------------------------------------------------------
resource "aws_ses_receipt_rule" "main" {
  name          = "s3email-route-to-lambda"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  enabled       = true
  scan_enabled  = true

  # Position 1: write raw email to S3 so Lambda can retrieve the full MIME body.
  # The Lambda event only carries verdicts + messageId, not the body.
  s3_action {
    bucket_name       = var.bucket_name
    object_key_prefix = "raw/"
    position          = 1
  }

  # Position 2: invoke Lambda with SES event (verdicts + messageId) asynchronously.
  lambda_action {
    function_arn    = var.lambda_arn
    invocation_type = "Event" # Async — SES accepts the email immediately; Lambda processes in background
    position        = 2
  }

  depends_on = [aws_ses_receipt_rule_set.main]
}
