#!/usr/bin/env bash
# deploy.sh — Apply Terraform then generate and upload config.json to S3.
# Run from the terraform/ directory: ./deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Installing Lambda dependencies..."
pushd ../lambda/router > /dev/null
npm install --omit=dev
popd > /dev/null
# pruner has no npm dependencies \u2014 uses AWS SDK built into Lambda runtime

echo "==> Running terraform init..."
terraform init

echo "==> Running terraform apply..."
terraform apply "$@"

echo "==> Reading Terraform outputs..."
AWS_REGION=$(terraform output -raw aws_region)
BUCKET_NAME=$(terraform output -raw bucket_name)
CLOUDFRONT_DISTRIBUTION_ID=$(terraform output -raw cloudfront_distribution_id)
COGNITO_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
COGNITO_HOSTED_UI_DOMAIN=$(terraform output -raw cognito_hosted_ui_domain)
COGNITO_IDENTITY_POOL_ID=$(terraform output -raw cognito_identity_pool_id)
ACCOUNT_ID=$(terraform output -raw account_id)

echo "==> Generating config.json..."
CONFIG_FILE="$(mktemp)"
cat > "$CONFIG_FILE" <<EOF
{
  "region": "${AWS_REGION}",
  "bucketName": "${BUCKET_NAME}",
  "accountId": "${ACCOUNT_ID}",
  "cognitoUserPoolId": "${COGNITO_USER_POOL_ID}",
  "cognitoAppClientId": "${COGNITO_APP_CLIENT_ID}",
  "cognitoHostedUiDomain": "${COGNITO_HOSTED_UI_DOMAIN}",
  "cognitoIdentityPoolId": "${COGNITO_IDENTITY_POOL_ID}"
}
EOF

echo "==> Uploading config.json to s3://${BUCKET_NAME}/app/config.json..."
aws s3 cp "$CONFIG_FILE" "s3://${BUCKET_NAME}/app/config.json" \
  --content-type "application/json" \
  --region "$AWS_REGION"
rm -f "$CONFIG_FILE"

echo "==> Uploading frontend assets to s3://${BUCKET_NAME}/app/..."
# Exclude test files and helper modules that are not part of the public app
aws s3 sync ../app/ "s3://${BUCKET_NAME}/app/" \
  --region "$AWS_REGION" \
  --exclude "config.json" \
  --exclude "__tests__/*" \
  --exclude "*.test.js" \
  --exclude "lib.js"

echo "==> Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/app/*" > /dev/null

APP_URL=$(terraform output -raw app_url)
DASHBOARD_URL=$(terraform output -raw cloudwatch_dashboard_url)

echo ""
echo "==> Deploy complete!"
echo "    App URL:       https://${APP_URL}/app/"
echo "    Dashboard URL: ${DASHBOARD_URL}"
