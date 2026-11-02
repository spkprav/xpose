// Enrich LinkedIn prospects via Apify `supreme_coder/linkedin-profile-scraper`.
//
// One actor run = up to 1500 profile URLs. We batch in chunks, fire run-sync
// against each chunk, write the parsed rows back to `prospects`.
//
// Output schema (relevant subset from the actor):
//   publicIdentifier, firstName, lastName, headline, summary, jobTitle,
//   companyName, companyLinkedinUrl, geoLocationName, geoCountryName,
//   countryCode, connectionsCount, followerCount, premium, isVerified,
//   creator, influencer, pictureUrl{100x100,200x200,400x400,800x800},
//   positions[], educations[], skills[], certifications[],
//   mutualConnections[]
//
// All deps are explicit so this module works inside Electron + standalone scripts.

const API_BASE = 'https://api.apify.com/v2';
const MAX_PER_RUN = 1500;            // Apify input cap
const DEFAULT_CHUNK = 50;            // small chunks = faster feedback + retry-friendly

// Per-actor adapter: input builder + item mapper.
// New actors plug in here without touching enrichBatch / enrichProspects.
const ACTORS = {
  'supreme_coder~linkedin-profile-scraper': {
    buildInput: (handles, opts = {}) => ({
      urls: handles.map(h => ({ url: `https://www.linkedin.com/in/${h}/` })),
      scrapeCompany: !!opts.scrapeCompany,
      findContacts: !!opts.findContacts,
    }),
    mapItem: mapSupremeCoderItem,
  },
  'harvestapi~linkedin-profile-scraper': {
    buildInput: (handles, opts = {}) => ({
      profileScraperMode: opts.withEmail
        ? 'Profile details + email search ($10 per 1k)'
        : 'Profile details no email ($4 per 1k)',
      publicIdentifiers: handles,
    }),
    mapItem: mapHarvestApiItem,
  },
};

const DEFAULT_ACTOR = 'harvestapi~linkedin-profile-scraper';

function pickPictureUrl(pic) {
  if (!pic) return null;
  if (typeof pic === 'string') return pic;
  if (typeof pic !== 'object') return null;
  // supreme_coder shape: { "800x800": "...", "400x400": "...", ... }
  return pic['800x800'] || pic['400x400'] || pic['200x200'] || pic['100x100']
    || pic.url
    || (Array.isArray(pic.sizes) ? pic.sizes[0]?.url : null)
    || null;
}

/**
 * supreme_coder actor: shape uses positions, educations, jobTitle, summary,
 * pictureUrl{100x100..800x800}, geoLocationName, countryCode, isVerified.
 */
function mapSupremeCoderItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.error) {
    const err = new Error(`Apify actor error: ${String(item.error).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    err.actorError = true;
    throw err;
  }
  if (!item.publicIdentifier) return null;

  const display_name = [item.firstName, item.lastName].filter(Boolean).join(' ').trim() || null;
  const title = item.jobTitle || (item.positions?.[0]?.title) || null;
  const company = item.companyName || (item.currentCompany?.name) || (item.positions?.[0]?.company?.name) || null;
  const location = item.geoLocationName || null;

  return {
    handle: item.publicIdentifier,
    profile_url: `https://www.linkedin.com/in/${item.publicIdentifier}/`,
    display_name,
    headline: item.headline || null,
    bio: item.summary || null,
    summary: item.summary || null,
    location,
    country_code: item.countryCode || null,
    followers_count: item.followerCount || 0,
    connections_count: item.connectionsCount || 0,
    company,
    title,
    picture_url: pickPictureUrl(item.pictureUrl),
    is_premium: !!item.premium,
    is_verified: !!item.isVerified,
    is_creator: !!item.creator,
    is_influencer: !!item.influencer,
    positions: item.positions || null,
    educations: item.educations || null,
    skills: item.skills || null,
    certifications: item.certifications || null,
    mutual_connections: item.mutualConnections || null,
    apify_raw: item,
  };
}

/**
 * harvestapi actor: shape uses experience, education, about, photo string,
 * location.{linkedinText,countryCode}, currentPosition[], verified, etc.
 * Returns null on per-item "Profile not found" (counted as MISS by caller).
 */
