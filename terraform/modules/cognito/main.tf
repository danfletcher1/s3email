# ---------------------------------------------------------------------------
# Cognito User Pool
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  name = "s3email"

  # Only admins can create users — no self-registration
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  username_configuration {
    case_sensitive = false
  }

  # Custom attribute: local-part of the mailbox address (e.g. "user")
  schema {
    name                     = "mailbox_user"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  # Custom attribute: domain of the mailbox (e.g. "example.com")
  schema {
    name                     = "mailbox_domain"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    string_attribute_constraints {
      min_length = 1
      max_length = 253
    }
  }

  tags = {
    Project = "s3email"
  }
}

# ---------------------------------------------------------------------------
# App Client — PKCE, no client secret (safe for browser apps)
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool_client" "main" {
  name         = "s3email-app"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]

  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.app_callback_urls
  logout_urls                          = var.app_logout_urls
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true

  prevent_user_existence_errors = "ENABLED"

  # Include custom attributes in the ID token so the browser can derive S3 prefix
  read_attributes = [
    "email",
    "preferred_username",
    "custom:mailbox_user",
    "custom:mailbox_domain"
  ]

  access_token_validity  = 1  # hours
  id_token_validity      = 1  # hours
  refresh_token_validity = 30 # days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# ---------------------------------------------------------------------------
# Hosted UI domain
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

# ---------------------------------------------------------------------------
# Identity Pool — exchanges ID token for scoped temporary AWS credentials
# ---------------------------------------------------------------------------
resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = "s3email"
  allow_unauthenticated_identities = false

  cognito_identity_providers {
    client_id               = aws_cognito_user_pool_client.main.id
    provider_name           = aws_cognito_user_pool.main.endpoint
    server_side_token_check = false
  }
}

# IAM role assumed by authenticated users via the Identity Pool
resource "aws_iam_role" "authenticated" {
  name = "s3email-cognito-authenticated"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "cognito-identity.amazonaws.com"
      }
      Action = ["sts:AssumeRoleWithWebIdentity", "sts:TagSession"]
      Condition = {
        StringEquals = {
          "cognito-identity.amazonaws.com:aud" = aws_cognito_identity_pool.main.id
        }
        "ForAnyValue:StringLike" = {
          "cognito-identity.amazonaws.com:amr" = "authenticated"
        }
      }
    }]
  })
}

# S3 policy using IAM principal tags derived from Cognito custom attributes.
# Each user can only access /{mailbox_domain}/{mailbox_user}/* — enforced by AWS IAM,
# not just app code.
resource "aws_iam_role_policy" "authenticated_s3" {
  name = "s3email-authenticated-s3"
  role = aws_iam_role.authenticated.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ObjectAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:PutObjectTagging",
          "s3:DeleteObjectTagging"
        ]
        # $${...} produces a literal ${...} in the JSON — IAM policy variable syntax
        Resource = "${var.bucket_arn}/$${aws:PrincipalTag/mailbox_domain}/$${aws:PrincipalTag/mailbox_user}/*"
      },
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = "s3:ListBucket"
        Resource = var.bucket_arn
        Condition = {
          StringLike = {
            "s3:prefix" = "$${aws:PrincipalTag/mailbox_domain}/$${aws:PrincipalTag/mailbox_user}/*"
          }
        }
      }
    ]
  })
}

# Attach the authenticated role to the Identity Pool
resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    "authenticated" = aws_iam_role.authenticated.arn
  }

  # Required when using principal tags: tells the identity pool to resolve the
  # role from the token and propagate session tags for this provider.
  role_mapping {
    identity_provider         = "${aws_cognito_user_pool.main.endpoint}:${aws_cognito_user_pool_client.main.id}"
    ambiguous_role_resolution = "AuthenticatedRole"
    type                      = "Token"
  }
}

# Map Cognito User Pool custom attributes to IAM principal tags.
# This is what makes the S3 IAM policy variables work — the custom:mailbox_user
# and custom:mailbox_domain claims from the ID token become ${aws:PrincipalTag/...}
# values in the IAM policy at credential-issuance time.
resource "aws_cognito_identity_pool_provider_principal_tag" "main" {
  identity_pool_id       = aws_cognito_identity_pool.main.id
  identity_provider_name = aws_cognito_user_pool.main.endpoint
  use_defaults           = false

  principal_tags = {
    mailbox_user   = "custom:mailbox_user"
    mailbox_domain = "custom:mailbox_domain"
  }
}
