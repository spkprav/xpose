#!/usr/bin/env node
// Extract topical keywords per tweet using a local Ollama instruct model.
// Caches per-tweet keywords as JSONL so repeat runs only process new tweets.
// Then aggregates per-author and writes:
//   - keywords/<slug>.md     (people who use this topic)
//   - keywords/_index.md     (top topics by score)
//   - appends ## Topics section to people/<sn>.md (in place)
//
// Usage:
//   node lib/wiki/extract-keywords.js <screen_name>     (pilot)
//   node lib/wiki/extract-keywords.js --all             (every circle author)
//   node lib/wiki/extract-keywords.js --top 50          (top N by tweet count)

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

const WIKI_ROOT    = path.join(REPO_ROOT, 'social-wiki');
const PEOPLE_DIR   = path.join(WIKI_ROOT, 'people');
const KEYWORDS_DIR = path.join(WIKI_ROOT, 'keywords');
const CACHE_DIR    = path.join(REPO_ROOT, '.cache', 'keywords');

const OLLAMA_URL  = 'http://localhost:11434/api/generate';
const MODEL       = 'qwen2.5:3b';
const BATCH_SIZE  = 20;       // tweets per LLM call
const MAX_RETRIES = 2;

const KEYWORDS_PER_TWEET_MAX = 5;
const TOP_KEYWORDS_PER_PERSON = 20;
const TOP_PEOPLE_PER_KEYWORD  = 30;

const safeName = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_');
const slugify  = (s) =>
  String(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const STOP_KEYWORDS = new Set([
  'tweet', 'tweets', 'post', 'thread', 'twitter', 'x', 'today', 'time',
  'people', 'thing', 'things', 'someone', 'anyone', 'everyone',
  'question', 'answer', 'reply', 'comment',
  'yes', 'no', 'ok', 'okay', 'thanks', 'thank',
  'us', 'we', 'you', 'me', 'i', 'they', 'them', 'it',
]);

// Crude lemmatizer: collapse trailing plural/verb forms so
// "server"/"servers", "model"/"models", "code"/"coding" merge.
function lemmatize(s) {
  let w = String(s).toLowerCase().trim();
  if (w.length <= 3) return w;
  // multi-word: lemmatize each token
  if (w.includes(' ')) return w.split(/\s+/).map(lemmatize).join(' ');
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);  // classes -> class
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3) return w.slice(0, -1);
  return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- LLM call ----------
const SYSTEM_PROMPT = `You extract topical keywords from tweets. Output strictly valid JSON.

Rules:
- For each tweet, extract 2-5 SHORT topical keywords (1-3 words each, lowercase).
- Keywords describe the SUBJECT or DOMAIN, not generic words.
- Prefer: technologies, products, companies, fields, concepts (e.g. "rust", "indie hacker", "saas pricing", "vibe coding").
- Skip: filler words, generic verbs, emotions, pronouns, single common words like "good" or "tweet".
- If a tweet is purely conversational/empty/spam, return [].
- Output exactly one JSON line per input tweet in order, no preamble.

Output format (one JSON object per line):
{"i": 1, "k": ["kw1", "kw2"]}
{"i": 2, "k": []}`;

async function callOllama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_ctx: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.response || '';
}

function buildPrompt(batch) {
  const lines = batch.map((t, i) => `${i + 1}. ${t.text.replace(/\s+/g, ' ').trim().slice(0, 280)}`);
  return `${SYSTEM_PROMPT}

Tweets:
${lines.join('\n')}

JSON output (one line per tweet, in order):`;
}

function parseResponse(raw, expected) {
  const out = new Array(expected).fill(null).map(() => []);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\{[^}]*\}$/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[0]);
      const i = Number(obj.i);
      if (i >= 1 && i <= expected && Array.isArray(obj.k)) {
        out[i - 1] = obj.k
          .map((k) => lemmatize(k))
          .filter((k) => k.length >= 2 && k.length <= 40 && !STOP_KEYWORDS.has(k))
          .slice(0, KEYWORDS_PER_TWEET_MAX);
      }
    } catch {}
  }
  return out;
}

async function extractBatch(batch) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prompt = buildPrompt(batch);
      const raw = await callOllama(prompt);
      const parsed = parseResponse(raw, batch.length);
      const filledCount = parsed.filter((p) => p.length > 0).length;
      if (filledCount > 0 || attempt === MAX_RETRIES) return parsed;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  if (lastErr) console.error('  batch failed:', lastErr.message);
  return new Array(batch.length).fill(null).map(() => []);
}

