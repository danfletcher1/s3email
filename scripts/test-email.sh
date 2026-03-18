#!/usr/bin/env bash
# test-email.sh — Inject a synthetic raw email directly into S3 to test the Lambda pipeline.
#
# This bypasses SES and writes a raw RFC 5322 email to s3://BUCKET/raw/ exactly as
# SES would, then fires the Lambda function with a matching SES event payload.
# Use this to verify end-to-end processing (routing, parsing, index update) after deploy.
#
# Usage:
#   ./scripts/test-email.sh <recipient-email>
#
# Example:
#   ./scripts/test-email.sh user@example.com
#
# Prerequisites: aws CLI, jq

set -euo pipefail

RECIPIENT="${1:-}"
if [[ -z "$RECIPIENT" ]]; then
  echo "Usage: $0 <recipient-email>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"

# Resolve config from Terraform outputs unless set in environment
if [[ -z "${AWS_REGION:-}" ]]; then
  AWS_REGION="$(terraform -chdir="$TF_DIR" output -raw aws_region 2>/dev/null)" \
    || { echo "Error: could not read aws_region. Set AWS_REGION env var." >&2; exit 1; }
fi
if [[ -z "${BUCKET_NAME:-}" ]]; then
  BUCKET_NAME="$(terraform -chdir="$TF_DIR" output -raw bucket_name 2>/dev/null)" \
    || { echo "Error: could not read bucket_name. Set BUCKET_NAME env var." >&2; exit 1; }
fi
if [[ -z "${LAMBDA_FUNCTION:-}" ]]; then
  LAMBDA_FUNCTION="$(terraform -chdir="$TF_DIR" output -raw lambda_function_arn 2>/dev/null)" \
    || { echo "Error: could not read lambda_function_arn. Set LAMBDA_FUNCTION env var." >&2; exit 1; }
fi

MESSAGE_ID="test-$(date +%s)-$(openssl rand -hex 4)"
NOW="$(date -u "+%a, %d %b %Y %H:%M:%S +0000")"
SENDER="sender@mail-test.example"

# ---------------------------------------------------------------------------
# Build a minimal but valid multipart email
# ---------------------------------------------------------------------------
BOUNDARY="----=_Part_1_$(date +%s)"

RAW_EMAIL="From: Test Sender <${SENDER}>
To: ${RECIPIENT}
Subject: [s3email test] Pipeline smoke test $(date +%Y-%m-%dT%H:%M:%SZ)
Date: ${NOW}
Message-ID: <${MESSAGE_ID}@mail-test.example>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary=\"${BOUNDARY}\"

--${BOUNDARY}
Content-Type: text/plain; charset=UTF-8

This is a test email sent by scripts/test-email.sh to verify the s3email pipeline.
If you can see this message in your inbox the delivery pipeline is working correctly.

--${BOUNDARY}
Content-Type: text/html; charset=UTF-8

<!DOCTYPE html>
<html><body>
<p>This is a <strong>test email</strong> sent by <code>scripts/test-email.sh</code>
to verify the s3email pipeline.</p>
<p>If you can see this message in your inbox the delivery pipeline is working correctly.</p>
</body></html>
--${BOUNDARY}--
"

RAW_KEY="raw/${MESSAGE_ID}"

echo "==> Uploading raw email to s3://${BUCKET_NAME}/${RAW_KEY} ..."
echo "$RAW_EMAIL" | aws s3 cp - "s3://${BUCKET_NAME}/${RAW_KEY}" \
  --content-type "message/rfc822" \
  --region "$AWS_REGION"

# ---------------------------------------------------------------------------
# Build a minimal SES event that mirrors what SES actually sends to Lambda.
# Verdicts are all PASS so the email routes to inbox.
# ---------------------------------------------------------------------------
SES_EVENT=$(jq -n \
  --arg messageId "$MESSAGE_ID" \
  --arg recipient "$RECIPIENT" \
  --arg sender "$SENDER" \
  '{
    "Records": [{
      "eventSource": "aws:ses",
      "eventVersion": "1.0",
      "ses": {
        "mail": {
          "timestamp": (now | todate),
          "messageId": $messageId,
          "source": $sender,
          "destination": [$recipient],
          "headers": [],
          "commonHeaders": {
            "from": [$sender],
            "to": [$recipient],
            "subject": "[s3email test] Pipeline smoke test"
          }
        },
        "receipt": {
          "timestamp": (now | todate),
          "processingTimeMillis": 100,
          "recipients": [$recipient],
          "spamVerdict":  {"status": "PASS"},
          "virusVerdict": {"status": "PASS"},
          "spfVerdict":   {"status": "PASS"},
          "dkimVerdict":  {"status": "PASS"},
          "dmarcVerdict": {"status": "PASS"},
          "action": {
            "type": "Lambda",
            "functionArn": "",
            "invocationType": "Event"
          }
        }
      }
    }]
  }'
)

echo "==> Invoking Lambda function ${LAMBDA_FUNCTION} ..."
RESPONSE_FILE="$(mktemp)"
STATUS=$(aws lambda invoke \
  --function-name "$LAMBDA_FUNCTION" \
  --invocation-type RequestResponse \
  --payload "$SES_EVENT" \
  --cli-binary-format raw-in-base64-out \
  --region "$AWS_REGION" \
  --output json \
  "$RESPONSE_FILE")

FUNCTION_ERROR=$(echo "$STATUS" | jq -r '.FunctionError // empty')
if [[ -n "$FUNCTION_ERROR" ]]; then
  echo ""
  echo "ERROR: Lambda returned an error:"
  cat "$RESPONSE_FILE"
  rm -f "$RESPONSE_FILE"
  exit 1
fi

rm -f "$RESPONSE_FILE"

echo ""
echo "==> Success! Test email processed."
echo "    Message ID: ${MESSAGE_ID}"
echo "    Recipient:  ${RECIPIENT}"
echo ""
echo "    Check your inbox in the app — the email should appear immediately."
echo "    You can also inspect the Lambda logs:"
echo "    https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:log-groups/log-group/\$252Faws\$252Flambda\$252Fs3email-router"
