#!/usr/bin/env node
// Read .cache/keywords/*.jsonl (whatever lib/wiki/extract-keywords.js has produced so far)
// and rebuild social-wiki/keywords/*.md + person Topics sections.
// Safe to run while lib/wiki/extract-keywords.js is still going.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DB_CONFIG = {
  host:     process.env.PGHOST     || 'localhost',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'xpose',
  port:     Number(process.env.PGPORT) || 54329,
  connectionTimeoutMillis: 5000, statement_timeout: 60000,
};

const AMBIENT_THRESHOLD = 50;  // keywords used by > N distinct people are "ambient", not niche

const WIKI_ROOT    = path.join(REPO_ROOT, 'social-wiki');
const PEOPLE_DIR   = path.join(WIKI_ROOT, 'people');
const KEYWORDS_DIR = path.join(WIKI_ROOT, 'keywords');
const CACHE_DIR    = path.join(REPO_ROOT, '.cache', 'keywords');

const TOP_KEYWORDS_PER_PERSON = 20;
const TOP_PEOPLE_PER_KEYWORD  = 30;

const STOP_KEYWORDS = new Set([
  'tweet','tweets','post','thread','twitter','x','today','time',
  'people','thing','things','someone','anyone','everyone',
  'question','answer','reply','comment',
  'yes','no','ok','okay','thanks','thank',
  'us','we','you','me','i','they','them','it',
  // model-output artifacts seen in the wild:
  'saa',           // model splits 'saas' badly in some cases
  'praveeninpublic', 'praveen', 'praveeninpublic_', // user's own handle (not in social_circle)
]);

// Heuristic: keyword likely a Twitter handle if it looks like one.
// Handles: 4-15 chars, letters+digits+underscore, no spaces, contains digit OR underscore OR mixed-case alpha.
function looksLikeHandle(kw) {
  if (!kw || kw.includes(' ')) return false;
  if (kw.length < 4 || kw.length > 15) return false;
  if (!/^[a-z0-9_]+$/.test(kw)) return false;
  // contains a digit or underscore = strong handle signal
  if (/[0-9_]/.test(kw)) return true;
  // pure alpha is fine — could be a real word
  return false;
}

function lemmatize(s) {
  let w = String(s).toLowerCase().trim();
  if (w.length <= 4) return w;  // protect short words / acronyms like saas, apis, news
  if (w.includes(' ')) return w.split(/\s+/).map(lemmatize).join(' ');
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  // strip trailing -s only if stem would still be >=4 chars
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 4) return w.slice(0, -1);
  return w;
}

const safeName = (n) => String(n).replace(/[^A-Za-z0-9_]/g, '_');
const slugify  = (s) =>
  String(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function loadAllCache() {
  let files;
  try { files = await fs.readdir(CACHE_DIR); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const sn = f.replace(/\.jsonl$/, '');
    const txt = await fs.readFile(path.join(CACHE_DIR, f), 'utf8');
    const items = [];
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        items.push({ id: o.id, k: o.k || [] });
      } catch {}
    }
    out.push([sn, items]);
  }
  return out;
}

function aggregate(perAuthor, screenNamesLower) {
  const k2p = new Map();
  const p2k = new Map();
  for (const [sn, items] of perAuthor) {
    for (const it of items) {
      const uniq = new Set();
      for (const raw of it.k) {
        const kw = lemmatize(raw);
        if (!kw || kw.length < 2 || STOP_KEYWORDS.has(kw)) continue;
        if (screenNamesLower.has(kw)) continue;
        if (looksLikeHandle(kw)) continue;
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

async function loadScreenNames() {
  const { Pool } = pg;
  const pool = new Pool(DB_CONFIG);
  const { rows } = await pool.query(`SELECT LOWER(screen_name) AS sn FROM social_circle WHERE screen_name IS NOT NULL`);
  await pool.end();
  return new Set(rows.map((r) => r.sn));
}

async function writeKeywordPages(k2p) {
  await fs.mkdir(KEYWORDS_DIR, { recursive: true });
  // remove old pages to avoid stale entries (keep _index.md replacement at end)
  const existing = await fs.readdir(KEYWORDS_DIR).catch(() => []);
  for (const f of existing) if (f.endsWith('.md')) await fs.rm(path.join(KEYWORDS_DIR, f), { force: true });

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
    const flavor = people > AMBIENT_THRESHOLD ? 'ambient' : 'niche';
    const lines = [
      '---',
      `keyword: ${JSON.stringify(kw)}`,
      `total_uses: ${total}`,
      `distinct_people: ${people}`,
      `tags: [keyword, ${flavor}]`,
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
    '## Top 200 by score',
  ];
  for (const r of ranked.slice(0, 200)) {
    idx.push(`- [[keywords/${slugify(r.kw)}|${r.kw}]] — ${r.total}× by ${r.people} people`);
  }
  await fs.writeFile(path.join(KEYWORDS_DIR, '_index.md'), idx.join('\n'));
  return ranked;
}

async function updatePersonPages(p2k, ranked) {
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
    const stripped = body.replace(/\n## Topics\n[\s\S]*?(?=\n## |\n*$)/, '\n');
    const next = stripped.endsWith('\n') ? stripped + section : stripped + '\n' + section;
    await fs.writeFile(file, next);
    updated++;
  }
  return updated;
}

async function main() {
  const perAuthor = await loadAllCache();
  console.log(`Loaded cache for ${perAuthor.length} authors`);
  const screenNamesLower = await loadScreenNames();
  console.log(`Loaded ${screenNamesLower.size} screen_names for collision filtering`);
  const { k2p, p2k } = aggregate(perAuthor, screenNamesLower);
  console.log(`Aggregated: ${k2p.size} raw keywords, ${p2k.size} people`);
  const ranked = await writeKeywordPages(k2p);
  console.log(`Wrote ${ranked.length} keyword pages + index`);
  const upd = await updatePersonPages(p2k, ranked);
  console.log(`Updated ${upd} person pages`);
}

main().catch((e) => { console.error(e); process.exit(1); });
