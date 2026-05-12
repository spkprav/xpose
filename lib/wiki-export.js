const fs = require('fs');
const path = require('path');

const WIKI_ROOT = path.join(__dirname, '..', 'social-wiki');

function ensureDirs() {
  fs.mkdirSync(path.join(WIKI_ROOT, 'people'), { recursive: true });
  fs.mkdirSync(path.join(WIKI_ROOT, 'drafts'), { recursive: true });
}

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDate(d) {
  if (!d) return 'never';
  return new Date(d).toISOString().slice(0, 10);
}

async function exportPerson(db, screenName) {
  ensureDirs();
  const circle = await db.getSocialCircle();
  const member = circle.find(m => m.screen_name === screenName);
  if (!member) return;

  const recentTweets = await db.getTopCircleTweets(10, 30);
  const memberTweets = recentTweets.filter(t => t.screen_name === screenName);

  const lines = [
    `---`,
    `screen_name: "${screenName}"`,
    `relationship: "${member.relationship}"`,
    `last_updated: "${new Date().toISOString().slice(0, 10)}"`,
    `---`,
    ``,
    `# @${screenName}${member.display_name && member.display_name !== screenName ? ` (${member.display_name})` : ''}`,
    ``,
    `**Relationship**: ${member.relationship}  `,
    `**Followers**: ${formatCount(member.followers_count)} | **Following**: ${formatCount(member.following_count)}  `,
    `**Last crawled**: ${formatDate(member.last_crawled_at)}`,
    ``,
  ];

  if (member.bio) {
    lines.push(`## Bio`, ``, member.bio, ``);
  }

  if (memberTweets.length > 0) {
    lines.push(`## Top recent tweets (last 30 days)`, ``);
    for (const t of memberTweets) {
      const score = t.like_count + t.retweet_count * 2 + t.quote_count * 3;
      lines.push(`**[${score} pts]** ${t.text.replace(/\n/g, ' ').slice(0, 200)}`);
      lines.push(`*${formatDate(t.created_at)}. ${t.like_count} likes, ${t.retweet_count} RT, ${t.reply_count} replies*`);
      lines.push(``);
    }
  }

  const filePath = path.join(WIKI_ROOT, 'people', `${screenName}.md`);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

async function exportCircleSummary(db) {
  ensureDirs();
  const [stats, activity, topTweets, candidates] = await Promise.all([
    db.getSocialCircleStats(),
    db.getCircleActivity(7),
    db.getTopCircleTweets(10, 7),
    db.get2ndDegreeCandidates(),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    `---`,
    `updated: "${today}"`,
    `---`,
    ``,
    `# Social Circle Summary. ${today}`,
    ``,
    `## Circle composition`,
    ``,
  ];

  for (const s of stats) {
    lines.push(`- **${s.relationship}**: ${s.count} total, ${s.crawled} crawled, ${s.needs_enrichment} need enrichment`);
  }

  lines.push(``, `## Most active this week`, ``);
  for (const a of activity.slice(0, 10)) {
    lines.push(`- **@${a.screen_name}**: ${a.tweet_count} tweets, ${a.total_likes} likes`);
  }

  lines.push(``, `## Top circle tweets this week`, ``);
  for (const t of topTweets) {
    const score = t.like_count + t.retweet_count * 2;
    lines.push(`**@${t.screen_name}** [${score} pts]: "${t.text.replace(/\n/g, ' ').slice(0, 150)}"`);
    lines.push(``);
  }

  if (candidates.length > 0) {
    lines.push(`## 2nd-degree candidates`, ``, `These accounts are frequently replied to by your circle:`, ``);
    for (const c of candidates.slice(0, 20)) {
      lines.push(`- **@${c.screen_name}**: ${c.interaction_count} interactions from circle`);
    }
    lines.push(``);
  }

  const filePath = path.join(WIKI_ROOT, 'circle-summary.md');
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

function exportDrafts(drafts, date) {
  ensureDirs();
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const filePath = path.join(WIKI_ROOT, 'drafts', `${dateStr}.md`);

  const lines = [
    `# Drafts. ${dateStr}`,
    ``,
    `*Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST*`,
    ``,
  ];

  drafts.forEach((d, i) => {
    lines.push(`## Draft ${i + 1}`);
    lines.push(`**Optimal time**: ${d.optimal_time || 'Tuesday 22:00 IST'}  `);
    if (d.angle) lines.push(`**Angle**: ${d.angle}`);
    lines.push(``);
    lines.push(d.text);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  });

  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

async function exportAll(db, drafts) {
  ensureDirs();
  const paths = [];

  const summaryPath = await exportCircleSummary(db);
  paths.push(summaryPath);

  if (drafts && drafts.length > 0) {
    const draftsPath = exportDrafts(drafts);
    paths.push(draftsPath);
  }

  return paths;
}

module.exports = { exportPerson, exportCircleSummary, exportDrafts, exportAll };
