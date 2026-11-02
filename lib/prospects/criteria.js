// Prompt → structured ICP criteria via LLM.
// Output is a JSON object the scorer + source crawlers can consume.

const CRITERIA_SYSTEM_PROMPT = `You are an ICP-criteria parser for a B2B prospecting tool.
Given a natural-language description of an Ideal Customer Profile, output a strict JSON object:

{
  "roles":        ["string"],   // job titles or role types, e.g. "founder", "head of growth"
  "industries":   ["string"],   // industries / verticals
  "company_size": "string|null",// e.g. "1-10", "11-50", "Series A", "bootstrapped"
  "geographies":  ["string"],   // cities, regions, countries
  "topics":       ["string"],   // interests, tech stack, content themes
  "exclude":      ["string"],   // hard excludes
  "signals":      ["string"],   // buying / hiring / funding signals to look for
  "min_followers": null,        // integer or null
  "keywords":     ["string"]    // keyword phrases to match in bio/posts
}

Be precise. If a field is not implied by the prompt, return [] or null. No prose, no markdown. JSON only.`;

async function parseCriteria(llmClient, prompt) {
  const messages = [
    { role: 'system', content: CRITERIA_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const raw = await llmClient.chat(messages, { maxTokens: 600, temperature: 0.2 });
  return extractJson(raw);
}

function extractJson(raw) {
  let str = (raw || '').trim();
  if (str.startsWith('```')) {
    str = str.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  }
  const match = str.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('LLM did not return JSON criteria');
  return JSON.parse(match[0]);
}

module.exports = { parseCriteria, CRITERIA_SYSTEM_PROMPT };
