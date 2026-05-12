// Entry paths for different timeline sources
const ENTRY_PATHS = {
  'for-you': (data) => data.home?.home_timeline_urt?.instructions,
  'following': (data) => data.home?.home_timeline_urt?.instructions,
  'list': (data) => data.list?.tweets_timeline?.timeline?.instructions,
  'search': (data) => data.search_by_raw_query?.search_timeline?.timeline?.instructions,
  'user-tweets': (data) => data.user?.result?.timeline_v2?.timeline?.instructions,
  'user-likes': (data) => data.user?.result?.timeline_v2?.timeline?.instructions,
  'user-tweets-replies': (data) => data.user?.result?.timeline_v2?.timeline?.instructions,
  'community-tweets': (data) => data.communityResults?.result?.ranked_community_timeline?.timeline?.instructions,
};

// Entry IDs to skip (ads, promotions, etc.)
const SKIP_PATTERNS = [
  'community',
  'promotion',
  'pinned-tweets',
  'who-to-follow',
];

// Endpoints intercepted on the crawl BrowserView
const CRAWL_ENDPOINTS = [
  '/UserTweetsAndReplies',
  '/UserTweets',
  '/Followers',
  '/Following',
  '/UserByRestId',
  '/UserByScreenName',
];

// Response data paths for crawl endpoints
// Twitter uses multiple response shapes. try all known paths
function resolveListInstructions(data) {
  return data.followers_timeline?.timeline?.instructions
    || data.following_timeline?.timeline?.instructions
    || data.user?.result?.timeline?.timeline?.instructions
    || data.user?.result?.timeline_v2?.timeline?.instructions
    || null;
}

const CRAWL_ENTRY_PATHS = {
  'UserTweetsAndReplies': (data) => data.user?.result?.timeline_v2?.timeline?.instructions
    || data.user?.result?.timeline?.timeline?.instructions,
  'UserTweets': (data) => data.user?.result?.timeline_v2?.timeline?.instructions
    || data.user?.result?.timeline?.timeline?.instructions,
  'Followers':  resolveListInstructions,
  'Following':  resolveListInstructions,
};

module.exports = {
  ENTRY_PATHS,
  SKIP_PATTERNS,
  CRAWL_ENDPOINTS,
  CRAWL_ENTRY_PATHS,
};
