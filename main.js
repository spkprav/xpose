const path = require('path');
const { app, BrowserWindow, BrowserView, ipcMain, session, Notification, powerSaveBlocker, screen } = require('electron');

// Keep renderer responsive when window is minimized / hidden / occluded.
// Without these, Chromium throttles JS timers + rAF, breaking crawler pagination scrolls.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const fs = require('fs');
const TweetProcessor = require('./lib/twitter');
const ProfileCrawler = require('./lib/twitter/crawler');
const { CRAWL_ENDPOINTS } = require('./lib/twitter/constants');
const { parseTwitterExportJS } = require('./lib/twitter/extractors');
const Settings = require('./lib/settings');
const { createClient } = require('./lib/llm');
const db = require('./lib/db');
const { generateDrafts } = require('./lib/drafts');
const wikiExport = require('./lib/wiki-export');
const { scoreUnscoredFeed, setConfig: setScorerConfig } = require('./lib/feed/score-tweets');
const telegram = require('./lib/telegram');
const prospects = require('./lib/prospects');
const { generateOutreach } = require('./lib/prospects/outreach');
const linkedinRecon = require('./lib/linkedin/recon');
const { snapshotHtml: linkedinSnapshotHtml, SNAP_DIR: LI_SNAP_DIR } = require('./lib/linkedin/snapshot');
const { sanitizeMany: sanitizeLinkedinRows } = require('./lib/linkedin/quality');
const workflowsRegistry = require('./lib/workflows');
const { getIdentity } = require('./lib/identity');
const LiveRunner = require('./lib/live/runner');
const { isLiveCaptureUrl } = require('./lib/live/extract');
const { extractLists, listPageUrl } = require('./lib/live/lists');
const LIVE_PAGE_HOOK = require('./lib/live/page-hook');

let win, twitterView, crawlView, linkedinView, settings, llmClient;
let activePlatform = 'x';
let pendingFetch = false;
let fetchedTweets = [];
let currentLinkIndex = 0;
let feedLinks = [];
const requestMap = new Map();
const liveRequestMap = new Map();
const crawlRequestMap = new Map();
let liveRunner = null;
let liveNetHooked = false;
// Registered while an X-prospect discovery workflow is running. Receives raw
// SearchTimeline GraphQL responses from crawlView. Null when no workflow active.
let xSearchListener = null;
// Registered during the tweet-enrichment phase of the X-prospect workflow.
// Routes UserTweets / UserTweetsAndReplies bypass the main crawler state
// machine — the workflow handles save itself, per-handle.
let xUserTweetsListener = null;
const listRequestMap = new Map(); // for Followers/Following interception on main view
let focusMode = false;
let crawler = null;
let fetchingList = false;
let importingUserLists = false;
const importedUserLists = new Map();
let listCaptured = [];

// Feed scoring state — debounced after crawl, plus a periodic heartbeat.
let feedScoringRunning = false;
let feedScoringDebounce = null;
let feedScoringAbortRequested = false;
const FEED_SCORE_DEBOUNCE_MS = 30 * 1000;       // wait 30s after last crawl event
const FEED_SCORE_HEARTBEAT_MS = 5 * 60 * 1000;  // run every 5min while app open
const FEED_SCORE_HOURS_MAX = 3;
const FEED_SCORE_BATCH_LIMIT = 60;

function syncScorerConfig() {
  if (!settings) return;
  const ollama = settings.get('ollama') || {};
  const openrouter = settings.get('openrouter') || {};
  const provider = settings.get('scoringProvider') || 'ollama';
  setScorerConfig({
    provider,
    baseUrl:     ollama.baseUrl  || 'http://localhost:11434',
    textModel:   ollama.scoreModel  || 'qwen2.5vl:7b',
    visionUrl:   ollama.visionUrl   || ollama.baseUrl || null,
    visionModel: ollama.visionModel || 'qwen2.5vl:7b',
    enableVision: ollama.enableVision !== false,
    openrouterApiKey: openrouter.apiKey || '',
    openrouterModel:  settings.get('scoringOpenrouterModel') || 'google/gemini-2.5-flash',
  });
}

function emitFeedProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('feed-score-progress', payload);
}

async function runFeedScoring({ hoursMax = FEED_SCORE_HOURS_MAX, limit = FEED_SCORE_BATCH_LIMIT, source = 'auto' } = {}) {
  if (feedScoringRunning) {
    console.log(`[FeedScore] skip (${source}) — already running`);
    emitFeedProgress({ phase: 'skip', source });
    return { scored: 0, failed: 0, skipped: 1, total: 0 };
  }
  syncScorerConfig();
  feedScoringRunning = true;
  feedScoringAbortRequested = false;
  const t0 = Date.now();
  emitFeedProgress({ phase: 'start', source });
  try {
    const r = await scoreUnscoredFeed({
      hoursMax,
      limit,
      shouldAbort:   () => feedScoringAbortRequested,
      onStart:       (n) => emitFeedProgress({ phase: 'queued', total: n, source }),
      onTweetStart:  (i, n, t) => emitFeedProgress({
        phase: 'tweet-start', i, n, source,
        tweet: { id: String(t.id), screen_name: t.screen_name },
      }),
      onTweetDone:   (i, n, res) => emitFeedProgress({
        phase: 'tweet-done', i, n, source,
        result: { id: String(res.id), screen_name: res.screen_name, total: res.total },
      }),
      onTweetError:  (i, n, t, e) => emitFeedProgress({
        phase: 'tweet-error', i, n, source,
        tweet: { id: String(t.id), screen_name: t.screen_name },
        error: e.message,
      }),
    });
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    if (r.total > 0) {
      console.log(`[FeedScore] ${source} done in ${elapsedSec}s — scored=${r.scored} failed=${r.failed} of ${r.total}`);
    }
    emitFeedProgress({ phase: 'done', source, ...r, elapsedSec });
    if (win && !win.isDestroyed()) win.webContents.send('feed-scores-updated', r);
    return r;
  } catch (err) {
    console.error('[FeedScore] error:', err.message);
    emitFeedProgress({ phase: 'error', source, error: err.message });
    return { scored: 0, failed: 0, skipped: 0, total: 0, error: err.message };
  } finally {
    feedScoringRunning = false;
  }
}

function scheduleFeedScoring(source = 'auto') {
  clearTimeout(feedScoringDebounce);
  feedScoringDebounce = setTimeout(() => runFeedScoring({ source }), FEED_SCORE_DEBOUNCE_MS);
}

// X-list crawl state (Lists tab)
let activeListSlug = null;
let listScrollTimer = null;
let listScrollCount = 0;
let listCapturedThisRun = 0;
let listOpenedAt = 0;
const LIST_BURST_SCROLLS = 2;       // jump-to-bottom twice, enough for 12-24h catchup
const LIST_BURST_DELAY_MS = 1500;   // gap between bursts to let content load
const LIST_STOP_GRACE_MS = 2000;  // ignore Stop within N ms of Open (debounce accidental double-click)

// Auto-crawl scheduler state. `running` mirrors settings.listAutoCrawl.running so
// pause survives a Settings save. The timer is rescheduled whenever settings change.
let autoCrawlTimer = null;
let autoCrawlNextAt = 0;
let autoCrawlQueue = [];      // slugs queued for this auto run
let autoCrawlPostHookSlug = null;  // slug to push to Telegram once its crawl finishes
let autoCrawlLastFireAt = 0;       // ms-epoch of the last fired auto-cycle (set when it actually started)
let autoCrawlPrevRunning = false;  // tracks running-state transitions to detect "just enabled"

const PAGE_PATHS = {
  '/HomeTimeline': 'for-you',
  '/HomeLatestTimeline': 'following',
  '/ListLatestTweetsTimeline': 'list',
  '/SearchTimeline': 'search',
  '/CommunityTweetsTimeline': 'community-tweets'
};

const MONITORED_ENDPOINTS = Object.keys(PAGE_PATHS);

function getCrawlEndpointType(url) {
  const ep = CRAWL_ENDPOINTS.find(e => url.includes(e));
  return ep ? ep.replace('/', '') : null;
}

function getPagePathFromUrl(url) {
  const endpoint = MONITORED_ENDPOINTS.find(ep => url.includes(ep));
  return endpoint ? PAGE_PATHS[endpoint] : null;
}

// ─── Auto-crawl scheduler ────────────────────────────────────────────────
function emitAutoCrawlStatus() {
  if (!win || win.isDestroyed()) return;
  const cfg = (settings && settings.get('listAutoCrawl')) || {};
  win.webContents.send('list-auto-crawl-status', {
    enabled: !!cfg.enabled,
    running: !!cfg.running,
    intervalMinutes: cfg.intervalMinutes || 60,
    startTime: cfg.startTime || '',
    nextAt: autoCrawlNextAt || null,
    lastFireAt: autoCrawlLastFireAt || null,
  });
}

function clearAutoCrawlTimer() {
  if (autoCrawlTimer) { clearTimeout(autoCrawlTimer); autoCrawlTimer = null; }
  autoCrawlNextAt = 0;
}

// Pure: compute the next scheduled fire-time given config + history.
// - With startTime: cadence is anchored. nextSlot = anchor + N*interval, where
//   anchor is the most recent occurrence of HH:MM and N is chosen so the slot
//   sits strictly after max(now, lastFireAt).
// - Without startTime:
//     justEnabled → fire ASAP (1s grace, so the scheduler can settle).
//     otherwise   → lastFireAt + interval, or now if no prior fire.
function computeNextAutoCrawlAt({ intervalMinutes, startTime, lastFireAt = 0, justEnabled = false, now = Date.now() }) {
  const intervalMs = Math.max(5, Number(intervalMinutes) || 60) * 60_000;
  if (startTime && /^\d{1,2}:\d{2}$/.test(startTime)) {
    const [h, m] = startTime.split(':').map(Number);
    const ref = new Date(); ref.setHours(h, m, 0, 0);
    let anchor = ref.getTime();
    if (anchor > now) anchor -= 86_400_000; // use yesterday's anchor if today's hasn't happened yet
    const after = Math.max(now, lastFireAt || 0);
    const slots = Math.floor((after - anchor) / intervalMs) + 1;
    return anchor + slots * intervalMs;
  }
  if (justEnabled) return now + 1000;
  return (lastFireAt || now) + intervalMs;
}

function scheduleNextAutoCrawl(reason = 'reschedule') {
  clearAutoCrawlTimer();
  const cfg = (settings && settings.get('listAutoCrawl')) || {};
  const nowRunning = !!(cfg.enabled && cfg.running);
  const justEnabled = nowRunning && !autoCrawlPrevRunning;
  autoCrawlPrevRunning = nowRunning;
  if (!nowRunning) {
    autoCrawlNextAt = 0;
    emitAutoCrawlStatus();
    return;
  }
  const nextAt = computeNextAutoCrawlAt({
    intervalMinutes: cfg.intervalMinutes,
    startTime: cfg.startTime,
    lastFireAt: autoCrawlLastFireAt,
    justEnabled,
  });
  const delay = Math.max(1000, nextAt - Date.now());
  autoCrawlNextAt = nextAt;
  autoCrawlTimer = setTimeout(() => runAutoCrawl().catch(e => console.error('[AutoCrawl] error:', e.message)), delay);
  const mins = Math.round(delay / 60000);
  console.log(`[AutoCrawl] next run in ${mins < 1 ? `${Math.round(delay/1000)}s` : `${mins}m`} (${reason}, justEnabled=${justEnabled}, startTime=${cfg.startTime || 'none'})`);
  emitAutoCrawlStatus();
}

async function runAutoCrawl() {
  const cfg = (settings && settings.get('listAutoCrawl')) || {};
  if (!cfg.enabled || !cfg.running) return;
  if (activeListSlug) {
    console.log('[AutoCrawl] skip — a list crawl is already active');
    // Stamp lastFireAt so the next computed slot is one full interval out,
    // preventing a tight reschedule loop while a manual crawl is running.
    autoCrawlLastFireAt = Date.now();
    scheduleNextAutoCrawl('busy');
    return;
  }
  // Delegate to the workflow so the Workflows tab sees the same phases.
  const r = await runListSweepWorkflow({ source: 'auto' });
  if (!r.ok) {
    console.log(`[AutoCrawl] workflow refused: ${r.error}`);
    autoCrawlLastFireAt = Date.now();
    scheduleNextAutoCrawl('refused');
  }
}

// ─── List crawl primitives (module scope so scheduler + IPC share them) ──
function stopListCrawl(reason = 'stopped') {
  if (listScrollTimer) { clearTimeout(listScrollTimer); listScrollTimer = null; }
  const slug = activeListSlug;
  const finalScrolls = listScrollCount;
  const finalCaptured = listCapturedThisRun;
  activeListSlug = null;
  listScrollCount = 0;
  listCapturedThisRun = 0;
  if (slug) {
    console.log(`[ListCrawl] ${slug}: ${reason}. captured ${finalCaptured} new tweets across ${finalScrolls} scrolls`);
    win?.webContents.send('list-crawl-status', {
      slug,
      status: reason === 'done' ? 'done' : (reason === 'error' ? 'error' : 'stopped'),
      message: `${slug}: ${reason} (${finalCaptured} new, ${finalScrolls} scrolls)`,
    });
    // Fire post-crawl hooks (telegram push, auto-queue drain) after a brief delay
    // so the UI sees the "done" state first.
    setTimeout(() => {
      onListCrawlComplete(slug, reason).catch(err => console.error('[ListCrawl] post hook:', err.message));
    }, 250);
  }
}

