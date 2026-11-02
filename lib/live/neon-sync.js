const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Transform } = require('stream');
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

function neonUrl(envFile = ENV_FILE) {
  const file = readEnvFile(envFile);
  return (process.env.NEON_DB_URL || file.NEON_DB_URL || '').trim();
}

function neonConfigured(envFile) {
  return !!neonUrl(envFile);
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

async function defaultPost(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  await response.text().catch(() => '');
  return { ok: response.ok, status: response.status };
}

// One small trigger after a restore. The check itself happens in Grok Bot.
async function notifyRestore({ envFile, post = defaultPost } = {}) {
  const { url, token } = webhookConfig(envFile);
  if (!url || !token) return { ok: false, skipped: true, reason: 'not configured' };
  let result;
  try {
    result = await post(url, token, { event: 'restore-finished' });
  } catch (err) {
    return { ok: false, error: redact(err && err.message ? err.message : err) };
  }
  if (!result || !result.ok) {
    return { ok: false, status: result && result.status ? result.status : null };
  }
  return { ok: true, status: result.status || null };
}

// pg_dump 17 writes a setting that older servers reject. Drop that line only.
function dropTransactionTimeout() {
  let pending = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      const kept = lines.filter(line => !/^SET transaction_timeout\b/.test(line));
      callback(null, kept.length ? `${kept.join('\n')}\n` : '');
    },
    flush(callback) {
      if (pending && !/^SET transaction_timeout\b/.test(pending)) callback(null, pending);
      else callback();
    },
  });
}

// Old libpq (Postgres 13 on the Pi) has no SNI, so Neon rejects the connection
// unless the endpoint id is sent in the startup options.
function neonEndpointId(hostname) {
  const first = String(hostname || '').split('.')[0];
  if (!first.startsWith('ep-')) return '';
  return first.replace(/-pooler$/, '');
}

function targetFromUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('NEON_DB_URL is not a postgres url');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !url.username || !database) {
    throw new Error('NEON_DB_URL is missing the host, user, or database');
  }
  const endpoint = neonEndpointId(url.hostname);
  const existing = url.searchParams.get('options') || '';
  const hasEndpoint = /(^|\s)endpoint=/.test(existing);
  const options = endpoint && !hasEndpoint
    ? (existing ? `${existing} endpoint=${endpoint}` : `endpoint=${endpoint}`)
    : existing;
  const target = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password || ''),
    PGDATABASE: database,
    PGSSLMODE: url.searchParams.get('sslmode') || 'require',
  };
  if (options) target.PGOPTIONS = options;
  return target;
}

function sourceEnv(source) {
  return {
    PGHOST: source.host || 'localhost',
    PGPORT: String(source.port || 5432),
    PGUSER: source.user || 'postgres',
    PGPASSWORD: source.password || '',
    PGDATABASE: source.database || 'postgres',
    PGSSLMODE: 'prefer',
    PGOPTIONS: '',
  };
}

function childEnv(base) {
  return { ...process.env, ...base };
}

function pipeDump({ source, target, signal }) {
  return new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', [
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '--encoding=UTF8',
    ], { env: childEnv(source) });
    const restore = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-q'], { env: childEnv(target) });
    const filter = dropTransactionTimeout();
    let dumpErr = '';
    let restoreErr = '';
    let bytes = 0;
    let dumpCode = null;
    let restoreCode = null;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      dump.kill();
      restore.kill();
      reject(error);
    };

    const finish = () => {
      if (settled || dumpCode === null || restoreCode === null) return;
      settled = true;
      if (signal && signal.aborted) {
        resolve({ ok: false, skipped: true, reason: 'stopped', bytes });
        return;
      }
      if (dumpCode !== 0) {
        reject(new Error(redact(`pg_dump exited ${dumpCode}: ${dumpErr || 'no error output'}`)));
        return;
      }
      if (restoreCode !== 0) {
        reject(new Error(redact(`psql exited ${restoreCode}: ${restoreErr || 'no error output'}`)));
        return;
      }
      resolve({ ok: true, bytes });
    };

    filter.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
    });
    dump.stdout.pipe(filter).pipe(restore.stdin);
    dump.stderr.on('data', (chunk) => {
      dumpErr = (dumpErr + chunk.toString('utf8')).slice(-4000);
    });
    restore.stderr.on('data', (chunk) => {
      restoreErr = (restoreErr + chunk.toString('utf8')).slice(-4000);
    });
    dump.stdout.on('error', () => {});
    filter.on('error', () => {});
    restore.stdin.on('error', () => {});

    dump.on('error', (err) => {
      fail(new Error(err.code === 'ENOENT' ? 'pg_dump not found' : redact(err.message)));
    });
    restore.on('error', (err) => {
      fail(new Error(err.code === 'ENOENT' ? 'psql not found' : redact(err.message)));
    });
    dump.on('close', (code) => {
      dumpCode = code == null ? 1 : code;
      finish();
    });
    restore.on('close', (code) => {
      restoreCode = code == null ? 1 : code;
      finish();
    });

    if (signal) {
      const stop = () => {
        dump.kill();
        restore.kill();
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });
}

// Full dump of the app database, views included, then restore into Neon.
async function syncToNeon({ envFile, url, source, signal, run = pipeDump, post } = {}) {
  const targetUrl = (url || neonUrl(envFile) || '').trim();
  if (!targetUrl) return { ok: false, skipped: true, reason: 'not configured' };
  const target = targetFromUrl(targetUrl);
  const from = sourceEnv(source || getConfig());
  const restored = await run({ source: from, target, signal });
  if (!restored || !restored.ok || (signal && signal.aborted)) return restored;
  const notify = await notifyRestore({ envFile, post });
  return { ...restored, notify };
}

module.exports = {
  dropTransactionTimeout,
  neonConfigured,
  neonUrl,
  redact,
  notifyRestore,
  syncToNeon,
  targetFromUrl,
};
