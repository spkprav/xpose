const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ENV_FILE = path.resolve(__dirname, '..', '.env');

let pool = null;
let reported = null;
let config = {
  host:     'localhost',
  user:     'postgres',
  password: 'postgres',
  database: 'xpose',
  port:     5432,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
};

function readNeonUrl() {
  const fromProcess = (process.env.NEON_DB_URL || '').trim();
  if (fromProcess) return fromProcess;
  let text = '';
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('NEON_DB_URL=')) continue;
    let value = trimmed.slice('NEON_DB_URL='.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return '';
}

function describeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('NEON_DB_URL is not a postgres url');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) {
    throw new Error('NEON_DB_URL is missing the host or database');
  }
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database,
  };
}

/**
 * Configure the DB connection. Call from main.js after Settings loads.
 * When NEON_DB_URL is set, that database is used and the Settings host is ignored.
 * Re-calling closes the existing pool so next getPool() reopens with new config.
 */
function configure(userConfig = {}) {
  const neonUrl = readNeonUrl();
  if (neonUrl) {
    reported = describeUrl(neonUrl);
    config = {
      connectionString: neonUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20000,
      statement_timeout: 20000,
    };
  } else {
    reported = null;
    const { connectionString, ssl, connectionTimeoutMillis, statement_timeout, ...persist } = config;
    config = { connectionTimeoutMillis, statement_timeout, ...persist, ...userConfig };
  }
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

function getConfig() {
  if (reported) {
    return {
      host: reported.host,
      port: reported.port,
      user: reported.user,
      password: reported.password,
      database: reported.database,
    };
  }
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  };
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

/**
 * Feed of tweets captured from X-lists.
 * @param {object} opts
 * @param {string} opts.slug   'all' or a list slug (anchors|venues|mutuals-rising|high-velocity-replies|growth-study)
 * @param {number} opts.limit  max rows (default 100)
 * @param {boolean} opts.includeActioned  if false (default), hide tweets that have any non-null action
 */
// Lists whose tweets ARE reply targets. growth-study + anchors are study-only,
// not for replying — see social-wiki/connections/lists.md.
const REPLY_TARGET_LISTS = ['venues', 'mutuals-rising', 'high-velocity-replies'];

async function getListFeed({ slug = 'all', limit = 100, includeActioned = false } = {}) {
  const db = getPool();
  const params = [limit];
  let slugFilter = '';
  if (slug && slug !== 'all') {
    params.push(slug);
    slugFilter = `AND EXISTS (SELECT 1 FROM circle_tweet_sources s2 WHERE s2.tweet_id = ct.id AND s2.source_list = $${params.length})`;
  } else {
    // 'all' = only reply-target lists (study-only lists hidden from reply feed)
    params.push(REPLY_TARGET_LISTS);
    slugFilter = `AND EXISTS (SELECT 1 FROM circle_tweet_sources s2 WHERE s2.tweet_id = ct.id AND s2.source_list = ANY($${params.length}::text[]))`;
  }
  const actionedFilter = includeActioned ? '' : `
    AND NOT EXISTS (
      SELECT 1 FROM circle_tweet_actions a
      WHERE a.tweet_id = ct.id
        AND a.action_type IN ('replied','skipped','hidden','done')
    )`;
  const result = await db.query(`
    SELECT
      ct.id, ct.screen_name, ct.text, ct.created_at,
      ct.like_count, ct.retweet_count, ct.reply_count, ct.quote_count, ct.view_count,
      ct.is_retweet,
      (
        SELECT ARRAY_AGG(DISTINCT s.source_list ORDER BY s.source_list)
        FROM circle_tweet_sources s
        WHERE s.tweet_id = ct.id
      ) AS source_lists,
      (
        SELECT action_type FROM circle_tweet_actions
        WHERE tweet_id = ct.id ORDER BY action_at DESC LIMIT 1
      ) AS last_action,
      sc.followers_count, sc.relationship
    FROM circle_tweets ct
    LEFT JOIN social_circle sc ON ct.screen_name = sc.screen_name
    WHERE ct.is_retweet = FALSE
      AND ct.in_reply_to_screen_name IS NULL
      AND length(trim(regexp_replace(ct.text, 'https?://t\.co/\w+', '', 'g'))) > 0
      AND EXISTS (SELECT 1 FROM circle_tweet_sources s WHERE s.tweet_id = ct.id)
      ${slugFilter}
      ${actionedFilter}
    ORDER BY ct.created_at DESC NULLS LAST
    LIMIT $1
  `, params);
  return result.rows;
}

async function recordCircleTweetAction(tweetId, actionType, actionContent = null) {
  const db = getPool();
  const result = await db.query(`
    INSERT INTO circle_tweet_actions (tweet_id, action_type, action_content)
    VALUES ($1, $2, $3)
    ON CONFLICT (tweet_id, action_type) DO UPDATE
      SET action_at = CURRENT_TIMESTAMP, action_content = EXCLUDED.action_content
    RETURNING id
  `, [tweetId, actionType, actionContent]);
  return result.rows[0]?.id;
}

/**
 * Scored feed view. Joins list_tweet_scores; sort by total DESC then created_at DESC.
 * @param {object} opts
 * @param {string} opts.slug             'all' or list slug
 * @param {number} opts.hoursWindow      hours back from NOW (default 3)
 * @param {number} opts.limit            max rows (default 200)
 * @param {boolean} opts.includeActioned default false
 */
async function getListFeedScored({ slug = 'all', hoursWindow = 3, limit = 200, includeActioned = false } = {}) {
  const db = getPool();
  const params = [limit, hoursWindow];
  let slugFilter = '';
  if (slug && slug !== 'all') {
    params.push(slug);
    slugFilter = `AND EXISTS (SELECT 1 FROM circle_tweet_sources s2 WHERE s2.tweet_id = ct.id AND s2.source_list = $${params.length})`;
  } else {
    params.push(REPLY_TARGET_LISTS);
    slugFilter = `AND EXISTS (SELECT 1 FROM circle_tweet_sources s2 WHERE s2.tweet_id = ct.id AND s2.source_list = ANY($${params.length}::text[]))`;
  }
  const actionedFilter = includeActioned ? '' : `
    AND NOT EXISTS (
      SELECT 1 FROM circle_tweet_actions a
      WHERE a.tweet_id = ct.id
        AND a.action_type IN ('replied','skipped','hidden','done')
    )`;
  // Exclude people already replied to today (calendar day, UTC midnight boundary).
  const repliedTodayFilter = `
    AND NOT EXISTS (
      SELECT 1 FROM circle_tweet_actions a_today
      JOIN circle_tweets ct_today ON ct_today.id = a_today.tweet_id
      WHERE ct_today.screen_name = ct.screen_name
        AND a_today.action_type = 'replied'
        AND a_today.action_at >= date_trunc('day', NOW())
    )`;
  // Exclude mutual-rising people who are also growth-study, unless they're anchors.
  const growthFilter = `
    AND NOT (
      EXISTS (
        SELECT 1 FROM circle_tweet_sources s_g
        JOIN circle_tweets ct_g ON ct_g.id = s_g.tweet_id
        WHERE ct_g.screen_name = ct.screen_name
          AND s_g.source_list = 'growth-study'
      )
      AND NOT EXISTS (
        SELECT 1 FROM circle_tweet_sources s_a
        JOIN circle_tweets ct_a ON ct_a.id = s_a.tweet_id
        WHERE ct_a.screen_name = ct.screen_name
          AND s_a.source_list = 'anchors'
      )
    )`;
  const result = await db.query(`
    SELECT
      ct.id, ct.screen_name, ct.text, ct.created_at,
      ct.like_count, ct.retweet_count, ct.reply_count, ct.quote_count, ct.view_count,
      ct.is_retweet,
      (
        SELECT ARRAY_AGG(DISTINCT s.source_list ORDER BY s.source_list)
        FROM circle_tweet_sources s
        WHERE s.tweet_id = ct.id
      ) AS source_lists,
      (
        SELECT action_type FROM circle_tweet_actions
        WHERE tweet_id = ct.id ORDER BY action_at DESC LIMIT 1
      ) AS last_action,
      sc.followers_count, sc.relationship,
      lts.total       AS score_total,
      lts.scores      AS score_breakdown,
      lts.reason      AS score_reason,
      lts.scored_at   AS scored_at
    FROM circle_tweets ct
    LEFT JOIN social_circle sc ON ct.screen_name = sc.screen_name
    LEFT JOIN list_tweet_scores lts ON lts.tweet_id = ct.id
    WHERE ct.is_retweet = FALSE
      AND ct.in_reply_to_screen_name IS NULL
      AND ct.created_at > NOW() - ($2 * INTERVAL '1 hour')
      AND length(trim(regexp_replace(ct.text, 'https?://t\.co/\w+', '', 'g'))) > 0
      AND EXISTS (SELECT 1 FROM circle_tweet_sources s WHERE s.tweet_id = ct.id)
      ${slugFilter}
      ${actionedFilter}
      ${repliedTodayFilter}
      ${growthFilter}
    ORDER BY lts.total DESC NULLS LAST, ct.created_at DESC
    LIMIT $1
  `, params);
  return result.rows;
}

/**
 * Tweets needing LLM scoring: within `hoursMax` (default 3),
 * not retweet, not actioned, no existing score row.
 * Joins social_circle for author meta the prompt needs.
 */
async function getUnscoredFeedTweets({ hoursMax = 3, limit = 100 } = {}) {
  const db = getPool();
  const result = await db.query(`
    SELECT
      ct.id, ct.screen_name, ct.text, ct.created_at,
      ct.like_count, ct.retweet_count, ct.reply_count, ct.quote_count, ct.view_count,
      ct.in_reply_to_screen_name, ct.raw_data
    FROM circle_tweets ct
    WHERE ct.is_retweet = FALSE
      AND ct.in_reply_to_screen_name IS NULL
      AND ct.created_at > NOW() - ($1 * INTERVAL '1 hour')
      AND length(trim(regexp_replace(ct.text, 'https?://t\.co/\w+', '', 'g'))) > 0
      AND EXISTS (
        SELECT 1 FROM circle_tweet_sources s
        WHERE s.tweet_id = ct.id AND s.source_list = ANY($3::text[])
      )
      AND NOT EXISTS (
        SELECT 1 FROM circle_tweet_actions a
        WHERE a.tweet_id = ct.id
          AND a.action_type IN ('replied','skipped','hidden','done')
      )
      AND NOT EXISTS (SELECT 1 FROM list_tweet_scores lts WHERE lts.tweet_id = ct.id)
      AND NOT EXISTS (
        SELECT 1 FROM circle_tweet_actions a_today
        JOIN circle_tweets ct_today ON ct_today.id = a_today.tweet_id
        WHERE ct_today.screen_name = ct.screen_name
          AND a_today.action_type = 'replied'
          AND a_today.action_at >= date_trunc('day', NOW())
      )
      AND NOT (
        EXISTS (
          SELECT 1 FROM circle_tweet_sources s_g
          JOIN circle_tweets ct_g ON ct_g.id = s_g.tweet_id
          WHERE ct_g.screen_name = ct.screen_name
            AND s_g.source_list = 'growth-study'
        )
        AND NOT EXISTS (
          SELECT 1 FROM circle_tweet_sources s_a
          JOIN circle_tweets ct_a ON ct_a.id = s_a.tweet_id
          WHERE ct_a.screen_name = ct.screen_name
            AND s_a.source_list = 'anchors'
        )
      )
    ORDER BY ct.created_at DESC
    LIMIT $2
  `, [hoursMax, limit, REPLY_TARGET_LISTS]);
  return result.rows;
}

async function saveListTweetScore({ tweetId, total, scores, reason, model, promptHash }) {
  const db = getPool();
  await db.query(`
    INSERT INTO list_tweet_scores (tweet_id, total, scores, reason, model, prompt_hash)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6)
    ON CONFLICT (tweet_id) DO UPDATE SET
      total       = EXCLUDED.total,
      scores      = EXCLUDED.scores,
      reason      = EXCLUDED.reason,
      model       = EXCLUDED.model,
      prompt_hash = EXCLUDED.prompt_hash,
      scored_at   = CURRENT_TIMESTAMP
  `, [tweetId, total, JSON.stringify(scores), reason || null, model || null, promptHash || null]);
}

async function getListFeedStats() {
  const db = getPool();
  const result = await db.query(`
    SELECT
      s.source_list,
      COUNT(DISTINCT s.tweet_id)::int AS total,
      COUNT(DISTINCT s.tweet_id) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM circle_tweet_actions a
          WHERE a.tweet_id = s.tweet_id
            AND a.action_type IN ('replied','skipped','hidden','done')
        )
      )::int AS unactioned
    FROM circle_tweet_sources s
    GROUP BY s.source_list
  `);
  return result.rows;
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

// ============================================================================
// LIVE TAB
// ============================================================================

let liveTablesReady = null;

// One statement per query. node-postgres will not run a multi-statement string.
// History is append-only: the trigger copies a row only when live data changes.
const LIVE_HISTORY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS live_signals_history (
    id BIGSERIAL PRIMARY KEY,
    live_signal_id INT,
    kind VARCHAR(20) NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT,
    detail TEXT,
    url TEXT,
    payload JSONB,
    content_hash TEXT NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_signals_history_item
    ON live_signals_history (kind, item_key, recorded_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS tweets_history (
    id BIGSERIAL PRIMARY KEY,
    tweet_id BIGINT NOT NULL,
    user_id BIGINT,
    user_screen_name VARCHAR(50),
    user_name VARCHAR(100),
    user_followers_count INT,
    user_following_count INT,
    user_is_blue_verified BOOLEAN,
    user_follows_me BOOLEAN,
    i_follow_user BOOLEAN,
    text TEXT,
    reply_count INT,
    retweet_count INT,
    like_count INT,
    quote_count INT,
    view_count INT,
    bookmark_count INT,
    content_hash TEXT NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_history_tweet
    ON tweets_history (tweet_id, recorded_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_history_user
    ON tweets_history (user_id, recorded_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_history_screen
    ON tweets_history (user_screen_name, recorded_at DESC, id DESC)`,
  `CREATE OR REPLACE FUNCTION live_signal_snapshot_hash(title text, detail text, url text, payload jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT md5(concat_ws('|', coalesce(title, ''), coalesce(detail, ''), coalesce(url, ''), coalesce(payload::text, '')))
    $$`,
  `CREATE OR REPLACE FUNCTION tweet_snapshot_hash(
      followers integer, following integer, follows_me boolean, i_follow boolean, blue boolean,
      user_name text, screen_name text, body text,
      replies integer, retweets integer, likes integer, quotes integer, views integer, bookmarks integer
    ) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT md5(concat_ws('|',
        coalesce(followers, 0), coalesce(following, 0), coalesce(follows_me, false), coalesce(i_follow, false),
        coalesce(blue, false), coalesce(user_name, ''), coalesce(screen_name, ''), coalesce(body, ''),
        coalesce(replies, 0), coalesce(retweets, 0), coalesce(likes, 0), coalesce(quotes, 0),
        coalesce(views, 0), coalesce(bookmarks, 0)
      ))
    $$`,
  `CREATE OR REPLACE FUNCTION live_signals_history_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NOT (
        NEW.title IS DISTINCT FROM OLD.title
        OR NEW.detail IS DISTINCT FROM OLD.detail
        OR NEW.url IS DISTINCT FROM OLD.url
        OR NEW.payload IS DISTINCT FROM OLD.payload
      ) THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND NOT EXISTS (
        SELECT 1 FROM live_signals_history h
        WHERE h.kind = OLD.kind AND h.item_key = OLD.item_key
      ) THEN
        INSERT INTO live_signals_history (
          live_signal_id, kind, item_key, title, detail, url, payload, content_hash
        ) VALUES (
          OLD.id, OLD.kind, OLD.item_key, OLD.title, OLD.detail, OLD.url, OLD.payload,
          live_signal_snapshot_hash(OLD.title, OLD.detail, OLD.url, OLD.payload)
        );
      END IF;
      INSERT INTO live_signals_history (
        live_signal_id, kind, item_key, title, detail, url, payload, content_hash
      ) VALUES (
        NEW.id, NEW.kind, NEW.item_key, NEW.title, NEW.detail, NEW.url, NEW.payload,
        live_signal_snapshot_hash(NEW.title, NEW.detail, NEW.url, NEW.payload)
      );
      RETURN NEW;
    END;
    $$`,
  `CREATE OR REPLACE FUNCTION tweets_history_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NOT (
        NEW.user_followers_count IS DISTINCT FROM OLD.user_followers_count
        OR NEW.user_following_count IS DISTINCT FROM OLD.user_following_count
        OR NEW.user_follows_me IS DISTINCT FROM OLD.user_follows_me
        OR NEW.i_follow_user IS DISTINCT FROM OLD.i_follow_user
        OR NEW.user_is_blue_verified IS DISTINCT FROM OLD.user_is_blue_verified
        OR NEW.user_name IS DISTINCT FROM OLD.user_name
        OR NEW.user_screen_name IS DISTINCT FROM OLD.user_screen_name
        OR NEW.text IS DISTINCT FROM OLD.text
        OR NEW.reply_count IS DISTINCT FROM OLD.reply_count
        OR NEW.retweet_count IS DISTINCT FROM OLD.retweet_count
        OR NEW.like_count IS DISTINCT FROM OLD.like_count
        OR NEW.quote_count IS DISTINCT FROM OLD.quote_count
        OR NEW.view_count IS DISTINCT FROM OLD.view_count
        OR NEW.bookmark_count IS DISTINCT FROM OLD.bookmark_count
      ) THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND NOT EXISTS (
        SELECT 1 FROM tweets_history h WHERE h.tweet_id = OLD.id
      ) THEN
        INSERT INTO tweets_history (
          tweet_id, user_id, user_screen_name, user_name,
          user_followers_count, user_following_count, user_is_blue_verified,
          user_follows_me, i_follow_user, text,
          reply_count, retweet_count, like_count, quote_count, view_count, bookmark_count,
          content_hash
        ) VALUES (
          OLD.id, OLD.user_id, OLD.user_screen_name, OLD.user_name,
          OLD.user_followers_count, OLD.user_following_count, OLD.user_is_blue_verified,
          OLD.user_follows_me, OLD.i_follow_user, OLD.text,
          OLD.reply_count, OLD.retweet_count, OLD.like_count, OLD.quote_count, OLD.view_count, OLD.bookmark_count,
          tweet_snapshot_hash(
            OLD.user_followers_count, OLD.user_following_count, OLD.user_follows_me, OLD.i_follow_user,
            OLD.user_is_blue_verified, OLD.user_name, OLD.user_screen_name, OLD.text,
            OLD.reply_count, OLD.retweet_count, OLD.like_count, OLD.quote_count, OLD.view_count, OLD.bookmark_count
          )
        );
      END IF;
      INSERT INTO tweets_history (
        tweet_id, user_id, user_screen_name, user_name,
        user_followers_count, user_following_count, user_is_blue_verified,
        user_follows_me, i_follow_user, text,
        reply_count, retweet_count, like_count, quote_count, view_count, bookmark_count,
        content_hash
      ) VALUES (
        NEW.id, NEW.user_id, NEW.user_screen_name, NEW.user_name,
        NEW.user_followers_count, NEW.user_following_count, NEW.user_is_blue_verified,
        NEW.user_follows_me, NEW.i_follow_user, NEW.text,
        NEW.reply_count, NEW.retweet_count, NEW.like_count, NEW.quote_count, NEW.view_count, NEW.bookmark_count,
        tweet_snapshot_hash(
          NEW.user_followers_count, NEW.user_following_count, NEW.user_follows_me, NEW.i_follow_user,
          NEW.user_is_blue_verified, NEW.user_name, NEW.user_screen_name, NEW.text,
          NEW.reply_count, NEW.retweet_count, NEW.like_count, NEW.quote_count, NEW.view_count, NEW.bookmark_count
        )
      );
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS live_signals_history_trg ON live_signals`,
  `CREATE TRIGGER live_signals_history_trg
    AFTER INSERT OR UPDATE ON live_signals
    FOR EACH ROW
    EXECUTE PROCEDURE live_signals_history_write()`,
  `DROP TRIGGER IF EXISTS tweets_history_trg ON tweets`,
  `CREATE TRIGGER tweets_history_trg
    AFTER INSERT OR UPDATE ON tweets
    FOR EACH ROW
    EXECUTE PROCEDURE tweets_history_write()`,
  // Own followers and following. removed_at is null while they are still on the list.
  // Snapshots are one row per full scan, so the totals show whether the list moved.
  `CREATE TABLE IF NOT EXISTS live_graph (
    relation VARCHAR(16) NOT NULL,
    screen_name VARCHAR(50) NOT NULL,
    user_id VARCHAR(30),
    display_name VARCHAR(100),
    followers_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    PRIMARY KEY (relation, screen_name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_graph_open
    ON live_graph (relation, removed_at)`,
  `CREATE TABLE IF NOT EXISTS live_graph_history (
    id BIGSERIAL PRIMARY KEY,
    relation VARCHAR(16) NOT NULL,
    screen_name VARCHAR(50) NOT NULL,
    user_id VARCHAR(30),
    display_name VARCHAR(100),
    followers_count INT,
    following_count INT,
    event VARCHAR(16) NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_graph_history_rel
    ON live_graph_history (relation, recorded_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS live_graph_snapshots (
    id BIGSERIAL PRIMARY KEY,
    relation VARCHAR(16) NOT NULL,
    total INT NOT NULL,
    added INT NOT NULL DEFAULT 0,
    removed INT NOT NULL DEFAULT 0,
    header_count INT,
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    recorded_at TIMESTAMP NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_graph_snapshots_rel
    ON live_graph_snapshots (relation, recorded_at DESC, id DESC)`,
];

function ensureLiveTables() {
  if (!liveTablesReady) {
    liveTablesReady = (async () => {
      const db = getPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS live_signals (
          id SERIAL PRIMARY KEY,
          kind VARCHAR(20) NOT NULL,
          item_key TEXT NOT NULL,
          title TEXT,
          detail TEXT,
          url TEXT,
          payload JSONB,
          first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (kind, item_key)
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_live_signals_kind_seen
          ON live_signals(kind, last_seen_at DESC)
      `);
      for (const statement of LIVE_HISTORY_STATEMENTS) {
        await db.query(statement);
      }
    })().catch(err => {
      liveTablesReady = null;
      throw err;
    });
  }
  return liveTablesReady;
}

async function upsertLiveSignal(signal) {
  await ensureLiveTables();
  const db = getPool();
  const itemKey = String(signal.item_key || '').slice(0, 800);
  if (!signal.kind || !itemKey) return false;
  let payload = signal.payload || {};
  let detail = signal.detail || null;
  let title = signal.title || null;
  let url = signal.url || null;
  if (signal.kind === 'who_to_follow') {
    const { mergePersonPayload } = require('./live/person');
    const prev = await db.query(
      `SELECT payload FROM live_signals WHERE kind = 'who_to_follow' AND item_key = $1`,
      [itemKey]
    );
    if (prev.rows[0]?.payload) payload = mergePersonPayload(prev.rows[0].payload, payload);
  } else if (signal.kind === 'news' || signal.kind === 'trend') {
    const { mergeStoryPayload, preferWebUrl } = require('./live/extract');
    const prev = await db.query(
      `SELECT title, detail, url, payload FROM live_signals WHERE kind = $1 AND item_key = $2`,
      [signal.kind, itemKey]
    );
    const row = prev.rows[0];
    if (row) {
      payload = mergeStoryPayload(row.payload, payload);
      if ((row.detail || '').length > String(detail || '').length) detail = row.detail;
      if ((row.title || '').length > String(title || '').length) title = row.title;
      url = preferWebUrl(row.url, url);
    }
  }
  const result = await db.query(`
    INSERT INTO live_signals (kind, item_key, title, detail, url, payload)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (kind, item_key) DO UPDATE SET
      title = EXCLUDED.title,
      detail = COALESCE(NULLIF(EXCLUDED.detail, ''), live_signals.detail),
      url = COALESCE(EXCLUDED.url, live_signals.url),
      payload = EXCLUDED.payload,
      last_seen_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS inserted
  `, [
    signal.kind,
    itemKey,
    title,
    detail,
    url,
    JSON.stringify(payload),
  ]);
  return result.rows[0]?.inserted === true;
}

async function attachPersonTweet(handle, bucket, record) {
  await ensureLiveTables();
  const db = getPool();
  const itemKey = String(handle || '').toLowerCase();
  if (!itemKey || !record?.id) return;
  const { attachTweetToPerson } = require('./live/person');
  const prev = await db.query(
    `SELECT payload, detail FROM live_signals WHERE kind = 'who_to_follow' AND item_key = $1`,
    [itemKey]
  );
  if (!prev.rows[0]) return;
  const payload = attachTweetToPerson(prev.rows[0].payload, bucket, record);
  await db.query(`
    UPDATE live_signals
    SET payload = $2,
        detail = COALESCE(NULLIF($3, ''), detail),
        last_seen_at = CURRENT_TIMESTAMP
    WHERE kind = 'who_to_follow' AND item_key = $1
  `, [itemKey, JSON.stringify(payload), payload.bio || '']);
}

function graphRelation(relation) {
  return relation === 'following' ? 'following' : 'follower';
}

async function latestGraphTotals() {
  await ensureLiveTables();
  const db = getPool();
  const result = await db.query(`
    SELECT DISTINCT ON (relation) relation, total
    FROM live_graph_snapshots
    WHERE complete = TRUE
    ORDER BY relation, recorded_at DESC, id DESC
  `);
  const totals = { follower: null, following: null };
  for (const row of result.rows) {
    if (row.relation === 'follower' || row.relation === 'following') {
      totals[row.relation] = Number(row.total);
    }
  }
  return totals;
}

// Write one followers or following scan. A partial scan records people it
// actually saw and does not mark anyone removed.
async function reconcileLiveGraph({ relation, people, scrollComplete, headerCount } = {}) {
  await ensureLiveTables();
  const { planGraphReconcile } = require('./live/graph');
  const rel = graphRelation(relation);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT screen_name, removed_at FROM live_graph WHERE relation = $1`,
      [rel]
    );
    const prior = await client.query(
      `SELECT 1 FROM live_graph_snapshots WHERE relation = $1 AND complete = TRUE LIMIT 1`,
      [rel]
    );
    const plan = planGraphReconcile({
      seen: people,
      rows: existing.rows,
      hadComplete: prior.rows.length > 0,
      scrollComplete: !!scrollComplete,
      headerCount: Number.isInteger(headerCount) ? headerCount : null,
    });

    const chunk = 400;
    for (let i = 0; i < plan.seen.length; i += chunk) {
      const slice = plan.seen.slice(i, i + chunk);
      await client.query(`
        INSERT INTO live_graph (
          relation, screen_name, user_id, display_name, followers_count, following_count, removed_at, last_seen_at
        )
        SELECT $1, screen_name, NULLIF(user_id, ''), NULLIF(display_name, ''),
               followers_count, following_count, NULL, CURRENT_TIMESTAMP
        FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
          AS t(screen_name, user_id, display_name, followers_count, following_count)
        ON CONFLICT (relation, screen_name) DO UPDATE SET
          user_id = COALESCE(EXCLUDED.user_id, live_graph.user_id),
          display_name = COALESCE(EXCLUDED.display_name, live_graph.display_name),
          followers_count = CASE
            WHEN EXCLUDED.followers_count > 0 THEN EXCLUDED.followers_count
            ELSE live_graph.followers_count END,
          following_count = CASE
            WHEN EXCLUDED.following_count > 0 THEN EXCLUDED.following_count
            ELSE live_graph.following_count END,
          last_seen_at = CURRENT_TIMESTAMP,
          removed_at = NULL
      `, [
        rel,
        slice.map(person => person.screen_name),
        slice.map(person => person.user_id || ''),
        slice.map(person => person.display_name || ''),
        slice.map(person => person.followers_count || 0),
        slice.map(person => person.following_count || 0),
      ]);
    }

    if (plan.closing) {
      await client.query(`
        UPDATE live_graph
        SET removed_at = CURRENT_TIMESTAMP
        WHERE relation = $1
          AND removed_at IS NULL
          AND NOT (screen_name = ANY($2::text[]))
      `, [rel, plan.seen.map(person => person.screen_name)]);
    }

    async function writeEvents(event, slicePeople) {
      for (let i = 0; i < slicePeople.length; i += chunk) {
        const slice = slicePeople.slice(i, i + chunk);
        await client.query(`
          INSERT INTO live_graph_history (
            relation, screen_name, user_id, display_name, followers_count, following_count, event
          )
          SELECT $1, screen_name, NULLIF(user_id, ''), NULLIF(display_name, ''),
                 followers_count, following_count, $2
          FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[])
            AS t(screen_name, user_id, display_name, followers_count, following_count)
        `, [
          rel,
          event,
          slice.map(person => person.screen_name),
          slice.map(person => person.user_id || ''),
          slice.map(person => person.display_name || ''),
          slice.map(person => person.followers_count || 0),
          slice.map(person => person.following_count || 0),
        ]);
      }
    }

    if (plan.added.length) await writeEvents('added', plan.added);
    if (plan.removed.length) {
      await writeEvents('removed', plan.removed.map(screen => ({
        screen_name: screen,
        user_id: '',
        display_name: '',
        followers_count: 0,
        following_count: 0,
      })));
    }

    if (plan.closing) {
      await client.query(`
        INSERT INTO live_graph_snapshots (relation, total, added, removed, header_count, complete)
        VALUES ($1, $2, $3, $4, $5, TRUE)
      `, [rel, plan.total, plan.added.length, plan.removed.length, plan.headerCount]);
    }

    await client.query('COMMIT');
    return {
      relation: rel,
      closing: plan.closing,
      baseline: plan.baseline,
      reason: plan.reason,
      total: plan.total,
      addedCount: plan.added.length,
      removedCount: plan.removed.length,
      addedNames: plan.added.slice(0, 8).map(person => person.screen_name),
      removedNames: plan.removed.slice(0, 8),
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
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
  getConfig,
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
  getListFeed,
  getListFeedScored,
  getUnscoredFeedTweets,
  saveListTweetScore,
  getListFeedStats,
  recordCircleTweetAction,
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
  // Live tab
  ensureLiveTables,
  upsertLiveSignal,
  attachPersonTweet,
  reconcileLiveGraph,
  latestGraphTotals,
};
