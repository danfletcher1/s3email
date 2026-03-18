'use strict';

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const s3     = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.BUCKET_NAME;

// The three index files that can ever contain a tagged (expiring) email.
// inbox.index.json is intentionally excluded — emails only acquire a lifecycle
// tag when moved to trash, or when routed directly to spam or quarantine.
// Custom *.index.json folders (if added later) do not hold tagged emails either.
const EXPIRY_INDEX_FOLDERS = ['spam', 'quarantine', 'trash'];

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Handler — triggered by s3:LifecycleExpiration:Delete, suffix-filtered to
// header.json. Body and attachments carry the same lifecycle tag and are
// expired by S3 lifecycle independently — pruner is index maintenance only.
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  for (const record of event.Records) {
    const startTime = Date.now();

    // S3 encodes the key using + for spaces and percent-encodes special chars
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Suffix filter on the S3 notification ensures only header.json expiry
    // fires this Lambda. Guard defensively in case the filter is misconfigured.
    if (!key.endsWith('/header.json')) continue;

    // Parse key: {domain}/{user}/{uuid}/header.json
    // e.g. "example.com/user/550e8400-e29b-41d4-a716-446655440000/header.json"
    const parts = key.split('/');
    if (parts.length < 4) continue;

    const uuid          = parts[parts.length - 2];
    const mailboxPrefix = parts.slice(0, parts.length - 2).join('/');
    const user          = parts[parts.length - 3];
    const domain        = parts.slice(0, parts.length - 3).join('/');

    const indexesUpdated = [];

    try {
      // -----------------------------------------------------------------------
      // Check the 3 expiry-relevant index files in parallel.
      // inbox.index.json is skipped — tagged emails never live in inbox.
      // Missing index files are a no-op (folder simply has no emails).
      // -----------------------------------------------------------------------
      const indexKeys = EXPIRY_INDEX_FOLDERS.map(f => `${mailboxPrefix}/${f}.index.json`);

      await Promise.all(indexKeys.map(async (idxKey) => {
        try {
          const resp     = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: idxKey }));
          const buf      = await streamToBuffer(resp.Body);
          const arr      = JSON.parse(buf.toString('utf8'));
          if (!Array.isArray(arr)) return;
          const filtered = arr.filter(e => e.uuid !== uuid);
          if (filtered.length === arr.length) return; // UUID not in this index — no-op
          await s3.send(new PutObjectCommand({
            Bucket:      BUCKET,
            Key:         idxKey,
            Body:        JSON.stringify(filtered),
            ContentType: 'application/json',
          }));
          indexesUpdated.push(idxKey.split('/').pop().replace('.index.json', ''));
        } catch (err) {
          if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
            throw err;
          }
        }
      }));

      console.log(JSON.stringify({
        event:           'email_pruned',
        timestamp:       new Date().toISOString(),
        domain,
        user,
        uuid,
        indexes_updated: indexesUpdated,
        duration_ms:     Date.now() - startTime,
        error:           null,
      }));

    } catch (err) {
      console.error(JSON.stringify({
        event:           'email_pruned',
        timestamp:       new Date().toISOString(),
        domain,
        user,
        uuid,
        indexes_updated: indexesUpdated,
        duration_ms:     Date.now() - startTime,
        error:           err.message,
      }));
      throw err;
    }
  }
};
