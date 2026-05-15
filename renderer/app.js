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
  if ($('#db-port'))     $('#db-port').value     = db.port     != null ? db.port : 54329;
  if ($('#db-user'))     $('#db-user').value     = db.user     || 'postgres';
  if ($('#db-password')) $('#db-password').value = db.password || 'postgres';
  if ($('#db-database')) $('#db-database').value = db.database || 'xpose';
  const listIds = settings.lists || {};
  LIST_SLUGS.forEach(slug => {
    const el = $(`#list-id-${slug}`);
    if (el) el.value = listIds[slug] || '';
  });
  renderListCards();
  renderProviders();
  if (settings.profile) {
    $('#profile-info')?.classList.remove('hidden');
    if ($('#profile-name'))   $('#profile-name').textContent   = settings.profile.name || '';
    if ($('#profile-handle')) $('#profile-handle').textContent = `@${settings.profile.screen_name}`;
  }
});

$('#btn-save-settings').addEventListener('click', () => {
  collectCurrentInputs();
  const newSettings = {
    llmProvider: selectedProvider,
    icpCriteria: $('#icp-criteria')?.value || '',
    feedLinks:   $('#feed-links')?.value   || '',
    database: {
      host:     $('#db-host')?.value     || 'localhost',
      port:     Number($('#db-port')?.value) || 54329,
      user:     $('#db-user')?.value     || 'postgres',
      password: $('#db-password')?.value || 'postgres',
      database: $('#db-database')?.value || 'xpose',
    },
    lists: collectListIds(),
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
    settings.icpCriteria  = $('#icp-criteria')?.value || '';
    settings.feedLinks    = $('#feed-links')?.value   || '';
    settings.database = {
      host:     $('#db-host')?.value     || 'localhost',
      port:     Number($('#db-port')?.value) || 54329,
      user:     $('#db-user')?.value     || 'postgres',
      password: $('#db-password')?.value || 'postgres',
      database: $('#db-database')?.value || 'xpose',
    };
    settings.lists = collectListIds();
    renderListCards();
    providerInputs = {};
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
            ? `<button class="sb-action-link list-stop-btn" data-slug="${slug}">Stop</button>`
            : `<button class="sb-btn-primary list-open-btn" data-slug="${slug}" ${configured ? '' : 'disabled'}>Open &amp; crawl</button>`}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.list-open-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.slug;
      const listId = (settings.lists || {})[slug];
      if (!listId) { showGlobalStatus('Set the list ID in Settings first'); return; }
      ipcRenderer.send('open-list', { slug, listId });
    });
  });
  container.querySelectorAll('.list-stop-btn').forEach(btn => {
    btn.addEventListener('click', () => ipcRenderer.send('stop-list-crawl'));
  });
}

function refreshListStats() {
  ipcRenderer.send('get-list-stats', LIST_SLUGS);
}

ipcRenderer.on('list-stats', (event, stats) => {
  listStatsCache = stats || {};
  renderListCards();
});

ipcRenderer.on('list-crawl-status', (event, payload) => {
  const { slug, status, message } = payload || {};
  const strip = $('#list-crawl-strip');
  const text  = $('#list-crawl-text');
  if (status === 'started' || status === 'scrolling') {
    activeListSlug = slug;
    strip?.classList.remove('hidden');
    if (text) text.textContent = message || `Crawling ${slug}...`;
  } else if (status === 'stopped' || status === 'done' || status === 'error') {
    activeListSlug = null;
    strip?.classList.add('hidden');
    refreshListStats();
  } else if (status === 'progress') {
    if (text) text.textContent = message || `Crawling ${slug}...`;
  }
  renderListCards();
});

$('#btn-refresh-lists')?.addEventListener('click', refreshListStats);
$('#btn-stop-list-crawl')?.addEventListener('click', () => ipcRenderer.send('stop-list-crawl'));

// Refresh stats when Lists tab is opened
document.querySelector('[data-tab="lists"]')?.addEventListener('click', refreshListStats);

// ═══════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════
renderProviders();
initIcons();
refreshListStats();
