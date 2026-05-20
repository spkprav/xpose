// Minimal Telegram Bot API client — outbound only.
// Used by main.js to push high-score list-feed tweets to a Telegram chat
// after each list crawl completes. No incoming webhook, no polling.
//
// Config (from settings.telegram):
//   botToken     — bot HTTP API token from @BotFather
//   chatId       — numeric chat id, e.g. -1001234567890 (group) or 123456789 (DM)
//   minScore     — only push tweets at/above this LLM score (0–100)
//   maxPerCrawl  — cap per crawl
//   hoursWindow  — look-back window in hours

const https = require('https');

function tgRequest(token, method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch (e) {
          reject(new Error(`Telegram ${method} non-JSON ${res.statusCode}: ${buf.slice(0, 200)}`));
          return;
        }
        if (!json.ok) {
          reject(new Error(`Telegram ${method} ${res.statusCode}: ${json.description || 'unknown error'}`));
          return;
        }
        resolve(json.result);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage({ botToken, chatId, text, disablePreview = false }) {
  if (!botToken || !chatId) throw new Error('Telegram botToken/chatId missing');
  return tgRequest(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: !!disablePreview,
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRelativeAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatNumber(n) {
  if (!n) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function scoreBadge(total) {
  if (total == null) return '⚪';
  if (total >= 80) return '🟢';
  if (total >= 60) return '🟡';
  if (total >= 40) return '🟠';
  return '🔴';
}

// Format a single tweet row (from db.getListFeedScored) into a Telegram HTML message.
// Goal: enough context that the user can decide to reply without opening X first.
function formatTweet(row, { slug } = {}) {
  const url = `https://x.com/${row.screen_name}/status/${row.id}`;
  const score = row.score_total != null ? `${row.score_total}` : '?';
  const badge = scoreBadge(row.score_total);
  const reason = row.score_reason ? escapeHtml(row.score_reason).slice(0, 280) : '';
  const text = escapeHtml((row.text || '').slice(0, 800));
  const age = formatRelativeAge(row.created_at);
  const lists = Array.isArray(row.source_lists) ? row.source_lists.join(', ') : (slug || '');
  const followers = formatNumber(row.followers_count);
  const rel = row.relationship ? escapeHtml(String(row.relationship)) : '';

  const headerBits = [`<b>@${escapeHtml(row.screen_name)}</b>`];
  if (followers) headerBits.push(`${followers} followers`);
  if (rel)       headerBits.push(rel);

  const metaBits = [age, lists ? `[${escapeHtml(lists)}]` : null].filter(Boolean).join(' · ');

  const stats = [
    row.like_count    ? `❤️${formatNumber(row.like_count)}` : null,
    row.retweet_count ? `🔁${formatNumber(row.retweet_count)}` : null,
    row.reply_count   ? `💬${formatNumber(row.reply_count)}` : null,
    row.quote_count   ? `📝${formatNumber(row.quote_count)}` : null,
    row.view_count    ? `👁${formatNumber(row.view_count)}` : null,
  ].filter(Boolean).join('  ');

  // Score breakdown — abbreviated keys to fit one line.
  let breakdown = '';
  if (row.score_breakdown && typeof row.score_breakdown === 'object') {
    const sb = row.score_breakdown;
    const parts = [
      sb.icp_fit             != null ? `icp ${sb.icp_fit}`              : null,
      sb.reply_opportunity   != null ? `reply ${sb.reply_opportunity}`  : null,
      sb.freshness_window    != null ? `fresh ${sb.freshness_window}`   : null,
      sb.signal_quality      != null ? `sig ${sb.signal_quality}`       : null,
      sb.voice_match         != null ? `voice ${sb.voice_match}`        : null,
      sb.virality_trajectory != null ? `viral ${sb.virality_trajectory}`: null,
    ].filter(Boolean);
    if (parts.length) breakdown = parts.join(' · ');
  }

  return [
    `${badge} <b>${score}</b>  ${headerBits.join(' · ')}`,
    metaBits || null,
    '',
    text,
    '',
    breakdown ? `<b>scores</b>  ${breakdown}` : null,
    reason   ? `<b>why</b>  <i>${reason}</i>` : null,
    stats    || null,
    url,
  ].filter(v => v !== null).join('\n');
}

/**
 * Push a batch of tweet rows to Telegram. Rows come pre-sorted from
 * db.getListFeedScored (highest score first).
 * Returns { sent, skipped, failed }.
 */
async function pushTweets({ botToken, chatId, rows, slug = null }) {
  let sent = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    try {
      await sendMessage({
        botToken,
        chatId,
        text: formatTweet(row, { slug }),
        disablePreview: false,
      });
      sent++;
      // Telegram rate-limit: ~30 msg/sec global, but 1/sec per chat is the safe upper bound.
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) {
      failed++;
      console.error(`[Telegram] send failed for ${row.id}: ${err.message}`);
    }
  }
  return { sent, skipped, failed };
}

async function testConnection({ botToken, chatId }) {
  if (!botToken) throw new Error('botToken missing');
  const me = await tgRequest(botToken, 'getMe', {});
  if (chatId) {
    await sendMessage({
      botToken,
      chatId,
      text: `<b>xpose</b> Telegram link verified. Bot: <code>@${escapeHtml(me.username || '')}</code>`,
      disablePreview: true,
    });
  }
  return me;
}

module.exports = { sendMessage, pushTweets, formatTweet, testConnection };
