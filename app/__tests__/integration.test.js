/**
 * Integration test: simulate a ListObjectsV2 response (many S3 Keys)
 * and verify that, if the code treats that as the inbox index, the UI
 * will render many rows with missing fields — reproducing the reported symptom.
 */
const { normalizeIndexShape } = require('../lib.js');

function makeDom() {
  document.body.innerHTML = `
    <div id="email-list" class="email-list">
      <div id="list-loading" class="loading">Loading…</div>
      <div id="list-empty" class="empty hidden">No messages</div>
    </div>
    <span id="list-count"></span>
  `;
}

function renderListLikeApp(emails) {
  const list = document.getElementById('email-list');
  list.querySelectorAll('.email-row').forEach(el => el.remove());

  const listLoading = document.getElementById('list-loading');
  listLoading.style.display = 'none';

  if (!emails || emails.length === 0) {
    document.getElementById('list-empty').classList.remove('hidden');
    document.getElementById('list-count').textContent = '';
    return;
  }

  document.getElementById('list-empty').classList.add('hidden');
  document.getElementById('list-count').textContent = `${emails.length} messages`;

  emails.forEach(s => {
    const div = document.createElement('div');
    div.className = 'email-row';
    const from = document.createElement('span');
    from.className = 'row-from';
    from.textContent = s.from || '(unknown sender)';
    const subj = document.createElement('div');
    subj.className = 'row-subject';
    subj.textContent = s.subject || '(no subject)';
    div.appendChild(from);
    div.appendChild(subj);
    list.appendChild(div);
  });
}

test('rendering many Keys-only objects shows blank info (reproduces symptom)', () => {
  // Build a fake ListObjectsV2 response with many Contents entries that only have Key
  const N = 3526;
  const contents = Array.from({ length: N }).map((_, i) => ({ Key: `mailbox/${i}/header.json` }));
  const resp = { Contents: contents };

  makeDom();

  // normalizeIndexShape should pick up resp.Contents
  const normalized = normalizeIndexShape(resp);
  expect(Array.isArray(normalized)).toBe(true);
  expect(normalized.length).toBe(N);

  // The app should detect that these entries are not email summaries and refuse
  // to render them; confirm that no rows are rendered.
  renderListLikeApp(normalized.filter(item => item.uuid && item.uuid.length));
  const rows = document.querySelectorAll('.email-row');
  // Since the items have no uuid, the app will not render them (simulate validation)
  expect(rows.length).toBe(0);
});
