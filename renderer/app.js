const { ipcRenderer } = require('electron');

// ═══════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════
let selectedProvider = 'ollama';
let settings = {};
let focusMode = false;

const PROVIDERS = [
  { id: 'ollama',      name: 'Ollama',       desc: 'Local LLM',     fields: ['baseUrl', 'model'] },
  { id: 'openrouter',  name: 'OpenRouter',   desc: 'Multi-model',   fields: ['apiKey', 'model'] },
  { id: 'glm',         name: 'GLM (Zhipu)',  desc: 'Chinese LLM',   fields: ['apiKey', 'model'] },
  { id: 'openai',      name: 'OpenAI',       desc: 'GPT models',    fields: ['apiKey', 'model'] },
];

const LIST_SLUGS = ['anchors', 'venues', 'mutuals-rising', 'high-velocity-replies', 'growth-study'];
const LIST_META = {
  'anchors':               { label: 'Anchors',                desc: 'Big-name circle accounts. Public signal. Crawl weekly for trend awareness.' },
  'venues':                { label: 'Venues',                 desc: 'Party-hosts where the circle gathers. Daily reply target.' },
  'mutuals-rising':        { label: 'Mutuals Rising',         desc: 'Mutuals showing growth signals. Daily engage to lift each other.' },
  'high-velocity-replies': { label: 'High Velocity Replies',  desc: 'Broad repliers. Daily study cadence + thread selection.' },
  'growth-study':          { label: 'Growth Study',           desc: 'Discussion-drivers with viral hits. Weekly pattern study.' },
};
let activeListSlug = null;
let listStatsCache = {};
let fetchAllQueue = [];  // slugs waiting to be opened in sequence

function collectListIds() {
  const out = {};
  LIST_SLUGS.forEach(slug => { out[slug] = ($(`#list-id-${slug}`)?.value || '').trim(); });
  return out;
}

// ═══════════════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════════════
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function initIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function showGlobalStatus(msg, durationMs = 2000) {
  const el = $('#global-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), durationMs);
}

function showCircleMessage(msg, type = 'info') {
  const el = $('#circle-summary');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? '#f87171' : '#71767b';
  setTimeout(() => {
    // Reload circle to restore real summary
    loadCircle();
  }, 4000);
}

function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatCount(n) {
  if (!n) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ═══════════════════════════════════════════════════
// Global platform mode (X / LinkedIn)
// Switches the BrowserView + sidebar tabs as a unit.
// ═══════════════════════════════════════════════════
window.activePlatform = 'x';

function tabIsForPlatform(btn, platform) {
  const list = (btn.dataset.platforms || 'x,linkedin').split(',').map(s => s.trim());
  return list.includes(platform);
}

function applyPlatformUi(platform) {
  if (platform !== 'x' && platform !== 'linkedin') return;
  window.activePlatform = platform;

  // Toggle header pills
  $$('#platform-toggle .platform-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.platform === platform);
    p.setAttribute('aria-selected', p.dataset.platform === platform ? 'true' : 'false');
  });

  // Hide tabs not applicable to active platform
  const tabs = Array.from($$('.tab-btn'));
  let activeTabStillVisible = false;
  tabs.forEach(btn => {
    const ok = tabIsForPlatform(btn, platform);
    btn.classList.toggle('hidden', !ok);
    if (ok && btn.classList.contains('active')) activeTabStillVisible = true;
  });

  // If current active tab got hidden, switch to first visible
  if (!activeTabStillVisible) {
    const firstVisible = tabs.find(b => !b.classList.contains('hidden'));
    if (firstVisible) {
      tabs.forEach(b => b.classList.remove('active'));
      firstVisible.classList.add('active');
      $$('.panel').forEach(p => p.classList.add('hidden'));
      $(`#panel-${firstVisible.dataset.tab}`)?.classList.remove('hidden');
    }
  }

  // Sync Prospects to current platform if it's loaded
  if (typeof syncProspectsToPlatform === 'function') {
    syncProspectsToPlatform(platform);
  }

  // Filter any element tagged data-platforms (workflow cards, toolbar buttons, etc.)
  document.querySelectorAll('[data-platforms]').forEach(el => {
    const list = (el.dataset.platforms || 'x,linkedin').split(',').map(s => s.trim());
    el.classList.toggle('hidden', !list.includes(platform));
  });
}

$$('#platform-toggle .platform-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const platform = pill.dataset.platform;
    if (platform === window.activePlatform) return;
    ipcRenderer.send('set-platform', { platform });
    // Optimistic UI update — main will confirm with platform-changed.
    applyPlatformUi(platform);
  });
});

ipcRenderer.on('platform-changed', (_e, { platform }) => {
  applyPlatformUi(platform);
});

// Ask main for the persisted platform on boot.
ipcRenderer.send('get-platform');

// ═══════════════════════════════════════════════════
// Tab navigation
// ═══════════════════════════════════════════════════
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.panel').forEach(p => p.classList.add('hidden'));
    $(`#panel-${btn.dataset.tab}`)?.classList.remove('hidden');
  });
});

// ═══════════════════════════════════════════════════
// Live tab
// ═══════════════════════════════════════════════════
let liveStatus = null;
let liveClockTimer = null;

function formatLiveRemaining(nextAt) {
  if (!nextAt) return '';
  const sec = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function livePhaseLabel(phase) {
  const labels = {
    off: 'off',
    idle: 'idle, watching the network',
    waiting: 'waiting for the view',
    home: 'home, today and what is happening',
    scroll: 'scrolling home',
    'who-to-follow': 'who to follow',
    explore: 'explore',
    news: 'explore news',
    passive: 'watching the network',
  };
  return labels[phase] || phase || 'off';
}

function renderLive(status) {
  liveStatus = status || liveStatus;
  if (!liveStatus) return;
  const btn = $('#btn-live-play');
  const next = $('#live-next');
  const strip = $('#live-strip');
  const stripText = $('#live-strip-text');
  const counts = $('#live-counts');
  const errEl = $('#live-error');
  const logEl = $('#live-log');
  const recentEl = $('#live-recent');
  if (!btn) return;

  const on = !!liveStatus.running;
  btn.textContent = on ? 'On' : 'Play';
  btn.classList.toggle('live-on', on);
  btn.title = on ? 'Click to stop' : 'Start capturing';

  if (next) {
    if (!on) next.textContent = 'off';
    else if (liveStatus.phase === 'waiting') next.textContent = 'retry soon';
    else if (liveStatus.nextAt) next.textContent = `next pass ${formatLiveRemaining(liveStatus.nextAt)}`;
    else next.textContent = 'pass running';
  }

  if (strip && stripText) {
    strip.classList.toggle('hidden', !on);
    stripText.textContent = on ? livePhaseLabel(liveStatus.phase) : '';
  }

  const c = liveStatus.counts || {};
  if (counts) {
    counts.textContent = `${c.tweets || 0} tweets · ${c.people || 0} people · ${c.news || 0} news · ${c.trends || 0} trends`;
  }

  if (errEl) {
    if (liveStatus.lastError) {
      errEl.textContent = liveStatus.lastError;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
  }

  if (logEl) {
    const lines = (liveStatus.log || []).slice().reverse();
    logEl.innerHTML = lines.length
      ? lines.map(line => `<div class="live-log-row"><span class="live-log-time">${escapeHtml(line.t)}</span>${escapeHtml(line.text)}</div>`).join('')
      : '<div class="live-log-row"><span class="live-log-time"> </span>nothing yet</div>';
  }

  if (recentEl) {
    const kindLabel = { who_to_follow: 'who to follow', trend: 'trend', news: 'news' };
    const rows = liveStatus.recent || [];
    recentEl.innerHTML = rows.length
      ? rows.slice().reverse().map(row => `
          <div class="live-signal-row">
            <span class="live-kind">${escapeHtml(kindLabel[row.kind] || row.kind || '')}</span>
            <div>${escapeHtml(row.title || '')}</div>
            ${row.detail ? `<div class="text-x-text-secondary">${escapeHtml(row.detail)}</div>` : ''}
          </div>
        `).join('')
      : '<div class="live-signal-row text-x-text-secondary">people, trends, and headlines show up here</div>';
  }
}

$('#btn-live-play')?.addEventListener('click', () => {
  const on = !$('#btn-live-play').classList.contains('live-on');
  ipcRenderer.send('live-play', { on });
});

ipcRenderer.on('live-status', (_event, status) => {
  renderLive(status);
});

ipcRenderer.send('live-get');
liveClockTimer = setInterval(() => {
  if (!liveStatus?.running || !liveStatus.nextAt) return;
  const next = $('#live-next');
  if (next) next.textContent = `next pass ${formatLiveRemaining(liveStatus.nextAt)}`;
}, 1000);

// ═══════════════════════════════════════════════════
// Header utilities
// ═══════════════════════════════════════════════════
$('#btn-reload').addEventListener('click', () => {
  ipcRenderer.send('reload-twitter-view');
  showGlobalStatus('Reloading...');
});

$('#btn-copy-url').addEventListener('click', () => {
  ipcRenderer.send('get-current-url');
});

ipcRenderer.on('current-url', (event, url) => {
  navigator.clipboard.writeText(url);
  showGlobalStatus('URL copied');
});

$('#btn-focus-mode').addEventListener('click', () => {
  ipcRenderer.send('toggle-focus-mode');
});

ipcRenderer.on('focus-mode-changed', (event, newFocusMode) => {
  focusMode = newFocusMode;
  const sidebar = $('#sidebar');
  const icon = $('#btn-focus-mode i');
  if (focusMode) {
    sidebar.style.width = 'calc(100% - 375px)';
    icon?.setAttribute('data-lucide', 'minimize-2');
  } else {
    sidebar.style.width = '320px';
    icon?.setAttribute('data-lucide', 'maximize-2');
  }
  initIcons();
});

// ═══════════════════════════════════════════════════
// CIRCLE PANEL
// ═══════════════════════════════════════════════════

// Setup drawer toggle
let setupOpen = false;
$('#btn-toggle-setup').addEventListener('click', () => {
  setupOpen = !setupOpen;
  const drawer = $('#circle-setup');
  if (setupOpen) {
    drawer.classList.remove('hidden');
    $('#btn-toggle-setup').style.color = '#e7e9ea';
  } else {
    drawer.classList.add('hidden');
    $('#btn-toggle-setup').style.color = '';
  }
});

// File browse
$('#btn-browse-import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.js';
  input.onchange = (e) => {
    if (e.target.files[0]) {
      $('#import-file-path').value = e.target.files[0].path;
    }
  };
  input.click();
});

// Import
$('#btn-import-circle').addEventListener('click', () => {
  const filePath = $('#import-file-path').value.trim();
  const type = $('#import-type').value;
  if (!filePath) {
    $('#import-status').textContent = 'Select a file first';
    return;
  }
  $('#import-status').textContent = 'Importing...';
  ipcRenderer.send('import-social-circle', { filePath, type });
});

ipcRenderer.on('social-circle-imported', (event, { success, imported, enrichmentQueued, error }) => {
  const el = $('#import-status');
  if (success) {
    el.textContent = `${imported} accounts imported. ${enrichmentQueued} queued for enrichment.`;
    el.style.color = '#34d399';
    loadCircle();
    // Collapse the drawer after successful import
    setTimeout(() => {
      setupOpen = false;
      $('#circle-setup').classList.add('hidden');
      $('#btn-toggle-setup').style.color = '';
    }, 2000);
  } else {
    el.textContent = error || 'Import failed';
    el.style.color = '#f87171';
  }
});

// Recompute mutuals from existing DB data
$('#btn-recompute-mutuals').addEventListener('click', async () => {
  const btn = $('#btn-recompute-mutuals');
  btn.textContent = 'Computing...';
  btn.style.pointerEvents = 'none';
  ipcRenderer.send('recompute-mutuals');
});

ipcRenderer.on('mutuals-recomputed', (event, { success, count, error }) => {
  const btn = $('#btn-recompute-mutuals');
  btn.textContent = '↻ Recompute mutuals from DB';
  btn.style.pointerEvents = '';
  if (success) {
    $('#import-status').textContent = `${count} mutuals found`;
    $('#import-status').style.color = '#34d399';
    loadCircle();
  } else {
    $('#import-status').textContent = error || 'Failed';
    $('#import-status').style.color = '#f87171';
  }
});

// Live import from X (followers + following pages)
$('#btn-import-from-twitter').addEventListener('click', () => {
  const btn = $('#btn-import-from-twitter');
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';
  $('#import-status').textContent = 'Crawling followers + following pages...';
  $('#import-status').style.color = '';
  ipcRenderer.send('import-from-twitter');
});

ipcRenderer.on('twitter-import-status', (event, { success, progress, screenName, saved, followers, following, error }) => {
  const btn = $('#btn-import-from-twitter');
  const el = $('#import-status');

  if (progress) {
    el.textContent = progress;
    el.style.color = '#71767b';
    return; // keep button disabled during progress
  }

  btn.style.opacity = '';
  btn.style.pointerEvents = '';

  if (success) {
    el.textContent = `Done. ${followers} followers, ${following} following saved`;
    el.style.color = '#34d399';
    loadCircle();
  } else {
    el.textContent = error || 'Failed';
    el.style.color = '#f87171';
  }
});

// Crawl chip group. multi-select toggle
$$('.crawl-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
  });
});

