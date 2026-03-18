/**
 * app.js — S3Email browser application
 *
 * Auth flow:
 *   1. On load: check sessionStorage for tokens. If present, init AWS SDK.
 *   2. If absent and URL has ?code=…: exchange code for tokens via Cognito token endpoint (PKCE).
 *   3. If absent: show login button which redirects to Cognito Hosted UI.
 *
 * After auth:
 *   - Read custom:mailbox_user + custom:mailbox_domain from ID token claims
 *   - Load inbox.index.json → render folder list
 *   - All S3 operations use temporary credentials from Cognito Identity Pool
 *
 * Dependencies (loaded from CDN as ES modules):
 *   - @aws-sdk/client-s3 (CJS compat bundle via esm.sh)
 *   - amazon-cognito-identity-js is NOT used — we do the PKCE dance manually
 *     with the Cognito token endpoint to avoid a large dependency.
 */

import { getConfig } from '/app/config.js';

// ---------------------------------------------------------------------------
// AWS SDK v3 — loaded from CDN
// ---------------------------------------------------------------------------
// AWS SDK constructors will be loaded lazily at runtime after the small
// `process.env` stub in `index.html` has run. This avoids the SDK's Node
// runtime shims attempting to read local files during module evaluation.
let S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    PutObjectTaggingCommand,
    DeleteObjectTaggingCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand;



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// Readable stream → text (works in browser with TransformStream)
async function bodyToText(body) {
  // Accept multiple body types: ReadableStream (fetch), Blob/ArrayBuffer (AWS SDK v2), Uint8Array
  if (!body) return '';
  if (body.getReader) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }
  if (body.arrayBuffer) {
    const ab = await body.arrayBuffer();
    return new TextDecoder().decode(ab);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  // Uint8Array (SDK v2 in browsers) or Node Buffer
  if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body && body.constructor && body.constructor.name === 'Buffer' && body.buffer) {
    return new TextDecoder().decode(body.buffer);
  }
  if (typeof body === 'string') return body;
  // Fallback: try JSON stringify
  try { return JSON.stringify(body); } catch { return '' }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return iso || ''; }
}

// Escape text for safe injection into iframe srcdoc
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Generate a random base64url string for PKCE
function randomBase64url(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function sha256Base64url(plain) {
  const enc = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ---------------------------------------------------------------------------
// PKCE / Cognito auth
// ---------------------------------------------------------------------------

// Session storage keys
const SS = {
  accessToken:  's3email.accessToken',
  idToken:      's3email.idToken',
  refreshToken: 's3email.refreshToken',
  codeVerifier: 's3email.codeVerifier',
  expiresAt:    's3email.expiresAt',
};

function getTokens() {
  return {
    access:  sessionStorage.getItem(SS.accessToken),
    id:      sessionStorage.getItem(SS.idToken),
    refresh: sessionStorage.getItem(SS.refreshToken),
    expiresAt: Number(sessionStorage.getItem(SS.expiresAt) || 0),
  };
}

function saveTokens({ access_token, id_token, refresh_token, expires_in }) {
  sessionStorage.setItem(SS.accessToken,  access_token);
  sessionStorage.setItem(SS.idToken,      id_token);
  if (refresh_token) sessionStorage.setItem(SS.refreshToken, refresh_token);
  sessionStorage.setItem(SS.expiresAt,    String(Date.now() + (expires_in - 60) * 1000));
}

function clearTokens() {
  Object.values(SS).forEach(k => sessionStorage.removeItem(k));
}

function parseJwtClaims(jwt) {
  try {
    const payload = jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(payload));
  } catch { return null; }
}

async function startLogin(cfg) {
  const verifier = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);
  sessionStorage.setItem(SS.codeVerifier, verifier);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             cfg.cognitoAppClientId,
    redirect_uri:          window.location.origin + '/app/',
    scope:                 'openid email profile',
    code_challenge_method: 'S256',
    code_challenge:        challenge,
  });
  window.location.assign(`${cfg.cognitoHostedUiDomain}/oauth2/authorize?${params}`);
}

async function exchangeCode(cfg, code) {
  const verifier = sessionStorage.getItem(SS.codeVerifier);
  if (!verifier) throw new Error('Missing PKCE code verifier');

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     cfg.cognitoAppClientId,
    redirect_uri:  window.location.origin + '/app/',
    code,
    code_verifier: verifier,
  });

  const resp = await fetch(`${cfg.cognitoHostedUiDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${txt}`);
  }

  const tokens = await resp.json();
  saveTokens(tokens);
  sessionStorage.removeItem(SS.codeVerifier);

  // Clean the ?code= from the URL without reloading
  window.history.replaceState({}, '', window.location.pathname);
  return tokens;
}

