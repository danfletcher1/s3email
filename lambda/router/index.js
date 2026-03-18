'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { simpleParser } = require('mailparser');
const { randomUUID } = require('crypto');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.BUCKET_NAME;

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function s3GetBuffer(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return streamToBuffer(resp.Body);
}

async function s3Put(key, body, contentType, tagging) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ...(tagging ? { Tagging: tagging } : {}),
  }));
}

async function s3Delete(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ---------------------------------------------------------------------------
// Routing logic
// ---------------------------------------------------------------------------

function determineRoute(receipt) {
  if (receipt.virusVerdict.status === 'FAIL') return 'quarantine';
  if (receipt.spamVerdict.status === 'FAIL') return 'spam';
  return 'inbox';
}

// Lifecycle tag applied to header.json for auto-expiry by S3 lifecycle rules.
// inbox emails carry no tag — they persist until the user deletes them.
const LIFECYCLE_TAG = { spam: 'lifecycle=spam', quarantine: 'lifecycle=quarantine' };

// ---------------------------------------------------------------------------
// Tracking pixel stripper
// ---------------------------------------------------------------------------

// Remove 1x1 tracking pixels from HTML while keeping inline/embedded images.
// A tracking pixel is an <img> whose natural dimensions are 1x1 (width/height
// attributes or style) or whose src is an obviously external tracker URL.
// We use a simple regex approach — no DOM parser in Lambda.
function stripTrackingPixels(html) {
  if (!html) return html;
  // Remove <img> tags that have width=1 and/or height=1 (common tracker signature)
  return html.replace(
    /<img[^>]*?(?:width=["']?1["']?[^>]*height=["']?1["']?|height=["']?1["']?[^>]*width=["']?1["']?)[^>]*>/gi,
    ''
  );
}

// ---------------------------------------------------------------------------
// Header metadata builder
// ---------------------------------------------------------------------------

function buildHeaderMetadata(parsed, uuid, verdicts, route) {
  const attachments = (parsed.attachments || [])
    .filter(a => a.contentDisposition === 'attachment')
    .map((a, i) => {
      const rawFilename = a.filename || `attachment_${i + 1}`;
      // Store the sanitized name — must match the actual S3 key written below
      const safeName = rawFilename.replace(/[\/\\]/g, '_').replace(/[^\w.\-]/g, '_');
      return {
        filename: safeName,
        type: a.contentType || 'application/octet-stream',
        size: a.size || (a.content ? a.content.length : 0),
      };
    });

  return {
    uuid,
    messageId: parsed.messageId || null,
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    cc: parsed.cc?.text || '',
    subject: parsed.subject || '(no subject)',
    date: parsed.date?.toISOString() || new Date().toISOString(),
    // 200-char plain-text preview — safe to show without rendering
    preview: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    verdicts: {
      spam: verdicts.spamVerdict.status,
      virus: verdicts.virusVerdict.status,
      spf: verdicts.spfVerdict?.status || 'GRAY',
      dkim: verdicts.dkimVerdict?.status || 'GRAY',
      dmarc: verdicts.dmarcVerdict?.status || 'GRAY',
    },
    hasHtml: !!parsed.html,
    hasText: !!parsed.text,
    importance: parsed.headers?.get('importance') || parsed.headers?.get('x-priority') || 'normal',
    inReplyTo: parsed.inReplyTo || null,
    threadReferences: Array.isArray(parsed.references) ? parsed.references : null,
    unsubscribeUrl: parsed.headers?.get('list-unsubscribe') || null,
    attachments,
    bodySize: parsed.html ? parsed.html.length : (parsed.text || '').length,
    route,
  };
}

// ---------------------------------------------------------------------------
// index.json updater
// ---------------------------------------------------------------------------

async function prependToIndex(indexKey, entry) {
  // Compact summary stored in the index — everything needed to render the folder list
  const summary = {
    uuid: entry.uuid,
    messageId: entry.messageId,
    from: entry.from,
    to: entry.to,
    cc: entry.cc,
    subject: entry.subject,
    date: entry.date,
    preview: entry.preview,
    verdicts: entry.verdicts,
    hasHtml: entry.hasHtml,
    hasText: entry.hasText,
    importance: entry.importance,
    inReplyTo: entry.inReplyTo,
    threadReferences: entry.threadReferences,
    unsubscribeUrl: entry.unsubscribeUrl,
    attachments: entry.attachments,
    bodySize: entry.bodySize,
  };

  let index = [];
  try {
    const buf = await s3GetBuffer(indexKey);
    index = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(index)) index = [];
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    // Index doesn't exist yet — start with an empty array
  }

  index.unshift(summary);
  await s3Put(indexKey, JSON.stringify(index), 'application/json');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  const startTime = Date.now();
  const record = event.Records[0];
  const { mail, receipt } = record.ses;
  const messageId = mail.messageId;

  // Use the first recipient to derive the mailbox path.
  // SES receipt rules are per-domain so all recipients resolve to this domain.
  const rawRecipient = (receipt.recipients[0] || mail.destination[0] || '').toLowerCase();
  const atIdx = rawRecipient.indexOf('@');
  const user = atIdx > -1 ? rawRecipient.slice(0, atIdx) : rawRecipient;
  const domain = atIdx > -1 ? rawRecipient.slice(atIdx + 1) : 'unknown';
  const mailboxPrefix = `${domain}/${user}`;

  const verdicts = {
    spamVerdict: receipt.spamVerdict,
    virusVerdict: receipt.virusVerdict,
    spfVerdict: receipt.spfVerdict,
    dkimVerdict: receipt.dkimVerdict,
    dmarcVerdict: receipt.dmarcVerdict,
  };

  const route = determineRoute(receipt);
  const uuid = randomUUID();
  const rawKey = `raw/${messageId}`;

  try {
    // Fetch raw email stored by the SES S3 action
    const rawBuffer = await s3GetBuffer(rawKey);
    const parsed = await simpleParser(rawBuffer);

    // Build the canonical header metadata object
    const header = buildHeaderMetadata(parsed, uuid, verdicts, route);

    // All emails stored flat — no sub-prefixes per folder. Folder membership is
    // determined by *.index.json files only. Objects never move.
    const emailPrefix = `${mailboxPrefix}/${uuid}`;

    // --- Always write header.json (tagged for lifecycle expiry on non-inbox routes) ---
    const headerTag = LIFECYCLE_TAG[route]; // undefined for inbox — no tag
    await s3Put(`${emailPrefix}/header.json`, JSON.stringify(header, null, 2), 'application/json', headerTag);

    if (route !== 'quarantine') {
      // --- Write body (inbox + spam only) ---
      // Dangerous content in quarantine is intentionally never written to S3.
      const rawBody  = parsed.html ? stripTrackingPixels(parsed.html) : (parsed.text || '');
      const bodyType = parsed.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
      // Spam: tag with lifecycle=spam so S3 expires all three objects with the same rule.
      // Inbox: tag with tier=cold to enable Standard→IA→Glacier IR tiering transitions.
      const bodyTag  = route === 'spam' ? 'lifecycle=spam' : 'tier=cold';
      await s3Put(`${emailPrefix}/body`, rawBody, bodyType, bodyTag);

      // --- Write non-inline attachments ---
      for (const attachment of (parsed.attachments || [])) {
        if (attachment.contentDisposition === 'attachment') {
          const rawFilename = attachment.filename || `attachment_${Date.now()}`;
          // Sanitise filename: strip path components, allow only safe characters.
          // The same name is stored in header metadata so the browser can reconstruct the key.
          const safeName = rawFilename.replace(/[/\\]/g, '_').replace(/[^\w.\-]/g, '_');
          await s3Put(
            `${emailPrefix}/attachments/${safeName}`,
            attachment.content,
            attachment.contentType || 'application/octet-stream',
            bodyTag, // lifecycle=spam or tier=cold, matching body tag above
          );
        }
      }
    }

    // --- Update the folder's index.json ---
    const indexKey =
      route === 'spam'       ? `${mailboxPrefix}/spam.index.json` :
      route === 'quarantine' ? `${mailboxPrefix}/quarantine.index.json` :
                               `${mailboxPrefix}/inbox.index.json`;
    await prependToIndex(indexKey, header);

    // --- Delete the staging raw email — no longer needed ---
    await s3Delete(rawKey);

    // --- Structured CloudWatch log ---
    console.log(JSON.stringify({
      event: 'email_processed',
      timestamp: new Date().toISOString(),
      messageId,
      domain,
      user,
      uuid,
      routed_to: route,
      verdicts: header.verdicts,
      attachments_count: header.attachments.length,
      body_size_bytes: header.bodySize,
      processing_duration_ms: Date.now() - startTime,
      error: null,
    }));

  } catch (err) {
    console.error(JSON.stringify({
      event: 'email_error',
      timestamp: new Date().toISOString(),
      messageId,
      domain,
      user,
      error: err.message,
      processing_duration_ms: Date.now() - startTime,
    }));
    // Re-throw so Lambda marks the invocation as failed.
    // SES async invocations do NOT retry, but the failure will appear in
    // CloudWatch and trigger the ProcessingErrors alarm.
    throw err;
  }
};