// Crawl button
$('#btn-crawl-start').addEventListener('click', () => {
  const selected = [...$$('.crawl-chip.active')].map(c => c.dataset.crawlRel).filter(Boolean);
  if (selected.length === 0) {
    showCircleMessage('Select at least one group to crawl');
    return;
  }
  const btn = $('#btn-crawl-start');
  btn.disabled = true;
  btn.textContent = 'Queuing...';

  ipcRenderer.send('queue-circle-crawl', { relationships: selected });

  btn._resetTimer = setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Crawl';
    showCircleMessage('DB unreachable. check DB host', 'error');
  }, 12000);
});

ipcRenderer.on('circle-crawl-queued', (event, { success, queued, error }) => {
  const btn = $('#btn-crawl-start');
  if (btn) {
    clearTimeout(btn._resetTimer);
    btn.disabled = false;
    btn.textContent = 'Crawl';
  }

  if (success && queued > 0) {
    showCircleMessage(`${queued} profiles queued`);
    ipcRenderer.send('start-crawl', { mode: 'user_tweets' });
    $('#crawl-strip').classList.remove('hidden');
  } else if (success && queued === 0) {
    setupOpen = false;
    $('#btn-toggle-setup').click();
    showCircleMessage('No profiles found. import circle first');
  } else {
    showCircleMessage(error || 'Failed to queue crawl', 'error');
  }
});

// Pause/resume
$('#btn-pause-crawl').addEventListener('click', () => {
  ipcRenderer.send('pause-crawl');
  $('#btn-pause-crawl').classList.add('hidden');
  $('#btn-resume-crawl').classList.remove('hidden');
});

$('#btn-resume-crawl').addEventListener('click', () => {
  ipcRenderer.send('resume-crawl');
  $('#btn-resume-crawl').classList.add('hidden');
  $('#btn-pause-crawl').classList.remove('hidden');
});

// Auto-refresh feed when new tweets come in
ipcRenderer.on('feed-refresh-available', () => {
  if (activeSubtab === 'feed') loadFeed();
});

ipcRenderer.on('crawl-status', (event, status) => {
  const strip = $('#crawl-strip');
  const text = $('#crawl-strip-text');
  const btn = $('#btn-crawl-all');

  if (status.state === 'idle') {
    strip.classList.add('hidden');
    btn.textContent = 'Crawl all';
    btn.style.pointerEvents = '';
    loadCircle(); // Refresh list after crawl completes
    return;
  }

  if (status.state === 'paused') {
    strip.classList.remove('hidden');
    text.textContent = 'Paused';
    return;
  }

  if (status.currentProfile) {
    strip.classList.remove('hidden');
    const left = status.queueLength || 0;
    const saved = status.totalSaved || 0;
    const profiles = status.totalProfiles || 0;
    const full = `@${status.currentProfile} · ${left} left · ${saved} tweets from ${profiles} profiles`;
    text.textContent = full;
    strip.title = full;
  }
});

// Load and render circle
function loadCircle() {
  ipcRenderer.send('load-social-circle');
}

ipcRenderer.on('social-circle-loaded', (event, { success, circle, stats }) => {
  if (!success || !circle) return;

  // Update summary line
  const total = circle.length;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const crawledRecent = circle.filter(m => m.last_crawled_at && new Date(m.last_crawled_at) >= cutoff).length;
  const crawledTotal = circle.filter(m => m.last_crawled_at).length;
  const summaryEl = $('#circle-summary');
  if (summaryEl) {
    summaryEl.textContent = total
      ? `${total} members · ${crawledRecent} fresh · ${crawledTotal} ever`
      : 'No circle yet';
  }

  renderCircleList(circle);
});

function renderCircleList(members) {
  const el = $('#circle-list');
  if (!el) return;

  if (!members || members.length === 0) {
    el.innerHTML = `<p class="p-4 text-xs text-x-text-secondary text-center leading-relaxed">Import follower.js or following.js<br>from your Twitter data export.</p>`;
    return;
  }

  el.innerHTML = members.map(m => {
    const name = m.screen_name || m.user_id || '?';
    const dotClass = { mutual: 'mutual', following: 'following', follower: 'follower', '2nd_degree': 'second' }[m.relationship] || 'follower';
    const relLabel = m.relationship === '2nd_degree' ? '2°' : m.relationship;
    const count = formatCount(m.followers_count);
    const crawled = m.last_crawled_at;
    return `
      <div class="member-row">
        <span class="rel-dot ${dotClass}"></span>
        <span class="member-handle">@${escapeHtml(name)}</span>
        <span class="member-rel">${relLabel}</span>
        ${count ? `<span class="member-count">${count}</span>` : ''}
        <span class="member-crawled ${crawled ? '' : 'empty'}">${crawled ? '✓' : '–'}</span>
      </div>
    `;
  }).join('');
}

// ── Sub-tabs: Members | Feed ──────────────────────
let activeSubtab = 'members';

$$('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.subtab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSubtab = btn.dataset.subtab;

    if (activeSubtab === 'feed') {
      $('#circle-list').classList.add('hidden');
      $('#circle-feed').classList.remove('hidden');
      $('#feed-filters').classList.remove('hidden');
      $('#btn-refresh-feed').style.display = '';
      loadFeed();
    } else {
      $('#circle-feed').classList.add('hidden');
      $('#feed-filters').classList.add('hidden');
      $('#btn-refresh-feed').style.display = 'none';
      $('#circle-list').classList.remove('hidden');
    }
  });
});

// ── Feed filters ──────────────────────────────────
let feedFilters = { relationship: 'all', days: 90, sort: 'engagement' };

function setFilterActive(group, value) {
  $$(`[data-${group}]`).forEach(b => b.classList.remove('active'));
  $(`[data-${group}="${value}"]`)?.classList.add('active');
}

$$('[data-rel]').forEach(btn => {
  btn.addEventListener('click', () => {
    feedFilters.relationship = btn.dataset.rel;
    setFilterActive('rel', btn.dataset.rel);
    loadFeed();
  });
});

$$('[data-days]').forEach(btn => {
  btn.addEventListener('click', () => {
    feedFilters.days = parseFloat(btn.dataset.days);
    setFilterActive('days', btn.dataset.days);
    loadFeed();
  });
});

$$('[data-sort]').forEach(btn => {
  btn.addEventListener('click', () => {
    feedFilters.sort = btn.dataset.sort;
    setFilterActive('sort', btn.dataset.sort);
    loadFeed();
  });
});

function loadFeed() {
  const el = $('#circle-feed');
  el.innerHTML = '<p class="p-4 text-xs text-x-text-secondary text-center">Loading...</p>';
  ipcRenderer.send('load-circle-feed', feedFilters);
}

$('#btn-refresh-feed').addEventListener('click', () => {
  const btn = $('#btn-refresh-feed');
  btn.style.opacity = '0.3';
  btn.style.pointerEvents = 'none';
  loadFeed();
  setTimeout(() => { btn.style.opacity = ''; btn.style.pointerEvents = ''; }, 1000);
});

ipcRenderer.on('circle-feed-loaded', (event, { success, feed, error }) => {
  $('#btn-refresh-feed').style.opacity = '';
  $('#btn-refresh-feed').style.pointerEvents = '';
  const el = $('#circle-feed');
  if (!el) return;
  if (!success) {
    el.innerHTML = `<p class="p-4 text-xs text-red-400 text-center">${error}</p>`;
    return;
  }

  if (!feed || feed.length === 0) {
    el.innerHTML = `<p class="p-4 text-xs text-x-text-secondary text-center leading-relaxed">No tweets yet.<br>Run "Crawl all" to collect circle tweets.</p>`;
    return;
  }

  el.innerHTML = feed.map(t => renderFeedCard(t)).join('');
  initIcons();
});

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderFeedCard(t) {
  const dotClass = { mutual: 'mutual', following: 'following', follower: 'follower', '2nd_degree': 'second' }[t.relationship] || 'follower';
  const score = (t.like_count || 0) + (t.retweet_count || 0) * 2 + (t.quote_count || 0) * 3;
  const hot = score >= 20;
  return `
    <div class="feed-card">
      <div class="feed-card-header">
        <span class="rel-dot ${dotClass}"></span>
        <span class="feed-handle">@${escapeHtml(t.screen_name)}</span>
        <span class="feed-time">${timeAgo(t.created_at)}</span>
      </div>
      <p class="feed-text">${escapeHtml(t.text)}</p>
      <div class="feed-stats">
        ${t.like_count ? `<span class="feed-stat ${hot ? 'hot' : ''}">♥ ${formatCount(t.like_count)}</span>` : ''}
        ${t.retweet_count ? `<span class="feed-stat">↺ ${formatCount(t.retweet_count)}</span>` : ''}
        ${t.reply_count ? `<span class="feed-stat">💬 ${formatCount(t.reply_count)}</span>` : ''}
        ${t.view_count ? `<span class="feed-stat">👁 ${formatCount(t.view_count)}</span>` : ''}
      </div>
    </div>
  `;
}

// Auto-load circle on startup
loadCircle();

// ═══════════════════════════════════════════════════
// DRAFTS PANEL
// ═══════════════════════════════════════════════════

let _drafts = [];

$('#btn-generate-drafts').addEventListener('click', () => {
  const btn = $('#btn-generate-drafts');
  const status = $('#drafts-status');
  btn.disabled = true;
  btn.textContent = 'Assembling context...';
  status.textContent = '';
  status.classList.remove('hidden');
  ipcRenderer.send('generate-drafts', {});
});

ipcRenderer.on('drafts-generating', (event, { status: msg }) => {
  const status = $('#drafts-status');
  status.textContent = msg;
  status.classList.remove('hidden');
});

ipcRenderer.on('drafts-generated', (event, { success, drafts, error }) => {
  const btn = $('#btn-generate-drafts');
  const status = $('#drafts-status');
  btn.disabled = false;
  btn.textContent = 'Generate from circle';

  if (!success) {
    status.textContent = error || 'Generation failed';
    status.style.color = '#f87171';
    status.classList.remove('hidden');
    return;
  }

  status.textContent = `${drafts.length} drafts ready`;
  status.style.color = '#34d399';
  setTimeout(() => status.classList.add('hidden'), 3000);
  renderDrafts(drafts);
});

$('#btn-load-drafts').addEventListener('click', () => {
  ipcRenderer.send('load-drafts');
});

ipcRenderer.on('drafts-loaded', (event, { success, drafts }) => {
  if (success && drafts) renderDrafts(drafts);
});

function formatDraftTime(ts) {
  if (!ts) return 'Tue 22:00 IST';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' IST';
  } catch {
    return 'Tue 22:00 IST';
  }
}

function renderDrafts(drafts) {
  _drafts = drafts || [];
  const el = $('#drafts-list');
  if (!el) return;

  if (!_drafts.length) {
    el.innerHTML = `<p class="text-xs text-x-text-secondary text-center mt-8 px-6">No drafts yet. Generate from circle.</p>`;
    return;
  }

  el.innerHTML = _drafts.map((d, i) => {
    const isApproved = d.status === 'approved';
    const dotClass = isApproved ? 'approved' : (d.status === 'discarded' ? 'discarded' : '');
    const timeLabel = d.optimal_time || formatDraftTime(d.suggested_post_time);
    const angle = d.angle || '';
    return `
      <div class="draft-card" data-draft-id="${d.id || i}" data-index="${i}">
        <p class="draft-text">${escapeHtml(d.draft_text || d.text || '')}</p>
        <div class="draft-meta">
          <span class="draft-status-dot ${dotClass}"></span>
          <span>${timeLabel}</span>
          ${angle ? `<span class="draft-meta-sep"></span><span>${escapeHtml(angle)}</span>` : ''}
        </div>
        <div class="draft-actions">
          <button class="draft-action-btn copy" onclick="copyDraft(${i})">Copy</button>
          <button class="draft-action-btn approve" onclick="approveDraft('${d.id}', this)" ${isApproved ? 'style="color:#34d399;border-color:#34d399"' : ''}>
            ${isApproved ? 'Approved' : 'Approve'}
          </button>
          <button class="draft-action-btn discard" onclick="discardDraft('${d.id}', this)">Discard</button>
        </div>
      </div>
    `;
  }).join('');
}

