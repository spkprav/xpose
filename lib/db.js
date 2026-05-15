const { Pool } = require('pg');

let pool = null;
let config = {
  host:     'localhost',
  user:     'postgres',
  password: 'postgres',
  database: 'xpose',
  port:     54329,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
};

/**
 * Configure the DB connection. Call from main.js after Settings loads.
 * Re-calling closes the existing pool so next getPool() reopens with new config.
 */
function configure(userConfig = {}) {
  const { connectionTimeoutMillis, statement_timeout, ...persist } = config;
  config = { connectionTimeoutMillis, statement_timeout, ...persist, ...userConfig };
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
}

function getPool() {
  if (!pool) {
    pool = new Pool(config);
  }
  return pool;
}

/**
 * Save a tweet to the database
 */
async function saveTweet(tweet, sourceUrl = null) {
  const db = getPool();
  const { user, tweet: tweetData } = tweet;

  const query = `
    INSERT INTO tweets (
      id, user_id, user_screen_name, user_name, user_followers_count, user_following_count,
      user_is_blue_verified, user_follows_me, i_follow_user,
      text, created_at,
      reply_count, retweet_count, like_count, quote_count, view_count, bookmark_count,
      source, source_url, raw_data
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
    )
    ON CONFLICT (id) DO UPDATE SET
      user_id = COALESCE(EXCLUDED.user_id, tweets.user_id),
      user_followers_count = EXCLUDED.user_followers_count,
      user_following_count = EXCLUDED.user_following_count,
      user_follows_me = EXCLUDED.user_follows_me,
      i_follow_user = EXCLUDED.i_follow_user,
      reply_count = EXCLUDED.reply_count,
      retweet_count = EXCLUDED.retweet_count,
      like_count = EXCLUDED.like_count,
      quote_count = EXCLUDED.quote_count,
      view_count = EXCLUDED.view_count,
      bookmark_count = EXCLUDED.bookmark_count
    RETURNING id
  `;

  const values = [
    tweetData.id,
    user.id || null,
    user.screen_name,
    user.name,
    user.followers_count || 0,
    user.following_count || 0,
    user.is_blue_verified || false,
    user.user_follows_me || false,
    user.i_follow_user || false,
    tweetData.text,
    tweetData.created_at ? new Date(tweetData.created_at) : null,
    tweetData.reply_count || 0,
    tweetData.retweet_count || 0,
    tweetData.favorites_count || 0,
    tweetData.quote_count || 0,
    parseInt(tweetData.views) || 0,
    tweetData.bookmark_count || 0,
    tweet.source || null,
    sourceUrl,
    JSON.stringify(tweet),
  ];

  const result = await db.query(query, values);
  return result.rows[0]?.id;
}

/**
 * Save tweet analysis to the database
 */
async function saveAnalysis(tweetId, analysis, icpCriteria, llmProvider, llmModel) {
  const db = getPool();

  const query = `
    INSERT INTO tweet_analysis (
      tweet_id, is_relevant, engagement_type, suggested_content, score,
      icp_criteria, llm_provider, llm_model
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (tweet_id, icp_criteria) DO UPDATE SET
      is_relevant = EXCLUDED.is_relevant,
      engagement_type = EXCLUDED.engagement_type,
      suggested_content = EXCLUDED.suggested_content,
      score = EXCLUDED.score,
      analyzed_at = CURRENT_TIMESTAMP
    RETURNING id
  `;

  const values = [
    tweetId,
    analysis.relevant || false,
    analysis.engagementType || null,
    analysis.suggestedContent || null,
    analysis.score || 0,
    icpCriteria,
    llmProvider,
    llmModel,
  ];

  const result = await db.query(query, values);
  return result.rows[0]?.id;
}

/**
 * Check if a tweet already exists in the database
 */
async function tweetExists(tweetId) {
  const db = getPool();
  const result = await db.query('SELECT id FROM tweets WHERE id = $1', [tweetId]);
  return result.rows.length > 0;
}

/**
 * Get tweet IDs that already exist from a list
 */
async function getExistingTweetIds(tweetIds) {
  if (!tweetIds.length) return new Set();
  const db = getPool();
  const result = await db.query(
    'SELECT id FROM tweets WHERE id = ANY($1)',
    [tweetIds]
  );
  return new Set(result.rows.map(r => r.id.toString()));
}

