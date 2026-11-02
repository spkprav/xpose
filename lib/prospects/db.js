const { getPool } = require('../db');

async function upsertProspect(p) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO prospects (
      platform, handle, profile_url, display_name, headline, bio, location,
      followers_count, following_count, company, title, raw_data,
      website_url, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CURRENT_TIMESTAMP)
    ON CONFLICT (platform, handle) DO UPDATE SET
      profile_url     = COALESCE(EXCLUDED.profile_url, prospects.profile_url),
      display_name    = COALESCE(EXCLUDED.display_name, prospects.display_name),
      headline        = COALESCE(EXCLUDED.headline, prospects.headline),
      bio             = COALESCE(EXCLUDED.bio, prospects.bio),
      location        = COALESCE(EXCLUDED.location, prospects.location),
      followers_count = GREATEST(EXCLUDED.followers_count, prospects.followers_count),
      following_count = GREATEST(EXCLUDED.following_count, prospects.following_count),
      company         = COALESCE(EXCLUDED.company, prospects.company),
      title           = COALESCE(EXCLUDED.title, prospects.title),
      raw_data        = COALESCE(EXCLUDED.raw_data, prospects.raw_data),
      website_url     = COALESCE(EXCLUDED.website_url, prospects.website_url),
      updated_at      = CURRENT_TIMESTAMP
    RETURNING id
  `, [
    p.platform, p.handle, p.profile_url || null, p.display_name || null,
    p.headline || null, p.bio || null, p.location || null,
    p.followers_count || 0, p.following_count || 0,
    p.company || null, p.title || null,
    p.raw_data ? JSON.stringify(p.raw_data) : null,
    p.website_url || null,
  ]);
  return result.rows[0].id;
}

/**
 * Bulk-upsert a batch of X prospects extracted from a SearchTimeline response.
 * Each row: { handle, display_name, bio, location, followers_count, following_count,
 *             website_url, raw_data? }
 * Returns { upserted, skipped }.
 */
async function upsertXProspectsBatch(rows = []) {
  let upserted = 0, skipped = 0;
  for (const r of rows) {
    const handle = r && (r.handle || r.screen_name);
    if (!handle) { skipped++; continue; }
    try {
      await upsertProspect({
        platform: 'x',
        handle,
        profile_url: r.profile_url || `https://x.com/${handle}`,
        display_name: r.display_name,
        bio: r.bio,
        location: r.location,
        followers_count: r.followers_count || 0,
        following_count: r.following_count || 0,
        website_url: r.website_url,
        raw_data: r.raw_data || null,
      });
      upserted++;
    } catch (err) {
      console.error(`[upsertXProspectsBatch] failed for @${handle}: ${err.message}`);
      skipped++;
    }
  }
  return { upserted, skipped };
}

/**
 * Persist a website blurb (already fetched + stripped) onto a prospect.
 * No-op if `text` is empty.
 */
async function saveWebsiteBlurb(prospectId, { url, text }) {
  if (!prospectId || !text || !text.trim()) return;
  const db = getPool();
  await db.query(`
    UPDATE prospects
       SET website_url        = COALESCE($2, website_url),
           website_text       = $3,
           website_fetched_at = CURRENT_TIMESTAMP
     WHERE id = $1
  `, [prospectId, url || null, text.slice(0, 16000)]);
}

/**
 * Fetch the N most-recent non-retweet `circle_tweets` rows for a handle.
 * Used by the X embedder. Pulls from circle_tweets because user-tweets crawl
 * already lands there (keyed by screen_name, not by relationship).
 */
async function getRecentTweetsForHandle(handle, n = 20) {
  if (!handle) return [];
  const db = getPool();
  const { rows } = await db.query(`
    SELECT id, text, created_at, is_retweet
      FROM circle_tweets
     WHERE screen_name = $1
       AND is_retweet = FALSE
       AND text IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2
  `, [handle, n]);
  return rows;
}

/**
 * X "today's top N" leaderboard: take the most-recent X scoring run,
 * join its results to prospects, drop anyone with a sent outreach draft,
 * return top N by fit_score.
 */
async function listTopXProspectsUncontacted({ limit = 10, minScore = 0, minFollowers = 100 } = {}) {
  const db = getPool();
  const latest = await db.query(`
    SELECT id FROM prospect_searches
     WHERE platform='x' AND status='done'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1
  `);
  if (!latest.rows.length) return { searchId: null, rows: [] };
  const searchId = latest.rows[0].id;

  const { rows } = await db.query(`
    SELECT r.id AS result_id, r.fit_score, r.reason, r.score_breakdown,
           p.id AS prospect_id, p.handle, p.display_name, p.bio, p.location,
           p.website_url, p.followers_count, p.following_count, p.picture_url
      FROM prospect_search_results r
      JOIN prospects p ON p.id = r.prospect_id
      LEFT JOIN outreach_drafts od
        ON od.prospect_id = p.id AND od.platform='x' AND od.status='sent'
     WHERE r.search_id = $1
       AND r.fit_score >= $2
       AND p.followers_count >= $4
       AND od.id IS NULL
     ORDER BY r.fit_score DESC, p.followers_count DESC NULLS LAST
     LIMIT $3
  `, [searchId, minScore, limit, minFollowers]);
  return { searchId, rows };
}