window.copyDraft = function(index) {
  const d = _drafts[index];
  if (!d) return;
  navigator.clipboard.writeText(d.draft_text || d.text || '');
  showGlobalStatus('Copied to clipboard');
};

window.approveDraft = function(id, btn) {
  if (!id) return;
  ipcRenderer.send('update-draft', { id, status: 'approved' });
  btn.textContent = 'Approved';
  btn.style.color = '#34d399';
  btn.style.borderColor = '#34d399';
  // Update dot
  const card = btn.closest('.draft-card');
  card?.querySelector('.draft-status-dot')?.classList.add('approved');
};

window.discardDraft = function(id, btn) {
  if (!id) return;
  ipcRenderer.send('update-draft', { id, status: 'discarded' });
  btn.closest('.draft-card')?.remove();
};

ipcRenderer.on('draft-updated', () => {});

$('#btn-export-wiki').addEventListener('click', () => {
  const btn = $('#btn-export-wiki');
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';
  ipcRenderer.send('export-wiki');
});

ipcRenderer.on('wiki-exported', (event, { success, paths, error }) => {
  const btn = $('#btn-export-wiki');
  btn.style.opacity = '';
  btn.style.pointerEvents = '';
  showGlobalStatus(success ? `Wiki exported (${paths?.length || 0} files)` : `Export failed: ${error}`);
});

// ═══════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════

let providerInputs = {};

function getInputValue(providerId, field) {
  return providerInputs[providerId]?.[field] ?? settings[providerId]?.[field] ?? '';
}

function collectCurrentInputs() {
  PROVIDERS.forEach(p => {
    if (!providerInputs[p.id]) providerInputs[p.id] = {};
    p.fields.forEach(f => {
      const input = $(`#${p.id}-${f}`);
      if (input) providerInputs[p.id][f] = input.value;
    });
  });
}

function renderProviders() {
  const list = $('#provider-list');
  if (!list) return;
  list.innerHTML = PROVIDERS.map(p => `
    <div class="provider-card ${selectedProvider === p.id ? 'selected' : ''}" data-provider="${p.id}">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-medium text-x-text">${p.name}</p>
          <p class="text-xs text-x-text-secondary">${p.desc}</p>
        </div>
        <div class="w-3.5 h-3.5 rounded-full border-2 ${selectedProvider === p.id ? 'bg-x-accent border-x-accent' : 'border-x-border'}"></div>
      </div>
      <div class="mt-2.5 space-y-1.5 ${selectedProvider === p.id ? '' : 'hidden'}" id="config-${p.id}">
        ${p.fields.map(f => `
          <input type="${f === 'apiKey' ? 'password' : 'text'}"
            id="${p.id}-${f}"
            placeholder="${f === 'apiKey' ? 'API Key' : f === 'baseUrl' ? 'http://localhost:11434' : 'Model name'}"
            value="${escapeHtml(getInputValue(p.id, f))}"
            class="sb-input w-full">
        `).join('')}
      </div>
    </div>
  `).join('');

  $$('.provider-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      collectCurrentInputs();
      selectedProvider = card.dataset.provider;
      renderProviders();
    });
  });
}

ipcRenderer.send('get-settings');

ipcRenderer.on('settings-loaded', (event, loaded) => {
  settings = loaded;
  selectedProvider = settings.llmProvider || 'ollama';
  providerInputs = {};
  if ($('#icp-criteria')) $('#icp-criteria').value = settings.icpCriteria || '';
  if ($('#feed-links'))   $('#feed-links').value   = settings.feedLinks   || '';
  // database fields
  const db = settings.database || {};
  if ($('#db-host'))     $('#db-host').value     = db.host     || 'localhost';
  if ($('#db-port'))     $('#db-port').value     = db.port     != null ? db.port : 5432;
  if ($('#db-user'))     $('#db-user').value     = db.user     || 'postgres';
  if ($('#db-password')) $('#db-password').value = db.password || 'postgres';
  if ($('#db-database')) $('#db-database').value = db.database || 'xpose';
  const listIds = settings.lists || {};
  LIST_SLUGS.forEach(slug => {
    const el = $(`#list-id-${slug}`);
    if (el) el.value = listIds[slug] || '';
  });
  // Auto-crawl scheduler fields
  const ac = settings.listAutoCrawl || {};
  if ($('#auto-crawl-enabled'))    $('#auto-crawl-enabled').checked  = !!ac.enabled;
  if ($('#auto-crawl-running'))    $('#auto-crawl-running').checked  = !!ac.running;
  if ($('#auto-crawl-interval'))   $('#auto-crawl-interval').value   = ac.intervalMinutes || 60;
  if ($('#auto-crawl-start-time')) $('#auto-crawl-start-time').value = ac.startTime || '';
  // Scoring provider
  const sp = settings.scoringProvider || 'ollama';
  const spOllama = $('#scoring-provider-ollama');
  const spOpen   = $('#scoring-provider-openrouter');
  if (spOllama) spOllama.checked = sp === 'ollama';
  if (spOpen)   spOpen.checked   = sp === 'openrouter';
  if ($('#scoring-openrouter-model')) $('#scoring-openrouter-model').value = settings.scoringOpenrouterModel || 'google/gemini-2.5-flash';
  // Telegram
  const tg = settings.telegram || {};
  if ($('#telegram-enabled'))       $('#telegram-enabled').checked       = !!tg.enabled;
  if ($('#telegram-bot-token'))     $('#telegram-bot-token').value       = tg.botToken || '';
  if ($('#telegram-chat-id'))       $('#telegram-chat-id').value         = tg.chatId   || '';
  if ($('#telegram-min-score'))     $('#telegram-min-score').value       = tg.minScore != null ? tg.minScore : 60;
  if ($('#telegram-max-per-crawl')) $('#telegram-max-per-crawl').value   = tg.maxPerCrawl != null ? tg.maxPerCrawl : 10;
  if ($('#telegram-hours-window'))  $('#telegram-hours-window').value    = tg.hoursWindow != null ? tg.hoursWindow : 3;
  renderListCards();
  renderProviders();
  renderAutoCrawlButton();
  if (settings.profile) {
    $('#profile-info')?.classList.remove('hidden');
    if ($('#profile-name'))   $('#profile-name').textContent   = settings.profile.name || '';
    if ($('#profile-handle')) $('#profile-handle').textContent = `@${settings.profile.screen_name}`;
  }
});

function collectScoringProvider() {
  const el = document.querySelector('input[name="scoring-provider"]:checked');
  return (el && el.value) || 'ollama';
}

function collectAutoCrawl() {
  const raw = ($('#auto-crawl-start-time')?.value || '').trim();
  // <input type=time> returns "HH:MM" or empty.
  const startTime = /^\d{1,2}:\d{2}$/.test(raw) ? raw : '';
  return {
    enabled: !!$('#auto-crawl-enabled')?.checked,
    running: !!$('#auto-crawl-running')?.checked,
    intervalMinutes: Math.max(5, Number($('#auto-crawl-interval')?.value) || 60),
    startTime,
  };
}

function collectTelegram() {
  return {
    enabled:     !!$('#telegram-enabled')?.checked,
    botToken:    $('#telegram-bot-token')?.value || '',
    chatId:      $('#telegram-chat-id')?.value   || '',
    minScore:    Math.max(0, Math.min(100, Number($('#telegram-min-score')?.value) || 60)),
    maxPerCrawl: Math.max(1, Number($('#telegram-max-per-crawl')?.value) || 10),
    hoursWindow: Math.max(1, Number($('#telegram-hours-window')?.value) || 3),
  };
}

$('#btn-save-settings').addEventListener('click', () => {
  collectCurrentInputs();
  const newSettings = {
    llmProvider: selectedProvider,
    scoringProvider: collectScoringProvider(),
    scoringOpenrouterModel: ($('#scoring-openrouter-model')?.value || '').trim() || 'google/gemini-2.5-flash',
    icpCriteria: $('#icp-criteria')?.value || '',
    feedLinks:   $('#feed-links')?.value   || '',
    database: {
      host:     $('#db-host')?.value     || 'localhost',
      port:     Number($('#db-port')?.value) || 5432,
      user:     $('#db-user')?.value     || 'postgres',
      password: $('#db-password')?.value || 'postgres',
      database: $('#db-database')?.value || 'xpose',
    },
    lists: collectListIds(),
    listAutoCrawl: collectAutoCrawl(),
    telegram: collectTelegram(),
  };
  PROVIDERS.forEach(p => {
    newSettings[p.id] = {};
    p.fields.forEach(f => { newSettings[p.id][f] = getInputValue(p.id, f); });
  });
  ipcRenderer.send('save-settings', newSettings);
});

ipcRenderer.on('settings-saved', (event, success) => {
  const el = $('#settings-status');
  if (el) {
    el.textContent = success ? 'Saved' : 'Failed to save';
    el.style.color  = success ? '#34d399' : '#f87171';
    setTimeout(() => { el.textContent = ''; }, 2000);
  }
  if (success) {
    collectCurrentInputs();
    PROVIDERS.forEach(p => { settings[p.id] = { ...providerInputs[p.id] }; });
    settings.llmProvider  = selectedProvider;
    settings.scoringProvider = collectScoringProvider();
    settings.scoringOpenrouterModel = ($('#scoring-openrouter-model')?.value || '').trim() || 'google/gemini-2.5-flash';
    settings.icpCriteria  = $('#icp-criteria')?.value || '';
    settings.feedLinks    = $('#feed-links')?.value   || '';
    settings.database = {
      host:     $('#db-host')?.value     || 'localhost',
      port:     Number($('#db-port')?.value) || 5432,
      user:     $('#db-user')?.value     || 'postgres',
      password: $('#db-password')?.value || 'postgres',
      database: $('#db-database')?.value || 'xpose',
    };
    settings.lists = collectListIds();
    settings.listAutoCrawl = collectAutoCrawl();
    settings.telegram = collectTelegram();
    renderListCards();
    renderAutoCrawlButton();
    providerInputs = {};
  }
});

// ─── Auto-crawl play/pause button + status ───────────────────────────────
function renderAutoCrawlButton() {
  const btn = $('#btn-auto-crawl-toggle');
  const nextEl = $('#auto-crawl-next');
  if (!btn) return;
  const ac = settings.listAutoCrawl || {};
  const enabled = !!ac.enabled;
  const running = !!ac.running;
  // Disabled: show greyed play, click = nudge user to settings.
  // Enabled+running: pause icon. Enabled+paused: play icon.
  const icon = (enabled && running) ? 'pause' : 'play';
  btn.innerHTML = `<i data-lucide="${icon}" class="w-3.5 h-3.5"></i>`;
  btn.title = !enabled
    ? 'Auto-crawl is disabled. Enable in Settings.'
    : running
      ? `Auto-crawl running (${ac.intervalMinutes || 60}m). Click to pause.`
      : `Auto-crawl paused. Click to resume.`;
  btn.style.opacity = enabled ? '1' : '0.45';
  if (nextEl) nextEl.textContent = '';
  if (window.lucide) window.lucide.createIcons();
}