async function refreshTokens(cfg) {
  const refresh = sessionStorage.getItem(SS.refreshToken);
  if (!refresh) throw new Error('No refresh token');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.cognitoAppClientId,
    refresh_token: refresh,
  });

  const resp = await fetch(`${cfg.cognitoHostedUiDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) { clearTokens(); throw new Error('Token refresh failed'); }
  const tokens = await resp.json();
  if (!tokens.refresh_token) tokens.refresh_token = refresh; // Cognito omits it on refresh
  saveTokens(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Cognito Identity Pool → temporary AWS credentials
// ---------------------------------------------------------------------------

let _credentials = null;

async function getCredentials(cfg, idToken) {
  // Return cached credentials if still valid (5-min buffer)
  if (_credentials && _credentials.Expiration && new Date(_credentials.Expiration) > new Date(Date.now() + 5 * 60 * 1000)) {
    return _credentials;
  }

  const endpoint = `https://cognito-identity.${cfg.region}.amazonaws.com`;
  const loginKey  = `cognito-idp.${cfg.region}.amazonaws.com/${cfg.cognitoUserPoolId}`;

  // Step 1 — GetId
  const getIdResp = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityService.GetId',
    },
    body: JSON.stringify({
      AccountId:      cfg.accountId,
      IdentityPoolId: cfg.cognitoIdentityPoolId,
      Logins: { [loginKey]: idToken },
    }),
  });
  if (!getIdResp.ok) {
    const txt = await getIdResp.text();
    throw new Error(`GetId failed: ${getIdResp.status} ${txt}`);
  }
  const { IdentityId } = await getIdResp.json();

  // Step 2 — GetCredentialsForIdentity
  const getCredsResp = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
    },
    body: JSON.stringify({
      IdentityId,
      Logins: { [loginKey]: idToken },
    }),
  });
  if (!getCredsResp.ok) {
    const txt = await getCredsResp.text();
    throw new Error(`GetCredentialsForIdentity failed: ${getCredsResp.status} ${txt}`);
  }
  const { Credentials } = await getCredsResp.json();
  _credentials = Credentials;
  return _credentials;
}

async function makeS3Client(cfg, creds) {
  // Ensure AWS SDK v2 global `AWS` is available. If the page didn't include
  // the script tag (cached HTML), dynamically load it here and wait for it.
  if (typeof window.AWS === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://sdk.amazonaws.com/js/aws-sdk-2.1350.0.min.js';
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error('Failed to load AWS SDK v2'));
      document.head.appendChild(s);
    });
  }

  return new AWS.S3({
    region: cfg.region,
    credentials: new AWS.Credentials(creds.AccessKeyId, creds.SecretKey, creds.SessionToken),
    signatureVersion: 'v4',
  });
}

// Small wrapper helpers that mirror the v3 `send(Command)` style used elsewhere.
async function s3GetObject(params) { return await s3.getObject(params).promise(); }
async function s3PutObject(params) { return await s3.putObject(params).promise(); }
async function s3DeleteObject(params) { return await s3.deleteObject(params).promise(); }
async function s3ListObjectsV2(params) { return await s3.listObjectsV2(params).promise(); }
async function s3DeleteObjects(params) { return await s3.deleteObjects(params).promise(); }
async function s3PutObjectTagging(params) { return await s3.putObjectTagging(params).promise(); }
async function s3DeleteObjectTagging(params) { return await s3.deleteObjectTagging(params).promise(); }

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let cfg = null;       // runtime config (config.json)
let s3 = null;        // S3Client
let mailboxPrefix = null;  // e.g. "example.com/user"
let bucketName = null;

let currentFolder = 'inbox';
let folderIndex = {};  // folder → array of email summaries
let stateJson = { read: [] };
let currentEmail = null;  // { summary, folder }

const selectedUuids = new Set();  // UUIDs checked for bulk operations (inbox + spam only)

// ---------------------------------------------------------------------------
// S3 data layer
// ---------------------------------------------------------------------------

function indexKey(folder) {
  if (folder === 'inbox')      return `${mailboxPrefix}/inbox.index.json`;
  if (folder === 'spam')       return `${mailboxPrefix}/spam.index.json`;
  if (folder === 'quarantine') return `${mailboxPrefix}/quarantine.index.json`;
  if (folder === 'trash')      return `${mailboxPrefix}/trash.index.json`;
  return null;
}

async function loadIndex(folder) {
  const key = indexKey(folder);
  if (!key) return [];
  try {
    const resp = await s3GetObject({ Bucket: bucketName, Key: key });
    const text = await bodyToText(resp.Body);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Sometimes the body may already be an object-like string or a Buffer
      // fallback: attempt to coerce common forms
      try {
        // If it's a quoted JSON string, parse again
        if (typeof text === 'string' && text.startsWith('"') && text.endsWith('"')) {
          parsed = JSON.parse(JSON.parse(text));
        } else {
          throw e;
        }
      } catch {
        throw new Error('Failed to parse inbox index JSON');
      }
    }

    // Normalize into an array if the stored structure is an envelope or array-like
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.Contents)) return parsed.Contents;
      if (Array.isArray(parsed.Items)) return parsed.Items;
      // Numeric-keyed objects (Buffer-like) — convert to array of values
      if (parsed.length && typeof parsed.length === 'number') return Array.from(parsed);
      const arrProp = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
      if (arrProp) return parsed[arrProp];
    }

    // Unexpected shape — log for debugging and return empty
    console.warn('loadIndex: unexpected inbox index shape', parsed);
    return [];
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    throw e;
  }
}