/**
 * Save multiple tweets in a batch
 */
async function saveTweetsBatch(tweets, sourceUrl = null) {
  const saved = [];
  const errors = [];

  for (const tweet of tweets) {
    try {
      const id = await saveTweet(tweet, sourceUrl);
      saved.push(id);
    } catch (err) {
      errors.push({ tweet: tweet.id, error: err.message });
    }
  }

  return { saved, errors };
}

/**
 * Test database connection
 */
async function testConnection() {
  const db = getPool();
  const result = await db.query('SELECT NOW()');
  return result.rows[0];
}

/**
 * Load engagement opportunities from DB
 * @param {boolean} iFollowing - If true, only show users I follow. If false, only show users I don't follow.
 */
async function loadEngagementOpportunities(iFollowing = false) {
  const db = getPool();
  const query = `
    SELECT * FROM engagement_opportunities
    WHERE i_follow_user = $1
    ORDER BY engagement_score DESC
    LIMIT 100
  `;
  const result = await db.query(query, [iFollowing]);
  return result.rows;
}

/**
 * Save a tweet action (done, hidden, etc.)
 */
async function saveTweetAction(tweetId, actionType, actionContent = null) {
  const db = getPool();
  const query = `
    INSERT INTO tweet_actions (tweet_id, action_type, action_content)
    VALUES ($1, $2, $3)
    ON CONFLICT (tweet_id, action_type) DO UPDATE SET
      action_content = EXCLUDED.action_content,
      action_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  const result = await db.query(query, [tweetId, actionType, actionContent]);
  return result.rows[0]?.id;
}

/**
 * Block a user (never show their tweets)
 */
async function blockUser(screenName, userName = null) {
  const db = getPool();
  const query = `
    INSERT INTO user_preferences (user_screen_name, user_name, is_blocked)
    VALUES ($1, $2, TRUE)
    ON CONFLICT (user_screen_name) DO UPDATE SET
      is_blocked = TRUE,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  const result = await db.query(query, [screenName, userName]);
  return result.rows[0]?.id;
}

/**
 * Unblock a user
 */
async function unblockUser(screenName) {
  const db = getPool();
  const query = `
    UPDATE user_preferences
    SET is_blocked = FALSE, updated_at = CURRENT_TIMESTAMP
    WHERE user_screen_name = $1
    RETURNING id
  `;
  const result = await db.query(query, [screenName]);
  return result.rows[0]?.id;
}

/**
 * Boost a user's score by adding points
 */
async function boostUser(screenName, userName = null, points = 10) {
  const db = getPool();
  const query = `
    INSERT INTO user_preferences (user_screen_name, user_name, boost_points)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_screen_name) DO UPDATE SET
      boost_points = user_preferences.boost_points + $3,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, boost_points
  `;
  const result = await db.query(query, [screenName, userName, points]);
  return result.rows[0];
}

/**
 * Get user preference
 */
async function getUserPreference(screenName) {
  const db = getPool();
  const query = 'SELECT * FROM user_preferences WHERE user_screen_name = $1';
  const result = await db.query(query, [screenName]);
  return result.rows[0];
}

/**
 * Get all blocked users
 */
async function getBlockedUsers() {
  const db = getPool();
  const query = 'SELECT * FROM user_preferences WHERE is_blocked = TRUE ORDER BY updated_at DESC';
  const result = await db.query(query);
  return result.rows;
}

// ============================================================================
// SOCIAL CIRCLE
// ============================================================================

