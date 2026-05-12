const { extractTweetResult, extractUserInfo, extractTweetText, extractCommunityInfo, hasMedia } = require('./extractors');

/**
 * Transform raw tweet data into our standard format
 */
function transformTweet(tweetResults, source, parentId = null) {
  const tweetData = extractTweetResult(tweetResults);
  if (!tweetData) return null;

  const { legacy, note_tweet, core, views, rest_id } = tweetData;
  if (!legacy) return null;

  const user = extractUserInfo(core);
  if (!user) return null;  // Skip tweets with unknown users

  const tweet = {
    id: rest_id,
    key: rest_id,
    source,
    user,
    tweet: {
      created_at: legacy.created_at,
      id: rest_id,
      bookmark_count: legacy.bookmark_count || 0,
      favorites_count: legacy.favorite_count || 0,
      lang: legacy.lang,
      quote_count: legacy.quote_count || 0,
      reply_count: legacy.reply_count || 0,
      retweet_count: legacy.retweet_count || 0,
      text: extractTweetText(legacy, note_tweet),
      views: views?.count || '0',
      media: null,
      media_exists: hasMedia(legacy),
    },
    communityInfo: extractCommunityInfo(tweetData),
  };

  if (parentId) {
    tweet.parent_id = parentId;
  }

  return tweet;
}

/**
 * Transform a conversation (tweet with replies)
 */
function transformConversation(items, source) {
  if (!items?.length) return null;

  const [originalItem, ...replyItems] = items;

  // Transform the original tweet
  const originalResults = originalItem?.item?.itemContent?.tweet_results;
  if (!originalResults) return null;

  const originalTweet = transformTweet(originalResults, source);
  if (!originalTweet) return null;

  // Transform replies
  const replies = replyItems
    .map(replyItem => {
      const replyResults = replyItem?.item?.itemContent?.tweet_results;
      return transformTweet(replyResults, source, originalTweet.id);
    })
    .filter(Boolean);

  originalTweet.replies = replies;
  return originalTweet;
}

/**
 * Transform a single tweet entry
 */
function transformSingleTweet(itemContent, source) {
  const tweetResults = itemContent?.tweet_results;
  if (!tweetResults) return null;

  const tweet = transformTweet(tweetResults, source);
  if (tweet) {
    tweet.replies = [];
  }
  return tweet;
}

module.exports = {
  transformTweet,
  transformConversation,
  transformSingleTweet,
};
