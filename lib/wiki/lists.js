#!/usr/bin/env node
// Generate the 5 X-lists from wiki frontmatter ONLY (no DB).
// Reads social-wiki/people/*.md, filters/sorts on frontmatter fields,
// writes social-wiki/connections/lists.md ready to paste into X list builder.
//
// Pre-requisites:
//   - generate.js has populated metrics (engagement_depth, reply_ratio, etc.)
//   - classify-niche.js has populated bucket (or you set bucket_override manually)
//
// Run: node lib/wiki/lists.js   (or: npm run wiki:lists)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WIKI_ROOT       = path.join(REPO_ROOT, 'social-wiki');
const PEOPLE_DIR      = path.join(WIKI_ROOT, 'people');
const CONNECTIONS_DIR = path.join(WIKI_ROOT, 'connections');

const DB_CONFIG = {
  host:     process.env.PGHOST     || 'localhost',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'xpose',
  port:     Number(process.env.PGPORT) || 54329,
  connectionTimeoutMillis: 5000,
  statement_timeout: 60000,
};

const DAYS_BACK = 90;

// ----- list configs -----
const LIST_CAP       = 25;  // top-N highlighted in primary paste block (daily attention)
const FULL_TABLE_CAP = 500; // members in the full table (reference / X-list paste pool)

function isNicheStrict(b) { return b === 'niche'; }
function isNiche(b)       { return b === 'niche' || b === 'adjacent'; }
function isUsable(b)      { return isNiche(b)    || b === null || b === undefined || b === 'unknown'; }
function isNotJunk(b)     { return b !== 'shitposter' && b !== 'noise'; }

