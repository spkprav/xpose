// Quality gate. Reject obvious junk BEFORE upsertProspect. Applies to rows
// from both DOM scraper + voyager API extractors. Belt + suspenders.

const JUNK_NAME_PATTERNS = [
  /Premium Profile/i,
  /^\d+\s*(st|nd|rd|th)\+?\s*$/i,        // "1st", "2nd", "3rd+"
  /\b(celebrates? this|likes? this|loves? this|reacted|commented|reposted|shared this|posted this|finds this insightful|congratulates|supports? this)\b/i,
  /^(View|See|Open|More|Show|Premium)\b/i,
  /\binvited you to\b/i,
  /^Status is offline\b/i,                // LinkedIn "messaging unavailable" card text leaked into name field
];

const JUNK_HEADLINE_PATTERNS = [
  /\b(celebrates? this|likes? this|loves? this|reacted|commented|reposted|shared this)\b/i,
  /\bPremium Profile\b/i,
  /^(View|See|Open|More|Show)\b/i,
  /^\d+(st|nd|rd|th)\+?\s/i,
  /^\s*•\s*\d+(st|nd|rd|th)\+?\s*$/i,     // degree-label-only headline (e.g. "• 2nd")
  /^\s*\d+\s+followers\s*[•·]/i,          // follower-count + name-list teaser (e.g. "591 followers • A, B and 4 others")
  /^\s*\d+\s+followers\s*$/i,             // bare follower count
];

// Headlines that look like POST CONTENT, not profile titles. Heuristics:
// - End with period (job titles rarely do)
// - Contain "admitted", "announced", "said", "today", "yesterday", quote chars
// - Over 240 chars (most real headlines under ~200)
const POST_BODY_PATTERNS = [
  /\b(admitted|announced|said|today|yesterday|this week|last week|breaking|just shipped|just launched)\b/i,
  /["""].{20,}["""]/,                    // long quoted text
];

function isJunkName(s) {
  if (!s) return true;
  if (s.length < 2 || s.length > 100) return true;
  return JUNK_NAME_PATTERNS.some(re => re.test(s));
}

function looksLikePostBody(s) {
  if (!s) return false;
  if (s.length > 240) return true;
  if (s.trim().endsWith('.') && /\s[a-z]+\s+[a-z]+\s+[a-z]+/i.test(s)) return true;
  return POST_BODY_PATTERNS.some(re => re.test(s));
}

function cleanHeadline(s) {
  if (!s) return null;
  if (JUNK_HEADLINE_PATTERNS.some(re => re.test(s))) return null;
  if (looksLikePostBody(s)) return null;
  if (headlineLooksLikeNameList(s)) return null;
  return s.trim();
}

// Headlines like "Foo Bar, Baz Qux, and 4 others" are search-result card teasers
// where multiple profile thumbnails got concatenated as a single headline.
function headlineLooksLikeNameList(s) {
  if (!s) return false;
  if (!/\bothers?\b/i.test(s)) return false;
  const commas = (s.match(/,/g) || []).length;
  return commas >= 2;
}

// Sanitize one prospect row. Returns null if irrecoverable junk.
function sanitize(row) {
  if (!row || !row.handle) return null;
  if (row.handle.startsWith('ACoAA')) return null;   // URN-only handle, not vanity slug
  if (isJunkName(row.display_name)) return null;
  // strip trailing degree markers that snuck through
  const name = (row.display_name || '').replace(/\s*[•·]\s*(1st|2nd|3rd\+?|3rd)\b.*$/i, '').replace(/\s*Premium\s+Profile.*$/i, '').trim();
  if (isJunkName(name)) return null;
  return {
    ...row,
    display_name: name,
    headline: cleanHeadline(row.headline),
  };
}

function sanitizeMany(rows) {
  const out = [];
  for (const r of rows) {
    const s = sanitize(r);
    if (s) out.push(s);
  }
  return out;
}

module.exports = { sanitize, sanitizeMany, isJunkName, cleanHeadline, looksLikePostBody, headlineLooksLikeNameList };
