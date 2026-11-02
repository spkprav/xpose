// Derive identity defaults from the user's local social-wiki/me.md.
//
// me.md is gitignored — this code lives in the repo, the data does not.
// If me.md does not exist (open-source user without one), returns empty
// schema and the rest of the app keeps working with manually-entered values.
//
// Parses:
//   - YAML frontmatter (handle, display_name, location, public_product)
//   - "## Identity" section → positioning line
//   - "## Voice Rules" + "## Off-Brand" → ICP exclusion language
//   - "## What I'm shipping" → product name(s)
//   - Voice anchors → outreach_context
//   - Builder-tool keywords → search seeds
//
// Returns the same shape as lib/identity.js emptySchema().

const fs = require('fs');
const path = require('path');

const WIKI_PATH = path.resolve(__dirname, '..', 'social-wiki', 'me.md');

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) out[kv[1].trim()] = kv[2].trim();
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(text, headingPlain) {
  // Pull text under "## <heading>" up to the next "## "
  const esc = escapeRegex(headingPlain);
  const re = new RegExp(`##\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function deriveOutreachContextX(text, fm) {
  // X audience = peer builders. Voice = lowercase indie tone.
  const id = extractSection(text, 'Identity');
  const ctxLines = [];
  if (fm.display_name && fm.public_product) {
    ctxLines.push(`${fm.display_name}, indie builder shipping ${fm.public_product}.`);
  }
  const ctxMatch = id.match(/\*\*Context:\*\*\s*([^\n]+)/);
  if (ctxMatch) ctxLines.push(ctxMatch[1].trim());
  ctxLines.push('Reach out to compare notes, share a relevant tool, or learn what they are building. Voice: lowercase, specific, no em dashes, no LinkedIn-speak.');
  return ctxLines.join(' ');
}

function deriveOutreachContextLinkedin(fm) {
  // LinkedIn audience = SMB owners + non-tech buyers for mevin.ai (website
  // builder) or for AI-workflow consulting. Voice = warm + business-outcome,
  // professional but not stiff.
  const product = fm.public_product || 'a website builder';
  const name = fm.display_name || 'an indie builder';
  return [
    `${name}, builder of ${product} (a website builder that lets non-technical owners ship a premium site in minutes) and AI-workflow consultant.`,
    `I help non-technical small business owners, consultants, agencies, and service professionals (a) get a modern website without hiring an agency, and (b) set up AI workflows that save real hours per week on lead handling, content, ops, and admin.`,
    `Outreach intent: open a conversation about ONE specific time-or-money pain in their current workflow that AI + a clean web presence could solve. NOT a generic pitch. NOT a wall of features.`,
    `Voice: professional, warm, business-outcome framed (saves X hours, replaces Y manual step, modernizes Z presence). Specific, no jargon, no em dashes. End with a soft question, not a sell.`,
  ].join(' ');
}

function deriveIcpX(text) {
  // Lane A audience: AI-coding tool builders, Claude Code / Cursor / RooCode users.
  // Pillar 1 + Lane A keywords drive this. Stay grounded in the doc's language.
  const pillars = extractSection(text, 'My 3 Content Pillars (Lane A primary)')
              || extractSection(text, 'My 3 Content Pillars')
              || extractSection(text, '3 Content Pillars (Lane A primary)');
  const offBrand = extractSection(text, 'Off-Brand, Never Engage / Never Post About')
                || extractSection(text, 'Off-Brand');
  const haveLane = /Lane A/i.test(pillars);

  const parts = [];
  parts.push('Indie hackers, solo founders, and small-team builders shipping in public.');
  if (haveLane) {
    parts.push('Active on X about Claude Code, Cursor, RooCode, agentic IDEs, MCP, LLM agents, RAG, dev-tool workflows, AI productivity.');
  }
  parts.push('Above 1k followers, English-speaking, ships frequently. Bonus: builders who post screen-recorded demos + open-source repos.');
  if (offBrand) {
    parts.push('Exclude: crypto/coin shillers, US-politics, drama/dunk accounts, generic motivational coaches, MLM.');
  }
  return parts.join(' ');
}

function deriveIcpLinkedin(text, fm) {
  // BUYERS, not peer builders. Non-tech SMB owners + service professionals
  // who would (a) buy a mevin.ai website or (b) hire AI-workflow setup help.
  return [
    'Non-technical small business owners, founders, and service professionals (1-50 employees) who decide their own marketing and tools.',
    'Target verticals: real estate agents, consultants, coaches, lawyers, accountants, doctors, dentists, photographers, interior designers, wedding planners, fitness trainers, salon/spa owners, boutique e-commerce, local agencies, restaurants, real-estate developers, financial advisors, immigration consultants, education-tech operators.',
    'Also: solo operators and creators who run their own business (course creators, newsletter writers, productized-service operators, freelance consultants).',
    'Active LinkedIn posters or commenters about: "no website", "building my website", "modernizing our digital presence", "AI for my business", "automating admin", "saving time with AI", "using ChatGPT for [my profession]", "moving on from [old tool]", hiring an agency, frustration with current website/funnel/CRM.',
    'India + US + UK + UAE + Singapore + Australia + Canada. English-speaking. Decision-maker title (Owner, Founder, Director, Principal, Partner, Managing Partner).',
    'Buying signals: just launched a business, recently rebranded, hiring their first marketing/admin, posted screenshots of manual workflows, asked for tool recommendations, complained about agency costs, talked about wanting to "go digital" or "embrace AI".',
    'Exclude: software engineers, dev-tool buyers, B2B SaaS founders, recruiters, MLM, crypto promoters, generic AI influencers, agency-rep accounts.',
    'Goal of outreach: open a conversation about one concrete time/money pain their business has that a fast website + 1-2 AI workflows can solve in days, not months.',
  ].join(' ');
}

function deriveLiSearchSeeds(_text) {
  // Buyer-shaped seeds: non-tech SMB owners + service pros likely to need
  // a website OR an AI workflow setup. Per-vertical + per-intent terms run
  // through LinkedIn's People SRP, each pulls a different audience pocket.
  return [
    // Decision-maker titles
    'business owner',
    'founder small business',
    'managing partner',
    'principal consultant',
    // High-intent verticals (people, not companies)
    'real estate agent',
    'business coach',
    'marketing consultant',
    'accountant practice owner',
    'wedding planner',
    'interior designer',
    'photography studio owner',
    'fitness studio owner',
    'immigration consultant',
    'financial advisor',
    'salon owner',
    'boutique owner',
    'course creator',
    // Intent-shaped queries (catches people posting about pain)
    'AI for small business',
    'automate my business',
    'modernize website',
    'no-code AI',
    'AI workflow',
  ];
}

function deriveFromWiki() {
  if (!fs.existsSync(WIKI_PATH)) return null;
  let text;
  try { text = fs.readFileSync(WIKI_PATH, 'utf8'); }
  catch { return null; }

  const fm = parseFrontmatter(text);
  return {
    handle:        fm.handle || '',
    display_name:  fm.display_name || '',
    location:      fm.location || '',
    product:       fm.public_product || '',
    positioning:   (fm.lane || '') + (fm.narrative ? `. ${fm.narrative}` : ''),
    outreach_context: {
      x:        deriveOutreachContextX(text, fm),
      linkedin: deriveOutreachContextLinkedin(fm),
    },
    icp: {
      x:        deriveIcpX(text),
      linkedin: deriveIcpLinkedin(text, fm),
    },
    li_search_seeds: deriveLiSearchSeeds(text),
  };
}

module.exports = { deriveFromWiki, WIKI_PATH };
