// X candidate source: pulls from social_circle + circle_tweets already crawled
// into the DB. No re-crawl. Filters by keyword match before scoring to keep
// LLM cost down. Each candidate is upserted into `prospects` with platform='x'.

const { getPool } = require('../db');

/**
 * Pull candidate X profiles whose bio OR recent tweet text matches any of the
 * criteria keywords. Returns enriched rows ready to feed the scorer.
 *
 * @param {object} criteria - parsed ICP criteria
 * @param {object} opts
 * @param {number} opts.limit - max candidates to return (default 40)
 * @param {number} opts.minFollowers - hard floor on followers
 */
async function fetchCandidates(criteria, { limit = 40, minFollowers = 0 } = {}) {
  const db = getPool();

  const kw = collectKeywords(criteria);
  const minF = Math.max(minFollowers, criteria.min_followers || 0);

  // Build LIKE filter from keywords. If no keywords, fall back to top-followed.
  let kwClause = '';
  const params = [minF, limit];
  if (kw.length) {
    const ors = kw.map((_, i) => `LOWER(sc.bio) LIKE $${i + 3}`).join(' OR ');
    kwClause = `AND (${ors})`;
    params.push(...kw.map(k => `%${k.toLowerCase()}%`));
  }

  const result = await db.query(`
    SELECT
      sc.screen_name,
      sc.display_name,
      sc.bio,
      sc.followers_count,
      sc.following_count,
      sc.relationship,
      (
        SELECT string_agg(LEFT(ct.text, 200), ' | ' ORDER BY ct.created_at DESC)
          FROM (
            SELECT text, created_at FROM circle_tweets
             WHERE screen_name = sc.screen_name
               AND is_retweet = FALSE
             ORDER BY created_at DESC
             LIMIT 5
          ) ct
      ) AS recent_text
    FROM social_circle sc
    WHERE sc.screen_name IS NOT NULL
      AND sc.followers_count >= $1
      ${kwClause}
    ORDER BY sc.followers_count DESC NULLS LAST
    LIMIT $2
  `, params);

  return result.rows.map(r => ({
    platform: 'x',
    handle: r.screen_name,
    profile_url: `https://x.com/${r.screen_name}`,
    display_name: r.display_name,
    headline: null,
    bio: r.bio,
    location: null,
    followers_count: r.followers_count || 0,
    following_count: r.following_count || 0,
    company: null,
    title: null,
    raw_data: { relationship: r.relationship },
    _recent_text: r.recent_text || '',
  }));
}

function collectKeywords(criteria) {
  const out = new Set();
  const push = v => { if (v && typeof v === 'string' && v.length >= 3) out.add(v.trim()); };
  (criteria.roles || []).forEach(push);
  (criteria.industries || []).forEach(push);
  (criteria.topics || []).forEach(push);
  (criteria.keywords || []).forEach(push);
  return [...out].slice(0, 12);
}

module.exports = { fetchCandidates };
