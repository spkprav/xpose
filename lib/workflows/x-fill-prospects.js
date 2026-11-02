// "Fill X Prospects" workflow.
//
// Drives the crawlView through X people-search pages for each seed keyword.
// CrawlView's CDP debugger (set up in main.js) intercepts the /SearchTimeline
// GraphQL response; while this workflow runs, main.js routes those responses
// here via ctx.setXSearchSink instead of into the tweet crawler.
//
// Per seed:
//   1. Nav to https://x.com/search?q=<seed>&f=user
//   2. Wait for first results
//   3. Scroll N times to trigger pagination
//   4. Each intercepted SearchTimeline → extract TimelineUser entries → upsert
//
// After discovery, optionally enriches the just-discovered prospects with a
// website-fetch for any rows that have a website_url and no website_text yet.
// (Tweet pull is deferred to the embed step so the workflow stays bounded.)
//
// ctx = {
//   crawlView,                                          // Electron BrowserView
//   setXSearchSink(fn) / clearXSearchSink(),            // main.js exposes
//   upsertXProspectsBatch(rows)  -> {upserted,skipped},
//   saveWebsiteBlurb(prospectId, {url, text}),
//   fetchWebsiteBlurb(url),                              // from lib/prospects/web-fetch
//   findProspectIdByHandle(handle),                      // for web-blurb saves
//   emitProgress(phase, payload),
//   getSettings(),
// }

const { extractUsersFromSearchInstructions, extractCircleTweet } = require('../twitter/extractors');
const { CRAWL_ENTRY_PATHS } = require('../twitter/constants');

const DEFAULTS = {
  searchSeeds:      [],
  scrollsPerSeed:   8,
  scrollPauseMs:    3000,
  scrollJitterMs:   1500,
  navWaitMs:        6000,
  navJitterMs:      1500,
  betweenSeedsMs:   4000,
  zeroDeltaBreak:   2,           // stop a seed after N consecutive scrolls with no new users
  fetchWebsites:    true,        // post-discovery: fill website_text for new prospects
  maxWebsiteFetches: 50,         // cap per workflow run
  minFollowersForEnrich: 100,    // skip squatter / dead accounts (tuned for X people-search noise)
  fetchTweets:      true,        // post-discovery: pull recent tweets for each prospect
  maxTweetCrawls:   30,          // cap per workflow run (each crawl ~6s)
  tweetCrawlWaitMs: 6000,        // dwell on each /with_replies page so UserTweets fires
  embedAndScore:    true,        // post-enrichment: embed all 3 vectors + rank vs ICP
  embedScoreLimit:  200,         // top-N to surface
};

function humanPause(baseMs, jitterMs = 0) {
  const j = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
  return new Promise(r => setTimeout(r, baseMs + j));
}

async function navigate(view, url) {
  if (view.webContents.isDestroyed()) throw new Error('crawlView destroyed');
  await view.webContents.loadURL(url);
}

async function scrollOnce(view, deltaY = 1500) {
  if (view.webContents.isDestroyed()) return { atBottom: false, height: 0, top: 0 };
  try {
    return await view.webContents.executeJavaScript(`
      (function(){
        const t = document.scrollingElement || document.documentElement;
        const bottom = t.scrollHeight - t.clientHeight;
        const before = t.scrollTop;
        t.scrollTop = Math.min(before + ${deltaY}, bottom);
        window.dispatchEvent(new Event('scroll'));
        return { top: t.scrollTop, height: t.scrollHeight, atBottom: t.scrollTop >= bottom - 4 };
      })()
    `);
  } catch (_) {
    return { atBottom: false, height: 0, top: 0 };
  }
}

