// LinkedIn endpoint recon: attach CDP debugger to linkedinView, log every
// voyager API hit, dedupe by pattern, save first response body per pattern
// to disk for later inventory + extractor authoring.
//
// "Pattern" = the URL with dynamic ids stripped + queryId param normalized.
// e.g.
//   https://www.linkedin.com/voyager/api/identity/profiles/abc-123/profileView
//   → identity/profiles/{id}/profileView
//
//   https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed.1234abcd&variables=...
//   → graphql:voyagerFeedDashMainFeed
//
// All captures land in <repo>/out/linkedin-recon/.

const fs = require('fs');
const path = require('path');
const { extractByPattern } = require('./extractors');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'out', 'linkedin-recon');

// Set by recon.attach({ ingestFn }) — if provided, every captured response is
// piped through extractors → ingestFn(prospects[]). Caller decides whether to
// upsert into DB or just log.
let ingestFn = null;
let autoStore = false;
const ingestStats = { extracted: 0, upserted: 0, errors: 0 };

// Pattern → metadata. In-memory state for this process.
const captured = new Map();
const pendingRequests = new Map(); // requestId → { url, pattern, ts }

let view = null;
let onEvent = null;
let attached = false;
let detachReason = null;
let totalHits = 0;

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function normalizePattern(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith('linkedin.com')) return null;
    if (!u.pathname.startsWith('/voyager/')) return null;

    // GraphQL endpoints — keyed by queryId prefix (before the hash).
    if (u.pathname === '/voyager/api/graphql') {
      const qid = u.searchParams.get('queryId') || 'unknown';
      const head = qid.split('.')[0];  // strip hash suffix
      return `graphql:${head}`;
    }

    // REST endpoints — replace numeric IDs + URN-encoded slugs with {id}.
    const segs = u.pathname.split('/').filter(Boolean);
    const norm = segs.map(s => {
      if (/^\d{4,}$/.test(s)) return '{id}';
      if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return '{slug}';
      if (s.startsWith('urn%3Ali%3A')) return '{urn}';
      return s;
    });
    return norm.join('/');
  } catch (_) {
    return null;
  }
}

