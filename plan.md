# S3Email App — Full Plan

## Core Value Proposition
Truly serverless email reader. No always-on compute — traditional readers (Dovecot, Exchange, Mailcow)
require a server running 24/7. Here: Lambda runs only on email delivery; all reads are direct S3 fetches
from the browser. Storage for thousands of emails costs pennies/month. Nothing to patch, restart or
monitor at 3am. Only always-on managed services: S3, Cognito, SES.

## Stack
- Plain HTML/CSS/JS (no framework, no bundler)
- Browser AWS SDK v3 (ES modules from CDN)
- Terraform for IaC
- Cognito User Pool + Hosted UI (auth)
- SES → Lambda → S3
- No backend API, no always-on server

## S3 Folder Structure

All emails are stored flat — no sub-prefixes per folder. Folder membership is
determined entirely by *.index.json files. Objects never move.

/{domain}/{user}/{uuid}/header.json           ← inbox: no tag; spam: lifecycle=spam; quarantine: lifecycle=quarantine; trash: lifecycle=trash
/{domain}/{user}/{uuid}/body                  ← inbox: tier=cold; spam: lifecycle=spam; on soft-delete: retagged lifecycle=trash
/{domain}/{user}/{uuid}/attachments/{file}    ← same tagging rules as body
/{domain}/{user}/inbox.index.json             ← single fetch loads entire inbox
/{domain}/{user}/spam.index.json
/{domain}/{user}/quarantine.index.json
/{domain}/{user}/trash.index.json             ← browser-maintained, includes deletedAt field
/{domain}/{user}/state.json                   ← read/unread state, syncs across devices
/app/                                         ← public static frontend files

Additional *.index.json files can be added to create custom folders — the
architecture supports any number. The pruner only ever checks three:
spam.index.json, quarantine.index.json, and trash.index.json. inbox.index.json
is never checked because no tagged (expiring) email ever lives there — emails
only acquire a lifecycle tag when moved to trash, or when routed to spam or quarantine.

## header.json Object Schema
/{domain}/{user}/{uuid}/header.json — written by Lambda router, read by Lambda pruner:
{
  uuid, messageId, from, to, cc, subject, date,
  preview (200 chars plain text),
  verdicts: { spam, virus, spf, dkim, dmarc },
  hasHtml, hasText, importance,
  inReplyTo, threadReferences, unsubscribeUrl,
  attachments: [{filename, type, size}],
  bodySize,
  route      ← "inbox" | "spam" | "quarantine" (set by router, used for auditing)
}
Note: deletedAt is NOT in header.json — it lives only in the trash.index.json entry.

## index.json Entry Schema
Each *.index.json is an array of index entries — everything needed for folder list view.
Index entries are a subset of header.json (no route field) plus the folder-specific fields:
[{
  uuid, messageId, from, to, cc, subject, date,
  preview (200 chars plain text),
  verdicts: { spam, virus, spf, dkim, dmarc },
  hasHtml, hasText, importance,
  inReplyTo, threadReferences, unsubscribeUrl,
  attachments: [{filename, type, size}],
  bodySize,
  deletedAt   ← present only in trash.index.json entries (ISO string, set by browser on delete)
}]

~500 emails ≈ ~200KB index file — one fetch loads entire folder, no ListObjectsV2 needed.
At 10 emails/day this grows ~1KB/day — manageable indefinitely.

The LastModified timestamp of each *.index.json file is used by the browser to
detect new email without polling: compare ETag/LastModified on load and after
a configurable interval to decide whether to re-fetch.

## Who updates index files
Lambda router (on delivery):
  - Reads inbox.index.json (or spam/quarantine), prepends new entry, writes back
  - Creates file if it doesn't exist yet
  - Sets Tagging: lifecycle=spam on header.json for spam emails
  - Sets Tagging: lifecycle=quarantine on header.json for quarantine emails
  - Sets Tagging: tier=cold on body and each attachment (drives Standard→IA→Glacier IR tiering)
  - Deletes raw/{messageId} after parsing (1-day safety-net expiry covers Lambda crashes)
  - Lambda IAM: s3:GetObject + s3:PutObject + s3:DeleteObject + s3:ListBucket on bucket

Lambda pruner (on S3 lifecycle expiry of header.json):
  - Triggered by s3:LifecycleExpiration:Delete event, suffix-filtered to header.json
    (S3 event notification filter_suffix = "/header.json" — only header.json expiry fires;
     body/attachment expiry events are silently discarded by the filter)
  - Parses domain/user/uuid from expired key path
  - Checks 3 index files in parallel (inbox never holds tagged emails):
      spam.index.json, quarantine.index.json, trash.index.json
  - Removes UUID from whichever index contains it, writes back
  - Does NOT delete body/attachments — they carry the same lifecycle tag and
    are expired by S3 lifecycle independently; pruner is purely index maintenance
  - Emits structured log line (see Structured Logging section)

