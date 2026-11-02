// LinkedIn voyager response extractors.
// Each function: parsed JSON → array of normalized prospect records ready for
// upsertProspect({ platform: 'linkedin', ... }).
//
// LinkedIn's "Decoupling API" pattern:
//   - response.data        = the entity for this endpoint
//   - response.data.elements / response.data['*elements'] = top-level URN refs
//   - response.included[]  = denormalized lookup table of every referenced entity
//
// All people-bearing endpoints converge on:
//   included[].$type === 'com.linkedin.voyager.dash.identity.profile.Profile'
// with: publicIdentifier, firstName, lastName, headline, entityUrn, profilePicture
// (Some Profile shapes also include summary, locationName, industryUrn.)

const PROFILE_TYPE = 'com.linkedin.voyager.dash.identity.profile.Profile';
const CONNECTION_TYPE = 'com.linkedin.voyager.dash.relationships.Connection';

function fullName(p) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || null;
}

// Voyager Profile entries on connection-list / search responses ship only
// firstName/lastName/headline/publicIdentifier/profilePicture. The richer
// positions[] + educations[] live only on /identity/dash/profiles/<urn>
// (one-by-one), which is too high-volume to crawl safely. So we recover
// title + company by parsing the headline string.
//
// ~70% of LinkedIn headlines follow shape:
//   "TITLE at COMPANY"            (most reliable)
//   "TITLE @COMPANY" / "TITLE @ COMPANY"
//   "TITLE — COMPANY"             (en-dash, em-dash)
//   "TITLE | COMPANY"             (only when COMPANY looks like a brand)
//
// Rest stay null and fall back to headline-only scoring.

const PROSE_TOKENS = /\b(i|me|my|btw|have|had|just|also|started|recently|currently|since|after|while|been|am|dm|free|for a|with a)\b/i;
const ROLE_WORDS = /\b(engineer|developer|founder|director|manager|owner|partner|coach|consultant|analyst|designer|architect|lead|cto|ceo|coo|cfo|vp|head|chief|principal|specialist|strategist|advisor|officer|president|driving|building|helping)\b/i;
const TECH_STACK_RE = /\b(js|jsx|tsx|ts|sql|python|java|ruby|rails|react|next|nextjs|node|nodejs|vue|angular|aws|gcp|azure|docker|kubernetes|k8s|graphql|rest|api|sdk|cli|devops|sre|qa|sdet|automation|ml|nlp|llm|ios|android|swift|kotlin|golang|rust|php|html|css|tailwind|figma|firebase|mongodb|postgres|mysql|redis|kafka|spark|hadoop|django|flask|fastapi|spring|laravel|express|ethers|solidity|hardhat|web3|blockchain|frontend|backend|fullstack)\b/i;

function _clean(s) {
  if (!s) return null;
  const t = String(s).replace(/^[\s,;:|·•\-]+|[\s,;:|·•\-]+$/g, '').trim();
  return t || null;
}

// A "looks like a company name" guard: rejects skill-stack tokens, prose CTAs,
// over-long descriptors. Real companies cluster 1-5 Title-Cased words.
function looksLikeCompany(s) {
  if (!s) return false;
  const c = s.trim();
  if (c.length < 2 || c.length > 60) return false;
  // Word count: companies almost never exceed 6 words.
  const words = c.split(/\s+/);
  if (words.length > 6) return false;
  // Reject tech-stack tokens.
  if (TECH_STACK_RE.test(c)) return false;
  // Reject CTA / prose markers.
  if (PROSE_TOKENS.test(c)) return false;
  // Reject sentence-style: ends with period followed by more text, or contains 2+ periods.
  if ((c.match(/\./g) || []).length >= 2) return false;
  // Reject if 3+ words are lowercase (likely descriptor phrase, not company).
  const lowercaseCount = words.filter(w => w && /^[a-z]/.test(w)).length;
  if (lowercaseCount >= 3) return false;
  return true;
}

