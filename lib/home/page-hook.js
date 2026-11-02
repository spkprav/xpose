// Runs in the background Home tab before X's own scripts. Same idea as the
// Live hook, but it delivers to xposeHome so those bodies never enter Live.
module.exports = `
(() => {
  if (window.__xposeHomeHook) return;
  window.__xposeHomeHook = true;
  function interesting(url) {
    url = String(url || '');
    return url.indexOf('/graphql/') !== -1
      || url.indexOf('guide.json') !== -1
      || url.indexOf('/i/api/2/guide') !== -1;
  }
  const queue = [];
  function deliver(url, text) {
    if (!text || text.length > 8000000) return;
    if (window.xposeHome && typeof window.xposeHome.deliver === 'function') {
      try { window.xposeHome.deliver(String(url), text); } catch (e) {}
      return;
    }
    if (queue.length < 20) queue.push([String(url), text]);
  }
  setInterval(function() {
    if (!window.xposeHome || typeof window.xposeHome.deliver !== 'function' || !queue.length) return;
    const batch = queue.splice(0, 4);
    for (let i = 0; i < batch.length; i++) {
      try { window.xposeHome.deliver(batch[i][0], batch[i][1]); } catch (e) {}
    }
  }, 250);
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function(input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const pending = origFetch.apply(this, arguments);
      if (!interesting(url)) return pending;
      return pending.then(function(res) {
        try {
          res.clone().text().then(function(text) { deliver(url, text); }).catch(function() {});
        } catch (e) {}
        return res;
      });
    };
  }
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__xposeHomeUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        const url = this.__xposeHomeUrl || '';
        if (!interesting(url)) return;
        if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
        deliver(url, this.responseText || '');
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
`;
