// Embedding-based prospect scoring.
//
// Strategy:
//   1. For each prospect, compose a compact text from title/company/headline/
//      summary/top positions/top educations/top skills.
//   2. Embed via OpenRouter (default: openai/text-embedding-3-small, 1536 dim).
//   3. Store as pgvector `vector(1536)` on prospects.embedding.
//   4. To score against an ICP: embed ICP text once, query pgvector with
//      cosine distance, map distance → fit_score 0-100.
//
// All deps explicit — works inside Electron + standalone scripts.

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/text-embedding-3-small';   // 1536-dim, $0.02/M tokens
const DEFAULT_DIM = 1536;

/**
 * Compose a single text blob per prospect. Order matters for embedding focus:
 * role + company first, then long-form, then experience, then skills.
 */
function buildProspectText(p) {
  if (!p) return '';
  const parts = [];
  if (p.title || p.company) {
    parts.push(`${p.title || ''}${p.title && p.company ? ' at ' : ''}${p.company || ''}`.trim());
  }
  if (p.headline) parts.push(`Headline: ${p.headline}`);
  if (p.summary) parts.push(`About: ${String(p.summary).slice(0, 600)}`);
  if (p.location) parts.push(`Location: ${p.location}`);

  const positions = Array.isArray(p.positions) ? p.positions.slice(0, 3) : [];
  if (positions.length) {
    parts.push('Experience: ' + positions.map(pos => {
      const t = pos?.position || pos?.title || '';
      const c = pos?.companyName || pos?.company?.name || '';
      const d = (pos?.description || '').replace(/\s+/g, ' ').slice(0, 120);
      return [t, c && `at ${c}`, d && `— ${d}`].filter(Boolean).join(' ');
    }).join(' | '));
  }

  const educations = Array.isArray(p.educations) ? p.educations.slice(0, 2) : [];
  if (educations.length) {
    parts.push('Education: ' + educations.map(e => {
      const deg = e?.degree || e?.degreeName || '';
      const fos = e?.fieldOfStudy || '';
      const s = e?.schoolName || '';
      return [deg, fos, s && `(${s})`].filter(Boolean).join(' ');
    }).join(' | '));
  }

  const skills = Array.isArray(p.skills) ? p.skills.slice(0, 12).map(s => s?.name).filter(Boolean) : [];
  if (skills.length) parts.push('Skills: ' + skills.join(', '));

  return parts.join('\n').slice(0, 4000);   // safety cap
}

/**
 * Call OpenRouter embeddings endpoint. Returns { vector, model, tokens }.
 */
