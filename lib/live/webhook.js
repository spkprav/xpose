const fs = require('fs');
const path = require('path');

// Stay under a size an automation prompt can actually read. One oversized
// row still goes out alone so a long profile is not dropped.
const CHUNK_BYTES = 60 * 1024;

const ENV_FILE = path.resolve(__dirname, '../..', '.env');

function readEnvFile(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function webhookConfig(envFile = ENV_FILE) {
  const file = readEnvFile(envFile);
  return {
    url: (process.env.CURSOR_AUTOMATION_WEBHOOK || file.CURSOR_AUTOMATION_WEBHOOK || '').trim(),
    token: (process.env.CURSOR_AUTOMATION_WEBHOOK_TOKEN || file.CURSOR_AUTOMATION_WEBHOOK_TOKEN || '').trim(),
  };
}

function countKinds(items) {
  const counts = { tweets: 0, people: 0, news: 0, trends: 0 };
  for (const item of items) {
    if (item.kind === 'tweet') counts.tweets += 1;
    else if (item.kind === 'who_to_follow') counts.people += 1;
    else if (item.kind === 'news') counts.news += 1;
    else if (item.kind === 'trend') counts.trends += 1;
  }
  return counts;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function chunkItems(items, maxBytes = CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const item of items) {
    const itemSize = jsonSize(item);
    const extra = itemSize + (current.length ? 1 : 0);
    if (current.length && size + extra > maxBytes) {
      chunks.push(current);
      current = [item];
      size = itemSize + 2;
    } else {
      current.push(item);
      size += extra;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function redact(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/crsr_[a-f0-9]+/gi, '[redacted]')
    .slice(0, 180);
}

function safeError(err) {
  return redact(err && err.message ? err.message : err);
}

async function defaultPost(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (response.ok) return { ok: true, status: response.status };
  const text = await response.text().catch(() => '');
  return { ok: false, status: response.status, error: text.slice(0, 180) };
}

// Posts one finished live pass. Chunks are sequential so the receiver sees
// 1 of N, then 2 of N. A failed chunk stops the rest; the caller keeps the
// unsent rows for the next finished pass.
async function postLiveBatch({ cycle, items, post = defaultPost, envFile, config, maxBytes } = {}) {
  const list = Array.isArray(items) ? items : [];
  const creds = config || webhookConfig(envFile);
  const url = creds.url || '';
  const token = creds.token || '';
  if (!url || !token) return { ok: false, skipped: true, reason: 'not configured' };
  if (!list.length) return { ok: true, skipped: true, reason: 'empty', chunks: 0, items: 0 };

  const chunks = chunkItems(list, maxBytes || CHUNK_BYTES);
  const counts = countKinds(list);
  const finishedAt = new Date().toISOString();
  let sentItems = 0;
  for (let i = 0; i < chunks.length; i++) {
    let result;
    try {
      result = await post(url, token, {
        source: 'xpose',
        kind: 'live-pass',
        cycle: cycle || 0,
        finished_at: finishedAt,
        chunk: i + 1,
        chunks: chunks.length,
        total_items: list.length,
        counts,
        items: chunks[i],
      });
    } catch (err) {
      return { ok: false, sent: i, sentItems, chunks: chunks.length, error: safeError(err) };
    }
    if (!result || !result.ok) {
      return {
        ok: false,
        sent: i,
        sentItems,
        chunks: chunks.length,
        status: result && result.status,
        error: result && result.error ? redact(result.error) : 'request failed',
      };
    }
    sentItems += chunks[i].length;
  }
  return { ok: true, chunks: chunks.length, items: list.length, sentItems };
}

module.exports = {
  CHUNK_BYTES,
  chunkItems,
  countKinds,
  postLiveBatch,
  redact,
  webhookConfig,
};
