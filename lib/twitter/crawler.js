const { CRAWL_ENTRY_PATHS, SKIP_PATTERNS } = require('./constants');
const { extractFollowerFromGraphQL, extractProfileFromGraphQL, extractCircleTweet } = require('./extractors');

const DELAY_BETWEEN_SCROLLS_MS = 2500;
const DELAY_BETWEEN_PROFILES_MS = 5000;
const PAGES_PER_PROFILE = 15;
const PAGES_PER_LIST = 20;

const DEEP_DEFAULTS = {
  target_tweets: 200,
  date_cutoff: '2026-03-01',
  min_skip_scrolls: 4,
  zero_delta_break: 4,
  max_scrolls_ceiling: 60,
};

class ProfileCrawler {
  constructor({ crawlView, db, onStatus, onFeedRefresh, deepConfig }) {
    this.crawlView = crawlView;
    this.db = db;
    this.onStatus = onStatus || (() => {});
    this.onFeedRefresh = onFeedRefresh || null;
    this.deepConfig = { ...DEEP_DEFAULTS, ...(deepConfig || {}) };

    this.state = 'idle';
    this.queue = [];
    this.currentJob = null;
    this.capturedTweets = [];
    this.savedTweetIds = new Set(); // track what's already been inserted
    this.capturedProfiles = [];
    this.currentPage = 0;
    this._pageTimer = null;
    this.totalSaved = 0;
    this.totalProfiles = 0;

    // Deep-mode per-profile state (reset in _crawlNext)
    this._lastSavedSize = 0;
    this._lastScrollHeight = 0;
    this._lastScrollTop = 0;
    this._bottomStreak = 0;
    this._exitReason = null;
  }

  setDeepConfig(cfg) {
    this.deepConfig = { ...DEEP_DEFAULTS, ...(cfg || {}) };
  }

  // Called by main.js debugger handler when a crawl endpoint fires
  ingestResponse(endpointType, data) {
    if (endpointType === 'UserTweets' || endpointType === 'UserTweetsAndReplies') {
      const instructions = CRAWL_ENTRY_PATHS[endpointType]?.(data) || CRAWL_ENTRY_PATHS['UserTweets'](data);
      if (!instructions) {
        console.log('[Crawler] UserTweets: no instructions. data keys:', Object.keys(data));
        const u = data.user?.result;
        if (u) console.log('[Crawler] user.result keys:', Object.keys(u));
        return;
      }
      console.log('[Crawler] UserTweets instructions count:', instructions.length);
      instructions.forEach((ins, i) => console.log(`  [${i}] type=${ins.type} entries=${ins.entries?.length ?? 'n/a'}`));
      const tweets = this._extractTweetsFromInstructions(instructions);
      console.log('[Crawler] extracted tweets:', tweets.length);
      this.capturedTweets.push(...tweets);
    } else if (endpointType === 'Followers' || endpointType === 'Following') {
      const relationship = endpointType === 'Followers' ? 'follower' : 'following';
      const instructions = CRAWL_ENTRY_PATHS[endpointType]?.(data);
      if (!instructions) return;
      for (const instruction of instructions) {
        if (instruction.type !== 'TimelineAddEntries') continue;
        for (const entry of instruction.entries || []) {
          const profile = extractFollowerFromGraphQL(entry);
          if (profile) this.capturedProfiles.push({ ...profile, relationship });
        }
      }
    } else if (endpointType === 'UserByRestId' || endpointType === 'UserByScreenName') {
      const profile = extractProfileFromGraphQL(data);
      if (profile) this.capturedProfiles.push(profile);
    }
  }

  /**
   * Standalone ingest path for X-list timeline responses, driven from the Lists tab.
   * Does NOT touch the queued job state machine. Extracts tweets, saves to
   * circle_tweets + circle_tweet_sources tagged with the source list slug.
   * Returns { saved, sourced } counts.
   */
  async ingestListResponse(data, sourceSlug) {
    if (!sourceSlug) return { saved: 0, sourced: 0 };
    const instructions = CRAWL_ENTRY_PATHS['ListLatestTweetsTimeline']?.(data);
    if (!instructions) {
      console.log('[ListCrawl] no instructions. data keys:', Object.keys(data || {}));
      return { saved: 0, sourced: 0 };
    }
    const tweets = this._extractTweetsFromInstructions(instructions);
    if (!tweets.length) return { saved: 0, sourced: 0 };
    try {
      const { saved, sourced, errors } = await this.db.upsertCircleTweetsBatchWithSource(tweets, sourceSlug);
      if (errors?.length) console.log(`[ListCrawl] ${sourceSlug}: ${errors.length} errors`);
      console.log(`[ListCrawl] ${sourceSlug}: extracted ${tweets.length}, new ${saved.length}, sourced ${sourced}`);
      return { saved: saved.length, sourced, extracted: tweets.length };
    } catch (err) {
      console.error('[ListCrawl] save error:', err.message);
      return { saved: 0, sourced: 0 };
    }
  }