async function upsertSocialCircle(data) {
  const db = getPool();
  const priority = { mutual: 3, following: 2, follower: 1, '2nd_degree': 0 }[data.relationship] ?? 0;

  if (data.screen_name) {
    const isFollower = data.relationship === 'follower' || data.relationship === 'mutual';
    const isFollowing = data.relationship === 'following' || data.relationship === 'mutual';
    const result = await db.query(`
      INSERT INTO social_circle (user_id, screen_name, display_name, bio, followers_count, following_count,
        is_follower, is_following, relationship, crawl_priority, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $7 AND $8 THEN 'mutual' WHEN $7 THEN 'follower' WHEN $8 THEN 'following' ELSE '2nd_degree' END,
        $9, CURRENT_TIMESTAMP)
      ON CONFLICT (screen_name) DO UPDATE SET
        user_id = COALESCE(EXCLUDED.user_id, social_circle.user_id),
        display_name = COALESCE(EXCLUDED.display_name, social_circle.display_name),
        bio = COALESCE(EXCLUDED.bio, social_circle.bio),
        followers_count = CASE WHEN EXCLUDED.followers_count > 0 THEN EXCLUDED.followers_count ELSE social_circle.followers_count END,
        following_count = CASE WHEN EXCLUDED.following_count > 0 THEN EXCLUDED.following_count ELSE social_circle.following_count END,
        is_follower  = social_circle.is_follower  OR EXCLUDED.is_follower,
        is_following = social_circle.is_following OR EXCLUDED.is_following,
        relationship = CASE
          WHEN (social_circle.is_follower OR EXCLUDED.is_follower) AND (social_circle.is_following OR EXCLUDED.is_following) THEN 'mutual'
          WHEN (social_circle.is_follower OR EXCLUDED.is_follower) THEN 'follower'
          WHEN (social_circle.is_following OR EXCLUDED.is_following) THEN 'following'
          ELSE social_circle.relationship END,
        crawl_priority = GREATEST(EXCLUDED.crawl_priority, social_circle.crawl_priority),
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [
      data.user_id || null, data.screen_name, data.display_name || null, data.bio || null,
      data.followers_count || 0, data.following_count || 0, isFollower, isFollowing, priority,
    ]);
    return result.rows[0]?.id;
  } else if (data.user_id) {
    // Upsert by user_id only (no screen_name yet)
    const result = await db.query(`
      INSERT INTO social_circle (user_id, relationship, crawl_priority, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE SET
        relationship = EXCLUDED.relationship,
        crawl_priority = GREATEST(EXCLUDED.crawl_priority, social_circle.crawl_priority),
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [data.user_id, data.relationship, priority]);
    return result.rows[0]?.id;
  }
}

async function markMutuals() {
  const db = getPool();
  await db.query(`
    UPDATE social_circle
    SET relationship = 'mutual', crawl_priority = 3, updated_at = CURRENT_TIMESTAMP
    WHERE is_follower = TRUE AND is_following = TRUE AND relationship != 'mutual'
  `);
}

async function getSocialCircle(relationship = null) {
  const db = getPool();
  const query = relationship
    ? 'SELECT * FROM social_circle WHERE relationship = $1 ORDER BY crawl_priority DESC, screen_name'
    : 'SELECT * FROM social_circle ORDER BY crawl_priority DESC, screen_name';
  const result = relationship ? await db.query(query, [relationship]) : await db.query(query);
  return result.rows;
}

async function getSocialCircleStats() {
  const db = getPool();
  const result = await db.query(`
    SELECT relationship, COUNT(*) as count,
           COUNT(*) FILTER (WHERE last_crawled_at IS NOT NULL) as crawled,
           COUNT(*) FILTER (WHERE screen_name IS NULL) as needs_enrichment
    FROM social_circle GROUP BY relationship ORDER BY relationship
  `);
  return result.rows;
}

async function updateSocialCircleCrawled(screenName) {
  const db = getPool();
  await db.query(
    'UPDATE social_circle SET last_crawled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE screen_name = $1',
    [screenName]
  );
}

// ============================================================================
// CIRCLE TWEETS
// ============================================================================

async function upsertCircleTweet(data) {
  const db = getPool();
  const query = `
    INSERT INTO circle_tweets (id, screen_name, text, created_at, in_reply_to_screen_name,
      reply_count, like_count, retweet_count, quote_count, view_count, is_retweet, raw_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  const result = await db.query(query, [
    data.id,
    data.screen_name,
    data.text,
    data.created_at ? new Date(data.created_at) : null,
    data.in_reply_to_screen_name || null,
    data.reply_count || 0,
    data.like_count || 0,
    data.retweet_count || 0,
    data.quote_count || 0,
    data.view_count || 0,
    data.is_retweet || false,
    data.raw_data ? JSON.stringify(data.raw_data) : null,
  ]);
  return result.rows[0]?.id;
}

async function upsertCircleTweetsBatch(tweets) {
  const saved = [], errors = [];
  for (const t of tweets) {
    try {
      const id = await upsertCircleTweet(t);
      if (id) saved.push(id);
    } catch (err) {
      errors.push({ id: t.id, error: err.message });
    }
  }
  return { saved, errors };
}

async function recordTweetSources(tweetIds, sourceList) {
  if (!tweetIds.length || !sourceList) return 0;
  const db = getPool();
  const placeholders = tweetIds.map((_, i) => `($${i + 1}, $${tweetIds.length + 1})`).join(',');
  const params = [...tweetIds, sourceList];
  const result = await db.query(
    `INSERT INTO circle_tweet_sources (tweet_id, source_list) VALUES ${placeholders}
     ON CONFLICT (tweet_id, source_list) DO UPDATE SET captured_at = CURRENT_TIMESTAMP`,
    params
  );
  return result.rowCount;
}

/**
 * Upsert tweets AND record their list provenance.
 * Records sources for every supplied tweet, even those that already existed
 * (ON CONFLICT DO NOTHING means upsertCircleTweet returns null for dupes).
 */
async function upsertCircleTweetsBatchWithSource(tweets, sourceList) {
  const result = await upsertCircleTweetsBatch(tweets);
  const allIds = tweets.map(t => t.id).filter(Boolean);
  const sourced = await recordTweetSources(allIds, sourceList);
  return { ...result, sourced };
}

async function getListCrawlStats(slug, daysBack = 7) {
  const db = getPool();
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE captured_at > NOW() - INTERVAL '1 day')::int AS today,
      COUNT(*) FILTER (WHERE captured_at > NOW() - ($2 * INTERVAL '1 day'))::int AS recent,
      MAX(captured_at) AS last_capture
    FROM circle_tweet_sources
    WHERE source_list = $1
  `, [slug, daysBack]);
  return result.rows[0];
}

