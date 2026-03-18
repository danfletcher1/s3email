const { parseJwtClaims, bodyToText, normalizeIndexShape } = require('../lib.js');

test('parseJwtClaims returns object for valid JWT', () => {
  const payload = { sub: '123', email: 'a@b.com' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt = `xxx.${b64}.sig`;
  expect(parseJwtClaims(jwt)).toEqual(payload);
});

test('parseJwtClaims returns null for invalid input', () => {
  expect(parseJwtClaims('not.a.jwt')).toBeNull();
});

test('bodyToText handles string and ArrayBuffer and Readable-like', async () => {
  expect(await bodyToText('hello')).toBe('hello');

  const buf = new TextEncoder().encode('bytes');
  const ab = buf.buffer;
  expect(await bodyToText(ab)).toBe('bytes');

  // Mock readable stream
  const chunks = [new TextEncoder().encode('ch1'), new TextEncoder().encode('ch2')];
  const reader = {
    idx: 0,
    async read() {
      if (this.idx >= chunks.length) return { done: true };
      return { done: false, value: chunks[this.idx++] };
    }
  };
  const readable = { getReader: () => reader };
  expect(await bodyToText(readable)).toBe('ch1ch2');
});

test('normalizeIndexShape handles various envelopes', () => {
  const arr = [{ a: 1 }];
  expect(normalizeIndexShape(arr)).toBe(arr);

  expect(normalizeIndexShape({ Contents: arr })).toBe(arr);
  expect(normalizeIndexShape({ Items: arr })).toBe(arr);

  const numeric = { 0: { a: 1 }, 1: { a: 2 }, length: 2 };
  expect(normalizeIndexShape(numeric)).toEqual([{ a:1 }, { a:2 }]);

  expect(normalizeIndexShape(null)).toEqual([]);
});