async function scrollListOnce() {
  if (!activeListSlug) return;
  listScrollCount++;
  try {
    await twitterView.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
  } catch (_) {
    try {
      await twitterView.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x: 400, y: 400, xDistance: 0, yDistance: -9999, speed: 1200,
      });
    } catch (_2) {}
  }
  console.log(`[ListCrawl] ${activeListSlug}: burst ${listScrollCount}/${LIST_BURST_SCROLLS} (captured ${listCapturedThisRun} so far)`);
  if (listScrollCount >= LIST_BURST_SCROLLS) {
    stopListCrawl('done');
    return;
  }
  listScrollTimer = setTimeout(scrollListOnce, LIST_BURST_DELAY_MS);
}

function openListFromMain(slug, listId) {
  if (!slug || !listId) return;
  if (activeListSlug === slug) return;
  if (activeListSlug) stopListCrawl('stopped');
  activeListSlug = slug;
  listScrollCount = 0;
  listCapturedThisRun = 0;
  listOpenedAt = Date.now();
  const url = `https://x.com/i/lists/${listId}`;
  console.log(`[ListCrawl] starting ${slug} -> ${url}`);
  win?.webContents.send('list-crawl-status', { slug, status: 'started', message: `Loading ${slug}...` });
  twitterView.webContents.loadURL(url)
    .then(() => { listScrollTimer = setTimeout(scrollListOnce, 2000); })
    .catch(err => {
      console.error('[ListCrawl] navigate failed:', err.message);
      win?.webContents.send('list-crawl-status', { slug, status: 'error', message: err.message });
      stopListCrawl('error');
    });
}

// Called from stopListCrawl after a list finishes. Drains queue, then runs the
// post-crawl pipeline: score → telegram → reschedule.
async function onListCrawlComplete(finishedSlug, reason) {
  // Drain queue first (Fetch All / auto-crawl sequence). Iterate (not recurse)
  // so a queue full of missing IDs can't blow the stack.
  const ids = (settings && settings.get('lists')) || {};
  while (autoCrawlQueue.length) {
    const next = autoCrawlQueue.shift();
    const listId = ids[next];
    if (listId) {
      setTimeout(() => openListFromMain(next, listId), 1500);
      return;
    }
    console.log(`[ListCrawl] skipping ${next} — no list id configured`);
  }

  // Cycle complete. Run pipeline: score → notify.
  await runPostCrawlPipeline(reason);

  // Schedule next auto-crawl if applicable.
  const cfg = (settings && settings.get('listAutoCrawl')) || {};
  if (cfg.enabled && cfg.running) scheduleNextAutoCrawl('cycle-done');
}

// ─── Workflow pipeline (score → telegram) ────────────────────────────────
// workflowState is the source of truth for the Workflows tab UI. Phases:
//   idle | crawling | scoring | notifying | done | error
const workflowState = {
  id: 'list-sweep',
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,    // { scored, failed, pushed, durationMs, error? }
  message: '',
};

function emitWorkflowState(patch = {}) {
  Object.assign(workflowState, patch);
  if (win && !win.isDestroyed()) {
    win.webContents.send('workflow-state', { ...workflowState });
  }
}

async function runPostCrawlPipeline(reason = 'cycle-done') {
  const t0 = Date.now();
  let scored = 0, failed = 0, pushed = 0, errorMsg = null;
  try {
    emitWorkflowState({ phase: 'scoring', message: `Scoring after crawl (${reason})` });
    const sr = await runFeedScoring({ source: 'post-crawl' });
    scored = sr.scored || 0;
    failed = sr.failed || 0;

    emitWorkflowState({ phase: 'notifying', message: `Pushing top tweets to Telegram` });
    const pr = await maybePushTelegramRecent();
    pushed = pr.sent || 0;

    emitWorkflowState({
      phase: 'done',
      finishedAt: Date.now(),
      lastResult: { scored, failed, pushed, durationMs: Date.now() - t0 },
      message: `Done. Scored ${scored}, pushed ${pushed}.`,
    });
  } catch (err) {
    errorMsg = err.message;
    console.error('[Pipeline]', err);
    emitWorkflowState({
      phase: 'error',
      finishedAt: Date.now(),
      lastResult: { scored, failed, pushed, durationMs: Date.now() - t0, error: errorMsg },
      message: `Error: ${errorMsg}`,
    });
  }
}

// Composite "List Sweep & Notify" workflow: crawl all configured lists → score → telegram.
// Used by the Workflows tab "Run Now" button and by the auto-crawl scheduler.
async function runListSweepWorkflow({ source = 'manual' } = {}) {
  if (activeListSlug || ['clearing', 'crawling', 'scoring', 'notifying'].includes(workflowState.phase)) {
    return { ok: false, error: 'workflow already running' };
  }
  const ids = (settings && settings.get('lists')) || {};
  const configured = Object.keys(ids).filter(s => ids[s]);
  if (!configured.length) {
    emitWorkflowState({ phase: 'error', message: 'No list IDs configured', finishedAt: Date.now() });
    return { ok: false, error: 'no list IDs configured' };
  }

  // Step 1: clear. Emit a distinct 'clearing' phase first so the renderer can
  // wipe the Reply tab BEFORE any crawl traffic arrives. Short delay lets the
  // renderer commit the empty state before we kick off network work.
  const startedAt = Date.now();
  emitWorkflowState({
    phase: 'clearing',
    startedAt,
    finishedAt: null,
    lastResult: null,
    message: 'Clearing Reply tab before crawl',
  });
  await new Promise(r => setTimeout(r, 200));

  // Step 2: crawl.
  emitWorkflowState({
    phase: 'crawling',
    startedAt,
    message: `Crawling ${configured.length} list(s): ${configured.join(', ')}`,
  });
  autoCrawlLastFireAt = Date.now();
  autoCrawlQueue = configured.slice(1);
  const first = configured[0];
  openListFromMain(first, ids[first]);
  // The crawl is async; pipeline continues from onListCrawlComplete:
  //   crawling → scoring → notifying → done
  return { ok: true, queued: configured };
}

// ─── Telegram push ───────────────────────────────────────────────────────
// In-memory dedup: tweet ids already pushed in this session. Persists per-process,
// resets on app restart. Capped at 2000 entries (FIFO trim) so a long session
// doesn't leak. Good enough until a DB column is worth adding.
const telegramPushedIds = new Set();
const TELEGRAM_PUSHED_CAP = 2000;

function markTelegramPushed(id) {
  telegramPushedIds.add(String(id));
  if (telegramPushedIds.size > TELEGRAM_PUSHED_CAP) {
    const drop = telegramPushedIds.size - TELEGRAM_PUSHED_CAP;
    const it = telegramPushedIds.values();
    for (let i = 0; i < drop; i++) telegramPushedIds.delete(it.next().value);
  }
}

async function maybePushTelegramRecent({ slug = 'all' } = {}) {
  const tg = (settings && settings.get('telegram')) || {};
  if (!tg.enabled || !tg.botToken || !tg.chatId) {
    console.log('[Telegram] disabled or missing token/chat — skipping push');
    return { sent: 0, skipped: 0 };
  }
  const minScore = Number(tg.minScore || 60);
  const maxPerCrawl = Math.max(1, Number(tg.maxPerCrawl || 10));
  const hoursWindow = Math.max(1, Number(tg.hoursWindow || 3));
  let rows;
  try {
    rows = await db.getListFeedScored({ slug, hoursWindow, limit: 200, includeActioned: false });
  } catch (err) {
    console.error('[Telegram] db read failed:', err.message);
    return { sent: 0, error: err.message };
  }
  const eligible = (rows || [])
    .filter(r => r.score_total != null && r.score_total >= minScore)
    .filter(r => !telegramPushedIds.has(String(r.id)))
    .slice(0, maxPerCrawl);
  if (!eligible.length) {
    console.log(`[Telegram] no new rows ≥ ${minScore} (slug=${slug}, window=${hoursWindow}h)`);
    return { sent: 0, skipped: 0 };
  }
  console.log(`[Telegram] pushing ${eligible.length} tweets (slug=${slug})`);
  try {
    const r = await telegram.pushTweets({
      botToken: tg.botToken,
      chatId: tg.chatId,
      rows: eligible,
      slug,
    });
    if (r.sent > 0) {
      for (const row of eligible) markTelegramPushed(row.id);
    }
    console.log(`[Telegram] sent=${r.sent} failed=${r.failed}`);
    return r;
  } catch (err) {
    console.error('[Telegram] push failed:', err.message);
    return { sent: 0, error: err.message };
  }
}

function getLLMClient() {
  const { provider, config } = settings.getActiveProvider();
  console.log(`[LLM] Provider: ${provider}`);
  console.log(`[LLM] Config:`, JSON.stringify(config, null, 2));
  if (!config?.apiKey && provider !== 'ollama') {
    console.log('[LLM] No API key configured');
    return null;
  }
  try {
    return createClient(provider, config);
  } catch (err) {
    console.error('Failed to create LLM client:', err.message);
    return null;
  }
}