async function getTopCircleTweets(limit = 15, daysBack = 7) {
  const db = getPool();
  const result = await db.query(`
    SELECT ct.*, sc.relationship, sc.followers_count AS author_followers
    FROM circle_tweets ct
    LEFT JOIN social_circle sc ON ct.screen_name = sc.screen_name
    WHERE ct.created_at > NOW() - ($2 * INTERVAL '1 day')
      AND ct.is_retweet = FALSE
    ORDER BY (ct.like_count + ct.retweet_count * 2 + ct.quote_count * 3) DESC
    LIMIT $1
  `, [limit, daysBack]);
  return result.rows;
}

async function getCircleActivity(daysBack = 7) {
  const db = getPool();
  const result = await db.query(`
    SELECT screen_name,
           COUNT(*) as tweet_count,
           SUM(like_count) as total_likes,
           SUM(retweet_count) as total_retweets,
           MAX(created_at) as last_tweet_at
    FROM circle_tweets
    WHERE created_at > NOW() - ($1 * INTERVAL '1 day')
      AND is_retweet = FALSE
    GROUP BY screen_name
    ORDER BY tweet_count DESC
    LIMIT 20
  `, [daysBack]);
  return result.rows;
}

async function getCircleFeed({ relationship = 'all', days = 7, sort = 'engagement', limit = 50 } = {}) {
  const db = getPool();
  const orderBy = sort === 'recent'
    ? 'ct.created_at DESC'
    : '(ct.like_count + ct.retweet_count * 2 + ct.quote_count * 3) DESC';
  const relFilter = relationship === 'all'
    ? ''
    : `AND sc.relationship = '${relationship.replace(/'/g, "''")}'`;
  const result = await db.query(`
    SELECT ct.id, ct.screen_name, ct.text, ct.created_at,
           ct.like_count, ct.retweet_count, ct.reply_count, ct.quote_count, ct.view_count,
           sc.relationship, sc.followers_count
    FROM circle_tweets ct
    JOIN social_circle sc ON ct.screen_name = sc.screen_name
    WHERE ct.created_at > NOW() - ($1 * INTERVAL '1 day')
      AND ct.is_retweet = FALSE
      ${relFilter}
    ORDER BY ${orderBy}
    LIMIT $2
  `, [days, limit]);
  return result.rows;
}

async function get2ndDegreeCandidates() {
  const db = getPool();
  const result = await db.query('SELECT * FROM second_degree_candidates LIMIT 50');
  return result.rows;
}

