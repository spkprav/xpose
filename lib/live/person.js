const LIST_CAP = 8;
const TEXT_CAP = 2000;

const SCALAR_KEYS = [
  'user_id',
  'display_name',
  'bio',
  'website',
  'location',
  'created_at',
  'is_blue_verified',
];

function tweetRecord(tweet) {
  const body = tweet?.tweet || {};
  const user = tweet?.user || {};
  const id = body.id == null ? '' : String(body.id);
  const screenName = user.screen_name || '';
  if (!id || !body.text || !screenName) return null;
  return {
    id,
    text: String(body.text).slice(0, TEXT_CAP),
    created_at: body.created_at || null,
    screen_name: screenName,
    name: user.name || '',
    followers_count: user.followers_count || 0,
    following_count: user.following_count || 0,
    reply_count: body.reply_count || 0,
    like_count: body.favorites_count || body.like_count || 0,
    retweet_count: body.retweet_count || 0,
    quote_count: body.quote_count || 0,
    views: body.views || '0',
    in_reply_to_screen_name: body.in_reply_to_screen_name || null,
    in_reply_to_status_id: body.in_reply_to_status_id || null,
    source: tweet.source || null,
    url: `https://x.com/${screenName}/status/${id}`,
  };
}

function bucketFor(url, record) {
  const target = `${url || ''} ${record?.source || ''}`;
  if (/highlight/i.test(target)) return 'highlights';
  if (record?.in_reply_to_status_id || record?.in_reply_to_screen_name) return 'replies';
  return 'tweets';
}

function unionTweets(prev, next, cap = LIST_CAP) {
  const map = new Map();
  for (const item of [...(next || []), ...(prev || [])]) {
    if (!item?.id) continue;
    const id = String(item.id);
    const older = map.get(id);
    map.set(id, older ? { ...older, ...item, id } : { ...item, id });
  }
  return [...map.values()].slice(0, cap);
}

function keepCount(prev, next) {
  const value = Number(next);
  if (Number.isFinite(value) && value > 0) return value;
  return Number(prev) || 0;
}

function mergePersonPayload(prev, next) {
  const older = prev && typeof prev === 'object' ? prev : {};
  const incoming = next && typeof next === 'object' ? next : {};
  const merged = { ...older };

  for (const key of SCALAR_KEYS) {
    const value = incoming[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'is_blue_verified') {
      merged[key] = !!(older[key] || value);
      continue;
    }
    merged[key] = value;
  }
  merged.followers_count = keepCount(older.followers_count, incoming.followers_count);
  merged.following_count = keepCount(older.following_count, incoming.following_count);

  const pinnedIds = unionIds(older.pinned_ids, incoming.pinned_ids);
  if (pinnedIds.length) merged.pinned_ids = pinnedIds;

  for (const key of ['pinned', 'highlights', 'tweets', 'replies']) {
    const combined = unionTweets(older[key], incoming[key]);
    if (combined.length) merged[key] = combined;
  }
  return merged;
}

function unionIds(prev, next) {
  const ids = [];
  for (const id of [...(prev || []), ...(next || [])]) {
    const value = String(id || '');
    if (value && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

function attachTweetToPerson(payload, bucket, record) {
  const merged = mergePersonPayload(payload, {});
  let list = bucket;
  if ((merged.pinned_ids || []).includes(String(record.id))) list = 'pinned';
  if (!['pinned', 'highlights', 'tweets', 'replies'].includes(list)) list = 'tweets';
  merged[list] = unionTweets(merged[list], [record]);
  return merged;
}

module.exports = {
  LIST_CAP,
  tweetRecord,
  bucketFor,
  mergePersonPayload,
  attachTweetToPerson,
};
