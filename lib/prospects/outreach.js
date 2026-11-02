// Outreach draft generator. Platform-aware: X tweets/DMs short and casual,
// LinkedIn connect notes < 300 chars, LinkedIn InMail longer.

const X_DM_SYSTEM = `Write a short, specific X (Twitter) DM opener to a prospect.
Rules:
- max 280 chars
- no em dashes anywhere
- no emojis
- reference one concrete detail from their bio / recent post
- end with a soft question, not a pitch
- no "hope this finds you well", no LinkedIn-speak
- lowercase casual unless their handle is corporate

Return only the message body. No quotes, no headers.`;

const LI_CONNECT_SYSTEM = `Write a LinkedIn connection-request note.
Rules:
- max 290 chars (LinkedIn's hard limit is 300)
- no em dashes
- reference one specific thing from their headline or company
- no pitch, just a reason to connect
- professional but not stiff

Return only the note. No quotes.`;

const LI_INMAIL_SYSTEM = `Write a LinkedIn InMail / cold email opener.
Rules:
- 3 short paragraphs, max 120 words total
- no em dashes
- subject line on first line prefixed "Subject: "
- specific hook from their role / company
- one clear soft CTA at end
- no "I hope this finds you well"

Return subject + body only.`;

function systemFor(platform, channel) {
  if (platform === 'x') return X_DM_SYSTEM;
  if (platform === 'linkedin' && channel === 'connect') return LI_CONNECT_SYSTEM;
  if (platform === 'linkedin') return LI_INMAIL_SYSTEM;
  return X_DM_SYSTEM;
}

function profileBlock(p) {
  return [
    p.display_name && `Name: ${p.display_name}`,
    p.handle && `Handle: ${p.handle}`,
    p.title && `Title: ${p.title}`,
    p.company && `Company: ${p.company}`,
    p.headline && `Headline: ${p.headline}`,
    p.bio && `Bio: ${p.bio.slice(0, 300)}`,
  ].filter(Boolean).join('\n');
}

async function generateOutreach(llmClient, { prospect, platform, channel, context = '' }) {
  const messages = [
    { role: 'system', content: systemFor(platform, channel) },
    {
      role: 'user',
      content: `Prospect:\n${profileBlock(prospect)}\n\nYour context / who you are: ${context || 'an indie builder reaching out'}\n\nWrite the message.`,
    },
  ];
  const body = await llmClient.chat(messages, { maxTokens: 320, temperature: 0.7 });
  return (body || '').replace(/—/g, ',').trim();
}

module.exports = { generateOutreach };