// ============================================================================
// CRAWL JOBS
// ============================================================================

async function insertCrawlJob(data) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO crawl_jobs (job_type, target_screen_name, target_user_id, status)
    VALUES ($1, $2, $3, 'pending')
    RETURNING id
  `, [data.job_type, data.target_screen_name || null, data.target_user_id || null]);
  return result.rows[0]?.id;
}

async function clearPendingCrawlJobs(jobType = 'user_tweets') {
  const db = getPool();
  const result = await db.query(
    `DELETE FROM crawl_jobs WHERE status = 'pending' AND job_type = $1`,
    [jobType]
  );
  return result.rowCount;
}

async function insertCrawlJobsBulk(jobs) {
  if (!jobs.length) return 0;
  const db = getPool();
  const CHUNK = 500; // postgres parameter limit ~65535, 3 params per row
  let total = 0;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((j, idx) => {
      const base = idx * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, 'pending')`);
      params.push(j.job_type, j.target_screen_name || null, j.target_user_id || null);
    });
    const result = await db.query(
      `INSERT INTO crawl_jobs (job_type, target_screen_name, target_user_id, status) VALUES ${values.join(',')} RETURNING id`,
      params
    );
    total += result.rows.length;
  }
  return total;
}

async function updateCrawlJob(id, status, extras = {}) {
  const db = getPool();
  const sets = ['status = $2', 'updated_at_ts = CURRENT_TIMESTAMP'];
  const vals = [id, status];
  let i = 3;
  if (status === 'running') { sets.push(`started_at = CURRENT_TIMESTAMP`); }
  if (status === 'done' || status === 'failed') { sets.push(`completed_at = CURRENT_TIMESTAMP`); }
  if (extras.tweets_collected != null) { sets.push(`tweets_collected = $${i++}`); vals.push(extras.tweets_collected); }
  if (extras.pages_fetched != null) { sets.push(`pages_fetched = $${i++}`); vals.push(extras.pages_fetched); }
  if (extras.error_message) { sets.push(`error_message = $${i++}`); vals.push(extras.error_message); }

  // Build without the fake updated_at_ts column
  const setClauses = sets.filter(s => !s.includes('updated_at_ts')).join(', ');
  await db.query(`UPDATE crawl_jobs SET ${setClauses} WHERE id = $1`, vals);
}