// ----- frontmatter parser (matches what generate.js + classify-niche.js write) -----
function splitFm(body) {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return m[1];
}
function fmGet(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}
function fmGetNum(fm, key) {
  const v = fmGet(fm, key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmGetBool(fm, key) {
  const v = fmGet(fm, key);
  return v === 'true';
}
function fmGetArray(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm'));
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// ----- load all people pages -----
async function loadPeople() {
  const out = [];
  let files = [];
  try { files = await fs.readdir(PEOPLE_DIR); } catch { return out; }
  for (const fname of files) {
    if (!fname.endsWith('.md')) continue;
    let body;
    try { body = await fs.readFile(path.join(PEOPLE_DIR, fname), 'utf8'); } catch { continue; }
    const fm = splitFm(body);
    if (!fm) continue;
    const sn = fmGet(fm, 'screen_name');
    if (!sn) continue;
    const tagsLine = fm.match(/^tags:\s*\[(.+?)\]\s*$/m);
    const tags = tagsLine ? tagsLine[1].split(',').map(s => s.trim()) : [];
    const roleSet = new Set(tags.filter(t => t.startsWith('role/')).map(t => t.replace('role/', '')));
    const blocked = fmGetBool(fm, 'blocked') || tags.includes('blocked');
    if (blocked) continue;  // hard exclude — never appears in any list
    const tweets_collected = fmGetNum(fm, 'tweets_collected') || 0;
    out.push({
      sn,
      display_name:     fmGet(fm, 'display_name'),
      followers:        fmGetNum(fm, 'followers') || 0,
      tweets_collected,
      unique_reply_targets_90d: fmGetNum(fm, 'unique_reply_targets_90d') || 0,
      reply_breadth_ratio:      fmGetNum(fm, 'reply_breadth_ratio') || 0,
      following:        fmGetNum(fm, 'following') || 0,
      tier:             fmGet(fm, 'tier'),
      relationship:     fmGet(fm, 'relationship'),
      bucket:           fmGet(fm, 'bucket_override') || fmGet(fm, 'bucket') || null,
      bucket_reason:    fmGet(fm, 'bucket_reason'),
      engagement_depth: fmGetNum(fm, 'engagement_depth'),
      reply_ratio:      fmGetNum(fm, 'reply_ratio'),
      solo_rate:        fmGetNum(fm, 'solo_rate'),
      viral_hits_90d:   fmGetNum(fm, 'viral_hits_90d') || 0,
      median_likes:     fmGetNum(fm, 'median_likes') || 0,
      median_views:     fmGetNum(fm, 'median_views') || 0,
      replies_90d:      fmGetNum(fm, 'replies_90d') || 0,
      reply_likes_90d:  fmGetNum(fm, 'reply_likes_90d') || 0,
      avg_likes_per_reply: fmGetNum(fm, 'avg_likes_per_reply') || 0,
      party_hit_by:     fmGetNum(fm, 'party_hit_by') || 0,
      party_total_likes:fmGetNum(fm, 'party_total_likes') || 0,
      tags,
      roles: roleSet,
    });
  }
  return out;
}

// ----- list builders -----
function buildGrowthStudy(people) {
  return people
    .filter(p => isNicheStrict(p.bucket))                              // strict: niche only, no adjacent
    .filter(p => p.followers >= 1000 && p.followers <= 100000)         // in-reach tier
    .filter(p => p.replies_90d >= 5 && p.reply_likes_90d >= 50)        // active + earning
    .filter(p => (p.engagement_depth || 0) >= 0.05)                    // discussion-driver, not likes-bait
    .filter(p => p.viral_hits_90d >= 1)                                // at least one breakout reply
    .sort((a, b) => b.avg_likes_per_reply - a.avg_likes_per_reply || b.reply_likes_90d - a.reply_likes_90d);
}

function buildVenues(people) {
  return people
    .filter(p => p.roles.has('party-host'))
    .filter(p => isNotJunk(p.bucket))
    .sort((a, b) => b.party_total_likes - a.party_total_likes);
}

function buildMutualsRising(people) {
  return people
    .filter(p => p.relationship === 'mutual')
    .filter(p => isNiche(p.bucket))
    .filter(p => p.tweets_collected >= 15)                                // active overall
    .filter(p => p.reply_likes_90d >= 10 || p.viral_hits_90d >= 1 || p.median_likes >= 3)
    .filter(p => p.unique_reply_targets_90d >= 10)                        // reciprocates broadly
    .filter(p => p.reply_breadth_ratio >= 0.4)                            // not concentrated on a few accounts
    .sort((a, b) => {
      // Composite: traction × reciprocity. Favors mutuals who post well AND engage broadly.
      const tractionA = (a.reply_likes_90d || 0) + (a.viral_hits_90d || 0) * 30 + (a.median_likes || 0) * 5;
      const tractionB = (b.reply_likes_90d || 0) + (b.viral_hits_90d || 0) * 30 + (b.median_likes || 0) * 5;
      const reciprocityA = (a.unique_reply_targets_90d || 0) * (a.reply_breadth_ratio || 0);
      const reciprocityB = (b.unique_reply_targets_90d || 0) * (b.reply_breadth_ratio || 0);
      return (tractionB + reciprocityB * 3) - (tractionA + reciprocityA * 3);
    });
}

function buildAnchors(people) {
  const bigTiers = new Set(['100k-1m', '1m-plus']);
  return people
    .filter(p => bigTiers.has(p.tier))
    .filter(p => isNiche(p.bucket))
    .filter(p => p.relationship === 'mutual' || p.relationship === 'following')  // only ones you actually follow
    .filter(p => p.unique_reply_targets_90d >= 5)             // reachable: they actually reply to people
    .filter(p => p.reply_breadth_ratio >= 0.3)                // not corp-style broadcast-only
    .sort((a, b) => b.followers - a.followers);
}

function buildHighVelocity(people) {
  return people
    .filter(p => isNiche(p.bucket))
    .filter(p => p.replies_90d >= 50)
    .filter(p => p.unique_reply_targets_90d >= 25)          // broad: replies to ≥25 distinct people
    .filter(p => p.reply_breadth_ratio >= 0.35)             // not concentrated on a handful
    .sort((a, b) => {
      // Composite: total replies × breadth — favors high-volume + high-spread
      const ascore = a.replies_90d * (a.reply_breadth_ratio || 0.01);
      const bscore = b.replies_90d * (b.reply_breadth_ratio || 0.01);
      return bscore - ascore;
    });
}

// ----- render -----
const safeName = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_');
const link     = (n) => `[[${safeName(n)}]]`;

function renderList(title, slug, hint, rows, columns) {
  const lines = [];
  lines.push(`## ${title}`, '');
  lines.push(`**Slug:** \`${slug}\`. ${hint}`, '');
  if (!rows.length) {
    lines.push('_No members match the filter yet. Run `wiki:bucket` after `wiki:gen` to populate buckets._', '');
    return lines.join('\n');
  }
  // Compact paste-ready handle block (top N only — daily attention)
  const handles = rows.slice(0, LIST_CAP).map(r => r.sn);
  lines.push(`### Paste handles (top ${handles.length} — daily attention)`, '');
  lines.push('```');
  lines.push(handles.join(', '));
  lines.push('```', '');
  lines.push(`Total matching: **${rows.length}**. Full ranked table below.`, '');
  // Full ranked table (up to FULL_TABLE_CAP)
  lines.push(`### Full ranked table (showing ${Math.min(rows.length, FULL_TABLE_CAP)} of ${rows.length})`, '');
  const header = '| # | Member | ' + columns.map(c => c.label).join(' | ') + ' | Bucket | Reason |';
  const sep    = '|--|' + '--|'.repeat(columns.length + 3);
  lines.push(header, sep);
  rows.slice(0, FULL_TABLE_CAP).forEach((r, i) => {
    const vals = columns.map(c => c.value(r) ?? '—');
    lines.push(`| ${i + 1} | ${link(r.sn)} | ${vals.join(' | ')} | ${r.bucket || '—'} | ${(r.bucket_reason || '').slice(0, 60)} |`);
  });
  lines.push('');
  return lines.join('\n');
}

// ----- timing analysis (scoped to a set of screen_names) -----
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function fetchTweetTimes(pool, screenNames) {
  if (!screenNames.length) return [];
  const { rows } = await pool.query(`
    SELECT screen_name, created_at, like_count, view_count
    FROM circle_tweets
    WHERE is_retweet = FALSE
      AND screen_name = ANY($1::text[])
      AND created_at > NOW() - ($2 * INTERVAL '1 day')
  `, [screenNames, DAYS_BACK]);
  return rows;
}

function computeMatrices(rows) {
  const postsMat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const likesMat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let totalPosts = 0, totalLikes = 0;
  for (const t of rows) {
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
  return { postsMat, likesMat, totalPosts, totalLikes };
}

function topCells(mat, k) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (mat[d][h] > 0) out.push({ d, h, v: mat[d][h] });
    }
  }
  return out.sort((a, b) => b.v - a.v).slice(0, k);
}

function renderTimingSection(title, members, postsMat, likesMat, totalPosts, totalLikes) {
  if (!members.length) return [`## ${title}`, '_(no members)_`', ''].join('\n');
  const topPosts = topCells(postsMat, 5);
  const topLikes = topCells(likesMat, 5);
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`${members.length} members · ${totalPosts.toLocaleString()} posts · ${totalLikes.toLocaleString()} likes earned.`);
  lines.push('');
  lines.push('**Top post-volume windows (when they are on X):**');
  lines.push('');
  lines.push('| # | Day | Hour IST | Posts |');
  lines.push('|--|--|--|--|');
  topPosts.forEach((c, i) => lines.push(`| ${i + 1} | ${DOW[c.d]} | ${String(c.h).padStart(2,'0')}:00 | ${c.v} |`));
  lines.push('');
  lines.push('**Top engagement windows (when their posts earn likes):**');
  lines.push('');
  lines.push('| # | Day | Hour IST | Likes |');
  lines.push('|--|--|--|--|');
  topLikes.forEach((c, i) => lines.push(`| ${i + 1} | ${DOW[c.d]} | ${String(c.h).padStart(2,'0')}:00 | ${c.v.toLocaleString()} |`));
  lines.push('');
  return lines.join('\n');
}