  _extractTweetsFromInstructions(instructions) {
    const tweets = [];
    for (const instruction of instructions) {
      if (instruction.type !== 'TimelineAddEntries') continue;
      for (const entry of instruction.entries || []) {
        const entryId = entry.entryId || '';
        if (SKIP_PATTERNS.some(p => entryId.includes(p))) continue;
        if (entryId.startsWith('cursor-')) continue;

        const { content } = entry;
        if (content?.itemContent?.tweet_results) {
          const tweet = extractCircleTweet(content.itemContent.tweet_results);
          if (tweet) tweets.push(tweet);
        } else if (content?.items) {
          for (const item of content.items) {
            const tr = item?.item?.itemContent?.tweet_results;
            if (tr) {
              const tweet = extractCircleTweet(tr);
              if (tweet) tweets.push(tweet);
            }
          }
        }
      }
    }
    return tweets;
  }

  async loadQueue() {
    const jobs = await this.db.getPendingCrawlJobs(5000);
    this.queue = jobs;
    return jobs.length;
  }

  async start(mode = 'user_tweets') {
    if (this.state === 'crawling') {
      console.log('[Crawler] Already crawling, ignoring start()');
      return;
    }
    this.state = 'idle';
    console.log('[Crawler] Resetting stale jobs...');
    await this.db.resetStaleCrawlJobs();
    const count = await this.loadQueue();
    console.log(`[Crawler] Queue loaded: ${count} jobs`);
    this._sendStatus({ state: 'starting', queueLength: count });
    this._crawlNext();
  }

  pause() {
    this.state = 'paused';
    if (this._pageTimer) { clearTimeout(this._pageTimer); this._pageTimer = null; }
    this._sendStatus({ state: 'paused' });
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'idle';
    this._crawlNext();
  }

  stop() {
    this.state = 'stopped';
    if (this._pageTimer) { clearTimeout(this._pageTimer); this._pageTimer = null; }
    this._sendStatus({ state: 'idle' });
  }

  async _crawlNext() {
    if (this.state === 'paused' || this.state === 'stopped') return;

    const job = this.queue.shift();
    if (!job) {
      this.state = 'idle';
      this._sendStatus({ state: 'idle', message: 'Crawl complete' });
      return;
    }

    this.currentJob = job;
    this.capturedTweets = [];
    this.savedTweetIds = new Set();
    this.capturedProfiles = [];
    this.currentPage = 0;
    this._lastSavedSize = 0;
    this._lastScrollHeight = 0;
    this._lastScrollTop = 0;
    this._bottomStreak = 0;
    this._exitReason = null;
    this._jobStartMs = Date.now();
    this.state = 'crawling';

    const target = job.target_screen_name || job.target_user_id;
    this._sendStatus({ state: 'crawling', currentProfile: target, queueLength: this.queue.length, mode: job.job_type });

    this.db.updateCrawlJob(job.id, 'running').catch(() => {});

    let url;
    if (job.job_type === 'enrichment' && job.target_user_id) {
      url = `https://x.com/i/user/${job.target_user_id}`;
    } else if (job.job_type === 'followers_live') {
      url = `https://x.com/${job.target_screen_name}/followers`;
    } else if (job.job_type === 'following_live') {
      url = `https://x.com/${job.target_screen_name}/following`;
    } else {
      // user_tweets and user_tweets_deep both crawl /with_replies
      url = `https://x.com/${job.target_screen_name}/with_replies`;
    }

    this.crawlView.webContents.loadURL(url).catch(err => {
      console.error(`[Crawler] Failed to load ${url}:`, err.message);
      this._failJob(err.message);
    });

    this._pageTimer = setTimeout(() => this._handlePageLoad(), DELAY_BETWEEN_SCROLLS_MS);
  }