function isEmailSummary(e) {
  return e && typeof e === 'object' && typeof e.uuid === 'string';
}

async function saveIndex(folder, arr) {
  const key = indexKey(folder);
  if (!key) return;
  await s3PutObject({
    Bucket: bucketName,
    Key: key,
    Body: JSON.stringify(arr),
    ContentType: 'application/json',
  });
}

async function loadState() {
  try {
    const resp = await s3GetObject({ Bucket: bucketName, Key: `${mailboxPrefix}/state.json` });
    const text = await bodyToText(resp.Body);
    stateJson = JSON.parse(text);
    if (!Array.isArray(stateJson.read)) stateJson.read = [];
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      stateJson = { read: [] };
    } else throw e;
  }
}

async function saveState() {
  await s3PutObject({
    Bucket: bucketName,
    Key: `${mailboxPrefix}/state.json`,
    Body: JSON.stringify(stateJson),
    ContentType: 'application/json',
  });
}

// List all keys under a prefix
async function listPrefix(prefix) {
  const keys = [];
  let token;
  do {
    const resp = await s3ListObjectsV2({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: token,
    });
    (resp.Contents || []).forEach(o => keys.push(o));
    token = resp.IsTruncated ? resp.NextContinuationToken : null;
  } while (token);
  return keys;
}

// Delete all objects with a prefix (batches of 1000)
async function deletePrefix(prefix) {
  const keys = await listPrefix(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map(o => ({ Key: o.Key }));
    await s3DeleteObjects({ Bucket: bucketName, Delete: { Objects: batch } });
  }
}

// Tag all objects for a UUID to schedule S3 lifecycle expiry.
// header.json gets the lifecycle tag; body and attachments get the same tag
// so S3 lifecycle expires all three objects together.
async function tagForExpiry(uuid, tag, summary) {
  const prefix = `${mailboxPrefix}/${uuid}`;
  const tagSet = { TagSet: [{ Key: 'lifecycle', Value: tag }] };
  await s3PutObjectTagging({ Bucket: bucketName, Key: `${prefix}/header.json`, Tagging: tagSet });
  // body and attachments only exist for inbox/spam emails (not quarantine)
  if (summary && (summary.hasHtml || summary.hasText)) {
    await s3PutObjectTagging({ Bucket: bucketName, Key: `${prefix}/body`, Tagging: tagSet });
    for (const att of (summary.attachments || [])) {
      await s3PutObjectTagging({ Bucket: bucketName, Key: `${prefix}/attachments/${att.filename}`, Tagging: tagSet });
    }
  }
}

// Remove lifecycle tag from header.json; re-apply tier=cold to body and attachments.
// DeleteObjectTagging wipes ALL tags, so we use PutObjectTagging on body/attachments
// to atomically remove the lifecycle tag and restore cold-tiering in one call.
async function restoreExpiryTag(uuid, summary) {
  const prefix = `${mailboxPrefix}/${uuid}`;
  await s3DeleteObjectTagging({ Bucket: bucketName, Key: `${prefix}/header.json` });
  if (summary && (summary.hasHtml || summary.hasText)) {
    const coldTag = { TagSet: [{ Key: 'tier', Value: 'cold' }] };
    await s3PutObjectTagging({ Bucket: bucketName, Key: `${prefix}/body`, Tagging: coldTag });
    for (const att of (summary.attachments || [])) {
      await s3PutObjectTagging({ Bucket: bucketName, Key: `${prefix}/attachments/${att.filename}`, Tagging: coldTag });
    }
  }
}

// Move email to trash: tag all objects + update indexes. No file copy or move.
async function moveToTrash(uuid, fromFolder) {
  const summary = (folderIndex[fromFolder] || []).find(e => e.uuid === uuid);
  await tagForExpiry(uuid, 'trash', summary);
  // Prepend to trash.index.json with deletedAt
  if (summary) {
    const trashEntry = { ...summary, deletedAt: new Date().toISOString() };
    const trashIdx = await loadIndex('trash');
    trashIdx.unshift(trashEntry);
    await saveIndex('trash', trashIdx);
    folderIndex['trash'] = trashIdx;
  }
}

// Restore email from trash back to inbox: remove lifecycle tag, restore cold tiering
async function restoreFromTrash(uuid, summary) {
  await restoreExpiryTag(uuid, summary);
  const trashIdx = (folderIndex['trash'] || await loadIndex('trash')).filter(e => e.uuid !== uuid);
  await saveIndex('trash', trashIdx);
  folderIndex['trash'] = trashIdx;
}

