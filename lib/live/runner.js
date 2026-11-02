const { extractLivePayload } = require('./extract');

const INTERVAL_MS = 5 * 60 * 1000;
const HOME_SCROLLS = 4;
const EXPLORE_SCROLLS = 3;
const NEWS_SCROLLS = 2;
const SCROLL_GAP_MS = 2200;
const PAGE_SETTLE_MS = 5500;
const DRAIN_MS = 1200;
const BUSY_RETRY_MS = 30 * 1000;
const LOG_LIMIT = 40;
const RECENT_LIMIT = 12;

function emptyCounts() {
  return { tweets: 0, people: 0, news: 0, trends: 0 };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class LiveRunner {
  constructor({ getView, db, isBusy, getPlatform, emit, persistRunning }) {
    this.getView = getView;
    this.db = db;
    this.isBusy = isBusy || (() => false);
    this.getPlatform = getPlatform || (() => 'x');
    this.emit = emit || (() => {});
    this.persistRunning = persistRunning || (() => {});

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
    this.seenTweetIds = new Set();
    this.seenSignals = new Set();
    this.log = [];
    this.recent = [];
    this._emitTimer = null;
  }

  snapshot() {
    return {
      running: this.running,
      phase: this.phase,
      cycle: this.cycle,
      nextAt: this.nextAt || null,
      lastError: this.lastError,
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
    this.persistRunning(false);
    this.pushLog('off');
    this.emitNow();
  }

  // Network body from the visible X view. Safe to call for every GraphQL
  // response while play is on, including ones the user scrolled into by hand.
  async ingest(json, url) {
    if (!this.running) return;
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

    for (const tweet of extracted.tweets) {
      const id = String(tweet.tweet.id);
      if (this.seenTweetIds.has(id)) continue;
      this.seenTweetIds.add(id);
      tweet.source = `live-${phase}`;
      try {
        await this.db.saveTweet(tweet, url);
        this.counts.tweets += 1;
        this.phaseCounts.tweets += 1;
      } catch (err) {
        this.seenTweetIds.delete(id);
        console.error('[Live] tweet save:', err.message);
      }
    }

    for (const signal of extracted.signals) {
      const key = `${signal.kind}:${signal.item_key}`;
      if (this.seenSignals.has(key)) continue;
      this.seenSignals.add(key);
      try {
        const inserted = await this.db.upsertLiveSignal(signal);
        if (!inserted) continue;
        const bucket = signal.kind === 'who_to_follow' ? 'people'
          : signal.kind === 'news' ? 'news'
          : 'trends';
        this.counts[bucket] += 1;
        this.phaseCounts[bucket] += 1;
        this.recent.push({
          kind: signal.kind,
          title: signal.title,
          detail: signal.detail || '',
        });
        if (this.recent.length > RECENT_LIMIT) {
          this.recent.splice(0, this.recent.length - RECENT_LIMIT);
        }
      } catch (err) {
        this.seenSignals.delete(key);
        console.error('[Live] signal save:', err.message);
      }
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
        this.nextAt = Date.now() + INTERVAL_MS;
        this.emitNow();
        if (this.running) this._arm(INTERVAL_MS);
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
        await this._wait(gen, PAGE_SETTLE_MS);
      }],
      ['scroll', async () => {
        await this._scrolls(gen, HOME_SCROLLS);
      }],
      ['who-to-follow', async () => {
        await this._go(gen, 'https://x.com/i/connect_people');
        await this._wait(gen, PAGE_SETTLE_MS);
        await this._scrolls(gen, 1);
      }],
      ['explore', async () => {
        await this._go(gen, 'https://x.com/explore');
        await this._wait(gen, PAGE_SETTLE_MS);
        await this._scrolls(gen, EXPLORE_SCROLLS);
      }],
      ['news', async () => {
        const clicked = await this._clickLabel(gen, ['News']);
        if (!clicked) await this._go(gen, 'https://x.com/explore/tabs/news');
        await this._wait(gen, PAGE_SETTLE_MS);
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
      this.phaseCounts = emptyCounts();
      this.emitNow();
      try {
        await fn();
        await this._wait(gen, DRAIN_MS);
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
    this.phase = 'idle';
    this.nextAt = Date.now() + INTERVAL_MS;
    this.pushLog('idle until next pass');
    this.emitNow();
    this._arm(INTERVAL_MS);
  }

  _phaseLine(phase) {
    const c = this.phaseCounts;
    const parts = [];
    if (c.tweets) parts.push(`${c.tweets} tweets`);
    if (c.people) parts.push(`${c.people} people`);
    if (c.news) parts.push(`${c.news} news`);
    if (c.trends) parts.push(`${c.trends} trends`);
    return `${phase}: ${parts.length ? parts.join(', ') : 'nothing new'}`;
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

  async _go(gen, url) {
    const view = this._view(gen);
    if (!view) return;
    console.log('[Live] navigate', url);
    await view.webContents.loadURL(url);
  }

  async _scrolls(gen, count) {
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
