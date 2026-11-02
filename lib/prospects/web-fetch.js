// Fetch home / about / pricing pages of a prospect's website and produce a
// compact text blurb suitable for embedding. Per-request timeout + size cap to
// avoid hanging the workflow on slow or huge sites.
//
// Used by lib/prospects/embed.js (the embedding_web vector) and the X-discovery
// workflow.

const PAGE_PATHS = ['', '/about', '/pricing'];   // '' = root
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_BYTES_PER_PAGE  = 200_000;             // hard cap on raw bytes downloaded
const MAX_TEXT_PER_PAGE   = 6_000;               // cap on cleaned text per page
const MAX_TOTAL_TEXT      = 16_000;              // final cap on combined output

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) xpose-prospector/0.1';

// Domains where the "website" is a social profile, link-aggregator, freelancer
// listing, paste, or shortened URL. Fetching them gives zero ICP signal — bio
// repetition at best, login walls at worst. Blocklist short-circuits with
// reason='blocklist' so the workflow log shows what we skipped and why.
const WEB_BLOCKLIST = [
  'facebook.com', 'fb.me', 'fb.com', 'm.facebook.com',
  'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 't.co',
  'linkedin.com', 'lnkd.in',
  'fiverr.com', 'upwork.com',
  'linktr.ee', 'beacons.ai', 'bio.link', 'campsite.bio', 'lnk.bio',
  'bit.ly', 'tinyurl.com', 'rebrand.ly', 'cutt.ly',
  'pinterest.com', 'reddit.com',
];

// Cheap parking / for-sale page heuristic. Most parked pages are <2KB stripped
// and contain phrases like "Domain is for sale" or "Buy this domain".
const PARKING_HINTS = /\b(domain (is )?for sale|buy this domain|parked (free|domain)|this page is parked|godaddy auctions|sedo|hugedomains)\b/i;

/**
 * Fetch a single URL with timeout + byte cap. Returns { text, error }. `text`
 * is null whenever `error` is set; both null means a successful empty body.
 * Surfacing the reason lets the workflow log explain why a page returned no
 * ICP signal (404, timeout, non-html, parked).
 */
async function fetchOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.7',
      },
    });
    if (!res.ok) return { text: null, error: `http_${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html') && !ct.includes('text')) return { text: null, error: `non_html_${ct.split(';')[0] || 'unknown'}` };

    const reader = res.body?.getReader?.();
    let raw;
    if (!reader) {
      raw = (await res.text()).slice(0, MAX_BYTES_PER_PAGE);
    } else {
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES_PER_PAGE) { try { reader.cancel(); } catch (_) {} break; }
        chunks.push(value);
      }
      raw = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
    }
    if (PARKING_HINTS.test(raw)) return { text: null, error: 'parked' };
    const cleaned = stripHtml(raw);
    if (!cleaned || cleaned.length < 40) return { text: null, error: 'empty_body' };
    return { text: cleaned, error: null };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.code || err?.message || 'fetch_error');
    return { text: null, error: String(reason).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

// Cheap HTML stripper. Removes script/style/svg/noscript blocks, comments, tags,
// collapses whitespace. Not a full DOM parser; good enough for embedding fodder.
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Drop nav / footer wrappers — usually copyright + menu repeats, low signal.
  s = s.replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_TEXT_PER_PAGE);
}

function normalizeBase(url) {
  if (!url) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    // Strip trailing slash for clean joining.
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

function hostIsBlocked(rawUrl) {
  try {
    const u = new URL(/^https?:/i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return WEB_BLOCKLIST.some(b => host === b || host.endsWith('.' + b));
  } catch (_) {
    return false;
  }
}

/**
 * Fetch home + /about + /pricing for a website. Returns
 * `{ url, text, pages, error, fetchedAt }`. `text` is the concatenated blurb
 * (cap MAX_TOTAL_TEXT). `pages[]` carries per-path `{ ok, length, error }` so
 * the caller can surface per-URL failure reasons.
 *
 * Top-level `error` is set when the whole blurb is empty — either the URL was
 * blocklisted (social profile / link aggregator / shortener), unparseable, or
 * every page returned no usable text.
 */
async function fetchWebsiteBlurb(rawUrl) {
  if (hostIsBlocked(rawUrl)) {
    return { url: rawUrl, text: '', pages: [], error: 'blocklist', fetchedAt: new Date().toISOString() };
  }
  const base = normalizeBase(rawUrl);
  if (!base) {
    return { url: rawUrl, text: '', pages: [], error: 'bad_url', fetchedAt: new Date().toISOString() };
  }

  const results = await Promise.all(PAGE_PATHS.map(async (p) => {
    const u = base + (p || '/');
    const { text, error } = await fetchOne(u);
    return { path: p || '/', url: u, ok: !!text, length: text ? text.length : 0, text: text || '', error: error || null };
  }));

  const parts = [];
  for (const r of results) {
    if (!r.text) continue;
    parts.push(`# ${r.path}\n${r.text}`);
  }
  const text = parts.join('\n\n').slice(0, MAX_TOTAL_TEXT);
  const allErrors = results.map(r => r.error).filter(Boolean);
  const topError = text ? null : (allErrors[0] || 'no_pages');
  return {
    url: base,
    text,
    pages: results.map(({ text: _, ...rest }) => rest),
    error: topError,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchWebsiteBlurb,
  hostIsBlocked,
  WEB_BLOCKLIST,
  PAGE_PATHS,
  REQUEST_TIMEOUT_MS,
  MAX_TOTAL_TEXT,
};
