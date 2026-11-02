/**
 * Extract tweet result data, handling different API response structures
 */
function extractTweetResult(tweetResults) {
  if (!tweetResults?.result) return null;

  const result = tweetResults.result;

  // Handle TweetWithVisibilityResults wrapper
  if (result.__typename === 'TweetWithVisibilityResults') {
    return result.tweet;
  }

  return result;
}

/**
 * Extract user info from core data
 * Returns null if user data is unavailable - we don't want unknown users
 */
function extractUserInfo(userCore) {
  const result = userCore?.user_results?.result;
  if (!result) return null;

  const coreData = result.core || {};
  const legacyData = result.legacy || {};
  const counts = result.relationship_counts || {};

  const screen_name = coreData.screen_name || legacyData.screen_name || result.screen_name;
  const name = coreData.name || legacyData.name || result.name;

  // Skip if we can't identify the user
  if (!screen_name || !name) return null;

  // Relationship data moved to relationship_perspectives in newer API.
  // Follower counts moved to relationship_counts. legacy.followers_count is gone.
  const relationships = result.relationship_perspectives || {};

  return {
    id: result.rest_id,
    screen_name,
    name,
    is_blue_verified: result.is_blue_verified || false,
    description: result.profile_bio?.description || legacyData.description || '',
    followers_count: counts.followers ?? legacyData.followers_count ?? 0,
    following_count: counts.following ?? legacyData.friends_count ?? 0,
    i_follow_user: relationships.following ?? legacyData.following ?? false,
    user_follows_me: relationships.followed_by ?? legacyData.followed_by ?? false,
  };
}

/**
 * Extract tweet text, preferring note_tweet for long-form content
 */
function extractTweetText(legacy, noteTweet) {
  if (noteTweet?.note_tweet_results?.result?.text) {
    return noteTweet.note_tweet_results.result.text;
  }
  return legacy?.full_text || '';
}

/**
 * Extract community info if present
 */
function extractCommunityInfo(tweetResult) {
  const communityResults = tweetResult?.community_results;
  if (!communityResults?.result) return {};

  return {
    id: communityResults.result.id_str,
    name: communityResults.result.name,
  };
}

/**
 * Check if tweet has media
 */
function hasMedia(legacy) {
  return legacy?.entities?.media?.length > 0;
}

/**
 * Parse a Twitter data export JS file (follower.js / following.js)
 * Returns array of { user_id } objects
 */
function parseTwitterExportJS(fileContent, type) {
  const match = fileContent.match(/=\s*(\[[\s\S]*?\]);?\s*$/);
  if (!match) throw new Error('Unexpected export format');
  const entries = JSON.parse(match[1]);
  return entries.map(entry => {
    const inner = entry[type] || entry;
    return { user_id: inner.accountId || inner.id_str };
  }).filter(e => e.user_id);
}

/**
 * Extract social_circle row from Twitter GraphQL Followers/Following entry
 */
function extractFollowerFromGraphQL(entry) {
  const userResult = entry?.content?.itemContent?.user_results?.result;
  if (!userResult) return null;

  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  const screen_name = core.screen_name || legacy.screen_name;
  if (!screen_name) return null;

  return {
    user_id: userResult.rest_id,
    screen_name,
    display_name: core.name || legacy.name || screen_name,
    bio: legacy.description || '',
    followers_count: legacy.followers_count || 0,
    following_count: legacy.friends_count || 0,
  };
}

/**
 * Extract profile data from UserByRestId/UserByScreenName GraphQL response
 */
function extractProfileFromGraphQL(data) {
  const userResult = data?.user?.result;
  if (!userResult) return null;

  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  const screen_name = core.screen_name || legacy.screen_name;
  if (!screen_name) return null;

  return {
    user_id: userResult.rest_id,
    screen_name,
    display_name: core.name || legacy.name || screen_name,
    bio: legacy.description || '',
    followers_count: legacy.followers_count || 0,
    following_count: legacy.friends_count || 0,
    website_url: pickWebsiteUrl(userResult, legacy),
    location: legacy.location || null,
  };
}

// Pull the bio website URL. X stores it under entities.url.urls[0].expanded_url.
// Some shapes also have it on userResult.legacy.url (t.co short link) — prefer
// expanded URL so embeddings get the real domain.
function pickWebsiteUrl(userResult, legacy) {
  const entityUrls = legacy?.entities?.url?.urls;
  if (Array.isArray(entityUrls) && entityUrls.length) {
    const e = entityUrls[0];
    return e.expanded_url || e.url || null;
  }
  return legacy?.url || null;
}

/**
 * Extract prospects (people) from a SearchTimeline instructions tree.
 * SearchTimeline carries both tweet entries and user entries; this picks only
 * `TimelineUser` items. Returns array of prospect-shaped rows ready for upsert
 * into `prospects(platform='x')`.
 */
function extractUsersFromSearchInstructions(instructions) {
  const out = [];
  for (const ins of instructions || []) {
    if (ins.type !== 'TimelineAddEntries') continue;
    for (const entry of ins.entries || []) {
      const c = entry?.content;
      if (!c) continue;
      // Single-item user card.
      if (c.itemContent?.itemType === 'TimelineUser') {
        const row = userFromUserResults(c.itemContent.user_results);
        if (row) out.push(row);
      }
      // Module of users (e.g. "People" carousel).
      if (Array.isArray(c.items)) {
        for (const it of c.items) {
          const ic = it?.item?.itemContent;
          if (ic?.itemType === 'TimelineUser') {
            const row = userFromUserResults(ic.user_results);
            if (row) out.push(row);
          }
        }
      }
    }
  }
  return out;
}

function userFromUserResults(user_results) {
  const r = user_results?.result;
  if (!r) return null;
  const legacy = r.legacy || {};
  const core = r.core || {};
  const screen_name = core.screen_name || legacy.screen_name;
  if (!screen_name) return null;
  return {
    user_id: r.rest_id || null,
    screen_name,
    display_name: core.name || legacy.name || screen_name,
    bio: legacy.description || '',
    followers_count: legacy.followers_count || 0,
    following_count: legacy.friends_count || 0,
    location: legacy.location || null,
    website_url: pickWebsiteUrl(r, legacy),
    is_blue_verified: r.is_blue_verified || false,
  };
}

/**
 * Extract a circle_tweets row from a UserTweets timeline entry
 */
function extractCircleTweet(tweetResults) {
  const tweetData = extractTweetResult(tweetResults);
  if (!tweetData) return null;

  const { legacy, note_tweet, core, views, rest_id } = tweetData;
  if (!legacy || !rest_id) return null;

  const user = extractUserInfo(core);
  if (!user) return null;

  const isRetweet = !!(legacy.retweeted_status_id_str || legacy.full_text?.startsWith('RT @'));

  return {
    id: rest_id,
    screen_name: user.screen_name,
    text: extractTweetText(legacy, note_tweet),
    created_at: legacy.created_at,
    in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
    reply_count: legacy.reply_count || 0,
    like_count: legacy.favorite_count || 0,
    retweet_count: legacy.retweet_count || 0,
    quote_count: legacy.quote_count || 0,
    view_count: parseInt(views?.count || '0') || 0,
    is_retweet: isRetweet,
    raw_data: { rest_id, legacy },
  };
}

module.exports = {
  extractTweetResult,
  extractUserInfo,
  extractTweetText,
  extractCommunityInfo,
  hasMedia,
  parseTwitterExportJS,
  extractFollowerFromGraphQL,
  extractProfileFromGraphQL,
  extractCircleTweet,
  extractUsersFromSearchInstructions,
  pickWebsiteUrl,
};
