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

  console.log(`Loading circle_tweets (last ${DAYS_BACK}d, non-retweet)...`);
  const { rows: tweets } = await pool.query(`
    SELECT id, screen_name, text, created_at, in_reply_to_screen_name,
           reply_count, like_count, retweet_count, quote_count, view_count,
           raw_data->'legacy'->'entities'->'user_mentions' AS mentions
    FROM circle_tweets
    WHERE is_retweet = FALSE
      AND created_at > NOW() - ($1 * INTERVAL '1 day')
  `, [DAYS_BACK]);
  console.log(`  ${tweets.length} tweets`);

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

    if (t.in_reply_to_screen_name && t.in_reply_to_screen_name !== author) {
      const tgt = t.in_reply_to_screen_name;
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

  console.log('Resetting output dirs...');
  await rmDirContents(PEOPLE_DIR);
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
    lines.push(`tags: [tier/${tier}, rel/${rel}]`);
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
    lines.push('tags: [orphan]');
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
  console.log('  3 connection summaries');

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
    '- [[connections/top-replies]]',
    '- [[connections/top-mentions]]',
    '- [[connections/co-mentions]]',
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