function mapHarvestApiItem(item) {
  if (!item || typeof item !== 'object') return null;
  // hard-stop errors (actor-level, account, etc.) bubble up.
  if (typeof item.error === 'string' && /hard limit|free user|subscribe/i.test(item.error)) {
    const err = new Error(`Apify actor error: ${item.error.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    err.actorError = true;
    throw err;
  }
  // soft per-item errors (profile not found, private) -> skip
  if (item.error) return null;
  if (!item.publicIdentifier) return null;

  const display_name = [item.firstName, item.lastName].filter(Boolean).join(' ').trim() || null;
  const cp = Array.isArray(item.currentPosition) && item.currentPosition.length ? item.currentPosition[0] : null;
  const ex0 = Array.isArray(item.experience) && item.experience.length ? item.experience[0] : null;
  const title = cp?.position || ex0?.position || null;
  const company = cp?.companyName || ex0?.companyName || null;

  return {
    handle: item.publicIdentifier,
    profile_url: item.linkedinUrl || `https://www.linkedin.com/in/${item.publicIdentifier}/`,
    display_name,
    headline: item.headline || null,
    bio: item.about || null,
    summary: item.about || null,
    location: item.location?.linkedinText || null,
    country_code: item.location?.countryCode || null,
    followers_count: item.followerCount || 0,
    connections_count: item.connectionsCount || 0,
    company,
    title,
    picture_url: pickPictureUrl(item.photo || item.profilePicture),
    is_premium: !!item.premium,
    is_verified: !!item.verified,
    is_creator: !!item.creator,
    is_influencer: !!item.influencer,
    positions: item.experience || null,
    educations: item.education || null,
    skills: item.skills || null,
    certifications: item.certifications || null,
    mutual_connections: null,             // harvestapi does not expose mutuals
    apify_raw: item,
  };
}

// Back-compat alias: callers passing 'apify-supreme_coder' or older code paths.
function mapApifyItem(item) { return mapSupremeCoderItem(item); }

/**
 * Fire one batch through an Apify actor's run-sync-get-dataset-items endpoint.
 * Returns array of mapped rows.
 *
 * @param {object} opts
 * @param {string} opts.token       Apify API token
 * @param {Array<string>} opts.handles  LinkedIn vanity slugs (NOT full URLs).
 * @param {string} [opts.actorSlug] Apify actor slug. Default: harvestapi.
 * @param {object} [opts.actorOpts] Forwarded to the actor's input builder
 *                                  (e.g. { scrapeCompany, findContacts, withEmail }).
 */
async function enrichBatch({ token, handles, actorSlug = DEFAULT_ACTOR, actorOpts = {}, signal }) {
  const adapter = ACTORS[actorSlug];
  if (!adapter) throw new Error(`Unknown actor: ${actorSlug}`);
  const endpoint = `${API_BASE}/acts/${actorSlug}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const body = adapter.buildInput(handles, actorOpts);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Apify ${res.status}: ${text.slice(0, 400)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`Apify response not JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(data)) {
    if (data?.error) throw new Error(`Apify error: ${data.error.message || JSON.stringify(data.error)}`);
    throw new Error(`Apify unexpected shape: ${text.slice(0, 200)}`);
  }
  return data.map(adapter.mapItem).filter(Boolean);
}

/**
 * Write enriched fields back to a prospect row matched by (platform, handle).
 */
async function persistEnriched(getPool, row, source = 'apify-supreme_coder') {
  const db = getPool();
  await db.query(`
    UPDATE prospects SET
      display_name       = COALESCE($2, display_name),
      headline           = COALESCE($3, headline),
      bio                = COALESCE($4, bio),
      summary            = $5,
      location           = COALESCE($6, location),
      country_code       = COALESCE($7, country_code),
      followers_count    = GREATEST(COALESCE($8,0), COALESCE(followers_count,0)),
      connections_count  = $9,
      company            = COALESCE($10, company),
      title              = COALESCE($11, title),
      picture_url        = $12,
      is_premium         = $13,
      is_verified        = $14,
      is_creator         = $15,
      is_influencer      = $16,
      positions          = $17::jsonb,
      educations         = $18::jsonb,
      skills             = $19::jsonb,
      certifications     = $20::jsonb,
      mutual_connections = $21::jsonb,
      apify_raw          = $22::jsonb,
      enriched_at        = CURRENT_TIMESTAMP,
      enriched_source    = $23,
      updated_at         = CURRENT_TIMESTAMP,
      profile_url        = COALESCE($24, profile_url)
    WHERE platform = 'linkedin' AND handle = $1
  `, [
    row.handle,
    row.display_name,
    row.headline,
    row.bio,
    row.summary,
    row.location,
    row.country_code,
    row.followers_count,
    row.connections_count,
    row.company,
    row.title,
    row.picture_url,
    row.is_premium,
    row.is_verified,
    row.is_creator,
    row.is_influencer,
    row.positions ? JSON.stringify(row.positions) : null,
    row.educations ? JSON.stringify(row.educations) : null,
    row.skills ? JSON.stringify(row.skills) : null,
    row.certifications ? JSON.stringify(row.certifications) : null,
    row.mutual_connections ? JSON.stringify(row.mutual_connections) : null,
    row.apify_raw ? JSON.stringify(row.apify_raw) : null,
    source,
    row.profile_url,
  ]);
}