// Restore email from spam to inbox: remove lifecycle=spam tag, restore cold tiering
async function restoreFromSpam(uuid, summary) {
  await restoreExpiryTag(uuid, summary);
  const spamIdx = (folderIndex['spam'] || await loadIndex('spam')).filter(e => e.uuid !== uuid);
  await saveIndex('spam', spamIdx);
  folderIndex['spam'] = spamIdx;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function isRead(uuid) { return stateJson.read.includes(uuid); }

async function markRead(uuid) {
  if (isRead(uuid)) return;
  stateJson.read.push(uuid);
  await saveState();
  // Update unread badge
  const idx = (folderIndex[currentFolder] || []);
  updateUnreadBadge(idx);
}

async function markUnread(uuid) {
  const i = stateJson.read.indexOf(uuid);
  if (i === -1) return;
  stateJson.read.splice(i, 1);
  await saveState();
}

function updateUnreadBadge(inboxEmails) {
  const unread = inboxEmails.filter(e => !isRead(e.uuid)).length;
  const badge = $('badge-inbox');
  if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

// ---------------------------------------------------------------------------
// Bulk selection (inbox + spam only)
// ---------------------------------------------------------------------------

function toggleSelectEmail(uuid, checked) {
  if (checked) selectedUuids.add(uuid);
  else selectedUuids.delete(uuid);
  updateBulkBar();
  // Sync select-all checkbox indeterminate / checked state
  const allUuids = (folderIndex[currentFolder] || []).map(e => e.uuid);
  const allCb = $('select-all-cb');
  allCb.checked = allUuids.length > 0 && allUuids.every(id => selectedUuids.has(id));
  allCb.indeterminate = selectedUuids.size > 0 && !allCb.checked;
}

function updateBulkBar() {
  const count = selectedUuids.size;
  $('bulk-count').textContent = count;
  $('bulk-delete-btn').classList.toggle('hidden', count === 0);
}

function clearSelection() {
  selectedUuids.clear();
  const allCb = $('select-all-cb');
  allCb.checked = false;
  allCb.indeterminate = false;
  document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = false; });
  updateBulkBar();
}

// Bulk move selected emails to trash.
// Tags all objects of each email serially, then does ONE combined write to the
// source index and ONE combined write to trash.index.json.
async function bulkMoveToTrash() {
  const uuids = [...selectedUuids];
  if (uuids.length === 0) return;
  if (!confirm(`Move ${uuids.length} email${uuids.length === 1 ? '' : 's'} to trash?`)) return;

  const btn = $('bulk-delete-btn');
  btn.disabled = true;
  try {
    const sourceIdx = folderIndex[currentFolder] || [];
    const toMove    = sourceIdx.filter(e => uuids.includes(e.uuid));
    const deletedAt = new Date().toISOString();

    // Tag all objects of each email serially to avoid S3 concurrency issues
    for (const entry of toMove) {
      await tagForExpiry(entry.uuid, 'trash', entry);
    }

    // Remove all from source index in ONE combined write
    const newSourceIdx = sourceIdx.filter(e => !uuids.includes(e.uuid));
    await saveIndex(currentFolder, newSourceIdx);
    folderIndex[currentFolder] = newSourceIdx;

    // Prepend all entries to trash.index.json in ONE combined write
    const trashIdx    = await loadIndex('trash');
    const newTrashIdx = [...toMove.map(s => ({ ...s, deletedAt })), ...trashIdx];
    await saveIndex('trash', newTrashIdx);
    folderIndex['trash'] = newTrashIdx;

    // Close detail pane if the currently open email was moved
    if (currentEmail && uuids.includes(currentEmail.summary.uuid)) {
      hide('detail-pane');
      currentEmail = null;
    }

    clearSelection();
    renderList(newSourceIdx, currentFolder);
  } finally {
    btn.disabled = false;
  }
}

function verdictClass(v) {
  if (!v) return 'verdict-gray';
  return v === 'PASS' ? 'verdict-pass' : v === 'FAIL' ? 'verdict-fail' : 'verdict-gray';
}

function renderVerdicts(verdicts) {
  if (!verdicts) return;
  const bar = $('verdict-bar');
  const interesting = Object.entries(verdicts).filter(([,v]) => v && v !== 'PASS');
  if (interesting.length === 0) { bar.classList.add('hidden'); return; }

  bar.innerHTML = interesting.map(([name, val]) =>
    `<span class="verdict-chip ${verdictClass(val)}">${name.toUpperCase()}: ${val}</span>`
  ).join('');
  bar.classList.remove('hidden');
}

