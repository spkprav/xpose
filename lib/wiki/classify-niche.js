#!/usr/bin/env node
// Niche bucket classifier. Reads person pages from social-wiki/people/ + me.md ICP,
// asks local Ollama to bucket each person, writes result back to frontmatter.
//
// Buckets: niche | adjacent | low-value | shitposter | noise | unknown
//
// Respects existing `bucket_override:` in frontmatter (never overwrites).
// Caches structured result in .cache/buckets/<safeName>.json.
//
// Usage:
//   node lib/wiki/classify-niche.js <screen_name>      (single)
//   node lib/wiki/classify-niche.js --top 50           (top N circle members by tweets_collected)
//   node lib/wiki/classify-niche.js --all              (every circle person page)
//   node lib/wiki/classify-niche.js --rerun            (ignore cache, reclassify)
//   node lib/wiki/classify-niche.js --dry              (print, don't write)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WIKI_ROOT  = path.join(REPO_ROOT, 'social-wiki');
const PEOPLE_DIR = path.join(WIKI_ROOT, 'people');
const ME_FILE    = path.join(WIKI_ROOT, 'me.md');
const ME_BACKUP  = path.join(WIKI_ROOT, 'PraveenInPublic.md');
const CACHE_DIR  = path.join(REPO_ROOT, '.cache', 'buckets');

const OLLAMA_URL  = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const MODEL       = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const MAX_RETRIES = 2;

const VALID_BUCKETS = new Set(['niche', 'adjacent', 'low-value', 'shitposter', 'noise', 'unknown']);

const safeName = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_');
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { all: false, top: null, rerun: false, dry: false, name: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--rerun') args.rerun = true;
    else if (a === '--dry') args.dry = true;
    else if (!a.startsWith('--')) args.name = a;
  }
  return args;
}

// ---------- frontmatter parsing ----------
function splitFrontmatter(body) {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: '', rest: body, hasFm: false };
  return { fm: m[1], rest: body.slice(m[0].length), hasFm: true };
}

