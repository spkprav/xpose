const fs = require('fs');
const path = require('path');
const { getConfig } = require('../db');

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

function redact(text) {
  return String(text || '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[url]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bpassword=\S+/gi, 'password=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/crsr_[a-f0-9]+/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function webhookConfig(envFile = ENV_FILE) {
  const file = readEnvFile(envFile);
  return {
    url: (process.env.CURSOR_AUTOMATION_WEBHOOK || file.CURSOR_AUTOMATION_WEBHOOK || '').trim(),
    token: (process.env.CURSOR_AUTOMATION_WEBHOOK_TOKEN || file.CURSOR_AUTOMATION_WEBHOOK_TOKEN || '').trim(),
  };
}

function webhookConfigured(envFile) {
  const { url, token } = webhookConfig(envFile);
  return !!(url && token);
}

async function defaultPost(url, token, body, signal) {
  const authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await response.text().catch(() => '');
  return { ok: response.ok, status: response.status };
}

// Tell the check a pass finished. It reads the same Postgres the app writes to.
async function notifyPass({ envFile, post = defaultPost, signal, source } = {}) {
  const { url, token } = webhookConfig(envFile);
  if (!url || !token) return { ok: false, skipped: true, reason: 'not configured' };
  if (signal && signal.aborted) return { ok: false, skipped: true, reason: 'stopped' };
  const db = source || getConfig();
  let result;
  try {
    result = await post(url, token, {
      event: 'pass-finished',
      host: db.host || '',
      database: db.database || '',
    }, signal);
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, skipped: true, reason: 'stopped' };
    return { ok: false, error: redact(err && err.message ? err.message : err) };
  }
  if (!result || !result.ok) {
    return { ok: false, status: result && result.status ? result.status : null };
  }
  return { ok: true, status: result.status || null };
}

module.exports = {
  redact,
  webhookConfigured,
  notifyPass,
};
