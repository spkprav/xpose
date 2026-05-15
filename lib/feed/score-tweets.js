// LLM-based ICP-fit + reply-urgency scorer for list-feed tweets.
//
// Per tweet: ask local Ollama for 6 criteria (each 0-100, integer).
// Total = JS-computed weighted mean of criteria. LLM never sees the total.
//
// Anchors per criterion are baked into the prompt so the model spreads scores
// across the 0-100 range instead of snapping to round numbers.
//
// Usable as:
//   - module:  const { scoreUnscoredFeed } = require('./lib/feed/score-tweets');
//   - script:  node lib/feed/score-tweets.js [--once] [--limit N] [--hours N]

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const MODEL      = process.env.OLLAMA_MODEL_SCORE || process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Per-criterion weights. Total = round(Σ s_i * w_i / Σ w_i) → 0..100.
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

function buildPrompt(icp, tweet) {
  const ageMin = tweet.created_at
    ? Math.max(0, Math.round((Date.now() - new Date(tweet.created_at).getTime()) / 60000))
    : null;
  const stats = `likes=${tweet.like_count || 0} rts=${tweet.retweet_count || 0} replies=${tweet.reply_count || 0} quotes=${tweet.quote_count || 0} views=${tweet.view_count || 0}`;
  return `You are a tweet-fit scorer for an indie-builder's X reply strategy.

USER ICP / VOICE:
${icp}

Score 6 criteria for the tweet below. Each criterion: INTEGER 0-100.
Use the FULL range. Do NOT snap to multiples of 10. Pick numbers like 27, 53, 71, 84.
If you want to write 70, ask: is it 67 or 73? Pick one.

CRITERIA + ANCHORS:

1. icp_fit — does the AUTHOR + TOPIC overlap the user's ICP (indie AI builders, dev tools, in-public launches)?
     8  = totally off (sports, lifestyle, regional news)
    27  = tech-adjacent but wrong sub-niche (devrel, big-SaaS marketing)
    54  = builder space, generic content
    78  = indie AI builder, shipping product, replicable pattern
    93  = exact ICP overlap, author and tweet both on-target

2. reply_opportunity — how much does this tweet INVITE a reply that lands?
    11  = closed statement, no hook, no question, no contestable claim
    34  = mild opinion, low engagement potential
    58  = clear take, askable follow-up
    79  = explicit question / asks for help / gap to fill / contestable claim
    92  = high-signal question with thin reply pool

3. freshness_window — is it early enough that a reply gets seen?
    Tweet age: ${ageMin == null ? 'unknown' : ageMin + ' min'}; current ${stats}.
    10  = >3h old OR >50 replies already (saturated)
    35  = 1-3h old, mid reply density
    62  = 30-90 min old, light replies
    83  = <30 min old, almost no replies
    96  = <10 min old, zero replies

4. signal_quality — substance vs shitpost / motivation / lifecoach noise
    9   = ragebait, hot-take farming, F4F engagement
    28  = generic motivation / "100 days of code" diary
    52  = real but skin-deep observation
    74  = substantive technical or product take
    91  = original insight from actual ship work

5. voice_match — would replying align with user's voice (concrete, smart, grounded)?
    12  = topic forces vague/inspirational reply
    36  = generic reply territory
    58  = neutral, can be made specific
    77  = topic invites concrete-numbers reply
    89  = topic perfect for personal-story / shipping-anecdote reply

6. virality_trajectory — likes/views ratio + reply velocity → likely to keep growing?
    Stats: ${stats}.
    14  = dead, low views, no engagement
    33  = normal-for-author, no breakout signal
    55  = slightly above baseline
    76  = clear breakout (high like:view ratio early)
    90  = exceptional velocity, going wide

ACCOUNT:
@${tweet.screen_name} (${tweet.relationship || 'unknown'}, ${tweet.followers_count || 0} followers, ${tweet.following_count || 0} following)
bio: ${(tweet.bio || '').slice(0, 240) || '(no bio)'}

TWEET:
"${String(tweet.text || '').slice(0, 600).replace(/"/g, "'")}"
${tweet.in_reply_to_screen_name ? `(reply to @${tweet.in_reply_to_screen_name})` : '(original)'}
age: ${ageMin == null ? 'unknown' : ageMin + ' min'}, ${stats}

Output STRICT JSON only — no prose, no markdown:
{"icp_fit":<int>,"reply_opportunity":<int>,"freshness_window":<int>,"signal_quality":<int>,"voice_match":<int>,"virality_trajectory":<int>,"reason":"<one short sentence on why>"}`;
}

async function callOllama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.4, num_ctx: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.response || '';
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
  const prompt = buildPrompt(icp, tweet);
  const promptHash = crypto.createHash('sha1').update(MODEL + '|' + prompt).digest('hex').slice(0, 12);
  const raw = await callOllama(prompt);
  const parsed = parseScores(raw);
  if (!parsed) throw new Error(`unparseable LLM output: ${raw.slice(0, 160)}`);
  const total = computeTotal(parsed.scores);
  await db.saveListTweetScore({
    tweetId: tweet.id,
    total,
    scores: parsed.scores,
    reason: parsed.reason,
    model: MODEL,
    promptHash,
  });
  return { id: tweet.id, total, scores: parsed.scores, reason: parsed.reason };
}

/**
 * Score every unscored feed tweet within the past `hoursMax` hours.
 * Sequential by design (local Ollama → 1 model in memory).
 * @param {object} opts
 * @param {number} opts.hoursMax  default 3
 * @param {number} opts.limit     default 100
 * @param {function} opts.onProgress (i, n, result)
 * @returns {Promise<{scored:number, failed:number, skipped:number}>}
 */
async function scoreUnscoredFeed({ hoursMax = 3, limit = 100, onProgress = null } = {}) {
  const tweets = await db.getUnscoredFeedTweets({ hoursMax, limit });
  if (!tweets.length) return { scored: 0, failed: 0, skipped: 0, total: 0 };

  const icp = await loadIcp();
  let scored = 0, failed = 0;
  for (let i = 0; i < tweets.length; i++) {
    try {
      const r = await scoreOneTweet(tweets[i], icp);
      scored++;
      if (onProgress) onProgress(i + 1, tweets.length, r);
    } catch (e) {
      failed++;
      console.error(`[feed-score] ${tweets[i].id} @${tweets[i].screen_name}: ${e.message}`);
    }
  }
  return { scored, failed, skipped: 0, total: tweets.length };
}

module.exports = {
  scoreUnscoredFeed,
  scoreOneTweet,
  loadIcp,
  CRITERIA,
};

// CLI mode
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
      onProgress: (i, n, res) => {
        const top = Object.entries(res.scores).sort((a, b) => b[1] - a[1])[0];
        console.log(`[${i}/${n}] ${res.id} → total=${res.total} (top: ${top[0]}=${top[1]}) — ${res.reason.slice(0, 80)}`);
      },
    });
    console.log(`Done: scored=${r.scored} failed=${r.failed} of ${r.total}`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