async function createSearch({ platform, prompt, criteria }) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO prospect_searches (platform, prompt, criteria, status)
    VALUES ($1, $2, $3::jsonb, 'running')
    RETURNING id
  `, [platform, prompt, criteria ? JSON.stringify(criteria) : null]);
  return result.rows[0].id;
}

async function completeSearch(id, resultCount) {
  const db = getPool();
  await db.query(`
    UPDATE prospect_searches
       SET status = 'done', result_count = $2, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
  `, [id, resultCount]);
}

async function failSearch(id, errorMessage) {
  const db = getPool();
  await db.query(`
    UPDATE prospect_searches
       SET status = 'failed', error_message = $2, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
  `, [id, errorMessage]);
}

async function saveSearchResult({ searchId, prospectId, fitScore, scoreBreakdown, reason, signals }) {
  const db = getPool();
  await db.query(`
    INSERT INTO prospect_search_results (search_id, prospect_id, fit_score, score_breakdown, reason, signals)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
    ON CONFLICT (search_id, prospect_id) DO UPDATE SET
      fit_score       = EXCLUDED.fit_score,
      score_breakdown = EXCLUDED.score_breakdown,
      reason          = EXCLUDED.reason,
      signals         = EXCLUDED.signals,
      scored_at       = CURRENT_TIMESTAMP
  `, [
    searchId, prospectId, fitScore,
    scoreBreakdown ? JSON.stringify(scoreBreakdown) : null,
    reason || null,
    signals ? JSON.stringify(signals) : null,
  ]);
}

async function listSearches(platform, limit = 20) {
  const db = getPool();
  const result = await db.query(`
    SELECT id, platform, prompt, criteria, result_count, status, error_message,
           created_at, completed_at
      FROM prospect_searches
     WHERE platform = $1
     ORDER BY created_at DESC
     LIMIT $2
  `, [platform, limit]);
  return result.rows;
}

async function getSearchResults(searchId, { minScore = 0, limit = 200 } = {}) {
  const db = getPool();
  const result = await db.query(`
    SELECT r.id, r.fit_score, r.score_breakdown, r.reason, r.signals, r.scored_at,
           p.id AS prospect_id, p.platform, p.handle, p.profile_url, p.display_name,
           p.headline, p.bio, p.location, p.followers_count, p.following_count,
           p.company, p.title
      FROM prospect_search_results r
      JOIN prospects p ON p.id = r.prospect_id
     WHERE r.search_id = $1 AND r.fit_score >= $2
     ORDER BY r.fit_score DESC, p.followers_count DESC
     LIMIT $3
  `, [searchId, minScore, limit]);
  return result.rows;
}

async function listAllProspects(platform, { limit = 200, offset = 0 } = {}) {
  const db = getPool();
  const result = await db.query(`
    SELECT p.id AS prospect_id, p.platform, p.handle, p.profile_url, p.display_name,
           p.headline, p.bio, p.location, p.followers_count, p.following_count,
           p.company, p.title,
           latest.fit_score, latest.reason, latest.signals, latest.score_breakdown,
           COALESCE(latest.scored_at, p.updated_at) AS scored_at
      FROM prospects p
      LEFT JOIN LATERAL (
        SELECT fit_score, reason, signals, score_breakdown, scored_at
          FROM prospect_search_results
         WHERE prospect_id = p.id
         ORDER BY scored_at DESC
         LIMIT 1
      ) latest ON true
     WHERE p.platform = $1
     ORDER BY latest.fit_score DESC NULLS LAST, p.updated_at DESC
     LIMIT $2 OFFSET $3
  `, [platform, limit, offset]);
  return result.rows;
}

async function getSearch(id) {
  const db = getPool();
  const result = await db.query('SELECT * FROM prospect_searches WHERE id = $1', [id]);
  return result.rows[0];
}

async function saveOutreachDraft({ prospectId, searchId, platform, channel, body, model }) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO outreach_drafts (prospect_id, search_id, platform, channel, body, model)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [prospectId, searchId || null, platform, channel, body, model || null]);
  return result.rows[0].id;
}

async function listOutreachDrafts({ platform, status = null, limit = 50 } = {}) {
  const db = getPool();
  const params = [platform, limit];
  let statusClause = '';
  if (status) { params.splice(1, 0, status); statusClause = 'AND od.status = $2'; }
  const result = await db.query(`
    SELECT od.*, p.handle, p.display_name, p.profile_url
      FROM outreach_drafts od
      JOIN prospects p ON p.id = od.prospect_id
     WHERE od.platform = $1 ${statusClause}
     ORDER BY od.created_at DESC
     LIMIT $${params.length}
  `, params);
  return result.rows;
}

async function updateOutreachDraft(id, { body, status }) {
  const db = getPool();
  const fields = [];
  const vals = [id];
  let i = 2;
  if (body != null)   { fields.push(`body = $${i++}`);   vals.push(body); }
  if (status != null) { fields.push(`status = $${i++}`); vals.push(status); }
  if (status === 'sent') { fields.push(`sent_at = CURRENT_TIMESTAMP`); }
  if (!fields.length) return;
  await db.query(`UPDATE outreach_drafts SET ${fields.join(', ')} WHERE id = $1`, vals);
}

module.exports = {
  upsertProspect,
  upsertXProspectsBatch,
  saveWebsiteBlurb,
  getRecentTweetsForHandle,
  listTopXProspectsUncontacted,
  createSearch,
  completeSearch,
  failSearch,
  saveSearchResult,
  listSearches,
  getSearchResults,
  listAllProspects,
  getSearch,
  saveOutreachDraft,
  listOutreachDrafts,
  updateOutreachDraft,
};