function parseHeadlineTitleCompany(headline) {
  if (!headline || typeof headline !== 'string') return { title: null, company: null };
  const h = headline.trim();
  if (h.length < 4) return { title: null, company: null };

  // Pattern 1: "TITLE at COMPANY" / "TITLE @COMPANY". Highest confidence.
  // Company captured up to first separator (|, ·, •, em/en-dash) or end of string.
  let m = h.match(/^(.{2,80}?)\s+(?:at\s+|@\s*)([^|·•—–]{2,80}?)(?:\s*[|·•—–]|$)/i);
  if (m) {
    const title = _clean(m[1]);
    const company = _clean(m[2]);
    if (title && company && title.length <= 80 && !PROSE_TOKENS.test(title) && looksLikeCompany(company)) {
      return { title, company };
    }
  }

  // Pattern 3: "TITLE — COMPANY" via en-dash or em-dash (not bare hyphen).
  m = h.match(/^(.{2,60}?)\s+[–—]\s+([^–—|]{2,60}?)(?:\s+[–—]|\s*\||$)/);
  if (m) {
    const title = _clean(m[1]);
    const company = _clean(m[2]);
    if (title && company && !PROSE_TOKENS.test(title) && looksLikeCompany(company)) {
      return { title, company };
    }
  }

  // Pattern 2: "TITLE | COMPANY". Only when headline has exactly one `|` separator
  // (multi-`|` headlines are skill lists, not title-company).
  const pipeCount = (h.match(/\|/g) || []).length;
  if (pipeCount === 1) {
    m = h.match(/^(.{2,60}?)\s*\|\s*(.{2,50}?)$/);
    if (m) {
      const title = _clean(m[1]);
      const company = _clean(m[2]);
      if (title && company && !PROSE_TOKENS.test(title) && !ROLE_WORDS.test(company) && looksLikeCompany(company)) {
        return { title, company };
      }
    }
  }

  return { title: null, company: null };
}

