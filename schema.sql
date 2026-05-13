-- xPose Database Schema
-- Run this against your PostgreSQL database to create the tables

-- Tweets table - stores all fetched tweets
CREATE TABLE IF NOT EXISTS tweets (
    id BIGINT PRIMARY KEY,                          -- Twitter tweet ID
    user_id BIGINT,                                 -- Twitter user ID
    user_screen_name VARCHAR(50),                   -- @handle
    user_name VARCHAR(100),                         -- Display name
    user_followers_count INT DEFAULT 0,
    user_following_count INT DEFAULT 0,             -- How many they follow
    user_is_blue_verified BOOLEAN DEFAULT FALSE,
    user_follows_me BOOLEAN DEFAULT FALSE,          -- Are they following me?
    i_follow_user BOOLEAN DEFAULT FALSE,            -- Am I following them?

    text TEXT NOT NULL,                             -- Tweet content
    created_at TIMESTAMP,                           -- When tweet was posted

    -- Engagement metrics
    reply_count INT DEFAULT 0,
    retweet_count INT DEFAULT 0,
    like_count INT DEFAULT 0,
    quote_count INT DEFAULT 0,
    view_count INT DEFAULT 0,
    bookmark_count INT DEFAULT 0,

    -- Source tracking
    source VARCHAR(50),                             -- 'for-you', 'list', 'search', etc.
    source_url TEXT,                                -- URL where tweet was found

    -- Metadata
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    raw_data JSONB                                  -- Full tweet data for reference
);

-- Analysis table - stores LLM analysis results
CREATE TABLE IF NOT EXISTS tweet_analysis (
    id SERIAL PRIMARY KEY,
    tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,

    -- Analysis results
    is_relevant BOOLEAN DEFAULT FALSE,
    engagement_type VARCHAR(20),                    -- 'quote', 'reply', or NULL
    suggested_content TEXT,                         -- LLM suggested message
    score INT DEFAULT 0,

    -- ICP used for analysis
    icp_criteria TEXT,

    -- Tracking
    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    llm_provider VARCHAR(50),                       -- 'openrouter', 'glm', etc.
    llm_model VARCHAR(100),                         -- Model used

    UNIQUE(tweet_id, icp_criteria)                  -- One analysis per tweet per ICP
);

-- User actions - track what you've done with tweets
CREATE TABLE IF NOT EXISTS tweet_actions (
    id SERIAL PRIMARY KEY,
    tweet_id BIGINT REFERENCES tweets(id) ON DELETE CASCADE,

    action_type VARCHAR(20) NOT NULL,               -- 'replied', 'quoted', 'liked', 'skipped', 'dismissed', 'done', 'hidden'
    action_content TEXT,                            -- What you actually posted (if applicable)
    action_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tweet_id, action_type)
);

