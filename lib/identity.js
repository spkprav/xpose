// Identity-derived defaults. Values live in user-local settings.json under
// the `identity` block. Code ships empty defaults so the open-source repo
// carries no personal data. The user edits the values via the Settings panel.
//
// Consumers call getIdentity(settings) where settings is the Settings instance
// passed in by main.js. Falls back to empty strings / arrays.

function emptySchema() {
  return {
    handle:          '',
    display_name:    '',
    location:        '',
    product:         '',
    positioning:     '',
    // Per-platform outreach context: X = builder voice, LinkedIn = sales voice.
    // Legacy single-string `outreach_context` still accepted on read (back-compat).
    outreach_context: { x: '', linkedin: '' },
    icp: {
      x:        '',
      linkedin: '',
    },
    li_search_seeds: [],
  };
}

function normalizeOutreach(stored) {
  // Back-compat: accept legacy string-valued outreach_context.
  if (typeof stored === 'string') return { x: stored, linkedin: stored };
  if (stored && typeof stored === 'object') return { x: stored.x || '', linkedin: stored.linkedin || '' };
  return { x: '', linkedin: '' };
}

function isAllEmpty(id) {
  if (!id) return true;
  const oc = id.outreach_context || {};
  if (oc.x || oc.linkedin) return false;
  if (id.icp?.x || id.icp?.linkedin) return false;
  if (Array.isArray(id.li_search_seeds) && id.li_search_seeds.length) return false;
  return true;
}

function getIdentity(settings) {
  const stored = (settings && settings.get('identity')) || {};
  const base = emptySchema();
  const merged = {
    ...base,
    ...stored,
    outreach_context: normalizeOutreach(stored.outreach_context),
    icp: { ...base.icp, ...(stored.icp || {}) },
    li_search_seeds: Array.isArray(stored.li_search_seeds) ? stored.li_search_seeds : base.li_search_seeds,
  };

  // If user-local settings.json carries no identity yet, try to derive from
  // social-wiki/me.md (gitignored user doc). Loaded lazily so the open-source
  // repo without a wiki simply gets empty defaults.
  if (isAllEmpty(merged)) {
    try {
      const { deriveFromWiki } = require('./identity-from-wiki');
      const wiki = deriveFromWiki();
      if (wiki) {
        return {
          ...merged,
          ...wiki,
          outreach_context: normalizeOutreach(wiki.outreach_context),
          icp: { ...merged.icp, ...wiki.icp },
        };
      }
    } catch (_) { /* wiki parser absent — fall back to empty */ }
  }
  return merged;
}

module.exports = {
  emptySchema,
  getIdentity,
  isAllEmpty,
  normalizeOutreach,
};
