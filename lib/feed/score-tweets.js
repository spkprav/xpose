// LLM-based ICP-fit + reply-urgency scorer for list-feed tweets.
//
// Per tweet: extract content (text + quoted/RT text + image URLs) → vision pass
// captions any images → text model scores tweet content against ICP on 6 criteria
// (each 0-100 integer). Total = JS-computed weighted mean. LLM never sees the total.
//
// Tweet → ICP only. Author bio / followers / relationship are deliberately ignored
// because people drift from their ICP over time; we score what's IN the tweet.
//
// Usable as:
//   - module:  const { scoreUnscoredFeed } = require('./lib/feed/score-tweets');
//   - script:  node lib/feed/score-tweets.js [--limit N] [--hours N]

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const { extractContent } = require('./extract-content');

// Defaults — overridable via setConfig() called from main.js with settings panel values.
let CONFIG = {
  baseUrl:     process.env.OLLAMA_URL          || 'http://localhost:11434',
  textModel:   process.env.OLLAMA_MODEL_SCORE  || 'llama3:latest',
  visionUrl:   process.env.OLLAMA_VISION_URL   || null, // falls back to baseUrl
  visionModel: process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:7b',
  enableVision: true,
};

function setConfig(partial) {
  CONFIG = { ...CONFIG, ...partial };
}

const CRITERIA = [
  { key: 'icp_fit',              weight: 1.5 },
  { key: 'reply_opportunity',    weight: 1.2 },
  { key: 'freshness_window',     weight: 1.0 },
  { key: 'signal_quality',       weight: 1.0 },
  { key: 'voice_match',          weight: 0.7 },
  { key: 'virality_trajectory',  weight: 0.8 },
];
const WEIGHT_SUM = CRITERIA.reduce((a, c) => a + c.weight, 0);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ME_FILES  = [
  path.join(REPO_ROOT, 'social-wiki', 'me.md'),
  path.join(REPO_ROOT, 'social-wiki', 'PraveenInPublic.md'),
];

let cachedIcp = null;
let cachedIcpAt = 0;
const ICP_TTL_MS = 5 * 60 * 1000;

async function loadIcp() {
  if (cachedIcp && Date.now() - cachedIcpAt < ICP_TTL_MS) return cachedIcp;
  for (const fp of ME_FILES) {
    try {
      const txt = await fs.readFile(fp, 'utf8');
      const stripped = txt.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      cachedIcp = stripped;
      cachedIcpAt = Date.now();
      return cachedIcp;
    } catch {}
  }
  cachedIcp = 'Indie builder of an AI website-builder (mevin.ai). Replies-driven growth on X. Voice: smartness + groundedness, concrete numbers > vague claims, lowercase casual replies, no em dashes, no listicle voice.';
  cachedIcpAt = Date.now();
  return cachedIcp;
}

// ──────────────────────────────────────────── HTTP helpers ────────────────────

async function ollamaGenerate({ baseUrl, model, prompt, images = null, format = null, temperature = 0.4 }) {
  const body = {
    model, prompt, stream: false,
    options: { temperature, num_ctx: 4096 },
  };
  if (format) body.format = format;
  if (images && images.length) body.images = images;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.response || '';
}

