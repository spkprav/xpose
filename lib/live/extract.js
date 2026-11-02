const { transformTweet } = require('../twitter/transformers');

// Entry ids X uses for the right-rail and connect modules. Plain `user-123`
// timeline rows are only taken when the sweep is actually on the who-to-follow page.
const SUGGESTION_ENTRY = /who-?to-?follow|whotofollow|connect|recommend|similar|sidebar-user|userrec/i;

function isLiveCaptureUrl(url) {
  if (!url) return false;
  return url.includes('/graphql/')
    || url.includes('guide.json')
    || url.includes('/i/api/2/guide');
}

function operationFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || 'response').slice(0, 48);
  } catch {
    return 'response';
  }
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 28) return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit, depth + 1);
  }
}

function websiteOf(userResult, legacy) {
  const lists = [
    legacy?.entities?.url?.urls,
    userResult?.profile_bio?.entities?.url?.urls,
    userResult?.entities?.url?.urls,
  ];
  for (const urls of lists) {
    if (Array.isArray(urls) && urls[0]) return urls[0].expanded_url || urls[0].url || null;
  }
  if (typeof userResult?.website?.url === 'string') return userResult.website.url;
  if (typeof legacy?.url === 'string' && legacy.url) return legacy.url;
  return null;
}

function pinnedIdsOf(userResult, legacy) {
  const raw = legacy?.pinned_tweet_ids_str
    || userResult?.pinned_items?.tweet_ids_str
    || userResult?.pinned_tweet_ids_str
    || [];
  if (!Array.isArray(raw)) return [];
  return raw.map(id => String(id)).filter(Boolean);
}

function userFromResult(userResult) {
  if (!userResult || userResult.__typename === 'UserUnavailable') return null;
  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  const counts = userResult.relationship_counts || {};
  const screenName = core.screen_name || legacy.screen_name;
  if (!screenName) return null;
  const bio = userResult.profile_bio?.description || legacy.description || '';
  const followers = counts.followers || legacy.followers_count || 0;
  const following = counts.following || legacy.friends_count || 0;
  const website = websiteOf(userResult, legacy);
  const location = userResult.location?.location || legacy.location || '';
  return {
    kind: 'who_to_follow',
    item_key: screenName.toLowerCase(),
    title: screenName,
    detail: bio,
    url: `https://x.com/${screenName}`,
    payload: {
      user_id: userResult.rest_id || null,
      display_name: core.name || legacy.name || null,
      bio,
      website,
      location,
      followers_count: followers,
      following_count: following,
      created_at: core.created_at || legacy.created_at || null,
      is_blue_verified: !!userResult.is_blue_verified,
      pinned_ids: pinnedIdsOf(userResult, legacy),
    },
  };
}

function replyFields(tweetResults) {
  let result = tweetResults?.result;
  if (!result) return {};
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) result = result.tweet;
  else if (result.tweet?.legacy || result.tweet?.rest_id) result = result.tweet;
  const legacy = result.legacy || {};
  return {
    in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
    in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
  };
}

// X dropped some legacy blocks in 2026. transformTweet bails when legacy is
// missing even if the text and author are still on the result.
function looseTweet(tweetResults) {
  let result = tweetResults?.result;
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) result = result.tweet;
  else if (result.tweet?.rest_id || result.tweet?.legacy) result = result.tweet;

  const legacy = result.legacy || {};
  const text = result.note_tweet?.note_tweet_results?.result?.text
    || legacy.full_text
    || result.full_text
    || '';
  const userResult = result.core?.user_results?.result || {};
  const userCore = userResult.core || {};
  const userLegacy = userResult.legacy || {};
  const counts = userResult.relationship_counts || {};
  const screenName = userCore.screen_name || userLegacy.screen_name;
  const name = userCore.name || userLegacy.name;
  const id = result.rest_id || legacy.id_str;
  if (!id || !text || !screenName || !name) return null;

  return {
    source: 'live',
    user: {
      id: userResult.rest_id || null,
      screen_name: screenName,
      name,
      is_blue_verified: !!userResult.is_blue_verified,
      description: userResult.profile_bio?.description || userLegacy.description || '',
      followers_count: counts.followers || userLegacy.followers_count || 0,
      following_count: counts.following || userLegacy.friends_count || 0,
      i_follow_user: !!(userResult.relationship_perspectives?.following ?? userLegacy.following),
      user_follows_me: !!(userResult.relationship_perspectives?.followed_by ?? userLegacy.followed_by),
    },
    tweet: {
      id: String(id),
      text,
      created_at: legacy.created_at || null,
      bookmark_count: legacy.bookmark_count || 0,
      favorites_count: legacy.favorite_count || 0,
      quote_count: legacy.quote_count || 0,
      reply_count: legacy.reply_count || 0,
      retweet_count: legacy.retweet_count || 0,
      views: result.views?.count || '0',
    },
  };
}

