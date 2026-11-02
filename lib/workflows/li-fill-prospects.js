// "Fill LinkedIn Prospects" workflow.
//
// Drives the linkedinView through key endpoints that surface Profile entries:
//   1. /mynetwork/invite-connect/connections/  → 1st-degree connections (paged)
//   2. /mynetwork/                              → "people you may know" cards
//   3. /search/results/people/?keywords=<seed>  → SRP people results (optional)
//
// While running, the recon module's auto-store mode is enabled so every
// captured voyager response auto-upserts into prospects (platform='linkedin').
//
// All deps come through ctx — module has no imports of main.js.
//
// ctx = {
//   linkedinView   : Electron BrowserView,
//   recon          : require('../linkedin/recon'),
//   emitProgress   : (phase, payload?) => void,
//   sleep          : ms => Promise,
//   getSettings    : () => settings object,
// }

const { scrapeProfilesFromPage } = require('../linkedin/dom-scrape');

const URLS = {
  feed:           'https://www.linkedin.com/feed/',
  connections:    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  myNetwork:      'https://www.linkedin.com/mynetwork/',
  peopleSearchFn: (q, page = 1) =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}` +
    (page > 1 ? `&page=${page}` : ''),
};

const DEFAULTS = {
  feedScrolls:        12,
  connectionsScrolls: 8,
  myNetworkScrolls:   4,
  searchScrolls:      3,
  searchPages:        5,
  scrollPauseMs:      4000,       // base pause; jittered ±1500ms below
  scrollJitterMs:     1500,       // random jitter added per pause
  navWaitMs:          7000,       // base wait after URL nav; jittered ±2000ms
  navJitterMs:        2000,
  betweenSeedsMs:     5000,       // pause between seed switches; jittered
  betweenPagesMs:     3500,       // pause between pages within a seed; jittered
  searchSeeds:        [],
  skipFeed:           false,
  skipConnections:    false,
  skipMyNetwork:      false,
  saveHtmlSnapshots:  true,       // dump <pattern>.html per phase
};

function humanPause(baseMs, jitterMs = 0) {
  const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
  return new Promise(r => setTimeout(r, baseMs + jitter));
}

// CDP-driven wheel event. The real one — fires at OS layer, triggers React
// intersection observers, virtualized list loaders, lazy-load handlers.
// Synthetic JS `new WheelEvent(...)` does NOT trigger LinkedIn's scroll
// listeners (verified: a full session produced 0 feed paginations).
async function cdpWheel(view, deltaY = 1200, x = 600, y = 400) {
  try {
    await view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY,
      pointerType: 'mouse', button: 'none', clickCount: 0,
    });
  } catch (err) {
    // Debugger might not be attached; fall back to JS-injected scroll.
    await view.webContents.executeJavaScript(`(document.scrollingElement || document.documentElement).scrollBy(0, ${deltaY})`, true);
  }
}

// LinkedIn-specific scroll helper. Measures progress by counting profile links
// (`a[href*="/in/"]`) instead of scrollHeight — `scrollHeight` is unreliable
// on LinkedIn's fixed-shell + internal-overflow layout.
//
// Each tick:
//   1. CDP wheel event (real)
//   2. Programmatic scrollBy on scrollingElement + nested scaffold containers
//   3. Click any visible "Show more" / "Show all" / "Load more" button
//   4. Count profile links. Stall = no new links for 2 ticks.
async function scrollAndWait(view, times, pauseMs, emitProgress, phase) {
  const tag = '[LinkedIn:Scroll]';
  let lastLinks = 0;
  let stallCount = 0;

  for (let i = 0; i < times; i++) {
    if (view.webContents.isDestroyed()) return;

    // Real wheel event (4 short ticks > 1 long tick for triggering observers).
    for (let k = 0; k < 4; k++) {
      await cdpWheel(view, 800, 600, 400);
      await new Promise(r => setTimeout(r, 80));
    }

    const result = await view.webContents.executeJavaScript(`
      (function() {
        const out = { linksBefore: 0, linksAfter: 0, clickedButtons: [], containers: 0, scrolledTo: 0, height: 0 };
        out.linksBefore = document.querySelectorAll('a[href*="/in/"]').length;

        // Scroll the real scrolling element.
        const scroller = document.scrollingElement || document.documentElement;
        scroller.scrollBy({ top: 1500, behavior: 'auto' });
        out.scrolledTo = scroller.scrollTop;
        out.height = scroller.scrollHeight;

        // Scroll nested scaffold containers (some LinkedIn pages use them).
        const selectors = [
          '.scaffold-finite-scroll',
          '.scaffold-finite-scroll__content',
          '[class*="scaffold-finite-scroll"]',
          '.reusable-search__entity-result-list',
          '.search-results-container',
          '.mn-connections__list',
          '[data-view-name="connections-list"]',
          'main',
        ];
        const seen = new Set();
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            if (el.scrollHeight > el.clientHeight) {
              el.scrollBy({ top: 1500, behavior: 'auto' });
              out.containers++;
            }
          });
        }

        // Click visible result-pagination buttons only.
        // EXCLUDE: filter UI ("Show all filters"), "Load more comments" (per-post threads),
        // any button mentioning "filter" / "sort" / "premium" / "save" / "follow" / "connect".
        const candidates = [...document.querySelectorAll('button, a[role="button"]')];
        const ALLOW = /(show more results|see more results|load more results|next page|more results below)/;
        const DENY  = /(filter|sort|premium|connect|follow|save|message|invite|comment|reply|dismiss|share|reaction|emoji|menu|expand collapsible)/;
        for (const b of candidates) {
          if (out.clickedButtons.length >= 2) break;
          const text = ((b.innerText || b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().toLowerCase();
          if (!text) continue;
          if (DENY.test(text)) continue;
          if (!ALLOW.test(text)) continue;
          const rect = b.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (b.disabled) continue;
          try { b.click(); out.clickedButtons.push(text.slice(0, 40)); } catch (_) {}
        }

        out.linksAfter = document.querySelectorAll('a[href*="/in/"]').length;
        return out;
      })()
    `, true);

    const linkDelta = result.linksAfter - result.linksBefore;
    const cumDelta = result.linksAfter - lastLinks;
    if (emitProgress) {
      emitProgress('scroll-tick', {
        phase, i: i + 1, total: times,
        linksBefore: result.linksBefore, linksAfter: result.linksAfter,
        height: result.height, scrolledTo: result.scrolledTo,
        clickedButtons: result.clickedButtons || [],
        containers: result.containers || 0,
        message: `${phase} scroll ${i + 1}/${times} (links ${result.linksBefore}→${result.linksAfter}, +${cumDelta} cum${result.clickedButtons?.length ? `, clicked ${result.clickedButtons.length}` : ''})`,
      });
    }
    console.log(`${tag} ${phase} ${i + 1}/${times} links=${result.linksBefore}→${result.linksAfter} cumDelta=${cumDelta} h=${result.height} scrolledTo=${result.scrolledTo} containers=${result.containers} clicks=[${(result.clickedButtons || []).join('|')}]`);

    // Stall detection: 2 consecutive scrolls with no link growth.
    if (result.linksAfter <= lastLinks) {
      stallCount++;
      if (stallCount >= 2) {
        console.log(`${tag} ${phase} stalled at links=${result.linksAfter} — stopping early at ${i + 1}/${times}`);
        if (emitProgress) emitProgress('scroll-stalled', { phase, atScroll: i + 1, total: times, message: `${phase}: no new profile links, stopping at ${i + 1}/${times}` });
        break;
      }
    } else {
      stallCount = 0;
    }
    lastLinks = result.linksAfter;

    // Human jitter on pause.
    const jitter = Math.floor(Math.random() * 1500);
    await new Promise(r => setTimeout(r, pauseMs + jitter));
  }
}

const { snapshotHtml: snapshotHtmlShared } = require('../linkedin/snapshot');
async function snapshotHtml(view, phase) {
  const r = await snapshotHtmlShared(view, phase);
  if (!r.ok) {
    console.error(`[LinkedIn:Snapshot] ${phase} error:`, r.error);
    return null;
  }
  return r.file;
}

async function navigate(view, url) {
  if (view.webContents.isDestroyed()) throw new Error('linkedinView destroyed');
  await view.webContents.loadURL(url);
}

// After load: dump what actually rendered. Lets you see if LinkedIn redirected
// to login, served a restriction interstitial, or just didn't fill the feed.
async function pageDiagnostic(view) {
  if (view.webContents.isDestroyed()) return null;
  return view.webContents.executeJavaScript(`
    (function() {
      const sel = {
        feed:        '.feed-shared-update-v2, .scaffold-finite-scroll__content',
        connections: '.mn-connection-card, [data-view-name="connections-list"]',
        mynetwork:   '.discover-entity-type-card, .mn-cohorts-list',
        search:      '.reusable-search__entity-result-list, .search-results-container, [data-view-name="search-entity-result-universal-template"]',
        login:       'input[name="session_key"], form[data-litms-control-urn*="login"]',
        captcha:     '#captcha-internal, iframe[src*="captcha"], iframe[src*="challenge"]',
        restricted:  '[data-test-id="restricted-account"], .application-error',
      };
      const found = {};
      for (const k of Object.keys(sel)) found[k] = !!document.querySelector(sel[k]);
      const scroller = document.scrollingElement || document.documentElement;
      return {
        href: location.href,
        title: document.title,
        height: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        profileLinks: document.querySelectorAll('a[href*="/in/"]').length,
        feedCount:        document.querySelectorAll('.feed-shared-update-v2, [data-id^="urn:li:activity"]').length,
        connectionsCount: document.querySelectorAll('.mn-connection-card, [data-view-name="connections-list"] li').length,
        searchCount:      document.querySelectorAll('[data-view-name="search-entity-result-universal-template"], .reusable-search__result-container').length,
        found,
        bodyPreview: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
      };
    })()
  `, true);
}

// Wait for a content-presence selector before scrolling. Returns true if it
// appeared within timeoutMs, false if not (caller logs + proceeds).
async function waitForContent(view, selectors, timeoutMs = 12000) {
  const start = Date.now();
  const sel = Array.isArray(selectors) ? selectors.join(', ') : selectors;
  while (Date.now() - start < timeoutMs) {
    if (view.webContents.isDestroyed()) return false;
    const found = await view.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(sel)})`, true
    );
    if (found) return true;
    await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

