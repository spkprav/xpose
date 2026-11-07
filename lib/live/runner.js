const { extractLivePayload, operationFromUrl } = require('./extract');
const { extractGraphPage, normalizeHandle } = require('./graph');
const { tweetRecord, bucketFor } = require('./person');
const { webhookConfigured, notifyPass } = require('./neon-sync');

const PEOPLE_PER_PASS = 5;

const INTERVAL_CHOICES_MIN = [30, 60, 120, 240, 480];
const DEFAULT_INTERVAL_MIN = 120;
// One count is one swipe of about two thirds of the screen, then a short gap
// so the next posts can load. Not a full-page jump, and not a tiny crawl.
const HOME_SCROLLS = 6;
const EXPLORE_SCROLLS = 4;
const NEWS_SCROLLS = 3;
const CONNECT_SCROLLS = 2;
const PEOPLE_PAGE_SCROLLS = 1;
const LIST_SCROLLS = 3;
// Cards are already on screen before this. Long enough for the first body.
const PAGE_SETTLE_MS = 4000;
const SCROLL_MIN_FRAC = 0.55;
const SCROLL_MAX_FRAC = 0.75;
const SCROLL_GAP_MIN = 1800;
const SCROLL_GAP_MAX = 3500;
const LEAVE_MIN_MS = 1200;
const LEAVE_MAX_MS = 2800;
const LEAVE_QUIET_MIN_MS = 600;
const LEAVE_QUIET_MAX_MS = 1500;
const PAGE_QUIET_MS = 15000;
const PAGE_READY_TIMEOUT_MS = 50000;
const DRAIN_MS = 3000;
const BUSY_RETRY_MS = 30 * 1000;
const LOG_LIMIT = 40;
const RECENT_LIMIT = 12;
// Followers and following are walked one screen at a time, with long gaps,
// so the pass does not look like a bot. A list that does not reach the end
// stays open: missing names are not recorded as unfollows.
const GRAPH_BEFORE_MS = 20000;
const GRAPH_BETWEEN_MS = 25000;
const GRAPH_GAP_MIN = 9000;
const GRAPH_GAP_MAX = 15000;
const GRAPH_PAUSE_EVERY = 7;
const GRAPH_PAUSE_MIN = 12000;
const GRAPH_PAUSE_MAX = 22000;
const GRAPH_IDLE_STREAK = 4;
const GRAPH_MAX_SCROLLS = 600;
const GRAPH_ECHO_MS = 2500;

function emptyCounts() {
  return { tweets: 0, people: 0, news: 0, trends: 0 };
}

