// Lightweight helper utilities extracted for unit testing.

function parseJwtClaims(jwt) {
  try {
    const payload = jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function bodyToText(body) {
  if (!body) return '';
  // ReadableStream-like (has getReader)
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
  // Blob/Response-like with arrayBuffer
  if (body.arrayBuffer) {
    const ab = await body.arrayBuffer();
    return new TextDecoder().decode(ab);
  }
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return '' }
}

function normalizeIndexShape(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.Contents)) return parsed.Contents;
    if (Array.isArray(parsed.Items)) return parsed.Items;
    if (typeof parsed.length === 'number') return Array.from(parsed);
    const arrProp = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    if (arrProp) return parsed[arrProp];
  }
  return [];
}
module.exports = { parseJwtClaims, bodyToText, normalizeIndexShape };
