// Fit-score a prospect against parsed ICP criteria via LLM.
// Per-prospect call. Caller batches.

const SCORE_SYSTEM_PROMPT = `Score how well a prospect matches an ICP. Output strict JSON:

{
  "fit_score": 0-100 integer,
  "breakdown": { "role": 0-100, "industry": 0-100, "topics": 0-100, "geography": 0-100, "size": 0-100 },
  "reason": "one sentence why",
  "signals": ["string"]
}

Heuristics:
- Strong role/industry match + topic overlap = 70-90.
- Bio mentions exact ICP terms = +10.
- Geography mismatch or excluded term = cap at 30.
- Empty bio + no topic signal = under 30.

JSON only. No markdown.`;

function profileSummary(p) {
  const parts = [
    p.display_name && `Name: ${p.display_name}`,
    p.handle && `Handle: @${p.handle}`,
    p.title && `Title: ${p.title}`,
    p.company && `Company: ${p.company}`,
    p.headline && `Headline: ${p.headline}`,
    p.bio && `Bio: ${p.bio.slice(0, 400)}`,
    p.location && `Location: ${p.location}`,
    p.followers_count != null && `Followers: ${p.followers_count}`,
  ].filter(Boolean);
  return parts.join('\n');
}

async function scoreProspect(llmClient, criteria, prospect, extraSignals = '') {
  const messages = [
    { role: 'system', content: SCORE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `ICP criteria:\n${JSON.stringify(criteria, null, 2)}\n\nProspect:\n${profileSummary(prospect)}${extraSignals ? `\n\nRecent activity / posts:\n${extraSignals.slice(0, 800)}` : ''}\n\nScore this prospect.`,
    },
  ];
  const raw = await llmClient.chat(messages, { maxTokens: 350, temperature: 0.3 });
  return extractScore(raw);
}

function extractScore(raw) {
  let str = (raw || '').trim();
  if (str.startsWith('```')) str = str.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  const m = str.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Scorer did not return JSON');
  const parsed = JSON.parse(m[0]);
  return {
    fitScore: clamp(parsed.fit_score, 0, 100),
    breakdown: parsed.breakdown || {},
    reason: parsed.reason || '',
    signals: Array.isArray(parsed.signals) ? parsed.signals : [],
  };
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

module.exports = { scoreProspect };