// Build a single email row element
function buildEmailRow(summary, folder) {
  const read = isRead(summary.uuid);
  const div = document.createElement('div');
  div.className = 'email-row' + (read ? '' : ' unread');
  div.dataset.uuid = summary.uuid;

  if (folder === 'inbox' || folder === 'spam') {
    // Checkbox for bulk selection. Replaces the unread dot — unread state is
    // conveyed by the row background colour (var(--unread-bg)) instead.
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'row-checkbox';
    cb.checked = selectedUuids.has(summary.uuid);
    cb.addEventListener('click', e => {
      e.stopPropagation();
      toggleSelectEmail(summary.uuid, cb.checked);
    });
    div.appendChild(cb);
  } else if (!read) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    div.appendChild(dot);
  }

  const top = document.createElement('div');
  top.className = 'row-top';

  const from = document.createElement('span');
  from.className = 'row-from';
  from.textContent = summary.from || '(unknown sender)';

  const date = document.createElement('span');
  date.className = 'row-date';

  if (folder === 'trash' && summary.deletedAt) {
    date.textContent = 'Deleted ' + formatDate(summary.deletedAt);
  } else {
    date.textContent = formatDate(summary.date);
  }

  top.appendChild(from);
  top.appendChild(date);

  const subject = document.createElement('div');
  subject.className = 'row-subject';
  subject.textContent = (summary.subject || '(no subject)') +
    (summary.attachments?.length ? ' 📎' : '');

  const preview = document.createElement('div');
  preview.className = 'row-preview';
  preview.textContent = summary.preview || '';

  div.appendChild(top);
  div.appendChild(subject);
  div.appendChild(preview);

  div.addEventListener('click', () => openEmail(summary, folder));
  return div;
}

// Render the email list for the current folder
function renderList(emails, folder) {
  const list = $('email-list');
  // Remove all rows (keep loading/empty sentinels)
  list.querySelectorAll('.email-row').forEach(el => el.remove());

  hide('list-loading');

  // Coerce unexpected envelopes to an array
  if (!Array.isArray(emails)) {
    // Common SDK responses: { Contents: [...] } or { Items: [...] }
    if (emails && Array.isArray(emails.Contents)) emails = emails.Contents;
    else if (emails && Array.isArray(emails.Items)) emails = emails.Items;
    else if (!emails) emails = [];
    else {
      // Try to find any array property
      const arrProp = Object.keys(emails).find(k => Array.isArray(emails[k]));
      if (arrProp) emails = emails[arrProp];
      else {
        console.warn('renderList: unexpected emails type', emails);
        emails = [];
      }
    }
  }

  if (emails.length === 0) {
    show('list-empty');
    $('list-count').textContent = '';
    return;
  }

  hide('list-empty');
  $('list-count').textContent = emails.length === 1 ? '1 message' : `${emails.length} messages`;

  const frag = document.createDocumentFragment();
  emails.forEach(s => frag.appendChild(buildEmailRow(s, folder)));
  list.appendChild(frag);

  if (folder === 'inbox') updateUnreadBadge(emails);
}

// ---------------------------------------------------------------------------
// Email open / detail render
// ---------------------------------------------------------------------------

