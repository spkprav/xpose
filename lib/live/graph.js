const { extractFollowerFromGraphQL } = require('../twitter/extractors');
const { CRAWL_ENTRY_PATHS } = require('../twitter/constants');
const { operationFromUrl } = require('./extract');

// Own followers and following. A pass is progress only when the scroll reached
// the end. A short or interrupted list must not mark the missing people as gone.

function normalizeHandle(value) {
  const raw = String(value || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,50}$/.test(raw)) return '';
  return raw.toLowerCase();
}

function countOf(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function profileFromItemContent(itemContent) {
  if (!itemContent) return null;
  return extractFollowerFromGraphQL({ content: { itemContent } });
}

function usersFromEntry(entry) {
  const found = [];
  const direct = extractFollowerFromGraphQL(entry);
  if (direct) found.push(direct);
  const items = entry?.content?.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const nested = item?.item?.itemContent || item?.itemContent;
      const profile = profileFromItemContent(nested);
      if (profile) found.push(profile);
    }
  }
  return found;
}

function bottomCursorValue(entry) {
  const content = entry?.content || {};
  const nested = content.itemContent || {};
  const id = String(entry?.entryId || '');
  const cursor = content.cursorType ? content : (nested.cursorType ? nested : null);
  if (cursor && String(cursor.cursorType).toLowerCase() === 'bottom') {
    return cursor.value == null ? '' : String(cursor.value);
  }
  if (id.startsWith('cursor-bottom')) {
    const value = content.value ?? nested.value;
    return value == null ? '' : String(value);
  }
  return null;
}

function relationFromUrl(url) {
  const op = operationFromUrl(url || '');
  if (op === 'Followers') return 'follower';
  if (op === 'Following') return 'following';
  return null;
}

/**
 * Pull the accounts off one Followers or Following GraphQL body.
 * Other timelines are ignored so a profile tweet response is not the list.
 */
function extractGraphPage(json, url) {
  const empty = { isList: false, relation: null, users: [], hasBottomCursor: false, bottomCursor: '' };
  const data = json?.data || json;
  if (!data || typeof data !== 'object') return empty;
  let relation = relationFromUrl(url);
  if (!relation) {
    if (data.followers_timeline) relation = 'follower';
    else if (data.following_timeline) relation = 'following';
  }
  if (!relation) return empty;
  if (json?.errors && !json?.data && !data.user && !data.followers_timeline && !data.following_timeline) {
    return empty;
  }

  const key = relation === 'follower' ? 'Followers' : 'Following';
  const instructions = CRAWL_ENTRY_PATHS[key]?.(data) || null;
  if (!instructions) {
    // A named Followers/Following body with no timeline is not a page of people.
    return empty;
  }

  const users = [];
  const seen = new Set();
  let cursorRaw = null;
  for (const instruction of instructions) {
    const entries = instruction?.entries || (instruction?.entry ? [instruction.entry] : []);
    for (const entry of entries) {
      const cursor = bottomCursorValue(entry);
      if (cursor != null) cursorRaw = cursor;
      for (const profile of usersFromEntry(entry)) {
        const screen = normalizeHandle(profile.screen_name);
        if (!screen || seen.has(screen)) continue;
        seen.add(screen);
        users.push({
          screen_name: screen,
          user_id: profile.user_id ? String(profile.user_id).slice(0, 30) : null,
          display_name: profile.display_name ? String(profile.display_name).slice(0, 100) : null,
          followers_count: countOf(profile.followers_count),
          following_count: countOf(profile.following_count),
        });
      }
    }
  }

  const hasBottomCursor = cursorRaw != null && cursorRaw !== '' && cursorRaw !== '0';
  return {
    isList: true,
    relation,
    users,
    hasBottomCursor,
    bottomCursor: hasBottomCursor ? cursorRaw : '',
  };
}

/**
 * Decide what a finished or partial scan is allowed to write.
 * `rows` are the stored graph. `scrollComplete` is true only when the
 * timeline itself ran out, not when the scroll hit a safety cap.
 */
function planGraphReconcile({
  seen,
  rows,
  hadComplete,
  scrollComplete,
  headerCount,
} = {}) {
  const seenMap = new Map();
  for (const person of seen || []) {
    const screen = normalizeHandle(person.screen_name);
    if (!screen || seenMap.has(screen)) continue;
    seenMap.set(screen, {
      screen_name: screen,
      user_id: person.user_id ? String(person.user_id).slice(0, 30) : null,
      display_name: person.display_name ? String(person.display_name).slice(0, 100) : null,
      followers_count: countOf(person.followers_count),
      following_count: countOf(person.following_count),
    });
  }

  const present = new Set();
  const gone = new Set();
  for (const row of rows || []) {
    const screen = normalizeHandle(row.screen_name);
    if (!screen) continue;
    if (row.removed_at) gone.add(screen);
    else present.add(screen);
  }

  const header = Number.isInteger(headerCount) && headerCount >= 0 ? headerCount : null;
  let closing = !!scrollComplete;
  let reason = null;
  if (closing && seenMap.size === 0 && header !== 0) {
    closing = false;
    reason = 'page had no one';
  }
  if (closing && present.size > 20 && seenMap.size < present.size * 0.5) {
    closing = false;
    reason = `only ${seenMap.size} of ${present.size}`;
  }
  // The profile count includes accounts the list does not render. A small gap
  // can still be a finished scroll. A large gap means the scroll stopped early.
  if (closing && header > 0 && seenMap.size < Math.floor(header * 0.9)) {
    closing = false;
    reason = `${seenMap.size} of ${header} on the profile`;
  }

  const baseline = closing && !hadComplete;
  const added = [];
  if (!baseline) {
    for (const [screen, person] of seenMap) {
      if (!present.has(screen) && (hadComplete || gone.has(screen))) added.push(person);
    }
  }
  const removed = [];
  if (closing) {
    for (const screen of present) {
      if (!seenMap.has(screen)) removed.push(screen);
    }
  }

  return {
    closing,
    baseline,
    reason,
    seen: [...seenMap.values()],
    added,
    removed,
    total: seenMap.size,
    headerCount: header,
  };
}

module.exports = {
  normalizeHandle,
  extractGraphPage,
  planGraphReconcile,
};
