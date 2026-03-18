#!/usr/bin/env bash
# add-domain.sh — create SES domain identity + DKIM and import into Terraform state
#
# Usage:
#   ./scripts/add-domain.sh example.com [--profile <aws-profile>]
#
# What it does:
# 1. Calls AWS SES to create a domain identity and request DKIM tokens.
# 2. Emits the DNS records you must add (TXT + 3 CNAMEs for DKIM).
# 3. Creates a Terraform file under terraform/imports/ for the domain.
# 4. Runs `terraform init` and `terraform import` so the identity is tracked in state.

set -euo pipefail

if [[ "${1:-}" == "" ]]; then
  echo "Usage: $0 <domain> [--profile <aws-profile>]"
  exit 1
fi

DOMAIN="$1"
shift || true

# Optional AWS profile
AWS_CLI_OPTS=()
while [[ ${#@} -gt 0 ]]; do
  case "$1" in
    --profile) AWS_CLI_OPTS+=("--profile" "$2"); shift 2 ;;
    *) shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
IMPORT_DIR="$TF_DIR/imports"
mkdir -p "$IMPORT_DIR"

san() { echo "$1" | tr '.' '_' | tr -c 'A-Za-z0-9_' '_'; }
SAN=$(san "$DOMAIN")

echo "Creating SES domain identity for: $DOMAIN"
VERIFICATION_TOKEN=$(aws ses verify-domain-identity --domain "$DOMAIN" "${AWS_CLI_OPTS[@]:-}" --query VerificationToken --output text)

echo "Requesting DKIM tokens for: $DOMAIN"
DKIM_TOKENS=$(aws ses verify-domain-dkim --domain "$DOMAIN" "${AWS_CLI_OPTS[@]:-}" --query DkimTokens --output text)

TF_FILE="$IMPORT_DIR/domain_${SAN}.tf"
cat > "$TF_FILE" <<EOF
resource "aws_ses_domain_identity" "import_${SAN}" {
  domain = "${DOMAIN}"
}

resource "aws_ses_domain_dkim" "import_${SAN}" {
  domain = "${DOMAIN}"
}
EOF

echo "Wrote Terraform resource file: $TF_FILE"

echo "\nInitialize Terraform in $TF_DIR (this may download providers)..."
terraform -chdir="$TF_DIR" init -input=false

echo "Importing aws_ses_domain_identity.import_${SAN} into state..."
terraform -chdir="$TF_DIR" import -lock=false aws_ses_domain_identity.import_${SAN} "$DOMAIN"

echo "Importing aws_ses_domain_dkim.import_${SAN} into state..."
terraform -chdir="$TF_DIR" import -lock=false aws_ses_domain_dkim.import_${SAN} "$DOMAIN"

echo "\nDNS records to add (please add these to your DNS provider):\n"
echo "1) SES domain verification TXT record"
echo "   Name: _amazonses.${DOMAIN}"
echo "   Type: TXT"
echo "   Value: \"${VERIFICATION_TOKEN}\""

echo "\n2) DKIM CNAME records (3 records). For each token below add a CNAME:\n"
for token in $DKIM_TOKENS; do
  echo "   Name: ${token}._domainkey.${DOMAIN}"
  echo "   Type: CNAME"
  echo "   Value: ${token}.dkim.amazonses.com"
  echo
done

echo "\nAfter DNS propagation you can run:"
echo "  terraform -chdir=$TF_DIR plan"
echo "to verify the imported resources and then apply as needed."

echo "\nNote: domain ownership verification (TXT) and DKIM records must be present in DNS for SES to mark the domain as verified and DKIM-enabled.\n"

exit 0