function collectUsers(entry, pushSignal) {
  const found = [];
  const content = entry?.content;
  if (!content) return;
  if (content.user_results && !content.tweet_results) {
    found.push(content.user_results.result);
  }
  if (content.itemContent?.user_results && !content.itemContent?.tweet_results) {
    found.push(content.itemContent.user_results.result);
  }
  const items = content.items || content.timelineModule?.items || [];
  for (const item of items) {
    const inner = item?.item?.itemContent || item?.itemContent || item?.content;
    if (inner?.user_results && !inner?.tweet_results) found.push(inner.user_results.result);
  }
  for (const user of found) {
    const signal = userFromResult(user);
    if (signal) pushSignal(signal);
  }
}

function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function linkText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.url === 'string') return value.url;
  return '';
}

function parsePostCount(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return Math.round(text);
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const match = raw.match(/([\d]+(?:[.,]\d+)?)\s*([kmb])?\s*posts/i);
  if (!match) return null;
  let n = parseFloat(match[1].replace(/,/g, ''));
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k') n *= 1000;
  else if (unit === 'm') n *= 1e6;
  else if (unit === 'b') n *= 1e9;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function contextSaysNews(text) {
  return String(text || '')
    .split(/[·•|]/)
    .some(part => part.trim().toLowerCase() === 'news');
}

function storyLink(node) {
  const raws = [node.trend_url, node.trend_metadata?.url, node.url].map(linkText).filter(Boolean);
  let restId = '';
  let deepLink = null;
  let web = null;
  for (const raw of raws) {
    const id = raw.match(/trending\/(\d+)/);
    if (id) restId = id[1];
    if (raw.startsWith('twitter:')) deepLink = raw;
    if (/^https?:\/\//.test(raw)) web = raw;
    const search = raw.match(/^twitter:\/\/search\/\?([^#\s]+)/i);
    if (search) {
      const query = new URLSearchParams(search[1]).get('query');
      if (query) web = `https://x.com/search?q=${encodeURIComponent(query)}`;
    }
  }
  return { url: web, restId, deepLink };
}

function groupedNames(node) {
  if (!Array.isArray(node.grouped_trends)) return [];
  return node.grouped_trends
    .map(item => (typeof item?.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
}

function proofUrls(node) {
  const rows = node.social_proof || node.social_context?.contextImageUrls || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => (typeof row === 'string' ? row : row?.img_url))
    .filter(url => typeof url === 'string' && url)
    .slice(0, 6);
}

function searchUrlFor(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  return `https://x.com/search?q=${encodeURIComponent(text)}`;
}

function timelineTrendSignal(node) {
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (!name) return null;
  const link = storyLink(node);
  const context = String(node.social_context?.text || node.trend_metadata?.domain_context || '').trim();
  const kind = (node.is_ai_trend || contextSaysNews(context)) ? 'news' : 'trend';
  return {
    kind,
    item_key: link.restId || nameKey(name),
    title: name,
    detail: context,
    url: link.url || searchUrlFor(name),
    payload: {
      rest_id: link.restId || null,
      context,
      post_count: parsePostCount(context),
      grouped: groupedNames(node),
      is_ai_trend: !!node.is_ai_trend,
      deep_link: link.deepLink,
      social_proof: proofUrls(node),
    },
  };
}

function aiTrendSignal(node) {
  const core = node.core || {};
  const name = typeof core.name === 'string' ? core.name.trim() : '';
  const restId = node.rest_id ? String(node.rest_id) : '';
  if (!name && !restId) return null;
  const hook = typeof core.hook === 'string' ? core.hook.trim() : '';
  return {
    kind: 'news',
    item_key: restId || nameKey(name),
    title: name || restId,
    detail: hook,
    url: searchUrlFor(name || restId),
    payload: {
      rest_id: restId || null,
      hook,
      category: core.category || null,
      created_at_ms: core.created_at_ms || null,
      post_count: parsePostCount(node.post_count),
      is_ai_trend: true,
      social_proof: proofUrls(node),
    },
  };
}

function eventSummarySignal(node) {
  const promo = node.promotedMetadata || {};
  const name = String(promo.promotedTrendName || node.title || '').trim();
  if (!name) return null;
  const restId = String(promo.promotedTrend?.rest_id || node.event?.rest_id || '');
  const description = typeof promo.promotedTrendDescription === 'string'
    ? promo.promotedTrendDescription.trim()
    : '';
  const query = String(promo.promotedTrendQueryTerm || name).trim();
  return {
    kind: 'trend',
    item_key: `promoted:${restId || nameKey(name)}`,
    title: name,
    detail: description,
    url: searchUrlFor(query),
    payload: {
      rest_id: restId || null,
      promoted: true,
      description,
      query: query || null,
    },
  };
}

function collectStory(node, pushSignal) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  let signal = null;
  if (node.__typename === 'TimelineTrend' || node.itemType === 'TimelineTrend') {
    signal = timelineTrendSignal(node);
  } else if (node.__typename === 'AiTrend') {
    signal = aiTrendSignal(node);
  } else if (node.__typename === 'TimelineEventSummary') {
    signal = eventSummarySignal(node);
  }
  if (signal) pushSignal(signal);
}

function storyScore(signal) {
  const payload = signal?.payload || {};
  return String(signal?.detail || '').length
    + String(payload.hook || '').length
    + (payload.post_count ? 40 : 0);
}

function longerText(left, right) {
  return String(right || '').length > String(left || '').length ? right : (left || right || null);
}

function keepList(left, right) {
  if (Array.isArray(right) && right.length) return right;
  return Array.isArray(left) ? left : [];
}

// A later AiTrend body has the hook. A later thin card must not wipe it.
function mergeStoryPayload(prev, next) {
  const older = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  const incoming = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  return {
    ...older,
    ...incoming,
    hook: longerText(older.hook, incoming.hook),
    context: longerText(older.context, incoming.context),
    description: longerText(older.description, incoming.description),
    post_count: incoming.post_count || older.post_count || null,
    category: incoming.category || older.category || null,
    rest_id: incoming.rest_id || older.rest_id || null,
    query: incoming.query || older.query || null,
    deep_link: incoming.deep_link || older.deep_link || null,
    created_at_ms: incoming.created_at_ms || older.created_at_ms || null,
    grouped: keepList(older.grouped, incoming.grouped),
    social_proof: keepList(older.social_proof, incoming.social_proof),
    is_ai_trend: !!(older.is_ai_trend || incoming.is_ai_trend),
    promoted: !!(older.promoted || incoming.promoted),
  };
}

function preferWebUrl(prev, next) {
  const older = prev || '';
  const incoming = next || '';
  if (/^https?:\/\//.test(incoming)) return incoming;
  if (/^https?:\/\//.test(older)) return older;
  return incoming || older || null;
}

function newsTitle(node) {
  if (typeof node.title === 'string') return node.title;
  if (typeof node.title?.text === 'string') return node.title.text;
  return '';
}

function newsUrl(node) {
  if (typeof node.landingUrl?.url === 'string') return node.landingUrl.url;
  if (typeof node.landing_url === 'string') return node.landing_url;
  if (typeof node.url === 'string') return node.url;
  if (typeof node.url?.url === 'string') return node.url.url;
  return '';
}

/**
 * Pull tweets plus who-to-follow / trend / news cards out of any X JSON body.
 * `phase` is the sweep step currently driving the view. `who-to-follow` treats
 * user rows as suggestions. Other phases only take users inside known modules.
 */
function extractLivePayload(json, { phase = 'passive' } = {}) {
  const root = json?.data || json;
  const tweets = [];
  const signals = [];
  const seenTweets = new Set();
  const signalByKey = new Map();

  function pushSignal(signal) {
    if (!signal?.item_key || !signal.kind) return;
    const key = `${signal.kind}:${signal.item_key}`;
    const prev = signalByKey.get(key);
    if (!prev) {
      signalByKey.set(key, signal);
      signals.push(signal);
      return;
    }
    if (signal.kind === 'who_to_follow') return;
    if (storyScore(signal) <= storyScore(prev)) return;
    prev.title = signal.title || prev.title;
    prev.detail = signal.detail || prev.detail;
    prev.url = signal.url || prev.url;
    prev.payload = mergeStoryPayload(prev.payload, signal.payload);
  }

  walk(root, (node) => {
    collectStory(node, pushSignal);

    if (node.tweet_results?.result) {
      const tweet = transformTweet(node.tweet_results, 'live') || looseTweet(node.tweet_results);
      const id = tweet?.tweet?.id;
      const text = tweet?.tweet?.text;
      if (tweet && id && text && !seenTweets.has(String(id))) {
        Object.assign(tweet.tweet, replyFields(node.tweet_results));
        seenTweets.add(String(id));
        tweets.push(tweet);
      }
    }

    if (phase === 'who-to-follow' && node.user?.result?.rest_id) {
      const profile = userFromResult(node.user.result);
      if (profile) pushSignal(profile);
    }

    const entryId = typeof node.entryId === 'string' ? node.entryId : '';
    const onConnectPage = phase === 'who-to-follow';
    if (entryId && node.content && (onConnectPage || SUGGESTION_ENTRY.test(entryId))) {
      collectUsers(node, pushSignal);
    }

    const trend = node.trend && typeof node.trend === 'object' ? node.trend : null;
    if (trend && typeof trend.name === 'string' && trend.name.trim()) {
      pushSignal({
        kind: 'trend',
        item_key: trend.name.trim().toLowerCase(),
        title: trend.name.trim(),
        detail: trend.meta_description || trend.metaDescription || '',
        url: trend.url?.url || null,
        payload: { rank: trend.rank || null },
      });
    } else if (
      typeof node.name === 'string'
      && node.name.trim().length <= 80
      && (typeof node.meta_description === 'string' || typeof node.metaDescription === 'string')
      && (node.rank != null || node.url)
    ) {
      const url = typeof node.url === 'string' ? node.url : (node.url?.url || null);
      pushSignal({
        kind: 'trend',
        item_key: node.name.trim().toLowerCase(),
        title: node.name.trim(),
        detail: node.meta_description || node.metaDescription || '',
        url,
        payload: { rank: node.rank || null },
      });
    }

    const title = newsTitle(node).trim();
    const url = newsUrl(node);
    // Require a news-shaped field. User bios also have `description` plus a url,
    // and those are not headlines.
    const looksLikeNews = node.news || node.news_article || node.thumbnail || node.thumbnail_image
      || node.landingUrl || node.landing_url;
    if (
      looksLikeNews
      && title.length >= 8
      && title.length <= 280
      && /^https?:\/\//.test(url)
      && !url.includes('/status/')
    ) {
      const detail = typeof node.description === 'string'
        ? node.description
        : (node.description?.text || '');
      pushSignal({
        kind: 'news',
        item_key: url,
        title,
        detail,
        url,
        payload: {},
      });
    }
  });

  return { tweets, signals };
}

module.exports = {
  isLiveCaptureUrl,
  operationFromUrl,
  extractLivePayload,
  mergeStoryPayload,
  preferWebUrl,
};