async function getEmbedding({ apiKey, text, model = DEFAULT_MODEL }) {
  if (!apiKey) throw new Error('OpenRouter apiKey required for embeddings');
  if (!text || !text.trim()) throw new Error('Empty embedding input');

  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 400)}`);
  let body;
  try { body = JSON.parse(txt); } catch (_) { throw new Error(`Embedding response not JSON: ${txt.slice(0, 200)}`); }
  const vec = body?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) throw new Error(`No embedding in response: ${txt.slice(0, 200)}`);
  return { vector: vec, model, tokens: body?.usage?.total_tokens || 0 };
}

// pg-friendly vector literal: '[0.1,0.2,...]'.
function vectorLiteral(vec) {
  return '[' + vec.map(v => Number(v).toFixed(7)).join(',') + ']';
}

/**
 * Embed every LinkedIn prospect that has enrichment but no embedding yet.
 * Idempotent: re-running skips already-embedded rows.
 */
async function embedAllProspects({ getPool, apiKey, model = DEFAULT_MODEL, onProgress = () => {}, limit = 5000, force = false }) {
  const db = getPool();
  const where = force
    ? `WHERE platform='linkedin' AND (title IS NOT NULL OR headline IS NOT NULL)`
    : `WHERE platform='linkedin' AND embedding IS NULL AND (title IS NOT NULL OR headline IS NOT NULL OR summary IS NOT NULL)`;
  const { rows } = await db.query(`
    SELECT id, handle, display_name, title, company, headline, bio, summary,
           location, positions, educations, skills
    FROM prospects ${where}
    ORDER BY (title IS NULL), id ASC
    LIMIT $1
  `, [limit]);

  onProgress('start', { total: rows.length, model });
  let done = 0, failed = 0;

  for (const p of rows) {
    const text = buildProspectText(p);
    if (!text || text.length < 10) {
      failed++;
      onProgress('skip', { handle: p.handle, reason: 'empty text', failedSoFar: failed, total: rows.length });
      continue;
    }
    try {
      const { vector } = await getEmbedding({ apiKey, text, model });
      await db.query(
        `UPDATE prospects SET embedding = $1::vector, embedded_at = CURRENT_TIMESTAMP, embedding_model = $2 WHERE id = $3`,
        [vectorLiteral(vector), model, p.id]
      );
      done++;
      onProgress('embedded', { handle: p.handle, title: p.title, doneSoFar: done, failedSoFar: failed, total: rows.length });
    } catch (err) {
      failed++;
      onProgress('error', { handle: p.handle, error: err.message, failedSoFar: failed, total: rows.length });
    }
  }
  onProgress('done', { embedded: done, failed, total: rows.length });
  return { embedded: done, failed, total: rows.length };
}

// Default title-regex exclude list. Embeddings ignore "EXCLUDE: X" semantics
// so we filter deterministically. Caller can override.
const DEFAULT_EXCLUDE_TITLE_RE = new RegExp([
  '\\b(software|fullstack|full[ -]stack|frontend|backend|web|mobile|ios|android|game)\\s*(engineer|engineering|developer|dev)\\b',
  '\\bSDE\\b', '\\bSDET\\b', '\\bSWE\\b', '\\bSRE\\b', '\\bQA\\b',
  '\\b(ML|AI|NLP|LLM|GenAI|gen-AI)\\s+(engineer|engineering|researcher|scientist|developer)\\b',
  '\\bhead of (ai|ml|nlp|llm|engineering|data|product)\\b',
  '\\b(forward[ -]deployed)\\s+(ai|ml|engineer)\\b',
  '\\bdata\\s+(engineer|scientist|analyst)\\b',
  '\\bdevops\\b', '\\bcloud\\s+(engineer|architect)\\b', '\\bsystem(s)?\\s+engineer\\b',
  '\\b(senior|junior|associate|lead|principal|staff)?\\s*(software|frontend|backend|full[ -]stack|ios|android|mobile)\\s*(engineer|developer)\\b',
  '\\b(blockchain|solidity|web3)\\s*(developer|engineer)\\b',
  '\\b(tech|technical|technology)\\s+recruit',
  '\\b(talent acquisition|talent partner|talent sourcer|sourcer|recruiter|recruiting)\\b',
  '\\bquality\\s+(analyst|engineer|assurance)\\b',
  '\\b(product\\s+(manager|designer)|senior\\s+product|director\\s+of\\s+product)\\b',
  '\\b(SDR|BDR|sales development|business development representative)\\b',
  '\\bcustomer success\\s+(manager|engineer|specialist)\\b',
  '\\b(student|intern|fresher|fresh grad)\\b',
  '\\b(VC|venture capital|investor|angel|partner at .* ventures|principal at .* ventures)\\b',
  '\\b(blockchain|crypto|web3|defi|NFT)\\b',
].join('|'), 'i');

/**
 * Embed ICP text once, return top-N prospects sorted by cosine similarity.
 * Persists results to prospect_searches + prospect_search_results so the
 * existing Prospects tab UI surfaces them.
 *
 * Score mapping: cosine distance [0..2] → fit_score 100..0 via (1 - dist/2)*100.
 * For OpenAI embeddings cosine distance rarely exceeds ~1.0, so realistic
 * scores cluster 30-80.
 *
 * `excludeTitleRegex`: if a prospect's title matches, they are dropped from
 * results entirely (embeddings can't honor "EXCLUDE: X" text). Pass null to
 * skip filtering. Defaults to a sensible engineer/dev/recruiter exclude list.
 */
async function scoreByEmbedding({ getPool, apiKey, icpText, model = DEFAULT_MODEL, limit = 200, persistSearchId = null, prompt = null, criteria = null, excludeTitleRegex = DEFAULT_EXCLUDE_TITLE_RE }) {
  if (!icpText || !icpText.trim()) throw new Error('icpText required');
  const db = getPool();

  const { vector: icpVec } = await getEmbedding({ apiKey, text: icpText, model });
  const lit = vectorLiteral(icpVec);

  // Over-fetch to compensate for post-filter drops.
  const fetchLimit = excludeTitleRegex ? limit * 2 : limit;
  const { rows } = await db.query(`
    SELECT id AS prospect_id, handle, display_name, title, company, headline,
           bio, summary, location, followers_count, following_count, picture_url,
           1 - (embedding <=> $1::vector) AS cosine_sim,
           (embedding <=> $1::vector)     AS cosine_dist
    FROM prospects
    WHERE platform='linkedin' AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [lit, fetchLimit]);

  // Deterministic post-filter for excludes (embeddings ignore "EXCLUDE: X" semantics).
  const filtered = excludeTitleRegex
    ? rows.filter(r => !(r.title && excludeTitleRegex.test(r.title)) && !(r.headline && excludeTitleRegex.test(r.headline)))
    : rows;

  // Cosine sim → fit_score 0..100. Stretch [0.2, 0.6] → [40, 95] so realistic
  // scores spread across the 0-100 band instead of clustering at 50-75.
  const scored = filtered.slice(0, limit).map(r => {
    const sim = Number(r.cosine_sim) || 0;
    const stretched = (sim - 0.20) / (0.60 - 0.20);    // 0.20→0, 0.60→1.0
    const fit = Math.max(0, Math.min(100, Math.round(40 + stretched * 55)));
    return { ...r, fit_score: fit, reason: `embedding cosine=${sim.toFixed(3)}` };
  });

  let searchId = persistSearchId;
  if (!searchId) {
    const ins = await db.query(`
      INSERT INTO prospect_searches (platform, prompt, criteria, status, result_count)
      VALUES ('linkedin', $1, $2::jsonb, 'done', $3) RETURNING id
    `, [prompt || icpText.slice(0, 500), JSON.stringify(criteria || { method: 'embedding', model }), scored.length]);
    searchId = ins.rows[0].id;
  }

  for (const r of scored) {
    await db.query(`
      INSERT INTO prospect_search_results (search_id, prospect_id, fit_score, reason, score_breakdown)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (search_id, prospect_id) DO UPDATE SET
        fit_score = EXCLUDED.fit_score,
        reason = EXCLUDED.reason,
        score_breakdown = EXCLUDED.score_breakdown,
        scored_at = CURRENT_TIMESTAMP
    `, [searchId, r.prospect_id, r.fit_score, r.reason, JSON.stringify({ cosine_sim: Number(r.cosine_sim), cosine_dist: Number(r.cosine_dist) })]);
  }

  return { searchId, rows: scored };
}