/**
 * High-level: enrich a list of LinkedIn prospect handles.
 * Loads candidates from DB, batches calls, persists results.
 *
 * @param {object} opts
 * @param {function} opts.getPool         pg pool factory (lib/db.getPool)
 * @param {string}   opts.token           Apify API token
 * @param {Array<string>} opts.handles    LinkedIn vanity slugs to enrich
 * @param {function} opts.onProgress      (stage, payload) => void
 * @param {number}   opts.chunkSize       URLs per actor run (default 50)
 */
async function enrichProspects({ getPool, token, handles, onProgress = () => {}, chunkSize = DEFAULT_CHUNK, actorSlug = DEFAULT_ACTOR, actorOpts = {}, source = null }) {
  if (!token) throw new Error('Apify token required');
  if (!Array.isArray(handles) || !handles.length) {
    onProgress('done', { enriched: 0, total: 0 });
    return { enriched: 0, failed: 0, total: 0 };
  }
  if (!ACTORS[actorSlug]) throw new Error(`Unknown actor: ${actorSlug}. Known: ${Object.keys(ACTORS).join(', ')}`);

  const enrichmentSource = source || `apify-${actorSlug.split('~')[0]}`;

  const chunks = [];
  for (let i = 0; i < handles.length; i += chunkSize) {
    chunks.push(handles.slice(i, i + Math.min(chunkSize, MAX_PER_RUN)));
  }

  let enriched = 0;
  let failed = 0;

  onProgress('start', { total: handles.length, chunks: chunks.length, actor: actorSlug });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onProgress('batch_start', { chunk: i + 1, total: chunks.length, size: chunk.length });
    try {
      let mapped;
      try {
        mapped = await enrichBatch({ token, handles: chunk, actorSlug, actorOpts });
      } catch (innerErr) {
        if (innerErr.actorError) {
          // Hard stop: actor blocked us (free-tier cap, etc.). No point continuing.
          onProgress('actor_blocked', { error: innerErr.message, enrichedSoFar: enriched, failedSoFar: failed });
          throw innerErr;
        }
        throw innerErr;
      }
      for (const row of mapped) {
        try {
          await persistEnriched(getPool, row, enrichmentSource);
          enriched++;
          onProgress('persisted', { handle: row.handle, title: row.title, company: row.company, enrichedSoFar: enriched, failedSoFar: failed, total: handles.length });
        } catch (err) {
          failed++;
          onProgress('persist_error', { handle: row.handle, error: err.message });
        }
      }
      // Profiles in the input that Apify couldn't resolve (private / deleted /
      // rate-limited) won't appear in the response. Count missing as failed.
      const got = new Set(mapped.map(r => r.handle));
      for (const h of chunk) if (!got.has(h)) { failed++; onProgress('missing', { handle: h, enrichedSoFar: enriched, failedSoFar: failed, total: handles.length }); }
      onProgress('batch_done', { chunk: i + 1, total: chunks.length, enrichedSoFar: enriched, failedSoFar: failed });
    } catch (err) {
      failed += chunk.length;
      onProgress('batch_error', { chunk: i + 1, total: chunks.length, error: err.message });
    }
  }

  onProgress('done', { enriched, failed, total: handles.length });
  return { enriched, failed, total: handles.length };
}

/**
 * Convenience: find LinkedIn prospects that need enrichment (no enriched_at,
 * optional headline-substring filter).
 */
async function listHandlesToEnrich(getPool, { headlineFilter = null, limit = 2000 } = {}) {
  const db = getPool();
  const params = [limit];
  let whereExtras = '';
  if (headlineFilter) {
    params.unshift(`%${headlineFilter}%`);
    whereExtras = `AND headline ILIKE $1`;
    // shift limit param to $2
    return db.query(`
      SELECT handle FROM prospects
      WHERE platform='linkedin' AND enriched_at IS NULL ${whereExtras}
      ORDER BY (title IS NULL), id ASC
      LIMIT $2
    `, params).then(r => r.rows.map(x => x.handle));
  }
  return db.query(`
    SELECT handle FROM prospects
    WHERE platform='linkedin' AND enriched_at IS NULL
    ORDER BY (title IS NULL), id ASC
    LIMIT $1
  `, params).then(r => r.rows.map(x => x.handle));
}

module.exports = {
  ACTORS,
  DEFAULT_ACTOR,
  enrichBatch,
  enrichProspects,
  mapApifyItem,
  mapSupremeCoderItem,
  mapHarvestApiItem,
  persistEnriched,
  listHandlesToEnrich,
};
