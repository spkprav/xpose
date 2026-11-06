const { extractLivePayload, operationFromUrl } = require('./extract');
const { tweetRecord, bucketFor } = require('./person');
const { webhookConfigured, notifyPass } = require('./neon-sync');

const PEOPLE_PER_PASS = 5;

const INTERVAL_CHOICES_MIN = [30, 60, 120, 240, 480];
const DEFAULT_INTERVAL_MIN = 120;
const HOME_SCROLLS = 4;
const EXPLORE_SCROLLS = 3;
const NEWS_SCROLLS = 2;
// The Pi paints X late. These waits sit after the document load, before any scroll.
const SCROLL_GAP_MS = 6000;
const PAGE_SETTLE_MS = 12000;
const PAGE_QUIET_MS = 15000;
const PAGE_READY_TIMEOUT_MS = 50000;
const DRAIN_MS = 3000;
const BUSY_RETRY_MS = 30 * 1000;
const LOG_LIMIT = 40;
const RECENT_LIMIT = 12;

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
  constructor({ getView, db, isBusy, getPlatform, emit, persistRunning, persistInterval, intervalMinutes, syncNeon }) {
    this.getView = getView;
    this.db = db;
    this.isBusy = isBusy || (() => false);
    this.getPlatform = getPlatform || (() => 'x');
    this.emit = emit || (() => {});
    this.persistRunning = persistRunning || (() => {});
    this.persistInterval = persistInterval || (() => {});
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
      counts: { ...this.counts },
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
        await this._scrolls(gen, 1);
        await this._drainInflight(gen);
        await this._enrichPeople(gen);
      }],
      ['explore', async () => {
        await this._go(gen, 'https://x.com/explore');
        await this._scrolls(gen, EXPLORE_SCROLLS);
      }],
      ['news', async () => {
        const clicked = await this._clickLabel(gen, ['News']);
        if (!clicked) await this._go(gen, 'https://x.com/explore/tabs/news');
        else await this._settle(gen, 'news-tab');
        await this._scrolls(gen, NEWS_SCROLLS);
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
      if (!this.alive(gen)) return;
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

  _phaseLine(phase) {
    const c = this.phaseCounts;
    if (!this.phaseResponses && !this.phaseFailed) {
      const why = this.lastBodyError ? `, body error: ${this.lastBodyError}` : '';
      return `${phase}: 0 network responses${why}`;
    }
    const bits = [`${this.phaseResponses} responses`];
    if (this.phaseFailed) bits.push(`${this.phaseFailed} unreadable`);
    if (this.phaseOps.length) bits.push(this.phaseOps.join(', '));
    const got = [];
    if (c.tweets) got.push(`${c.tweets} tweets`);
    if (c.people) got.push(`${c.people} people`);
    if (c.news) got.push(`${c.news} news`);
    if (c.trends) got.push(`${c.trends} trends`);
    bits.push(got.length ? got.join(', ') : '0 tweets');
    if (this.phaseProfiles) bits.push(`${this.phaseProfiles} profiles opened`);
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

  async _go(gen, url, { quiet = false } = {}) {
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
          if (!page.endsWith('/highlights')) await this._scrolls(gen, 1);
          await this._drainInflight(gen);
        }
        this.phaseProfiles += 1;
      } catch (err) {
        this.pushLog(`@${handle} profile failed: ${err.message}`);
      }
    }
  }

  async _scrolls(gen, count) {
    await this._waitForContent(gen);
    for (let i = 0; i < count; i++) {
      const view = this._view(gen);
      if (!view) return;
      await view.webContents.executeJavaScript(
        'window.scrollBy(0, Math.max(500, Math.round((window.innerHeight || 800) * 0.85)))'
      );
      await this._wait(gen, SCROLL_GAP_MS);
    }
  }

  async _clickLabel(gen, labels) {
    const view = this._view(gen);
    if (!view) return '';
    const want = JSON.stringify(labels.map(s => s.toLowerCase()));
    const clicked = await view.webContents.executeJavaScript(`
      (() => {
        const want = ${want};
        const nodes = document.querySelectorAll('a, button, [role="tab"], [role="link"]');
        for (const node of nodes) {
          const text = (node.innerText || '').trim().toLowerCase().split('\\n')[0];
          if (!text || text.length > 32) continue;
          if (want.includes(text)) {
            node.click();
            return text;
          }
        }
        return '';
      })()
    `);
    return clicked || '';
  }
}

module.exports = LiveRunner;