function formatCountdown(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `next in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `next in ${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm ? `next in ${h}h ${rm}m` : `next in ${h}h`;
}

function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

$('#btn-auto-crawl-toggle')?.addEventListener('click', () => {
  const ac = settings.listAutoCrawl || {};
  if (!ac.enabled) {
    showGlobalStatus('Enable auto-crawl in Settings first');
    return;
  }
  const nextRunning = !ac.running;
  settings.listAutoCrawl = { ...ac, running: nextRunning };
  ipcRenderer.send('set-list-auto-crawl', { running: nextRunning });
  renderAutoCrawlButton();
  showGlobalStatus(nextRunning ? 'Auto-crawl resumed' : 'Auto-crawl paused', 1500);
});

let autoCrawlStatusCache = null;
ipcRenderer.on('list-auto-crawl-status', (event, status) => {
  if (!status) return;
  autoCrawlStatusCache = status;
  settings.listAutoCrawl = {
    ...(settings.listAutoCrawl || {}),
    enabled: !!status.enabled,
    running: !!status.running,
    intervalMinutes: status.intervalMinutes || 60,
    startTime: status.startTime || '',
  };
  renderAutoCrawlButton();
  renderAutoCrawlCountdown();
});

function renderAutoCrawlCountdown() {
  const nextEl = $('#auto-crawl-next');
  if (!nextEl) return;
  const s = autoCrawlStatusCache;
  if (!s || !s.enabled || !s.running || !s.nextAt) { nextEl.textContent = ''; return; }
  const remain = s.nextAt - Date.now();
  const cd = formatCountdown(remain);
  const at = formatClock(s.nextAt);
  nextEl.textContent = remain > 0 ? `${cd} (${at})` : `firing… (${at})`;
}

// Tick locally every 10s so the countdown stays fresh without main.js round-trips.
setInterval(renderAutoCrawlCountdown, 10 * 1000);
// Resync from main once a minute so the cached nextAt corrects after a fire.
setInterval(() => {
  const ac = settings.listAutoCrawl || {};
  if (ac.enabled && ac.running) ipcRenderer.send('get-list-auto-crawl-status');
}, 60 * 1000);

// ─── Telegram test ───────────────────────────────────────────────────────
$('#btn-telegram-test')?.addEventListener('click', () => {
  const btn = $('#btn-telegram-test');
  const status = $('#telegram-test-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (status) status.textContent = '';
  // Save current form values so the test uses what's on screen, not stale settings.
  const tg = collectTelegram();
  ipcRenderer.send('save-settings', { ...settings, telegram: tg });
  // Settings save is fire-and-forget; wait briefly then test.
  setTimeout(() => ipcRenderer.send('telegram-test'), 200);
});

ipcRenderer.on('telegram-test-result', (event, res) => {
  const btn = $('#btn-telegram-test');
  const status = $('#telegram-test-status');
  if (btn) { btn.disabled = false; btn.textContent = 'Send test message'; }
  if (status) {
    if (res?.success) {
      status.textContent = `OK. Bot @${res.username}. Check your chat.`;
      status.style.color = '#34d399';
    } else {
      status.textContent = `Failed: ${res?.error || 'unknown error'}`;
      status.style.color = '#f87171';
    }
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 6000);
  }
});

$('#btn-fetch-profile').addEventListener('click', () => {
  $('#btn-fetch-profile').textContent = 'Fetching...';
  $('#btn-fetch-profile').disabled = true;
  ipcRenderer.send('fetch-profile');
});

ipcRenderer.on('profile-fetched', (event, profile) => {
  const btn = $('#btn-fetch-profile');
  btn.textContent = 'Fetch from X';
  btn.disabled = false;
  if (profile) {
    settings.profile = profile;
    $('#profile-info')?.classList.remove('hidden');
    if ($('#profile-name'))   $('#profile-name').textContent   = profile.name || '';
    if ($('#profile-handle')) $('#profile-handle').textContent = `@${profile.screen_name}`;
  }
});

$('#btn-generate-icp')?.addEventListener('click', () => {
  if (!settings.llmProvider || (!settings[settings.llmProvider]?.apiKey && settings.llmProvider !== 'ollama')) {
    showGlobalStatus('Configure LLM provider first');
    return;
  }
  $('#btn-generate-icp').textContent = 'Generating...';
  $('#btn-generate-icp').disabled = true;
  if ($('#icp-status')) $('#icp-status').textContent = 'Navigating to profile...';
  ipcRenderer.send('generate-icp');
});

ipcRenderer.on('icp-generating', (event, message) => {
  if ($('#icp-status')) $('#icp-status').textContent = message;
});

ipcRenderer.on('icp-generated', (event, { icp, error }) => {
  const btn = $('#btn-generate-icp');
  btn.disabled = false;
  btn.textContent = 'Generate from Profile';
  const status = $('#icp-status');
  if (error) {
    if (status) { status.textContent = error; status.style.color = '#f87171'; }
    return;
  }
  if ($('#icp-criteria')) $('#icp-criteria').value = icp;
  if (status) { status.textContent = 'Done. review and save.'; status.style.color = '#34d399'; }
  setTimeout(() => { if (status) status.textContent = ''; }, 3000);
});

// ═══════════════════════════════════════════════════
// Crawl tab — Deep crawl wiring
// ═══════════════════════════════════════════════════
function getDeepConfig() {
  return {
    target_tweets: parseInt($('#deep-target-tweets')?.value || '200', 10),
    date_cutoff:   $('#deep-date-cutoff')?.value || '2026-03-01',
    min_skip_scrolls:    parseInt($('#deep-min-skip')?.value || '4', 10),
    zero_delta_break:    parseInt($('#deep-zero-break')?.value || '4', 10),
    max_scrolls_ceiling: parseInt($('#deep-max-scrolls')?.value || '60', 10),
  };
}

function getDeepFilters() {
  return {
    dateCutoff: $('#deep-date-cutoff')?.value || '2026-03-01',
    recentDays: parseInt($('#deep-recent-days')?.value || '7', 10),
  };
}

function appendDeepLog(line) {
  const el = $('#deep-log');
  if (!el) return;
  if (el.textContent.startsWith('(no events')) el.textContent = '';
  const ts = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${ts}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setDeepStatus(text) {
  const el = $('#deep-status');
  if (el) el.textContent = text;
}

$('#btn-preview-deep-targets')?.addEventListener('click', () => {
  $('#deep-preview').textContent = 'Loading...';
  ipcRenderer.send('get-deep-priority-preview', getDeepFilters());
});

ipcRenderer.on('deep-priority-preview', (_e, { success, count, sample, error }) => {
  const el = $('#deep-preview');
  if (!el) return;
  if (!success) { el.textContent = `Error: ${error}`; el.style.color = '#f87171'; return; }
  const lines = [`${count} target users (preview top 5):`];
  for (const s of (sample || []).slice(0, 5)) {
    lines.push(`  @${s.screen_name} (${s.relationship}, ${s.replies_recent} replies)`);
  }
  el.textContent = lines.join('\n');
  el.style.color = '#e7e9ea';
});

$('#btn-enqueue-deep')?.addEventListener('click', () => {
  ipcRenderer.send('set-deep-config', getDeepConfig());
  ipcRenderer.send('enqueue-deep-priority', getDeepFilters());
  setDeepStatus('Enqueuing...');
});

ipcRenderer.on('deep-priority-enqueued', (_e, { success, queued, cleared, error }) => {
  if (!success) { setDeepStatus(`Error: ${error}`); return; }
  setDeepStatus(`Queued ${queued} jobs (cleared ${cleared} prior pending). Click Start crawl.`);
  appendDeepLog(`enqueued ${queued} deep jobs`);
});

$('#btn-start-deep-crawl')?.addEventListener('click', () => {
  ipcRenderer.send('set-deep-config', getDeepConfig());
  ipcRenderer.send('start-crawl', { mode: 'user_tweets' });
  setDeepStatus('Started');
  appendDeepLog('crawl started');
});

$('#btn-pause-deep')?.addEventListener('click', () => {
  ipcRenderer.send('pause-crawl');
  appendDeepLog('paused');
});
$('#btn-resume-deep')?.addEventListener('click', () => {
  ipcRenderer.send('resume-crawl');
  appendDeepLog('resumed');
});
$('#btn-stop-deep')?.addEventListener('click', () => {
  ipcRenderer.send('stop-crawl');
  appendDeepLog('stopped');
});

ipcRenderer.on('crawl-status', (_e, status) => {
  if (!status) return;
  if (status.currentProfile) {
    setDeepStatus(`${status.state}: @${status.currentProfile} (queue ${status.queueLength}, saved ${status.totalSaved || 0})`);
  } else if (status.state) {
    setDeepStatus(`${status.state}${status.message ? ' — ' + status.message : ''}`);
  }
});

// ═══════════════════════════════════════════════════
// Crawl groups accordion
// ═══════════════════════════════════════════════════
function appendCrawlGroupsLog(line) {
  const el = $('#crawl-groups-log');
  if (!el) return;
  const stamp = new Date().toLocaleTimeString();
  el.textContent = `[${stamp}] ${line}\n` + el.textContent;
}

function refreshCrawlGroupCounts() {
  ipcRenderer.send('get-crawl-groups');
}

ipcRenderer.on('crawl-groups-loaded', (_e, { success, counts, error }) => {
  if (!success) {
    appendCrawlGroupsLog(`load failed: ${error}`);
    return;
  }
  const setCount = (id, v) => {
    const el = $(id);
    if (el) el.textContent = (v ?? 0).toLocaleString();
  };
  setCount('#cnt-following-zerozero', counts.following_zerozero);
  setCount('#cnt-second-degree-zerozero', counts.second_degree_zerozero);
  setCount('#cnt-reply-targets-no-tweets', counts.reply_targets_no_tweets);
  const total = Number(counts.following_zerozero) + Number(counts.second_degree_zerozero) + Number(counts.reply_targets_no_tweets);
  const summary = $('#crawl-groups-summary');
  if (summary) summary.textContent = `${total.toLocaleString()} total across 3 groups`;
});

$('#btn-refresh-crawl-groups')?.addEventListener('click', refreshCrawlGroupCounts);

$('#btn-queue-following-zerozero')?.addEventListener('click', () => {
  appendCrawlGroupsLog('queueing following zero/zero (deep)...');
  ipcRenderer.send('queue-following-zerozero');
});
$('#btn-queue-2nd-degree-shallow')?.addEventListener('click', () => {
  appendCrawlGroupsLog('queueing 2nd-degree shallow...');
  ipcRenderer.send('queue-2nd-degree-shallow');
});
$('#btn-queue-reply-targets')?.addEventListener('click', () => {
  appendCrawlGroupsLog('queueing reply targets shallow...');
  ipcRenderer.send('queue-reply-targets');
});

ipcRenderer.on('crawl-group-queued', (_e, { group, success, queued, skipped, error }) => {
  if (!success) {
    appendCrawlGroupsLog(`${group}: failed — ${error}`);
    return;
  }
  appendCrawlGroupsLog(`${group}: queued ${queued}, skipped ${skipped} (already pending/running)`);
  refreshCrawlGroupCounts();
});

// Auto-load counts when crawl tab becomes visible
document.querySelectorAll('[data-tab="crawl"]').forEach(btn => {
  btn.addEventListener('click', () => setTimeout(refreshCrawlGroupCounts, 50));
});
// LISTS PANEL
// ═══════════════════════════════════════════════════

function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderListCards() {
  const container = $('#lists-cards');
  if (!container) return;
  const ids = settings.lists || {};
  container.innerHTML = LIST_SLUGS.map(slug => {
    const meta = LIST_META[slug];
    const listId = ids[slug] || '';
    const stats = listStatsCache[slug] || {};
    const configured = !!listId;
    const isActive = activeListSlug === slug;
    return `
      <div class="list-card${isActive ? ' list-card-active' : ''}" data-slug="${slug}">
        <div class="list-card-head">
          <div class="list-card-title">${meta.label}</div>
          <div class="list-card-id">${configured ? `id ${escapeHtml(listId)}` : '<span style="color:#f87171">not configured</span>'}</div>
        </div>
        <div class="list-card-desc">${meta.desc}</div>
        <div class="list-card-stats">
          <span title="Tweets captured today">today <b>${stats.today || 0}</b></span>
          <span title="Tweets captured last 7 days">7d <b>${stats.recent || 0}</b></span>
          <span title="Total tweets ever captured from this list">total <b>${stats.total || 0}</b></span>
          <span title="Last capture timestamp">last ${timeAgo(stats.last_capture)}</span>
        </div>
        <div class="list-card-actions">
          ${isActive
            ? `<span class="text-x-text-secondary text-xs" style="font-style:italic">crawling… (use Stop in the status strip above)</span>`
            : `<button class="sb-btn-primary list-open-btn" data-slug="${slug}" ${configured ? '' : 'disabled'}>Open &amp; crawl</button>`}
        </div>
      </div>
    `;
  }).join('');

  // Stop intentionally lives ONLY in the strip (#btn-stop-list-crawl) — not on the
  // card — to avoid a double-click trap where Open re-renders into Stop at the
  // same screen position.
  container.querySelectorAll('.list-open-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.slug;
      const listId = (settings.lists || {})[slug];
      if (!listId) { showGlobalStatus('Set the list ID in Settings first'); return; }
      btn.disabled = true;
      btn.textContent = 'Loading…';
      ipcRenderer.send('open-list', { slug, listId });
    });
  });
}

function refreshListStats() {
  ipcRenderer.send('get-list-stats', LIST_SLUGS);
}

ipcRenderer.on('list-stats', (event, stats) => {
  listStatsCache = stats || {};
  renderListCards();
});

function openListSlug(slug) {
  const listId = (settings.lists || {})[slug];
  if (!listId) { showGlobalStatus(`No list ID configured for ${slug}`); return; }
  ipcRenderer.send('open-list', { slug, listId });
}