function safeFilename(pattern) {
  return pattern.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

async function captureBody(requestId) {
  try {
    const resp = await view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
    return resp.base64Encoded ? Buffer.from(resp.body, 'base64').toString('utf8') : resp.body;
  } catch (err) {
    return null;
  }
}

function handleMessage(event, method, params) {
  if (method === 'Network.requestWillBeSent') {
    const pattern = normalizePattern(params.request.url);
    if (!pattern) return;
    pendingRequests.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers || {},
      pattern,
      ts: Date.now(),
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const info = pendingRequests.get(params.requestId);
    if (!info) return;
    pendingRequests.delete(params.requestId);
    totalHits++;

    const seenBefore = captured.has(info.pattern);
    const entry = captured.get(info.pattern) || {
      pattern: info.pattern,
      first_seen: info.ts,
      hit_count: 0,
      example_url: info.url,
      method: info.method,
      saved_body_path: null,
    };
    entry.hit_count++;
    entry.last_seen = Date.now();
    captured.set(info.pattern, entry);

    emit({ kind: 'hit', pattern: info.pattern, hit_count: entry.hit_count, url: info.url });
    if (entry.hit_count === 1 || entry.hit_count % 5 === 0) {
      console.log(`[LinkedIn:Recon] hit ${info.pattern} (${entry.hit_count})`);
    }

    // Single body fetch shared between save + ingest. Avoids CDP race where
    // parallel Network.getResponseBody calls compete for the same requestId.
    const needSave = !seenBefore;
    const needIngest = autoStore && ingestFn;
    if (!needSave && !needIngest) return;

    captureBody(params.requestId).then(body => {
      if (body == null) return;
      let bodyJson = null;
      try { bodyJson = JSON.parse(body); } catch (_) {}

      // Save first-occurrence body to disk.
      if (needSave) {
        ensureOutDir();
        const file = path.join(OUT_DIR, safeFilename(info.pattern) + '.json');
        const payload = {
          pattern: info.pattern,
          url: info.url,
          method: info.method,
          captured_at: new Date().toISOString(),
          request_headers: info.headers,
          body_length: body.length,
          body_sample: body.slice(0, 200_000),
        };
        if (bodyJson) payload.body_json = bodyJson;
        try {
          fs.writeFileSync(file, JSON.stringify(payload, null, 2));
          entry.saved_body_path = file;
          emit({ kind: 'saved', pattern: info.pattern, file });
        } catch (err) {
          emit({ kind: 'save_error', pattern: info.pattern, error: err.message });
        }
      }

      // Extract + upsert on EVERY response (paginated calls add new prospects).
      if (needIngest && bodyJson) {
        ingestFromBody(info, bodyJson).catch(err => {
          ingestStats.errors++;
          emit({ kind: 'ingest_error', pattern: info.pattern, error: err.message });
        });
      }
    }).catch(() => {});
    return;
  }

  if (method === 'Network.loadingFailed') {
    pendingRequests.delete(params.requestId);
  }
}

function emit(ev) {
  if (typeof onEvent === 'function') {
    try { onEvent(ev); } catch (_) {}
  }
}

async function ingestFromBody(info, bodyJson) {
  const rows = extractByPattern(info.pattern, bodyJson);
  if (!rows.length) return;
  ingestStats.extracted += rows.length;
  console.log(`[LinkedIn:Ingest] ${info.pattern} extracted=${rows.length} (cum extracted=${ingestStats.extracted})`);
  try {
    const n = await ingestFn(rows);
    ingestStats.upserted += (typeof n === 'number' ? n : rows.length);
    console.log(`[LinkedIn:Ingest] upserted=${n} cum=${ingestStats.upserted}`);
    emit({ kind: 'ingested', pattern: info.pattern, count: rows.length, total_upserted: ingestStats.upserted });
  } catch (err) {
    ingestStats.errors++;
    emit({ kind: 'ingest_error', pattern: info.pattern, error: err.message });
  }
}

function setAutoStore(enabled, fn) {
  autoStore = !!enabled;
  if (fn) ingestFn = fn;
  console.log(`[LinkedIn:Recon] autoStore=${autoStore} ingestFn=${typeof ingestFn === 'function' ? 'set' : 'null'}`);
  emit({ kind: 'autostore', enabled: autoStore });
}

function attach(linkedinView, opts = {}) {
  if (attached) {
    console.log('[LinkedIn:Recon] attach: already attached');
    return { ok: true, already: true };
  }
  view = linkedinView;
  onEvent = opts.onEvent || null;
  if (opts.ingestFn) ingestFn = opts.ingestFn;
  if (opts.autoStore != null) autoStore = !!opts.autoStore;

  try {
    view.webContents.debugger.attach('1.3');
    console.log('[LinkedIn:Recon] CDP debugger attached');
  } catch (err) {
    console.error('[LinkedIn:Recon] CDP attach failed:', err.message);
    return { ok: false, error: err.message };
  }
  view.webContents.debugger.on('detach', (_e, reason) => {
    attached = false;
    detachReason = reason;
    emit({ kind: 'detached', reason });
  });
  view.webContents.debugger.on('message', handleMessage);

  view.webContents.debugger.sendCommand('Network.enable', {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 25_000_000,
  }).catch(err => {
    emit({ kind: 'error', error: err.message });
  });

  attached = true;
  detachReason = null;
  emit({ kind: 'attached' });
  return { ok: true };
}

function detach() {
  if (!attached || !view) return { ok: true, already: true };
  try { view.webContents.debugger.detach(); } catch (_) {}
  attached = false;
  return { ok: true };
}

function status() {
  return {
    attached,
    detachReason,
    total_hits: totalHits,
    unique_patterns: captured.size,
    out_dir: OUT_DIR,
    auto_store: autoStore,
    ingest_stats: { ...ingestStats },
    patterns: [...captured.values()]
      .sort((a, b) => b.hit_count - a.hit_count)
      .map(p => ({
        pattern: p.pattern,
        hit_count: p.hit_count,
        first_seen: p.first_seen,
        last_seen: p.last_seen,
        saved: !!p.saved_body_path,
      })),
  };
}

function reset() {
  captured.clear();
  pendingRequests.clear();
  totalHits = 0;
  ingestStats.extracted = 0;
  ingestStats.upserted = 0;
  ingestStats.errors = 0;
}

// External callers (DOM scraper, custom workflows) record upserts they did
// outside the CDP-driven extraction path. Keeps the global counter coherent
// so phaseStats deltas reflect ALL prospect inserts, not just voyager ones.
function recordExternalUpserts(extractedCount, upsertedCount, sourceTag = 'external') {
  ingestStats.extracted += extractedCount || 0;
  ingestStats.upserted  += upsertedCount || 0;
  emit({ kind: 'ingested', pattern: sourceTag, count: upsertedCount, total_upserted: ingestStats.upserted });
}

module.exports = { attach, detach, status, reset, setAutoStore, recordExternalUpserts };
