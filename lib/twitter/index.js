const { ENTRY_PATHS, SKIP_PATTERNS } = require('./constants');
const { transformConversation, transformSingleTweet } = require('./transformers');

class TweetProcessor {
  constructor(response, source) {
    this.response = response;
    this.source = source;
  }

  /**
   * Extract all tweets from the API response
   */
  extractTweets() {
    if (!this.response?.data) {
      return [];
    }

    const entries = this.getEntries();
    if (!entries) {
      return [];
    }

    const tweets = [];

    for (const instruction of entries) {
      if (instruction.type !== 'TimelineAddEntries') continue;

      for (const entry of instruction.entries || []) {
        if (this.shouldSkipEntry(entry)) continue;

        const tweet = this.processEntry(entry);
        if (tweet) {
          tweets.push(tweet);
        }
      }
    }

    return tweets;
  }

  /**
   * Get timeline entries based on source type
   */
  getEntries() {
    const pathGetter = ENTRY_PATHS[this.source];
    if (!pathGetter) {
      console.warn(`Unknown source type: ${this.source}`);
      return null;
    }
    return pathGetter(this.response.data);
  }

  /**
   * Check if entry should be skipped (ads, promotions, etc.)
   */
  shouldSkipEntry(entry) {
    const entryId = entry.entryId || '';
    return SKIP_PATTERNS.some(pattern => entryId.includes(pattern));
  }

  /**
   * Process a single timeline entry
   */
  processEntry(entry) {
    const { content } = entry;

    // Conversation thread (tweet with replies)
    if (content?.items) {
      return transformConversation(content.items, this.source);
    }

    // Single tweet
    if (content?.itemContent) {
      return transformSingleTweet(content.itemContent, this.source);
    }

    return null;
  }
}

module.exports = TweetProcessor;
