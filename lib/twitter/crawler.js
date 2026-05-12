const { CRAWL_ENTRY_PATHS, SKIP_PATTERNS } = require('./constants');
const { extractFollowerFromGraphQL, extractProfileFromGraphQL, extractCircleTweet } = require('./extractors');

const DELAY_BETWEEN_SCROLLS_MS = 3000;
const DELAY_BETWEEN_PROFILES_MS = 5000;
const PAGES_PER_PROFILE = 3;  // 3 scrolls × 3s + 5s gap = ~14s per profile
const PAGES_PER_LIST = 10;    // ~500 followers/following across 10 scroll-loads
const MAX_TWEETS_PER_PROFILE = 10;

class ProfileCrawler {
  constructor({ crawlView, db, onStatus, onFeedRefresh }) {
    this.crawlView = crawlView;
    this.db = db;
    this.onStatus = onStatus || (() => {});
    this.onFeedRefresh = onFeedRefresh || null;

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
    this.state = 'crawling';

    const target = job.target_screen_name || job.target_user_id;
    this._sendStatus({ state: 'crawling', currentProfile: target, queueLength: this.queue.length });

    this.db.updateCrawlJob(job.id, 'running').catch(() => {});

    let url;
    if (job.job_type === 'enrichment' && job.target_user_id) {
      url = `https://x.com/i/user/${job.target_user_id}`;
    } else if (job.job_type === 'followers_live') {
      url = `https://x.com/${job.target_screen_name}/followers`;
    } else if (job.job_type === 'following_live') {
      url = `https://x.com/${job.target_screen_name}/following`;
    } else {
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

    // Save any new tweets captured since last scroll
    if (this.currentJob?.job_type === 'user_tweets') {
      await this._flushNewTweets();
    }

    const maxPages = (this.currentJob?.job_type === 'followers_live' || this.currentJob?.job_type === 'following_live')
      ? PAGES_PER_LIST
      : PAGES_PER_PROFILE;

    if (this.currentPage < maxPages) {
      try {
        // CDP scroll gesture. triggers IntersectionObserver unlike window.scrollTo
        await this.crawlView.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
          x: 400,
          y: 400,
          xDistance: 0,
          yDistance: -3000,
          speed: 800,
        });
      } catch (_) {
        // Fallback
        try {
          await this.crawlView.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
        } catch (_2) {}
      }
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
      if (job.job_type === 'user_tweets') {
        // Flush any remaining unsaved tweets
        await this._flushNewTweets();
        if (job.target_screen_name) {
          await this.db.updateSocialCircleCrawled(job.target_screen_name);
        }
        const profileTotal = this.savedTweetIds.size;
        await this.db.updateCrawlJob(job.id, 'done', {
          tweets_collected: profileTotal,
          pages_fetched: this.currentPage,
        });
        this.totalProfiles++;
        console.log(`[Crawler] Done @${job.target_screen_name}: ${profileTotal} tweets (session total: ${this.totalSaved})`);
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
