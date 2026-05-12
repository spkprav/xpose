const fs = require('fs');
const path = require('path');

const WIKI_BASE = path.join(__dirname, '..', 'docs', 'wiki');

const VOICE_SOURCES = [
  { file: path.join(WIKI_BASE, 'tweets', 'rhythm.md'), maxChars: 200 },
  { file: path.join(WIKI_BASE, 'creativity', 'content-creation.md'), maxChars: 300 },
];

const DRAFT_SYSTEM_PROMPT = `You generate Twitter/X posts for an indie-hacker who documents building in public.

Voice rules (non-negotiable):
- Concrete specifics: exact tool names, exact numbers, exact failure details
- Failure narratives beat success theater
- No generic motivation ("consistency is key", "just ship it", "keep going")
- Short standalone post > thread in 2026
- First-person, direct voice. no AI-speak, no hedging
- Best post times: 22:00 IST Tuesday or Thursday

Return a JSON array of 3-5 draft objects only:
[{"text": "post text here", "angle": "why this angle works", "optimal_time": "Tuesday 22:00 IST"}]

No explanation outside the JSON.`;

function readVoicePatterns() {
  const parts = [];
  for (const { file, maxChars } of VOICE_SOURCES) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      parts.push(content.slice(0, maxChars));
    } catch (_) {}
  }
  return parts.join('\n\n---\n\n').slice(0, 500);
}

async function generateDrafts(db, llmClient) {
  const [topTweets, activity] = await Promise.all([
    db.getTopCircleTweets(15, 7),
    db.getCircleActivity(7),
  ]);

  const voicePatterns = readVoicePatterns();

  const circleLines = topTweets.slice(0, 8).map(t =>
    `@${t.screen_name} (${t.author_followers || '?'} followers): "${t.text.slice(0, 120)}". ${t.like_count} likes`
  ).join('\n');

  const activeLines = activity.slice(0, 5).map(a =>
    `@${a.screen_name}: ${a.tweet_count} tweets, ${a.total_likes} likes this week`
  ).join('\n');

  const userPrompt = `What my circle is discussing right now (top engaged tweets, last 7 days):
${circleLines || 'No circle tweets yet. use general indie-hacker topics'}

Most active circle members:
${activeLines || 'No activity data yet'}

My documented voice patterns (from personal wiki):
${voicePatterns}

Generate 3-5 post drafts that connect to what my circle is discussing, in my documented voice. Find the intersection between their active conversations and what I know / have built / have failed at.`;

  const messages = [
    { role: 'system', content: DRAFT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const raw = await llmClient.chat(messages, { maxTokens: 900, temperature: 0.9 });

  let drafts = [];
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) drafts = JSON.parse(jsonMatch[0]);
  } catch (_) {
    drafts = [{ text: raw.slice(0, 280), angle: 'raw LLM output', optimal_time: 'Tuesday 22:00 IST' }];
  }

  const topTweetIds = topTweets.slice(0, 8).map(t => t.id?.toString());
  const wikiPages = VOICE_SOURCES.map(s => s.file);

  const contextSummary = `Based on ${topTweets.length} circle tweets, ${activity.length} active members`;

  // Calculate tonight's 22:00 IST as suggested post time
  const suggestedTime = getNext2200IST();

  const savedIds = [];
  for (const d of drafts) {
    const id = await db.insertDraft({
      draft_text: d.text,
      context_summary: contextSummary,
      based_on_circle_tweets: topTweetIds,
      based_on_wiki_pages: wikiPages,
      suggested_post_time: suggestedTime,
    });
    savedIds.push(id);
  }

  return { drafts, savedIds, contextSummary };
}

function getNext2200IST() {
  const now = new Date();
  // IST = UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const target = new Date(istNow);
  target.setHours(22, 0, 0, 0);
  if (istNow.getHours() >= 22) target.setDate(target.getDate() + 1);
  return new Date(target.getTime() - istOffset);
}

module.exports = { generateDrafts };