async function fetchImageBase64(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`img ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────── Vision pass ─────────────────────

async function captionImages(imageUrls) {
  if (!CONFIG.enableVision || !imageUrls?.length) return '';
  const captions = [];
  for (const url of imageUrls) {
    try {
      const b64 = await fetchImageBase64(url);
      const visionPrompt = 'Describe this image in 1-2 sentences for someone scoring whether the parent tweet is worth replying to. Be specific: if it is a screenshot of code/UI/dashboard, say what app/tool. If a chart, what it shows. If a meme or photo, the actual content. No fluff.';
      const out = await ollamaGenerate({
        baseUrl: CONFIG.visionUrl || CONFIG.baseUrl,
        model: CONFIG.visionModel,
        prompt: visionPrompt,
        images: [b64],
        temperature: 0.2,
      });
      const cleaned = out.replace(/\s+/g, ' ').trim().slice(0, 280);
      if (cleaned) captions.push(cleaned);
    } catch (e) {
      captions.push(`(image unavailable: ${e.message.slice(0, 60)})`);
    }
  }
  return captions.join(' | ');
}

// ──────────────────────────────────────────── Text scoring ────────────────────

function buildPrompt(icp, tweet, content, caption) {
  const ageMin = tweet.created_at
    ? Math.max(0, Math.round((Date.now() - new Date(tweet.created_at).getTime()) / 60000))
    : null;
  const stats = `likes=${tweet.like_count || 0} rts=${tweet.retweet_count || 0} replies=${tweet.reply_count || 0} quotes=${tweet.quote_count || 0} views=${tweet.view_count || 0}`;
  const quotedBlock = content.quoted_text
    ? `\nQUOTED/RT'D TWEET (the thing this is replying to / amplifying)${content.quoted_from ? ` from @${content.quoted_from}` : ''}:\n"${content.quoted_text.slice(0, 600)}"`
    : '';
  const imageBlock = caption ? `\nIMAGE CONTENT: ${caption}` : '';
  const replyToBlock = content.reply_to ? `\n(this tweet is a reply to @${content.reply_to})` : '';

  return `Score THIS TWEET against the user's ICP. Score the TWEET ITSELF — not the author.
Bio means nothing. People drift from their ICP. Score what's actually in this tweet.

USER ICP:
${icp}

TWEET${content.is_retweet ? ' (retweet — score the underlying content)' : ''}${content.is_quote ? ' (quote tweet — judge the user\'s take + the quoted content together)' : ''}:
"${(content.text || '').slice(0, 600)}"${quotedBlock}${imageBlock}${replyToBlock}

CONTEXT: ${ageMin == null ? 'unknown age' : ageMin + ' min old'}, ${stats}

Score 6 criteria. Each: INTEGER 0-100. Use the FULL range — pick numbers like 27, 53, 71, 84.
Do NOT default to multiples of 10.

ANCHORS:

1. icp_fit — does this TWEET'S CONTENT match the user's ICP?
    8  = totally off (sports, lifestyle, regional politics)
    27 = tech-adjacent but wrong sub-niche (devrel, big-SaaS marketing)
    54 = builder space, generic content
    78 = directly about indie AI building, shipping, dev tools, vibe-coding
    93 = exact ICP overlap, would land a strong reply

2. reply_opportunity — does this TWEET invite a reply that lands?
    11 = closed statement, no hook, no question, no take to add to
    34 = mild opinion, low engagement potential
    58 = clear take or askable follow-up
    79 = explicit question / asks for help / contestable claim / gap to fill
    92 = high-signal question with thin reply pool

3. freshness_window — early enough that a reply gets seen?
    10 = >3h old OR >50 replies (saturated)
    35 = 1-3h old, mid reply density
    62 = 30-90 min old, light replies
    83 = <30 min old, almost no replies
    96 = <10 min old, zero replies

4. signal_quality — substance vs shitpost / motivation / lifecoach noise
    9  = ragebait, hot-take farming, F4F, "good morning" tweets
    28 = generic motivation / "100 days of code" diary
    52 = real but skin-deep observation
    74 = substantive technical or product take
    91 = original insight from actual ship work

5. voice_match — would replying align with user's voice (concrete, smart, grounded)?
    12 = topic forces vague/inspirational reply
    36 = generic reply territory
    58 = neutral, can be made specific
    77 = topic invites concrete-numbers reply
    89 = perfect for personal-story / shipping-anecdote reply

6. virality_trajectory — likes/views ratio + reply velocity → keeps growing?
    14 = dead, low views, no engagement
    33 = normal-for-a-mid-account
    55 = slightly above baseline
    76 = clear breakout (high like:view ratio early)
    90 = exceptional velocity

Output STRICT JSON only — no prose, no markdown:
{"icp_fit":<int>,"reply_opportunity":<int>,"freshness_window":<int>,"signal_quality":<int>,"voice_match":<int>,"virality_trajectory":<int>,"reason":"<one short sentence on why>"}`;
}