function renderHeatmap(label, mat) {
  const flat = mat.flat().filter(v => v > 0).sort((a, b) => a - b);
  const q3 = flat[Math.floor(flat.length * 0.75)] || 0;
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const lines = [];
  lines.push(`### ${label}`, '');
  lines.push(`| Day | ${hours.join(' | ')} |`);
  lines.push(`|--|${'--|'.repeat(24)}`);
  for (let d = 0; d < 7; d++) {
    const cells = mat[d].map(v => v >= q3 && v > 0 ? `**${v}**` : (v > 0 ? String(v) : '·'));
    lines.push(`| ${DOW[d]} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

async function buildTimingDoc(perList) {
  // perList: { listName: { members: [sn], rows: [...tweet rows] } }
  const parts = [
    '---', 'tags: [connections, timing]', '---',
    '',
    '# Posting & engagement timing (IST)',
    '',
    `Scoped to actual list members. Times in **IST (UTC+5:30)**. Cells **bolded** = top quartile.`,
    `Last ${DAYS_BACK} days only. Excludes retweets.`,
    '',
  ];
  for (const [name, data] of Object.entries(perList)) {
    const { postsMat, likesMat, totalPosts, totalLikes } = computeMatrices(data.rows);
    parts.push(renderTimingSection(name, data.members, postsMat, likesMat, totalPosts, totalLikes));
    parts.push(renderHeatmap('Post volume heatmap', postsMat));
    parts.push('');
    parts.push(renderHeatmap('Engagement heatmap (likes)', likesMat));
    parts.push('', '---', '');
  }
  parts.push('## How to use', '');
  parts.push('- **Original posts:** use the top engagement window of the most relevant list (usually growth-study or venues).');
  parts.push('- **Reply sessions:** schedule during top volume windows of mutuals-rising — fresh tweets land then.');
  parts.push('- **Skip dead hours** — if a cell shows `·`, nobody on your lists is posting.');
  parts.push('- **Day patterns matter** — check whether weekends shift the windows.');
  parts.push('');
  return parts.join('\n');
}

// ----- main -----
async function main() {
  console.log('Loading wiki person pages...');
  const people = await loadPeople();
  console.log(`  ${people.length} pages parsed`);

  const bucketed = people.filter(p => p.bucket);
  const overrides = people.filter(p => p.tags.some(t => t.startsWith('bucket/')));
  console.log(`  ${bucketed.length} with bucket assignment, ${overrides.length} tagged in tags array`);

  const growthStudy   = buildGrowthStudy(people);
  const venues        = buildVenues(people);
  const mutualsRising = buildMutualsRising(people);
  const anchors       = buildAnchors(people);
  const highVelocity  = buildHighVelocity(people);

  console.log('List sizes:',
    'growth-study=' + growthStudy.length,
    'venues=' + venues.length,
    'mutuals-rising=' + mutualsRising.length,
    'anchors=' + anchors.length,
    'high-velocity-replies=' + highVelocity.length);

  const parts = [
    '---', 'tags: [connections, lists]', '---', '',
    '# X-lists (ready to paste)',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Source: \`social-wiki/people/*.md\` frontmatter (no DB hit).`,
    'Buckets used: niche, adjacent (positive). shitposter, noise (excluded). Override per-person with `bucket_override:`.',
    '',
    `**Bucket coverage:** ${bucketed.length} / ${people.length} people classified.${bucketed.length < people.length / 4 ? ' Run `npm run wiki:bucket` to populate more.' : ''}`,
    '',
    '## How to use',
    '',
    '1. Open `https://x.com/i/lists/create` in your browser.',
    '2. Copy the **Paste handles** block under each list below.',
    '3. Add each handle one-by-one in the X list builder. (X does not bulk-import.)',
    '4. Make `growth-study`, `venues`, `mutuals-rising`, `high-velocity-replies` PRIVATE. Make `anchors` PUBLIC.',
    '',
    renderList(
      '1. growth-study (private)',
      'growth-study',
      'Niche-only circle members in 1K-100K tier with discussion-driving replies (engagement_depth ≥ 0.05) and ≥1 viral hit in 90d. Replicable patterns.',
      growthStudy,
      [
        { label: 'Tier',          value: r => r.tier },
        { label: 'Followers',     value: r => r.followers.toLocaleString() },
        { label: 'Replies 90d',   value: r => r.replies_90d },
        { label: 'Avg ♥/reply',   value: r => r.avg_likes_per_reply?.toFixed(1) },
        { label: 'Engagement depth', value: r => r.engagement_depth?.toFixed(3) },
      ],
    ),
    renderList(
      '2. venues (private)',
      'venues',
      'Party-hosts: accounts where your circle gathers and lands engagement. Reply here daily.',
      venues,
      [
        { label: 'Tier',         value: r => r.tier },
        { label: 'Followers',    value: r => r.followers.toLocaleString() },
        { label: 'Hit by movers', value: r => r.party_hit_by },
        { label: 'Total likes',  value: r => r.party_total_likes },
      ],
    ),
    renderList(
      '3. mutuals-rising (private)',
      'mutuals-rising',
      'Mutuals already friendly with you AND showing growth signals. Engage to lift each other.',
      mutualsRising,
      [
        { label: 'Tier',        value: r => r.tier },
        { label: 'Followers',   value: r => r.followers.toLocaleString() },
        { label: 'Replies 90d', value: r => r.replies_90d },
        { label: 'Engagement depth', value: r => r.engagement_depth?.toFixed(3) },
      ],
    ),
    renderList(
      '4. anchors (public — signals your niche)',
      'anchors',
      'Big-name circle accounts that anchor your niche publicly. NOT primary engagement targets.',
      anchors,
      [
        { label: 'Tier',      value: r => r.tier },
        { label: 'Followers', value: r => r.followers.toLocaleString() },
      ],
    ),
    renderList(
      '5. high-velocity-replies (private)',
      'high-velocity-replies',
      'Broad repliers: ≥50 replies to ≥25 distinct people in 90d, breadth ratio ≥0.35. Generalists who engage across the niche, not concentrated on a handful of big accounts. Study cadence + thread selection.',
      highVelocity,
      [
        { label: 'Tier',           value: r => r.tier },
        { label: 'Followers',      value: r => r.followers.toLocaleString() },
        { label: 'Replies 90d',    value: r => r.replies_90d },
        { label: 'Unique targets', value: r => r.unique_reply_targets_90d },
        { label: 'Breadth ratio',  value: r => r.reply_breadth_ratio?.toFixed(2) },
      ],
    ),
    '',
    '## Refresh cadence',
    '',
    '- `npm run wiki:gen` weekly → new metrics',
    '- `npm run wiki:bucket` after wiki:gen if new people landed',
    '- `npm run wiki:lists` last → regenerates this page',
    '- Roll members OUT when they drop below filter thresholds. Roll new ones IN.',
    '',
  ];

  await fs.mkdir(CONNECTIONS_DIR, { recursive: true });
  const fp = path.join(CONNECTIONS_DIR, 'lists.md');
  await fs.writeFile(fp, parts.join('\n'));
  console.log(`Wrote ${fp}`);

  // ----- timing.md scoped to actual list members -----
  console.log('Computing timing analysis for list members...');
  const { Pool } = pg;
  const pool = new Pool(DB_CONFIG);
  try {
    const memberSet = (rows) => rows.map(r => r.sn);
    const unionSet  = new Set([
      ...memberSet(growthStudy), ...memberSet(venues), ...memberSet(mutualsRising),
      ...memberSet(anchors),     ...memberSet(highVelocity),
    ]);

    // Pull all tweet times for the union (one DB hit)
    const allRows = await fetchTweetTimes(pool, [...unionSet]);
    const byAuthor = new Map();
    for (const r of allRows) {
      if (!byAuthor.has(r.screen_name)) byAuthor.set(r.screen_name, []);
      byAuthor.get(r.screen_name).push(r);
    }

    function rowsFor(list) {
      const out = [];
      for (const p of list) {
        const r = byAuthor.get(p.sn);
        if (r) out.push(...r);
      }
      return out;
    }

    const perList = {
      'Combined (all lists)':       { members: [...unionSet],            rows: allRows },
      'growth-study':               { members: memberSet(growthStudy),   rows: rowsFor(growthStudy) },
      'venues':                     { members: memberSet(venues),        rows: rowsFor(venues) },
      'mutuals-rising':             { members: memberSet(mutualsRising), rows: rowsFor(mutualsRising) },
      'anchors':                    { members: memberSet(anchors),       rows: rowsFor(anchors) },
      'high-velocity-replies':      { members: memberSet(highVelocity),  rows: rowsFor(highVelocity) },
    };

    const timingDoc = await buildTimingDoc(perList);
    const tfp = path.join(CONNECTIONS_DIR, 'timing.md');
    await fs.writeFile(tfp, timingDoc);
    console.log(`Wrote ${tfp} (${unionSet.size} unique members, ${allRows.length} tweets analyzed)`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