// ─── X (Twitter) flow ─────────────────────────────────────────────────────────
// LinkedIn flow above uses a single `embedding` vector composed from one text
// blob. X prospects carry three orthogonal signal sources (bio, recent tweets,
// website blurb) — embedding each separately and combining cosine scores at
// query time gives much sharper ICP discrimination than concatenation, because
// long tweet text doesn't drown short bio text in the single-vector mean.

const X_WEIGHTS = { bio: 0.4, tweets: 0.4, web: 0.2 };

/**
 * Build the three text inputs for an X prospect's per-source embeddings.
 * Caller passes:
 *   - p       : prospect row (handle, display_name, bio, location, ...)
 *   - tweets  : array of {text, created_at} for the prospect's most recent tweets
 *   - webText : already-fetched + cleaned website blurb (see web-fetch.js)
 *
 * Returns { bio, tweets, web } — each is null or a non-empty string. The caller
 * embeds each non-null entry separately.
 */
function buildXProspectTexts(p, tweets = [], webText = '') {
  const bioParts = [];
  if (p.display_name) bioParts.push(`Name: ${p.display_name}`);
  if (p.handle)       bioParts.push(`Handle: @${p.handle}`);
  if (p.bio)          bioParts.push(`Bio: ${String(p.bio).slice(0, 500)}`);
  if (p.location)     bioParts.push(`Location: ${p.location}`);
  if (p.website_url)  bioParts.push(`Website: ${p.website_url}`);
  const bio = bioParts.length ? bioParts.join('\n') : null;

  // Most recent up to 20 tweets, joined with separators. Skip retweets if flagged.
  const tweetTexts = (tweets || [])
    .filter(t => t && t.text && !(t.is_retweet))
    .slice(0, 20)
    .map(t => String(t.text).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const tweetsBlob = tweetTexts.length
    ? `Recent tweets by @${p.handle}:\n` + tweetTexts.map(t => `- ${t}`).join('\n').slice(0, 6000)
    : null;

  const web = webText && webText.trim().length > 40 ? webText.slice(0, 8000) : null;

  return { bio, tweets: tweetsBlob, web };
}

/**
 * Compute and persist the three per-source embeddings for one X prospect.
 * `tweetsLookupFn` and `webLookupFn` let the caller decide whether to refetch
 * (e.g. skip web if website_text already cached). Returns {bio, tweets, web}
 * booleans indicating which vectors were written.
 */
async function embedXProspect({ getPool, apiKey, prospect, tweets = [], webText = '', model = DEFAULT_MODEL }) {
  const db = getPool();
  const texts = buildXProspectTexts(prospect, tweets, webText);
  const written = { bio: false, tweets: false, web: false };

  const sets = [];
  const params = [prospect.id];
  let pi = 2;

  for (const kind of ['bio', 'tweets', 'web']) {
    const txt = texts[kind];
    if (!txt) continue;
    try {
      const { vector } = await getEmbedding({ apiKey, text: txt, model });
      sets.push(`embedding_${kind} = $${pi++}::vector`);
      params.push(vectorLiteral(vector));
      sets.push(`embedded_${kind}_at = CURRENT_TIMESTAMP`);
      written[kind] = true;
    } catch (err) {
      console.error(`[embedXProspect] ${kind} failed for @${prospect.handle}: ${err.message}`);
    }
  }
  if (!sets.length) return written;
  sets.push(`embedding_model = $${pi++}`);
  params.push(model);
  await db.query(`UPDATE prospects SET ${sets.join(', ')} WHERE id = $1`, params);
  return written;
}

/**
 * Bulk-embed every X prospect that has at least one missing vector. `enrichFn`
 * is called per prospect to fetch (tweets, webText) before embedding. Caller
 * provides it because the X flow needs Electron-side helpers (DB tweets query,
 * web-fetch). Returns {embedded, failed, total}.
 */
async function embedAllXProspects({
  getPool,
  apiKey,
  enrichFn,                              // async (prospect) -> { tweets, webText }
  onProgress = () => {},
  model = DEFAULT_MODEL,
  limit = 1000,
  force = false,
  minFollowers = 100,                    // skip squatter / dead accounts (tuned for X people-search noise)
}) {
  const db = getPool();
  const where = force
    ? `WHERE platform='x' AND followers_count >= $2 AND (bio IS NOT NULL OR display_name IS NOT NULL)`
    : `WHERE platform='x' AND followers_count >= $2
         AND (bio IS NOT NULL OR display_name IS NOT NULL)
         AND (embedding_bio IS NULL OR embedding_tweets IS NULL OR embedding_web IS NULL)`;
  const { rows } = await db.query(`
    SELECT id, handle, display_name, bio, location, website_url, website_text,
           followers_count, following_count
    FROM prospects ${where}
    ORDER BY followers_count DESC NULLS LAST, id ASC
    LIMIT $1
  `, [limit, minFollowers]);

  onProgress('start', { total: rows.length, model });
  let done = 0, failed = 0;

  for (const p of rows) {
    try {
      const enriched = enrichFn ? await enrichFn(p) : { tweets: [], webText: p.website_text || '' };
      const written = await embedXProspect({
        getPool, apiKey, prospect: p,
        tweets: enriched.tweets || [],
        webText: enriched.webText || p.website_text || '',
        model,
      });
      const any = written.bio || written.tweets || written.web;
      if (any) {
        done++;
        onProgress('embedded', { handle: p.handle, written, doneSoFar: done, failedSoFar: failed, total: rows.length });
      } else {
        failed++;
        onProgress('skip', { handle: p.handle, reason: 'no text', doneSoFar: done, failedSoFar: failed, total: rows.length });
      }
    } catch (err) {
      failed++;
      onProgress('error', { handle: p.handle, error: err.message, doneSoFar: done, failedSoFar: failed, total: rows.length });
    }
  }
  onProgress('done', { embedded: done, failed, total: rows.length });
  return { embedded: done, failed, total: rows.length };
}

/**
 * Score every embedded X prospect against an ICP text. Picks the weighted-mean
 * cosine across (bio, tweets, web), redistributing weight when a source vector
 * is NULL so a prospect with only bio still gets a fair shot.
 *
 * Persists into prospect_searches + prospect_search_results so the existing
 * Prospects UI surfaces results.
 *
 * `excludeContacted=true` filters out prospects with an outreach_drafts row
 * where status='sent'.
 */
async function scoreXByEmbedding({
  getPool,
  apiKey,
  icpText,
  model = DEFAULT_MODEL,
  limit = 200,
  prompt = null,
  criteria = null,
  weights = X_WEIGHTS,
  excludeContacted = false,
  minFollowers = 100,                     // skip squatter / dead accounts (tuned for X people-search noise)
}) {
  if (!icpText || !icpText.trim()) throw new Error('icpText required');
  const db = getPool();

  const { vector: icpVec } = await getEmbedding({ apiKey, text: icpText, model });
  const lit = vectorLiteral(icpVec);

  // Per-row weighted similarity = SUM(w_i * sim_i) / SUM(w_i where v_i NOT NULL).
  // sim_i = 1 - cosine_distance. Coalesce NULL distances to NULL so the divisor
  // ignores missing vectors.
  const exclusionJoin = excludeContacted
    ? `LEFT JOIN outreach_drafts od ON od.prospect_id = p.id AND od.platform='x' AND od.status='sent'`
    : ``;
  const exclusionWhere = excludeContacted ? `AND od.id IS NULL` : ``;

  const { rows } = await db.query(`
    WITH sims AS (
      SELECT p.id, p.handle, p.display_name, p.bio, p.location, p.website_url,
             p.followers_count, p.following_count, p.picture_url,
             CASE WHEN p.embedding_bio    IS NOT NULL THEN 1 - (p.embedding_bio    <=> $1::vector) END AS sim_bio,
             CASE WHEN p.embedding_tweets IS NOT NULL THEN 1 - (p.embedding_tweets <=> $1::vector) END AS sim_tweets,
             CASE WHEN p.embedding_web    IS NOT NULL THEN 1 - (p.embedding_web    <=> $1::vector) END AS sim_web
        FROM prospects p
        ${exclusionJoin}
       WHERE p.platform='x'
         AND p.followers_count >= $6
         AND (p.embedding_bio IS NOT NULL OR p.embedding_tweets IS NOT NULL OR p.embedding_web IS NOT NULL)
         ${exclusionWhere}
    )
    SELECT *,
      (
        COALESCE(sim_bio    * $2, 0) +
        COALESCE(sim_tweets * $3, 0) +
        COALESCE(sim_web    * $4, 0)
      ) /
      NULLIF(
        (CASE WHEN sim_bio    IS NOT NULL THEN $2 ELSE 0 END) +
        (CASE WHEN sim_tweets IS NOT NULL THEN $3 ELSE 0 END) +
        (CASE WHEN sim_web    IS NOT NULL THEN $4 ELSE 0 END),
        0
      ) AS combined_sim
    FROM sims
    ORDER BY combined_sim DESC NULLS LAST
    LIMIT $5
  `, [lit, weights.bio, weights.tweets, weights.web, limit, minFollowers]);

  const scored = rows.map(r => {
    const sim = Number(r.combined_sim) || 0;
    const stretched = (sim - 0.18) / (0.55 - 0.18);    // empirically tighter band for X
    const fit = Math.max(0, Math.min(100, Math.round(35 + stretched * 60)));
    return {
      ...r,
      prospect_id: r.id,
      fit_score: fit,
      reason: `bio=${fmtSim(r.sim_bio)} tweets=${fmtSim(r.sim_tweets)} web=${fmtSim(r.sim_web)} → combined=${sim.toFixed(3)}`,
    };
  });

  const ins = await db.query(`
    INSERT INTO prospect_searches (platform, prompt, criteria, status, result_count)
    VALUES ('x', $1, $2::jsonb, 'done', $3) RETURNING id
  `, [prompt || icpText.slice(0, 500), JSON.stringify(criteria || { method: 'embedding-3way', model, weights, excludeContacted }), scored.length]);
  const searchId = ins.rows[0].id;

  for (const r of scored) {
    await db.query(`
      INSERT INTO prospect_search_results (search_id, prospect_id, fit_score, reason, score_breakdown)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (search_id, prospect_id) DO UPDATE SET
        fit_score = EXCLUDED.fit_score,
        reason = EXCLUDED.reason,
        score_breakdown = EXCLUDED.score_breakdown,
        scored_at = CURRENT_TIMESTAMP
    `, [
      searchId, r.prospect_id, r.fit_score, r.reason,
      JSON.stringify({ sim_bio: numOrNull(r.sim_bio), sim_tweets: numOrNull(r.sim_tweets), sim_web: numOrNull(r.sim_web), combined: numOrNull(r.combined_sim) }),
    ]);
  }
  return { searchId, rows: scored };
}

function fmtSim(v) { return v == null ? '—' : Number(v).toFixed(2); }
function numOrNull(v) { return v == null ? null : Number(v); }

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_DIM,
  buildProspectText,
  getEmbedding,
  vectorLiteral,
  embedAllProspects,
  scoreByEmbedding,
  // X flow
  X_WEIGHTS,
  buildXProspectTexts,
  embedXProspect,
  embedAllXProspects,
  scoreXByEmbedding,
};