async function waitForSelector(view, selector, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (view.webContents.isDestroyed()) return false;
    const found = await view.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(selector)})`, true
    ).catch(() => false);
    if (found) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function run(ctx, opts = {}) {
  const tag = '[X:Workflow:fill-prospects]';
  const cfg = { ...DEFAULTS, ...opts };
  const { crawlView, emitProgress = () => {} } = ctx;

  if (!crawlView) return { ok: false, error: 'crawlView not available' };
  if (crawlView.webContents.isDestroyed()) return { ok: false, error: 'crawlView destroyed' };

  const skipDiscovery = !!cfg.skipDiscovery;
  const seeds = (cfg.searchSeeds || []).map(s => String(s).trim()).filter(Boolean);
  if (!skipDiscovery && !seeds.length) return { ok: false, error: 'searchSeeds required (or set skipDiscovery=true to enrich existing prospects)' };
  if (!skipDiscovery && (!ctx.setXSearchSink || !ctx.clearXSearchSink)) {
    return { ok: false, error: 'ctx.setXSearchSink / clearXSearchSink missing — main.js wiring incomplete' };
  }

  console.log(`${tag} start skipDiscovery=${skipDiscovery} seeds=${JSON.stringify(seeds)} scrollsPerSeed=${cfg.scrollsPerSeed}`);
  const startedAt = Date.now();
  const stats = { discovered: 0, upserted: 0, webFetched: 0, webFailed: 0, perSeed: {}, mode: skipDiscovery ? 'enrich-only' : 'full' };
  const newlyDiscoveredHandles = new Set();

  // Sink: every intercepted /SearchTimeline response on crawlView lands here.
  const sink = async (data) => {
    const resolver = CRAWL_ENTRY_PATHS['SearchTimeline'];
    const instructions = resolver ? resolver(data) : null;
    if (!instructions) {
      console.log(`${tag} SearchTimeline response with no instructions. keys:`, Object.keys(data || {}));
      return;
    }
    const users = extractUsersFromSearchInstructions(instructions);
    if (!users.length) return;
    const { upserted, skipped } = await ctx.upsertXProspectsBatch(users);
    stats.discovered += users.length;
    stats.upserted += upserted;
    // Extractor returns rows keyed by screen_name (Twitter API field). The
    // upsert helper normalizes to `handle` internally, but the workflow needs
    // the raw screen_name here for downstream nav (/<handle>/with_replies).
    users.forEach(u => {
      const h = u.handle || u.screen_name;
      if (h) newlyDiscoveredHandles.add(h);
    });
    emitProgress('users-batch', {
      extracted: users.length, upserted, skipped, message: `+${upserted} prospects (extracted ${users.length}, skipped ${skipped})`,
    });
  };

  // Phase 1: discovery. Skipped in enrich-only mode — handles get pulled from
  // DB instead (see below).
  if (skipDiscovery) {
    emitProgress('skip-discovery', { message: 'Skip discovery; loading existing X prospects from DB' });
    if (ctx.listXProspectHandles) {
      const rows = await ctx.listXProspectHandles({ minFollowers: cfg.minFollowersForEnrich });
      rows.forEach(h => newlyDiscoveredHandles.add(h));
      emitProgress('loaded-existing', { count: rows.length, message: `${rows.length} prospects loaded for enrichment (followers ≥ ${cfg.minFollowersForEnrich})` });
    } else {
      return { ok: false, error: 'ctx.listXProspectHandles missing — main.js wiring incomplete' };
    }
  } else {
    ctx.setXSearchSink(sink);
  }

  try {
    if (skipDiscovery) {
      // jump to enrichment
    } else {
    let seedIdx = 0;
    for (const seed of seeds) {
      if (seedIdx++ > 0) await humanPause(cfg.betweenSeedsMs, 1500);
      const seedStats = { extracted: 0, upserted: 0 };
      const before = { discovered: stats.discovered, upserted: stats.upserted };

      const url = `https://x.com/search?q=${encodeURIComponent(seed)}&f=user`;
      console.log(`${tag} seed="${seed}" nav -> ${url}`);
      emitProgress('navigate', { seed, url, message: `Searching X people for "${seed}"` });
      await navigate(crawlView, url);
      await humanPause(cfg.navWaitMs, cfg.navJitterMs);

      // Login wall / empty state detection.
      const ready = await waitForSelector(crawlView, '[data-testid="UserCell"], [data-testid="cellInnerDiv"]', 10_000);
      if (!ready) {
        emitProgress('warn', { seed, message: `${seed}: no user cells detected in 10s. Continuing scroll in case page loads late.` });
      }

      let lastUpserted = stats.upserted;
      let zeroDelta = 0;
      for (let i = 0; i < cfg.scrollsPerSeed; i++) {
        const r = await scrollOnce(crawlView, 1600);
        await humanPause(cfg.scrollPauseMs, cfg.scrollJitterMs);
        const gained = stats.upserted - lastUpserted;
        if (gained === 0) zeroDelta++; else zeroDelta = 0;
        lastUpserted = stats.upserted;
        emitProgress('scroll-tick', {
          seed, i: i + 1, total: cfg.scrollsPerSeed,
          atBottom: r.atBottom, gained, cumUpserted: stats.upserted - before.upserted,
          message: `${seed} scroll ${i + 1}/${cfg.scrollsPerSeed} (+${gained} this tick, ${stats.upserted - before.upserted} this seed)`,
        });
        if (zeroDelta >= cfg.zeroDeltaBreak && i >= 2) {
          emitProgress('scroll-stalled', { seed, atScroll: i + 1, message: `${seed}: ${zeroDelta} scrolls with no new prospects, stopping seed early` });
          break;
        }
      }

      seedStats.extracted = stats.discovered - before.discovered;
      seedStats.upserted  = stats.upserted   - before.upserted;
      stats.perSeed[seed] = seedStats;
      console.log(`${tag} seed="${seed}" done. extracted=${seedStats.extracted} upserted=${seedStats.upserted}`);
      emitProgress('seed-done', { seed, stats: seedStats });
    }
    }   // close: if (!skipDiscovery) { ... } else
  } finally {
    if (!skipDiscovery) ctx.clearXSearchSink();
  }

  // Resolve every newly-discovered handle to its DB row (id, followers, website
  // state) once up-front. The enrichment phases below filter against this set.
  const handleRows = new Map();   // handle -> { id, website_url, website_text, followers_count }
  if (ctx.findProspectIdByHandle && newlyDiscoveredHandles.size) {
    for (const h of newlyDiscoveredHandles) {
      try {
        const p = await ctx.findProspectIdByHandle(h);
        if (p) handleRows.set(h, p);
      } catch (_) {}
    }
  }
  // Followers threshold skips 0-follower dead/spam accounts (CbdBoulder,
  // cbd_not, etc. — bios like "no" with zero followers carry no ICP signal).
  const enrichableHandles = [...handleRows.entries()]
    .filter(([, p]) => (p.followers_count || 0) >= cfg.minFollowersForEnrich)
    .map(([h]) => h);
  stats.eligibleForEnrich = enrichableHandles.length;
  stats.skippedZeroFollowers = newlyDiscoveredHandles.size - enrichableHandles.length;

  // Optional post-discovery website fetch.
  if (cfg.fetchWebsites && ctx.fetchWebsiteBlurb && ctx.saveWebsiteBlurb && enrichableHandles.length) {
    const handles = enrichableHandles.slice(0, cfg.maxWebsiteFetches);
    emitProgress('web-fetch-start', { total: handles.length, message: `Fetching websites for ${handles.length} prospects (followers ≥ ${cfg.minFollowersForEnrich})` });
    stats.webFailedReasons = {};   // reason -> count
    for (const handle of handles) {
      try {
        const p = handleRows.get(handle);
        if (!p || !p.website_url || p.website_text) continue;
        const blurb = await ctx.fetchWebsiteBlurb(p.website_url);
        if (blurb.text) {
          await ctx.saveWebsiteBlurb(p.id, { url: blurb.url, text: blurb.text });
          stats.webFetched++;
          emitProgress('web-fetched', { handle, url: p.website_url, length: blurb.text.length, message: `web @${handle}: ${blurb.text.length} chars` });
        } else {
          stats.webFailed++;
          const reason = blurb.error || 'unknown';
          stats.webFailedReasons[reason] = (stats.webFailedReasons[reason] || 0) + 1;
          // pages[] carries the per-path errors when reason was 'no_pages'.
          const detail = (blurb.pages || []).map(pp => `${pp.path}:${pp.error || 'ok'}`).join(' ');
          emitProgress('web-failed', { handle, url: p.website_url, reason, detail, message: `web @${handle}: ${reason}${detail ? ' [' + detail + ']' : ''}` });
        }
      } catch (err) {
        stats.webFailed++;
        stats.webFailedReasons.exception = (stats.webFailedReasons.exception || 0) + 1;
        emitProgress('web-failed', { handle, error: err.message, reason: 'exception' });
      }
    }
  }

  // Optional post-discovery tweet pull. Drives crawlView through each
  // /<handle>/with_replies and intercepts the UserTweets / UserTweetsAndReplies
  // response, then saves to circle_tweets via ctx.upsertCircleTweetsBatch.
  // One page per handle (~20 tweets), no scroll, to keep workflow bounded.
  if (cfg.fetchTweets && ctx.setXUserTweetsSink && ctx.clearXUserTweetsSink && ctx.upsertCircleTweetsBatch && enrichableHandles.length) {
    // Skip handles that already have tweets cached — keeps re-runs idempotent
    // and cheap. User can force re-pull by clearing circle_tweets first.
    let candidates = enrichableHandles;
    if (ctx.handleHasTweets) {
      const filtered = [];
      for (const h of enrichableHandles) {
        try { if (!(await ctx.handleHasTweets(h))) filtered.push(h); }
        catch (_) { filtered.push(h); }
      }
      stats.tweetsSkippedCached = enrichableHandles.length - filtered.length;
      candidates = filtered;
    }
    const handles = candidates.slice(0, cfg.maxTweetCrawls);
    emitProgress('tweets-start', { total: handles.length, message: `Pulling recent tweets for ${handles.length} prospects (skipped ${stats.tweetsSkippedCached || 0} already-cached)` });
    stats.tweetsCrawled = 0;
    stats.tweetsSaved   = 0;
    stats.tweetsFailed  = 0;

    for (const handle of handles) {
      let pageTweets = 0;
      const sink = async (endpointType, data) => {
        const resolver = CRAWL_ENTRY_PATHS[endpointType];
        const instructions = resolver ? resolver(data) : null;
        if (!instructions) return;
        const tweets = [];
        for (const ins of instructions) {
          if (ins.type !== 'TimelineAddEntries') continue;
          for (const entry of ins.entries || []) {
            const entryId = entry.entryId || '';
            if (entryId.startsWith('cursor-')) continue;
            const c = entry.content;
            if (c?.itemContent?.tweet_results) {
              const t = extractCircleTweet(c.itemContent.tweet_results);
              if (t) tweets.push(t);
            } else if (Array.isArray(c?.items)) {
              for (const it of c.items) {
                const tr = it?.item?.itemContent?.tweet_results;
                if (tr) { const t = extractCircleTweet(tr); if (t) tweets.push(t); }
              }
            }
          }
        }
        if (tweets.length) {
          try {
            const { saved } = await ctx.upsertCircleTweetsBatch(tweets);
            pageTweets += saved.length;
          } catch (err) {
            console.error(`[X:Workflow:tweets] upsert error @${handle}:`, err.message);
          }
        }
      };
      ctx.setXUserTweetsSink(sink);
      try {
        const url = `https://x.com/${handle}/with_replies`;
        await navigate(crawlView, url);
        await new Promise(r => setTimeout(r, cfg.tweetCrawlWaitMs));
        stats.tweetsCrawled++;
        stats.tweetsSaved += pageTweets;
        emitProgress('tweets-pulled', { handle, saved: pageTweets, message: `tweets @${handle}: +${pageTweets}` });
      } catch (err) {
        stats.tweetsFailed++;
        emitProgress('tweets-failed', { handle, error: err.message });
      } finally {
        ctx.clearXUserTweetsSink();
      }
    }
  }

  // Embed + score tail. Optional but on by default — saves a manual trip to
  // the Prospects tab. Skips silently when ctx hooks or apiKey/ICP missing.
  if (cfg.embedAndScore && ctx.runXEmbedAndScore) {
    try {
      emitProgress('embed-start', { message: 'Embedding new prospects + ranking vs ICP…' });
      const r = await ctx.runXEmbedAndScore({ limit: cfg.embedScoreLimit });
      stats.embedded = r?.embed?.embedded || 0;
      stats.embedFailed = r?.embed?.failed || 0;
      stats.scored = r?.scored || 0;
      stats.scoreSearchId = r?.searchId || null;
      emitProgress('embed-done', { ...stats, message: `embedded ${stats.embedded}, scored ${stats.scored}. Open Prospects tab → Top 10 today.` });
    } catch (err) {
      emitProgress('embed-failed', { error: err.message, message: `embed/score failed: ${err.message}` });
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(`${tag} DONE. ${JSON.stringify(stats)} in ${durationMs}ms`);
  emitProgress('done', { stats, durationMs });
  return { ok: true, stats, durationMs };
}

module.exports = {
  id: 'x-fill-prospects',
  platform: 'x',
  label: 'Fill X Prospects',
  description: 'Drive crawlView through X people-search for each seed keyword. Auto-upsert every TimelineUser into prospects(platform=\'x\'). Optionally fetches each new prospect\'s website.',
  run,
  DEFAULTS,
};