ipcRenderer.on('list-crawl-status', (event, payload) => {
  const { slug, status, message } = payload || {};
  const strip = $('#list-crawl-strip');
  const text  = $('#list-crawl-text');
  if (status === 'started' || status === 'scrolling') {
    activeListSlug = slug;
    strip?.classList.remove('hidden');
    const queueLabel = fetchAllQueue.length ? ` (${fetchAllQueue.length} left)` : '';
    if (text) text.textContent = (message || `Crawling ${slug}...`) + queueLabel;
  } else if (status === 'stopped' || status === 'done' || status === 'error') {
    activeListSlug = null;
    // Pop next from queue if Fetch All is running
    if (fetchAllQueue.length) {
      const next = fetchAllQueue.shift();
      openListSlug(next);
    } else {
      strip?.classList.add('hidden');
    }
    refreshListStats();
  } else if (status === 'progress') {
    const queueLabel = fetchAllQueue.length ? ` (${fetchAllQueue.length} left)` : '';
    if (text) text.textContent = (message || `Crawling ${slug}...`) + queueLabel;
  }
  renderListCards();
});

$('#btn-refresh-lists')?.addEventListener('click', refreshListStats);
$('#btn-stop-list-crawl')?.addEventListener('click', () => {
  fetchAllQueue = [];  // cancel queue on manual stop
  ipcRenderer.send('stop-list-crawl');
});

$('#btn-fetch-all-lists')?.addEventListener('click', () => {
  if (activeListSlug) { showGlobalStatus('Already crawling, stop first'); return; }
  const ids = settings.lists || {};
  const configured = LIST_SLUGS.filter(s => ids[s]);
  if (!configured.length) { showGlobalStatus('No list IDs configured in Settings'); return; }
  fetchAllQueue = configured.slice(1);  // remaining after the first
  openListSlug(configured[0]);
});

// Refresh stats when Lists tab is opened
document.querySelector('[data-tab="lists"]')?.addEventListener('click', refreshListStats);

// ═══════════════════════════════════════════════════
// FEED PANEL (tweets captured from X-lists)
// ═══════════════════════════════════════════════════
let feedSource = 'all';
let feedIncludeActioned = false;
let feedHoursWindow = 3;        // 3h default; togglable to 12h
let feedRows = [];
let feedCounts = [];
// Watermark: hide tweets scored before this epoch-ms. Set when a workflow starts
// so the Reply tab only shows the freshest batch. Persisted in localStorage so
// the filter survives reloads. 0 = no filter.
let feedWatermark = Number(localStorage.getItem('feedWatermark') || 0);

const FEED_CRITERIA_LABELS = {
  icp_fit:              'ICP fit',
  reply_opportunity:    'Reply opp',
  freshness_window:     'Freshness',
  signal_quality:       'Signal',
  voice_match:          'Voice',
  virality_trajectory:  'Virality',
};

function scoreColor(total) {
  if (total == null) return '#71767b';
  if (total >= 75) return '#f87171';   // red — urgent
  if (total >= 55) return '#f59e0b';   // amber
  if (total >= 35) return '#9ca3af';   // gray
  return '#4b5563';                    // dim
}

