const path = require('path');
const { Pool } = require('pg');
const { readEnvFile } = require('./neon-sync');

const ENV_FILE = path.resolve(__dirname, '../..', '.env');
const BATCH_SIZE = 100;
const GROUPS = [
  {
    table: 'tweets', timestamp: "COALESCE(fetched_at, created_at, '-infinity'::timestamp)",
    children: [
      ['tweet_analysis', "id::text"],
      ['tweet_actions', "id::text"],
    ],
  },
  {
    table: 'circle_tweets', timestamp: "COALESCE(fetched_at, created_at, '-infinity'::timestamp)",
    expiryFilter: `NOT EXISTS (
      SELECT 1 FROM circle_tweet_sources s
      WHERE s.tweet_id = t.id AND s.captured_at >= $1::timestamp
    )`,
    children: [
      ['circle_tweet_sources', "jsonb_build_array(tweet_id, source_list)::text"],
      ['circle_tweet_actions', "id::text"],
      ['list_tweet_scores', "tweet_id::text"],
    ],
  },
  { table: 'live_signals', timestamp: 'last_seen_at', filter: "kind = 'tweet'" },
  { table: 'tweets_history', timestamp: 'recorded_at' },
  { table: 'live_signals_history', timestamp: 'recorded_at', filter: "kind = 'tweet'" },
];

async function archiveBatch(cloud, archive, source, group, { cutoff, afterId }) {
  const { table, timestamp, filter = 'TRUE', expiryFilter = 'TRUE', children = [] } = group;
  const client = await cloud.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Stabilize dependent records until the archive commits and cascades finish.
    await client.query(`LOCK TABLE ${[table, ...children.map(([name]) => name)].join(', ')}
      IN SHARE ROW EXCLUSIVE MODE`);
    const copying = afterId !== undefined;
    const condition = copying
      ? `t.id > $1::bigint AND (${filter})`
      : `${timestamp} < $1::timestamp AND (${filter}) AND (${expiryFilter})`;
    const { rows } = await client.query(`
      SELECT id::text, to_jsonb(t)::text AS data FROM ${table} t
      WHERE ${condition}
      ORDER BY ${copying ? "t.id" : `${timestamp}, t.id`} LIMIT $2
    `, [copying ? afterId : cutoff, BATCH_SIZE]);
    let archived = 0;
    if (rows.length) {
      const ids = rows.map(row => row.id);
      const records = rows.map(row => [table, row.id, row.data]);
      for (const [name, key] of children) {
        const result = await client.query(`
          SELECT ${key} AS id, to_jsonb(t)::text AS data
          FROM ${name} t WHERE tweet_id = ANY($1::bigint[])
        `, [ids]);
        records.push(...result.rows.map(row => [name, row.id, row.data]));
      }
      // Keep JSON as text in transit so Postgres bigint IDs retain their precision.
      await archive.query(`
        INSERT INTO tweet_archive (source, table_name, row_key, data)
        SELECT $1, table_name, row_key, data::jsonb
        FROM unnest($2::text[], $3::text[], $4::text[]) AS r(table_name, row_key, data)
        ON CONFLICT (source, table_name, row_key) DO UPDATE SET data = EXCLUDED.data
      `, [source, records.map(row => row[0]), records.map(row => row[1]), records.map(row => row[2])]);
      archived = records.length;
      if (!copying) await client.query(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
    }
    await client.query('COMMIT');
    return { count: rows.length, lastId: rows.at(-1)?.id, archived };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createArchiveDatabase(archiveUrl) {
  const maintenanceUrl = new URL(archiveUrl);
  const database = decodeURIComponent(maintenanceUrl.pathname.slice(1));
  if (!database || ['postgres', 'template0', 'template1'].includes(database)) {
    throw new Error('TWEET_ARCHIVE_DB_URL must name a dedicated archive database');
  }
  maintenanceUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenanceUrl.href, connectionTimeoutMillis: 5000 });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!existing.rowCount) {
      const identifier = '"' + database.replaceAll('"', '""') + '"';
      await admin.query(`CREATE DATABASE ${identifier}`).catch(err => {
        if (err.code !== '42P04') throw err;
      });
    }
  } finally {
    await admin.end();
  }
}

async function retainTweets(db, { signal, passStartedAt, setup = false, onCopied } = {}) {
  const env = readEnvFile(ENV_FILE);
  const archiveUrl = (process.env.TWEET_ARCHIVE_DB_URL || env.TWEET_ARCHIVE_DB_URL || '').trim();
  const neonUrl = (process.env.NEON_DB_URL || env.NEON_DB_URL || '').trim();
  if (!archiveUrl || !neonUrl || signal?.aborted) return 0;

  const canonicalHost = url => new URL(url).hostname.replace('-pooler.', '.');
  const cloudHost = canonicalHost(neonUrl);
  if (canonicalHost(archiveUrl) === cloudHost || /\.neon\.tech$/i.test(canonicalHost(archiveUrl))) {
    throw new Error('TWEET_ARCHIVE_DB_URL must point to a separate local Postgres server');
  }
  const hours = Number(process.env.NEON_TWEET_RETENTION_HOURS || env.NEON_TWEET_RETENTION_HOURS || 24);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 8760) {
    throw new Error('NEON_TWEET_RETENTION_HOURS must be a whole number from 1 to 8760');
  }
  const windowStart = Date.now() - hours * 60 * 60 * 1000;
  const cutoff = new Date(Math.min(windowStart, passStartedAt ?? windowStart)).toISOString();

  if (setup) await createArchiveDatabase(archiveUrl);
  const cloud = db.getPool();
  const source = JSON.stringify([cloudHost, db.getConfig().database]);
  const archive = new Pool({ connectionString: archiveUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    await archive.query(`
      CREATE TABLE IF NOT EXISTS tweet_archive (
        source text NOT NULL,
        table_name text NOT NULL,
        row_key text NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY (source, table_name, row_key)
      )
    `);
    if (setup) {
      let copied = 0;
      for (const group of GROUPS) {
        let afterId = '-9223372036854775808';
        while (true) {
          const batch = await archiveBatch(cloud, archive, source, group, { afterId });
          copied += batch.archived;
          if (batch.count < BATCH_SIZE) break;
          afterId = batch.lastId;
        }
      }
      onCopied?.(copied);
    }
    let archived = 0;
    for (const group of GROUPS) {
      while (!signal?.aborted) {
        const { count } = await archiveBatch(cloud, archive, source, group, { cutoff });
        archived += count;
        if (count < BATCH_SIZE) break;
      }
    }
    return archived;
  } finally {
    await archive.end();
  }
}

module.exports = { retainTweets };
