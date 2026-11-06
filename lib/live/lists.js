// A person's /lists page. Pull every public list, then the live pass opens each one.

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit, depth + 1);
  }
}

function asList(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  const id = node.id_str || node.rest_id || node.id;
  const idStr = String(id || '');
  if (!name || name.length > 100 || !/^\d{2,22}$/.test(idStr)) return null;
  const listish = node.__typename === 'List'
    || node.member_count != null
    || node.memberCount != null
    || node.subscriber_count != null
    || node.subscriberCount != null
    || typeof node.mode === 'string';
  if (!listish) return null;
  if (String(node.mode || '').toLowerCase() === 'private') return null;
  return { id: idStr, name: name.slice(0, 80) };
}

function extractLists(json) {
  const root = json?.data || json;
  const lists = [];
  const seen = new Set();
  walk(root, (node) => {
    const list = asList(node);
    if (!list || seen.has(list.id)) return;
    seen.add(list.id);
    lists.push(list);
  });
  return lists;
}

// https://x.com/Scobleizer/lists and @Scobleizer both become that lists page.
function listPageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^@?[A-Za-z0-9_]{1,50}$/.test(raw)) {
    return `https://x.com/${raw.replace(/^@/, '')}/lists`;
  }
  try {
    const url = new URL(raw);
    if (!/^(www\.)?(x|twitter)\.com$/i.test(url.hostname)) return '';
    const path = url.pathname.replace(/\/+$/, '');
    if (!/\/lists$/i.test(path)) return '';
    return `https://x.com${path}`;
  } catch {
    return '';
  }
}

module.exports = {
  extractLists,
  listPageUrl,
};