function fmGet(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  let v = m[1];
  // strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function fmGetArray(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm'));
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// upsert key:value lines into frontmatter (replace if exists, else append before ---)
function upsertFm(fm, upserts) {
  let next = fm;
  for (const [key, value] of Object.entries(upserts)) {
    if (value == null) continue;
    const line = `${key}: ${value}`;
    const re = new RegExp(`^${key}:\\s*.+?$`, 'm');
    if (re.test(next)) next = next.replace(re, line);
    else                next = next.trimEnd() + '\n' + line;
  }
  return next;
}

function rebuildBody(fm, rest) {
  return `---\n${fm}\n---\n${rest.startsWith('\n') ? rest.slice(1) : rest}`;
}

// ---------- cache ----------
async function loadCache(sn) {
  const fp = path.join(CACHE_DIR, `${safeName(sn)}.json`);
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); } catch { return null; }
}
async function saveCache(sn, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${safeName(sn)}.json`), JSON.stringify(data, null, 2));
}

// ---------- Ollama ----------
async function callOllama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, prompt, stream: false,
      format: 'json',
      options: { temperature: 0.1, num_ctx: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.response || '';
}

// ---------- ICP context ----------
async function loadIcp() {
  for (const fp of [ME_FILE, ME_BACKUP]) {
    try {
      const txt = await fs.readFile(fp, 'utf8');
      // strip frontmatter if any, cap to 2000 chars
      const { rest } = splitFrontmatter(txt);
      return rest.replace(/\s+/g, ' ').trim().slice(0, 2000);
    } catch {}
  }
  return 'No ICP defined. Treat as indie builder, replies-driven growth strategy.';
}

// ---------- per-person prompt + classify ----------
function extractRecentTweets(body, limit = 5) {
  // grab "## Recent tweets" or "## Top tweets" bullets
  const sections = ['## Top tweets', '## Recent tweets'];
  for (const h of sections) {
    const i = body.indexOf(h);
    if (i < 0) continue;
    const block = body.slice(i, i + 4000);
    const tweets = [];
    for (const line of block.split('\n').slice(1)) {
      if (line.startsWith('## ')) break;
      const m = line.match(/^-\s*(?:\d{4}-\d{2}-\d{2}\s*[—-]\s*)?"(.+?)"\s*(?:—\s*(.+))?$/);
      if (m) tweets.push({ text: m[1].slice(0, 240), meta: (m[2] || '').slice(0, 60) });
      if (tweets.length >= limit) break;
    }
    if (tweets.length) return tweets;
  }
  return [];
}

function buildPrompt(icp, personMeta, tweets, keywords) {
  return `You are a niche-fit classifier for an indie-builder's X (Twitter) growth strategy.
COMMIT to one of niche/adjacent/low-value/shitposter/noise. Only return "unknown" when bio is empty AND no tweet samples.

USER ICP / VOICE (from me.md):
${icp}

RUBRIC (apply in order, pick first match):

shitposter — viral-for-virality posting. Hot takes for likes, drama, edgelord one-liners, F4F engagement farming, ragebait, mass-appeal threads with no product underneath. Popular but not useful to replicate. (e.g. @levelsio meme posts, @beffjezos)

noise — outside tech-builder space. Sports, regional-lang only, lifestyle, generic motivation, news bot, random unrelated content.

low-value — IN tech-builder space BUT skin-deep content. Generic productivity threads, "100 days of code" diaries, inspirational tweets, recaps of other people's work, link-sharing without takes. They post but don't build or ship visibly.

niche — DIRECT fit: bio or tweets show actively building/shipping indie AI tools, dev tools, SaaS products, in-public launches, vibe-coding, AI coding assistants. Same space the user is in. Their posts are replicable: real product updates, launches, ship logs, technical takes from working on something. NOT just "I work in tech".

adjacent — tech/builder-related but different sub-niche: B2B marketing, devrel, infra, big SaaS, design, indie-hacker community at scale, AI research, hardware, gamedev. Worth connecting; can't directly replicate their pattern. Default for established >50k follower builders.

unknown — bio empty AND zero tweet samples.

GUIDANCE:
- Niche bar: must be ACTIVELY BUILDING or shipping something. Talking about tech ≠ niche.
- Use the metrics: viral_hits_90d > 0 + builder bio + product-related tweets = niche.
- High solo_rate + low engagement_depth + generic bio = low-value.
- When unsure between niche and adjacent: pick adjacent.
- When unsure between low-value and noise: pick low-value if there's ANY tech/builder signal in bio.

ACCOUNT:
@${personMeta.screen_name}
display_name: ${personMeta.display_name || 'unknown'}
followers: ${personMeta.followers || 0}, following: ${personMeta.following || 0}, tier: ${personMeta.tier || 'unknown'}
relationship: ${personMeta.relationship || 'unknown'}
bio: ${personMeta.bio || '(no bio)'}

QUALITY SIGNALS:
- engagement_depth: ${personMeta.engagement_depth ?? 'n/a'}  (replies / likes; high = contrarian/discussion)
- reply_ratio: ${personMeta.reply_ratio ?? 'n/a'}            (fraction of activity that's replies)
- solo_rate: ${personMeta.solo_rate ?? 'n/a'}                (fraction that are originals)
- viral_hits_90d: ${personMeta.viral_hits_90d ?? 'n/a'}
- median_likes: ${personMeta.median_likes ?? 'n/a'}, median_views: ${personMeta.median_views ?? 'n/a'}
- avg_text_len: ${personMeta.avg_text_len ?? 'n/a'} chars
- url_rate: ${personMeta.url_rate ?? 'n/a'}, media_rate: ${personMeta.media_rate ?? 'n/a'}
- top_reply_targets: ${(personMeta.top_reply_targets || []).join(', ') || '(none)'}

TOP KEYWORDS (from their tweets, may be sparse): ${keywords.join(', ') || '(none)'}

SAMPLE TWEETS (${tweets.length} provided, highest-engagement):
${tweets.length ? tweets.map((t, i) => `${i + 1}. "${t.text}" ${t.meta}`).join('\n') : '(no tweet samples)'}

CRITICAL: ${tweets.length > 0 ? `${tweets.length} tweet samples ARE provided above. You MUST classify based on them. "unknown" is NOT an option here.` : 'No tweet samples — unknown is allowed only if bio is also absent.'}

Output STRICT JSON only — no prose, no markdown:
{"bucket": "<one of: niche, adjacent, low-value, shitposter, noise${tweets.length > 0 ? '' : ', unknown'}>", "confidence": <0.0-1.0>, "reason": "<one short sentence>"}`;
}

function extractKeywordsFromBody(body) {
  // Topics section bullets: - [[keywords/foo|foo]] — N×
  const i = body.indexOf('## Topics');
  if (i < 0) return [];
  const block = body.slice(i, i + 1500);
  const out = [];
  for (const line of block.split('\n').slice(1)) {
    if (line.startsWith('## ')) break;
    const m = line.match(/\[\[keywords\/[^|]+\|([^\]]+)\]\]/);
    if (m) out.push(m[1]);
    if (out.length >= 15) break;
  }
  return out;
}

function parseClassifyResponse(raw) {
  // Try direct JSON parse first (format:json gives clean JSON)
  try {
    const j = JSON.parse(raw);
    if (j.bucket && VALID_BUCKETS.has(j.bucket)) {
      return {
        bucket: j.bucket,
        confidence: clamp01(j.confidence),
        reason: String(j.reason || '').slice(0, 200),
      };
    }
  } catch {}
  // Fallback: extract first {...} block
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j.bucket && VALID_BUCKETS.has(j.bucket)) {
        return {
          bucket: j.bucket,
          confidence: clamp01(j.confidence),
          reason: String(j.reason || '').slice(0, 200),
        };
      }
    } catch {}
  }
  return null;
}
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

async function classifyOne(sn, icp, args) {
  const fp = path.join(PEOPLE_DIR, `${safeName(sn)}.md`);
  let body;
  try { body = await fs.readFile(fp, 'utf8'); }
  catch (e) { return { sn, skipped: 'page-missing' }; }

  const { fm, rest, hasFm } = splitFrontmatter(body);
  if (!hasFm) return { sn, skipped: 'no-frontmatter' };

  // Honor existing override — never overwrite
  const override = fmGet(fm, 'bucket_override');
  if (override) return { sn, skipped: `override=${override}` };

  // Check cache (unless --rerun)
  if (!args.rerun) {
    const cached = await loadCache(sn);
    if (cached?.bucket) {
      // Ensure frontmatter has it (in case file was regenerated)
      if (fmGet(fm, 'bucket') !== cached.bucket) {
        if (!args.dry) {
          const nextFm = upsertFm(fm, {
            bucket: cached.bucket,
            bucket_confidence: cached.confidence ?? '',
            bucket_reason: cached.reason ? JSON.stringify(cached.reason) : '""',
          });
          await fs.writeFile(fp, rebuildBody(nextFm, rest));
        }
        return { sn, from: 'cache', bucket: cached.bucket, refreshed: true };
      }
      return { sn, from: 'cache', bucket: cached.bucket };
    }
  }

  const personMeta = {
    screen_name: sn,
    display_name: fmGet(fm, 'display_name'),
    followers: Number(fmGet(fm, 'followers')) || 0,
    following: Number(fmGet(fm, 'following')) || 0,
    tier: fmGet(fm, 'tier'),
    relationship: fmGet(fm, 'relationship'),
    bio: (rest.match(/^>\s*(.+)$/m) || [])[1] || null,
    engagement_depth: fmGet(fm, 'engagement_depth'),
    reply_ratio:      fmGet(fm, 'reply_ratio'),
    solo_rate:        fmGet(fm, 'solo_rate'),
    viral_hits_90d:   fmGet(fm, 'viral_hits_90d'),
    median_likes:     fmGet(fm, 'median_likes'),
    median_views:     fmGet(fm, 'median_views'),
    avg_text_len:     fmGet(fm, 'avg_text_len'),
    url_rate:         fmGet(fm, 'url_rate'),
    media_rate:       fmGet(fm, 'media_rate'),
    top_reply_targets: fmGetArray(fm, 'top_reply_targets'),
  };
  const tweets   = extractRecentTweets(rest, 5);
  const keywords = extractKeywordsFromBody(rest);

  const prompt = buildPrompt(icp, personMeta, tweets, keywords);
  const prompt_hash = crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12);

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = await callOllama(prompt);
      const parsed = parseClassifyResponse(raw);
      if (!parsed) throw new Error(`could not parse: ${raw.slice(0, 120)}`);
      const result = { ...parsed, model: MODEL, prompt_hash, classified_at: new Date().toISOString() };

      if (!args.dry) {
        await saveCache(sn, result);
        const nextFm = upsertFm(fm, {
          bucket: result.bucket,
          bucket_confidence: result.confidence ?? '',
          bucket_reason: JSON.stringify(result.reason),
        });
        await fs.writeFile(fp, rebuildBody(nextFm, rest));
      }
      return { sn, from: 'llm', bucket: result.bucket, confidence: result.confidence, reason: result.reason };
    } catch (e) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  return { sn, error: lastErr?.message || 'unknown' };
}

// ---------- people enumeration ----------
const MIN_TWEETS_FOR_CLASSIFY = 3; // skip orphans / RT-harvest entries with no signal

async function listPeople(args) {
  const files = await fs.readdir(PEOPLE_DIR);
  const mds   = files.filter(f => f.endsWith('.md'));
  const people = [];
  for (const fname of mds) {
    const fp = path.join(PEOPLE_DIR, fname);
    let body;
    try { body = await fs.readFile(fp, 'utf8'); } catch { continue; }
    const { fm, rest, hasFm } = splitFrontmatter(body);
    if (!hasFm) continue;
    const sn = fmGet(fm, 'screen_name');
    if (!sn) continue;
    const tweets_collected = Number(fmGet(fm, 'tweets_collected')) || 0;
    const bio = (rest.match(/^>\s*(.+)$/m) || [])[1] || '';
    people.push({ sn, tweets_collected, hasBio: bio.length > 0 });
  }
  if (args.name) return people.filter(p => p.sn === args.name);
  // Skip orphans: must have ≥N tweets, otherwise the LLM has no signal to classify on.
  // Always sort by tweets_collected DESC so high-signal people get classified first
  // (lists.md becomes useful well before the full run finishes).
  const filtered = people
    .filter(p => p.tweets_collected >= MIN_TWEETS_FOR_CLASSIFY || p.hasBio)
    .sort((a, b) => b.tweets_collected - a.tweets_collected);
  if (args.top) return filtered.slice(0, args.top);
  if (args.all) return filtered;
  return [];
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);
  if (!args.all && !args.top && !args.name) {
    console.error('Usage: classify-niche.js <screen_name> | --top N | --all  [--rerun] [--dry]');
    process.exit(1);
  }

  const icp = await loadIcp();
  console.log(`Loaded ICP (${icp.length} chars). Model: ${MODEL}.`);

  const people = await listPeople(args);
  console.log(`Classifying ${people.length} people...`);

  let llm = 0, cache = 0, skipped = 0, err = 0;
  const buckets = {};
  for (let i = 0; i < people.length; i++) {
    const { sn } = people[i];
    const r = await classifyOne(sn, icp, args);
    if (r.error) { err++; console.error(`  [${i+1}/${people.length}] ${sn} ERROR ${r.error}`); continue; }
    if (r.skipped) { skipped++; console.log(`  [${i+1}/${people.length}] ${sn} SKIP ${r.skipped}`); continue; }
    if (r.from === 'cache') cache++; else llm++;
    buckets[r.bucket] = (buckets[r.bucket] || 0) + 1;
    // Log every item so progress is visible from the output file
    const tag = r.from === 'cache' ? 'cache' : 'llm';
    const conf = r.confidence != null ? ` conf=${r.confidence}` : '';
    console.log(`  [${i+1}/${people.length}] ${sn.padEnd(22)} ${tag.padEnd(5)} → ${r.bucket.padEnd(11)}${conf}${r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}`);
    // Roll-up every 50 items
    if ((i + 1) % 50 === 0) {
      const dist = Object.entries(buckets).map(([k,v]) => `${k}=${v}`).join(' ');
      console.log(`  --- progress ${i+1}/${people.length}: ${dist} (llm=${llm} cache=${cache}) ---`);
    }
  }
  console.log(`\nSummary: ${llm} via LLM, ${cache} from cache, ${skipped} skipped, ${err} errors.`);
  console.log('Bucket distribution:', buckets);
}

main().catch(e => { console.error(e); process.exit(1); });