function createWindow() {
  const ses = session.fromPartition('persist:twitter');
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    icon: path.resolve(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.png' : 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  // Stay hidden until it is maximized, so it never flashes at a smaller size.
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (!win.isMaximized()) win.maximize();
    win.show();
  });

  twitterView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.resolve(app.getAppPath(), 'preload.js'),
      session: ses,
      backgroundThrottling: false,
    },
  });

  // crawlView must be added FIRST so twitterView renders on top
  crawlView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
      backgroundThrottling: false,
    },
  });
  // LinkedIn view: separate session partition so the user can log in
  // independently of the X account. Spoof to look like real Chrome so
  // LinkedIn's automation-detection doesn't flag the Electron UA.
  const liSes = session.fromPartition('persist:linkedin');
  const REAL_CHROME_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  liSes.setUserAgent(REAL_CHROME_UA);
  // Strip Electron UA hint headers + Sec-CH-UA spoofs.
  liSes.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    headers['User-Agent'] = REAL_CHROME_UA;
    headers['Sec-CH-UA'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"macOS"';
    callback({ requestHeaders: headers });
  });

  linkedinView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.resolve(app.getAppPath(), 'preload.js'),
      session: liSes,
      backgroundThrottling: false,
    },
  });
  linkedinView.webContents.setUserAgent(REAL_CHROME_UA);

  // Auto-snapshot every page load on linkedinView. Fires regardless of
  // workflow state — so even if the workflow errors or you quit mid-run,
  // HTML is on disk for inspection. Phase label derived from URL path.
  linkedinView.webContents.on('did-finish-load', async () => {
    if (linkedinView.webContents.isDestroyed()) return;
    try {
      const url = linkedinView.webContents.getURL();
      // Skip about:blank, login redirects, captcha pages — recognizable noise.
      if (!url || !/^https?:\/\/(www\.)?linkedin\.com\//.test(url)) return;
      const u = new URL(url);
      let phase = 'page';
      if (/\/feed\/?$/.test(u.pathname))                          phase = 'feed';
      else if (/\/mynetwork\/invite-connect\/connections/.test(u.pathname)) phase = 'connections';
      else if (/\/mynetwork\//.test(u.pathname))                  phase = 'mynetwork';
      else if (/\/search\/results\/people/.test(u.pathname)) {
        const kw = u.searchParams.get('keywords') || 'unknown';
        const pg = u.searchParams.get('page') || '1';
        phase = `search-${kw.replace(/\s+/g, '_')}-p${pg}`;
      }
      else if (/\/in\//.test(u.pathname))                         phase = 'profile';
      else                                                         phase = 'page-' + u.pathname.replace(/\W+/g, '_').slice(0, 40);
      // Wait briefly for client-side hydration before snapshotting.
      setTimeout(() => linkedinSnapshotHtml(linkedinView, `auto-${phase}`).catch(() => {}), 3000);
    } catch (_) {}
  });

  // Inject browser-fingerprint spoofs on every navigation BEFORE page scripts
  // run. Hides navigator.webdriver, normalizes plugins/languages, removes the
  // Electron-specific window globals LinkedIn could fingerprint.
  linkedinView.webContents.on('dom-ready', () => {
    if (linkedinView.webContents.isDestroyed()) return;
    linkedinView.webContents.executeJavaScript(`
      (function() {
        try {
          Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
        } catch (_) {}
        try {
          // Plugins + languages = real-browser defaults.
          Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-US', 'en'] });
        } catch (_) {}
        try {
          // Remove Electron globals if present (rare with contextIsolation but belt+suspenders).
          delete window.require; delete window.process; delete window.module;
        } catch (_) {}
        try {
          // Chrome's window.chrome detection trick: ensure it exists.
          if (!window.chrome) window.chrome = { runtime: {} };
        } catch (_) {}
      })();
    `).catch(() => {});
  });

  win.addBrowserView(crawlView);    // bottom layer (X crawler)
  win.addBrowserView(linkedinView); // middle layer
  win.addBrowserView(twitterView);  // top layer by default

  activePlatform = settings.get('activePlatform') || 'x';
  applyPlatform(activePlatform);

  twitterView.webContents.loadURL('https://x.com/home');
  linkedinView.webContents.loadURL('https://www.linkedin.com/feed/');
  win.loadFile('index.html');

  let powerBlockerId = null;
  crawler = new ProfileCrawler({
    crawlView,
    db,
    onStatus: (status) => {
      if (win && !win.isDestroyed()) win.webContents.send('crawl-status', status);
      // Keep system awake while crawling
      if (status.state === 'crawling' && powerBlockerId === null) {
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('[Power] App suspension blocked for crawl');
      } else if (status.state === 'idle' && powerBlockerId !== null) {
        powerSaveBlocker.stop(powerBlockerId);
        powerBlockerId = null;
        console.log('[Power] App suspension unblocked');
      }
      // Swap top BrowserView so crawlView gets viewport focus (better pagination triggers)
      // Only applies in X mode. In LinkedIn mode the X crawl can keep running
      // headlessly, but we never surface it on top of linkedinView.
      if (win && !win.isDestroyed() && twitterView && crawlView && activePlatform === 'x') {
        if (status.state === 'crawling') {
          win.setTopBrowserView(crawlView);
        } else if (status.state === 'idle' || status.state === 'paused') {
          win.setTopBrowserView(twitterView);
        }
      }
    },
    onFeedRefresh: () => {
      if (win && !win.isDestroyed()) win.webContents.send('feed-refresh-available');
      // Newly captured list tweets → schedule a scoring pass.
      scheduleFeedScoring('crawl');
    },
  });

  // ==================
  // Tweet Handlers - Multi-link navigation
  // ==================
  async function navigateToNextLink() {
    if (currentLinkIndex >= feedLinks.length) {
      // Done with all links - send collected tweets
      pendingFetch = false;
      const serializedTweets = JSON.parse(JSON.stringify(fetchedTweets));
      console.log(`[Fetch] Done! Collected ${serializedTweets.length} tweets from ${feedLinks.length} links`);
      win.webContents.send('tweets-fetched', serializedTweets);
      return;
    }

    const link = feedLinks[currentLinkIndex];
    console.log(`[Fetch] Navigating to link ${currentLinkIndex + 1}/${feedLinks.length}: ${link}`);
    win.webContents.send('fetch-progress', {
      current: currentLinkIndex + 1,
      total: feedLinks.length,
      url: link,
      tweetsCollected: fetchedTweets.length
    });

    try {
      await twitterView.webContents.loadURL(link);
    } catch (err) {
      console.error(`[Fetch] Failed to load ${link}:`, err.message);
    }

    currentLinkIndex++;

    // Wait 7 seconds before moving to next link (give time for page load + API response)
    setTimeout(() => {
      if (pendingFetch) {
        navigateToNextLink();
      }
    }, 7000);
  }

  ipcMain.on('fetch-tweets', async () => {
    // Get feed links from settings
    const feedLinksStr = settings.get('feedLinks') || '';
    feedLinks = feedLinksStr
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && l.startsWith('http'));

    if (feedLinks.length === 0) {
      win.webContents.send('tweets-fetched', []);
      return;
    }

    pendingFetch = true;
    fetchedTweets = [];
    currentLinkIndex = 0;

    console.log(`[Fetch] Starting multi-link fetch with ${feedLinks.length} links`);

    // Step 1: Load home page (For You tab)
    win.webContents.send('fetch-progress', {
      current: 0,
      total: feedLinks.length + 1, // +1 for Following tab
      url: 'https://x.com/home (For You)',
      tweetsCollected: 0
    });

    await twitterView.webContents.loadURL('https://x.com/home');

    // Wait 6 seconds for For You tweets to load
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (!pendingFetch) return;

    // Step 2: Click "Following" tab
    console.log('[Fetch] Clicking Following tab...');
    win.webContents.send('fetch-progress', {
      current: 0,
      total: feedLinks.length + 1,
      url: 'https://x.com/home (Following)',
      tweetsCollected: fetchedTweets.length
    });

    try {
      await twitterView.webContents.executeJavaScript(`
        (function() {
          // Find the Following tab by role="tab" and text content
          const tabs = document.querySelectorAll('[role="tab"]');
          for (const tab of tabs) {
            if (tab.textContent.trim() === 'Following') {
              tab.click();
              return true;
            }
          }
          // Fallback: try finding by the tab structure
          const tabList = document.querySelector('[role="tablist"]');
          if (tabList) {
            const allTabs = tabList.querySelectorAll('[role="tab"]');
            // Following is usually the second tab
            if (allTabs.length >= 2) {
              allTabs[1].click();
              return true;
            }
          }
          return false;
        })()
      `);
    } catch (err) {
      console.error('[Fetch] Failed to click Following tab:', err.message);
    }

    // Wait 6 seconds for Following tweets to load
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (!pendingFetch) return;

    // Step 3: Start navigating feed links
    console.log(`[Fetch] Done with home tabs, proceeding to ${feedLinks.length} feed links`);
    navigateToNextLink();
  });

  ipcMain.on('stop-fetch', () => {
    pendingFetch = false;
    win.webContents.send('fetch-stopped');
  });

  // ==================
  // Test Run - Single page to DB
  // ==================
  let testRunPending = false;
  let testRunTweets = [];

  ipcMain.on('test-run', async () => {
    testRunPending = true;
    testRunTweets = [];

    win.webContents.send('test-run-progress', { status: 'Starting test run...' });

    // First test DB connection
    try {
      await db.testConnection();
      win.webContents.send('test-run-progress', { status: 'DB connected. Loading home page...' });
    } catch (err) {
      win.webContents.send('test-run-complete', {
        success: false,
        error: `DB connection failed: ${err.message}`
      });
      return;
    }

    // Load home page and wait for tweets
    twitterView.webContents.loadURL('https://x.com/home');

    // Wait 5 seconds for tweets to load
    setTimeout(async () => {
      if (!testRunPending) return;
      testRunPending = false;

      const tweets = [...testRunTweets];
      testRunTweets = [];

      if (tweets.length === 0) {
        win.webContents.send('test-run-complete', {
          success: false,
          error: 'No tweets captured. Try scrolling or refreshing.'
        });
        return;
      }

      win.webContents.send('test-run-progress', {
        status: `Saving ${tweets.length} tweets to database...`
      });

      try {
        const { saved, errors } = await db.saveTweetsBatch(tweets, 'https://x.com/home');
        win.webContents.send('test-run-complete', {
          success: true,
          saved: saved.length,
          errors: errors.length,
          errorDetails: errors.slice(0, 5), // First 5 errors
          sampleTweet: tweets[0] // Send first tweet as sample
        });

        // Also trigger LLM analysis on saved tweets
        console.log(`[TestRun] Sending tweets-fetched with ${tweets.length} tweets for analysis`);
        const serializedTweets = JSON.parse(JSON.stringify(tweets));
        win.webContents.send('tweets-fetched', serializedTweets);
      } catch (err) {
        win.webContents.send('test-run-complete', {
          success: false,
          error: `Save failed: ${err.message}`
        });
      }
    }, 5000);
  });

  // ==================
  // Settings Handlers
  // ==================
  // ==================
  // Identity defaults (pre-fill empty inputs from social-wiki/me.md)
  // ==================
  ipcMain.on('get-identity-defaults', () => {
    const id = getIdentity(settings);
    win.webContents.send('identity-defaults', {
      identity:        id,
      outreachContext: id.outreach_context || '',
      icp:             id.icp || { x: '', linkedin: '' },
      liSearchSeeds:   id.li_search_seeds || [],
      xSearchSeeds:    id.x_search_seeds  || [],
    });
  });

  ipcMain.on('save-identity', (event, patch = {}) => {
    try {
      const current = getIdentity(settings);
      const ocPatch = patch.outreach_context;
      const nextOc = typeof ocPatch === 'string'
        ? { x: ocPatch, linkedin: ocPatch }
        : {
            x:        ocPatch?.x        ?? current.outreach_context.x,
            linkedin: ocPatch?.linkedin ?? current.outreach_context.linkedin,
          };
      const next = {
        ...current,
        outreach_context: nextOc,
        icp: {
          x:        patch.icp?.x        ?? current.icp.x,
          linkedin: patch.icp?.linkedin ?? current.icp.linkedin,
        },
        li_search_seeds: Array.isArray(patch.li_search_seeds) ? patch.li_search_seeds : current.li_search_seeds,
        x_search_seeds:  Array.isArray(patch.x_search_seeds)  ? patch.x_search_seeds  : current.x_search_seeds,
      };
      settings.set('identity', next);
      win.webContents.send('identity-saved', { ok: true });
    } catch (err) {
      win.webContents.send('identity-saved', { ok: false, error: err.message });
    }
  });

  // ==================
  // Platform mode (X / LinkedIn)
  // ==================
  ipcMain.on('get-platform', () => {
    win.webContents.send('platform-changed', { platform: activePlatform });
  });

  ipcMain.on('set-platform', (event, { platform } = {}) => {
    applyPlatform(platform);
  });

  ipcMain.on('reload-linkedin', () => {
    if (linkedinView && !linkedinView.webContents.isDestroyed()) {
      linkedinView.webContents.reload();
    }
  });

  // ==================
  // LinkedIn endpoint recon
  // ==================
  ipcMain.on('linkedin-recon-start', () => {
    if (!linkedinView) {
      win.webContents.send('linkedin-recon-status', { error: 'linkedinView not initialized' });
      return;
    }
    const res = linkedinRecon.attach(linkedinView, {
      onEvent: (ev) => {
        if (win && !win.isDestroyed()) win.webContents.send('linkedin-recon-event', ev);
      },
      ingestFn: async (rows) => {
        const clean = sanitizeLinkedinRows(rows);
        let upserted = 0;
        for (const r of clean) {
          try { await prospects.upsertProspect(r); upserted++; } catch (_) {}
        }
        return upserted;
      },
    });
    win.webContents.send('linkedin-recon-status', { ...linkedinRecon.status(), result: res });
  });

  ipcMain.on('linkedin-recon-autostore', (event, { enabled } = {}) => {
    linkedinRecon.setAutoStore(!!enabled);
    win.webContents.send('linkedin-recon-status', linkedinRecon.status());
  });

  ipcMain.on('linkedin-recon-stop', () => {
    const res = linkedinRecon.detach();
    win.webContents.send('linkedin-recon-status', { ...linkedinRecon.status(), result: res });
  });

  ipcMain.on('linkedin-recon-status', () => {
    win.webContents.send('linkedin-recon-status', linkedinRecon.status());
  });

  ipcMain.on('linkedin-recon-reset', () => {
    linkedinRecon.reset();
    win.webContents.send('linkedin-recon-status', linkedinRecon.status());
  });

  // Manual snapshot: serialize whatever's currently rendered on linkedinView.
  ipcMain.on('linkedin-snapshot-current', async (event, { label } = {}) => {
    if (!linkedinView || linkedinView.webContents.isDestroyed()) {
      win.webContents.send('linkedin-snapshot-result', { ok: false, error: 'linkedinView not available' });
      return;
    }
    const phase = label || 'manual';
    const r = await linkedinSnapshotHtml(linkedinView, phase);
    win.webContents.send('linkedin-snapshot-result', { ...r, snap_dir: LI_SNAP_DIR });
  });

  // Open snapshots dir in the OS file explorer.
  ipcMain.on('linkedin-snapshot-open-dir', () => {
    try { require('electron').shell.openPath(LI_SNAP_DIR); } catch (_) {}
  });

  // Purge junk rows in DB (Premium Profile, "X celebrates this", post-bodies-as-headlines etc.)
  ipcMain.on('linkedin-cleanup-junk', async () => {
    try {
      const dbPool = db.getPool();
      const beforeRes = await dbPool.query(`SELECT COUNT(*) FROM prospects WHERE platform='linkedin'`);
      const before = parseInt(beforeRes.rows[0].count, 10);

      // Drop rows whose display_name matches junk patterns OR headline is a post body / status verb.
      const r = await dbPool.query(`
        DELETE FROM prospects
        WHERE platform = 'linkedin'
          AND (
               display_name ~* '(celebrates? this|likes? this|loves? this|reacted|commented|reposted|shared this|Premium Profile|invited you to|finds this insightful)'
            OR display_name ~* '\\m(View|See|Open|More|Show)\\s'
            OR headline ~* '(celebrates? this|likes? this|loves? this|reacted|commented|reposted|shared this|Premium Profile)'
            OR (headline IS NOT NULL AND length(headline) > 240)
            OR display_name ~* '\\s+(1st|2nd|3rd\\+?|3rd)\\s*$'
          )
      `);
      const afterRes = await dbPool.query(`SELECT COUNT(*) FROM prospects WHERE platform='linkedin'`);
      const after = parseInt(afterRes.rows[0].count, 10);
      win.webContents.send('linkedin-cleanup-result', { ok: true, deleted: r.rowCount, before, after });
    } catch (err) {
      win.webContents.send('linkedin-cleanup-result', { ok: false, error: err.message });
    }
  });

  ipcMain.on('get-settings', () => {
    win.webContents.send('settings-loaded', settings.get());
  });

  ipcMain.on('save-settings', (event, newSettings) => {
    const prevDb = JSON.stringify(settings.get('database'));
    const prevAuto = JSON.stringify(settings.get('listAutoCrawl'));
    const success = settings.update(newSettings);
    llmClient = null; // Reset client to pick up new settings
    // If DB config changed, reconfigure the pool
    if (JSON.stringify(settings.get('database')) !== prevDb) {
      db.configure(settings.get('database'));
    }
    // Sync scorer in case provider/key/model changed.
    syncScorerConfig();
    // Reschedule auto-crawl if settings changed.
    if (JSON.stringify(settings.get('listAutoCrawl')) !== prevAuto) {
      scheduleNextAutoCrawl('settings-saved');
    }
    win.webContents.send('settings-saved', success);
  });

  // Play/pause auto-crawl from the Lists toolbar without opening Settings.
  ipcMain.on('set-list-auto-crawl', (event, patch = {}) => {
    const cur = settings.get('listAutoCrawl') || {};
    const next = { ...cur, ...patch };
    settings.set('listAutoCrawl', next);
    scheduleNextAutoCrawl('toggle');
  });

  ipcMain.on('get-list-auto-crawl-status', () => emitAutoCrawlStatus());

  // ─── Workflows ─────────────────────────────────────────────
  ipcMain.on('get-workflow-state', () => {
    if (win && !win.isDestroyed()) win.webContents.send('workflow-state', { ...workflowState });
  });

  ipcMain.on('list-workflows', () => {
    const items = workflowsRegistry.WORKFLOWS.map(w => ({
      id: w.id, platform: w.platform, label: w.label, description: w.description,
    }));
    event_safe_send('workflows-listed', { items });
  });

  function event_safe_send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  ipcMain.on('run-workflow', async (event, { id, opts = {} } = {}) => {
    console.log(`[Workflow] run-workflow id=${id} opts=${JSON.stringify(opts)}`);
    // Registry-driven workflows take priority. Legacy 'list-sweep' falls through.
    const wf = workflowsRegistry.get(id);
    if (wf) {
      console.log(`[Workflow] dispatch -> ${wf.label} (${wf.platform})`);
      try {
        const ctx = {
          linkedinView,
          crawlView,
          twitterView,
          recon: linkedinRecon,
          emitProgress: (phase, payload = {}) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('workflow-progress', { id, phase, ...payload });
            }
          },
          onReconEvent: (ev) => {
            if (win && !win.isDestroyed()) win.webContents.send('linkedin-recon-event', ev);
          },
          ingestFn: async (rows) => {
            const clean = sanitizeLinkedinRows(rows);
            let upserted = 0;
            for (const r of clean) {
              try { await prospects.upsertProspect(r); upserted++; } catch (_) {}
            }
            return upserted;
          },
          // ─── X-prospect plumbing ────────────────────────────────────────────
          setXSearchSink: (fn) => { xSearchListener = fn || null; },
          clearXSearchSink: () => { xSearchListener = null; },
          setXUserTweetsSink:   (fn) => { xUserTweetsListener = fn || null; },
          clearXUserTweetsSink: ()   => { xUserTweetsListener = null; },
          upsertXProspectsBatch: (rows) => prospects.upsertXProspectsBatch(rows),
          upsertCircleTweetsBatch: (tweets) => db.upsertCircleTweetsBatch(tweets),
          saveWebsiteBlurb: (pid, blurb) => prospects.saveWebsiteBlurb(pid, blurb),
          fetchWebsiteBlurb: (url) => require('./lib/prospects/web-fetch').fetchWebsiteBlurb(url),
          findProspectIdByHandle: async (handle) => {
            const { getPool } = require('./lib/db');
            const r = await getPool().query(
              `SELECT id, website_url, website_text, followers_count FROM prospects WHERE platform='x' AND handle=$1 LIMIT 1`,
              [handle]
            );
            return r.rows[0] || null;
          },
          // List all X handles in the prospects table meeting a follower floor.
          // Used by skipDiscovery (enrich-only) mode.
          listXProspectHandles: async ({ minFollowers = 1 } = {}) => {
            const { getPool } = require('./lib/db');
            const r = await getPool().query(
              `SELECT handle FROM prospects WHERE platform='x' AND followers_count >= $1 ORDER BY followers_count DESC NULLS LAST`,
              [minFollowers]
            );
            return r.rows.map(x => x.handle).filter(Boolean);
          },
          // True if a handle already has at least one row in circle_tweets.
          // Used to skip the tweet-pull phase on re-runs.
          handleHasTweets: async (handle) => {
            const { getPool } = require('./lib/db');
            const r = await getPool().query(
              `SELECT 1 FROM circle_tweets WHERE screen_name = $1 LIMIT 1`,
              [handle]
            );
            return r.rowCount > 0;
          },
          // Embed + score helper for the workflow's tail phase. Runs the full
          // 3-vector embed pass + cosine score vs identity.icp.x. Emits
          // workflow-progress events stamped `x_embed_*` AND pushes the final
          // scored row set into the Prospects tab via `prospect-results-loaded`
          // so the user sees results without a second click.
          runXEmbedAndScore: async (opts = {}) => {
            const result = await runXEmbedAndScore({
              ...opts,
              onProgress: (stage, payload) => {
                if (win && !win.isDestroyed()) {
                  win.webContents.send('workflow-progress', { id, phase: `x_embed_${stage}`, ...payload });
                }
              },
            });
            if (result?.rows && win && !win.isDestroyed()) {
              win.webContents.send('prospect-results-loaded', {
                success: true,
                search: { id: result.searchId },
                rows: result.rows,
              });
            }
            return result;
          },
          // ────────────────────────────────────────────────────────────────────
          sleep: (ms) => new Promise(r => setTimeout(r, ms)),
          getSettings: () => settings.get(),
        };
        const result = await wf.run(ctx, opts);
        event.sender.send('workflow-run-result', { id, ...result });
      } catch (err) {
        event.sender.send('workflow-run-result', { id, ok: false, error: err.message });
      }
      return;
    }
    if (id !== 'list-sweep') {
      event.sender.send('workflow-run-result', { ok: false, error: `unknown workflow: ${id}` });
      return;
    }
    const r = await runListSweepWorkflow({ source: 'manual' });
    event.sender.send('workflow-run-result', { id, ...r });
  });

  // Telegram: test connection (verifies token + chat id).
  ipcMain.on('telegram-test', async () => {
    const tg = settings.get('telegram') || {};
    try {
      const me = await telegram.testConnection({ botToken: tg.botToken, chatId: tg.chatId });
      win.webContents.send('telegram-test-result', { success: true, username: me.username });
    } catch (err) {
      win.webContents.send('telegram-test-result', { success: false, error: err.message });
    }
  });

  // ==================
  // LLM Analysis Handlers
  // ==================
  ipcMain.on('analyze-tweet', async (event, { index, tweet, icpCriteria }) => {
    const client = getLLMClient();
    if (!client) {
      win.webContents.send('tweet-analyzed', { index, analysis: { relevant: false, reason: 'LLM not configured' } });
      return;
    }

    try {
      const analysis = await client.analyzeTweet(tweet, icpCriteria);

      // Save analysis to database
      const { provider, config } = settings.getActiveProvider();
      await db.saveAnalysis(
        tweet.tweet.id,
        analysis,
        icpCriteria,
        provider,
        config.model || 'unknown'
      );

      win.webContents.send('tweet-analyzed', { index, analysis, tweet });
    } catch (err) {
      console.error('Analysis error:', err);
      win.webContents.send('tweet-analyzed', { index, analysis: { relevant: false, reason: err.message } });
    }
  });

  // ==================
  // Open Tweet in Twitter View
  // ==================
  ipcMain.on('open-tweet', (event, { tweetId, screenName }) => {
    const url = `https://x.com/${screenName}/status/${tweetId}`;
    twitterView.webContents.loadURL(url);
  });

  // ==================
  // Focus Mode Toggle
  // ==================
  ipcMain.on('toggle-focus-mode', () => {
    focusMode = !focusMode;
    resizeTwitterView();
    win.webContents.send('focus-mode-changed', focusMode);
  });

  // ==================
  // Reload active platform view
  // ==================
  ipcMain.on('reload-twitter-view', () => {
    const view = activePlatform === 'linkedin' ? linkedinView : twitterView;
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
  });

  // ==================
  // Get Current URL (of active platform view)
  // ==================
  ipcMain.on('get-current-url', () => {
    const view = activePlatform === 'linkedin' ? linkedinView : twitterView;
    const url = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : '';
    win.webContents.send('current-url', url);
  });

  // ==================
  // Load Engagement Opportunities from DB
  // ==================
  ipcMain.on('load-engagement-opportunities', async (event, { iFollowing }) => {
    try {
      const opportunities = await db.loadEngagementOpportunities(iFollowing);
      win.webContents.send('engagement-opportunities-loaded', { success: true, data: opportunities });
    } catch (err) {
      console.error('Failed to load engagement opportunities:', err);
      win.webContents.send('engagement-opportunities-loaded', { success: false, error: err.message });
    }
  });

  // ==================
  // Tweet Actions (done, hide)
  // ==================
  ipcMain.on('tweet-action', async (event, { tweetId, actionType, actionContent }) => {
    try {
      await db.saveTweetAction(tweetId, actionType, actionContent);
      win.webContents.send('tweet-action-saved', { success: true, tweetId, actionType });
    } catch (err) {
      console.error('Failed to save tweet action:', err);
      win.webContents.send('tweet-action-saved', { success: false, error: err.message });
    }
  });

  // ==================
  // User Preferences (block, boost)
  // ==================
  ipcMain.on('block-user', async (event, { screenName, userName }) => {
    try {
      await db.blockUser(screenName, userName);
      win.webContents.send('user-blocked', { success: true, screenName });
    } catch (err) {
      console.error('Failed to block user:', err);
      win.webContents.send('user-blocked', { success: false, error: err.message });
    }
  });

  ipcMain.on('boost-user', async (event, { screenName, userName, points }) => {
    try {
      const result = await db.boostUser(screenName, userName, points);
      win.webContents.send('user-boosted', { success: true, screenName, newBoostPoints: result?.boost_points });
    } catch (err) {
      console.error('Failed to boost user:', err);
      win.webContents.send('user-boosted', { success: false, error: err.message });
    }
  });

  // ==================
  // Profile Handler
  // ==================
  ipcMain.on('fetch-profile', async () => {
    try {
      const profile = await twitterView.webContents.executeJavaScript(`
        (function() {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (!link) return null;
          const href = link.getAttribute('href');
          const screenName = href ? href.replace('/', '') : null;
          const nameEl = document.querySelector('[data-testid="UserName"]');
          const name = nameEl ? nameEl.textContent.split('@')[0].trim() : screenName;
          return { screen_name: screenName, name: name };
        })()
      `);

      if (profile) {
        settings.update({ profile });
      }
      win.webContents.send('profile-fetched', profile);
    } catch (err) {
      console.error('Failed to fetch profile:', err);
      win.webContents.send('profile-fetched', null);
    }
  });

  // ==================
  // ICP Generation
  // ==================
  ipcMain.on('generate-icp', async () => {
    try {
      // Step 1: Get profile handle
      win.webContents.send('icp-generating', 'Getting profile info...');

      const profileHandle = await twitterView.webContents.executeJavaScript(`
        (function() {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          return link ? link.getAttribute('href').replace('/', '') : null;
        })()
      `);

      if (!profileHandle) {
        win.webContents.send('icp-generated', { error: 'Could not find profile. Please log in to X.' });
        return;
      }

      // Step 2: Navigate to profile page
      win.webContents.send('icp-generating', 'Navigating to your profile...');
      await twitterView.webContents.loadURL(`https://x.com/${profileHandle}`);

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 3: Extract profile data
      win.webContents.send('icp-generating', 'Extracting profile data...');

      const profileData = await twitterView.webContents.executeJavaScript(`
        (function() {
          const data = {
            screen_name: '${profileHandle}',
            name: '',
            bio: '',
            location: '',
            followers_count: '',
            following_count: '',
            recentTweets: []
          };

          // Get name
          const nameEl = document.querySelector('[data-testid="UserName"]');
          if (nameEl) {
            const spans = nameEl.querySelectorAll('span');
            if (spans.length > 0) data.name = spans[0].textContent;
          }

          // Get bio
          const bioEl = document.querySelector('[data-testid="UserDescription"]');
          if (bioEl) data.bio = bioEl.textContent;

          // Get location
          const locationEl = document.querySelector('[data-testid="UserLocation"]');
          if (locationEl) data.location = locationEl.textContent;

          // Get follower counts
          const followLinks = document.querySelectorAll('a[href*="/verified_followers"], a[href*="/followers"], a[href*="/following"]');
          followLinks.forEach(link => {
            const text = link.textContent;
            if (link.href.includes('following')) {
              data.following_count = text.replace(' Following', '');
            } else if (link.href.includes('followers')) {
              data.followers_count = text.replace(' Followers', '');
            }
          });

          // Get recent tweets
          const tweets = document.querySelectorAll('[data-testid="tweetText"]');
          tweets.forEach((tweet, i) => {
            if (i < 10) {
              data.recentTweets.push(tweet.textContent.substring(0, 200));
            }
          });

          return data;
        })()
      `);

      // Step 4: Generate ICP using LLM
      win.webContents.send('icp-generating', 'Generating ICP with AI...');

      const client = getLLMClient();
      if (!client) {
        win.webContents.send('icp-generated', { error: 'LLM not configured' });
        return;
      }

      const icp = await client.generateICP(profileData);

      // Save profile data
      settings.update({ profile: profileData });

      // Navigate back to home
      twitterView.webContents.loadURL('https://x.com/home');

      win.webContents.send('icp-generated', { icp });

    } catch (err) {
      console.error('ICP generation failed:', err);
      win.webContents.send('icp-generated', { error: err.message });
      // Try to go back home
      twitterView.webContents.loadURL('https://x.com/home');
    }
  });

  // ==================
  // Network Debugger
  // ==================
  try {
    twitterView.webContents.debugger.attach('1.3');
  } catch (err) {
    console.log('Debugger attach failed:', err);
  }

  twitterView.webContents.debugger.on('detach', (event, reason) => {
    console.log('Debugger detached due to:', reason);
  });

  twitterView.webContents.debugger.on('message', async (event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const url = params.request.url;
      const pagePath = getPagePathFromUrl(url);
      if (pagePath) {
        // Capture activeListSlug at REQUEST time so in-flight responses from a
        // previous list don't get tagged with the new active slug after switch.
        requestMap.set(params.requestId, {
          url,
          pagePath,
          listSlug: pagePath === 'list' ? (activeListSlug || liveRunner?.listSlug || null) : null,
        });
      }
      // Also intercept Followers/Following when list fetch is active
      if (fetchingList && (url.includes('/Followers') || url.includes('/Following'))) {
        const listType = url.includes('/Followers') ? 'follower' : 'following';
        listRequestMap.set(params.requestId, { url, listType });
      }
      if (liveRunner && liveRunner.running && isLiveCaptureUrl(url)) {
        liveRequestMap.set(params.requestId, url);
      }
      return;
    }

    if (method === 'Network.loadingFailed') {
      requestMap.delete(params.requestId);
      listRequestMap.delete(params.requestId);
      liveRequestMap.delete(params.requestId);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const listInfo = listRequestMap.get(params.requestId);
      const requestInfo = requestMap.get(params.requestId);
      const liveUrl = liveRequestMap.get(params.requestId);
      if (listInfo) listRequestMap.delete(params.requestId);
      if (requestInfo) requestMap.delete(params.requestId);
      if (liveUrl) liveRequestMap.delete(params.requestId);
      if (!listInfo && !requestInfo && !liveUrl) return;

      let jsonResponse = null;
      let rawBody = null;
      try {
        const response = await twitterView.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        rawBody = response.base64Encoded
          ? Buffer.from(response.body, 'base64').toString('utf8')
          : response.body;
        jsonResponse = JSON.parse(rawBody);
      } catch (err) {
        if (liveUrl && liveRunner?.running && !liveRunner.pageHook) {
          liveRunner.lastBodyError = err.message;
        }
        return;
      }

      if (liveUrl && rawBody && liveRunner?.running && !liveRunner.pageHook) {
        liveRunner.accept(liveUrl, rawBody);
      }

      // Handle followers/following list interception
      if (listInfo) {
        try {
          const { extractFollowerFromGraphQL } = require('./lib/twitter/extractors');
          const { CRAWL_ENTRY_PATHS } = require('./lib/twitter/constants');
          const key = listInfo.listType === 'follower' ? 'Followers' : 'Following';
          const instructions = CRAWL_ENTRY_PATHS[key]?.(jsonResponse.data || jsonResponse);
          if (instructions) {
            for (const instr of instructions) {
              if (instr.type !== 'TimelineAddEntries') continue;
              for (const entry of instr.entries || []) {
                const profile = extractFollowerFromGraphQL(entry);
                if (profile) listCaptured.push({ ...profile, relationship: listInfo.listType });
              }
            }
            console.log(`[ListFetch] ${key}: captured ${listCaptured.length} total so far`);
          } else {
            const data = jsonResponse.data || jsonResponse;
            console.log(`[ListFetch] ${key}: no instructions found. Top-level keys:`, Object.keys(data));
          }
        } catch (_) {}
      }

      if (liveUrl && liveRunner && liveRunner.running) {
        try {
          await liveRunner.ingest(jsonResponse, liveUrl);
        } catch (err) {
          console.error('[Live] ingest error:', err.message);
        }
      }

      if (!requestInfo) return;

      try {

        // Lists tab: tag tweets from active X-list with source provenance.
        // Uses the slug captured at REQUEST time (requestInfo.listSlug) so a
        // late response from list A doesn't get tagged as list B after switch.
        if (requestInfo.pagePath === 'list' && requestInfo.listSlug && crawler) {
          try {
            const data = jsonResponse.data || jsonResponse;
            const result = await crawler.ingestListResponse(data, requestInfo.listSlug);
            // Only count toward the current run if the slug still matches what's active.
            if (requestInfo.listSlug === activeListSlug) {
              listCapturedThisRun += result.saved || 0;
              win?.webContents.send('list-crawl-status', {
                slug: activeListSlug,
                status: 'progress',
                message: `${activeListSlug}: ${listCapturedThisRun} new (scroll ${listScrollCount})`,
              });
            } else {
              console.log(`[ListCrawl] late response for ${requestInfo.listSlug} (now ${activeListSlug || 'idle'}): saved ${result.saved || 0}`);
            }
          } catch (err) {
            console.error('[ListCrawl] ingest error:', err.message);
          }
        }

        const tweetProcessor = new TweetProcessor(jsonResponse, requestInfo.pagePath);
        const tweets = tweetProcessor.extractTweets();

        if (tweets.length > 0) {
          // Deduplicate by tweet ID
          const existingIds = new Set(fetchedTweets.map(t => t.tweet?.id));
          const newTweets = tweets.filter(t => !existingIds.has(t.tweet?.id));
          fetchedTweets = [...fetchedTweets, ...newTweets];
          console.log(`[Fetch] Collected ${newTweets.length} new tweets (total: ${fetchedTweets.length})`);

          // Save to database immediately
          if (pendingFetch && newTweets.length > 0) {
            db.saveTweetsBatch(newTweets, requestInfo.url).then(({ saved, errors }) => {
              console.log(`[Fetch] Saved ${saved.length} tweets to DB (${errors.length} errors)`);
            }).catch(err => {
              console.error(`[Fetch] DB save error:`, err.message);
            });
          }

          // Also capture for test run if active
          if (testRunPending) {
            const testExistingIds = new Set(testRunTweets.map(t => t.tweet?.id));
            const testNewTweets = tweets.filter(t => !testExistingIds.has(t.tweet?.id));
            testRunTweets = [...testRunTweets, ...testNewTweets];
            console.log(`[TestRun] Collected ${testNewTweets.length} tweets (total: ${testRunTweets.length})`);
          }
        }
      } catch (err) {
        // Response body may not be available
      }
      return;
    }
  });

  twitterView.webContents.debugger.sendCommand('Network.enable', {
    maxResourceBufferSize: 10000000,
    maxTotalBufferSize: 50000000
  });

  // Copy GraphQL bodies out of the page itself. Network.getResponseBody was
  // coming back empty for these responses, so the sweep logged "nothing new"
  // with an empty database.
  twitterView.webContents.debugger.sendCommand('Page.enable').then(() => {
    return twitterView.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: LIVE_PAGE_HOOK,
    });
  }).then(() => {
    console.log('[Live] page hook armed');
  }).catch(err => {
    console.error('[Live] page hook arm failed:', err.message);
  });
  twitterView.webContents.executeJavaScript(LIVE_PAGE_HOOK).catch(() => {});

  // ==================
  // Crawl View Debugger
  // ==================
  try {
    crawlView.webContents.debugger.attach('1.3');
  } catch (err) {
    console.log('[Crawler] Debugger attach failed:', err);
  }

  crawlView.webContents.debugger.on('message', async (event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const url = params.request.url;
      // Log ALL twitter API calls so we can see what crawlView is doing
      if (url.includes('api/graphql') || url.includes('x.com/i/api')) {
        console.log(`[CrawlView] API call: ${url.split('/').pop().split('?')[0]}`);
      }
      const endpointType = getCrawlEndpointType(url);
      if (endpointType) {
        console.log(`[CrawlView] Intercepted: ${endpointType}`);
        crawlRequestMap.set(params.requestId, { url, endpointType });
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      const info = crawlRequestMap.get(params.requestId);
      if (!info) return;
      crawlRequestMap.delete(params.requestId);

      try {
        const response = await crawlView.webContents.debugger.sendCommand(
          'Network.getResponseBody', { requestId: params.requestId }
        );
        const json = JSON.parse(response.body);
        const data = json.data || json;
        console.log(`[CrawlView] Response for ${info.endpointType}, top-level keys:`, Object.keys(data));
        // Route SearchTimeline + UserTweets to the active X-prospect workflow
        // when its sinks are registered. All other endpoints (and any of these
        // when no sink) flow through the crawler state machine.
        if (info.endpointType === 'SearchTimeline' && xSearchListener) {
          try { await xSearchListener(data); } catch (e) { console.error('[CrawlView] xSearchListener error:', e.message); }
        } else if ((info.endpointType === 'UserTweets' || info.endpointType === 'UserTweetsAndReplies') && xUserTweetsListener) {
          try { await xUserTweetsListener(info.endpointType, data); } catch (e) { console.error('[CrawlView] xUserTweetsListener error:', e.message); }
        } else {
          const before = crawler.capturedTweets.length;
          crawler.ingestResponse(info.endpointType, data);
          console.log(`[CrawlView] ${info.endpointType}: +${crawler.capturedTweets.length - before} tweets (total ${crawler.capturedTweets.length})`);
        }
      } catch (err) {
        console.error(`[CrawlView] Error processing ${info.endpointType}:`, err.message);
      }
    }
  });

  crawlView.webContents.debugger.sendCommand('Network.enable', {
    maxResourceBufferSize: 10000000,
    maxTotalBufferSize: 50000000
  });

  // ==================
  // Social Circle Import
  // ==================
  ipcMain.on('import-social-circle', async (event, { filePath, type }) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const entries = parseTwitterExportJS(content, type);
      let imported = 0;
      for (const entry of entries) {
        await db.upsertSocialCircle({
          user_id: entry.user_id,
          relationship: type === 'follower' ? 'follower' : 'following',
        });
        imported++;
      }
      await db.markMutuals();

      // Queue enrichment jobs for entries without screen_name
      const circle = await db.getSocialCircle();
      const needsEnrichment = circle.filter(m => !m.screen_name && m.user_id);
      for (const m of needsEnrichment) {
        await db.insertCrawlJob({ job_type: 'enrichment', target_user_id: m.user_id });
      }

      win.webContents.send('social-circle-imported', {
        success: true, imported, enrichmentQueued: needsEnrichment.length
      });
    } catch (err) {
      console.error('[Import] Failed:', err.message);
      win.webContents.send('social-circle-imported', { success: false, error: err.message });
    }
  });

  // ==================
  // Circle Feed
  // ==================
  ipcMain.on('load-circle-feed', async (event, { relationship = 'all', days = 7, sort = 'engagement' } = {}) => {
    try {
      const feed = await db.getCircleFeed({ relationship, days, sort, limit: 200 });
      win.webContents.send('circle-feed-loaded', { success: true, feed });
    } catch (err) {
      win.webContents.send('circle-feed-loaded', { success: false, error: err.message });
    }
  });

  // ==================
  // Recompute mutuals from existing DB data
  // ==================
  ipcMain.on('recompute-mutuals', async () => {
    try {
      await db.markMutuals();
      const result = await db.getPool().query("SELECT COUNT(*) FROM social_circle WHERE relationship='mutual'");
      win.webContents.send('mutuals-recomputed', { success: true, count: parseInt(result.rows[0].count) });
    } catch (err) {
      win.webContents.send('mutuals-recomputed', { success: false, error: err.message });
    }
  });

  // ==================
  // Live follower/following import from X (uses visible twitterView)
  // ==================
  ipcMain.on('import-from-twitter', async () => {
    try {
      // Get screen name from settings or DOM
      let screenName = settings.get('profile')?.screen_name;
      if (!screenName) {
        try {
          screenName = await twitterView.webContents.executeJavaScript(`
            (function() {
              const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
              return link ? link.getAttribute('href').replace('/', '') : null;
            })()`);
        } catch (_) {}
      }
      if (!screenName) {
        win.webContents.send('twitter-import-status', { error: 'Profile not found. visit X first or set profile in Settings' });
        return;
      }

      fetchingList = true;
      listCaptured = [];

      const SCROLL_DELAY = 3500;
      const MAX_SCROLLS = 300;     // hard safety cap (~6000 users)
      const IDLE_LIMIT  = 4;       // stop after N scrolls produce zero new captures

      const scrollPage = () => twitterView.webContents.executeJavaScript(
        'window.scrollTo(0, document.body.scrollHeight)'
      ).catch(() => {});

      const wait = (ms) => new Promise(r => setTimeout(r, ms));

      // Read total count from DOM (handles "1,234" and "1.2K" formats)
      const readCount = () => twitterView.webContents.executeJavaScript(`
        (function() {
          const selectors = [
            'a[href$="/verified_followers"] span',
            'a[href$="/followers"] span',
            'a[href$="/following"] span',
            '[data-testid="primaryColumn"] span'
          ];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const t = el.textContent.trim();
              if (/^[\d,.]+[KkMm]?$/.test(t)) {
                if (t.endsWith('K') || t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
                if (t.endsWith('M') || t.endsWith('m')) return Math.round(parseFloat(t) * 1000000);
                return parseInt(t.replace(/[,\.]/g, '')) || 0;
              }
            }
          }
          return 0;
        })()
      `).catch(() => 0);

      const scrollList = async (label, relationship) => {
        await wait(SCROLL_DELAY);
        const total = await readCount();
        console.log(`[ListFetch] ${label}: total=${total}, scrolling until idle (idleLimit=${IDLE_LIMIT}, cap=${MAX_SCROLLS})`);

        let idle = 0;
        let prev = listCaptured.filter(p => p.relationship === relationship).length;

        for (let i = 0; i < MAX_SCROLLS; i++) {
          await scrollPage();
          await wait(SCROLL_DELAY);

          const captured = listCaptured.filter(p => p.relationship === relationship).length;
          const delta = captured - prev;
          prev = captured;

          if (delta === 0) idle++;
          else idle = 0;

          win.webContents.send('twitter-import-status', {
            progress: `${label}: ${captured}/${total || '?'} (scroll ${i + 1}, +${delta}, idle ${idle}/${IDLE_LIMIT})`
          });

          // Stop when target known and reached.
          if (total > 0 && captured >= total) {
            console.log(`[ListFetch] ${label}: hit total ${total} at scroll ${i + 1}`);
            break;
          }
          // Stop when no new API responses for IDLE_LIMIT consecutive scrolls.
          if (idle >= IDLE_LIMIT) {
            console.log(`[ListFetch] ${label}: idle stop at scroll ${i + 1}, captured ${captured}`);
            break;
          }
        }
      };

      // Step 1: Followers
      win.webContents.send('twitter-import-status', { progress: `Navigating to @${screenName}/followers...` });
      await twitterView.webContents.loadURL(`https://x.com/${screenName}/followers`);
      await scrollList('Followers', 'follower');

      // Step 2: Following
      win.webContents.send('twitter-import-status', { progress: `Navigating to @${screenName}/following...` });
      await twitterView.webContents.loadURL(`https://x.com/${screenName}/following`);
      await scrollList('Following', 'following');

      fetchingList = false;

      // Save to DB
      let saved = 0;
      let failed = 0;
      let firstErr = null;
      for (const profile of listCaptured) {
        try {
          await db.upsertSocialCircle(profile);
          saved++;
        } catch (err) {
          failed++;
          if (!firstErr) firstErr = err;
        }
      }
      if (failed > 0) {
        console.error(`[ListFetch] DB save: saved=${saved}, failed=${failed}. First error:`, firstErr?.message || firstErr);
      } else {
        console.log(`[ListFetch] DB save: ${saved}/${listCaptured.length} rows`);
      }
      try {
        await db.markMutuals();
      } catch (err) {
        console.error('[ListFetch] markMutuals failed:', err?.message || err);
      }

      // Return home
      twitterView.webContents.loadURL('https://x.com/home');

      const followers = listCaptured.filter(p => p.relationship === 'follower').length;
      const following = listCaptured.filter(p => p.relationship === 'following').length;
      win.webContents.send('twitter-import-status', {
        success: true,
        screenName,
        saved,
        followers,
        following,
      });
    } catch (err) {
      fetchingList = false;
      console.error('[ListFetch] Failed:', err.message);
      win.webContents.send('twitter-import-status', { error: err.message });
      twitterView.webContents.loadURL('https://x.com/home');
    }
  });

  // ==================
  // Crawl Controls
  // ==================
  ipcMain.on('start-crawl', async (event, { mode } = {}) => {
    await crawler.start(mode || 'user_tweets');
  });

  ipcMain.on('pause-crawl', () => crawler.pause());
  ipcMain.on('resume-crawl', () => crawler.resume());
  ipcMain.on('stop-crawl', () => crawler.stop());

  // ==================
  // X-list crawl (Lists tab)
  // ==================
  // stopListCrawl, scrollListOnce, openListFromMain hoisted to module scope so the
  // auto-crawl scheduler can drive them. IPC handlers below just delegate.

  function noteImportedList(list) {
    if (!list?.id) return;
    const prev = importedUserLists.get(list.id);
    if (prev) {
      if (!prev.name && list.name) prev.name = list.name;
      return;
    }
    importedUserLists.set(list.id, { id: String(list.id), name: list.name || '' });
  }

  function sendListImport(payload) {
    if (win && !win.isDestroyed()) win.webContents.send('list-import-status', payload);
  }

  async function scrapeImportedListLinks() {
    if (!twitterView || twitterView.webContents.isDestroyed()) return;
    const found = await twitterView.webContents.executeJavaScript(`(() => {
      const out = [];
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href*="/lists/"]')) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\\/lists\\/(\\d+)/);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);
        const lines = (link.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        const name = lines.find(line => line.length > 1 && line.length <= 80 && !/^\\d/.test(line)) || '';
        out.push({ id: match[1], name: name.slice(0, 80) });
      }
      return out;
    })()`);
    for (const list of found || []) noteImportedList(list);
  }

  async function clickListTab(label) {
    if (!twitterView || twitterView.webContents.isDestroyed()) return '';
    const want = JSON.stringify([label.toLowerCase()]);
    return twitterView.webContents.executeJavaScript(`(() => {
      const want = ${want};
      const nodes = document.querySelectorAll('a, button, [role="tab"], [role="link"]');
      for (const node of nodes) {
        const text = (node.innerText || '').trim().toLowerCase().split('\\n')[0];
        if (!text || text.length > 32) continue;
        if (want.includes(text)) { node.click(); return text; }
      }
      return '';
    })()`);
  }

  async function scrollImportedLists() {
    let idle = 0;
    let prev = importedUserLists.size;
    for (let i = 0; i < 25; i++) {
      if (!importingUserLists) return;
      try { await scrapeImportedListLinks(); } catch (_) {}
      if (importedUserLists.size === prev) idle += 1;
      else idle = 0;
      prev = importedUserLists.size;
      sendListImport({ status: 'scrolling', found: prev, message: `${prev} lists` });
      if (idle >= 3 && i > 0) return;
      try {
        await twitterView.webContents.executeJavaScript(
          'window.scrollBy(0, Math.max(500, Math.round((window.innerHeight || 800) * 0.85)))'
        );
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }

  async function importUserLists(page) {
    if (importingUserLists) return;
    if (activeListSlug || fetchingList) {
      sendListImport({ status: 'error', message: 'A list crawl is already running' });
      return;
    }
    const livePhase = liveRunner?.phase;
    if (liveRunner?.running && livePhase && !['idle', 'off', 'waiting'].includes(livePhase)) {
      sendListImport({ status: 'error', message: 'Live is using the view. Try again when the pass is idle' });
      return;
    }
    const url = listPageUrl(page);
    if (!url) {
      sendListImport({ status: 'error', message: 'Paste a lists page, like x.com/Scobleizer/lists' });
      return;
    }
    importingUserLists = true;
    importedUserLists.clear();
    try {
      sendListImport({ status: 'loading', message: 'Opening the lists page' });
      await twitterView.webContents.loadURL(url);
      await new Promise(resolve => setTimeout(resolve, 5000));
      await scrollImportedLists();
      for (const label of ['Owned', 'Memberships', 'Subscribed']) {
        if (!importingUserLists) break;
        const clicked = await clickListTab(label);
        if (!clicked) continue;
        await new Promise(resolve => setTimeout(resolve, 3000));
        await scrollImportedLists();
      }
      const lists = [...importedUserLists.values()];
      sendListImport({ status: 'done', found: lists.length, lists, message: `${lists.length} lists` });
    } catch (err) {
      sendListImport({ status: 'error', message: err.message || 'Import failed' });
    } finally {
      importingUserLists = false;
    }
  }

  ipcMain.on('import-user-lists', (_event, { page } = {}) => {
    importUserLists(page).catch(err => {
      importingUserLists = false;
      sendListImport({ status: 'error', message: err.message || 'Import failed' });
    });
  });

  ipcMain.on('open-list', async (event, { slug, listId }) => {
    if (!slug || !listId) {
      event.sender.send('list-crawl-status', { slug, status: 'error', message: 'Missing slug or list id' });
      return;
    }
    // Same slug already active = no-op (guards against accidental re-click).
    if (activeListSlug === slug) {
      console.log(`[ListCrawl] ${slug} already active, ignoring re-open`);
      return;
    }
    // Manual open clears any pending auto-crawl queue so user takes precedence.
    autoCrawlQueue = [];
    openListFromMain(slug, listId);
  });

  ipcMain.on('stop-list-crawl', () => {
    // Debounce: if user just opened, ignore Stop within grace window
    // (mitigates accidental double-click on the card where Open re-renders into Stop).
    if (activeListSlug && Date.now() - listOpenedAt < LIST_STOP_GRACE_MS) {
      console.log(`[ListCrawl] ignoring Stop within grace (${Date.now() - listOpenedAt}ms since open)`);
      return;
    }
    stopListCrawl('stopped');
  });

  ipcMain.on('get-list-stats', async (event, slugs) => {
    const out = {};
    const list = Array.isArray(slugs) ? slugs : [];
    for (const slug of list) {
      try {
        out[slug] = await db.getListCrawlStats(slug, 7);
      } catch (err) {
        out[slug] = { total: 0, today: 0, recent: 0, last_capture: null };
      }
    }
    event.sender.send('list-stats', out);
  });

  // ==================
  // List Feed (read crawled tweets per source_list, joined with LLM scores)
  // ==================
  ipcMain.on('get-list-feed', async (event, { slug = 'all', limit = 200, includeActioned = false, hoursWindow = 3 } = {}) => {
    try {
      const rows = await db.getListFeedScored({ slug, limit, includeActioned, hoursWindow });
      const counts = await db.getListFeedStats();
      event.sender.send('list-feed-loaded', { success: true, slug, rows, counts, hoursWindow });
    } catch (err) {
      console.error('[ListFeed] load error:', err.message);
      event.sender.send('list-feed-loaded', { success: false, error: err.message });
    }
  });

  // Manual rescore trigger from renderer
  ipcMain.on('rescore-feed', async (event, { hoursMax = 3, limit = 100 } = {}) => {
    try {
      const r = await runFeedScoring({ hoursMax, limit, source: 'manual' });
      event.sender.send('feed-rescore-done', { success: true, ...r });
    } catch (err) {
      console.error('[FeedScore] manual error:', err.message);
      event.sender.send('feed-rescore-done', { success: false, error: err.message });
    }
  });

  // Stop in-flight feed scoring. The current tweet's request finishes (since
  // we can't cancel fetch mid-flight cleanly), then the loop bails.
  ipcMain.on('stop-feed-scoring', () => {
    if (!feedScoringRunning) return;
    feedScoringAbortRequested = true;
    console.log('[FeedScore] stop requested');
    emitFeedProgress({ phase: 'aborting' });
  });

  ipcMain.on('circle-tweet-action', async (event, { tweetId, actionType, actionContent }) => {
    try {
      const id = await db.recordCircleTweetAction(tweetId, actionType, actionContent || null);
      event.sender.send('circle-tweet-action-done', { success: true, id, tweetId, actionType });
    } catch (err) {
      console.error('[ListFeed] action error:', err.message);
      event.sender.send('circle-tweet-action-done', { success: false, error: err.message });
    }
  });

  ipcMain.on('open-circle-tweet', (event, { tweetId, screenName }) => {
    if (!tweetId || !screenName) return;
    const url = `https://x.com/${screenName}/status/${tweetId}`;
    twitterView.webContents.loadURL(url).catch(() => {});
  });

  ipcMain.on('queue-circle-crawl', async (event, { relationship, relationships } = {}) => {
    try {
      // Accept single relationship string OR array of relationships
      const rels = relationships || (relationship ? [relationship] : null);
      console.log(`[Queue] Fetching social_circle (filter: ${rels?.join(',') || 'all'})...`);
      let circle = [];
      const nonUncrawled = rels?.filter(r => r !== 'uncrawled') || [];
      if (nonUncrawled.length > 0) {
        for (const rel of nonUncrawled) {
          const rows = await db.getSocialCircle(rel);
          circle.push(...rows);
        }
      } else {
        circle = await db.getSocialCircle(); // all relationships
      }

      const isUncrawledOnly = rels?.includes('uncrawled');
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h
      const eligible = circle.filter(m => {
        if (!m.screen_name) return false;
        if (isUncrawledOnly) return !m.last_crawled_at;
        return !m.last_crawled_at || new Date(m.last_crawled_at) < cutoff;
      });
      console.log(`[Queue] ${eligible.length} eligible (mode: ${isUncrawledOnly ? 'uncrawled-only' : '7d'})`);

      if (eligible.length === 0) {
        win.webContents.send('circle-crawl-queued', { success: true, queued: 0 });
        return;
      }

      const cleared = await db.clearPendingCrawlJobs('user_tweets');
      console.log(`[Queue] Cleared ${cleared} existing pending jobs`);

      const jobs = eligible.map(m => ({ job_type: 'user_tweets', target_screen_name: m.screen_name }));
      const queued = await db.insertCrawlJobsBulk(jobs);
      console.log(`[Queue] Done. ${queued} jobs inserted`);

      win.webContents.send('circle-crawl-queued', { success: true, queued, relationship });
    } catch (err) {
      console.error('[Queue] Failed:', err.message);
      win.webContents.send('circle-crawl-queued', { success: false, error: err.message });
    }
  });

  // ==================
  // Deep Crawl (strict-priority)
  // ==================
  ipcMain.on('get-deep-priority-preview', async (event, opts = {}) => {
    try {
      const targets = await db.getStrictPriorityTargets({
        dateCutoff: opts.dateCutoff || '2026-03-01',
        recentDays: opts.recentDays || 7,
      });
      win.webContents.send('deep-priority-preview', {
        success: true,
        count: targets.length,
        sample: targets.slice(0, 10),
      });
    } catch (err) {
      win.webContents.send('deep-priority-preview', { success: false, error: err.message });
    }
  });

  ipcMain.on('enqueue-deep-priority', async (event, opts = {}) => {
    try {
      const targets = await db.getStrictPriorityTargets({
        dateCutoff: opts.dateCutoff || '2026-03-01',
        recentDays: opts.recentDays || 7,
      });
      const cleared = await db.clearPendingDeepJobs();
      const screenNames = targets.map(t => t.screen_name).filter(Boolean);
      const queued = await db.enqueueDeepCrawlForScreenNames(screenNames);
      console.log(`[DeepQueue] Cleared ${cleared} pending. Enqueued ${queued} deep jobs.`);
      win.webContents.send('deep-priority-enqueued', { success: true, queued, cleared });
    } catch (err) {
      console.error('[DeepQueue] Failed:', err.message);
      win.webContents.send('deep-priority-enqueued', { success: false, error: err.message });
    }
  });

  ipcMain.on('set-deep-config', (event, cfg) => {
    if (crawler && cfg) crawler.setDeepConfig(cfg);
  });

  // ==================
  // Crawl group stats (counts for the accordion in Crawl tab)
  // ==================
  ipcMain.on('get-crawl-groups', async () => {
    try {
      const pool = db.getPool();
      const { rows } = await pool.query(`
        WITH zero_following AS (
          SELECT screen_name FROM social_circle
          WHERE relationship='following' AND followers_count=0 AND following_count=0 AND screen_name IS NOT NULL
        ),
        zero_2nd AS (
          SELECT screen_name FROM social_circle
          WHERE relationship='2nd_degree' AND followers_count=0 AND following_count=0 AND screen_name IS NOT NULL
        ),
        reply_targets_no_tweets AS (
          SELECT DISTINCT ct.in_reply_to_screen_name AS screen_name
          FROM circle_tweets ct
          WHERE ct.in_reply_to_screen_name IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM circle_tweets ct2
              WHERE ct2.screen_name = ct.in_reply_to_screen_name
            )
        )
        SELECT
          (SELECT COUNT(*) FROM zero_following)            AS following_zerozero,
          (SELECT COUNT(*) FROM zero_2nd)                  AS second_degree_zerozero,
          (SELECT COUNT(*) FROM reply_targets_no_tweets)   AS reply_targets_no_tweets
      `);
      win.webContents.send('crawl-groups-loaded', { success: true, counts: rows[0] });
    } catch (err) {
      console.error('[CrawlGroups] Failed:', err.message);
      win.webContents.send('crawl-groups-loaded', { success: false, error: err.message });
    }
  });

  // ==================
  // Queue handlers per accordion group (dedup against existing pending of same job_type)
  // ==================
  async function _queueGroup(jobType, screenNames) {
    if (!screenNames.length) return { queued: 0, skipped: 0 };
    const pool = db.getPool();
    const { rows: existing } = await pool.query(
      `SELECT target_screen_name FROM crawl_jobs
       WHERE job_type = $1 AND status IN ('pending','running')
         AND target_screen_name = ANY($2::text[])`,
      [jobType, screenNames]
    );
    const skip = new Set(existing.map(r => r.target_screen_name));
    const fresh = screenNames.filter(n => !skip.has(n));
    if (!fresh.length) return { queued: 0, skipped: screenNames.length };
    const jobs = fresh.map(n => ({ job_type: jobType, target_screen_name: n }));
    const queued = await db.insertCrawlJobsBulk(jobs);
    return { queued, skipped: screenNames.length - fresh.length };
  }

  ipcMain.on('queue-following-zerozero', async () => {
    try {
      const pool = db.getPool();
      const { rows } = await pool.query(`
        SELECT screen_name FROM social_circle
        WHERE relationship='following' AND followers_count=0 AND following_count=0 AND screen_name IS NOT NULL
      `);
      const result = await _queueGroup('user_tweets_deep', rows.map(r => r.screen_name));
      win.webContents.send('crawl-group-queued', { group: 'following_zerozero', success: true, ...result });
    } catch (err) {
      win.webContents.send('crawl-group-queued', { group: 'following_zerozero', success: false, error: err.message });
    }
  });

  ipcMain.on('queue-2nd-degree-shallow', async () => {
    try {
      const pool = db.getPool();
      const { rows } = await pool.query(`
        SELECT screen_name FROM social_circle
        WHERE relationship='2nd_degree' AND followers_count=0 AND following_count=0 AND screen_name IS NOT NULL
      `);
      const result = await _queueGroup('user_tweets_shallow', rows.map(r => r.screen_name));
      win.webContents.send('crawl-group-queued', { group: 'second_degree_shallow', success: true, ...result });
    } catch (err) {
      win.webContents.send('crawl-group-queued', { group: 'second_degree_shallow', success: false, error: err.message });
    }
  });

  ipcMain.on('queue-reply-targets', async () => {
    try {
      const pool = db.getPool();
      const { rows } = await pool.query(`
        SELECT DISTINCT ct.in_reply_to_screen_name AS screen_name
        FROM circle_tweets ct
        WHERE ct.in_reply_to_screen_name IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM circle_tweets ct2
            WHERE ct2.screen_name = ct.in_reply_to_screen_name
          )
      `);
      const result = await _queueGroup('user_tweets_shallow', rows.map(r => r.screen_name));
      win.webContents.send('crawl-group-queued', { group: 'reply_targets', success: true, ...result });
    } catch (err) {
      win.webContents.send('crawl-group-queued', { group: 'reply_targets', success: false, error: err.message });
    }
  });

  // ==================
  // Load Social Circle
  // ==================
  ipcMain.on('load-social-circle', async () => {
    try {
      const [circle, stats, crawlStats] = await Promise.all([
        db.getSocialCircle(),
        db.getSocialCircleStats(),
        db.getCrawlStats(),
      ]);
      win.webContents.send('social-circle-loaded', { success: true, circle, stats, crawlStats });
    } catch (err) {
      win.webContents.send('social-circle-loaded', { success: false, error: err.message });
    }
  });

  // ==================
  // Generate Drafts
  // ==================
  ipcMain.on('generate-drafts', async (event, { screenshotPath } = {}) => {
    try {
      win.webContents.send('drafts-generating', { status: 'Assembling circle context...' });

      const client = getLLMClient();
      if (!client) {
        win.webContents.send('drafts-generated', { success: false, error: 'LLM not configured' });
        return;
      }

      win.webContents.send('drafts-generating', { status: 'Generating drafts with AI...' });
      const result = await generateDrafts(db, client);

      // Export to social-wiki/drafts/
      const today = new Date().toISOString().slice(0, 10);
      wikiExport.exportDrafts(result.drafts, today);

      win.webContents.send('drafts-generated', { success: true, drafts: result.drafts, savedIds: result.savedIds });

      // macOS notification
      if (Notification.isSupported()) {
        new Notification({
          title: 'Drafts Ready',
          body: `${result.drafts.length} post drafts generated. Best time: 22:00 IST tonight.`,
        }).show();
      }
    } catch (err) {
      console.error('[Drafts] Generation failed:', err.message);
      win.webContents.send('drafts-generated', { success: false, error: err.message });
    }
  });

  ipcMain.on('load-drafts', async () => {
    try {
      const drafts = await db.getDrafts();
      win.webContents.send('drafts-loaded', { success: true, drafts });
    } catch (err) {
      win.webContents.send('drafts-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('update-draft', async (event, { id, status, draft_text }) => {
    try {
      await db.updateDraft(id, { status, draft_text });
      win.webContents.send('draft-updated', { success: true, id });
    } catch (err) {
      win.webContents.send('draft-updated', { success: false, error: err.message });
    }
  });

  // ==================
  // Prospects (Origami-style ICP search)
  // ==================
  ipcMain.on('prospect-search', async (event, { platform, prompt, candidateLimit, minScore, minFollowers } = {}) => {
    try {
      if (!platform || !prompt) {
        win.webContents.send('prospect-search-done', { success: false, error: 'platform + prompt required' });
        return;
      }
      const client = getLLMClient();
      if (!client) {
        win.webContents.send('prospect-search-done', { success: false, error: 'LLM client not configured. Set an API key in Settings.' });
        return;
      }
      const onProgress = (stage, payload) => {
        try { win.webContents.send('prospect-search-progress', { stage, ...payload }); } catch (_) {}
      };
      const result = await prospects.runSearch({
        platform,
        prompt,
        llmClient: client,
        candidateLimit: candidateLimit || 25,
        minScore: minScore != null ? minScore : 40,
        minFollowers: minFollowers || 0,
        onProgress,
      });
      win.webContents.send('prospect-search-done', { success: true, ...result });
    } catch (err) {
      win.webContents.send('prospect-search-done', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-list-searches', async (event, { platform } = {}) => {
    try {
      const rows = await prospects.listSearches(platform);
      win.webContents.send('prospect-searches-loaded', { success: true, platform, rows });
    } catch (err) {
      win.webContents.send('prospect-searches-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-load-results', async (event, { searchId, minScore = 0 } = {}) => {
    try {
      const search = await prospects.getSearch(searchId);
      const rows = await prospects.getSearchResults(searchId, { minScore });
      win.webContents.send('prospect-results-loaded', { success: true, search, rows });
    } catch (err) {
      win.webContents.send('prospect-results-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-browse-all', async (event, { platform, limit = 300 } = {}) => {
    try {
      const rows = await prospects.listAllProspects(platform, { limit });
      win.webContents.send('prospect-results-loaded', { success: true, browse: true, platform, rows });
    } catch (err) {
      win.webContents.send('prospect-results-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-enrich-all', async (event, { platform, headlineFilter = null, limit = 2000 } = {}) => {
    try {
      if (platform !== 'linkedin') {
        win.webContents.send('prospect-search-done', { success: false, error: 'Enrichment only supports LinkedIn.' });
        return;
      }
      const token = (settings && settings.get && settings.get('apify')?.token) || null;
      if (!token) {
        win.webContents.send('prospect-search-done', { success: false, error: 'Apify token missing. Set settings.apify.token.' });
        return;
      }
      const enrich = require('./lib/linkedin/enrich-apify');
      const { getPool } = require('./lib/db');
      const handles = await enrich.listHandlesToEnrich(getPool, { headlineFilter, limit });
      if (!handles.length) {
        win.webContents.send('prospect-search-progress', { stage: 'done', message: 'Nothing to enrich. All matching prospects already enriched.' });
        win.webContents.send('prospect-search-done', { success: true, enriched: 0, total: 0 });
        return;
      }
      const onProgress = (stage, payload) => {
        try { win.webContents.send('prospect-search-progress', { stage: `enrich_${stage}`, ...payload }); } catch (_) {}
      };
      const result = await enrich.enrichProspects({ getPool, token, handles, onProgress, chunkSize: 50 });
      win.webContents.send('prospect-search-done', { success: true, ...result });
    } catch (err) {
      win.webContents.send('prospect-search-done', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-embed-and-score', async (event, { platform, prompt, embedFirst = true } = {}) => {
    try {
      if (platform !== 'linkedin') {
        win.webContents.send('prospect-search-done', { success: false, error: 'Embedding scoring only supports LinkedIn.' });
        return;
      }
      const cfg = (settings && settings.get && settings.get('openrouter')) || {};
      const apiKey = cfg.apiKey;
      if (!apiKey) {
        win.webContents.send('prospect-search-done', { success: false, error: 'OpenRouter API key missing. Set settings.openrouter.apiKey.' });
        return;
      }
      const ident = getIdentity(settings);
      const icpText = (prompt && prompt.trim()) || ident.icp?.linkedin || '';
      if (!icpText) {
        win.webContents.send('prospect-search-done', { success: false, error: 'No ICP. Type one or set identity.icp.linkedin.' });
        return;
      }
      const embed = require('./lib/prospects/embed');
      const { getPool } = require('./lib/db');
      const onProgress = (stage, payload) => {
        try { win.webContents.send('prospect-search-progress', { stage: `embed_${stage}`, ...payload }); } catch (_) {}
      };
      let embedResult = { embedded: 0, failed: 0, total: 0 };
      if (embedFirst) {
        embedResult = await embed.embedAllProspects({
          getPool, apiKey, onProgress, limit: 5000,
        });
      }
      const { searchId, rows } = await embed.scoreByEmbedding({
        getPool, apiKey, icpText, limit: 200, prompt: icpText,
      });
      win.webContents.send('prospect-search-progress', { stage: 'embed_scored', searchId, count: rows.length, top: rows.slice(0, 3) });
      win.webContents.send('prospect-search-done', { success: true, searchId, embed: embedResult, scored: rows.length });
      // Auto-load results into the Prospects view.
      win.webContents.send('prospect-results-loaded', { success: true, search: { id: searchId }, rows });
    } catch (err) {
      win.webContents.send('prospect-search-done', { success: false, error: err.message });
    }
  });

  // ─── X-prospect embed + 3-way score + daily-ten ────────────────────────────
  // Shared body used by both the IPC and the workflow's embed-tail. Returns
  // { searchId, embed: {embedded,failed,total}, scored: N, rows }.
  async function runXEmbedAndScore({
    prompt,
    embedFirst = true,
    excludeContacted = true,
    limit = 200,
    onProgress = () => {},
  } = {}) {
    const cfg = (settings && settings.get && settings.get('openrouter')) || {};
    const apiKey = cfg.apiKey;
    if (!apiKey) throw new Error('OpenRouter API key missing. Set settings.openrouter.apiKey.');
    const ident = getIdentity(settings);
    const icpText = (prompt && prompt.trim()) || ident.icp?.x || '';
    if (!icpText) throw new Error('No ICP. Type one or set identity.icp.x.');

    const embed = require('./lib/prospects/embed');
    const webFetch = require('./lib/prospects/web-fetch');
    const { getPool } = require('./lib/db');

    let embedResult = { embedded: 0, failed: 0, total: 0 };
    if (embedFirst) {
      embedResult = await embed.embedAllXProspects({
        getPool, apiKey, onProgress,
        enrichFn: async (p) => {
          const tweets = await prospects.getRecentTweetsForHandle(p.handle, 20);
          let webText = p.website_text || '';
          if (!webText && p.website_url) {
            try {
              const blurb = await webFetch.fetchWebsiteBlurb(p.website_url);
              webText = blurb.text || '';
              if (webText) await prospects.saveWebsiteBlurb(p.id, { url: blurb.url, text: webText });
            } catch (_) {}
          }
          return { tweets, webText };
        },
        limit: 2000,
      });
    }

    const { searchId, rows } = await embed.scoreXByEmbedding({
      getPool, apiKey, icpText, limit, prompt: icpText, excludeContacted,
    });
    return { searchId, embed: embedResult, scored: rows.length, rows };
  }

  ipcMain.on('prospect-x-embed-and-score', async (event, { prompt, embedFirst = true, excludeContacted = true } = {}) => {
    try {
      const onProgress = (stage, payload) => {
        try { win.webContents.send('prospect-search-progress', { stage: `x_embed_${stage}`, ...payload }); } catch (_) {}
      };
      const { searchId, embed: embedResult, scored, rows } = await runXEmbedAndScore({ prompt, embedFirst, excludeContacted, onProgress });
      win.webContents.send('prospect-search-progress', { stage: 'x_embed_scored', searchId, count: scored, top: rows.slice(0, 3) });
      win.webContents.send('prospect-search-done', { success: true, searchId, embed: embedResult, scored });
      win.webContents.send('prospect-results-loaded', { success: true, search: { id: searchId }, rows });
    } catch (err) {
      console.error('[prospect-x-embed-and-score]', err);
      win.webContents.send('prospect-search-done', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-x-daily-ten', async (event, { limit = 10, minScore = 0 } = {}) => {
    try {
      const { searchId, rows } = await prospects.listTopXProspectsUncontacted({ limit, minScore });
      win.webContents.send('prospect-results-loaded', {
        success: true,
        dailyTen: true,
        platform: 'x',
        search: searchId ? { id: searchId } : null,
        rows,
      });
    } catch (err) {
      win.webContents.send('prospect-results-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-score-all', async (event, { platform, prompt } = {}) => {
    try {
      if (!platform) {
        win.webContents.send('prospect-search-done', { success: false, error: 'platform required' });
        return;
      }
      const ident = getIdentity(settings);
      const finalPrompt = (prompt && prompt.trim()) || ident.icp?.[platform] || '';
      if (!finalPrompt) {
        win.webContents.send('prospect-search-done', { success: false, error: `No ICP prompt. Type one or set identity.icp.${platform} in Settings.` });
        return;
      }
      const client = getLLMClient();
      if (!client) {
        win.webContents.send('prospect-search-done', { success: false, error: 'LLM client not configured. Set an API key in Settings.' });
        return;
      }
      const onProgress = (stage, payload) => {
        try { win.webContents.send('prospect-search-progress', { stage, ...payload }); } catch (_) {}
      };
      const result = await prospects.runFullScoring({
        platform, prompt: finalPrompt, llmClient: client, onProgress, concurrency: 5,
      });
      win.webContents.send('prospect-search-done', { success: true, ...result });
    } catch (err) {
      win.webContents.send('prospect-search-done', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-generate-outreach', async (event, { prospectId, searchId, platform, channel, context, prospect } = {}) => {
    try {
      const client = getLLMClient();
      if (!client) {
        win.webContents.send('prospect-outreach-generated', { success: false, error: 'LLM client not configured.' });
        return;
      }
      const ident = getIdentity(settings);
      const ocPlatform = ident.outreach_context?.[platform] || ident.outreach_context?.x || 'an indie builder';
      const body = await generateOutreach(client, {
        prospect, platform, channel,
        context: context || ocPlatform,
      });
      const draftId = await prospects.saveOutreachDraft({
        prospectId, searchId, platform, channel, body,
        model: settings.getActiveProvider().config?.model || null,
      });
      win.webContents.send('prospect-outreach-generated', { success: true, id: draftId, body });
    } catch (err) {
      win.webContents.send('prospect-outreach-generated', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-list-outreach', async (event, { platform, status } = {}) => {
    try {
      const rows = await prospects.listOutreachDrafts({ platform, status });
      win.webContents.send('prospect-outreach-loaded', { success: true, rows });
    } catch (err) {
      win.webContents.send('prospect-outreach-loaded', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-update-outreach', async (event, { id, body, status } = {}) => {
    try {
      await prospects.updateOutreachDraft(id, { body, status });
      win.webContents.send('prospect-outreach-updated', { success: true, id });
    } catch (err) {
      win.webContents.send('prospect-outreach-updated', { success: false, error: err.message });
    }
  });

  ipcMain.on('prospect-ingest-linkedin', async (event, { rows } = {}) => {
    try {
      const ids = await prospects.ingestLinkedinProspects(rows || []);
      win.webContents.send('prospect-linkedin-ingested', { success: true, count: ids.length });
    } catch (err) {
      win.webContents.send('prospect-linkedin-ingested', { success: false, error: err.message });
    }
  });

  // ==================
  // Export Social Wiki
  // ==================
  ipcMain.on('export-wiki', async () => {
    try {
      const drafts = await db.getDrafts('draft');
      const paths = await wikiExport.exportAll(db, drafts);
      win.webContents.send('wiki-exported', { success: true, paths });
    } catch (err) {
      win.webContents.send('wiki-exported', { success: false, error: err.message });
    }
  });

  // ==================
  // Live tab: keep capturing whatever the X view loads
  // ==================
  if (!liveRunner) {
    liveRunner = new LiveRunner({
      getView: () => twitterView,
      db,
      isBusy: () => !!(activeListSlug || fetchingList || pendingFetch || importingUserLists),
      getPlatform: () => activePlatform,
      emit: (status) => {
        if (win && !win.isDestroyed()) win.webContents.send('live-status', status);
      },
      persistRunning: (running) => {
        if (!settings) return;
        const prev = settings.get('liveCapture') || {};
        settings.set('liveCapture', { ...prev, running: !!running });
      },
      persistInterval: (minutes) => {
        if (!settings) return;
        const prev = settings.get('liveCapture') || {};
        settings.set('liveCapture', { ...prev, intervalMinutes: minutes });
      },
      persistTrackFollows: (on) => {
        if (!settings) return;
        const prev = settings.get('liveCapture') || {};
        settings.set('liveCapture', { ...prev, trackFollows: !!on });
      },
      intervalMinutes: settings.get('liveCapture')?.intervalMinutes,
      trackFollows: settings.get('liveCapture')?.trackFollows === true,
      getScreenName: () => settings.get('profile')?.screen_name || '',
      getLists: () => {
        const ids = settings.get('lists') || {};
        return Object.keys(ids).map(slug => ({ slug, id: ids[slug] }));
      },
    });
  }

  ipcMain.on('live-play', (_event, { on } = {}) => {
    if (!liveRunner) return;
    if (on) liveRunner.start();
    else liveRunner.stop();
  });

  ipcMain.on('live-interval', (_event, { minutes } = {}) => {
    liveRunner?.setIntervalMinutes(minutes);
  });

  ipcMain.on('live-track-follows', (_event, { on } = {}) => {
    liveRunner?.setTrackFollows(on);
  });

  ipcMain.on('live-sync', () => {
    liveRunner?.syncNow();
  });

  ipcMain.on('live-get', () => {
    liveRunner?.emitNow();
  });

  if (!liveNetHooked) {
    liveNetHooked = true;
    ipcMain.on('live-net-body', (_event, { url, body } = {}) => {
      if (importingUserLists && body) {
        try {
          const json = JSON.parse(body);
          for (const list of extractLists(json)) noteImportedList(list);
        } catch (_) {}
      }
      if (!liveRunner?.running || !url || !body) return;
      if (!isLiveCaptureUrl(url)) return;
      liveRunner.pageHook = true;
      liveRunner.accept(url, body);
      // The list page's timeline body often never comes back through CDP.
      // The page hook has it. Save it onto the list the pass is standing on.
      if (liveRunner.listSlug && crawler && url.includes('/ListLatestTweetsTimeline')) {
        try {
          const json = JSON.parse(body);
          const slug = liveRunner.listSlug;
          crawler.ingestListResponse(json.data || json, slug).catch(err => {
            console.error('[Live] list save:', err.message);
          });
        } catch (_) {}
      }
    });
  }

  if (settings.get('liveCapture')?.running) {
    liveRunner.start();
  }

  // Recompute BrowserView bounds on every state change that affects the content
  // area. macOS fires `resize` differently for maximize/fullscreen transitions
  // than for drag-resize, so subscribe to all of them. `setImmediate` defers the
  // call until after Chromium has settled into the new size — without it the
  // BrowserView is sometimes sized against the OLD content area.
  const scheduleResize = () => setImmediate(resizeTwitterView);
  win.on('resize',            scheduleResize);
  win.on('maximize',          scheduleResize);
  win.on('unmaximize',        scheduleResize);
  win.on('enter-full-screen', scheduleResize);
  win.on('leave-full-screen', scheduleResize);
}

// Hidden bounds = 0×0 offscreen. Used to "remove" a BrowserView from view
// without detaching it (preserves session, debugger, scroll state).
const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

function resizeTwitterView() {
  if (!win || win.isDestroyed()) return;
  // getContentBounds() = inner area (no title bar / chrome). BrowserView.setBounds
  // is in content coords, so this is the correct source.
  const bounds = win.getContentBounds();
  const mobileWidth = 375;
  const normalSidebarWidth = 320;

  const contentWidth = focusMode ? mobileWidth : Math.max(0, bounds.width - normalSidebarWidth);
  const visibleTarget = { x: 0, y: 0, width: contentWidth, height: bounds.height };

  const xTarget   = activePlatform === 'x'        ? visibleTarget : HIDDEN_BOUNDS;
  const liTarget  = activePlatform === 'linkedin' ? visibleTarget : HIDDEN_BOUNDS;
  // crawlView only ever runs in X mode (twitter crawler). Hide in LinkedIn mode.
  const crawlTarget = activePlatform === 'x' ? visibleTarget : HIDDEN_BOUNDS;

  if (twitterView && !twitterView.webContents.isDestroyed()) {
    twitterView.setBounds(xTarget);
    try { twitterView.webContents.invalidate(); } catch {}
  }
  if (linkedinView && !linkedinView.webContents.isDestroyed()) {
    linkedinView.setBounds(liTarget);
    try { linkedinView.webContents.invalidate(); } catch {}
  }
  if (crawlView && !crawlView.webContents.isDestroyed()) {
    crawlView.setBounds(crawlTarget);
    try { crawlView.webContents.invalidate(); } catch {}
  }

  // Z-order: whichever BrowserView matches activePlatform is on top.
  // Exception: while crawling in X mode, crawlView gets top to capture viewport
  // focus for pagination triggers (see crawler.js).
  if (activePlatform === 'x') {
    const top = crawler && crawler.state === 'crawling' ? crawlView : twitterView;
    if (top) win.setTopBrowserView(top);
  } else if (linkedinView) {
    win.setTopBrowserView(linkedinView);
  }
}

function applyPlatform(platform) {
  if (platform !== 'x' && platform !== 'linkedin') return;
  activePlatform = platform;
  if (settings) settings.set('activePlatform', platform);
  resizeTwitterView();
  if (win && !win.isDestroyed()) {
    win.webContents.send('platform-changed', { platform });
  }
}

// Prevent duplicate instances corrupting shared userData (service worker / quota DBs).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.resolve(app.getAppPath(), 'assets', 'icon.png')); } catch {}
  }
  settings = new Settings();
  db.configure(settings.get('database'));
  const dbTarget = db.getConfig();
  console.log(`[Boot] database: ${dbTarget.host}/${dbTarget.database}`);
  try {
    const reset = await db.resetAllRunningOnBoot();
    if (reset) console.log(`[Boot] Reset ${reset} stale 'running' crawl jobs to 'pending'`);
  } catch (err) {
    console.error('[Boot] resetAllRunningOnBoot failed:', err.message);
  }
  createWindow();

  // Periodic feed-scoring heartbeat. First run after 60s so app finishes booting,
  // then every FEED_SCORE_HEARTBEAT_MS.
  setTimeout(() => runFeedScoring({ source: 'boot' }), 60 * 1000);
  setInterval(() => runFeedScoring({ source: 'heartbeat' }), FEED_SCORE_HEARTBEAT_MS);

  // Auto-crawl scheduler: if user left it `running` last session, resume on boot.
  scheduleNextAutoCrawl('boot');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Flush current job back to pending before exit so crash-resume works.
async function flushCurrentJobOnExit(reason) {
  if (!crawler?.currentJob) return;
  try {
    await db.updateCrawlJob(crawler.currentJob.id, 'pending', { error_message: `interrupted:${reason}` });
    console.log(`[Exit] Flushed job ${crawler.currentJob.id} back to pending (${reason})`);
  } catch (err) {
    console.error('[Exit] flush failed:', err.message);
  }
}

app.on('before-quit', async (e) => {
  if (crawler?.currentJob) {
    e.preventDefault();
    await flushCurrentJobOnExit('before-quit');
    app.exit(0);
  }
});

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await flushCurrentJobOnExit('uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