async function run(ctx, opts = {}) {
  const tag = '[LinkedIn:Workflow:li-fill]';
  const cfg = { ...DEFAULTS, ...opts };
  const { linkedinView, recon, emitProgress = () => {} } = ctx;
  console.log(`${tag} start`, { opts, hasView: !!linkedinView });
  if (!linkedinView) {
    console.log(`${tag} abort: linkedinView missing`);
    return { ok: false, error: 'linkedinView not available' };
  }
  if (linkedinView.webContents.isDestroyed()) {
    console.log(`${tag} abort: linkedinView destroyed`);
    return { ok: false, error: 'linkedinView destroyed' };
  }

  const startedAt = Date.now();
  const phaseStats = { feed: 0, connections: 0, mynetwork: 0, search: 0 };

  // Attach recon + autostore. If recon already attached we just flip autostore on.
  const reconStatus = recon.status();
  console.log(`${tag} recon status before:`, { attached: reconStatus.attached });
  emitProgress('attach', { message: 'Attaching recon + enabling auto-store' });
  if (!reconStatus.attached) {
    const ok = recon.attach(linkedinView, {
      ingestFn: ctx.ingestFn,
      onEvent: ctx.onReconEvent,
    });
    console.log(`${tag} recon.attach ->`, ok);
    if (!ok.ok) return { ok: false, error: `recon attach failed: ${ok.error}` };
  }
  recon.setAutoStore(true);
  console.log(`${tag} auto-store enabled`);

  const baseline = recon.status().ingest_stats?.upserted || 0;
  console.log(`${tag} baseline upserts: ${baseline}`);

  try {
    let cumDelta = 0;

    // Scrape current DOM for profile cards + push through ingestFn. The
    // recon stream catches voyager profiles; DOM scrape catches the URN-stub
    // case (search results) and the "page rendered but voyager Profile entries
    // lacked publicIdentifier" case. Belt + suspenders.
    const selfHandle = ctx.getSettings?.()?.identity?.handle || null;
    async function harvestDOM(phase) {
      try {
        const rows = await scrapeProfilesFromPage(linkedinView, { selfHandle });
        if (!rows || !rows.length) return 0;
        const n = await (ctx.ingestFn ? ctx.ingestFn(rows) : Promise.resolve(0));
        // Bridge DOM upserts into recon's counter so workflow phaseStats sees them.
        if (typeof recon.recordExternalUpserts === 'function') {
          recon.recordExternalUpserts(rows.length, typeof n === 'number' ? n : rows.length, `dom:${phase}`);
        }
        emitProgress('dom-harvest', { phase, scraped: rows.length, upserted: n, message: `${phase}: DOM scraped ${rows.length}, upserted ${n}` });
        console.log(`[LinkedIn:DOM] ${phase} scraped=${rows.length} upserted=${n}`);
        return n;
      } catch (err) {
        emitProgress('dom-harvest-error', { phase, error: err.message });
        console.error(`[LinkedIn:DOM] ${phase} error:`, err.message);
        return 0;
      }
    }

    // Helper: nav → wait for content → diagnostic dump → scroll + DOM scrape.
    async function runPhase({ url, phase, contentSel, scrolls }) {
      console.log(`${tag} phase=${phase} nav -> ${url}`);
      emitProgress('navigate', { url, phase, message: `Navigating: ${phase}` });
      await navigate(linkedinView, url);
      await humanPause(cfg.navWaitMs, cfg.navJitterMs);

      const appeared = await waitForContent(linkedinView, contentSel, 12_000);
      const diag = await pageDiagnostic(linkedinView);
      if (diag) {
        const found = Object.entries(diag.found).filter(([_, v]) => v).map(([k]) => k).join(',') || 'none';
        emitProgress('diagnostic', {
          phase,
          message: `${phase}: profileLinks=${diag.profileLinks} h=${diag.height}/${diag.clientHeight} feed=${diag.feedCount} conn=${diag.connectionsCount} search=${diag.searchCount} found=[${found}]`,
        });
        console.log(`${tag} ${phase} diag:`, JSON.stringify(diag));
        if (diag.found.login) {
          emitProgress('error', { phase, error: `${phase}: hit login wall. Log into LinkedIn on the left pane first.` });
          return false;
        }
        if (diag.found.captcha) {
          emitProgress('error', { phase, error: `${phase}: hit captcha/challenge. Solve manually on the left pane.` });
          return false;
        }
        if (diag.found.restricted) {
          emitProgress('error', { phase, error: `${phase}: account restriction. Check LinkedIn on the left pane.` });
          return false;
        }
      }
      if (!appeared) {
        emitProgress('warn', { phase, message: `${phase}: content selector did not appear in 12s. Page might still be loading; proceeding with scroll anyway.` });
      }

      // Initial DOM scrape + HTML snapshot before scrolling.
      await harvestDOM(phase);
      if (cfg.saveHtmlSnapshots) {
        const f = await snapshotHtml(linkedinView, phase);
        if (f) emitProgress('snapshot', { phase, file: f, message: `${phase}: HTML snapshot saved → ${f.split('/').slice(-2).join('/')}` });
      }

      emitProgress('scrolling', { phase, total: scrolls, message: `Scrolling ${phase} (${scrolls})` });
      await scrollAndWait(linkedinView, scrolls, cfg.scrollPauseMs, emitProgress, phase);

      // Final DOM scrape after scroll completes.
      await harvestDOM(phase);
      return true;
    }

    // 1) HOME FEED
    if (!cfg.skipFeed) {
      await runPhase({
        url: URLS.feed, phase: 'feed',
        contentSel: '.feed-shared-update-v2, .scaffold-finite-scroll__content, [data-id^="urn:li:activity"]',
        scrolls: cfg.feedScrolls,
      });
      const after = (recon.status().ingest_stats?.upserted || 0) - baseline;
      phaseStats.feed = after - cumDelta;
      cumDelta = after;
      console.log(`${tag} feed done. delta=${phaseStats.feed}`);
    }

    // 2) Connections
    if (!cfg.skipConnections) {
      await runPhase({
        url: URLS.connections, phase: 'connections',
        contentSel: '.mn-connection-card, [data-view-name="connections-list"]',
        scrolls: cfg.connectionsScrolls,
      });
      const after = (recon.status().ingest_stats?.upserted || 0) - baseline;
      phaseStats.connections = after - cumDelta;
      cumDelta = after;
      console.log(`${tag} connections done. delta=${phaseStats.connections}`);
    }

    // 3) My Network
    if (!cfg.skipMyNetwork) {
      await runPhase({
        url: URLS.myNetwork, phase: 'mynetwork',
        contentSel: '.discover-entity-type-card, .mn-cohorts-list, [data-test-id="cohort-card"]',
        scrolls: cfg.myNetworkScrolls,
      });
      const after = (recon.status().ingest_stats?.upserted || 0) - baseline;
      phaseStats.mynetwork = after - cumDelta;
      cumDelta = after;
      console.log(`${tag} mynetwork done. delta=${phaseStats.mynetwork}`);
    }

    // 4) People search seeds — URL-paginated. Each seed crawls pages 1..searchPages
    //    via direct ?page=N URL nav. After each page: wait for results → DOM scrape →
    //    short scroll for lazy-loaded items → DOM scrape again. Stops a seed early
    //    if a page yields 0 new profiles (paywall / end of results).
    if (Array.isArray(cfg.searchSeeds) && cfg.searchSeeds.length) {
      console.log(`${tag} phase=search seeds=${cfg.searchSeeds.join(',')}`);
      let seedIdx = 0;
      for (const seed of cfg.searchSeeds) {
        if (seedIdx++ > 0) {
          // Pause between seed switches — looks more like a human browsing.
          await humanPause(cfg.betweenSeedsMs, 2500);
        }
        let seedHarvest = 0;
        for (let pageNum = 1; pageNum <= cfg.searchPages; pageNum++) {
          if (pageNum > 1) await humanPause(cfg.betweenPagesMs, 2000);
          const url = URLS.peopleSearchFn(seed, pageNum);
          console.log(`${tag} search seed="${seed}" page=${pageNum} -> ${url}`);
          emitProgress('navigate', { url, phase: 'search', seed, page: pageNum, message: `Searching: ${seed} (page ${pageNum})` });
          await navigate(linkedinView, url);
          await humanPause(cfg.navWaitMs, cfg.navJitterMs);

          // SNAPSHOT FIRST. Before any other failing await. Guarantees we
          // have HTML on disk for inspection regardless of what fails next.
          if (cfg.saveHtmlSnapshots) {
            const f = await snapshotHtml(linkedinView, `search-${seed.replace(/\s+/g, '_')}-p${pageNum}`);
            if (f) emitProgress('snapshot', { phase: 'search', seed, page: pageNum, file: f, message: `search "${seed}" p${pageNum}: snapshot → ${f.split('/').slice(-2).join('/')}` });
            else emitProgress('warn', { phase: 'search', seed, page: pageNum, message: `search "${seed}" p${pageNum}: SNAPSHOT FAILED (see main console)` });
          }

          const appeared = await waitForContent(linkedinView,
            '.reusable-search__entity-result-list, [data-view-name="search-entity-result-universal-template"], .reusable-search__result-container, .search-results-container, a[href*="/in/"]',
            12_000
          );
          const diag = await pageDiagnostic(linkedinView);
          if (diag) {
            const found = Object.entries(diag.found).filter(([_, v]) => v).map(([k]) => k).join(',') || 'none';
            emitProgress('diagnostic', { phase: 'search', seed, page: pageNum,
              message: `search "${seed}" p${pageNum}: profileLinks=${diag.profileLinks} h=${diag.height}/${diag.clientHeight} results=${diag.searchCount} found=[${found}]` });
            if (diag.found.login || diag.found.captcha) {
              emitProgress('error', { phase: 'search', seed, error: `search hit ${diag.found.login ? 'login' : 'captcha'} wall — aborting search phase` });
              break;
            }
          }
          if (!appeared) {
            emitProgress('warn', { phase: 'search', seed, page: pageNum, message: `no search results selector after 12s on page ${pageNum}` });
          }

          // Re-snapshot AFTER content settled — useful when first snapshot caught
          // a loading skeleton.
          const before = recon.status().ingest_stats?.upserted || 0;
          await harvestDOM(`search:${seed}:p${pageNum}`);
          if (cfg.saveHtmlSnapshots) {
            await snapshotHtml(linkedinView, `search-${seed.replace(/\s+/g, '_')}-p${pageNum}-settled`);
          }
          // Short scroll to trigger lazy-load.
          await scrollAndWait(linkedinView, cfg.searchScrolls, cfg.scrollPauseMs, emitProgress, `search:${seed}:p${pageNum}`);
          await harvestDOM(`search:${seed}:p${pageNum}`);

          const pageHarvest = (recon.status().ingest_stats?.upserted || 0) - before;
          seedHarvest += pageHarvest;
          console.log(`${tag} search "${seed}" page=${pageNum} pageHarvest=${pageHarvest}`);

          if (pageHarvest === 0) {
            emitProgress('warn', { phase: 'search', seed, page: pageNum, message: `${seed} p${pageNum}: zero new profiles — stopping seed early` });
            break;
          }
        }
        console.log(`${tag} search seed="${seed}" total=${seedHarvest}`);
      }
      const after = (recon.status().ingest_stats?.upserted || 0) - baseline;
      phaseStats.search = after - cumDelta;
      cumDelta = after;
      console.log(`${tag} search done. delta=${phaseStats.search}`);
    }

    const total = phaseStats.feed + phaseStats.connections + phaseStats.mynetwork + phaseStats.search;
    console.log(`${tag} ALL DONE. total=${total} stats=${JSON.stringify(phaseStats)}`);
    emitProgress('done', { stats: phaseStats, total, durationMs: Date.now() - startedAt });
    return { ok: true, stats: phaseStats, total, durationMs: Date.now() - startedAt };
  } catch (err) {
    console.error(`${tag} ERROR:`, err.stack || err.message);
    emitProgress('error', { error: err.message });
    return { ok: false, error: err.message, stats: phaseStats };
  }
}

module.exports = {
  id: 'li-fill-prospects',
  platform: 'linkedin',
  label: 'Fill LinkedIn Prospects',
  description: 'Navigate Connections + My Network + optional people search, scroll each, auto-store every captured Profile to the prospects table.',
  run,
  DEFAULTS,
};