function signalWeight(signal) {
  const payload = signal?.payload || {};
  return String(signal?.detail || '').length
    + String(payload.hook || '').length
    + (payload.post_count ? 30 : 0)
    + (Array.isArray(payload.grouped) ? payload.grouped.length : 0)
    + (Array.isArray(payload.social_proof) ? payload.social_proof.length : 0);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function intervalMsFromMinutes(minutes) {
  const n = Number(minutes);
  const picked = INTERVAL_CHOICES_MIN.includes(n) ? n : DEFAULT_INTERVAL_MIN;
  return picked * 60 * 1000;
}

function intervalLabel(ms) {
  const min = Math.round(ms / 60000);
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

class LiveRunner {
  constructor({ getView, db, isBusy, getPlatform, emit, persistRunning, persistInterval, persistTrackFollows, intervalMinutes, trackFollows, syncNeon, getScreenName, getLists }) {
    this.getView = getView;
    this.db = db;
    this.isBusy = isBusy || (() => false);
    this.getPlatform = getPlatform || (() => 'x');
    this.getScreenName = getScreenName || (() => '');
    this.getLists = getLists || (() => []);
    this.emit = emit || (() => {});
    this.persistRunning = persistRunning || (() => {});
    this.persistInterval = persistInterval || (() => {});
    this.persistTrackFollows = persistTrackFollows || (() => {});
    this.trackFollows = trackFollows === true;
    this.syncNeon = syncNeon || (options => notifyPass(options));
    this._syncing = false;
    this.intervalMs = intervalMsFromMinutes(intervalMinutes);

    this.running = false;
    this.phase = 'off';
    this.cycle = 0;
    this.gen = 0;
    this.nextAt = 0;
    this.timer = null;
    this.powerBlockerId = null;
    this.lastError = null;
    this.counts = emptyCounts();
    this.phaseCounts = emptyCounts();
    this.phaseResponses = 0;
    this.phaseFailed = 0;
    this.phaseOps = [];
    this.phaseError = '';
    this.lastBodyError = '';
    this.pageHook = false;
    this.people = new Set();
    this.phasePeople = [];
    this.enrichedPeople = new Set();
    this.personLocks = new Map();
    this.phaseProfiles = 0;
    this.seenTweetIds = new Set();
    // kind:item_key -> how much detail we already stored this session.
    this.seenSignals = new Map();
    this.seenPayloads = [];
    this.inflight = 0;
    this.log = [];
    this.recent = [];
    this._emitTimer = null;
    this.phaseNote = '';
    this.phaseSkip = false;
    this.listSlug = '';
    this.listWatch = null;
    this.graphUsers = new Map();
    this.graphWatch = null;
    this.graphTotals = { follower: null, following: null };
    this.graphSelf = '';
    this.graphHeader = null;
    this.graphSawList = false;
    this.graphCursorStuck = false;
    this.graphPageKey = '';
    this.graphPageAt = 0;
    this.graphAbort = '';
  }

  _resetPhaseStats() {
    this.phaseCounts = emptyCounts();
    this.phaseResponses = 0;
    this.phaseFailed = 0;
    this.phaseOps = [];
    this.phaseError = '';
    this.lastBodyError = '';
    this.phasePeople = [];
    this.phaseProfiles = 0;
    this.phaseNote = '';
    this.phaseSkip = false;
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      cycle: this.cycle,
      intervalMinutes: this.intervalMs / 60000,
      nextAt: this.nextAt || null,
      lastError: this.lastError,
      syncing: !!this._syncing,
      trackFollows: this.trackFollows === true,
      counts: { ...this.counts },
      graph: this.graphWatch,
      graphTotals: { ...this.graphTotals },
      list: this.listWatch,
      log: this.log.slice(-LOG_LIMIT),
      recent: this.recent.slice(-RECENT_LIMIT),
    };
  }

  emitNow() {
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    try { this.emit(this.snapshot()); } catch (_) {}
  }

  scheduleEmit() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => this.emitNow(), 400);
  }

  pushLog(text) {
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.log.push({ t: stamp, text });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    console.log(`[Live] ${text}`);
  }

  alive(gen) {
    return this.running && this.gen === gen;
  }

  async start() {
    if (this.running) {
      this.emitNow();
      return;
    }
    this.running = true;
    this.lastError = null;
    this.phase = 'idle';
    this.nextAt = 0;
    this.emitNow();
    try {
      await this.db.ensureLiveTables();
    } catch (err) {
      this.running = false;
      this.phase = 'off';
      this.lastError = `database: ${err.message}`;
      this.emitNow();
      console.error('[Live] start failed:', err.message);
      return;
    }
    if (!this.running) return;
    try {
      this.graphTotals = await this.db.latestGraphTotals();
    } catch (err) {
      console.error('[Live] graph totals:', err.message);
    }
    if (!this.running) return;

    this.persistRunning(true);
    this._holdPower();
    this.pushLog('on. first pass starting');
    this.emitNow();
    this._arm(1500);
  }

  stop() {
    if (!this.running && this.phase === 'off') {
      this.emitNow();
      return;
    }
    this.running = false;
    this.gen += 1;
    this.phase = 'off';
    this.nextAt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._releasePower();
    if (this._syncAbort) this._syncAbort.abort();
    this.persistRunning(false);
    this.pushLog('off');
    this.emitNow();
  }

  // One entry for both the page fetch hook and the CDP body. Same payload
  // arriving twice counts once.
  accept(url, bodyText) {
    if (!this.running || !bodyText) return;
    const key = `${operationFromUrl(url)}:${bodyText.length}:${bodyText.slice(0, 80)}`;
    if (this.seenPayloads.includes(key)) return;
    this.seenPayloads.push(key);
    if (this.seenPayloads.length > 200) this.seenPayloads.splice(0, this.seenPayloads.length - 200);

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      this.phaseFailed += 1;
      if (!this.phaseError) this.phaseError = `${operationFromUrl(url)} was not json`;
      this.scheduleEmit();
      return;
    }
    this._noteOp(url);
    this.ingest(json, url).catch(err => console.error('[Live] ingest error:', err.message));
  }

  _noteOp(url) {
    const op = operationFromUrl(url);
    this.phaseResponses += 1;
    if (op && !this.phaseOps.includes(op) && this.phaseOps.length < 6) this.phaseOps.push(op);
  }

  // Network body from the visible X view. Safe to call for every GraphQL
  // response while play is on, including ones the user scrolled into by hand.
  async ingest(json, url) {
    this.inflight += 1;
    try {
      await this._ingest(json, url);
    } finally {
      this.inflight -= 1;
    }
  }

  async _ingest(json, url) {
    if (!this.running) return;
    const gqlError = json?.errors?.[0]?.message;
    if (gqlError && !json?.data && !this.phaseError) {
      this.phaseError = String(gqlError).slice(0, 140);
    }
    const phase = (this.phase === 'idle' || this.phase === 'waiting' || this.phase === 'off')
      ? 'passive'
      : this.phase;
    if (phase === 'followers' || phase === 'following') {
      try {
        const page = extractGraphPage(json, url);
        const want = phase === 'following' ? 'following' : 'follower';
        if (page.relation === want) this._noteGraphPage(page);
      } catch (err) {
        console.error('[Live] graph extract:', err.message);
      }
    }
    let extracted;
    try {
      extracted = extractLivePayload(json, { phase });
    } catch (err) {
      console.error('[Live] extract error:', err.message);
      return;
    }

    for (const signal of extracted.signals) {
      if (signal.kind !== 'who_to_follow') continue;
      try {
        await this._savePerson(signal);
      } catch (err) {
        console.error('[Live] person save:', err.message);
      }
    }

    for (const tweet of extracted.tweets) {
      const id = String(tweet.tweet.id);
      if (this.seenTweetIds.has(id)) continue;
      this.seenTweetIds.add(id);
      tweet.source = `live-${phase}`;
      const record = tweetRecord(tweet);
      try {
        await this.db.saveTweet(tweet, url);
        this.counts.tweets += 1;
        this.phaseCounts.tweets += 1;
        if (record) {
          await this.db.upsertLiveSignal({
            kind: 'tweet',
            item_key: record.id,
            title: `@${record.screen_name}`,
            detail: record.text,
            url: record.url,
            payload: record,
          });
          this._rememberRecent('tweet', `@${record.screen_name}`, record.text);
          const handle = record.screen_name.toLowerCase();
          if (this.people.has(handle)) {
            await this._withPerson(handle, () => (
              this.db.attachPersonTweet(handle, bucketFor(url, record), record)
            ));
          }
        }
      } catch (err) {
        this.seenTweetIds.delete(id);
        if (!this.phaseError) this.phaseError = `save failed: ${err.message}`;
        console.error('[Live] tweet save:', err.message);
      }
    }

    for (const signal of extracted.signals) {
      if (signal.kind === 'who_to_follow') continue;
      const key = `${signal.kind}:${signal.item_key}`;
      const weight = signalWeight(signal);
      const prevWeight = this.seenSignals.get(key);
      // A later body can carry the hook the first card did not. Skip only
      // when this copy is no richer than what we already saved.
      if (prevWeight != null && prevWeight >= weight) continue;
      try {
        const inserted = await this.db.upsertLiveSignal(signal);
        this.seenSignals.set(key, Math.max(prevWeight || 0, weight));
        if (!inserted) continue;
        const bucket = signal.kind === 'news' ? 'news' : 'trends';
        this.counts[bucket] += 1;
        this.phaseCounts[bucket] += 1;
        this._rememberRecent(signal.kind, signal.title, signal.detail || '');
      } catch (err) {
        console.error('[Live] signal save:', err.message);
      }
    }

    const op = operationFromUrl(url);
    if (
      !extracted.tweets.length
      && !extracted.signals.length
      && /timeline|explore|search|guide|tweet/i.test(op)
    ) {
      if (!this.phaseError) this.phaseError = `${op} had no tweets`;
    }
    this.scheduleEmit();
  }

  _arm(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._cycle().catch(err => {
        console.error('[Live] cycle error:', err.message);
        this.lastError = err.message;
        this.pushLog(`pass failed: ${err.message}`);
        this.phase = 'idle';
        this.nextAt = Date.now() + this.intervalMs;
        this.emitNow();
        if (this.running) this._arm(this.intervalMs);
      });
    }, delayMs);
  }

  _holdPower() {
    if (this.powerBlockerId != null) return;
    try {
      const { powerSaveBlocker } = require('electron');
      this.powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch (_) {}
  }

  _releasePower() {
    if (this.powerBlockerId == null) return;
    try {
      const { powerSaveBlocker } = require('electron');
      powerSaveBlocker.stop(this.powerBlockerId);
    } catch (_) {}
    this.powerBlockerId = null;
  }

  async _cycle() {
    if (!this.running) return;
    const gen = this.gen;

    if (this.getPlatform() !== 'x' || this.isBusy()) {
      const why = this.getPlatform() !== 'x'
        ? 'waiting: LinkedIn is in front'
        : 'waiting: another crawl owns the view';
      this.phase = 'waiting';
      this.nextAt = Date.now() + BUSY_RETRY_MS;
      this.pushLog(why);
      this.emitNow();
      if (this.alive(gen)) this._arm(BUSY_RETRY_MS);
      return;
    }

    this.cycle += 1;
    this.lastError = null;
    this.nextAt = 0;
    this.pushLog(`pass ${this.cycle}`);
    this.emitNow();

    const steps = [
      ['home', async () => {
        await this._go(gen, 'https://x.com/home');
      }],
      ['scroll', async () => {
        await this._scrolls(gen, HOME_SCROLLS);
      }],
      ['who-to-follow', async () => {
        await this._go(gen, 'https://x.com/i/connect_people');
        await this._scrolls(gen, CONNECT_SCROLLS);
        await this._drainInflight(gen);
        await this._enrichPeople(gen);
      }],
      ['explore', async () => {
        await this._go(gen, 'https://x.com/explore');
        await this._scrolls(gen, EXPLORE_SCROLLS);
      }],
      ['news', async () => {
        await this._go(gen, 'https://x.com/explore/tabs/news');
        await this._scrolls(gen, NEWS_SCROLLS);
      }],
      ['lists', async () => {
        await this._scanLists(gen);
      }],
      ['followers', async () => {
        await this._scanGraph(gen, 'follower');
      }],
      ['following', async () => {
        await this._scanGraph(gen, 'following');
      }],
    ];

    for (const [phase, fn] of steps) {
      if (!this.alive(gen)) return;
      if (this.getPlatform() !== 'x' || this.isBusy()) {
        this.phase = 'waiting';
        this.nextAt = Date.now() + BUSY_RETRY_MS;
        this.pushLog('paused mid-pass, view is busy');
        this.emitNow();
        this._arm(BUSY_RETRY_MS);
        return;
      }
      if ((phase === 'followers' || phase === 'following') && !this.trackFollows) continue;
      this.phase = phase;
      this._resetPhaseStats();
      this.emitNow();
      try {
        await fn();
        await this._wait(gen, DRAIN_MS);
        await this._drainInflight(gen);
      } catch (err) {
        if (!this.alive(gen)) return;
        this.pushLog(`${phase} failed: ${err.message}`);
        continue;
      }
      if (!this.alive(gen) || this.phaseSkip) continue;
      this.pushLog(this._phaseLine(phase));
      this.emitNow();
    }

    if (!this.alive(gen)) return;
    await this._notifyCheck(gen);
    if (!this.alive(gen)) return;
    this.phase = 'idle';
    this.nextAt = Date.now() + this.intervalMs;
    this.pushLog(`idle for ${intervalLabel(this.intervalMs)}`);
    this.emitNow();
    this._arm(this.intervalMs);
  }

  syncNow() {
    return this._notifyCheck(this.gen, { manual: true });
  }

  async _notifyCheck(gen, { manual = false } = {}) {
    if (this._syncing) {
      this.pushLog('check: already running');
      return;
    }
    if (!webhookConfigured()) {
      if (manual) this.pushLog('check: webhook is not set');
      return;
    }
    const previousPhase = this.phase;
    const abort = new AbortController();
    const stopped = () => abort.signal.aborted || (manual ? this.gen !== gen : !this.alive(gen));
    this._syncing = true;
    this._syncAbort = abort;
    this.phase = 'check';
    this.pushLog('check: pinging');
    this.emitNow();
    try {
      const result = await this.syncNeon({ signal: abort.signal });
      if (stopped()) return;
      if (result && result.skipped) {
        this.pushLog('check: webhook is not set');
        return;
      }
      if (result && result.ok) {
        this.lastError = null;
        this.pushLog('check: triggered');
      } else {
        const message = (result && result.error) || `status ${(result && result.status) || 'none'}`;
        console.error(`[Live] check: ${message}`);
        this.lastError = `check: ${message}`;
        this.pushLog(`check: failed: ${message}`);
      }
    } catch (err) {
      if (stopped()) return;
      const message = err && err.message ? err.message : String(err);
      console.error(`[Live] check: ${message}`);
      this.lastError = `check: ${message}`;
      this.pushLog(`check: failed: ${message}`);
    } finally {
      if (this._syncAbort === abort) this._syncAbort = null;
      this._syncing = false;
      if (this.phase === 'check') {
        this.phase = manual ? previousPhase : (this.running ? 'idle' : 'off');
      }
      this.emitNow();
    }
  }

  // Gap between passes. A change during a pass applies when that pass ends.
  // A change while idle restarts the wait from now.
  setIntervalMinutes(minutes) {
    const ms = intervalMsFromMinutes(minutes);
    if (ms === this.intervalMs) {
      this.emitNow();
      return;
    }
    this.intervalMs = ms;
    this.persistInterval(ms / 60000);
    if (this.running && this.phase === 'idle' && this.nextAt) {
      this.nextAt = Date.now() + ms;
      this._arm(ms);
      this.pushLog(`gap set to ${intervalLabel(ms)}`);
    }
    this.emitNow();
  }

  setTrackFollows(on) {
    const next = !!on;
    if (next === this.trackFollows) {
      this.emitNow();
      return;
    }
    this.trackFollows = next;
    this.persistTrackFollows(next);
    this.pushLog(next ? 'followers and following on' : 'followers and following off');
    this.emitNow();
  }

  _phaseLine(phase) {
    if (this.phaseNote && (phase === 'followers' || phase === 'following')) {
      const extra = this.phaseError ? `, ${this.phaseError}` : '';
      return `${phase}: ${this.phaseNote}${extra}`;
    }
    const c = this.phaseCounts;
    if (!this.phaseResponses && !this.phaseFailed) {
      const why = this.lastBodyError ? `, body error: ${this.lastBodyError}` : '';
      const note = this.phaseNote ? `, ${this.phaseNote}` : '';
      return `${phase}: 0 network responses${why}${note}`;
    }
    const bits = [`${this.phaseResponses} responses`];
    if (this.phaseFailed) bits.push(`${this.phaseFailed} unreadable`);
    if (this.phaseOps.length) bits.push(this.phaseOps.join(', '));
    const got = [];
    if (c.tweets) got.push(`${c.tweets} tweets`);
    if (c.people) got.push(`${c.people} people`);
    if (c.news) got.push(`${c.news} news`);
    if (c.trends) got.push(`${c.trends} trends`);
    bits.push(got.length ? got.join(', ') : (this.phaseResponses ? '0 new tweets' : '0 tweets'));
    if (this.phaseProfiles) bits.push(`${this.phaseProfiles} profiles opened`);
    if (this.phaseNote) bits.push(this.phaseNote);
    if (this.phaseError) bits.push(this.phaseError);
    return `${phase}: ${bits.join(', ')}`;
  }

  async _drainInflight(gen) {
    const start = Date.now();
    while (this.alive(gen) && this.inflight > 0 && Date.now() - start < 15000) {
      await sleep(100);
    }
  }

  async _wait(gen, ms) {
    const step = 250;
    let left = ms;
    while (left > 0) {
      if (!this.alive(gen)) return;
      const slice = Math.min(step, left);
      await sleep(slice);
      left -= slice;
    }
  }

  _view(gen) {
    if (!this.alive(gen)) return null;
    const view = this.getView();
    if (!view || view.webContents.isDestroyed()) throw new Error('X view is gone');
    return view;
  }

  // Document load is not enough on a Pi. X keeps a blank column while the
  // bundle boots. Scroll only after a card is on screen, then a settle beat
  // so the GraphQL body has time to arrive.
  async _waitForContent(gen, url) {
    const start = Date.now();
    let quietSince = 0;
    while (this.alive(gen) && Date.now() - start < PAGE_READY_TIMEOUT_MS) {
      let view;
      try { view = this._view(gen); } catch { return; }
      if (!view) return;
      const wc = view.webContents;
      const loading = typeof wc.isLoadingMainFrame === 'function'
        ? wc.isLoadingMainFrame()
        : wc.isLoading();
      if (loading) {
        quietSince = 0;
        await this._wait(gen, 1000);
        continue;
      }
      if (!quietSince) quietSince = Date.now();
      let ready = false;
      try {
        ready = await wc.executeJavaScript(`(() => {
          if (document.readyState !== 'complete') return false;
          return !!(
            document.querySelector('article')
            || document.querySelector('[data-testid="UserCell"]')
            || document.querySelector('[data-testid="trend"]')
          );
        })()`);
      } catch (_) {
        ready = false;
      }
      if (ready) return;
      if (Date.now() - quietSince >= PAGE_QUIET_MS) {
        console.log('[Live] no cards yet, continuing', url || '');
        return;
      }
      await this._wait(gen, 1000);
    }
    console.log('[Live] page wait timed out', url || '');
  }

  async _settle(gen, url) {
    await this._waitForContent(gen, url);
    await this._wait(gen, PAGE_SETTLE_MS);
  }

  async _go(gen, url, { quiet = false, beforeLoad } = {}) {
    if (!this._view(gen)) return;
    // Stay on the page a moment before clicking away. Quiet hops are the
    // profile, replies, and highlights of one person, so the pause is shorter.
    const leave = quiet
      ? jitter(LEAVE_QUIET_MIN_MS, LEAVE_QUIET_MAX_MS)
      : jitter(LEAVE_MIN_MS, LEAVE_MAX_MS);
    await this._wait(gen, leave);
    if (!this.alive(gen)) return;
    if (beforeLoad) beforeLoad();
    const view = this._view(gen);
    if (!view) return;
    console.log('[Live] navigate', url);
    await view.webContents.loadURL(url);
    await this._settle(gen, url);
    if (quiet) return;
    const landed = view.webContents.getURL() || '';
    let wanted = '';
    try { wanted = new URL(url).pathname; } catch { wanted = ''; }
    if (wanted && landed && !landed.includes(wanted)) {
      this.phaseError = `opened ${landed.replace(/^https?:\/\/(www\.)?x\.com/, '') || landed}`;
    }
  }

  _rememberRecent(kind, title, detail) {
    this.recent.push({ kind, title: title || '', detail: detail || '' });
    if (this.recent.length > RECENT_LIMIT) {
      this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    }
  }

  _withPerson(handle, fn) {
    const key = String(handle || '').toLowerCase();
    if (!key) return fn();
    const prev = this.personLocks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    this.personLocks.set(key, run.catch(() => {}));
    return run;
  }

  async _savePerson(signal) {
    const handle = String(signal.item_key || '').toLowerCase();
    if (!handle) return;
    const first = !this.people.has(handle);
    this.people.add(handle);
    if (this.phase === 'who-to-follow' && !this.enrichedPeople.has(handle) && !this.phasePeople.includes(handle)) {
      this.phasePeople.push(handle);
    }
    await this._withPerson(handle, () => this.db.upsertLiveSignal(signal));
    if (!first) return;
    this.counts.people += 1;
    this.phaseCounts.people += 1;
    this._rememberRecent('who_to_follow', signal.title, signal.detail || signal.payload?.bio || '');
  }

  // Lists saved on the Lists tab. One page at a time, three swipes,
  // then the next. Empty ids are skipped. The same id is opened once.
  async _configuredLists() {
    const raw = typeof this.getLists === 'function' ? await this.getLists() : [];
    const out = [];
    const seen = new Set();
    for (const item of raw || []) {
      const slug = String(item?.slug || '').trim();
      const id = String(item?.id || '').trim();
      if (!slug || !/^\d{2,22}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ slug, id });
    }
    return out;
  }

  async _scanLists(gen) {
    const lists = await this._configuredLists();
    if (!lists.length) {
      this.phaseNote = 'no lists in the database';
      return;
    }
    let opened = 0;
    this.pushLog(`opening ${lists.length} lists`);
    try {
      for (let i = 0; i < lists.length; i++) {
        if (!this.alive(gen)) return;
        if (this.getPlatform() !== 'x' || this.isBusy()) {
          this.phaseNote = `paused after ${opened} of ${lists.length} lists`;
          return;
        }
        const { slug, id } = lists[i];
        this.listWatch = { slug, index: i + 1, total: lists.length };
        this.emitNow();
        try {
          // Tag the list only once the address changes, so a late response
          // from the previous page keeps the previous slug.
          await this._go(gen, `https://x.com/i/lists/${id}`, {
            beforeLoad: () => { this.listSlug = slug; },
          });
          if (!this.alive(gen)) return;
          await this._scrolls(gen, LIST_SCROLLS);
          await this._drainInflight(gen);
          opened += 1;
        } catch (err) {
          if (!this.alive(gen)) return;
          this.pushLog(`${slug} failed: ${err.message}`);
        }
      }
    } finally {
      this.listSlug = '';
      this.listWatch = null;
    }
    this.phaseNote = opened === lists.length
      ? `${opened} lists, 3 scrolls each`
      : `${opened} of ${lists.length} lists`;
  }

  // Open each new suggestion's profile, replies, and highlights so the row
  // picks up bio, link, counts, and the posts themselves.
  async _enrichPeople(gen) {
    const queue = this.phasePeople.filter(handle => !this.enrichedPeople.has(handle)).slice(0, PEOPLE_PER_PASS);
    for (const handle of queue) {
      if (!this.alive(gen)) return;
      this.enrichedPeople.add(handle);
      const pages = [
        `https://x.com/${handle}`,
        `https://x.com/${handle}/with_replies`,
        `https://x.com/${handle}/highlights`,
      ];
      try {
        for (const page of pages) {
          if (!this.alive(gen)) return;
          await this._go(gen, page, { quiet: true });
          if (!page.endsWith('/highlights')) await this._scrolls(gen, PEOPLE_PAGE_SCROLLS);
          await this._drainInflight(gen);
        }
        this.phaseProfiles += 1;
      } catch (err) {
        this.pushLog(`@${handle} profile failed: ${err.message}`);
      }
    }
  }

  // X scrolls the timeline column, not the window. window.scrollBy leaves
  // the feed still and the next request never fires.
  async _swipe(gen) {
    const view = this._view(gen);
    if (!view) return;
    const frac = (SCROLL_MIN_FRAC + Math.random() * (SCROLL_MAX_FRAC - SCROLL_MIN_FRAC)).toFixed(3);
    let moved = false;
    try {
      moved = await view.webContents.executeJavaScript(`(() => {
        const root = document.scrollingElement || document.documentElement;
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        let target = root;
        let room = (root.scrollHeight || 0) - (root.clientHeight || 0);
        const pool = primary ? [primary, ...primary.querySelectorAll('div')] : [];
        for (const node of pool) {
          const space = node.scrollHeight - node.clientHeight;
          if (space > room + 40) {
            room = space;
            target = node;
          }
        }
        const dist = Math.max(420, Math.min(860, Math.round((target.clientHeight || window.innerHeight || 800) * ${frac})));
        const before = target.scrollTop || 0;
        const bottom = Math.max(0, target.scrollHeight - target.clientHeight);
        target.scrollTop = Math.min(before + dist, bottom);
        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        return (target.scrollTop || 0) > before + 24;
      })()`);
    } catch (_) {}
    if (moved) return;
    let bounds = { width: 800, height: 800 };
    try { bounds = view.getBounds(); } catch (_) {}
    try {
      await view.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x: Math.max(180, Math.min(520, Math.floor((bounds.width || 800) * 0.45))),
        y: Math.max(220, Math.min(640, Math.floor((bounds.height || 800) * 0.45))),
        xDistance: 0,
        yDistance: -(520 + Math.floor(Math.random() * 220)),
        speed: 700 + Math.floor(Math.random() * 200),
      });
    } catch (_) {}
  }

  async _scrolls(gen, count) {
    await this._waitForContent(gen);
    for (let i = 0; i < count; i++) {
      if (!this.alive(gen)) return;
      if (!this._view(gen)) return;
      await this._swipe(gen);
      await this._wait(gen, jitter(SCROLL_GAP_MIN, SCROLL_GAP_MAX));
    }
  }

  _resetGraphScan(handle) {
    this.graphUsers = new Map();
    this.graphSelf = normalizeHandle(handle);
    this.graphHeader = null;
    this.graphSawList = false;
    this.graphCursorStuck = false;
    this.graphPageKey = '';
    this.graphPageAt = 0;
    this.graphAbort = '';
    this.graphWatch = null;
  }

  _noteGraphUsers(users) {
    let added = 0;
    for (const user of users || []) {
      const screen = normalizeHandle(user.screen_name);
      if (!screen || screen === this.graphSelf) continue;
      const prev = this.graphUsers.get(screen);
      if (!prev) {
        this.graphUsers.set(screen, {
          screen_name: screen,
          user_id: user.user_id || null,
          display_name: user.display_name || null,
          followers_count: user.followers_count || 0,
          following_count: user.following_count || 0,
        });
        added += 1;
        continue;
      }
      if (!prev.user_id && user.user_id) prev.user_id = user.user_id;
      if (!prev.display_name && user.display_name) prev.display_name = user.display_name;
      if (user.followers_count > 0) prev.followers_count = user.followers_count;
      if (user.following_count > 0) prev.following_count = user.following_count;
    }
    return added;
  }

  // Same body can arrive from the page hook and from CDP a moment apart.
  // A repeat after the scroll gap means X returned the page again, which is the end.
  _noteGraphPage(page) {
    if (!page?.isList) return;
    const ids = (page.users || []).map(user => user.user_id || user.screen_name).join(',');
    const key = `${page.bottomCursor || ''}|${page.hasBottomCursor ? 1 : 0}|${ids}`;
    const now = Date.now();
    if (key === this.graphPageKey && now - this.graphPageAt < GRAPH_ECHO_MS) return;
    const repeat = key === this.graphPageKey;
    this.graphPageKey = key;
    this.graphPageAt = now;
    this.graphSawList = true;
    this._noteGraphUsers(page.users);
    if (repeat || !page.hasBottomCursor) this.graphCursorStuck = true;
    else this.graphCursorStuck = false;
  }

  async _ownHandle(gen) {
    const view = this._view(gen);
    if (view) {
      try {
        const fromPage = await view.webContents.executeJavaScript(`(() => {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          const href = (link && link.getAttribute('href')) || '';
          return href.split('?')[0].split('/').filter(Boolean)[0] || '';
        })()`);
        const handle = String(fromPage || '').trim();
        if (handle) return handle;
      } catch (_) {}
    }
    try {
      return String(this.getScreenName() || '').replace(/^@/, '').trim();
    } catch (_) {
      return '';
    }
  }

  async _readHeaderCount(gen, relation) {
    const view = this._view(gen);
    if (!view) return null;
    const suffix = relation === 'following' ? '/following' : '/followers';
    try {
      const value = await view.webContents.executeJavaScript(`(() => {
        const suffix = ${JSON.stringify(suffix)};
        const links = document.querySelectorAll('a[href$="' + suffix + '"]');
        for (const link of links) {
          const raw = ((link.innerText || '').trim().split(/\\s+/)[0]) || '';
          if (!/^[\\d,]+$/.test(raw)) continue;
          const n = parseInt(raw.replace(/,/g, ''), 10);
          if (Number.isFinite(n)) return n;
        }
        return null;
      })()`);
      return Number.isInteger(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  async _graphScroll(gen) {
    const view = this._view(gen);
    if (!view) return;
    const fraction = (0.58 + Math.random() * 0.2).toFixed(3);
    let moved = false;
    try {
      moved = await view.webContents.executeJavaScript(`(() => {
        const root = document.scrollingElement || document.documentElement;
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        const t = (primary && primary.scrollHeight > primary.clientHeight + 80) ? primary : root;
        const bottom = Math.max(0, t.scrollHeight - t.clientHeight);
        const before = t.scrollTop;
        const dy = Math.max(320, Math.floor((t.clientHeight || 800) * ${fraction}));
        t.scrollTop = Math.min(before + dy, bottom);
        window.dispatchEvent(new Event('scroll'));
        return t.scrollTop > before + 24;
      })()`);
    } catch (_) {}
    if (moved) return;
    let bounds = { width: 800, height: 800 };
    try { bounds = view.getBounds(); } catch (_) {}
    try {
      await view.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x: Math.max(180, Math.min(520, Math.floor((bounds.width || 800) * 0.45))),
        y: Math.max(220, Math.min(640, Math.floor((bounds.height || 800) * 0.45))),
        xDistance: 0,
        yDistance: -(420 + Math.floor(Math.random() * 280)),
        speed: 240 + Math.floor(Math.random() * 140),
      });
    } catch (_) {}
  }

  async _graphPosition(gen) {
    const view = this._view(gen);
    if (!view) return null;
    try {
      return await view.webContents.executeJavaScript(`(() => {
        const root = document.scrollingElement || document.documentElement;
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        const t = (primary && primary.scrollHeight > primary.clientHeight + 80) ? primary : root;
        const bottom = Math.max(0, t.scrollHeight - t.clientHeight);
        return {
          height: t.scrollHeight,
          atBottom: bottom <= 8 || t.scrollTop >= bottom - 12,
        };
      })()`);
    } catch (_) {
      return null;
    }
  }

  async _scrapeGraphCells(gen) {
    const view = this._view(gen);
    if (!view) return 0;
    let cells = [];
    try {
      cells = await view.webContents.executeJavaScript(`(() => {
        const out = [];
        const seen = new Set();
        for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
          const link = cell.querySelector('a[href^="/"]');
          const href = (link && link.getAttribute('href')) || '';
          const handle = href.split('?')[0].split('/').filter(Boolean)[0] || '';
          if (!handle || seen.has(handle.toLowerCase())) continue;
          seen.add(handle.toLowerCase());
          const lines = (cell.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
          const name = lines.find(line => {
            const lower = line.toLowerCase();
            return lower !== handle.toLowerCase() && lower !== '@' + handle.toLowerCase();
          }) || '';
          out.push({ screen_name: handle, display_name: name.slice(0, 100) });
        }
        return out;
      })()`);
    } catch (_) {}
    return this._noteGraphUsers(cells || []);
  }

  async _scrollGraphToEnd(gen, relation) {
    let bottomStreak = 0;
    let idleStreak = 0;
    let lastHeight = 0;
    let prevSeen = this.graphUsers.size;
    for (let i = 0; i < GRAPH_MAX_SCROLLS; i++) {
      if (!this.alive(gen)) return false;
      if (!this.trackFollows) {
        this.graphAbort = 'switch off';
        return false;
      }
      if (this.getPlatform() !== 'x' || this.isBusy()) {
        this.graphAbort = 'view is busy';
        return false;
      }
      await this._graphScroll(gen);
      const gap = GRAPH_GAP_MIN + Math.floor(Math.random() * (GRAPH_GAP_MAX - GRAPH_GAP_MIN));
      await this._wait(gen, gap);
      if (!this.alive(gen)) return false;
      if (!this.trackFollows) {
        this.graphAbort = 'switch off';
        return false;
      }
      if ((i + 1) % GRAPH_PAUSE_EVERY === 0) {
        const extra = GRAPH_PAUSE_MIN + Math.floor(Math.random() * (GRAPH_PAUSE_MAX - GRAPH_PAUSE_MIN));
        await this._wait(gen, extra);
        if (!this.alive(gen)) return false;
        if (!this.trackFollows) {
          this.graphAbort = 'switch off';
          return false;
        }
      }
      await this._drainInflight(gen);
      await this._scrapeGraphCells(gen);
      const pos = await this._graphPosition(gen);
      const seen = this.graphUsers.size;
      if (seen === prevSeen) idleStreak += 1;
      else idleStreak = 0;
      prevSeen = seen;
      const height = pos?.height || 0;
      const grew = lastHeight > 0 && height > lastHeight + 40;
      if (pos?.atBottom && !grew && lastHeight > 0) bottomStreak += 1;
      else bottomStreak = 0;
      if (height) lastHeight = height;
      this.graphWatch = { relation, seen, scroll: i + 1 };
      this.scheduleEmit();

      const header = this.graphHeader;
      if (header > 0 && seen >= header && idleStreak >= 1) return true;
      const stalled = bottomStreak >= GRAPH_IDLE_STREAK && idleStreak >= GRAPH_IDLE_STREAK;
      if (stalled && this.graphCursorStuck && this.graphSawList) return true;
    }
    return false;
  }

  _applyGraphResult(relation, result) {
    const kind = relation === 'following' ? 'following' : 'follower';
    if (result.closing) {
      this.graphTotals[kind] = result.total;
      if (result.baseline) {
        const dropped = result.removedCount ? `, dropped ${result.removedCount} partial` : '';
        this.phaseNote = `${result.total} on the first full list${dropped}`;
      } else {
        this.phaseNote = `${result.total} (+${result.addedCount}, -${result.removedCount})`;
      }
    } else {
      const why = result.reason ? `, ${result.reason}` : '';
      this.phaseNote = `${result.total} seen, list left open${why}`;
    }
    const addedDetail = kind === 'following' ? 'new follow' : 'new follower';
    const removedDetail = kind === 'following' ? 'unfollowed' : 'lost follower';
    for (const name of result.addedNames || []) {
      this._rememberRecent(kind, `@${name}`, addedDetail);
    }
    if (result.closing) {
      for (const name of result.removedNames || []) {
        this._rememberRecent(kind, `@${name}`, removedDetail);
      }
    }
    this.graphWatch = null;
  }

  // Open the signed-in account's followers or following and scroll to the end.
  async _scanGraph(gen, relation) {
    const handle = await this._ownHandle(gen);
    this._resetGraphScan(handle);
    try {
      if (!this.alive(gen)) return;
      if (!this.trackFollows) {
        this.phaseSkip = true;
        return;
      }
      if (!handle) {
        this.phaseNote = 'no signed-in profile on the page';
        return;
      }
      const path = relation === 'following' ? 'following' : 'followers';
      const pause = relation === 'following' ? GRAPH_BETWEEN_MS : GRAPH_BEFORE_MS;
      this.graphWatch = { relation, seen: 0, scroll: 0 };
      this.emitNow();
      await this._wait(gen, pause);
      if (!this.alive(gen)) return;
      if (!this.trackFollows) {
        this.phaseSkip = true;
        return;
      }
      await this._go(gen, `https://x.com/${handle}/${path}`);
      if (!this.alive(gen)) return;
      this.graphHeader = await this._readHeaderCount(gen, relation);
      await this._scrapeGraphCells(gen);
      const finished = await this._scrollGraphToEnd(gen, relation);
      if (!this.alive(gen) && !this.graphUsers.size) return;
      const lateHeader = await this._readHeaderCount(gen, relation);
      if (lateHeader != null) this.graphHeader = lateHeader;
      const result = await this.db.reconcileLiveGraph({
        relation,
        people: [...this.graphUsers.values()],
        scrollComplete: finished && this.alive(gen),
        headerCount: this.graphHeader,
      });
      if (!result.closing && !result.reason) {
        if (this.graphAbort) result.reason = this.graphAbort;
        else result.reason = this.alive(gen) ? 'reached the scroll cap' : 'stopped';
      }
      this._applyGraphResult(relation, result);
    } finally {
      this.graphWatch = null;
    }
  }
}

module.exports = LiveRunner;
