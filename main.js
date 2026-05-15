const path = require('path');
const { app, BrowserWindow, BrowserView, ipcMain, session, Notification, powerSaveBlocker } = require('electron');

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

let win, twitterView, crawlView, settings, llmClient;
let pendingFetch = false;
let fetchedTweets = [];
let currentLinkIndex = 0;
let feedLinks = [];
const requestMap = new Map();
const crawlRequestMap = new Map();
const listRequestMap = new Map(); // for Followers/Following interception on main view
let focusMode = false;
let crawler = null;
let fetchingList = false;
let listCaptured = [];

// Feed scoring state — debounced after crawl, plus a periodic heartbeat.
let feedScoringRunning = false;
let feedScoringDebounce = null;
const FEED_SCORE_DEBOUNCE_MS = 30 * 1000;       // wait 30s after last crawl event
const FEED_SCORE_HEARTBEAT_MS = 5 * 60 * 1000;  // run every 5min while app open
const FEED_SCORE_HOURS_MAX = 3;
const FEED_SCORE_BATCH_LIMIT = 60;

function syncScorerConfig() {
  if (!settings) return;
  const ollama = settings.get('ollama') || {};
  setScorerConfig({
    baseUrl:     ollama.baseUrl  || 'http://localhost:11434',
    textModel:   ollama.scoreModel  || 'llama3:latest',
    visionUrl:   ollama.visionUrl   || ollama.baseUrl || null,
    visionModel: ollama.visionModel || 'qwen2.5vl:7b',
    enableVision: ollama.enableVision !== false,
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
  const t0 = Date.now();
  emitFeedProgress({ phase: 'start', source });
  try {
    const r = await scoreUnscoredFeed({
      hoursMax,
      limit,
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
const LIST_MAX_SCROLLS = 25;
const LIST_SCROLL_INTERVAL_MS = 3500;
const LIST_STOP_GRACE_MS = 2000;  // ignore Stop within N ms of Open (debounce accidental double-click)

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

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
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
  win.addBrowserView(crawlView);  // bottom layer
  win.addBrowserView(twitterView); // top layer
  resizeTwitterView();
  twitterView.webContents.loadURL('https://x.com/home');
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
      if (win && !win.isDestroyed() && twitterView && crawlView) {
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
  ipcMain.on('get-settings', () => {
    win.webContents.send('settings-loaded', settings.get());
  });

  ipcMain.on('save-settings', (event, newSettings) => {
    const prevDb = JSON.stringify(settings.get('database'));
    const success = settings.update(newSettings);
    llmClient = null; // Reset client to pick up new settings
    // If DB config changed, reconfigure the pool
    if (JSON.stringify(settings.get('database')) !== prevDb) {
      db.configure(settings.get('database'));
    }
    win.webContents.send('settings-saved', success);
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
  // Reload Twitter View
  // ==================
  ipcMain.on('reload-twitter-view', () => {
    twitterView.webContents.reload();
  });

  // ==================
  // Get Current URL
  // ==================
  ipcMain.on('get-current-url', () => {
    const url = twitterView.webContents.getURL();
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
          listSlug: pagePath === 'list' ? activeListSlug : null,
        });
      }
      // Also intercept Followers/Following when list fetch is active
      if (fetchingList && (url.includes('/Followers') || url.includes('/Following'))) {
        const listType = url.includes('/Followers') ? 'follower' : 'following';
        listRequestMap.set(params.requestId, { url, listType });
      }
      return;
    }

    if (method === 'Network.loadingFinished') {
      // Handle followers/following list interception
      const listInfo = listRequestMap.get(params.requestId);
      if (listInfo) {
        listRequestMap.delete(params.requestId);
        try {
          const response = await twitterView.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const json = JSON.parse(response.body);
          const { extractFollowerFromGraphQL } = require('./lib/twitter/extractors');
          const { CRAWL_ENTRY_PATHS } = require('./lib/twitter/constants');
          const key = listInfo.listType === 'follower' ? 'Followers' : 'Following';
          const instructions = CRAWL_ENTRY_PATHS[key]?.(json.data || json);
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
            // Log top-level keys so we can fix the path if wrong
            const data = json.data || json;
            console.log(`[ListFetch] ${key}: no instructions found. Top-level keys:`, Object.keys(data));
          }
        } catch (_) {}
        return;
      }

      const requestInfo = requestMap.get(params.requestId);
      if (!requestInfo) return;

      requestMap.delete(params.requestId);

      try {
        const response = await twitterView.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const jsonResponse = JSON.parse(response.body);

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
        const before = crawler.capturedTweets.length;
        crawler.ingestResponse(info.endpointType, data);
        console.log(`[CrawlView] ${info.endpointType}: +${crawler.capturedTweets.length - before} tweets (total ${crawler.capturedTweets.length})`);
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
    }
  }

  async function scrollListOnce() {
    if (!activeListSlug) return;
    listScrollCount++;
    try {
      await twitterView.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x: 400, y: 400, xDistance: 0, yDistance: -3000, speed: 800,
      });
    } catch (_) {
      try {
        await twitterView.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
      } catch (_2) {}
    }
    console.log(`[ListCrawl] ${activeListSlug}: scroll ${listScrollCount}/${LIST_MAX_SCROLLS} (captured ${listCapturedThisRun} so far)`);
    if (listScrollCount >= LIST_MAX_SCROLLS) {
      stopListCrawl('done');
      return;
    }
    listScrollTimer = setTimeout(scrollListOnce, LIST_SCROLL_INTERVAL_MS);
  }

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
    if (activeListSlug) stopListCrawl('stopped');
    activeListSlug = slug;
    listScrollCount = 0;
    listCapturedThisRun = 0;
    listOpenedAt = Date.now();
    const url = `https://x.com/i/lists/${listId}`;
    console.log(`[ListCrawl] starting ${slug} -> ${url}`);
    event.sender.send('list-crawl-status', { slug, status: 'started', message: `Loading ${slug}...` });
    try {
      await twitterView.webContents.loadURL(url);
    } catch (err) {
      console.error('[ListCrawl] navigate failed:', err.message);
      event.sender.send('list-crawl-status', { slug, status: 'error', message: err.message });
      stopListCrawl('error');
      return;
    }
    // First scroll after initial load + render
    listScrollTimer = setTimeout(scrollListOnce, LIST_SCROLL_INTERVAL_MS * 2);
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
    const list = Array.isArray(slugs) && slugs.length
      ? slugs
      : ['anchors', 'venues', 'mutuals-rising', 'high-velocity-replies', 'growth-study'];
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

  win.on('resize', resizeTwitterView);
}

function resizeTwitterView() {
  const bounds = win.getBounds();
  const mobileWidth = 375;
  const normalSidebarWidth = 320;

  const twitterWidth = focusMode ? mobileWidth : bounds.width - normalSidebarWidth;
  twitterView.setBounds({ x: 0, y: 0, width: twitterWidth, height: bounds.height });
  // crawlView gets same space so it has a real rendered viewport under twitterView
  if (crawlView) {
    crawlView.setBounds({ x: 0, y: 0, width: twitterWidth, height: bounds.height });
    // Respect crawler state: don't yank crawlView out from under it during resize.
    const top = crawler && crawler.state === 'crawling' ? crawlView : twitterView;
    win.setTopBrowserView(top);
  }
}

app.whenReady().then(async () => {
  settings = new Settings();
  db.configure(settings.get('database'));
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
