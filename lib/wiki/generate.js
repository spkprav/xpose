#!/usr/bin/env node
// Generate Obsidian-flavored markdown wiki from circle_tweets + social_circle.
// Read-only against DB. Writes to social-wiki/.
// Run: node lib/wiki/generate.js   (or: npm run wiki:gen)

import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DB_CONFIG = {
  host:     process.env.PGHOST     || 'localhost',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'xpose',
  port:     Number(process.env.PGPORT) || 54329,
  connectionTimeoutMillis: 5000,
  statement_timeout: 120000,
};

const WIKI_ROOT       = path.join(REPO_ROOT, 'social-wiki');
const PEOPLE_DIR      = path.join(WIKI_ROOT, 'people');
const ORPHANS_DIR     = path.join(PEOPLE_DIR, '_orphans');
const TIERS_DIR       = path.join(WIKI_ROOT, 'tiers');
const CONNECTIONS_DIR = path.join(WIKI_ROOT, 'connections');

const DAYS_BACK         = 90;
const RECENT_LIMIT      = 10;
const TOP_TWEETS_LIMIT  = 5;
const TOP_NEIGHBORS     = 15;
const TOP_CO_MENTIONS   = 10;
const ORPHAN_MIN_INBOUND = 2;
const EDGE_LIST_TOP     = 200;
const SNIPPET_CHARS     = 200;

// Growth-mover / party-host classification.
// Goal: find circle members whose REPLIES land hard (likes/views), then trace
// which reply targets they hit. Those targets are the parties to join.
const GROWTH_MIN_REPLY_LIKES   = 100;   // total likes on replies (90d window)
const GROWTH_MIN_REPLIES       = 5;     // need a base of activity
const GROWTH_TOP_N             = 50;    // how many growth-movers to highlight
const PARTY_MIN_HOSTS_HIT_BY   = 2;     // # of growth-movers replying to that host
const PARTY_MIN_TOTAL_LIKES    = 50;    // cumulative likes on replies to that host

const score = (t) =>
  (t.like_count || 0) + (t.retweet_count || 0) * 2 + (t.quote_count || 0) * 3;

const tierOf = (followers) => {
  const f = Number(followers) || 0;
  if (f === 0)      return 'unknown';
  if (f < 1000)     return 'under-1k';
  if (f < 3000)     return '1k-3k';
  if (f < 5000)     return '3k-5k';
  if (f < 10000)    return '5k-10k';
  if (f < 100000)   return '10k-100k';
  if (f < 1000000)  return '100k-1m';
  return '1m-plus';
};

const safeName = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_');
const link     = (n) => `[[${safeName(n)}]]`;
const snippet  = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
const isoDate  = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function incrEdge(outer, k1, k2) {
  if (!k1 || !k2 || k1 === k2) return;
  let m = outer.get(k1);
  if (!m) { m = new Map(); outer.set(k1, m); }
  m.set(k2, (m.get(k2) || 0) + 1);
}

