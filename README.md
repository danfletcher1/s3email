# s3email

A serverless email reader. No always-on server — emails arrive via AWS SES, are processed by a Lambda function, and stored in S3. The browser reads directly from S3 using temporary AWS credentials. Nothing to patch, restart, or monitor at 3am.

**Stack:** Plain HTML/CSS/JS · AWS SES · AWS Lambda · AWS S3 · AWS Cognito · Terraform

---

## Prerequisites

Before deploying you need:

1. **AWS CLI** configured with credentials that have sufficient permissions to create IAM roles, S3 buckets, Cognito pools, Lambda functions, SES rules, and CloudWatch resources.
2. **Terraform >= 1.6** — [install instructions](https://developer.hashicorp.com/terraform/install)
3. **Node.js >= 18** — for building the Lambda function
4. **An AWS account with SES already configured** for your domain:
   - SES domain identity verified
   - An SES receipt rule set created (note the rule set name — you'll need it)
   - SES sandbox lifted (if you need to receive from external senders)

---

## First-time setup

### 1. Clone and configure secrets

```bash
git clone <repo-url>
cd s3email/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` and fill in every `YOUR_*` placeholder:

| Variable | Description | Example |
|---|---|---|
| `aws_region` | Region to deploy into | `eu-west-1` |
| `bucket_name` | S3 bucket name (globally unique) | `mycompany-email` |
| `domain_name` | Domain SES is configured for | `example.com` |
| `ses_rule_set_name` | Existing SES receipt rule set name | `default-rule-set` |
| `cognito_domain_prefix` | Unique prefix for Cognito Hosted UI URL | `mycompany-email` |
| `app_callback_urls` | App URL(s) for Cognito redirect after login — must end in `/app/` | `["http://bucket.s3-website.eu-west-1.amazonaws.com/app/"]` |
| `app_logout_urls` | App URL(s) for Cognito redirect after logout — must end in `/app/` | same as above |
| `trash_retention_days` | Days before deleted emails are permanently removed | `30` |
| `alarm_notification_email` | Email to receive CloudWatch alarm notifications | `admin@example.com` |

`terraform.tfvars` is gitignored and must never be committed.

### 2. Deploy

```bash
cd terraform
chmod +x deploy.sh
./deploy.sh
```

This will:
- Run `terraform apply` to provision all AWS infrastructure
- Generate `app/config.json` from the Terraform outputs
- Upload the frontend and config to S3

The app URL and CloudWatch dashboard URL are printed at the end.

### 3. Create your first user

After deploy, create a Cognito user for each mailbox. The username must match the email local-part:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username user@example.com \
  --user-attributes \
      Name=email,Value=user@example.com \
      Name=custom:mailbox_user,Value=user \
      Name=custom:mailbox_domain,Value=example.com \
  --temporary-password "ChangeMe123!" \
  --region <AWS_REGION>
```

The user will be prompted to set a new password on first login.

---

## Architecture

```
Incoming email
      │
      ▼
  AWS SES (receipt rule)
      │  Lambda action
      ▼
  Lambda (router/processor)
  ├── Parses MIME
  ├── Checks spam/virus/SPF/DKIM/DMARC verdicts
  ├── Routes to inbox / spam / quarantine
  ├── Writes header.json + body + attachments to S3
  └── Updates folder index.json

Browser (static HTML/CSS/JS hosted on S3)
  ├── Authenticates via Cognito Hosted UI (PKCE)
  ├── Receives scoped temporary AWS credentials
  ├── Fetches inbox.index.json (one file = full inbox)
  ├── Opens emails by fetching body on demand
  └── Manages delete/restore via server-side S3 CopyObject
```

### S3 layout

```
/{domain}/{user}/inbox.index.json       ← full inbox metadata, fetched once
/{domain}/{user}/spam.index.json
/{domain}/{user}/quarantine.index.json
/{domain}/{user}/state.json             ← read/unread state (syncs across devices)
/{domain}/{user}/{uuid}/header.json     ← individual email metadata
/{domain}/{user}/{uuid}/body            ← email body (fetched on open)
/{domain}/{user}/{uuid}/attachments/*   ← attachments (fetched on download)
/{domain}/{user}/_trash/{uuid}/…        ← soft-deleted (auto-expires per lifecycle rule)
/app/                                   ← public static frontend files
```

---

## Security notes

> **This is a public repository.** Never commit `terraform.tfvars` — it contains your AWS configuration (region, bucket name, Cognito settings, alarm email). It is gitignored by default; keep it that way.

- The S3 bucket has **public read access restricted to `/app/` only**. All email data is private.
- The browser receives **temporary AWS credentials** from Cognito Identity Pool scoped strictly to `/{domain}/{user}/*`. Users cannot read each other's email.
- HTML email bodies are rendered in a **sandboxed iframe** via `srcdoc` — the iframe's `sandbox` attribute blocks all scripts, so no code from email content can execute or access the parent page.
- Virus-flagged emails: the **body and attachments are never written to S3** by Lambda. Only the safe header metadata is stored.
- Auth tokens are stored in **sessionStorage** (not localStorage) to limit XSS exposure.

---

## Moving to a new AWS account

1. `cp terraform/terraform.tfvars.example terraform/terraform.tfvars`
2. Fill in the new account's values
3. `cd terraform && ./deploy.sh`

All infrastructure is defined in Terraform — no manual console steps required.

---

## Adding a new email user

1. Add the user in Cognito (see "Create your first user" above with the new address)
2. No Terraform changes needed — Lambda routes dynamically based on the `To:` header

---

## Future considerations

- **Google login** — add Google as a Cognito federated IdP; one Terraform change, no app code changes
- **MFA (TOTP)** — enable per-user via one Terraform attribute; no app code changes
- **Thread view** — `inReplyTo` and `threadReferences` are already stored in the index; client-side grouping only