function profilePicUrl(p) {
  const pic = p.profilePicture?.displayImageReference?.vectorImage;
  if (!pic) return null;
  const art = (pic.artifacts || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (!art || !pic.rootUrl) return null;
  return pic.rootUrl + art.fileIdentifyingUrlPathSegment;
}

function profileFromIncluded(p) {
  if (!p || p.$type !== PROFILE_TYPE) return null;
  if (!p.publicIdentifier) return null;  // legacy / ghost profile, skip
  if (p.publicIdentifier.startsWith('ACoAA')) return null;  // URN-only handle, not vanity slug

  const headline = p.headline || null;
  const parsed = parseHeadlineTitleCompany(headline);

  return {
    platform: 'linkedin',
    handle: p.publicIdentifier,
    profile_url: `https://www.linkedin.com/in/${p.publicIdentifier}/`,
    display_name: fullName(p),
    headline,
    bio: p.summary || null,
    location: p.locationName || null,
    followers_count: 0,         // not in connection-list Profile shape
    following_count: 0,
    company: parsed.company,
    title: parsed.title,
    raw_data: {
      entityUrn: p.entityUrn,
      industryUrn: p.industryUrn || null,
      profile_pic: profilePicUrl(p),
      $recipeTypes: p.$recipeTypes,
    },
  };
}

/**
 * Extract every Profile entry from a voyager response's `included[]` array.
 * Works for: connections list, search results, profile-components, anywhere a
 * Profile appears in the lookup table.
 */
function extractProfilesFromIncluded(body) {
  if (!body || !Array.isArray(body.included)) return [];
  const out = [];
  for (const item of body.included) {
    const p = profileFromIncluded(item);
    if (p) out.push(p);
  }
  // Dedupe by handle within this response.
  const seen = new Set();
  return out.filter(p => {
    if (seen.has(p.handle)) return false;
    seen.add(p.handle);
    return true;
  });
}

/**
 * Single full-profile endpoint: voyager/api/identity/dash/profiles/<urn>
 * The profile lives at body.data (not in included[]).
 */
function extractSingleProfile(body) {
  const d = body?.data;
  if (!d || !d.publicIdentifier) return [];
  if (d.publicIdentifier.startsWith('ACoAA')) return [];

  const headline = d.headline || null;
  const parsed = parseHeadlineTitleCompany(headline);

  return [{
    platform: 'linkedin',
    handle: d.publicIdentifier,
    profile_url: `https://www.linkedin.com/in/${d.publicIdentifier}/`,
    display_name: fullName(d),
    headline,
    bio: d.summary || null,
    location: d.locationName || d.address || null,
    followers_count: 0,
    following_count: 0,
    company: parsed.company,
    title: parsed.title,
    raw_data: {
      entityUrn: d.entityUrn,
      industryUrn: d.industryUrn || null,
      premium: d.premium || false,
      profile_pic: profilePicUrl(d),
      geoLocation: d.geoLocation || null,
    },
  }];
}

/**
 * Connection metadata (createdAt = when you connected). Pair Connection
 * entries with the matching Profile by URN suffix.
 */
function extractConnections(body) {
  if (!body || !Array.isArray(body.included)) return [];
  const profiles = new Map();   // urn → Profile
  const connections = [];

  for (const item of body.included) {
    if (item.$type === PROFILE_TYPE && item.entityUrn) {
      profiles.set(item.entityUrn, item);
    } else if (item.$type === CONNECTION_TYPE) {
      connections.push(item);
    }
  }

  const out = [];
  for (const c of connections) {
    const memberUrn = c.connectedMember || c['*connectedMember'];
    if (!memberUrn) continue;
    const profileUrn = memberUrn.replace(':fsd_member:', ':fsd_profile:');
    const profile = profiles.get(memberUrn) || profiles.get(profileUrn);
    if (!profile) continue;
    const prospect = profileFromIncluded(profile);
    if (!prospect) continue;
    prospect.raw_data.connected_at = c.createdAt || null;
    out.push(prospect);
  }
  return out;
}

// Patterns whose responses carry junk profiles (your own avatar, nav menus,
// messaging contacts, premium upsell models, jobseeker prefs). Skip entirely.
const JUNK_PATTERNS = [
  /voyagerFeedDashGlobalNavs/,
  /voyagerFeedDashThirdPartyIdSyncs/,
  /voyagerFeedDashLeadGenForm/,
  /voyagerMessagingDash/,
  /voyagerDashMySettings/,
  /voyagerJobsDashJobSeekerPreferences/,
  /voyagerPremiumDash/,
  /voyagerLegoDash/,
  /voyagerGlobalAlerts/,
  /voyagerIdentityDashProfiles$/,        // top-bar profile chip (vs ProfileComponents)
  /voyager\/api\/messaging\/dash\/presenceStatuses/,
];
function isJunkPattern(p) { return JUNK_PATTERNS.some(re => re.test(p)); }

// Self-URN filter. /identity/dash/profiles/<urn> fires on every page for the
// logged-in user. After 3 sightings of the same URN we treat it as self and
// suppress from all downstream extractions.
const selfUrnSeen = new Map();
let SELF_URN = null;
function markSelfCandidate(urn) {
  if (!urn) return;
  selfUrnSeen.set(urn, (selfUrnSeen.get(urn) || 0) + 1);
  if (!SELF_URN && selfUrnSeen.get(urn) >= 3) {
    SELF_URN = urn;
    console.log(`[LinkedIn:Extract] self URN detected: ${urn}`);
  }
}
function isSelf(prospect) {
  return SELF_URN && prospect?.raw_data?.entityUrn === SELF_URN;
}

/**
 * Dispatcher: given a recon pattern + parsed body, return the right extractor
 * output. Returns [] if pattern not recognized.
 *
 * Pattern values come from lib/linkedin/recon.js normalizePattern().
 */
function extractByPattern(pattern, body) {
  if (!pattern || !body) return [];
  if (isJunkPattern(pattern)) return [];
  // Connections list (REST)
  if (pattern.startsWith('voyager/api/relationships/dash/connections')) {
    return extractConnections(body).filter(p => !isSelf(p));
  }
  // Single profile by URN (REST). Fires on every page for the logged-in user;
  // we track frequency to identify self-URN, then suppress.
  if (pattern.startsWith('voyager/api/identity/dash/profiles/')) {
    const rows = extractSingleProfile(body);
    rows.forEach(r => markSelfCandidate(r.raw_data?.entityUrn));
    return rows.filter(p => !isSelf(p));
  }
  // GraphQL endpoints — all read from included[] of Profile shape
  const filterSelf = rows => rows.filter(p => !isSelf(p));
  if (pattern.startsWith('graphql:voyagerSearchDashLazyLoadedActions')) {
    return filterSelf(extractProfilesFromIncluded(body));
  }
  if (pattern.startsWith('graphql:voyagerIdentityDashProfileComponents')) {
    return filterSelf(extractProfilesFromIncluded(body));
  }
  if (pattern.startsWith('graphql:voyagerSearchDashClusters')) {
    return filterSelf(extractProfilesFromIncluded(body));
  }
  if (pattern.startsWith('graphql:voyagerFeedDashMainFeed') ||
      pattern.startsWith('graphql:voyagerFeedDashUpdatesV2') ||
      pattern.startsWith('graphql:voyagerFeedDash')) {
    return filterSelf(extractProfilesFromIncluded(body));
  }
  // Generic fallback: any voyager response that carries Profile entries.
  if (pattern.startsWith('graphql:voyager') || pattern.startsWith('voyager/api/')) {
    return filterSelf(extractProfilesFromIncluded(body));
  }
  return [];
}

function getSelfUrn() { return SELF_URN; }
function resetSelfUrn() { SELF_URN = null; selfUrnSeen.clear(); }

module.exports = {
  extractByPattern,
  extractProfilesFromIncluded,
  extractSingleProfile,
  extractConnections,
  isJunkPattern,
  getSelfUrn,
  resetSelfUrn,
  parseHeadlineTitleCompany,
};