-- User preferences - track user-level settings (block/boost)
CREATE TABLE IF NOT EXISTS user_preferences (
    id SERIAL PRIMARY KEY,
    user_screen_name VARCHAR(50) NOT NULL UNIQUE,
    user_name VARCHAR(100),

    is_blocked BOOLEAN DEFAULT FALSE,              -- Never show this user
    boost_points INT DEFAULT 0,                    -- Extra points for this user (+/- adjustment)
    notes TEXT,                                     -- Personal notes about this user

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_screen_name ON user_preferences(user_screen_name);
CREATE INDEX IF NOT EXISTS idx_user_prefs_blocked ON user_preferences(is_blocked) WHERE is_blocked = TRUE;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tweets_fetched_at ON tweets(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_user_screen_name ON tweets(user_screen_name);
CREATE INDEX IF NOT EXISTS idx_tweets_source ON tweets(source);
CREATE INDEX IF NOT EXISTS idx_tweets_user_follows_me ON tweets(user_follows_me) WHERE user_follows_me = TRUE;
CREATE INDEX IF NOT EXISTS idx_tweets_i_follow_user ON tweets(i_follow_user) WHERE i_follow_user = TRUE;
CREATE INDEX IF NOT EXISTS idx_tweets_followers_count ON tweets(user_followers_count DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_relevant ON tweet_analysis(is_relevant) WHERE is_relevant = TRUE;
CREATE INDEX IF NOT EXISTS idx_analysis_tweet_id ON tweet_analysis(tweet_id);
CREATE INDEX IF NOT EXISTS idx_actions_tweet_id ON tweet_actions(tweet_id);

-- View for quick access to relevant tweets with their analysis
CREATE OR REPLACE VIEW relevant_tweets AS
SELECT
    t.id,
    t.user_screen_name,
    t.user_name,
    t.user_followers_count,
    t.user_following_count,
    t.user_follows_me,
    t.i_follow_user,
    t.user_is_blue_verified,
    t.text,
    t.created_at,
    t.reply_count,
    t.retweet_count,
    t.like_count,
    a.engagement_type,
    a.suggested_content,
    a.analyzed_at,
    ta.action_type AS actioned
FROM tweets t
JOIN tweet_analysis a ON t.id = a.tweet_id
LEFT JOIN tweet_actions ta ON t.id = ta.tweet_id
WHERE a.is_relevant = TRUE
ORDER BY a.analyzed_at DESC;

-- ============================================================================
-- ENGAGEMENT OPPORTUNITIES ALGORITHM
-- ============================================================================
-- This view scores tweets from the past 8 hours to maximize engagement potential
-- for replies and quotes. Higher score = better opportunity.
--
-- SCORING FACTORS (Total max ~120 points):
--   1. OG Followers (max 30pts) - More followers = more eyeballs
--   2. First Reply Advantage (max 25pts) - Low reply count = less competition
--   3. Tweet Freshness (max 20pts) - Newer tweets have algorithm juice
--   4. Blue Verified (10pts) - Verified accounts get more reach
--   5. Engagement Velocity (max 15pts) - Fast-growing = trending potential
--   6. Mutual Relationship (max 13pts) - Connection = reciprocation
--   7. Influencer Ratio (max 10pts) - Real influencers, not follow-back bots
--   8. View Count (max 10pts) - More views = more potential reach
--   9. Quote Potential (max 10pts) - Being quoted = viral content
--  10. Bookmark Signal (max 5pts) - Bookmarked = valuable content
-- ============================================================================
CREATE OR REPLACE VIEW engagement_opportunities AS
WITH scored_tweets AS (
    SELECT
        t.id,
        t.user_screen_name,
        t.user_name,
        t.user_followers_count,
        t.user_following_count,
        t.user_is_blue_verified,
        t.user_follows_me,
        t.i_follow_user,
        t.text,
        t.created_at,
        t.reply_count,
        t.retweet_count,
        t.like_count,
        t.quote_count,
        t.view_count,
        t.bookmark_count,
        t.source,
        t.fetched_at,

        -- User preferences (boost points)
        COALESCE(up.boost_points, 0) AS user_boost_points,

        -- Minutes since tweet was posted
        EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60 AS minutes_old,

        -- =============================================
        -- SCORING COMPONENTS (broken out for debugging)
        -- =============================================

        -- 1. OG Followers Score (max 30 points)
        -- Log scale prevents mega-accounts from dominating
        -- 10K followers ≈ 20pts, 100K ≈ 25pts, 1M ≈ 30pts
        LEAST(30, LN(GREATEST(t.user_followers_count, 1) + 1) * 2.5)::NUMERIC(5,2)
            AS followers_score,

        -- 2. First Reply Advantage (max 25 points)
        -- 0 replies = 25pts, 5 replies = 15pts, 12+ replies = 0pts
        GREATEST(0, 25 - (t.reply_count * 2))::NUMERIC(5,2)
            AS first_reply_score,

        -- 3. Tweet Freshness (max 20 points)
        -- < 10 min = 20pts, 1 hour = ~13pts, 4 hours = ~0pts
        GREATEST(0, 20 - (EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60 / 12))::NUMERIC(5,2)
            AS freshness_score,

        -- 4. Blue Verified Bonus (10 points)
        CASE WHEN t.user_is_blue_verified THEN 10 ELSE 0 END
            AS verified_score,

        -- 5. Engagement Velocity (max 15 points)
        -- Likes per minute, scaled - fast engagement = trending
        LEAST(15,
            CASE
                WHEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60 > 5
                THEN (t.like_count::FLOAT / (EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60)) * 5
                ELSE t.like_count * 0.3  -- New tweets: just use raw likes
            END
        )::NUMERIC(5,2) AS velocity_score,

        -- 6. Mutual Relationship (max 13 points)
        -- They follow you (8pts) + You follow them (5pts)
        (CASE WHEN t.user_follows_me THEN 8 ELSE 0 END +
         CASE WHEN t.i_follow_user THEN 5 ELSE 0 END)
            AS relationship_score,

        -- 7. Influencer Ratio (max 10 points)
        -- Low following/follower ratio = real influencer
        CASE
            WHEN t.user_followers_count > 1000 AND
                 t.user_following_count::FLOAT / GREATEST(t.user_followers_count, 1) < 0.05
            THEN 10  -- Elite ratio (follows <5% of followers)
            WHEN t.user_followers_count > 1000 AND
                 t.user_following_count::FLOAT / GREATEST(t.user_followers_count, 1) < 0.2
            THEN 7   -- Strong ratio
            WHEN t.user_followers_count > 1000 AND
                 t.user_following_count::FLOAT / GREATEST(t.user_followers_count, 1) < 0.5
            THEN 4   -- Decent ratio
            ELSE 0
        END AS influencer_ratio_score,

        -- 8. View Count (max 10 points)
        -- More views = more potential eyeballs on your reply
        LEAST(10, LN(GREATEST(t.view_count, 1) + 1) * 0.8)::NUMERIC(5,2)
            AS views_score,

        -- 9. Quote Potential (max 10 points)
        -- Tweets being quoted = controversial/viral = engagement magnet
        LEAST(10, t.quote_count * 2)::NUMERIC(5,2)
            AS quote_potential_score,

        -- 10. Bookmark Signal (max 5 points)
        -- Bookmarked content = valuable, thoughtful
        LEAST(5, t.bookmark_count)::NUMERIC(5,2)
            AS bookmark_score,

        -- Analysis data (from most recent analysis)
        ta.suggested_content,
        ta.is_relevant AS analysis_relevant,
        ta.analysis_score,
        ta.analysis_type

    FROM tweets t
    LEFT JOIN user_preferences up ON t.user_screen_name = up.user_screen_name
    LEFT JOIN LATERAL (
        SELECT suggested_content, is_relevant, score as analysis_score, engagement_type as analysis_type
        FROM tweet_analysis
        WHERE tweet_id = t.id
        ORDER BY analyzed_at DESC
        LIMIT 1
    ) ta ON true
    WHERE
        -- Only tweets from last 8 hours
        t.created_at > NOW() - INTERVAL '8 hours'
        -- Max 8 replies (real opportunities, not crowded threads)
        AND t.reply_count <= 8
        -- Exclude blocked users
        AND (up.is_blocked IS NULL OR up.is_blocked = FALSE)
        -- Exclude tweets we've already acted on
        AND NOT EXISTS (
            SELECT 1 FROM tweet_actions tact
            WHERE tact.tweet_id = t.id
            AND tact.action_type IN ('replied', 'quoted', 'skipped', 'dismissed', 'done', 'hidden')
        )
)
SELECT
    id,
    user_screen_name,
    user_name,
    user_followers_count,
    user_following_count,
    user_is_blue_verified,
    user_follows_me,
    i_follow_user,
    text,
    created_at,
    reply_count,
    retweet_count,
    like_count,
    quote_count,
    view_count,
    bookmark_count,
    source,
    fetched_at,
    minutes_old,
    user_boost_points,

    -- Individual scores for transparency/debugging
    followers_score,
    first_reply_score,
    freshness_score,
    verified_score,
    velocity_score,
    relationship_score,
    influencer_ratio_score,
    views_score,
    quote_potential_score,
    bookmark_score,

    -- TOTAL ENGAGEMENT SCORE (including user boost)
    (followers_score + first_reply_score + freshness_score + verified_score +
     velocity_score + relationship_score + influencer_ratio_score +
     views_score + quote_potential_score + bookmark_score + user_boost_points)::NUMERIC(6,2) AS engagement_score,

    -- Recommended action based on quote_count (quotes > replies for engagement)
    CASE
        WHEN quote_count >= 3 THEN 'QUOTE'  -- High quote activity = quote-worthy
        WHEN user_followers_count > 50000 THEN 'QUOTE'  -- Big accounts = quote for visibility
        ELSE 'REPLY'
    END AS recommended_action,

    -- Analysis data
    suggested_content,
    analysis_relevant,
    analysis_score,
    analysis_type

FROM scored_tweets
ORDER BY
    (followers_score + first_reply_score + freshness_score + verified_score +
     velocity_score + relationship_score + influencer_ratio_score +
     views_score + quote_potential_score + bookmark_score + user_boost_points) DESC
LIMIT 100;

-- ============================================================================
-- SOCIAL CIRCLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS social_circle (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(30) UNIQUE,
    screen_name VARCHAR(50) UNIQUE,
    display_name VARCHAR(100),
    bio TEXT,
    followers_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    is_follower  BOOLEAN DEFAULT FALSE,   -- they follow me
    is_following BOOLEAN DEFAULT FALSE,   -- I follow them
    relationship VARCHAR(20) NOT NULL,    -- 'follower','following','mutual','2nd_degree'
    is_active BOOLEAN DEFAULT TRUE,
    last_crawled_at TIMESTAMP,
    crawl_priority INT DEFAULT 0,         -- mutual=3, following=2, follower=1, 2nd_degree=0
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Upgrade path for existing installs missing the boolean flags.
ALTER TABLE social_circle ADD COLUMN IF NOT EXISTS is_follower  BOOLEAN DEFAULT FALSE;
ALTER TABLE social_circle ADD COLUMN IF NOT EXISTS is_following BOOLEAN DEFAULT FALSE;

-- Upgrade path: ensure UNIQUE (screen_name) so upsertSocialCircle's ON CONFLICT works.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'social_circle'::regclass AND contype = 'u'
      AND conkey = (SELECT array_agg(attnum) FROM pg_attribute
                    WHERE attrelid = 'social_circle'::regclass AND attname = 'screen_name')
  ) THEN
    DELETE FROM social_circle a USING social_circle b
     WHERE a.id > b.id AND a.screen_name = b.screen_name AND a.screen_name IS NOT NULL;
    ALTER TABLE social_circle ADD CONSTRAINT social_circle_screen_name_key UNIQUE (screen_name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_social_circle_screen_name ON social_circle(screen_name);
CREATE INDEX IF NOT EXISTS idx_social_circle_crawl_next ON social_circle(crawl_priority DESC, last_crawled_at ASC NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_social_circle_relationship ON social_circle(relationship);

-- Tweets collected from circle members
CREATE TABLE IF NOT EXISTS circle_tweets (
    id BIGINT PRIMARY KEY,
    screen_name VARCHAR(50) NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMP,
    in_reply_to_screen_name VARCHAR(50),
    reply_count INT DEFAULT 0,
    like_count INT DEFAULT 0,
    retweet_count INT DEFAULT 0,
    quote_count INT DEFAULT 0,
    view_count INT DEFAULT 0,
    is_retweet BOOLEAN DEFAULT FALSE,
    raw_data JSONB,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_circle_tweets_screen_name ON circle_tweets(screen_name);
CREATE INDEX IF NOT EXISTS idx_circle_tweets_created_at ON circle_tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_circle_tweets_reply_to ON circle_tweets(in_reply_to_screen_name);

-- Crawl job queue
CREATE TABLE IF NOT EXISTS crawl_jobs (
    id SERIAL PRIMARY KEY,
    job_type VARCHAR(30) NOT NULL,        -- 'import','enrichment','user_tweets'
    target_screen_name VARCHAR(50),
    target_user_id VARCHAR(30),
    status VARCHAR(20) DEFAULT 'pending', -- pending/running/done/failed/paused
    tweets_collected INT DEFAULT 0,
    pages_fetched INT DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON crawl_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_target ON crawl_jobs(target_screen_name);

-- Post drafts
CREATE TABLE IF NOT EXISTS drafts (
    id SERIAL PRIMARY KEY,
    draft_text TEXT NOT NULL,
    context_summary TEXT,
    based_on_circle_tweets JSONB,
    based_on_wiki_pages JSONB,
    status VARCHAR(20) DEFAULT 'draft',   -- draft/approved/scheduled/posted/discarded
    suggested_post_time TIMESTAMP,
    posted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_created_at ON drafts(created_at DESC);

-- 2nd-degree connection candidates: non-circle users that circle frequently replies to
CREATE OR REPLACE VIEW second_degree_candidates AS
SELECT in_reply_to_screen_name AS screen_name, COUNT(*) AS interaction_count
FROM circle_tweets
WHERE in_reply_to_screen_name IS NOT NULL
  AND in_reply_to_screen_name NOT IN (
    SELECT screen_name FROM social_circle WHERE screen_name IS NOT NULL
  )
GROUP BY in_reply_to_screen_name
HAVING COUNT(*) >= 3
ORDER BY interaction_count DESC;