Browser (on user actions):
  - Soft delete (single)  → PutObjectTagging lifecycle=trash on {uuid}/header.json + body
                            + each attachment (replaces existing tier=cold tag — fine, email
                            is expiring); remove from source index, prepend to trash.index.json
                            (with deletedAt)
  - Soft delete (bulk)    → PutObjectTagging lifecycle=trash on all objects of each email
                            serially; ONE combined write removing all UUIDs from source index;
                            ONE combined write prepending all entries to trash.index.json.
  - Restore from trash    → DeleteObjectTagging on {uuid}/header.json (no cold tag
                            to preserve); PutObjectTagging [{tier: cold}] on {uuid}/body
                            + each attachment (removes lifecycle=trash and restores cold
                            tiering atomically); remove from trash.index.json, prepend to
                            inbox.index.json
  - Restore from spam     → DeleteObjectTagging on {uuid}/header.json;
                            PutObjectTagging [{tier: cold}] on {uuid}/body + each attachment
                            (removes lifecycle=spam and restores cold tiering atomically);
                            remove from spam.index.json, prepend to inbox.index.json
  - Permanent delete      → DeleteObjects all {uuid}/*, remove from current index
  - Mark read/unread      → update state.json (single or bulk: one state.json write)
  - Browser keeps in-memory folderIndex in sync after every mutation; no re-fetch needed
  - Last-write-wins on concurrent device edits (acceptable for single-user mailbox)
  - Browser IAM: s3:GetObject + s3:PutObject + s3:DeleteObject
               + s3:PutObjectTagging + s3:DeleteObjectTagging
               + s3:ListBucket — scoped to /{domain}/{user}/* only
  - No CopyObject ever needed

## Trash Behaviour
- trash.index.json maintained by browser — single fetch to open trash, no ListObjectsV2
- Soft delete: PutObjectTagging lifecycle=trash on header.json, body, and each attachment;
  no file copy or move; replaces existing tier=cold tag (acceptable — email is expiring)
- deletedAt stored as a field in the trash.index.json entry (ISO string, set at delete time)
- S3 lifecycle rule expires ALL lifecycle=trash tagged objects after trash_retention_days;
  pruner fires on header.json expiry and removes the UUID from trash.index.json only
- Restore: DeleteObjectTagging on header.json; PutObjectTagging [{tier: cold}] on body +
  each attachment (removes lifecycle=trash and restores cold tiering in one call per object);
  email re-added to inbox.index.json
- Permanent delete: DeleteObjects {uuid}/*, remove from trash.index.json
- Stale trash.index.json entries (from permanent-delete or pruner) are handled gracefully
  (404 on body fetch shows "message expired")

## Spam Behaviour
- spam.index.json maintained by Lambda router (on delivery) and browser (on restore/delete)
- S3 lifecycle rule expires ALL lifecycle=spam tagged objects (header.json, body, attachments)
  after spam_retention_days; pruner fires on header.json expiry and removes UUID from
  spam.index.json only
- Restore to inbox: DeleteObjectTagging on header.json + move between indexes (mirrors trash restore)
- Permanent delete: DeleteObjects {uuid}/*, remove from spam.index.json
- Bulk delete: serial PutObjectTagging + combined index writes (same as inbox bulk delete)

## Read/Unread State (cross-device sync)
Stored in /{domain}/{user}/state.json:
  { "read": ["uuid1", "uuid2", ...] }
- Browser reads state.json on app load → applies over index data
- Browser writes state.json on mark read/unread
- Last-write-wins — cosmetic-only risk for concurrent multi-device use (acceptable)
- No server, no DynamoDB, no sync protocol

## Auth
- Cognito User Pool, username/password only (Google can be added later trivially)
- 2-5 users, admin-created via Terraform or console, forced password reset on first login
- Hosted UI (Cognito-managed) — PKCE Authorization Code flow
- Works on mobile and desktop browser natively
- Each Cognito user has custom attributes:
    custom:mailbox_user   (e.g. "user")
    custom:mailbox_domain (e.g. "example.com")
- After login: read ID token claims → S3 prefix = /{domain}/{user}/
- Each user can only access their own prefix (enforced by Cognito Identity Pool IAM policy)
- Tokens stored in sessionStorage (not localStorage) — reduces XSS exposure
- MFA (TOTP) can be enabled per-user later, no code changes

## Cognito Identity Pool → IAM scoping
- Cognito Identity Pool exchanges ID token for temporary AWS credentials
- IAM policy scoped to: arn:aws:s3:::bucket/{domain}/{user}/* only
- Browser can: s3:GetObject, s3:PutObject, s3:DeleteObject,
               s3:PutObjectTagging, s3:DeleteObjectTagging, s3:ListBucket (prefix)
- Browser cannot: s3:CopyObject (no longer needed), touch any other user's prefix

## Lambda Router / Processor
- Trigger: SES receipt rule Lambda action — receives SES event with spam/virus/SPF/DKIM/DMARC verdicts included
- Parses full MIME in Lambda
- Extracts To: header → derives domain + local-part → target prefix
- Routing logic:
    virus=FAIL → quarantine
    spam=FAIL  → spam
    else       → inbox
- All emails stored flat at {domain}/{user}/{uuid}/ — no sub-prefixes
- Writes to S3:
    Always:   {uuid}/header.json (enriched metadata)
    Inbox only (no lifecycle tag on any object):
              {uuid}/header.json — no tag
              {uuid}/body — tagged tier=cold
              {uuid}/attachments/{filename} — tagged tier=cold
    Spam only (all three objects tagged lifecycle=spam so S3 lifecycle expires them all):
              {uuid}/header.json — tagged lifecycle=spam
              {uuid}/body — tagged lifecycle=spam
              {uuid}/attachments/{filename} — tagged lifecycle=spam
    Quarantine: {uuid}/header.json ONLY tagged lifecycle=quarantine —
              body and attachments deliberately not written
- Updates the appropriate folder index.json (reads, prepends, writes back)
- Emits structured JSON log line to CloudWatch
- IAM role: s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket on bucket
- reserved_concurrent_executions = 1 — only one Lambda instance runs at a time, preventing
  concurrent reads+writes to the same index.json. Events that arrive during execution are
  throttled and retried (maximum_retry_attempts = 2); genuine failures land in router-dlq.
- Dead-letter queue (SQS): s3email-router-dlq, 7-day retention
  CloudWatch alarm fires immediately when any message lands in either DLQ

## Lambda Pruner
- Trigger: S3 LifecycleExpiration:Delete event notification, suffix-filtered to header.json
  (S3 event notification filter_suffix = "/header.json" ensures only header.json expiry
   fires the pruner; body/attachment expiry events are silently discarded by the filter)
- Receives expired key — parses domain, user, uuid from path
- Checks 3 known index files in parallel (inbox never holds tagged emails):
    spam.index.json, quarantine.index.json, trash.index.json
- Removes UUID from whichever index(es) contain it, writes back
- Does NOT DeleteObjects — body and attachments are tagged with the same lifecycle tag
  and expire via S3 lifecycle independently; pruner is purely index maintenance
- IAM role: same as router (s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket)
- reserved_concurrent_executions = 1 — same rationale as router; index writes are sequential.
  Throttled events retry up to 2 times; failures land in pruner-dlq.
- Dead-letter queue (SQS): s3email-pruner-dlq, 7-day retention
  CloudWatch alarm fires immediately when any message lands in either DLQ

## Quarantine Behaviour
Trigger: virus verdict = FAIL (or virus + spam both FAIL)
Lambda writes ONLY: /{domain}/{user}/{uuid}/header.json (tagged lifecycle=quarantine)
Body and attachments are NOT written — the dangerous content never exists in S3
S3 lifecycle expires header.json after quarantine_retention_days; pruner fires but finds
only header.json already gone — no other objects to clean up.

User sees in quarantine folder:
- From, subject, date, preview snippet, attachment filenames+sizes (from header metadata — safe)
- VIRUS DETECTED warning banner
- No body render option (body doesn't exist in S3 — enforced by absence, not just UI)
- Only action available: permanent delete (DeleteObjects on {uuid}/header.json only)

## Soft Delete / Trash
- Delete = PutObjectTagging lifecycle=trash on {uuid}/header.json (schedules S3 expiry)
         + remove from source folder's index.json
         + prepend to trash.index.json with deletedAt field
  No CopyObject, no file move, no data to browser.
- trash_retention_days S3 lifecycle rule expires tagged objects; pruner cleans remainder
  Lifecycle counts from tag-set time = deletion date
- Opening trash: single fetch of trash.index.json — instant, no ListObjectsV2
- Restore: DeleteObjectTagging on {uuid}/header.json (cancels expiry)
         + remove from trash.index.json, prepend to inbox.index.json
- Permanent delete: DeleteObjects {uuid}/*, remove from trash.index.json
- No "empty trash" bulk operation — one email at a time only. Bulk deletes across many UUIDs
  create many concurrent index reads+writes, which the concurrency=1 Lambda cannot prevent
  from the browser side. Avoiding the feature sidesteps the problem entirely.

## IaC (Terraform)
Modules:
1. modules/s3 — bucket, S3 static website hosting, public read bucket policy scoped to /app/ prefix
   only; six lifecycle rules: expire-trash/spam/quarantine by tag, expire-raw (1-day prefix rule for
   staging objects), cold-to-ia (Standard→Standard-IA at cold_ia_days, tag+size filtered),
   cold-to-glacier (Standard-IA→Glacier IR at cold_glacier_days, tag+size filtered);
   S3 event notification → pruner Lambda on header.json expiry
2. modules/cloudfront — CloudFront distribution in front of the S3 static website endpoint;
   provides HTTPS for the frontend (required by Cognito callback URLs); custom HTTP origin
   pointing to S3 website endpoint; PriceClass_100; cache invalidation on deploy
3. modules/ses — creates SES domain identity + DKIM keys (outputs tokens for DNS),
   creates and activates SES receipt rule set, creates receipt rule with S3 + Lambda actions.
   Assumes a fresh AWS account: DNS MX/SPF records already pointing to SES for the domain,
   but SES domain identity and rule set are created here. SES sandbox exit is manual.
4. modules/lambda — router function + pruner function (Node.js), shared IAM role,
   SES invocation permission for router, S3 invocation permission for pruner;
   reserved_concurrent_executions=1 + DLQ (SQS, 7-day retention) on both functions;
   CloudWatch Log Groups with retention_in_days=90 for both functions
5. modules/cognito — User Pool, custom attributes, App Client (PKCE, no secret), Hosted UI domain,
   Identity Pool + IAM role scoped per-user (PutObjectTagging/DeleteObjectTagging not CopyObject);
   callback_urls and logout_urls auto-derived from CloudFront domain (no manual tfvars entry)
6. modules/monitoring — CloudWatch Log Group, Metric Filters, Alarms, Dashboard;
   alarms include DLQ message-count > 0 for both router and pruner DLQs;
   pruner Lambda error + duration alarms

Variables added:
- spam_retention_days (default: 30) — days before spam emails are auto-expired
- quarantine_retention_days (default: 30) — days before quarantine emails are auto-expired
- trash_retention_days (default: 30) — unchanged, days before trash emails are auto-expired
- cold_ia_days (default: 60) — days before body/attachment objects (>128 KB) move to Standard-IA
- cold_glacier_days (default: 210) — days before body/attachment objects (>128 KB) move to Glacier IR
  (Glacier Instant Retrieval — millisecond access preserved; header.json stays in Standard always)

Note: app_callback_urls and app_logout_urls are NOT variables — they are auto-computed from
the CloudFront domain name output, so no manual entry in terraform.tfvars is required.

Frontend served over HTTPS via CloudFront (S3 static website endpoint is the origin).
Public access restricted to /app/ prefix via bucket policy; all email data remains private.

## Structured Logging & Monitoring (CloudWatch)

### Router structured log (one line per email):
{
  "event": "email_processed",
  "timestamp": "…",
  "messageId": "…",
  "domain": "example.com",
  "user": "user",
  "uuid": "…",
  "routed_to": "inbox|spam|quarantine",
  "verdicts": { "spam": "PASS|FAIL|GRAY", "virus": "PASS|FAIL", "spf": "PASS|FAIL|GRAY",
                "dkim": "PASS|FAIL", "dmarc": "PASS|FAIL" },
  "attachments_count": 2,
  "body_size_bytes": 18432,
  "processing_duration_ms": 143,
  "error": null
}

### Pruner structured log (one line per lifecycle expiry):
{
  "event": "email_pruned",
  "timestamp": "…",
  "domain": "example.com",
  "user": "user",
  "uuid": "…",
  "indexes_updated": ["inbox"],
  "duration_ms": 45,
  "error": null
}

### CloudWatch Metric Filters (no SDK cost):
EmailsReceived, SpamDetected, VirusDetected, SpfFailed, DkimFailed, DmarcFailed,
ProcessingErrors, EmailsQuarantined

### CloudWatch Alarms (SNS → email notification):
- VirusDetected > 0 in 5 min → CRITICAL
- ProcessingErrors > 2 in 5 min → ERROR
- Spam rate > 50% over 1 hr → WARNING
- Router Lambda Errors > 0 → ERROR
- Router Lambda Duration > 80% of timeout → WARNING
- Pruner Lambda Errors > 0 → ERROR
- Pruner Lambda Duration > 80% of timeout → WARNING
- Router DLQ ApproximateNumberOfMessagesVisible > 0 → ERROR
- Pruner DLQ ApproximateNumberOfMessagesVisible > 0 → ERROR

### Log + Resource Retention:
| Resource                          | Retention |
|-----------------------------------|-----------|
| Spam header.json (S3)             | spam_retention_days (default 30) |
| Quarantine header.json (S3)       | quarantine_retention_days (default 30) |
| Trash header.json (S3)            | trash_retention_days (default 30) |
| Raw staging objects (S3)          | 1 day     |
| Router DLQ messages               | 7 days    |
| Pruner DLQ messages               | 7 days    |
| CloudWatch Logs (router + pruner) | 90 days   |
| CloudWatch Metrics                | 15 months (AWS default) |
| CloudWatch Alarm history          | 14 days (AWS default) |

### CloudWatch Dashboard:
Emails received today/week, security panel (all 5 verdicts), routing breakdown,
Lambda health, alarm history

## Secrets / Config
- terraform.tfvars (gitignored) — real values: region, bucket name, domain, SES rule set name,
  Cognito domain prefix (no callback URLs — auto-derived from CloudFront)
- terraform.tfvars.example (committed) — placeholder markers e.g. YOUR_DOMAIN_NAME
- .gitignore: terraform.tfvars, .terraform/, *.tfstate, *.tfstate.backup, config.json
- Runtime config.json (generated by deploy.sh, uploaded to /app/ in S3):
    { region, bucketName, cognitoUserPoolId, cognitoAppClientId,
      cognitoHostedUiDomain, cognitoIdentityPoolId }
  Not secret — Cognito IDs are safe client-side
- App fetches /app/config.json at startup before initialising AWS SDK

## File Structure
/
  index.html
  styles.css
  app.js
  config.js                          fetches /app/config.json, exposes getConfig()
  README.md
  .gitignore
  lambda/
    router/
      index.js                       MIME processor, S3 writer, tags spam/quarantine headers
      package.json
    pruner/
      index.js                       S3 lifecycle expiry handler — prunes indexes + cleans objects
      package.json                   no npm deps (AWS SDK built into Lambda runtime)
  terraform/
    main.tf
    variables.tf
    outputs.tf
    terraform.tfvars.example
    deploy.sh                        terraform apply + generate + upload config.json to S3 +
                                     CloudFront cache invalidation (/app/*)
    modules/
      s3/
      ses/
      lambda/
      cognito/
      cloudfront/
      monitoring/

## Browser Features
- Inbox list — one fetch of inbox.index.json, no ListObjectsV2, instant even at thousands of emails
- Spam folder — spam.index.json
- Quarantine folder — quarantine.index.json (header info only, VIRUS WARNING, delete-only action)
- Trash folder — single fetch of trash.index.json (browser-maintained index, instant)
- New email polling — on folder load, store ETag/LastModified of index file; re-check on interval;
  only re-fetch index if changed (zero cost if no new mail)
- Read email: fetch {uuid}/body → HTML rendered in sandboxed iframe (allow-same-origin allow-popups,
  no allow-scripts) or plain text pre element
- Attachments: list from index metadata (no body fetch); download = GetObject → Blob → anchor click
- Soft delete (single + bulk) → PutObjectTagging serially + combined index writes (no CopyObject)
- Restore from trash — DeleteObjectTagging + index updates
- Restore from spam ("Not spam") — DeleteObjectTagging + move to inbox.index.json
- Permanent delete + index update
- Mark read / Mark unread — both available via UI button; state persisted in state.json
- Bulk mark read/unread — one state.json write covering all selected UUIDs
- Browser keeps in-memory folder state in sync after every mutation (no re-fetch needed)
- Auth: Cognito Hosted UI → PKCE → scoped temp credentials → mailbox auto-routing from token claims

## Future Considerations
1. Google login — add Cognito federated IdP, one Terraform change, no app code changes
2. MFA (TOTP) — one Terraform attribute per user, no code changes
3. Thread grouping — inReplyTo + threadReferences already in index, client-side grouping only
4. Custom folders — architecture supports it (add {name}.index.json); add folder create/rename UI
5. Sending email — SES SendRawMessage from a small Lambda (browser calls it); drafts at
   {domain}/{user}/drafts/ in S3; scoped IAM ses:SendEmail on the From identity only
