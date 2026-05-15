// Extract scoreable content from a circle_tweets row's raw_data:
//   text          — the user's own words (RT-stripped)
//   quoted_text   — quoted/RT'd tweet text (the thing they're commenting on)
//   image_urls    — direct https URLs for images (photo + video preview)
//   is_quote      — boolean
//   is_retweet    — boolean
//   reply_to      — screen_name or null
//
// Twitter API surface:
//   legacy.full_text                                    — own text
//   legacy.is_quote_status, quoted_status_id_str        — quote tweet flag
//   legacy.retweeted_status_result.result.legacy.*      — full RT'd tweet
//   quoted_status_result.result.legacy.*                — full quoted tweet
//   legacy.extended_entities.media[]                    — images / video preview frames
//   media[].media_url_https                             — direct CDN URL

function stripTcoUrls(text) {
  if (!text) return '';
  return String(text)
    .replace(/https?:\/\/t\.co\/\w+\s*$/g, '')
    .trim();
}

function imageUrlsFromMedia(media) {
  if (!Array.isArray(media)) return [];
  const urls = [];
  for (const m of media) {
    if (!m) continue;
    const u = m.media_url_https || m.media_url;
    if (!u) continue;
    urls.push(u);
  }
  return urls;
}

function extractContent(row) {
  const raw = row?.raw_data || {};
  const legacy = raw.legacy || {};

  const isRetweet = !!legacy.retweeted_status_result;
  const isQuote   = !!legacy.is_quote_status && !isRetweet;

  let text = legacy.full_text || row?.text || '';
  if (isRetweet) {
    text = text.replace(/^RT @\w+:\s*/, '').trim();
  }
  text = stripTcoUrls(text);

  let quotedText  = '';
  let quotedFrom  = '';
  let quotedMedia = [];
  if (isRetweet) {
    const rtResult = legacy.retweeted_status_result?.result || {};
    const rtLegacy = rtResult.legacy || {};
    quotedText  = stripTcoUrls(rtLegacy.full_text || '');
    quotedFrom  = rtResult.core?.user_results?.result?.core?.screen_name || '';
    quotedMedia = rtLegacy.extended_entities?.media || rtLegacy.entities?.media || [];
  } else if (isQuote) {
    const qResult = raw.quoted_status_result?.result
                 || raw.quotedStatus
                 || legacy.quoted_status_result?.result
                 || {};
    const qLegacy = qResult.legacy || {};
    quotedText  = stripTcoUrls(qLegacy.full_text || '');
    quotedFrom  = qResult.core?.user_results?.result?.core?.screen_name || '';
    quotedMedia = qLegacy.extended_entities?.media || qLegacy.entities?.media || [];
  }

  const ownMedia  = legacy.extended_entities?.media || legacy.entities?.media || [];
  const allMedia  = [...ownMedia, ...quotedMedia];
  const imageUrls = imageUrlsFromMedia(allMedia).slice(0, 4);

  return {
    text,
    quoted_text: quotedText,
    quoted_from: quotedFrom,
    image_urls: imageUrls,
    is_quote: isQuote,
    is_retweet: isRetweet,
    reply_to: legacy.in_reply_to_screen_name || row?.in_reply_to_screen_name || null,
  };
}

module.exports = { extractContent };