async function getPendingCrawlJobs(limit = 50) {
  const db = getPool();
  const result = await db.query(`
    SELECT cj.*, sc.crawl_priority
    FROM crawl_jobs cj
    LEFT JOIN social_circle sc ON cj.target_screen_name = sc.screen_name
    WHERE cj.status = 'pending'
    ORDER BY COALESCE(sc.crawl_priority, 0) DESC, cj.created_at ASC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

async function getCrawlStats() {
  const db = getPool();
  const result = await db.query(`
    SELECT status, COUNT(*) as count FROM crawl_jobs GROUP BY status
  `);
  return result.rows;
}

async function resetStaleCrawlJobs() {
  const db = getPool();
  await db.query(`
    UPDATE crawl_jobs SET status = 'pending', started_at = NULL
    WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes'
  `);
}

// Called on app boot: every job in 'running' state is from a crashed prior session.
async function resetAllRunningOnBoot() {
  const db = getPool();
  const result = await db.query(`
    UPDATE crawl_jobs SET status = 'pending', started_at = NULL
    WHERE status = 'running'
  `);
  return result.rowCount;
}

// Returns screen_names matching strict-priority filter for deep crawl:
//  - relationship != '2nd_degree'
//  - replied to others at least once in last 7 days
//  - earliest tweet in DB is AFTER the date_cutoff (gap to fill)
async function getStrictPriorityTargets({ dateCutoff = '2026-03-01', recentDays = 7 } = {}) {
  const db = getPool();
  const result = await db.query(`
    WITH stats AS (
      SELECT screen_name,
        COUNT(*) FILTER (WHERE in_reply_to_screen_name IS NOT NULL
                           AND in_reply_to_screen_name != screen_name
                           AND NOT is_retweet
                           AND created_at >= NOW() - ($2 || ' days')::INTERVAL) AS replies_recent,
        MIN(created_at) AS first_at
      FROM circle_tweets GROUP BY screen_name
    )
    SELECT sc.screen_name, sc.relationship, sc.followers_count,
           s.replies_recent, s.first_at
    FROM social_circle sc
    JOIN stats s ON s.screen_name = sc.screen_name
    WHERE sc.relationship != '2nd_degree'
      AND s.replies_recent >= 1
      AND s.first_at > $1::timestamp
    ORDER BY s.replies_recent DESC, sc.followers_count DESC
  `, [dateCutoff, String(recentDays)]);
  return result.rows;
}

// Bulk enqueue deep-crawl jobs for a list of screen_names. Skips duplicates
// already in 'pending' state. Returns count inserted.
async function enqueueDeepCrawlForScreenNames(screenNames) {
  if (!screenNames?.length) return 0;
  const db = getPool();
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < screenNames.length; i += CHUNK) {
    const chunk = screenNames.slice(i, i + CHUNK);
    const values = chunk.map((_, idx) => `('user_tweets_deep', $${idx + 1}, 'pending')`).join(',');
    const result = await db.query(
      `INSERT INTO crawl_jobs (job_type, target_screen_name, status) VALUES ${values}
       RETURNING id`,
      chunk
    );
    total += result.rows.length;
  }
  return total;
}

async function clearPendingDeepJobs() {
  const db = getPool();
  const r = await db.query(`DELETE FROM crawl_jobs WHERE status = 'pending' AND job_type = 'user_tweets_deep'`);
  return r.rowCount;
}

// ============================================================================
// DRAFTS
// ============================================================================

async function insertDraft(data) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO drafts (draft_text, context_summary, based_on_circle_tweets, based_on_wiki_pages, suggested_post_time)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [
    data.draft_text,
    data.context_summary || null,
    data.based_on_circle_tweets ? JSON.stringify(data.based_on_circle_tweets) : null,
    data.based_on_wiki_pages ? JSON.stringify(data.based_on_wiki_pages) : null,
    data.suggested_post_time || null,
  ]);
  return result.rows[0]?.id;
}

async function updateDraft(id, data) {
  const db = getPool();
  const fields = [];
  const vals = [id];
  let i = 2;
  if (data.draft_text != null) { fields.push(`draft_text = $${i++}`); vals.push(data.draft_text); }
  if (data.status != null) { fields.push(`status = $${i++}`); vals.push(data.status); }
  if (data.posted_at != null) { fields.push(`posted_at = $${i++}`); vals.push(data.posted_at); }
  if (!fields.length) return;
  await db.query(`UPDATE drafts SET ${fields.join(', ')} WHERE id = $1`, vals);
}

async function getDrafts(status = null) {
  const db = getPool();
  const query = status
    ? 'SELECT * FROM drafts WHERE status = $1 ORDER BY created_at DESC'
    : "SELECT * FROM drafts WHERE status != 'discarded' ORDER BY created_at DESC LIMIT 50";
  const result = status ? await db.query(query, [status]) : await db.query(query);
  return result.rows;
}

module.exports = {
  configure,
  getPool,
  saveTweet,
  saveAnalysis,
  tweetExists,
  getExistingTweetIds,
  saveTweetsBatch,
  testConnection,
  loadEngagementOpportunities,
  saveTweetAction,
  blockUser,
  unblockUser,
  boostUser,
  getUserPreference,
  getBlockedUsers,
  // Social circle
  upsertSocialCircle,
  markMutuals,
  getSocialCircle,
  getSocialCircleStats,
  updateSocialCircleCrawled,
  // Circle tweets
  upsertCircleTweet,
  upsertCircleTweetsBatch,
  upsertCircleTweetsBatchWithSource,
  recordTweetSources,
  getListCrawlStats,
  getTopCircleTweets,
  getCircleActivity,
  getCircleFeed,
  get2ndDegreeCandidates,
  // Crawl jobs
  insertCrawlJob,
  insertCrawlJobsBulk,
  clearPendingCrawlJobs,
  updateCrawlJob,
  getPendingCrawlJobs,
  getCrawlStats,
  resetStaleCrawlJobs,
  resetAllRunningOnBoot,
  getStrictPriorityTargets,
  enqueueDeepCrawlForScreenNames,
  clearPendingDeepJobs,
  // Drafts
  insertDraft,
  updateDraft,
  getDrafts,
};