// ---------- cache ----------
async function loadCache(screenName) {
  const file = path.join(CACHE_DIR, `${safeName(screenName)}.jsonl`);
  const seen = new Map(); // tweet_id -> keywords[]
  try {
    const txt = await fs.readFile(file, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj.id) seen.set(String(obj.id), obj.k || []);
      } catch {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { file, seen };
}

async function appendCache(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await fs.appendFile(file, body);
}

// ---------- main ----------
async function getAuthors(pool, args) {
  if (args.all) {
    const { rows } = await pool.query(`
      SELECT DISTINCT screen_name FROM circle_tweets WHERE is_retweet = FALSE
      ORDER BY screen_name
    `);
    return rows.map((r) => r.screen_name);
  }
  if (args.top) {
    const { rows } = await pool.query(`
      SELECT screen_name, COUNT(*) n
      FROM circle_tweets WHERE is_retweet = FALSE
      GROUP BY screen_name ORDER BY n DESC LIMIT $1
    `, [args.top]);
    return rows.map((r) => r.screen_name);
  }
  return [args.target];
}

async function processAuthor(pool, sn) {
  const { rows: tweets } = await pool.query(`
    SELECT id, text FROM circle_tweets
    WHERE screen_name = $1 AND is_retweet = FALSE
    ORDER BY created_at DESC
  `, [sn]);
  if (!tweets.length) { console.log(`  ${sn}: no tweets`); return []; }

  const { file, seen } = await loadCache(sn);
  const todo = tweets.filter((t) => !seen.has(String(t.id)));
  console.log(`  ${sn}: ${tweets.length} tweets, ${seen.size} cached, ${todo.length} to extract`);

  const newRows = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    process.stdout.write(`    ${i + 1}/${todo.length}...`);
    const t0 = Date.now();
    const results = await extractBatch(batch);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    let nKw = 0;
    batch.forEach((t, idx) => {
      const k = results[idx] || [];
      nKw += k.length;
      seen.set(String(t.id), k);
      newRows.push({ id: String(t.id), k });
    });
    process.stdout.write(` ${dt}s, ${nKw} kw\n`);
  }
  if (newRows.length) await appendCache(file, newRows);

  // return all (cached + new) for aggregation
  return tweets.map((t) => ({ id: String(t.id), k: seen.get(String(t.id)) || [] }));
}

function aggregate(perAuthor) {
  // keywordsToPeople: keyword -> Map(screen_name -> count)
  // personToKeywords: screen_name -> Map(keyword -> count)
  const k2p = new Map();
  const p2k = new Map();
  for (const [sn, items] of perAuthor) {
    for (const it of items) {
      // dedupe per-tweet so a keyword surviving lemmatize collapse isn't double-counted
      const uniq = new Set();
      for (const raw of it.k) {
        const kw = lemmatize(raw);
        if (!kw || kw.length < 2 || STOP_KEYWORDS.has(kw)) continue;
        uniq.add(kw);
      }
      for (const kw of uniq) {
        let pm = k2p.get(kw); if (!pm) { pm = new Map(); k2p.set(kw, pm); }
        pm.set(sn, (pm.get(sn) || 0) + 1);
        let km = p2k.get(sn); if (!km) { km = new Map(); p2k.set(sn, km); }
        km.set(kw, (km.get(kw) || 0) + 1);
      }
    }
  }
  return { k2p, p2k };
}

const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function writeKeywordPages(k2p) {
  await fs.mkdir(KEYWORDS_DIR, { recursive: true });
  // filter: keyword used ≥3 times total OR by ≥2 distinct people
  const ranked = [];
  for (const [kw, pm] of k2p) {
    const total = [...pm.values()].reduce((a, b) => a + b, 0);
    if (total < 2 && pm.size < 2) continue;
    const score = Math.log(1 + total) * Math.log(1 + pm.size);
    ranked.push({ kw, total, people: pm.size, score, pm });
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const { kw, total, people, pm } of ranked) {
    const slug = slugify(kw);
    if (!slug) continue;
    const lines = [
      '---',
      `keyword: ${JSON.stringify(kw)}`,
      `total_uses: ${total}`,
      `distinct_people: ${people}`,
      'tags: [keyword]',
      '---',
      '',
      `# ${kw}`,
      '',
      `Used ${total}× by ${people} people.`,
      '',
      '## People',
    ];
    for (const [sn, n] of topN(pm, TOP_PEOPLE_PER_KEYWORD)) {
      lines.push(`- [[${safeName(sn)}]] — ${n}×`);
    }
    lines.push('');
    await fs.writeFile(path.join(KEYWORDS_DIR, `${slug}.md`), lines.join('\n'));
  }

  // index
  const idx = [
    '---', 'tags: [keyword, index]', '---', '',
    '# Keywords Index',
    '',
    `Total keywords passing filter: ${ranked.length}`,
    '',
    '## Top 100 by score',
  ];
  for (const r of ranked.slice(0, 100)) {
    idx.push(`- [[keywords/${slugify(r.kw)}|${r.kw}]] — ${r.total}× by ${r.people} people`);
  }
  await fs.writeFile(path.join(KEYWORDS_DIR, '_index.md'), idx.join('\n'));

  return ranked.length;
}