  async _handlePageLoad() {
    if (this.state !== 'crawling') return;
    this.currentPage++;

    const jobType = this.currentJob?.job_type;
    const isDeep = jobType === 'user_tweets_deep';
    const isShallow = jobType === 'user_tweets_shallow';
    const isTweetJob = jobType === 'user_tweets' || isDeep || isShallow;

    // Save any new tweets captured since last scroll
    if (isTweetJob) {
      await this._flushNewTweets();
    }

    // Shallow: one page load, no scroll. Exit immediately after first flush.
    if (isShallow) {
      await this._finishCurrentJob();
      this._pageTimer = setTimeout(() => this._crawlNext(), DELAY_BETWEEN_PROFILES_MS);
      return;
    }

    // Deep-mode early-exit checks
    if (isDeep) {
      const cfg = this.deepConfig;
      const cur = this.savedTweetIds.size;
      this._lastSavedSize = cur;

      const cutoffMs = Date.parse(cfg.date_cutoff);
      const pastCutoff = this.currentPage > cfg.min_skip_scrolls && this.capturedTweets.some(t => {
        const ts = t.created_at ? Date.parse(t.created_at) : NaN;
        return Number.isFinite(ts) && ts < cutoffMs;
      });

      // Stall = scrolled to bottom AND DOM not growing for N consecutive ticks.
      // Means X stopped paginating (end of feed) or never paginated.
      if (cur >= cfg.target_tweets) this._exitReason = 'cap';
      else if (pastCutoff) this._exitReason = 'cutoff';
      else if (this._bottomStreak >= cfg.zero_delta_break && this.currentPage > cfg.min_skip_scrolls) this._exitReason = 'stall';
      else if (this.currentPage >= cfg.max_scrolls_ceiling) this._exitReason = 'ceiling';

      if (this._exitReason) {
        await this._finishCurrentJob();
        this._pageTimer = setTimeout(() => this._crawlNext(), DELAY_BETWEEN_PROFILES_MS);
        return;
      }
    }

    const maxPages = (jobType === 'followers_live' || jobType === 'following_live')
      ? PAGES_PER_LIST
      : (isDeep ? this.deepConfig.max_scrolls_ceiling : PAGES_PER_PROFILE);

    if (this.currentPage < maxPages) {
      // Progressive scroll: one screen at a time toward DOM bottom.
      // X virtualizes the list — bottom sentinel must intersect viewport for pagination fetch.
      let result = { top: 0, height: 0, atBottom: false };
      try {
        result = await this.crawlView.webContents.executeJavaScript(`
          (function(){
            const t = document.scrollingElement || document.documentElement;
            const bottom = t.scrollHeight - t.clientHeight;
            const before = t.scrollTop;
            t.scrollTop = Math.min(before + Math.floor(t.clientHeight * 0.9), bottom);
            window.dispatchEvent(new Event('scroll'));
            return { top: t.scrollTop, height: t.scrollHeight, atBottom: t.scrollTop >= bottom - 4 };
          })()
        `);
      } catch (_) {
        try {
          await this.crawlView.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
            x: 200, y: 400, xDistance: 0, yDistance: -800, speed: 600,
          });
        } catch (_2) {}
      }
      // True stall: hit bottom of rendered DOM AND DOM did not grow vs last tick.
      // Means scroll fired but X didn't paginate → real end of feed.
      const heightGrew = result.height > this._lastScrollHeight;
      const stalled = result.atBottom && !heightGrew && this._lastScrollHeight > 0;
      console.log(`[Crawler] scroll page=${this.currentPage} top=${result.top} height=${result.height} bottom=${result.atBottom} grew=${heightGrew} bottomStreak=${this._bottomStreak}`);
      this._bottomStreak = stalled ? this._bottomStreak + 1 : 0;
      this._lastScrollHeight = result.height || this._lastScrollHeight;
      this._lastScrollTop = result.top;
      this._pageTimer = setTimeout(() => this._handlePageLoad(), DELAY_BETWEEN_SCROLLS_MS);
    } else {
      await this._finishCurrentJob();
      this._pageTimer = setTimeout(() => this._crawlNext(), DELAY_BETWEEN_PROFILES_MS);
    }
  }

  async _flushNewTweets() {
    const unsaved = this.capturedTweets.filter(t => !this.savedTweetIds.has(t.id));
    if (!unsaved.length) return;
    try {
      const { saved } = await this.db.upsertCircleTweetsBatch(unsaved);
      saved.forEach(id => this.savedTweetIds.add(id));
      this.totalSaved += saved.length;
      console.log(`[Crawler] Flushed ${saved.length} tweets (page ${this.currentPage})`);
      this.onFeedRefresh?.(); // signal feed to refresh
    } catch (err) {
      console.error('[Crawler] Flush error:', err.message);
    }
  }

  async _finishCurrentJob() {
    const job = this.currentJob;
    if (!job) return;

    try {
      if (job.job_type === 'user_tweets' || job.job_type === 'user_tweets_deep' || job.job_type === 'user_tweets_shallow') {
        // Flush any remaining unsaved tweets
        await this._flushNewTweets();
        // Upsert profile fields (followers/following/bio) captured from UserByScreenName during this crawl.
        // Preserves existing relationship — don't pass relationship so upsert keeps prior is_follower/is_following.
        for (const profile of this.capturedProfiles) {
          try {
            await this.db.upsertSocialCircle({
              user_id: profile.user_id,
              screen_name: profile.screen_name,
              display_name: profile.display_name,
              bio: profile.bio,
              followers_count: profile.followers_count,
              following_count: profile.following_count,
              relationship: '2nd_degree',
            });
          } catch (err) {
            console.error('[Crawler] Profile upsert failed:', err.message);
          }
        }
        if (job.target_screen_name) {
          await this.db.updateSocialCircleCrawled(job.target_screen_name);
        }
        const profileTotal = this.savedTweetIds.size;
        const durSec = ((Date.now() - (this._jobStartMs || Date.now())) / 1000).toFixed(1);
        const reason = this._exitReason || (job.job_type === 'user_tweets_deep' ? 'pages' : 'pages');
        await this.db.updateCrawlJob(job.id, 'done', {
          tweets_collected: profileTotal,
          pages_fetched: this.currentPage,
          error_message: job.job_type === 'user_tweets_deep' ? `exit:${reason}` : null,
        });
        this.totalProfiles++;
        console.log(`[Crawler] Done @${job.target_screen_name} (${job.job_type}, exit=${reason}): ${profileTotal} tweets in ${durSec}s (session total: ${this.totalSaved})`);
        // Clear crawlView cache every 200 profiles to prevent memory buildup
        if (this.totalProfiles % 200 === 0) {
          console.log('[Crawler] Clearing crawlView cache...');
          this.crawlView.webContents.session.clearCache().catch(() => {});
        }
      } else if ((job.job_type === 'followers_live' || job.job_type === 'following_live') && this.capturedProfiles.length > 0) {
        let saved = 0;
        for (const profile of this.capturedProfiles) {
          try {
            await this.db.upsertSocialCircle(profile);
            saved++;
          } catch (_) {}
        }
        await this.db.markMutuals();
        await this.db.updateCrawlJob(job.id, 'done', {
          tweets_collected: saved,
          pages_fetched: this.currentPage,
        });
        console.log(`[Crawler] ${job.job_type} done: ${saved} profiles saved`);
      } else if (job.job_type === 'enrichment' && this.capturedProfiles.length > 0) {
        const profile = this.capturedProfiles[0];
        if (profile && job.target_user_id) {
          await this.db.upsertSocialCircle({ ...profile, user_id: job.target_user_id, relationship: job.relationship || 'follower' });
        }
        await this.db.updateCrawlJob(job.id, 'done', { pages_fetched: this.currentPage });
      } else {
        await this.db.updateCrawlJob(job.id, 'done', { pages_fetched: this.currentPage });
      }
    } catch (err) {
      await this._failJob(err.message);
    }

    this.currentJob = null;
  }

  async _failJob(message) {
    if (this.currentJob) {
      await this.db.updateCrawlJob(this.currentJob.id, 'failed', { error_message: message }).catch(() => {});
      this.currentJob = null;
    }
    this._pageTimer = setTimeout(() => this._crawlNext(), DELAY_BETWEEN_PROFILES_MS);
  }

  _sendStatus(data) {
    this.onStatus({ ...data, capturedTweets: this.capturedTweets.length, totalSaved: this.totalSaved, totalProfiles: this.totalProfiles });
  }
}

module.exports = ProfileCrawler;
