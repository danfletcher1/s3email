#!/usr/bin/env bash
# create-user.sh — Create a Cognito user for a mailbox address.
#
# Usage:
#   ./scripts/create-user.sh <email-address> [--region <region>]
#
# Example:
#   ./scripts/create-user.sh user@example.com
#
# The script reads USER_POOL_ID and AWS_REGION from Terraform outputs if they
# are not already set in the environment. You can override them:
#   USER_POOL_ID=eu-west-1_ABC123 AWS_REGION=eu-west-1 ./scripts/create-user.sh user@example.com
#
# The user will be created with a forced password reset on first login.
# A temporary password is printed to stdout — share it with the user securely.

set -euo pipefail

EMAIL="${1:-}"
if [[ -z "$EMAIL" ]]; then
  echo "Usage: $0 <email-address>" >&2
  exit 1
fi

# Split email into local-part and domain
LOCAL="${EMAIL%%@*}"
DOMAIN="${EMAIL##*@}"

if [[ "$LOCAL" == "$EMAIL" || -z "$DOMAIN" ]]; then
  echo "Error: '$EMAIL' does not look like a valid email address." >&2
  exit 1
fi

# Resolve Terraform outputs if not set in environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"

if [[ -z "${AWS_REGION:-}" ]]; then
  AWS_REGION="$(terraform -chdir="$TF_DIR" output -raw aws_region 2>/dev/null)" \
    || { echo "Error: could not read aws_region from Terraform. Set AWS_REGION env var." >&2; exit 1; }
fi

if [[ -z "${USER_POOL_ID:-}" ]]; then
  USER_POOL_ID="$(terraform -chdir="$TF_DIR" output -raw cognito_user_pool_id 2>/dev/null)" \
    || { echo "Error: could not read cognito_user_pool_id from Terraform. Set USER_POOL_ID env var." >&2; exit 1; }
fi

# Generate a strong temporary password
# pipefail is temporarily disabled: `tr` receives SIGPIPE when `head` exits after
# reading its 16 bytes, which would otherwise abort the script under set -euo pipefail.
TEMP_PASSWORD="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9!@#%^&*' </dev/urandom | head -c 16)Aa1!"

echo "==> Creating Cognito user '${EMAIL}' in pool ${USER_POOL_ID} ..."

aws cognito-idp admin-create-user \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes \
      "Name=email,Value=${EMAIL}" \
      "Name=email_verified,Value=true" \
      "Name=custom:mailbox_user,Value=${LOCAL}" \
      "Name=custom:mailbox_domain,Value=${DOMAIN}" \
  --temporary-password "$TEMP_PASSWORD" \
  --message-action SUPPRESS \
  --output json > /dev/null

echo ""
echo "==> User created successfully."
echo "    Username:           ${EMAIL}"
echo "    Mailbox:            ${EMAIL}"
echo "    Temporary password: ${TEMP_PASSWORD}"
echo ""
echo "    The user must change this password on first login."
echo "    Share it with them securely (do not send via email)."