function topN(m, n) {
  if (!m) return [];
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function rmDirContents(dir) {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(entries.map((e) => fs.rm(path.join(dir, e), { recursive: true, force: true })));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

async function main() {
  const { Pool } = pg;
  const pool = new Pool(DB_CONFIG);

  console.log('Loading social_circle...');
  const { rows: circle } = await pool.query(`
    SELECT user_id, screen_name, display_name, bio,
           followers_count, following_count, relationship,
           last_crawled_at, crawl_priority
    FROM social_circle
    WHERE screen_name IS NOT NULL
  `);
  const circleMap = new Map(circle.map((r) => [r.screen_name, r]));
  console.log(`  ${circle.length} circle members`);

  // Blocked users from user_preferences. Marked on their page + excluded from list outputs.
  const { rows: blockedRows } = await pool.query(
    `SELECT user_screen_name FROM user_preferences WHERE is_blocked = TRUE`
  );
  const blockedSet = new Set(blockedRows.map(r => r.user_screen_name));
  console.log(`  ${blockedSet.size} blocked users (user_preferences)`);

  console.log(`Loading circle_tweets (last ${DAYS_BACK}d, non-retweet)...`);
  const { rows: tweets } = await pool.query(`
    SELECT id, screen_name, text, created_at, in_reply_to_screen_name,
           reply_count, like_count, retweet_count, quote_count, view_count,
           is_retweet,
           raw_data->'legacy'->'entities'->'user_mentions'   AS mentions,
           (raw_data->'legacy'->'entities'->'urls')          AS urls,
           (raw_data->'legacy'->'entities'->'media')         AS entity_media,
           (raw_data->'legacy'->'extended_entities'->'media') AS ext_media,
           (raw_data->'legacy'->>'is_quote_status')::bool    AS is_quote_status,
           raw_data->'legacy'->>'conversation_id_str'        AS conversation_id
    FROM circle_tweets
    WHERE is_retweet = FALSE
      AND created_at > NOW() - ($1 * INTERVAL '1 day')
  `, [DAYS_BACK]);
  console.log(`  ${tweets.length} tweets`);

  // Build tweet_id -> author map across ALL circle_tweets (not just window) so we can
  // resolve thread-root authors for replies whose root tweet may be older.
  console.log('Loading thread-root lookup (tweet_id -> author across full table)...');
  const { rows: idMap } = await pool.query(`
    SELECT id::text AS id, screen_name FROM circle_tweets WHERE screen_name IS NOT NULL
  `);
  const tweetIdToAuthor = new Map(idMap.map(r => [r.id, r.screen_name]));
  console.log(`  ${tweetIdToAuthor.size} tweet ids in lookup`);

  // Thread root resolution: prefer conversation_id_str -> root tweet's author.
  // Fall back to immediate parent (in_reply_to_screen_name) when root not in our DB.
  // For non-reply tweets, returns null.
  function threadRootAuthor(t) {
    if (!t.in_reply_to_screen_name) return null;          // not a reply
    const convId = t.conversation_id;
    if (convId && tweetIdToAuthor.has(convId)) {
      return tweetIdToAuthor.get(convId);                  // root author known
    }
    return t.in_reply_to_screen_name;                      // fallback
  }
  let rootResolved = 0, rootFallback = 0;
  for (const t of tweets) {
    if (!t.in_reply_to_screen_name) continue;
    if (t.conversation_id && tweetIdToAuthor.has(t.conversation_id)) rootResolved++;
    else rootFallback++;
  }
  console.log(`  thread root: ${rootResolved} resolved via conversation_id, ${rootFallback} fell back to immediate parent`);

  const repliesOut   = new Map();
  const repliesIn    = new Map();
  const mentionsOut  = new Map();
  const mentionsIn   = new Map();
  const coMentions   = new Map();
  const tweetsByAuthor = new Map();
  const referenced     = new Set();

  for (const t of tweets) {
    const author = t.screen_name;
    if (!author) continue;
    referenced.add(author);

    // Use THREAD ROOT (conversation host), not just immediate parent, for the reply graph.
    // The watering hole is whoever started the conversation, not the previous reply in chain.
    const tgt = threadRootAuthor(t);
    if (tgt && tgt !== author) {
      incrEdge(repliesOut, author, tgt);
      incrEdge(repliesIn, tgt, author);
      referenced.add(tgt);
    }

    const ments = Array.isArray(t.mentions)
      ? [...new Set(t.mentions.map((m) => m && m.screen_name).filter(Boolean))]
          .filter((m) => m !== author)
      : [];
    for (const m of ments) {
      incrEdge(mentionsOut, author, m);
      incrEdge(mentionsIn, m, author);
      referenced.add(m);
    }
    for (let i = 0; i < ments.length; i++) {
      for (let j = i + 1; j < ments.length; j++) {
        incrEdge(coMentions, ments[i], ments[j]);
        incrEdge(coMentions, ments[j], ments[i]);
      }
    }

    let arr = tweetsByAuthor.get(author);
    if (!arr) { arr = []; tweetsByAuthor.set(author, arr); }
    arr.push(t);
  }

  const recentTweets = new Map();
  const topTweets    = new Map();
  for (const [a, arr] of tweetsByAuthor) {
    const byDate = [...arr].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    recentTweets.set(a, byDate.slice(0, RECENT_LIMIT));
    const byScore = [...arr].sort((x, y) => score(y) - score(x));
    topTweets.set(a, byScore.slice(0, TOP_TWEETS_LIMIT));
  }

  // ──────────────────────────────────────────────────────────
  // Per-author engagement metrics (emitted into frontmatter)
  // ──────────────────────────────────────────────────────────
  function computeAuthorMetrics(arr) {
    const n = arr.length;
    if (!n) return null;
    const author = arr[0]?.screen_name;
    const likes  = arr.map((t) => t.like_count  || 0);
    const views  = arr.map((t) => t.view_count  || 0);
    const replys = arr.map((t) => t.reply_count || 0);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const avg = (xs) => (n ? sum(xs) / n : 0);
    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] || 0;
    };

    // OUTBOUND reply = reply to someone else (not self-thread continuation).
    // Self-replies are thread continuations and don't count as engagement with others.
    const isOutboundReply = (t) =>
      t.in_reply_to_screen_name && t.in_reply_to_screen_name !== author;
    const isSelfReply = (t) =>
      t.in_reply_to_screen_name && t.in_reply_to_screen_name === author;
    const replyOnes  = arr.filter(isOutboundReply).length;
    const threadOnes = arr.filter(isSelfReply).length;
    const soloOnes   = arr.filter((t) => !t.in_reply_to_screen_name && !t.is_retweet).length;

    // Breadth: distinct people they reply to (uses immediate parent — measures social reach).
    const distinctTargets = new Set();
    for (const t of arr) {
      if (isOutboundReply(t)) distinctTargets.add(t.in_reply_to_screen_name);
    }
    const uniqueReplyTargets = distinctTargets.size;
    const breadthRatio = replyOnes > 0 ? uniqueReplyTargets / replyOnes : 0;
    const quoteOnes = arr.filter((t) => t.is_quote_status).length;
    const mediaOnes = arr.filter((t) => {
      const e = Array.isArray(t.entity_media) ? t.entity_media.length : 0;
      const x = Array.isArray(t.ext_media)    ? t.ext_media.length    : 0;
      return (e + x) > 0;
    }).length;
    const urlOnes   = arr.filter((t) => Array.isArray(t.urls) && t.urls.length > 0).length;
    const medianL   = median(likes);
    const viralN    = arr.filter((t) => (t.like_count || 0) > Math.max(10, medianL * 10)).length;
    const textLen   = avg(arr.map((t) => (t.text || '').length));

    // Timing: post volume + engagement by hour-of-day and day-of-week (IST = UTC+5:30)
    const hourFreqUtc = new Map();
    const hourFreqIst = new Map();
    const dowFreqIst  = new Map();
    const hourLikesIst = new Map();
    const dowLikesIst  = new Map();
    for (const t of arr) {
      const d = new Date(t.created_at);
      const hUtc = d.getUTCHours();
      // IST shift: add 5.5h
      const istMs = d.getTime() + (5 * 60 + 30) * 60 * 1000;
      const dIst = new Date(istMs);
      const hIst = dIst.getUTCHours();
      const dowIst = dIst.getUTCDay();  // 0 = Sun
      const likes = t.like_count || 0;
      hourFreqUtc.set(hUtc, (hourFreqUtc.get(hUtc) || 0) + 1);
      hourFreqIst.set(hIst, (hourFreqIst.get(hIst) || 0) + 1);
      dowFreqIst.set(dowIst, (dowFreqIst.get(dowIst) || 0) + 1);
      hourLikesIst.set(hIst, (hourLikesIst.get(hIst) || 0) + likes);
      dowLikesIst.set(dowIst, (dowLikesIst.get(dowIst) || 0) + likes);
    }
    const peakHour    = [...hourFreqUtc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const peakHourIst = [...hourFreqIst.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const peakDayIst  = [...dowFreqIst.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const top3HoursIst = [...hourFreqIst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
    const bestLikesHourIst = [...hourLikesIst.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const bestLikesDayIst  = [...dowLikesIst.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      engagement_depth: +(avg(replys) / (avg(likes) + 1)).toFixed(3),
      reply_ratio:      +(replyOnes / n).toFixed(2),
      solo_rate:        +(soloOnes / n).toFixed(2),
      quote_rate:       +(quoteOnes / n).toFixed(2),
      media_rate:       +(mediaOnes / n).toFixed(2),
      url_rate:         +(urlOnes / n).toFixed(2),
      viral_hits_90d:   viralN,
      median_likes:     medianL,
      median_views:     median(views),
      avg_text_len:     Math.round(textLen),
      peak_hour_utc:    peakHour,
      replies_90d:      replyOnes,    // outbound replies only (excludes self-threads)
      threads_90d:      threadOnes,   // self-replies (own-thread continuations)
      unique_reply_targets_90d: uniqueReplyTargets,
      reply_breadth_ratio: +breadthRatio.toFixed(2),
      peak_hour_ist:        peakHourIst,
      peak_day_ist:         peakDayIst,
      top_3_post_hours_ist: top3HoursIst,
      best_likes_hour_ist:  bestLikesHourIst,
      best_likes_day_ist:   bestLikesDayIst,
    };
  }

  const authorMetrics = new Map();
  for (const [a, arr] of tweetsByAuthor) {
    const m = computeAuthorMetrics(arr);
    if (m) authorMetrics.set(a, m);
  }

  // top_co_repliers per author: people who reply to the same hubs this author replies to
  function computeCoRepliers(sn) {
    const myHubs = repliesOut.get(sn);
    if (!myHubs) return [];
    const tally = new Map();
    for (const [hub] of myHubs) {
      const repliers = repliesIn.get(hub);
      if (!repliers) continue;
      for (const [who, n] of repliers) {
        if (who === sn) continue;
        tally.set(who, (tally.get(who) || 0) + n);
      }
    }
    return topN(tally, 5).map(([who]) => who);
  }

  // ──────────────────────────────────────────────────────────
  // Preserve bucket / bucket_override across regen (read existing pages BEFORE wipe)
  // ──────────────────────────────────────────────────────────
  const preservedBuckets = new Map(); // sn -> { bucket, bucket_override, bucket_reason, bucket_confidence }
  try {
    const existing = await fs.readdir(PEOPLE_DIR);
    for (const fname of existing) {
      if (!fname.endsWith('.md')) continue;
      const fp = path.join(PEOPLE_DIR, fname);
      let body;
      try { body = await fs.readFile(fp, 'utf8'); } catch { continue; }
      const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      const get = (key) => {
        const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
        return m ? m[1].replace(/^["']|["']$/g, '') : null;
      };
      const sn = get('screen_name');
      if (!sn) continue;
      const entry = {};
      const b = get('bucket');                if (b) entry.bucket = b;
      const o = get('bucket_override');       if (o) entry.bucket_override = o;
      const r = get('bucket_reason');         if (r) entry.bucket_reason = r;
      const c = get('bucket_confidence');     if (c) entry.bucket_confidence = c;
      if (Object.keys(entry).length) preservedBuckets.set(sn, entry);
    }
    console.log(`  Preserved buckets for ${preservedBuckets.size} people (across regen)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Bucket preservation read failed:', e.message);
  }

  function effectiveBucket(sn) {
    const e = preservedBuckets.get(sn);
    if (!e) return null;
    return e.bucket_override || e.bucket || null;
  }

  // ──────────────────────────────────────────────────────────
  // Growth-mover / party-host classification.
  // For each circle member: aggregate engagement on their REPLY tweets.
  // Top performers = growth-movers. Their reply targets = party-hosts.
  // ──────────────────────────────────────────────────────────
  console.log('Computing growth-mover / party-host signals...');

  // Per-author reply stats (only counts reply tweets, ignores standalone tweets)
  // Targets here are THREAD ROOTS (conversation hosts), not immediate-parent replies.
  const authorReplyStats = new Map(); // sn -> { replies, likes, views, targets: Map<host, {count, likes, views}> }

  for (const t of tweets) {
    const author = t.screen_name;
    const tgt    = threadRootAuthor(t);
    if (!author || !tgt) continue;
    if (author === tgt) continue;
    // Restrict growth-mover universe to social_circle members (you can replicate their pattern)
    if (!circleMap.has(author)) continue;
    if (blockedSet.has(author)) continue;

    let s = authorReplyStats.get(author);
    if (!s) { s = { replies: 0, likes: 0, views: 0, targets: new Map() }; authorReplyStats.set(author, s); }
    s.replies++;
    s.likes += (t.like_count || 0);
    s.views += (t.view_count || 0);
    let tgtStats = s.targets.get(tgt);
    if (!tgtStats) { tgtStats = { count: 0, likes: 0, views: 0 }; s.targets.set(tgt, tgtStats); }
    tgtStats.count++;
    tgtStats.likes += (t.like_count || 0);
    tgtStats.views += (t.view_count || 0);
  }

  // Rank growth-movers
  const growthMoverList = [...authorReplyStats.entries()]
    .filter(([, s]) => s.replies >= GROWTH_MIN_REPLIES && s.likes >= GROWTH_MIN_REPLY_LIKES)
    .map(([sn, s]) => ({ sn, ...s, avg_likes_per_reply: s.likes / s.replies }))
    .sort((a, b) => b.likes - a.likes);
  const growthMovers = new Map(growthMoverList.slice(0, GROWTH_TOP_N).map(g => [g.sn, g]));
  console.log(`  ${growthMovers.size} growth-movers (of ${authorReplyStats.size} circle members with reply data)`);

  // Aggregate party-hosts: reply targets hit by ≥N growth-movers, ≥M total likes from their replies
  const partyHostMap = new Map(); // host -> { hitBy: Set<growth-mover>, total_likes, total_views, total_replies, top_movers: Map }
  for (const [moverSn, stats] of growthMovers) {
    for (const [host, tgtStats] of stats.targets) {
      let p = partyHostMap.get(host);
      if (!p) { p = { hitBy: new Set(), total_likes: 0, total_views: 0, total_replies: 0, mover_breakdown: new Map() }; partyHostMap.set(host, p); }
      p.hitBy.add(moverSn);
      p.total_likes   += tgtStats.likes;
      p.total_views   += tgtStats.views;
      p.total_replies += tgtStats.count;
      p.mover_breakdown.set(moverSn, tgtStats);
    }
  }
  const partyHosts = new Map();
  for (const [host, p] of partyHostMap) {
    if (blockedSet.has(host)) continue;
    if (p.hitBy.size >= PARTY_MIN_HOSTS_HIT_BY && p.total_likes >= PARTY_MIN_TOTAL_LIKES) {
      partyHosts.set(host, p);
    }
  }
  console.log(`  ${partyHosts.size} party-hosts (hit by ≥${PARTY_MIN_HOSTS_HIT_BY} growth-movers, ≥${PARTY_MIN_TOTAL_LIKES} cumulative likes)`);

  function classifyRoles(sn) {
    const tags = [];
    if (!sn) return tags;
    if (growthMovers.has(sn)) tags.push('role/growth-mover');
    if (partyHosts.has(sn))   tags.push('role/party-host');
    return tags;
  }

  console.log('Resetting output dirs (preserving people/ for concurrent classifier safety)...');
  // NOTE: PEOPLE_DIR (and ORPHANS_DIR which lives inside it) are NOT wiped.
  // Person pages overwrite in place — concurrent classifier never hits a missing file.
  // Stale pages (for people removed from social_circle) may persist; acceptable trade-off.
  await rmDirContents(TIERS_DIR);
  await rmDirContents(CONNECTIONS_DIR);
  await fs.mkdir(PEOPLE_DIR,      { recursive: true });
  await fs.mkdir(ORPHANS_DIR,     { recursive: true });
  await fs.mkdir(TIERS_DIR,       { recursive: true });
  await fs.mkdir(CONNECTIONS_DIR, { recursive: true });

  // ----- circle people pages -----
  let circleWritten = 0;
  for (const m of circle) {
    const sn = m.screen_name;
    if (!sn) continue;
    const tier  = tierOf(m.followers_count);
    const rel   = m.relationship || '2nd_degree';
    const lines = [];

    lines.push('---');
    lines.push(`screen_name: ${sn}`);
    if (m.display_name) lines.push(`display_name: ${JSON.stringify(m.display_name)}`);
    if (m.user_id)      lines.push(`user_id: "${m.user_id}"`);
    lines.push(`followers: ${m.followers_count || 0}`);
    lines.push(`following: ${m.following_count || 0}`);
    lines.push(`tier: ${tier}`);
    lines.push(`relationship: ${rel}`);
    lines.push(`last_crawled: ${isoDate(m.last_crawled_at) || 'null'}`);
    lines.push(`tweets_collected: ${(tweetsByAuthor.get(sn) || []).length}`);
    const isBlocked = blockedSet.has(sn);
    if (isBlocked) lines.push('blocked: true');
    const roleTags = classifyRoles(sn);
    // preserved bucket from prior LLM run (or manual override)
    const preserved = preservedBuckets.get(sn) || {};
    const bucketEffective = preserved.bucket_override || preserved.bucket || null;
    const bucketTag = bucketEffective ? [`bucket/${bucketEffective}`] : [];
    const blockedTag = isBlocked ? ['blocked'] : [];
    const allTags = [`tier/${tier}`, `rel/${rel}`, ...roleTags, ...bucketTag, ...blockedTag];
    lines.push(`tags: [${allTags.join(', ')}]`);
    if (roleTags.length) lines.push(`roles: [${roleTags.map(r => r.replace('role/', '')).join(', ')}]`);
    if (preserved.bucket)            lines.push(`bucket: ${preserved.bucket}`);
    if (preserved.bucket_override)   lines.push(`bucket_override: ${preserved.bucket_override}`);
    if (preserved.bucket_confidence) lines.push(`bucket_confidence: ${preserved.bucket_confidence}`);
    if (preserved.bucket_reason)     lines.push(`bucket_reason: ${JSON.stringify(preserved.bucket_reason)}`);

    // Per-author engagement metrics
    const am = authorMetrics.get(sn);
    if (am) {
      lines.push(`engagement_depth: ${am.engagement_depth}`);
      lines.push(`reply_ratio: ${am.reply_ratio}`);
      lines.push(`solo_rate: ${am.solo_rate}`);
      lines.push(`quote_rate: ${am.quote_rate}`);
      lines.push(`media_rate: ${am.media_rate}`);
      lines.push(`url_rate: ${am.url_rate}`);
      lines.push(`viral_hits_90d: ${am.viral_hits_90d}`);
      lines.push(`median_likes: ${am.median_likes}`);
      lines.push(`median_views: ${am.median_views}`);
      lines.push(`avg_text_len: ${am.avg_text_len}`);
      if (am.peak_hour_utc !== null) lines.push(`peak_hour_utc: ${am.peak_hour_utc}`);
      if (am.peak_hour_ist !== null) lines.push(`peak_hour_ist: ${am.peak_hour_ist}`);
      if (am.peak_day_ist  !== null) lines.push(`peak_day_ist: ${am.peak_day_ist}`);
      if (am.top_3_post_hours_ist?.length) lines.push(`top_3_post_hours_ist: [${am.top_3_post_hours_ist.join(', ')}]`);
      if (am.best_likes_hour_ist !== null) lines.push(`best_likes_hour_ist: ${am.best_likes_hour_ist}`);
      if (am.best_likes_day_ist  !== null) lines.push(`best_likes_day_ist: ${am.best_likes_day_ist}`);
      lines.push(`replies_90d: ${am.replies_90d}`);
      lines.push(`threads_90d: ${am.threads_90d}`);
      lines.push(`unique_reply_targets_90d: ${am.unique_reply_targets_90d}`);
      lines.push(`reply_breadth_ratio: ${am.reply_breadth_ratio}`);
    }
    // Top reply targets + co-repliers (max 5 each)
    const topTargets = topN(repliesOut.get(sn), 5).map(([t]) => t);
    if (topTargets.length) lines.push(`top_reply_targets: [${topTargets.join(', ')}]`);
    const coReps = computeCoRepliers(sn);
    if (coReps.length) lines.push(`top_co_repliers: [${coReps.join(', ')}]`);

    // Reply engagement stats for ANY circle author who has reply activity (not just top growth-movers).
    const replyStats = authorReplyStats.get(sn);
    if (replyStats && replyStats.replies > 0) {
      lines.push(`reply_likes_90d: ${replyStats.likes}`);
      lines.push(`reply_views_90d: ${replyStats.views}`);
      lines.push(`avg_likes_per_reply: ${(replyStats.likes / replyStats.replies).toFixed(1)}`);
    }
    const party = partyHosts.get(sn);
    if (party) {
      lines.push(`party_hit_by: ${party.hitBy.size}`);
      lines.push(`party_total_likes: ${party.total_likes}`);
      lines.push(`party_total_replies: ${party.total_replies}`);
    }
    lines.push('---');
    lines.push('');
    lines.push(`# ${link(sn)}`);
    lines.push('');
    if (m.display_name) lines.push(`**${m.display_name}**`, '');
    if (m.bio)          lines.push(`> ${m.bio.replace(/\n+/g, ' ')}`, '');

    const ratio = m.following_count > 0
      ? (m.followers_count / m.following_count).toFixed(1)
      : 'n/a';
    lines.push('## Stats');
    lines.push(`- **Followers:** ${(m.followers_count || 0).toLocaleString()}`);
    lines.push(`- **Following:** ${(m.following_count || 0).toLocaleString()}`);
    lines.push(`- **Ratio:** ${ratio}`);
    lines.push(`- **Tier:** [[tiers/${tier}|${tier}]]`);
    lines.push(`- **Relationship:** ${rel}`);
    lines.push(`- **Last crawled:** ${isoDate(m.last_crawled_at) || 'never'}`);
    lines.push('');

    const sections = [
      ['Replies to (top 15)',         topN(repliesOut.get(sn),  TOP_NEIGHBORS)],
      ['Replied to by (top 15)',      topN(repliesIn.get(sn),   TOP_NEIGHBORS)],
      ['Mentions (top 15)',           topN(mentionsOut.get(sn), TOP_NEIGHBORS)],
      ['Mentioned by (top 15)',       topN(mentionsIn.get(sn),  TOP_NEIGHBORS)],
      ['Co-mentioned with (top 10)',  topN(coMentions.get(sn),  TOP_CO_MENTIONS)],
    ];
    for (const [title, edges] of sections) {
      if (!edges.length) continue;
      lines.push(`## ${title}`);
      for (const [target, n] of edges) lines.push(`- ${link(target)} — ${n}×`);
      lines.push('');
    }

    const rec = recentTweets.get(sn) || [];
    if (rec.length) {
      lines.push('## Recent tweets');
      for (const t of rec) {
        lines.push(`- ${isoDate(t.created_at)} — "${snippet(t.text)}" — ♥${t.like_count || 0} · 🔁${t.retweet_count || 0} · 💬${t.reply_count || 0}`);
      }
      lines.push('');
    }
    const top = topTweets.get(sn) || [];
    if (top.length) {
      lines.push(`## Top tweets (last ${DAYS_BACK}d)`);
      for (const t of top) {
        lines.push(`- ${isoDate(t.created_at)} — "${snippet(t.text)}" — score ${score(t)}`);
      }
      lines.push('');
    }

    await fs.writeFile(path.join(PEOPLE_DIR, `${safeName(sn)}.md`), lines.join('\n'));
    circleWritten++;
  }
  console.log(`  ${circleWritten} circle pages`);

  // ----- orphan pages -----
  let orphansWritten = 0;
  for (const sn of referenced) {
    if (!sn || circleMap.has(sn)) continue;
    const ri = topN(repliesIn.get(sn), 20);
    const mi = topN(mentionsIn.get(sn), 20);
    const inbound = ri.reduce((a, [, n]) => a + n, 0) + mi.reduce((a, [, n]) => a + n, 0);
    if (inbound < ORPHAN_MIN_INBOUND) continue;

    const lines = [];
    lines.push('---');
    lines.push(`screen_name: ${sn}`);
    lines.push('orphan: true');
    lines.push(`inbound_replies: ${ri.reduce((a, [, n]) => a + n, 0)}`);
    lines.push(`inbound_mentions: ${mi.reduce((a, [, n]) => a + n, 0)}`);
    const orphanRoles = classifyRoles(sn);
    const orphanTags = ['orphan', ...orphanRoles];
    lines.push(`tags: [${orphanTags.join(', ')}]`);
    if (orphanRoles.length) lines.push(`roles: [${orphanRoles.map(r => r.replace('role/', '')).join(', ')}]`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${link(sn)}`);
    lines.push('');
    lines.push('Not in social_circle — discovered via replies/mentions only. Enrichment candidate.');
    lines.push('');
    if (ri.length) {
      lines.push('## Replied to by');
      for (const [t, n] of ri) lines.push(`- ${link(t)} — ${n}×`);
      lines.push('');
    }
    if (mi.length) {
      lines.push('## Mentioned by');
      for (const [t, n] of mi) lines.push(`- ${link(t)} — ${n}×`);
      lines.push('');
    }
    await fs.writeFile(path.join(ORPHANS_DIR, `${safeName(sn)}.md`), lines.join('\n'));
    orphansWritten++;
  }
  console.log(`  ${orphansWritten} orphan pages (min inbound ${ORPHAN_MIN_INBOUND})`);

  // ----- tier pages -----
  const byTier = new Map();
  for (const m of circle) {
    if (!m.screen_name) continue;
    const t = tierOf(m.followers_count);
    let arr = byTier.get(t);
    if (!arr) { arr = []; byTier.set(t, arr); }
    arr.push(m);
  }
  for (const [t, arr] of byTier) {
    const buckets = { mutual: [], following: [], follower: [], '2nd_degree': [] };
    for (const m of arr) {
      const rel = m.relationship || '2nd_degree';
      (buckets[rel] = buckets[rel] || []).push(m);
    }
    const lines = [
      '---',
      `tier: ${t}`,
      `count: ${arr.length}`,
      'tags: [tier]',
      '---',
      '',
      `# Tier: ${t}`,
      '',
      `${arr.length} accounts.`,
      '',
    ];
    for (const rel of ['mutual', 'following', 'follower', '2nd_degree']) {
      const list = (buckets[rel] || []).sort((a, b) => (b.followers_count || 0) - (a.followers_count || 0));
      if (!list.length) continue;
      lines.push(`## ${rel} (${list.length})`);
      for (const m of list) {
        const dn = m.display_name ? ` — ${m.display_name}` : '';
        lines.push(`- ${link(m.screen_name)}${dn} — ${(m.followers_count || 0).toLocaleString()} followers`);
      }
      lines.push('');
    }
    await fs.writeFile(path.join(TIERS_DIR, `${t}.md`), lines.join('\n'));
  }
  console.log(`  ${byTier.size} tier pages`);

  // ----- connection summaries -----
  const flatten = (outer) => {
    const flat = [];
    for (const [a, mp] of outer) for (const [b, n] of mp) flat.push([a, b, n]);
    return flat.sort((x, y) => y[2] - x[2]);
  };
  const writeEdges = async (file, title, edges) => {
    const lines = [
      '---',
      `count: ${edges.length}`,
      'tags: [connections]',
      '---',
      '',
      `# ${title}`,
      '',
      `Top ${Math.min(EDGE_LIST_TOP, edges.length)} of ${edges.length} edges.`,
      '',
    ];
    for (const [a, b, n] of edges.slice(0, EDGE_LIST_TOP)) {
      lines.push(`- ${link(a)} → ${link(b)} — ${n}×`);
    }
    await fs.writeFile(path.join(CONNECTIONS_DIR, file), lines.join('\n'));
  };
  await writeEdges('top-replies.md',  'Top reply edges',      flatten(repliesOut));
  await writeEdges('top-mentions.md', 'Top mention edges',    flatten(mentionsOut));

  const seen = new Set();
  const coEdges = [];
  for (const [a, mp] of coMentions) {
    for (const [b, n] of mp) {
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = `${lo}|${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      coEdges.push([lo, hi, n]);
    }
  }
  coEdges.sort((x, y) => y[2] - x[2]);
  await writeEdges('co-mentions.md', 'Top co-mention pairs', coEdges);

  // ----- growth-movers / party-hosts summaries -----
  // Bucket filter helper: when buckets exist, narrow to (niche, adjacent). Otherwise pass-through.
  const NICHE_OK = new Set(['niche', 'adjacent']);
  const hasAnyBuckets = preservedBuckets.size > 0;
  const inNiche = (sn) => {
    if (!hasAnyBuckets) return true;
    const b = effectiveBucket(sn);
    return !b || NICHE_OK.has(b); // unclassified passes through; only filter explicit non-niche
  };

  // Growth-movers: circle members whose replies pull engagement.
  {
    const filtered = growthMoverList.filter(g => inNiche(g.sn));
    const lines = [
      '---', `count: ${filtered.length}`, 'tags: [connections, growth-movers]', '---',
      '',
      `# Growth-movers — circle members crushing replies (last ${DAYS_BACK}d)`,
      '',
      'These are the people in your circle whose REPLY tweets get the most engagement.',
      'Study their reply targets, style, timing. Copy the pattern.',
      '',
      `Thresholds: ≥${GROWTH_MIN_REPLIES} replies, ≥${GROWTH_MIN_REPLY_LIKES} total likes on replies.`,
      hasAnyBuckets ? `Bucket filter: niche + adjacent (buckets exist for ${preservedBuckets.size} people).` : 'Bucket filter: OFF (no buckets yet — run wiki:bucket).',
      '',
      '| # | Mover | Bucket | Replies | Total likes | Total views | Avg likes/reply | Top reply targets |',
      '|--|--|--|--|--|--|--|--|',
    ];
    filtered.slice(0, EDGE_LIST_TOP).forEach((g, i) => {
      const topTargets = [...g.targets.entries()]
        .sort((a, b) => b[1].likes - a[1].likes)
        .slice(0, 3)
        .map(([h, s]) => `${link(h)} (${s.likes}♥)`)
        .join(', ');
      const b = effectiveBucket(g.sn) || '—';
      lines.push(`| ${i + 1} | ${link(g.sn)} | ${b} | ${g.replies} | ${g.likes} | ${g.views} | ${g.avg_likes_per_reply.toFixed(1)} | ${topTargets} |`);
    });
    await fs.writeFile(path.join(CONNECTIONS_DIR, 'growth-movers.md'), lines.join('\n'));
  }

  // Party-hosts: aggregated reply targets hit by multiple growth-movers.
  // When buckets exist, only count contributions from niche/adjacent movers AND drop hosts with bucket=shitposter/noise.
  const partyRows = [...partyHosts.entries()].map(([host, p]) => {
    const moversFiltered = [...p.mover_breakdown.entries()]
      .filter(([sn]) => inNiche(sn))
      .sort((a, b) => b[1].likes - a[1].likes);
    const hitBy   = moversFiltered.length;
    const likes   = moversFiltered.reduce((a, [, s]) => a + s.likes, 0);
    const views   = moversFiltered.reduce((a, [, s]) => a + s.views, 0);
    const replies = moversFiltered.reduce((a, [, s]) => a + s.count, 0);
    return { host, hitBy, likes, views, replies,
             avg_likes_per_reply: replies > 0 ? likes / replies : 0,
             moverList: moversFiltered };
  })
  .filter(r => r.hitBy >= PARTY_MIN_HOSTS_HIT_BY && r.likes >= PARTY_MIN_TOTAL_LIKES)
  .filter(r => {
    if (!hasAnyBuckets) return true;
    const b = effectiveBucket(r.host);
    return !b || NICHE_OK.has(b);
  })
  .sort((a, b) => b.likes - a.likes);
  {
    const lines = [
      '---', `count: ${partyRows.length}`, 'tags: [connections, party-hosts]', '---',
      '',
      '# Party-hosts — where the growth-movers are gathering',
      '',
      'Reply-target accounts where multiple growth-movers from your circle keep showing up AND getting traction.',
      'Reply here. Your circle is already proving the venue works.',
      '',
      `Thresholds: hit by ≥${PARTY_MIN_HOSTS_HIT_BY} growth-movers, ≥${PARTY_MIN_TOTAL_LIKES} cumulative likes.`,
      hasAnyBuckets ? 'Bucket filter: only niche/adjacent movers count, off-niche hosts dropped.' : 'Bucket filter: OFF.',
      '',
      '| # | Host | Host bucket | Movers replying | Total replies | Total likes | Avg likes/reply | Movers (top by likes) |',
      '|--|--|--|--|--|--|--|--|',
    ];
    partyRows.slice(0, EDGE_LIST_TOP).forEach((row, i) => {
      const movers = row.moverList.slice(0, 5)
        .map(([sn, s]) => `${link(sn)}(${s.likes}♥)`)
        .join(', ');
      const b = effectiveBucket(row.host) || '—';
      lines.push(`| ${i + 1} | ${link(row.host)} | ${b} | ${row.hitBy} | ${row.replies} | ${row.likes} | ${row.avg_likes_per_reply.toFixed(1)} | ${movers} |`);
    });
    await fs.writeFile(path.join(CONNECTIONS_DIR, 'party-hosts.md'), lines.join('\n'));
  }

  console.log(`  5 connection summaries (incl. growth-movers, party-hosts)`);

  // ----- timing analysis MOVED to lib/wiki/lists.js (scoped to actual list members) -----
  if (false) {
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // 24h × 7d matrices for niche+adjacent only (your engagement universe)
    const NICHE_OK = new Set(['niche', 'adjacent']);
    const inNicheBucket = (sn) => {
      const b = effectiveBucket(sn);
      return b && NICHE_OK.has(b);
    };

    const postsMat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const likesMat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let totalPosts = 0, totalLikes = 0;
    let nicheAuthors = 0;
    const seenAuthor = new Set();

    for (const t of tweets) {
      if (!t.screen_name) continue;
      if (!inNicheBucket(t.screen_name)) continue;
      if (!seenAuthor.has(t.screen_name)) { nicheAuthors++; seenAuthor.add(t.screen_name); }
      const d = new Date(t.created_at);
      const istMs = d.getTime() + (5 * 60 + 30) * 60 * 1000;
      const dIst = new Date(istMs);
      const h = dIst.getUTCHours();
      const dow = dIst.getUTCDay();
      const likes = t.like_count || 0;
      postsMat[dow][h]++;
      likesMat[dow][h] += likes;
      totalPosts++;
      totalLikes += likes;
    }

    const fmtRow = (label, row) => `| ${label.padEnd(3)} | ${row.join(' | ')} |`;
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    const head1 = `| Day | ${hours.join(' | ')} |`;
    const head2 = `|--|${'--|'.repeat(24)}`;

    // Heatmap: highlight top quartile cells
    function heatmapRow(label, row, q3) {
      const cells = row.map(v => v >= q3 && v > 0 ? `**${v}**` : (v > 0 ? String(v) : '·'));
      return `| ${label} | ${cells.join(' | ')} |`;
    }
    const allPostsFlat = postsMat.flat().filter(v => v > 0).sort((a, b) => a - b);
    const allLikesFlat = likesMat.flat().filter(v => v > 0).sort((a, b) => a - b);
    const q3Posts = allPostsFlat[Math.floor(allPostsFlat.length * 0.75)] || 0;
    const q3Likes = allLikesFlat[Math.floor(allLikesFlat.length * 0.75)] || 0;

    // Top windows
    const cellsLikes = [];
    const cellsPosts = [];
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        cellsLikes.push({ d, h, v: likesMat[d][h] });
        cellsPosts.push({ d, h, v: postsMat[d][h] });
      }
    }
    cellsLikes.sort((a, b) => b.v - a.v);
    cellsPosts.sort((a, b) => b.v - a.v);

    const lines = [
      '---', 'tags: [connections, timing]', '---',
      '',
      '# Posting & engagement timing (IST)',
      '',
      `Across **${nicheAuthors}** niche/adjacent authors in last ${DAYS_BACK}d.`,
      `Total posts: **${totalPosts.toLocaleString()}** · Total likes earned: **${totalLikes.toLocaleString()}**.`,
      `Times shown in **IST (UTC+5:30)**. Cells **bolded** = top quartile.`,
      '',
      '## Best windows to POST (when your audience is most active)',
      '',
      'Top 10 hour-of-day × day-of-week windows by post volume (= when niche people are on X):',
      '',
      '| # | Day | Hour IST | Posts |',
      '|--|--|--|--|',
      ...cellsPosts.slice(0, 10).map((c, i) => `| ${i + 1} | ${DOW[c.d]} | ${String(c.h).padStart(2,'0')}:00 | ${c.v} |`),
      '',
      '## Best windows by ENGAGEMENT (when posts here earn most likes)',
      '',
      'Top 10 hour-of-day × day-of-week windows by total likes earned:',
      '',
      '| # | Day | Hour IST | Likes |',
      '|--|--|--|--|',
      ...cellsLikes.slice(0, 10).map((c, i) => `| ${i + 1} | ${DOW[c.d]} | ${String(c.h).padStart(2,'0')}:00 | ${c.v.toLocaleString()} |`),
      '',
      '## Post-volume heatmap (Day × Hour IST)',
      '',
      head1, head2,
      ...DOW.map((d, i) => heatmapRow(d, postsMat[i], q3Posts)),
      '',
      '## Engagement heatmap (likes earned, Day × Hour IST)',
      '',
      head1, head2,
      ...DOW.map((d, i) => heatmapRow(d, likesMat[i], q3Likes)),
      '',
      '## How to use',
      '',
      '- **Post your originals** in the top engagement window. That\'s when audience is online and likes flow.',
      '- **Reply during top volume windows.** That\'s when fresh tweets land + you have surface area to engage.',
      '- **Batch X time** to your top 2-3 IST hours. Skip dead hours entirely.',
      '- **Day skew matters**: Saturday and Sunday usually differ from weekdays. Check the heatmap before scheduling.',
      '',
    ];
    await fs.writeFile(path.join(CONNECTIONS_DIR, 'timing.md'), lines.join('\n'));
    console.log(`  timing.md (${nicheAuthors} niche/adjacent authors, ${totalPosts} posts)`);
  }

  // ----- graph-filters guide -----
  const filtersDoc = [
    '---', 'tags: [guide]', '---', '',
    '# Graph filters — finding the party in your circle',
    '',
    `**Strategy:** identify circle members whose replies get traction (growth-movers), trace where they reply (party-hosts), then replicate by replying there yourself.`,
    '',
    `Window: last ${DAYS_BACK} days.`,
    '',
    '## Person roles (frontmatter `tags`)',
    '',
    '| Tag | Meaning |',
    '|--|--|',
    `| \`role/growth-mover\` | Circle member with ≥${GROWTH_MIN_REPLIES} replies and ≥${GROWTH_MIN_REPLY_LIKES} total likes on replies |`,
    `| \`role/party-host\` | Reply target hit by ≥${PARTY_MIN_HOSTS_HIT_BY} growth-movers with ≥${PARTY_MIN_TOTAL_LIKES} cumulative likes |`,
    '| `rel/mutual`, `rel/follower`, `rel/following`, `rel/2nd_degree` | Direct relationship |',
    '| `tier/under-1k` … `tier/1m-plus` | Follower-count bucket |',
    '| `orphan` | Referenced via replies/mentions but not in social_circle |',
    '',
    '## Obsidian graph filters',
    '',
    'Open graph view → Filters → Search. Paste a query:',
    '',
    '### The party map (who in your circle moves, and where)',
    '```',
    'tag:role/growth-mover OR tag:role/party-host',
    '```',
    '→ Two clusters of nodes. Edges between them show which growth-mover replies to which host. Reply alongside them.',
    '',
    '### Just the venues to crash',
    '```',
    'tag:role/party-host',
    '```',
    '→ The list of accounts where your circle is making the most noise. Reply at these accounts. Frequency matters.',
    '',
    '### Just the growth-movers (people to study)',
    '```',
    'tag:role/growth-mover',
    '```',
    '→ Open each page. Read their `Recent tweets` and `Replies to` sections. Pattern-match the style + topic + timing.',
    '',
    '### High-tier party-hosts (max-reach venues)',
    '```',
    'tag:role/party-host AND (tag:tier/100k-1m OR tag:tier/1m-plus)',
    '```',
    '',
    '### Growth-movers you don\'t follow yet',
    '```',
    'tag:role/growth-mover AND tag:rel/2nd_degree',
    '```',
    '→ Worth following. They\'re already proving the strategy works.',
    '',
    '## Color groups (Settings → Graph view → Color groups)',
    '',
    '- `tag:#role/party-host` → orange (the venues)',
    '- `tag:#role/growth-mover` → green (the movers)',
    '- `tag:#tier/1m-plus` → gold (mega accounts)',
    '- `tag:#tier/100k-1m` → silver',
    '- `tag:#rel/mutual` → light blue',
    '- `tag:#orphan` → grey',
    '',
    '## How to read it',
    '',
    '1. Open `[[connections/party-hosts]]` — sorted by likes. Top 10 = your venue shortlist.',
    '2. Open `[[connections/growth-movers]]` — sorted by likes. Top 10 = your study list.',
    '3. For each host on the shortlist: pull up their page. Look at `Replied to by` section → see which movers gather there. That\'s the room.',
    '4. Reply at the host. When a mover also replies, react to *their* reply with substance. You both look like regulars.',
    '5. Repeat daily. ~30 days of consistent presence = recognition in that room.',
    '',
    '## Sanity checks',
    '',
    '- If `party-hosts.md` has fewer than 5 rows → lower `PARTY_MIN_HOSTS_HIT_BY` or `PARTY_MIN_TOTAL_LIKES` in `lib/wiki/generate.js`.',
    '- If `growth-movers.md` has fewer than 10 rows → lower `GROWTH_MIN_REPLY_LIKES`.',
    '- If your circle is small and counts feel sparse, crawl more circle members first (`/with_replies` deep crawl).',
    '',
    '## Lists',
    '- [[connections/growth-movers]] — circle members whose replies pull engagement',
    '- [[connections/party-hosts]] — venues your circle is replying into successfully',
    '- [[connections/top-replies]] — raw reply edges',
    '- [[connections/top-mentions]] — raw mention edges',
    '- [[connections/co-mentions]] — who gets co-mentioned together',
    '',
  ].join('\n');
  await fs.writeFile(path.join(WIKI_ROOT, 'graph-filters.md'), filtersDoc);

  // ----- index -----
  const idx = [
    '---', 'tags: [index]', '---', '',
    '# Social Wiki Index',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Counts',
    `- Circle pages: ${circleWritten}`,
    `- Orphan pages: ${orphansWritten}`,
    `- Tiers: ${byTier.size}`,
    `- Tweets analyzed: ${tweets.length}`,
    `- Window: last ${DAYS_BACK} days`,
    '',
    '## Tiers',
    ...['unknown', 'under-1k', '1k-3k', '3k-5k', '5k-10k', '10k-100k', '100k-1m', '1m-plus']
      .filter((t) => byTier.has(t))
      .map((t) => `- [[tiers/${t}|${t}]] (${byTier.get(t).length})`),
    '',
    '## Connections',
    '- [[connections/growth-movers]] — circle members whose replies pull engagement',
    '- [[connections/party-hosts]] — venues your circle is replying into successfully',
    '- [[connections/timing]] — when to post / when to reply (IST heatmap)',
    '- [[connections/top-replies]]',
    '- [[connections/top-mentions]]',
    '- [[connections/co-mentions]]',
    '',
    '## Roles snapshot',
    `- Growth-movers: ${growthMovers.size}`,
    `- Party-hosts: ${partyHosts.size}`,
    '',
    '## Guide',
    '- [[graph-filters]] — Obsidian graph view filter recipes + strategy',
    '',
    '## See also',
    '- [[circle-summary]]',
    '',
  ];
  await fs.writeFile(path.join(WIKI_ROOT, 'index.md'), idx.join('\n'));
  console.log('  index.md');

  await pool.end();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