function parseScores(raw) {
  let obj;
  try { obj = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  const scores = {};
  for (const { key } of CRITERIA) {
    const v = Number(obj[key]);
    if (!Number.isFinite(v)) return null;
    scores[key] = Math.max(0, Math.min(100, Math.round(v)));
  }
  const reason = String(obj.reason || '').slice(0, 240);
  return { scores, reason };
}

function computeTotal(scores) {
  let acc = 0;
  for (const { key, weight } of CRITERIA) acc += (scores[key] || 0) * weight;
  return Math.round(acc / WEIGHT_SUM);
}

async function scoreOneTweet(tweet, icp) {
  const content = extractContent(tweet);
  const caption = await captionImages(content.image_urls);
  const prompt  = buildPrompt(icp, tweet, content, caption);
  const promptHash = crypto.createHash('sha1')
    .update(`${CONFIG.textModel}|${CONFIG.visionModel}|${prompt}|${caption}`)
    .digest('hex').slice(0, 12);
  const raw = await ollamaGenerate({
    baseUrl: CONFIG.baseUrl,
    model: CONFIG.textModel,
    prompt,
    format: 'json',
    temperature: 0.4,
  });
  const parsed = parseScores(raw);
  if (!parsed) throw new Error(`unparseable LLM output: ${raw.slice(0, 160)}`);
  const total = computeTotal(parsed.scores);
  await db.saveListTweetScore({
    tweetId: tweet.id,
    total,
    scores: parsed.scores,
    reason: parsed.reason,
    model: `${CONFIG.textModel}+${CONFIG.visionModel}`,
    promptHash,
  });
  return {
    id: tweet.id,
    screen_name: tweet.screen_name,
    total,
    scores: parsed.scores,
    reason: parsed.reason,
    image_count: content.image_urls.length,
    has_quote: !!content.quoted_text,
  };
}

/**
 * Score every unscored feed tweet within the past `hoursMax` hours.
 * Sequential by design (single Ollama instance).
 *
 * @param {object} opts
 * @param {number} opts.hoursMax  default 3
 * @param {number} opts.limit     default 100
 * @param {function} opts.onStart       (n)  — total to process
 * @param {function} opts.onTweetStart  (i, n, tweet)
 * @param {function} opts.onTweetDone   (i, n, result)
 * @param {function} opts.onTweetError  (i, n, tweet, error)
 * @returns {Promise<{scored:number, failed:number, total:number}>}
 */
async function scoreUnscoredFeed({ hoursMax = 3, limit = 100, onStart, onTweetStart, onTweetDone, onTweetError } = {}) {
  const tweets = await db.getUnscoredFeedTweets({ hoursMax, limit });
  if (onStart) try { onStart(tweets.length); } catch {}
  if (!tweets.length) return { scored: 0, failed: 0, total: 0 };

  const icp = await loadIcp();
  let scored = 0, failed = 0;
  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    if (onTweetStart) try { onTweetStart(i + 1, tweets.length, t); } catch {}
    try {
      const r = await scoreOneTweet(t, icp);
      scored++;
      if (onTweetDone) try { onTweetDone(i + 1, tweets.length, r); } catch {}
    } catch (e) {
      failed++;
      console.error(`[feed-score] ${t.id} @${t.screen_name}: ${e.message}`);
      if (onTweetError) try { onTweetError(i + 1, tweets.length, t, e); } catch {}
    }
  }
  return { scored, failed, total: tweets.length };
}

module.exports = {
  scoreUnscoredFeed,
  scoreOneTweet,
  loadIcp,
  setConfig,
  CRITERIA,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const hours = Number(getArg('--hours', 3));
  const limit = Number(getArg('--limit', 100));
  (async () => {
    db.configure({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE,
    });
    const r = await scoreUnscoredFeed({
      hoursMax: hours,
      limit,
      onTweetStart: (i, n, t) => process.stdout.write(`[${i}/${n}] @${t.screen_name} ${String(t.id).slice(-6)} ... `),
      onTweetDone:  (i, n, r) => {
        const top = Object.entries(r.scores).sort((a, b) => b[1] - a[1])[0];
        console.log(`total=${r.total} top=${top[0]}:${top[1]} imgs=${r.image_count} quote=${r.has_quote ? 'y' : 'n'} — ${(r.reason || '').slice(0, 80)}`);
      },
      onTweetError: (i, n, t, e) => console.log(`FAIL ${e.message.slice(0, 100)}`),
    });
    console.log(`Done: scored=${r.scored} failed=${r.failed} of ${r.total}`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
