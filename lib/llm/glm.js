const https = require('https');

class GLMClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'glm-4-flash';
    this.baseUrl = 'api.z.ai';
  }

  async chat(messages, options = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: this.model,
        messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 500,
      });

      console.log(`[GLM] Request to: https://${this.baseUrl}/api/paas/v4/chat/completions`);
      console.log(`[GLM] Model: ${this.model}`);
      console.log(`[GLM] API Key (first 10 chars): ${this.apiKey?.substring(0, 10)}...`);

      const req = https.request({
        hostname: this.baseUrl,
        path: '/api/paas/v4/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            console.log(`[GLM] Response status: ${res.statusCode}`);
            const response = JSON.parse(body);

            if (response.error) {
              console.log(`[GLM] Error:`, response.error);
              reject(new Error(response.error.message || JSON.stringify(response.error)));
              return;
            }

            resolve(response.choices?.[0]?.message?.content || '');
          } catch (err) {
            console.log(`[GLM] Parse error, raw body:`, body.substring(0, 500));
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        console.log(`[GLM] Request error:`, err);
        reject(err);
      });
      req.write(data);
      req.end();
    });
  }

  async generateReply(tweet) {
    const messages = [
      {
        role: 'system',
        content: `You are a helpful assistant that generates engaging Twitter/X replies.
Keep replies concise (under 280 chars), authentic, and valuable.
Avoid being salesy or spammy. Add value to the conversation.`
      },
      {
        role: 'user',
        content: `Generate a thoughtful reply to this tweet:

Author: @${tweet.user.screen_name} (${tweet.user.name})
Tweet: ${tweet.tweet.text}

Reply:`
      }
    ];

    return this.chat(messages);
  }

  async generateICP(profileData) {
    const messages = [
      {
        role: 'system',
        content: `You are an expert at defining Ideal Customer Profiles (ICP) for Twitter/X engagement.
Based on a user's profile, bio, and recent tweets, generate a concise ICP criteria that describes:
1. Who they should engage with (audience type)
2. Topics they're interested in
3. Type of content that aligns with their brand
4. What kind of accounts would benefit from their replies

Be specific and actionable. Output only the ICP criteria, no explanations.`
      },
      {
        role: 'user',
        content: `Generate ICP criteria for this Twitter user:

Name: ${profileData.name}
Handle: @${profileData.screen_name}
Bio: ${profileData.bio || 'N/A'}
Location: ${profileData.location || 'N/A'}
Followers: ${profileData.followers_count || 'N/A'}
Following: ${profileData.following_count || 'N/A'}

Recent Tweets:
${profileData.recentTweets?.map((t, i) => `${i + 1}. ${t}`).join('\n') || 'N/A'}

Generate a concise ICP criteria (3-5 bullet points):`
      }
    ];

    return this.chat(messages, { maxTokens: 300 });
  }

  async analyzeTweet(tweet, icpCriteria) {
    const messages = [
      {
        role: 'system',
        content: `Craft short replies/quotes for tweets. Be generous - most tweets are worth engaging.

- "quote" = share with your take
- "reply" = respond directly

CRITICAL: Max 10 words!

{"match":true,"type":"reply","message":"max 10 words"}
{"match":true,"type":"quote","message":"max 10 words"}

Only {"match":false} if spam/offensive.

JSON only.`
      },
      {
        role: 'user',
        content: `Me: ${icpCriteria}

Tweet by @${tweet.user.screen_name}: "${tweet.tweet.text}"

Reply or quote? 10 words max.`
      }
    ];

    const response = await this.chat(messages, { maxTokens: 350 });
    try {
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
      }
      const parsed = JSON.parse(jsonStr);
      return {
        relevant: parsed.match === true,
        engagementType: parsed.type,
        suggestedContent: parsed.message,
        score: parsed.match ? 80 : 0
      };
    } catch {
      return { relevant: false };
    }
  }
}

module.exports = GLMClient;
