const { transformTweet } = require('../twitter/transformers');

// Entry ids X uses for the right-rail and connect modules. Plain `user-123`
// timeline rows are only taken when the sweep is actually on the who-to-follow page.
const SUGGESTION_ENTRY = /who-?to-?follow|whotofollow|connect|recommend|similar|sidebar-user|userrec/i;

function isLiveCaptureUrl(url) {
  if (!url) return false;
  return url.includes('/i/api/graphql/')
    || url.includes('/i/api/2/guide')
    || url.includes('guide.json');
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

function userFromResult(userResult) {
  if (!userResult || userResult.__typename === 'UserUnavailable') return null;
  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  const screenName = core.screen_name || legacy.screen_name;
  if (!screenName) return null;
  return {
    kind: 'who_to_follow',
    item_key: screenName.toLowerCase(),
    title: screenName,
    detail: core.name || legacy.name || '',
    url: `https://x.com/${screenName}`,
    payload: {
      user_id: userResult.rest_id || null,
      display_name: core.name || legacy.name || null,
      bio: legacy.description || '',
      followers_count: legacy.followers_count || 0,
      following_count: legacy.friends_count || 0,
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
  const seenSignals = new Set();

  function pushSignal(signal) {
    if (!signal?.item_key || !signal.kind) return;
    const key = `${signal.kind}:${signal.item_key}`;
    if (seenSignals.has(key)) return;
    seenSignals.add(key);
    signals.push(signal);
  }

  walk(root, (node) => {
    if (node.tweet_results?.result) {
      const tweet = transformTweet(node.tweet_results, 'live');
      const id = tweet?.tweet?.id;
      const text = tweet?.tweet?.text;
      if (tweet && id && text && !seenTweets.has(String(id))) {
        seenTweets.add(String(id));
        tweets.push(tweet);
      }
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
  extractLivePayload,
};