async function appendTopicsSection(p2k, ranked) {
  // Only include keywords that passed the global filter
  const ok = new Set(ranked.map((r) => r.kw));
  let updated = 0;
  for (const [sn, km] of p2k) {
    const top = topN(km, TOP_KEYWORDS_PER_PERSON).filter(([k]) => ok.has(k));
    if (!top.length) continue;
    const file = path.join(PEOPLE_DIR, `${safeName(sn)}.md`);
    let body;
    try { body = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const section = [
      '## Topics',
      ...top.map(([k, n]) => `- [[keywords/${slugify(k)}|${k}]] — ${n}×`),
      '',
    ].join('\n');
    // strip prior Topics section if present, then append
    const stripped = body.replace(/\n## Topics\n[\s\S]*?(?=\n## |\n*$)/, '\n');
    const next = stripped.endsWith('\n') ? stripped + section : stripped + '\n' + section;
    await fs.writeFile(file, next);
    updated++;
  }
  return updated;
}

function parseArgs(argv) {
  const a = { target: null, all: false, top: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--all') a.all = true;
    else if (v === '--top') a.top = Number(argv[++i]);
    else if (!v.startsWith('--')) a.target = v;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.target && !args.all && !args.top) {
    console.error('Usage: extract-keywords.mjs <screen_name>  |  --all  |  --top N');
    process.exit(1);
  }

  // sanity: ollama up + model present
  try {
    const r = await fetch('http://localhost:11434/api/tags');
    const j = await r.json();
    const have = (j.models || []).some((m) => m.name.startsWith(MODEL));
    if (!have) { console.error(`Model ${MODEL} not installed. Run: ollama pull ${MODEL}`); process.exit(1); }
  } catch {
    console.error('Ollama not reachable at http://localhost:11434. Run `ollama serve`.');
    process.exit(1);
  }

  const { Pool } = pg;
  const pool = new Pool(DB_CONFIG);
  const authors = await getAuthors(pool, args);
  console.log(`Processing ${authors.length} author(s) with ${MODEL}...`);

  const perAuthor = [];
  for (const sn of authors) {
    const items = await processAuthor(pool, sn);
    perAuthor.push([sn, items]);
  }

  console.log('Aggregating...');
  const { k2p, p2k } = aggregate(perAuthor);
  console.log(`  ${k2p.size} raw keywords across ${p2k.size} people`);

  console.log('Writing keyword pages...');
  // need to also fold in keywords from authors NOT in this run's people pages,
  // but for pilot scope we limit to processed authors only.
  // Build ranked once, share with appendTopicsSection.
  await fs.mkdir(KEYWORDS_DIR, { recursive: true });
  const ranked = [];
  for (const [kw, pm] of k2p) {
    const total = [...pm.values()].reduce((a, b) => a + b, 0);
    if (total < 2 && pm.size < 2) continue;
    ranked.push({ kw, total, people: pm.size, score: Math.log(1 + total) * Math.log(1 + pm.size), pm });
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const { kw, total, people, pm } of ranked) {
    const slug = slugify(kw);
    if (!slug) continue;
    const lines = [
      '---',
      `keyword: ${JSON.stringify(kw)}`,
      `total_uses: ${total}`,
      `distinct_people: ${people}`,
      'tags: [keyword]',
      '---',
      '',
      `# ${kw}`,
      '',
      `Used ${total}× by ${people} people.`,
      '',
      '## People',
    ];
    for (const [sn, n] of topN(pm, TOP_PEOPLE_PER_KEYWORD)) {
      lines.push(`- [[${safeName(sn)}]] — ${n}×`);
    }
    lines.push('');
    await fs.writeFile(path.join(KEYWORDS_DIR, `${slug}.md`), lines.join('\n'));
  }
  const idx = [
    '---', 'tags: [keyword, index]', '---', '',
    '# Keywords Index',
    '',
    `Total keywords passing filter: ${ranked.length}`,
    '',
    '## Top 100 by score',
  ];
  for (const r of ranked.slice(0, 100)) {
    idx.push(`- [[keywords/${slugify(r.kw)}|${r.kw}]] — ${r.total}× by ${r.people} people`);
  }
  await fs.writeFile(path.join(KEYWORDS_DIR, '_index.md'), idx.join('\n'));
  console.log(`  ${ranked.length} keyword pages + index`);

  console.log('Updating person pages...');
  const updated = await appendTopicsSection(p2k, ranked);
  console.log(`  ${updated} person pages got Topics section`);

  await pool.end();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