function formatNum(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function loadFeed() {
  ipcRenderer.send('get-list-feed', {
    slug: feedSource,
    limit: 200,
    includeActioned: feedIncludeActioned,
    hoursWindow: feedHoursWindow,
  });
  const sum = $('#feed-summary');
  if (sum) sum.textContent = 'Loading…';
}

function renderScoreChip(t) {
  if (t.score_total == null) {
    return `<span class="feed-score-chip feed-score-pending" title="Not scored yet — runs every 5 min">…</span>`;
  }
  const breakdown = t.score_breakdown || {};
  const lines = Object.entries(FEED_CRITERIA_LABELS)
    .map(([k, label]) => `${label}: ${breakdown[k] ?? '?'}`)
    .join('\n');
  const reason = t.score_reason ? `\n\n${t.score_reason}` : '';
  const tip = `Total ${t.score_total} (weighted)\n${lines}${reason}`;
  return `<span class="feed-score-chip" style="background:${scoreColor(t.score_total)}" title="${escapeHtml(tip)}">${t.score_total}</span>`;
}

function renderFeed() {
  const list = $('#feed-list');
  const sum  = $('#feed-summary');
  if (!list) return;
  // Filter chip counts
  const countMap = {};
  for (const r of feedCounts) countMap[r.source_list] = r;
  document.querySelectorAll('#feed-source-chips .filter-btn').forEach(btn => {
    const src = btn.dataset.source;
    let label = src === 'high-velocity-replies' ? 'high-velocity'
              : src === 'mutuals-rising' ? 'mutuals-rising'
              : src;
    if (src === 'all') {
      const total = feedCounts.reduce((a, r) => a + r.unactioned, 0);
      btn.textContent = `all (${total})`;
    } else {
      const c = countMap[src];
      btn.textContent = `${label}${c ? ` (${c.unactioned})` : ''}`;
    }
    btn.classList.toggle('active', src === feedSource);
  });
  const scoredCount = feedRows.filter(r => r.score_total != null).length;
  if (sum) sum.textContent = `${feedRows.length} tweet${feedRows.length === 1 ? '' : 's'} · ${scoredCount} scored · ${feedHoursWindow}h${feedIncludeActioned ? ' · incl. actioned' : ''}`;

  if (!feedRows.length) {
    list.innerHTML = `<p class="text-xs text-x-text-secondary text-center mt-8 px-6 leading-relaxed">No tweets yet for this filter.<br>Crawl a list from the Lists tab.</p>`;
    return;
  }
  list.innerHTML = feedRows.map(t => {
    const ts = t.created_at ? new Date(t.created_at) : null;
    const ago = ts ? timeAgo(ts.toISOString()) : '—';
    const sources = (t.source_lists || []).map(s => `<span class="feed-src-badge">${s}</span>`).join('');
    const lastAction = t.last_action ? `<span class="feed-action-badge">${t.last_action}</span>` : '';
    const scoreChip = renderScoreChip(t);
    return `
      <div class="feed-item" data-id="${t.id}" data-handle="${escapeHtml(t.screen_name)}">
        <div class="feed-item-head">
          ${scoreChip}
          <span class="feed-item-handle">@${escapeHtml(t.screen_name)}</span>
          ${t.relationship ? `<span class="feed-item-rel">${t.relationship}</span>` : ''}
          ${t.followers_count ? `<span class="feed-item-rel">${formatNum(t.followers_count)}f</span>` : ''}
          <span class="feed-item-time">${ago}</span>
        </div>
        <div class="feed-item-text">${escapeHtml(t.text)}</div>
        <div class="feed-item-meta">
          <span title="Likes">♥ ${formatNum(t.like_count)}</span>
          <span title="Retweets">↻ ${formatNum(t.retweet_count)}</span>
          <span title="Replies">↳ ${formatNum(t.reply_count)}</span>
          <span title="Views">👁 ${formatNum(t.view_count)}</span>
          ${sources}
          ${lastAction}
        </div>
        <div class="feed-item-actions">
          <button class="feed-btn feed-open"     data-id="${t.id}" data-handle="${escapeHtml(t.screen_name)}">Open</button>
          <button class="feed-btn feed-replied"  data-id="${t.id}">Replied</button>
          <button class="feed-btn feed-skipped"  data-id="${t.id}">Skip</button>
          <button class="feed-btn feed-hidden"   data-id="${t.id}">Hide</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.feed-open').forEach(b => b.addEventListener('click', () => {
    ipcRenderer.send('open-circle-tweet', { tweetId: b.dataset.id, screenName: b.dataset.handle });
  }));
  const actMap = { 'feed-replied': 'replied', 'feed-skipped': 'skipped', 'feed-hidden': 'hidden' };
  Object.entries(actMap).forEach(([cls, action]) => {
    list.querySelectorAll(`.${cls}`).forEach(b => b.addEventListener('click', () => {
      ipcRenderer.send('circle-tweet-action', { tweetId: b.dataset.id, actionType: action });
    }));
  });
}

function applyFeedWatermark(rows) {
  if (!feedWatermark) return rows;
  return rows.filter(r => {
    if (!r.scored_at) return false;          // unscored → hide while filter is active
    return new Date(r.scored_at).getTime() >= feedWatermark;
  });
}

function renderFeedWatermarkChip() {
  const btn = $('#btn-clear-feed-watermark');
  if (!btn) return;
  if (feedWatermark) {
    btn.classList.remove('hidden');
    const t = new Date(feedWatermark);
    btn.title = `Hiding tweets scored before ${t.toLocaleTimeString()}. Click to show all.`;
  } else {
    btn.classList.add('hidden');
  }
}

ipcRenderer.on('list-feed-loaded', (event, payload) => {
  if (!payload?.success) {
    const sum = $('#feed-summary');
    if (sum) { sum.textContent = `Error: ${payload?.error || 'unknown'}`; sum.style.color = '#f87171'; }
    return;
  }
  feedRows = applyFeedWatermark(payload.rows || []);
  feedCounts = payload.counts || [];
  renderFeed();
  renderFeedWatermarkChip();
});

$('#btn-clear-feed-watermark')?.addEventListener('click', () => {
  feedWatermark = 0;
  localStorage.removeItem('feedWatermark');
  renderFeedWatermarkChip();
  loadFeed();
});

ipcRenderer.on('circle-tweet-action-done', (event, payload) => {
  if (!payload?.success) {
    showGlobalStatus(`Action failed: ${payload?.error || 'unknown'}`);
    return;
  }
  // Optimistic remove from current view if not showing actioned
  if (!feedIncludeActioned) {
    feedRows = feedRows.filter(r => String(r.id) !== String(payload.tweetId));
  }
  renderFeed();
  // Refresh counts in background
  loadFeed();
});

document.querySelectorAll('#feed-source-chips .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    feedSource = btn.dataset.source;
    loadFeed();
  });
});

$('#feed-include-actioned')?.addEventListener('change', (e) => {
  feedIncludeActioned = e.target.checked;
  loadFeed();
});

$('#btn-refresh-feed-list')?.addEventListener('click', loadFeed);

document.querySelectorAll('#feed-window-chips .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    feedHoursWindow = Number(btn.dataset.window) || 3;
    document.querySelectorAll('#feed-window-chips .filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    loadFeed();
  });
});

$('#btn-rescore-feed')?.addEventListener('click', () => {
  const btn = $('#btn-rescore-feed');
  if (!btn) return;
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  ipcRenderer.send('rescore-feed', { hoursMax: 3, limit: 100 });
});

ipcRenderer.on('feed-rescore-done', (event, payload) => {
  const btn = $('#btn-rescore-feed');
  if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
  if (payload?.success) {
    showGlobalStatus(`Scored ${payload.scored || 0} tweet${payload.scored === 1 ? '' : 's'}${payload.failed ? ` (${payload.failed} failed)` : ''}`);
    loadFeed();
  } else {
    showGlobalStatus(`Rescore failed: ${payload?.error || 'unknown'}`);
  }
});

ipcRenderer.on('feed-scores-updated', () => {
  // Auto-refresh feed when background scoring finishes
  if (document.querySelector('[data-tab="reply"]')?.classList.contains('active')) {
    loadFeed();
  }
});

// Live scoring progress strip
let feedScoreStripHideTimer = null;
ipcRenderer.on('feed-score-progress', (event, p) => {
  const strip = $('#feed-score-strip');
  const txt   = $('#feed-score-strip-text');
  const cnt   = $('#feed-score-strip-count');
  if (!strip || !txt || !cnt) return;
  clearTimeout(feedScoreStripHideTimer);

  if (p.phase === 'start' || p.phase === 'queued') {
    strip.classList.remove('hidden');
    txt.textContent = p.total === 0
      ? 'No new tweets to score'
      : `Scoring ${p.total != null ? p.total : '…'} tweet${p.total === 1 ? '' : 's'}`;
    cnt.textContent = '';
    if (p.phase === 'queued' && p.total === 0) {
      feedScoreStripHideTimer = setTimeout(() => strip.classList.add('hidden'), 1500);
    }
  } else if (p.phase === 'tweet-start') {
    strip.classList.remove('hidden');
    txt.textContent = `Scoring @${p.tweet.screen_name}`;
    cnt.textContent = `${p.i}/${p.n}`;
  } else if (p.phase === 'tweet-done') {
    cnt.textContent = `${p.i}/${p.n} · last ${p.result.total}`;
  } else if (p.phase === 'tweet-error') {
    cnt.textContent = `${p.i}/${p.n} · err`;
  } else if (p.phase === 'done') {
    txt.textContent = p.total === 0
      ? 'No new tweets to score'
      : `Scored ${p.scored}/${p.total}${p.failed ? ` · ${p.failed} failed` : ''} in ${p.elapsedSec}s`;
    cnt.textContent = '';
    feedScoreStripHideTimer = setTimeout(() => strip.classList.add('hidden'), 4000);
  } else if (p.phase === 'error') {
    txt.textContent = `Score error: ${p.error}`;
    cnt.textContent = '';
    feedScoreStripHideTimer = setTimeout(() => strip.classList.add('hidden'), 6000);
  } else if (p.phase === 'aborting') {
    txt.textContent = 'Stopping after current tweet…';
  } else if (p.phase === 'skip') {
    // Already running — ignore
  }
});

$('#btn-stop-feed-scoring')?.addEventListener('click', () => {
  ipcRenderer.send('stop-feed-scoring');
  const btn = $('#btn-stop-feed-scoring');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Stop'; }, 3000); }
});

// Load when Reply tab is opened
document.querySelector('[data-tab="reply"]')?.addEventListener('click', loadFeed);

// ═══════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════
renderProviders();
initIcons();
refreshListStats();

// ═══════════════════════════════════════════════════
// WORKFLOWS TAB
// ═══════════════════════════════════════════════════
const WF_BADGE_COLORS = {
  idle:       { bg: '#374151', fg: '#d1d5db' },
  clearing:   { bg: '#475569', fg: '#fff'    },
  crawling:   { bg: '#2563eb', fg: '#fff'    },
  scoring:    { bg: '#7c3aed', fg: '#fff'    },
  notifying:  { bg: '#0ea5e9', fg: '#fff'    },
  done:       { bg: '#16a34a', fg: '#fff'    },
  error:      { bg: '#dc2626', fg: '#fff'    },
};

function applyWorkflowState(state) {
  if (!state || state.id !== 'list-sweep') return;
  const badge   = $('#wf-list-sweep-badge');
  const status  = $('#wf-list-sweep-status');
  const result  = $('#wf-list-sweep-result');
  const runBtn  = $('#wf-list-sweep-run');
  if (badge) {
    const colors = WF_BADGE_COLORS[state.phase] || WF_BADGE_COLORS.idle;
    badge.textContent = state.phase || 'idle';
    badge.style.background = colors.bg;
    badge.style.color      = colors.fg;
  }
  if (status) {
    status.textContent = state.message || (state.phase === 'idle' ? 'Not yet run.' : '');
  }
  if (result && state.lastResult) {
    const r = state.lastResult;
    const parts = [];
    if (r.scored != null) parts.push(`scored ${r.scored}`);
    if (r.failed)         parts.push(`${r.failed} failed`);
    if (r.pushed != null) parts.push(`pushed ${r.pushed} to telegram`);
    if (r.durationMs)     parts.push(`${Math.round(r.durationMs / 1000)}s`);
    if (r.error)          parts.push(`error: ${r.error}`);
    if (state.finishedAt) parts.push(`at ${new Date(state.finishedAt).toLocaleTimeString()}`);
    if (parts.length) {
      result.textContent = `Last run: ${parts.join(' · ')}`;
      result.classList.remove('hidden');
    }
  }
  const busy = ['clearing', 'crawling', 'scoring', 'notifying'].includes(state.phase);
  if (runBtn) {
    runBtn.disabled = busy;
    runBtn.textContent = busy ? 'Running…' : 'Run Now';
  }
}

let lastWorkflowStartedAt = 0;
ipcRenderer.on('workflow-state', (event, state) => {
  applyWorkflowState(state);
  // When a fresh workflow starts, watermark the Reply tab so older tweets stay
  // hidden until the user explicitly clicks "show older". Triggered on the
  // 'clearing' phase, which fires BEFORE the crawl so the UI wipes before any
  // network traffic begins.
  if (state && state.phase === 'clearing' && state.startedAt && state.startedAt !== lastWorkflowStartedAt) {
    lastWorkflowStartedAt = state.startedAt;
    feedWatermark = state.startedAt;
    try { localStorage.setItem('feedWatermark', String(feedWatermark)); } catch {}
    // Wipe immediately.
    feedRows = [];
    renderFeed();
    renderFeedWatermarkChip();
    const sum = $('#feed-summary');
    if (sum) sum.textContent = 'Cleared. Crawling starts next…';
  }
  // When scoring completes or workflow finishes, reload feed so the new rows show.
  if (state && (state.phase === 'done' || state.phase === 'notifying')) {
    if (document.querySelector('[data-tab="reply"]')?.classList.contains('active')) {
      loadFeed();
    }
  }
});
ipcRenderer.on('workflow-run-result', (event, r) => {
  if (!r) return;
  if (!r.ok) showGlobalStatus(`Workflow failed: ${r.error}`);
});

function loadWorkflowScheduleFromSettings() {
  const ac = settings.listAutoCrawl || {};
  // "Enable scheduled run" mirrors `enabled` only — pause/resume is a separate toggle.
  if ($('#wf-list-sweep-enabled'))  $('#wf-list-sweep-enabled').checked  = !!ac.enabled;
  if ($('#wf-list-sweep-interval')) $('#wf-list-sweep-interval').value   = ac.intervalMinutes || 60;
  if ($('#wf-list-sweep-start'))    $('#wf-list-sweep-start').value      = ac.startTime || '';
  const tg = settings.telegram || {};
  if ($('#wf-list-sweep-min-score')) $('#wf-list-sweep-min-score').value = tg.minScore != null ? tg.minScore : 60;
  const pauseBtn = $('#wf-list-sweep-pause');
  if (pauseBtn) {
    pauseBtn.textContent = (ac.enabled && ac.running) ? 'Pause schedule' : 'Resume schedule';
    pauseBtn.disabled = !ac.enabled;
  }
}

function updateWorkflowNextLabel() {
  const el = $('#wf-list-sweep-next');
  if (!el) return;
  const s = autoCrawlStatusCache;
  if (!s || !s.enabled || !s.running || !s.nextAt) { el.textContent = ''; return; }
  el.textContent = `${formatCountdown(s.nextAt - Date.now())} (${formatClock(s.nextAt)})`;
}
setInterval(updateWorkflowNextLabel, 10 * 1000);

document.querySelector('[data-tab="workflows"]')?.addEventListener('click', () => {
  loadWorkflowScheduleFromSettings();
  updateWorkflowNextLabel();
  ipcRenderer.send('get-workflow-state');
  ipcRenderer.send('get-list-auto-crawl-status');
});

$('#wf-list-sweep-run')?.addEventListener('click', () => {
  const btn = $('#wf-list-sweep-run');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  ipcRenderer.send('run-workflow', { id: 'list-sweep' });
});

$('#wf-list-sweep-pause')?.addEventListener('click', () => {
  const ac = settings.listAutoCrawl || {};
  if (!ac.enabled) {
    showGlobalStatus('Enable scheduled run first');
    return;
  }
  const nextRunning = !ac.running;
  settings.listAutoCrawl = { ...ac, running: nextRunning };
  ipcRenderer.send('set-list-auto-crawl', { running: nextRunning });
  loadWorkflowScheduleFromSettings();
});

$('#wf-list-sweep-save')?.addEventListener('click', () => {
  const enabled = !!$('#wf-list-sweep-enabled')?.checked;
  const intervalMinutes = Math.max(5, Number($('#wf-list-sweep-interval')?.value) || 60);
  const raw = ($('#wf-list-sweep-start')?.value || '').trim();
  const startTime = /^\d{1,2}:\d{2}$/.test(raw) ? raw : '';
  const ac = settings.listAutoCrawl || {};
  const patch = { enabled, running: enabled ? (ac.running !== false) : false, intervalMinutes, startTime };
  settings.listAutoCrawl = { ...ac, ...patch };
  ipcRenderer.send('set-list-auto-crawl', patch);

  // Persist telegram.minScore (the only telegram knob on this card).
  const minScore = Math.max(0, Math.min(100, Number($('#wf-list-sweep-min-score')?.value) || 60));
  const tg = { ...(settings.telegram || {}), minScore };
  settings.telegram = tg;
  // Send a full save so other settings stay intact.
  ipcRenderer.send('save-settings', { ...settings, telegram: tg });

  loadWorkflowScheduleFromSettings();
  showGlobalStatus('Workflow saved', 1500);
});

// ═══════════════════════════════════════════════════════════════════════
// PROSPECTS — Origami-style ICP search across X / LinkedIn
// ═══════════════════════════════════════════════════════════════════════

let activeProspectPlatform = window.activePlatform || 'x';
let lastProspectSearchId = null;

function syncProspectsToPlatform(platform) {
  activeProspectPlatform = platform;
  ipcRenderer.send('prospect-list-searches', { platform });
  // Reset visible results — different platform = different result set.
  const results = $('#prospect-results');
  if (results) results.innerHTML = '<p class="text-xs text-x-text-secondary text-center mt-8 px-6 leading-relaxed">Platform switched. Type an ICP prompt above to search.</p>';
  lastProspectSearchId = null;
}

document.querySelector('[data-tab="prospects"]')?.addEventListener('click', () => {
  syncProspectsToPlatform(activeProspectPlatform);
});

$('#prospect-browse-btn')?.addEventListener('click', () => {
  const platform = activeProspectPlatform;
  const btn = $('#prospect-browse-btn');
  const progress = $('#prospect-progress');
  const results = $('#prospect-results');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (progress) { progress.classList.remove('hidden'); progress.textContent = `Loading all ${platform} prospects…`; }
  if (results) results.innerHTML = '';
  ipcRenderer.send('prospect-browse-all', { platform, limit: 300 });
});

$('#prospect-embed-score-btn')?.addEventListener('click', () => {
  const platform = activeProspectPlatform;
  if (platform !== 'linkedin') { alert('Embedding scoring only supports LinkedIn for now.'); return; }
  const prompt = ($('#prospect-prompt')?.value || '').trim();
  const btn = $('#prospect-embed-score-btn');
  const progress = $('#prospect-progress');
  const results = $('#prospect-results');
  if (btn) { btn.disabled = true; btn.textContent = 'Embedding…'; }
  if (progress) { progress.classList.remove('hidden'); progress.textContent = 'Embedding prospects + ICP via OpenRouter…'; }
  if (results) results.innerHTML = '';
  ipcRenderer.send('prospect-embed-and-score', { platform, prompt, embedFirst: true });
});

$('#prospect-enrich-all-btn')?.addEventListener('click', () => {
  const platform = activeProspectPlatform;
  if (platform !== 'linkedin') {
    alert('Enrichment only supports LinkedIn for now.');
    return;
  }
  const filter = prompt('Optional headline filter (substring, ILIKE). Blank = enrich all un-enriched. Example: "Operations"', '') || null;
  const btn = $('#prospect-enrich-all-btn');
  const progress = $('#prospect-progress');
  const results = $('#prospect-results');
  if (btn) { btn.disabled = true; btn.textContent = 'Enriching…'; }
  if (progress) { progress.classList.remove('hidden'); progress.textContent = 'Fetching profiles via Apify…'; }
  if (results) results.innerHTML = '';
  ipcRenderer.send('prospect-enrich-all', { platform, headlineFilter: filter, limit: 2000 });
});

$('#prospect-score-all-btn')?.addEventListener('click', () => {
  const platform = activeProspectPlatform;
  const prompt = ($('#prospect-prompt')?.value || '').trim();
  const btn = $('#prospect-score-all-btn');
  const progress = $('#prospect-progress');
  const results = $('#prospect-results');
  if (btn) { btn.disabled = true; btn.textContent = 'Scoring…'; }
  if (progress) { progress.classList.remove('hidden'); progress.textContent = 'Scoring every prospect. May take several minutes…'; }
  if (results) results.innerHTML = '';
  ipcRenderer.send('prospect-score-all', { platform, prompt });
});

$('#prospect-run-btn')?.addEventListener('click', () => {
  const prompt = ($('#prospect-prompt')?.value || '').trim();
  if (!prompt) { showGlobalStatus('Enter an ICP prompt first'); return; }
  const candidateLimit = Number($('#prospect-candidate-limit')?.value) || 25;
  const minScore       = Number($('#prospect-min-score')?.value);
  const minFollowers   = Number($('#prospect-min-followers')?.value) || 0;

  const btn = $('#prospect-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }
  const progress = $('#prospect-progress');
  if (progress) {
    progress.classList.remove('hidden');
    progress.textContent = 'Parsing ICP…';
  }
  const results = $('#prospect-results');
  if (results) results.innerHTML = '';

  ipcRenderer.send('prospect-search', {
    platform: activeProspectPlatform,
    prompt,
    candidateLimit,
    minScore: Number.isFinite(minScore) ? minScore : 40,
    minFollowers,
  });
});

ipcRenderer.on('prospect-search-progress', (_e, payload) => {
  const progress = $('#prospect-progress');
  if (!progress) return;
  switch (payload.stage) {
    case 'parsing':            progress.textContent = 'Parsing ICP prompt…'; break;
    case 'parsed':             progress.textContent = `Criteria parsed: ${summarizeCriteria(payload.criteria)}`; break;
    case 'candidates_loading': progress.textContent = 'Loading candidate pool…'; break;
    case 'candidates_loaded':  progress.textContent = `${payload.count} candidates. Scoring…`; break;
    case 'scoring':            progress.textContent = `Scoring ${payload.i + 1}/${payload.total}: @${payload.handle}`; break;
    case 'score_error':        progress.textContent = `Score error on @${payload.handle}: ${payload.error}`; break;
    case 'done':               progress.textContent = `Done. ${payload.saved} prospects above threshold.`; break;
    case 'error':              progress.textContent = `Error: ${payload.error}`; break;
  }
});

ipcRenderer.on('prospect-search-done', (_e, payload) => {
  const btn = $('#prospect-run-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Find prospects'; }
  const scoreAllBtn = $('#prospect-score-all-btn');
  if (scoreAllBtn) { scoreAllBtn.disabled = false; scoreAllBtn.textContent = 'Score all'; }
  const enrichBtn = $('#prospect-enrich-all-btn');
  if (enrichBtn) { enrichBtn.disabled = false; enrichBtn.textContent = 'Enrich all'; }
  const embedBtn = $('#prospect-embed-score-btn');
  if (embedBtn) { embedBtn.disabled = false; embedBtn.textContent = 'Embed score'; }
  if (!payload.success) {
    showGlobalStatus(`Search failed: ${payload.error}`, 4000);
    return;
  }
  lastProspectSearchId = payload.searchId;
  ipcRenderer.send('prospect-load-results', { searchId: payload.searchId });
  ipcRenderer.send('prospect-list-searches', { platform: activeProspectPlatform });
});

function summarizeCriteria(c) {
  if (!c) return '';
  const parts = [];
  if (c.roles?.length)      parts.push(`roles: ${c.roles.slice(0, 3).join(', ')}`);
  if (c.industries?.length) parts.push(`industries: ${c.industries.slice(0, 3).join(', ')}`);
  if (c.topics?.length)     parts.push(`topics: ${c.topics.slice(0, 3).join(', ')}`);
  return parts.join(' | ') || 'generic';
}

ipcRenderer.on('prospect-searches-loaded', (_e, payload) => {
  if (!payload.success) return;
  const sel = $('#prospect-recent-select');
  if (!sel) return;
  const opts = ['<option value="">recent…</option>'];
  for (const r of (payload.rows || [])) {
    const label = (r.prompt || '').slice(0, 32).replace(/\n/g, ' ');
    const count = r.result_count || 0;
    opts.push(`<option value="${r.id}" title="${escapeHtml(r.prompt)}">${escapeHtml(label)} · ${count}</option>`);
  }
  sel.innerHTML = opts.join('');
});

$('#prospect-recent-select')?.addEventListener('change', (e) => {
  const id = Number(e.target.value);
  if (!id) return;
  lastProspectSearchId = id;
  ipcRenderer.send('prospect-load-results', { searchId: id });
});

ipcRenderer.on('prospect-results-loaded', (_e, payload) => {
  const el = $('#prospect-results');
  const browseBtn = $('#prospect-browse-btn');
  const progress = $('#prospect-progress');
  if (browseBtn) { browseBtn.disabled = false; browseBtn.textContent = 'Browse all'; }
  if (!el) return;
  if (!payload.success) {
    el.innerHTML = `<p class="text-xs text-red-400 p-3">Error: ${escapeHtml(payload.error)}</p>`;
    if (progress) progress.classList.add('hidden');
    return;
  }
  if (!payload.rows?.length) {
    el.innerHTML = payload.browse
      ? '<p class="text-xs text-x-text-secondary text-center mt-8">No prospects in DB for this platform. Run the LinkedIn fill workflow first.</p>'
      : '<p class="text-xs text-x-text-secondary text-center mt-8">No prospects above threshold. Try lowering min fit or broadening the prompt.</p>';
    if (progress) progress.classList.add('hidden');
    return;
  }
  if (progress) {
    if (payload.browse) {
      progress.classList.remove('hidden');
      progress.textContent = `Showing ${payload.rows.length} prospects (most recent first, ones with title shown first).`;
    } else {
      progress.classList.add('hidden');
    }
  }
  el.innerHTML = payload.rows.map(renderProspectCard).join('');
  el.querySelectorAll('[data-outreach-prospect]').forEach(b => {
    b.addEventListener('click', () => onOutreachClick(b));
  });
});

function renderProspectCard(r) {
  const meta = [
    r.title && escapeHtml(r.title),
    r.company && escapeHtml(r.company),
    r.location && escapeHtml(r.location),
  ].filter(Boolean).join(' · ');
  const link = r.profile_url ? `<a href="${escapeHtml(r.profile_url)}" target="_blank" class="text-x-accent">@${escapeHtml(r.handle)}</a>` : `@${escapeHtml(r.handle)}`;
  const bio = (r.bio || r.headline || '').slice(0, 240);
  const channelOpts = r.platform === 'linkedin'
    ? `<option value="connect">Connect note</option><option value="inmail">InMail</option>`
    : `<option value="dm">DM</option><option value="reply">Reply</option>`;
  return `
    <div class="prospect-card" data-prospect-id="${r.prospect_id}" style="border:1px solid #2f3336;border-radius:8px;padding:10px 12px;background:#16181c">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-sm font-medium">
            <span>${escapeHtml(r.display_name || r.handle)}</span>
            <span class="text-x-text-secondary text-xs">${link}</span>
          </div>
          ${meta ? `<div class="text-xs text-x-text-secondary mt-0.5">${meta}</div>` : ''}
          ${bio ? `<div class="text-xs mt-1.5 leading-snug">${escapeHtml(bio)}</div>` : ''}
          ${r.reason ? `<div class="text-xs text-x-text-secondary mt-1.5 italic">${escapeHtml(r.reason)}</div>` : ''}
        </div>
        <div class="text-right shrink-0">
          <div style="font-size:20px;font-weight:600;color:${fitColor(r.fit_score)}">${r.fit_score == null ? '—' : r.fit_score}</div>
          <div class="text-xs text-x-text-secondary">${r.fit_score == null ? 'unscored' : 'fit'}</div>
          <div class="text-xs text-x-text-secondary mt-1">${(r.followers_count || 0).toLocaleString()} foll</div>
        </div>
      </div>
      <div class="flex items-center gap-2 mt-2 pt-2 border-t border-x-border">
        <select class="sb-textarea text-xs" data-channel-select style="padding:2px 6px;width:auto">
          ${channelOpts}
        </select>
        <button class="sb-btn-ghost text-xs" data-outreach-prospect="${r.prospect_id}">Draft outreach</button>
        <div class="outreach-output flex-1 text-xs text-x-text-secondary"></div>
      </div>
    </div>
  `;
}

function fitColor(score) {
  if (score >= 80) return '#10b981';
  if (score >= 60) return '#3b82f6';
  if (score >= 40) return '#f59e0b';
  return '#9ca3af';
}

function onOutreachClick(btn) {
  const card = btn.closest('.prospect-card');
  if (!card) return;
  const prospectId = Number(card.dataset.prospectId);
  const channel = card.querySelector('[data-channel-select]')?.value || 'dm';
  const out = card.querySelector('.outreach-output');

  // Reconstruct minimal prospect payload from the DOM-rendered card.
  // Bio + headline already in the card; the IPC handler also receives the
  // canonical record via prospectId if it needs to enrich.
  const prospect = {
    handle: card.querySelector('a')?.textContent?.replace(/^@/, '') || '',
    display_name: card.querySelector('.text-sm.font-medium span')?.textContent || '',
    headline: '',
    bio: card.querySelector('.text-xs.mt-1\\.5')?.textContent || '',
  };

  if (out) { out.textContent = 'Drafting…'; }
  btn.disabled = true;

  ipcRenderer.send('prospect-generate-outreach', {
    prospectId,
    searchId: lastProspectSearchId,
    platform: activeProspectPlatform,
    channel,
    context: 'an indie builder',
    prospect,
  });
}

ipcRenderer.on('prospect-outreach-generated', (_e, payload) => {
  // Find any card with a disabled outreach button to identify the target.
  const btn = document.querySelector('.prospect-card [data-outreach-prospect]:disabled');
  const card = btn?.closest('.prospect-card');
  const out = card?.querySelector('.outreach-output');
  if (btn) btn.disabled = false;
  if (!payload.success) {
    if (out) out.textContent = `Error: ${payload.error}`;
    return;
  }
  if (out) {
    out.innerHTML = `<div style="white-space:pre-wrap;color:#e5e7eb;background:#0f1419;padding:6px 8px;border-radius:4px;margin-top:6px">${escapeHtml(payload.body)}</div>`;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Workflow: Fill LinkedIn Prospects
// ═══════════════════════════════════════════════════════════════════════

function liFillLog(line) {
  const el = $('#wf-li-fill-log');
  if (!el) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${stamp}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

$('#wf-li-fill-run')?.addEventListener('click', () => {
  const seedsRaw = ($('#wf-li-fill-seeds')?.value || '').trim();
  const searchSeeds = seedsRaw ? seedsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const btn = $('#wf-li-fill-run');
  const badge = $('#wf-li-fill-badge');
  const statusEl = $('#wf-li-fill-status');
  const resultEl = $('#wf-li-fill-result');

  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  if (badge) { badge.textContent = 'running'; badge.style.background = '#f59e0b'; }
  if (statusEl) statusEl.textContent = 'Sending run-workflow IPC…';
  if (resultEl) resultEl.classList.add('hidden');
  liFillLog(`click Run Now. seeds=${searchSeeds.join(',') || '(none)'}`);

  ipcRenderer.send('run-workflow', { id: 'li-fill-prospects', opts: { searchSeeds } });
});

$('#wf-li-fill-clear-log')?.addEventListener('click', () => {
  const el = $('#wf-li-fill-log');
  if (el) el.textContent = '';
});

ipcRenderer.on('workflow-progress', (_e, ev) => {
  if (ev.id !== 'li-fill-prospects') return;
  const statusEl = $('#wf-li-fill-status');
  const msg = ev.message || ev.phase || '';
  if (statusEl && (ev.phase !== 'diagnostic' && ev.phase !== 'warn')) statusEl.textContent = msg;

  if (ev.phase === 'scroll-tick' || ev.phase === 'scroll-stalled') {
    liFillLog(msg);
  } else if (ev.phase === 'diagnostic') {
    liFillLog(`  ${msg}`);
  } else if (ev.phase === 'dom-harvest') {
    liFillLog(`  DOM ${msg}`);
  } else if (ev.phase === 'dom-harvest-error') {
    liFillLog(`  DOM ERROR ${ev.error}`);
  } else if (ev.phase === 'snapshot') {
    liFillLog(`  HTML ${msg}`);
  } else if (ev.phase === 'warn') {
    liFillLog(`  WARN ${msg}`);
  } else if (ev.phase === 'error') {
    liFillLog(`  ERROR ${ev.error || msg}`);
  } else {
    liFillLog(`${ev.phase}: ${msg}${ev.url ? ' → ' + ev.url : ''}${ev.seed ? ' (seed=' + ev.seed + ')' : ''}`);
  }
});

// Surface live recon events in the workflow log when the LI card is visible.
ipcRenderer.on('linkedin-recon-event', (_e, ev) => {
  const card = document.querySelector('.workflow-card[data-workflow="li-fill-prospects"]');
  if (!card || card.classList.contains('hidden')) return;
  if (ev.kind === 'hit')               liFillLog(`hit ${ev.pattern} #${ev.hit_count}`);
  else if (ev.kind === 'ingested')      liFillLog(`ingested ${ev.count} from ${ev.pattern} (cum=${ev.total_upserted})`);
  else if (ev.kind === 'attached')      liFillLog('recon attached');
  else if (ev.kind === 'detached')      liFillLog(`recon detached: ${ev.reason}`);
  else if (ev.kind === 'autostore')     liFillLog(`autostore=${ev.enabled}`);
  else if (ev.kind === 'ingest_error')  liFillLog(`ingest_error ${ev.pattern}: ${ev.error}`);
});

ipcRenderer.on('workflow-run-result', (_e, payload) => {
  if (payload.id !== 'li-fill-prospects') return;
  const btn = $('#wf-li-fill-run');
  const badge = $('#wf-li-fill-badge');
  const resultEl = $('#wf-li-fill-result');
  if (btn) { btn.disabled = false; btn.textContent = 'Run Now'; }
  if (badge) {
    badge.textContent = payload.ok ? 'done' : 'error';
    badge.style.background = payload.ok ? '#10b981' : '#ef4444';
  }
  if (resultEl) {
    resultEl.classList.remove('hidden');
    const stats = payload.stats || {};
    const dur = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
    resultEl.textContent = payload.ok
      ? `+${payload.total || 0} prospects in ${dur}. feed:${stats.feed || 0} connections:${stats.connections || 0} mynetwork:${stats.mynetwork || 0} search:${stats.search || 0}`
      : `Failed: ${payload.error}`;
  }
  liFillLog(payload.ok ? `result: +${payload.total || 0}` : `result FAIL: ${payload.error}`);
});

// ═══════════════════════════════════════════════════════════════════════
// X-fill-prospects workflow wiring (Workflows tab card)
// ═══════════════════════════════════════════════════════════════════════

function xFillLog(line) {
  const el = $('#wf-x-fill-log');
  if (!el) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${stamp}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function readXFillOpts() {
  const fetchWebsites = !!$('#wf-x-fill-web')?.checked;
  const maxWebsiteFetches = Math.max(0, parseInt($('#wf-x-fill-web-cap')?.value || '50', 10));
  const fetchTweets = $('#wf-x-fill-tweets') ? !!$('#wf-x-fill-tweets').checked : true;
  const maxTweetCrawls = Math.max(0, parseInt($('#wf-x-fill-tweets-cap')?.value || '30', 10));
  const embedAndScore = $('#wf-x-fill-embed') ? !!$('#wf-x-fill-embed').checked : true;
  return { fetchWebsites, maxWebsiteFetches, fetchTweets, maxTweetCrawls, embedAndScore };
}

function startXFill({ skipDiscovery }) {
  const seedsRaw = ($('#wf-x-fill-seeds')?.value || '').trim();
  const searchSeeds = seedsRaw ? seedsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!skipDiscovery && !searchSeeds.length) {
    alert('At least one seed keyword is required (comma-separated). Or click "Enrich existing" to skip discovery.');
    return;
  }
  const scrollsPerSeed = Math.max(1, parseInt($('#wf-x-fill-scrolls')?.value || '8', 10));
  const opts = { searchSeeds, scrollsPerSeed, skipDiscovery, ...readXFillOpts() };

  const runBtn = $('#wf-x-fill-run');
  const enrichBtn = $('#wf-x-fill-enrich');
  const badge = $('#wf-x-fill-badge');
  const statusEl = $('#wf-x-fill-status');
  const resultEl = $('#wf-x-fill-result');

  if (runBtn)    { runBtn.disabled    = true; if (!skipDiscovery) runBtn.textContent    = 'Running…'; }
  if (enrichBtn) { enrichBtn.disabled = true; if (skipDiscovery)  enrichBtn.textContent = 'Enriching…'; }
  if (badge) { badge.textContent = skipDiscovery ? 'enriching' : 'running'; badge.style.background = '#f59e0b'; }
  if (statusEl) statusEl.textContent = skipDiscovery ? 'Skip discovery, enrich existing X prospects…' : 'Sending run-workflow IPC…';
  if (resultEl) resultEl.classList.add('hidden');
  xFillLog(`click ${skipDiscovery ? 'Enrich existing' : 'Run Now'}. seeds=[${searchSeeds.join(',') || '(skip)'}] scrolls=${scrollsPerSeed} web=${opts.fetchWebsites} tweets=${opts.fetchTweets} embed=${opts.embedAndScore}`);

  ipcRenderer.send('run-workflow', { id: 'x-fill-prospects', opts });
}

$('#wf-x-fill-run')?.addEventListener('click', () => startXFill({ skipDiscovery: false }));
$('#wf-x-fill-enrich')?.addEventListener('click', () => startXFill({ skipDiscovery: true }));

$('#wf-x-fill-clear-log')?.addEventListener('click', () => {
  const el = $('#wf-x-fill-log');
  if (el) el.textContent = '';
});

ipcRenderer.on('workflow-progress', (_e, ev) => {
  if (ev.id !== 'x-fill-prospects') return;
  const statusEl = $('#wf-x-fill-status');
  const msg = ev.message || ev.phase || '';
  if (statusEl) statusEl.textContent = msg;
  xFillLog(`${ev.phase}: ${msg}`);
});

ipcRenderer.on('workflow-run-result', (_e, payload) => {
  if (payload.id !== 'x-fill-prospects') return;
  const btn = $('#wf-x-fill-run');
  const enrichBtn = $('#wf-x-fill-enrich');
  const badge = $('#wf-x-fill-badge');
  const resultEl = $('#wf-x-fill-result');
  if (btn)       { btn.disabled       = false; btn.textContent       = 'Run Now (full)'; }
  if (enrichBtn) { enrichBtn.disabled = false; enrichBtn.textContent = 'Enrich existing'; }
  if (badge) {
    badge.textContent = payload.ok ? 'done' : 'error';
    badge.style.background = payload.ok ? '#10b981' : '#ef4444';
  }
  if (resultEl) {
    resultEl.classList.remove('hidden');
    const stats = payload.stats || {};
    const dur = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
    const mode = stats.mode || 'full';
    resultEl.textContent = payload.ok
      ? `[${mode}] +${stats.upserted || 0} new · web ${stats.webFetched || 0} · tweets ${stats.tweetsCrawled || 0} (skipped-cached ${stats.tweetsSkippedCached || 0}) · embedded ${stats.embedded || 0} · scored ${stats.scored || 0} · ${dur}`
      : `Failed: ${payload.error}`;
  }
  xFillLog(payload.ok ? `DONE [${(payload.stats || {}).mode || 'full'}] +${(payload.stats || {}).upserted || 0} prospects, scored ${(payload.stats || {}).scored || 0}. Open Prospects tab → Top 10 today.` : `result FAIL: ${payload.error}`);
});

// ═══════════════════════════════════════════════════════════════════════
// X-only Prospects toolbar buttons: Embed score (X) + Top 10 today
// ═══════════════════════════════════════════════════════════════════════

$('#prospect-x-embed-score-btn')?.addEventListener('click', () => {
  const prompt = ($('#prospect-prompt')?.value || '').trim();
  const btn = $('#prospect-x-embed-score-btn');
  const progress = $('#prospect-progress');
  if (btn) { btn.disabled = true; btn.textContent = 'Embedding…'; }
  if (progress) {
    progress.classList.remove('hidden');
    progress.textContent = 'Embedding X prospects (bio + tweets + website), then ranking vs ICP…';
  }
  ipcRenderer.send('prospect-x-embed-and-score', { prompt, embedFirst: true, excludeContacted: true });
});

$('#prospect-x-daily-ten-btn')?.addEventListener('click', () => {
  const btn = $('#prospect-x-daily-ten-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  ipcRenderer.send('prospect-x-daily-ten', { limit: 10 });
});

// Re-enable X buttons on result + progress events.
ipcRenderer.on('prospect-search-progress', (_e, ev) => {
  if (!ev || !String(ev.stage || '').startsWith('x_embed_')) return;
  const progress = $('#prospect-progress');
  if (progress) {
    progress.classList.remove('hidden');
    if (ev.stage === 'x_embed_start')     progress.textContent = `Embedding ${ev.total || 0} X prospects…`;
    else if (ev.stage === 'x_embed_embedded') progress.textContent = `Embedded @${ev.handle} (${ev.doneSoFar}/${ev.total})`;
    else if (ev.stage === 'x_embed_scored')   progress.textContent = `Scored ${ev.count || 0} prospects vs ICP. Loading results…`;
    else if (ev.stage === 'x_embed_done')     progress.textContent = `Done. embedded=${ev.embedded || 0} failed=${ev.failed || 0}`;
  }
});

ipcRenderer.on('prospect-search-done', (_e, ev) => {
  const xBtn = $('#prospect-x-embed-score-btn');
  if (xBtn && xBtn.disabled) { xBtn.disabled = false; xBtn.textContent = 'Embed score (X)'; }
  const tenBtn = $('#prospect-x-daily-ten-btn');
  if (tenBtn && tenBtn.disabled) { tenBtn.disabled = false; tenBtn.textContent = 'Top 10 today'; }
});

ipcRenderer.on('prospect-results-loaded', (_e, payload) => {
  if (!payload?.dailyTen) return;
  const tenBtn = $('#prospect-x-daily-ten-btn');
  if (tenBtn) { tenBtn.disabled = false; tenBtn.textContent = 'Top 10 today'; }
});

// ═══════════════════════════════════════════════════════════════════════
// Identity defaults: hydrate Settings inputs + pre-fill empty fields
// across Prospects + Workflow when defaults exist in user-local settings.
// All values live in user-local settings.json — repo carries empty schema only.
// ═══════════════════════════════════════════════════════════════════════

let identityDefaultsCache = null;

function applyIdentityDefaults(data) {
  identityDefaultsCache = data;
  const oc = data.outreachContext || {};
  const ocX  = typeof oc === 'string' ? oc : (oc.x  || '');
  const ocLi = typeof oc === 'string' ? oc : (oc.linkedin || '');

  // Hydrate Settings panel fields (always reflect saved state)
  if ($('#id-outreach-context-x'))  $('#id-outreach-context-x').value  = ocX;
  if ($('#id-outreach-context-li')) $('#id-outreach-context-li').value = ocLi;
  if ($('#id-icp-x'))                $('#id-icp-x').value               = data.icp?.x || '';
  if ($('#id-icp-li'))               $('#id-icp-li').value              = data.icp?.linkedin || '';
  if ($('#id-li-seeds'))             $('#id-li-seeds').value            = (data.liSearchSeeds || []).join(', ');
  if ($('#id-x-seeds'))              $('#id-x-seeds').value             = (data.xSearchSeeds  || []).join(', ');

  // Pre-fill Prospects prompt textarea only if empty (don't overwrite user typing)
  const promptEl = $('#prospect-prompt');
  if (promptEl && !promptEl.value) {
    const platform = window.activePlatform || 'x';
    promptEl.value = data.icp?.[platform] || '';
  }

  // Pre-fill LinkedIn workflow seeds input only if empty
  const seedsEl = $('#wf-li-fill-seeds');
  if (seedsEl && !seedsEl.value && data.liSearchSeeds?.length) {
    seedsEl.value = data.liSearchSeeds.join(', ');
  }
  // Same for X workflow card.
  const xSeedsEl = $('#wf-x-fill-seeds');
  if (xSeedsEl && !xSeedsEl.value && data.xSearchSeeds?.length) {
    xSeedsEl.value = data.xSearchSeeds.join(', ');
  }
}

ipcRenderer.on('identity-defaults', (_e, data) => applyIdentityDefaults(data));
ipcRenderer.send('get-identity-defaults');

// When the user switches platforms, swap the Prospects prompt default to the
// new platform's ICP. Preserve user-typed input by only swapping if the current
// prompt matches one of the cached ICP defaults (i.e. wasn't custom-edited).
(function bindProspectsPromptToPlatform() {
  const original = window.applyPlatformUi;
  if (typeof original !== 'function') return;
  window.applyPlatformUi = function(platform) {
    original(platform);
    const promptEl = $('#prospect-prompt');
    if (!promptEl || !identityDefaultsCache) return;
    const icp = identityDefaultsCache.icp || {};
    const current = promptEl.value.trim();
    const isDefault = !current || current === (icp.x || '').trim() || current === (icp.linkedin || '').trim();
    if (isDefault) promptEl.value = icp[platform] || '';
  };
})();

$('#btn-save-identity')?.addEventListener('click', () => {
  const seedsRaw = ($('#id-li-seeds')?.value || '').trim();
  const li_search_seeds = seedsRaw ? seedsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const xSeedsRaw = ($('#id-x-seeds')?.value || '').trim();
  const x_search_seeds = xSeedsRaw ? xSeedsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const payload = {
    outreach_context: {
      x:        ($('#id-outreach-context-x')?.value  || '').trim(),
      linkedin: ($('#id-outreach-context-li')?.value || '').trim(),
    },
    icp: {
      x:        ($('#id-icp-x')?.value || '').trim(),
      linkedin: ($('#id-icp-li')?.value || '').trim(),
    },
    li_search_seeds,
    x_search_seeds,
  };
  const status = $('#id-save-status');
  if (status) status.textContent = 'Saving…';
  ipcRenderer.send('save-identity', payload);
});

ipcRenderer.on('identity-saved', (_e, payload) => {
  const status = $('#id-save-status');
  if (!status) return;
  status.textContent = payload.ok ? 'Saved.' : `Save failed: ${payload.error}`;
  setTimeout(() => { status.textContent = ''; }, 2000);
  // Re-fetch to refresh cache + re-apply to other panels.
  ipcRenderer.send('get-identity-defaults');
});

// ═══════════════════════════════════════════════════════════════════════
// (Manual snapshot + cleanup UI removed — backend IPC handlers in main.js stay idle.)
// ═══════════════════════════════════════════════════════════════════════