async function openEmail(summary, folder) {
  currentEmail = { summary, folder };

  // Highlight the selected row
  document.querySelectorAll('.email-row.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`.email-row[data-uuid="${summary.uuid}"]`)?.classList.add('active');

  // Show detail pane, hide nothing yet
  show('detail-pane');
  $('detail-pane').classList.remove('hidden');
  $('detail-pane').classList.add('mobile-open');

  // Reset pane state
  hide('quarantine-banner');
  hide('verdict-bar');
  hide('attachments');
  hide('body-iframe');
  hide('body-text');
  show('body-loading');
  $('restore-btn').textContent = 'Restore'; // reset in case it was changed to 'Not spam'
  $('restore-btn').classList.add('hidden');
  $('perma-delete-btn').classList.add('hidden');
  $('delete-btn').classList.remove('hidden');

  // Populate header
  const h = $('email-header');
  h.querySelector('.email-from').textContent    = `From: ${summary.from}`;
  h.querySelector('.email-subject').textContent = summary.subject || '(no subject)';
  h.querySelector('.email-meta').textContent    =
    `To: ${summary.to || ''}  ·  ${new Date(summary.date).toLocaleString()}`;

  if (folder === 'quarantine') {
    show('quarantine-banner');
    hide('delete-btn');
    show('perma-delete-btn');
    renderAttachListFromMeta(summary, folder);
    hide('body-loading');
    return;
  }

  if (folder === 'spam') {
    $('restore-btn').textContent = 'Not spam';
    show('restore-btn');
  }

  if (folder === 'trash') {
    hide('delete-btn');
    show('restore-btn');
    show('perma-delete-btn');
  }

  renderVerdicts(summary.verdicts);
  renderAttachListFromMeta(summary, folder);

  // Fetch body — all emails flat at {mailboxPrefix}/{uuid}/
  const emailFolder = `${mailboxPrefix}/${summary.uuid}`;
  try {
    const resp = await s3GetObject({ Bucket: bucketName, Key: `${emailFolder}/body` });
    const bodyContent = await bodyToText(resp.Body);
    hide('body-loading');

    if (summary.hasHtml) {
      // Render in sandboxed iframe via srcdoc — prevents any XSS from escaping
      $('body-iframe').srcdoc = bodyContent;
      show('body-iframe');
    } else {
      $('body-text').textContent = bodyContent;
      show('body-text');
    }
  } catch (e) {
    hide('body-loading');
    $('body-text').textContent = '(Unable to load message body)';
    show('body-text');
  }

  // Mark as read
  await markRead(summary.uuid);
  document.querySelector(`.email-row[data-uuid="${summary.uuid}"]`)?.classList.remove('unread');
  document.querySelector(`.email-row[data-uuid="${summary.uuid}"] .unread-dot`)?.remove();
}

function renderAttachListFromMeta(summary, folder) {
  if (!summary.attachments?.length) return;

  const container = $('attachments');
  container.innerHTML = '';

  summary.attachments.forEach(att => {
    const chip = document.createElement('a');
    chip.className = 'attachment-chip';
    chip.textContent = `📎 ${att.filename}`;
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'attachment-size';
    sizeSpan.textContent = att.size ? `(${formatBytes(att.size)})` : '';
    chip.appendChild(sizeSpan);

    // Build direct S3-presigned-URL-style download — for private objects we use the
    // SDK to generate a pre-signed URL so the download stays server-side.
    chip.addEventListener('click', e => {
      e.preventDefault();
      downloadAttachment(summary, att, folder);
    });

    container.appendChild(chip);
  });

  show('attachments');
}

async function downloadAttachment(summary, att, folder) {
  // All emails stored flat — same path regardless of folder
  const key = `${mailboxPrefix}/${summary.uuid}/attachments/${att.filename}`;

  try {
    const resp = await s3GetObject({ Bucket: bucketName, Key: key });
    // resp.Body may be a ReadableStream (SDK v3 style) or an ArrayBuffer/Blob (v2 style)
    if (resp.Body && resp.Body.getReader) {
      const reader = resp.Body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const blob = new Blob(chunks, { type: att.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }

    // Fallback: SDK v2 returns body as Buffer/ArrayBuffer/Uint8Array/Blob
    let arrayBuffer = null;
    if (resp.Body instanceof ArrayBuffer) arrayBuffer = resp.Body;
    else if (resp.Body && resp.Body.arrayBuffer) arrayBuffer = await resp.Body.arrayBuffer();
    else if (resp.Body && resp.Body.constructor && resp.Body.constructor.name === 'Buffer' && resp.Body.buffer) arrayBuffer = resp.Body.buffer;

    if (arrayBuffer) {
      const blob = new Blob([new Uint8Array(arrayBuffer)], { type: att.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }

    throw new Error('Unsupported attachment body type');
  } catch (e) {
    alert(`Download failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Folder switching
// ---------------------------------------------------------------------------

async function switchFolder(folder) {
  currentFolder = folder;
  currentEmail = null;

  // Update sidebar active button
  document.querySelectorAll('.folder-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.folder === folder);
  });

  // Update title
  const titles = { inbox: 'Inbox', spam: 'Spam', quarantine: 'Quarantine', trash: 'Trash' };
  $('folder-title').textContent = titles[folder] || folder;

  // Clear bulk selection and show/hide bulk controls
  clearSelection();
  const hasBulk = (folder === 'inbox' || folder === 'spam');
  $('select-all-wrap').classList.toggle('hidden', !hasBulk);

  // Hide detail pane, reset list
  hide('detail-pane');
  $('detail-pane').classList.remove('mobile-open');

  // Clear list
  $('email-list').querySelectorAll('.email-row').forEach(el => el.remove());
  show('list-loading');
  hide('list-empty');
  $('list-count').textContent = '';

  const emails = await loadIndex(folder);
  // Validate shape: only accept arrays of email summaries (must have `uuid`).
  if (!Array.isArray(emails) || emails.length === 0 || !emails.every(isEmailSummary)) {
    // Diagnostic: log a small sample so we can see what shape arrived in production
    const sample = Array.isArray(emails) ? emails.slice(0,3) : emails;
    console.warn('switchFolder: loaded index has unexpected shape, refusing to render', folder, emails && emails.length, 'sample:', sample);
    // If array-like Contents (S3 listing), log keys for debugging
    if (Array.isArray(emails) && emails.length > 0 && emails[0].Key) {
      console.warn('switchFolder: first keys:', emails.slice(0,5).map(i => i.Key));
    }
    folderIndex[folder] = [];
    renderList([], folder);
  } else {
    folderIndex[folder] = emails;
    renderList(emails, folder);
  }
}

// ---------------------------------------------------------------------------
// Delete / restore actions
// ---------------------------------------------------------------------------

async function deleteCurrentEmail() {
  if (!currentEmail) return;
  const { summary, folder } = currentEmail;
  if (!confirm(`Move "${summary.subject}" to trash?`)) return;

  // Tag header.json for expiry + update trash.index.json
  await moveToTrash(summary.uuid, folder);

  // Remove from source folder index
  const idx = (folderIndex[folder] || []).filter(e => e.uuid !== summary.uuid);
  folderIndex[folder] = idx;
  await saveIndex(folder, idx);

  // Remove row from UI
  document.querySelector(`.email-row[data-uuid="${summary.uuid}"]`)?.remove();
  hide('detail-pane');
  currentEmail = null;
  renderList(folderIndex[folder], folder);
}

async function restoreCurrentEmail() {
  if (!currentEmail) return;
  const { summary, folder } = currentEmail;
  const label = folder === 'spam' ? 'Not spam' : 'Restore';
  if (!confirm(`${label} "${summary.subject}" to inbox?`)) return;

  if (folder === 'spam') {
    await restoreFromSpam(summary.uuid, summary);
  } else {
    await restoreFromTrash(summary.uuid, summary);
  }

  // Add back to inbox (strip deletedAt if present — trash entries carry it)
  const { deletedAt: _deleted, ...cleanSummary } = summary;
  const inbox = await loadIndex('inbox');
  if (!inbox.find(e => e.uuid === summary.uuid)) {
    inbox.unshift(cleanSummary);
    await saveIndex('inbox', inbox);
    folderIndex['inbox'] = inbox;
  }

  // Remove from current folder view and update UI
  folderIndex[folder] = (folderIndex[folder] || []).filter(e => e.uuid !== summary.uuid);
  document.querySelector(`.email-row[data-uuid="${summary.uuid}"]`)?.remove();
  hide('detail-pane');
  currentEmail = null;
  renderList(folderIndex[folder], folder);
}

async function permanentlyDeleteCurrentEmail() {
  if (!currentEmail) return;
  const { summary, folder } = currentEmail;
  if (!confirm(`Permanently delete "${summary.subject}"? This cannot be undone.`)) return;

  // Delete all {uuid}/* objects (body, attachments, header.json)
  await deletePrefix(`${mailboxPrefix}/${summary.uuid}/`);

  // Remove from current folder's index
  const idx = (folderIndex[folder] || []).filter(e => e.uuid !== summary.uuid);
  folderIndex[folder] = idx;
  await saveIndex(folder, idx);

  document.querySelector(`.email-row[data-uuid="${summary.uuid}"]`)?.remove();
  hide('detail-pane');
  currentEmail = null;
  renderList(folderIndex[folder] || [], folder);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

async function logout() {
  const tokens = getTokens();
  clearTokens();
  _credentials = null;

  // Attempt Cognito logout (best-effort — don't block on failure)
  try {
    const params = new URLSearchParams({
      client_id:   cfg.cognitoAppClientId,
      logout_uri:  window.location.origin + '/app/',
    });
    window.location.assign(`${cfg.cognitoHostedUiDomain}/logout?${params}`);
  } catch {
    location.reload();
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    cfg = await getConfig();
  } catch (e) {
    $('auth-error').textContent = 'Failed to load app configuration. Please try refreshing.';
    show('auth-error');
    return;
  }

  // Lazy-load the AWS SDK browser bundle after the stub in index.html sets
  // `window.process.env`. This avoids the SDK's Node shims running at module
  // evaluation time and trying to access the filesystem.
  try {
    const s3mod = await import('https://esm.sh/@aws-sdk/client-s3@3');
    S3Client = s3mod.S3Client;
    GetObjectCommand = s3mod.GetObjectCommand;
    PutObjectCommand = s3mod.PutObjectCommand;
    DeleteObjectCommand = s3mod.DeleteObjectCommand;
    PutObjectTaggingCommand = s3mod.PutObjectTaggingCommand;
    DeleteObjectTaggingCommand = s3mod.DeleteObjectTaggingCommand;
    ListObjectsV2Command = s3mod.ListObjectsV2Command;
    DeleteObjectsCommand = s3mod.DeleteObjectsCommand;
  } catch (e) {
    console.error('Failed to load AWS SDK:', e);
    $('auth-error').textContent = 'Failed to load runtime dependencies. Try refreshing.';
    show('auth-error');
    return;
  }

  $('login-btn').addEventListener('click', () => startLogin(cfg));

  // Check for OAuth callback code in URL
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  let tokens = getTokens();

  if (code) {
    try {
      await exchangeCode(cfg, code);
      tokens = getTokens();
    } catch (e) {
      $('auth-error').textContent = `Login failed: ${e.message}`;
      show('auth-error');
      return;
    }
  }

  if (!tokens.id) {
    // Not logged in — show auth screen
    show('auth-screen');
    hide('app-screen');
    return;
  }

  // Refresh if expired
  if (Date.now() > tokens.expiresAt) {
    try {
      tokens = await refreshTokens(cfg);
    } catch {
      clearTokens();
      show('auth-screen');
      hide('app-screen');
      return;
    }
  }

  // Parse mailbox from ID token claims
  const claims = parseJwtClaims(tokens.id);
  if (!claims) { clearTokens(); location.reload(); return; }

  const mailboxUser   = claims['custom:mailbox_user'];
  const mailboxDomain = claims['custom:mailbox_domain'];

  if (!mailboxUser || !mailboxDomain) {
    $('auth-error').textContent =
      'Your account is not configured with a mailbox. Please contact the administrator.';
    show('auth-error');
    return;
  }

  // Get scoped AWS credentials
  let creds;
  try {
    creds = await getCredentials(cfg, tokens.id);
  } catch (e) {
    $('auth-error').textContent = `AWS credential exchange failed: ${e.message}`;
    show('auth-error');
    return;
  }

  s3 = await makeS3Client(cfg, creds);
  mailboxPrefix = `${mailboxDomain}/${mailboxUser}`;
  bucketName = cfg.bucketName;

  // Show app
  hide('auth-screen');
  show('app-screen');

  $('user-email').textContent = claims.email || `${mailboxUser}@${mailboxDomain}`;

  // Bind UI actions
  $('logout-btn').addEventListener('click', logout);
  $('back-btn').addEventListener('click', () => {
    hide('detail-pane');
    $('detail-pane').classList.remove('mobile-open');
  });
  $('delete-btn').addEventListener('click', deleteCurrentEmail);
  $('restore-btn').addEventListener('click', restoreCurrentEmail);
  $('perma-delete-btn').addEventListener('click', permanentlyDeleteCurrentEmail);
  $('mark-unread-btn').addEventListener('click', async () => {
    if (!currentEmail) return;
    await markUnread(currentEmail.summary.uuid);
    document.querySelector(`.email-row[data-uuid="${currentEmail.summary.uuid}"]`)
      ?.classList.add('unread');
  });

  $('bulk-delete-btn').addEventListener('click', bulkMoveToTrash);

  $('select-all-cb').addEventListener('change', e => {
    const emails = folderIndex[currentFolder] || [];
    if (e.target.checked) {
      emails.forEach(em => selectedUuids.add(em.uuid));
      document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = true; });
    } else {
      selectedUuids.clear();
      document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = false; });
    }
    updateBulkBar();
  });

  document.querySelectorAll('.folder-btn').forEach(btn => {
    btn.addEventListener('click', () => switchFolder(btn.dataset.folder));
  });

  // Load state and inbox
  await Promise.all([loadState(), switchFolder('inbox')]);

  // Index polling — check inbox.index.json LastModified every 2 minutes.
  // If it changed, reload the inbox silently and update the unread badge.
  // Uses a HEAD request (HeadObjectCommand would also work but GetObject with
  // conditional If-None-Match is simpler with the SDK).
  let lastInboxETag = null;
  async function pollInbox() {
    try {
      // ListObjectsV2 with a single key is cheaper than HeadObject for this purpose.
      // We just need the ETag/LastModified of inbox.index.json.
        const resp = await s3ListObjectsV2({
          Bucket: bucketName,
          Prefix: `${mailboxPrefix}/inbox.index.json`,
          MaxKeys: 1,
        });
        const obj = (resp.Contents || [])[0];
        if (!obj) return;
        // Ensure we actually got the index.json object and not a listing of many keys.
        if (obj.Key !== `${mailboxPrefix}/inbox.index.json`) {
          console.warn('pollInbox: unexpected ListObjectsV2 response', resp);
          return;
        }
        const etag = obj.ETag;
      if (lastInboxETag && etag !== lastInboxETag) {
        // Index changed — new email arrived (or browser on another device modified it)
        const emails = await loadIndex('inbox');
        if (!Array.isArray(emails) || emails.length === 0 || !emails.every(isEmailSummary)) {
          console.warn('pollInbox: loadIndex returned unexpected shape, skipping update', emails && emails.length);
        } else {
          folderIndex['inbox'] = emails;
          if (currentFolder === 'inbox') {
            renderList(emails, 'inbox');
          } else {
            updateUnreadBadge(emails);
          }
        }
      }
      lastInboxETag = etag;
    } catch { /* network issue — skip tick */ }
  }

  // First ETag capture after initial load
  pollInbox();
  setInterval(pollInbox, 2 * 60 * 1000);

  // Periodic credential refresh — check every 4 minutes
  setInterval(async () => {
    let t = getTokens();
    if (Date.now() > t.expiresAt) {
      try { t = await refreshTokens(cfg); } catch { logout(); return; }
    }
    try {
      const freshCreds = await getCredentials(cfg, t.id);
      s3 = await makeS3Client(cfg, freshCreds);
    } catch { /* will retry next tick */ }
  }, 4 * 60 * 1000);
}

init().catch(err => {
  console.error('Fatal init error:', err);
});
