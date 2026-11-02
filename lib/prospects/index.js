// Top-level orchestrator: prompt → criteria → candidates → score → save.
// Platform-agnostic; selects source by `platform` arg.

const dbops = require('./db');
const { parseCriteria } = require('./criteria');
const { scoreProspect } = require('./score');
const xSource = require('./x-source');
const liSource = require('./linkedin-source');

function pickSource(platform) {
  if (platform === 'x') return xSource;
  if (platform === 'linkedin') return liSource;
  throw new Error(`Unknown platform: ${platform}`);
}

/**
 * Run an end-to-end prospect search.
 * @param {object} opts
 * @param {string} opts.platform   - 'x' | 'linkedin'
 * @param {string} opts.prompt     - natural-language ICP
 * @param {object} opts.llmClient  - LLM client (chat() method)
 * @param {function} opts.onProgress - optional (stage, payload) => void
 * @param {number} opts.candidateLimit - max candidates to score (default 25)
 * @param {number} opts.minScore   - drop results below this fit_score (default 40)
 * @param {number} opts.minFollowers
 */
async function runSearch({
  platform,
  prompt,
  llmClient,
  onProgress = () => {},
  candidateLimit = 25,
  minScore = 40,
  minFollowers = 0,
}) {
  if (!llmClient) throw new Error('llmClient required');
  if (!platform) throw new Error('platform required');
  if (!prompt) throw new Error('prompt required');

  let searchId;
  try {
    onProgress('parsing', { prompt });
    const criteria = await parseCriteria(llmClient, prompt);
    searchId = await dbops.createSearch({ platform, prompt, criteria });
    onProgress('parsed', { searchId, criteria });

    const source = pickSource(platform);
    onProgress('candidates_loading', { searchId });
    const candidates = await source.fetchCandidates(criteria, {
      limit: candidateLimit,
      minFollowers,
    });
    onProgress('candidates_loaded', { searchId, count: candidates.length });

    let saved = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      onProgress('scoring', { searchId, i, total: candidates.length, handle: c.handle });
      try {
        const score = await scoreProspect(llmClient, criteria, c, c._recent_text || '');
        if (score.fitScore < minScore) continue;
        const prospectId = await dbops.upsertProspect(c);
        await dbops.saveSearchResult({
          searchId,
          prospectId,
          fitScore: score.fitScore,
          scoreBreakdown: score.breakdown,
          reason: score.reason,
          signals: score.signals,
        });
        saved++;
      } catch (err) {
        onProgress('score_error', { searchId, handle: c.handle, error: err.message });
      }
    }

    await dbops.completeSearch(searchId, saved);
    onProgress('done', { searchId, saved });
    return { searchId, saved, criteria };
  } catch (err) {
    if (searchId) await dbops.failSearch(searchId, err.message).catch(() => {});
    onProgress('error', { searchId, error: err.message });
    throw err;
  }
}

/**
 * Score every prospect in the DB for a given platform, no keyword pre-filter.
 * Use when the user wants to grade the full crawled pool against a single ICP,
 * not the keyword-narrowed subset that fetchCandidates produces.
 *
 * Runs `concurrency` scorer calls in parallel.
 */
async function runFullScoring({
  platform,
  prompt,
  llmClient,
  onProgress = () => {},
  concurrency = 5,
  prospectLimit = 5000,
}) {
  if (!llmClient) throw new Error('llmClient required');
  if (!platform) throw new Error('platform required');
  if (!prompt) throw new Error('prompt required');

  let searchId;
  try {
    onProgress('parsing', { prompt });
    const criteria = await parseCriteria(llmClient, prompt);
    searchId = await dbops.createSearch({ platform, prompt, criteria });
    onProgress('parsed', { searchId, criteria });

    const all = await dbops.listAllProspects(platform, { limit: prospectLimit });
    onProgress('candidates_loaded', { searchId, count: all.length });

    const queue = all.slice();
    let saved = 0;
    let done = 0;

    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (!c) break;
        try {
          const score = await scoreProspect(llmClient, criteria, c, '');
          await dbops.saveSearchResult({
            searchId,
            prospectId: c.prospect_id,
            fitScore: score.fitScore,
            scoreBreakdown: score.breakdown,
            reason: score.reason,
            signals: score.signals,
          });
          saved++;
        } catch (err) {
          onProgress('score_error', { searchId, handle: c.handle, error: err.message });
        }
        done++;
        onProgress('scoring', { searchId, i: done, total: all.length, handle: c.handle });
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    await dbops.completeSearch(searchId, saved);
    onProgress('done', { searchId, saved });
    return { searchId, saved, criteria };
  } catch (err) {
    if (searchId) await dbops.failSearch(searchId, err.message).catch(() => {});
    onProgress('error', { searchId, error: err.message });
    throw err;
  }
}

module.exports = {
  runSearch,
  runFullScoring,
  ...dbops,
  ingestLinkedinProspects: liSource.ingestProspects,
};
