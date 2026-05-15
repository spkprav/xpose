#!/usr/bin/env node
// Harvest profile data (followers, following, bio, display_name) from raw_data RT chains.
// Many circle_tweets rows include the retweeted author's full profile inline — free enrichment.
// Run: node lib/wiki/enrich-from-rt.js   (or: npm run wiki:enrich-rt)

import pg from 'pg';

const DB_CONFIG = {
  host:     process.env.PGHOST     || 'localhost',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'xpose',
  port:     Number(process.env.PGPORT) || 54329,
  connectionTimeoutMillis: 5000,
  statement_timeout: 120000,
};

const SQL_HARVEST = `
WITH rt_authors AS (
  SELECT DISTINCT ON (r->>'rest_id')
    r->>'rest_id'                                              AS user_id,
    r->'core'->>'screen_name'                                  AS screen_name,
    r->'core'->>'name'                                         AS display_name,
    r->'legacy'->>'description'                                AS bio,
    NULLIF((r->'legacy'->>'followers_count'), '')::int         AS followers_count,
    NULLIF((r->'legacy'->>'friends_count'),  '')::int          AS following_count
  FROM circle_tweets,
       LATERAL (
         SELECT raw_data->'legacy'->'retweeted_status_result'->'result'
                ->'core'->'user_results'->'result' AS r
       ) sub
  WHERE raw_data->'legacy' ? 'retweeted_status_result'
    AND r IS NOT NULL
    AND r->'core'->>'screen_name' IS NOT NULL
)
INSERT INTO social_circle (
  user_id, screen_name, display_name, bio,
  followers_count, following_count, relationship, updated_at
)
SELECT
  user_id, screen_name, display_name, bio,
  COALESCE(followers_count, 0), COALESCE(following_count, 0),
  '2nd_degree', NOW()
FROM rt_authors
ON CONFLICT (screen_name) DO UPDATE SET
  user_id         = COALESCE(EXCLUDED.user_id, social_circle.user_id),
  display_name    = COALESCE(EXCLUDED.display_name, social_circle.display_name),
  bio             = CASE
    WHEN EXCLUDED.bio IS NOT NULL AND EXCLUDED.bio <> '' THEN EXCLUDED.bio
    ELSE social_circle.bio
  END,
  followers_count = CASE
    WHEN EXCLUDED.followers_count > 0 THEN EXCLUDED.followers_count
    ELSE social_circle.followers_count
  END,
  following_count = CASE
    WHEN EXCLUDED.following_count > 0 THEN EXCLUDED.following_count
    ELSE social_circle.following_count
  END,
  updated_at      = NOW()
RETURNING (xmax = 0) AS inserted, screen_name
;
`;

async function main() {
  const { Pool } = pg;
  const pool = new Pool(DB_CONFIG);

  console.log('Pre-state...');
  const { rows: pre } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM social_circle)                                       AS total,
      (SELECT COUNT(*) FROM social_circle WHERE followers_count > 0)             AS with_followers,
      (SELECT COUNT(*) FROM social_circle WHERE bio IS NOT NULL AND bio <> '')   AS with_bio
  `);
  console.table(pre);

  console.log('Harvesting RT-chain profiles...');
  const t0 = Date.now();
  const { rows } = await pool.query(SQL_HARVEST);
  const inserted = rows.filter(r => r.inserted).length;
  const updated  = rows.length - inserted;
  console.log(`  ${rows.length} rows touched: ${inserted} inserted, ${updated} updated (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log('Post-state...');
  const { rows: post } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM social_circle)                                       AS total,
      (SELECT COUNT(*) FROM social_circle WHERE followers_count > 0)             AS with_followers,
      (SELECT COUNT(*) FROM social_circle WHERE bio IS NOT NULL AND bio <> '')   AS with_bio
  `);
  console.table(post);

  const dFollowers = post[0].with_followers - pre[0].with_followers;
  const dBio       = post[0].with_bio       - pre[0].with_bio;
  const dTotal     = post[0].total          - pre[0].total;
  console.log(`Delta: +${dTotal} rows, +${dFollowers} now have followers, +${dBio} now have bio.`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
