// Background home tab. Reloads https://x.com/home on its own timer and writes
// whatever that plain refresh returns. It does not scroll, open profiles, or
// touch the Live runner.
const { extractLivePayload, operationFromUrl } = require('../live/extract');
const { tweetRecord } = require('../live/person');

const HOME_URL = 'https://x.com/home';
const INTERVAL_MS = 5 * 60 * 1000;
const SETTLED_LOG_MS = 6000;
const SKIP_IF_LOADING_MS = 45000;

function emptyCounts() {
  return { tweets: 0, news: 0, trends: 0, people: 0 };
}

class HomeRefresh {
  constructor({ getView, db, emit } = {}) {
    this.getView = getView || (() => null);
    this.db = db;
    this.emit = emit || (() => {});
    this.timer = null;
    this.emitTimer = null;
    this.logTimer = null;
    this.gen = 0;
    this.loading = false;
    this.startedAt = 0;
    this.lastRefreshAt = 0;
    this.nextAt = 0;
    this.lastError = '';
    this.last = emptyCounts();
    this.totals = emptyCounts();
    this.seenPayloads = [];
    this.passTweetIds = new Set();
    this.passSignals = new Set();
  }

  start() {
    if (this.timer) return;
    // Page load events must not move this. X fires did-stop-loading all the
    // time, and resetting the clock there means the 5 minutes never elapses.
    this.nextAt = Date.now() + INTERVAL_MS;
    this.timer = setInterval(() => {
      this.nextAt = Date.now() + INTERVAL_MS;
      this.refresh();
    }, INTERVAL_MS);
    this.emitNow();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = null;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.nextAt = 0;
  }

  snapshot() {
    return {
      refreshing: this.loading,
      lastRefreshAt: this.lastRefreshAt,
      nextAt: this.nextAt,
      lastError: this.lastError,
      last: { ...this.last },
      totals: { ...this.totals },
    };
  }

  // One reload. Skipped when the previous navigation is still in flight.
  refresh() {
    if (this.loading && Date.now() - this.startedAt < SKIP_IF_LOADING_MS) {
      console.log('[Home] refresh skipped, still loading');
      return;
    }
    const view = this.getView();
    if (!view || view.webContents.isDestroyed()) return;
    console.log('[Home] reload');
    this.begin();
    view.webContents.loadURL(HOME_URL).catch(err => this.fail(err.message));
  }

  begin() {
    this.gen += 1;
    this.loading = true;
    this.startedAt = Date.now();
    this.lastError = '';
    this.last = emptyCounts();
    this.seenPayloads = [];
    this.passTweetIds = new Set();
    this.passSignals = new Set();
    if (this.logTimer) {
      clearTimeout(this.logTimer);
      this.logTimer = null;
    }
    this.emitNow();
  }

  onStart() {
    this.loading = true;
    if (!this.startedAt) this.startedAt = Date.now();
    this.scheduleEmit();
  }

  onSettle() {
    const view = this.getView();
    let url = '';
    try { url = view?.webContents?.getURL?.() || ''; } catch { url = ''; }
    if (!url || url === 'about:blank') return;
    this.loading = false;
    this.lastRefreshAt = Date.now();
    const gen = this.gen;
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      if (gen !== this.gen) return;
      const n = this.last;
      const parts = [`${n.tweets} tweets`];
      if (n.news) parts.push(`${n.news} news`);
      if (n.trends) parts.push(`${n.trends} trends`);
      if (n.people) parts.push(`${n.people} people`);
      console.log(`[Home] ${parts.join(', ')}`);
      this.emitNow();
    }, SETTLED_LOG_MS);
    this.scheduleEmit();
  }

  fail(message) {
    this.loading = false;
    this.lastRefreshAt = Date.now();
    this.lastError = String(message || 'load failed').slice(0, 140);
    console.error('[Home] reload failed:', this.lastError);
    this.emitNow();
  }

  accept(url, bodyText) {
    if (!bodyText) return;
    const key = `${operationFromUrl(url)}:${bodyText.length}:${String(bodyText).slice(0, 80)}`;
    if (this.seenPayloads.includes(key)) return;
    this.seenPayloads.push(key);
    if (this.seenPayloads.length > 80) this.seenPayloads.splice(0, this.seenPayloads.length - 80);

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return;
    }
    return this._ingest(json, url).catch(err => {
      this.lastError = err.message;
      console.error('[Home] ingest error:', err.message);
    });
  }

  async _ingest(json, url) {
    let extracted;
    try {
      extracted = extractLivePayload(json, { phase: 'passive' });
    } catch (err) {
      console.error('[Home] extract error:', err.message);
      return;
    }

    const news = extracted.signals.filter(signal => signal.kind === 'news');
    if (news.length) {
      console.log(`[Home] ${operationFromUrl(url)}: ${news.map(signal => signal.title).join(' | ')}`);
    }

    for (const tweet of extracted.tweets) {
      const id = String(tweet.tweet.id);
      if (this.passTweetIds.has(id)) continue;
      this.passTweetIds.add(id);
      tweet.source = 'home-refresh';
      const record = tweetRecord(tweet);
      try {
        await this.db.saveTweet(tweet, url);
        this.last.tweets += 1;
        if (record) {
          const inserted = await this.db.upsertLiveSignal({
            kind: 'tweet',
            item_key: record.id,
            title: `@${record.screen_name}`,
            detail: record.text,
            url: record.url,
            payload: record,
          });
          if (inserted) this.totals.tweets += 1;
        }
      } catch (err) {
        this.passTweetIds.delete(id);
        this.lastError = err.message;
        console.error('[Home] tweet save:', err.message);
      }
    }

    for (const signal of extracted.signals) {
      const sigKey = `${signal.kind}:${signal.item_key}`;
      if (this.passSignals.has(sigKey)) continue;
      this.passSignals.add(sigKey);
      try {
        const inserted = await this.db.upsertLiveSignal(signal);
        if (signal.kind === 'news') this.last.news += 1;
        else if (signal.kind === 'trend') this.last.trends += 1;
        else if (signal.kind === 'who_to_follow') this.last.people += 1;
        if (inserted) {
          if (signal.kind === 'news') this.totals.news += 1;
          else if (signal.kind === 'trend') this.totals.trends += 1;
          else if (signal.kind === 'who_to_follow') this.totals.people += 1;
        }
      } catch (err) {
        this.passSignals.delete(sigKey);
        this.lastError = err.message;
        console.error('[Home] signal save:', err.message);
      }
    }
    this.scheduleEmit();
  }

  scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, 200);
  }

  emitNow() {
    try { this.emit(this.snapshot()); } catch (_) {}
  }
}

module.exports = {
  HomeRefresh,
  HOME_URL,
  INTERVAL_MS,
};
