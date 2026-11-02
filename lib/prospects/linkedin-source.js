// LinkedIn candidate source — MVP stub.
//
// Schema is already namespaced and ready: prospects.platform = 'linkedin'.
// A real crawler will live here (CDP-attached LinkedIn search results
// interception, mirroring lib/twitter/crawler.js). For MVP we expose two ways
// to populate prospects without a crawler:
//   1. manual import via UI (paste handles / urls)
//   2. CSV/JSON file ingest
//
// Both flows funnel through `ingestProspects()` which upserts and returns
// rows shaped identically to x-source.fetchCandidates output, so the scorer
// is platform-agnostic.

const { upsertProspect } = require('./db');
const { getPool } = require('../db');

async function fetchCandidates(criteria, { limit = 40 } = {}) {
  // No crawler yet. Pull whatever has been ingested into prospects(platform='linkedin')
  // and prefilter by keyword match on headline/bio/title/company.
  const db = getPool();
  const kw = collectKeywords(criteria);
  let kwClause = '';
  const params = [limit];
  if (kw.length) {
    const ors = kw.map((_, i) => `
      LOWER(COALESCE(headline, '')) LIKE $${i + 2}
      OR LOWER(COALESCE(bio, '')) LIKE $${i + 2}
      OR LOWER(COALESCE(title, '')) LIKE $${i + 2}
      OR LOWER(COALESCE(company, '')) LIKE $${i + 2}
    `).join(' OR ');
    kwClause = `AND (${ors})`;
    params.push(...kw.map(k => `%${k.toLowerCase()}%`));
  }

  const result = await db.query(`
    SELECT id, platform, handle, profile_url, display_name, headline, bio,
           location, followers_count, following_count, company, title, raw_data
      FROM prospects
     WHERE platform = 'linkedin'
       ${kwClause}
     ORDER BY followers_count DESC NULLS LAST, first_seen_at DESC
     LIMIT $1
  `, params);

  return result.rows.map(r => ({ ...r, _recent_text: '' }));
}

/**
 * Ingest a batch of LinkedIn profiles into `prospects`. Used by manual import.
 * Each row: { handle, profile_url, display_name, headline, bio, location,
 *             company, title, followers_count }
 */
async function ingestProspects(rows = []) {
  const ids = [];
  for (const r of rows) {
    if (!r.handle && !r.profile_url) continue;
    const handle = r.handle || handleFromUrl(r.profile_url);
    if (!handle) continue;
    const id = await upsertProspect({
      platform: 'linkedin',
      handle,
      profile_url: r.profile_url || `https://linkedin.com/in/${handle}`,
      display_name: r.display_name,
      headline: r.headline,
      bio: r.bio,
      location: r.location,
      followers_count: r.followers_count || 0,
      following_count: r.following_count || 0,
      company: r.company,
      title: r.title,
      raw_data: r.raw_data || null,
    });
    ids.push(id);
  }
  return ids;
}

function handleFromUrl(url) {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : null;
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

module.exports = { fetchCandidates, ingestProspects };
