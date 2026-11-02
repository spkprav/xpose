// Runs in the X page before its own scripts. Copies GraphQL and guide
// responses back to the app. CDP getResponseBody was returning nothing.
module.exports = `
(() => {
  if (window.__xposeLiveHook) return;
  window.__xposeLiveHook = true;
  function interesting(url) {
    url = String(url || '');
    return url.indexOf('/graphql/') !== -1
      || url.indexOf('guide.json') !== -1
      || url.indexOf('/i/api/2/guide') !== -1;
  }
  const queue = [];
  function deliver(url, text) {
    if (!text || text.length > 8000000) return;
    if (window.xposeLive && typeof window.xposeLive.deliver === 'function') {
      try { window.xposeLive.deliver(String(url), text); } catch (e) {}
      return;
    }
    if (queue.length < 20) queue.push([String(url), text]);
  }
  setInterval(function() {
    if (!window.xposeLive || typeof window.xposeLive.deliver !== 'function' || !queue.length) return;
    const batch = queue.splice(0, 4);
    for (let i = 0; i < batch.length; i++) {
      try { window.xposeLive.deliver(batch[i][0], batch[i][1]); } catch (e) {}
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
    this.__xposeUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        const url = this.__xposeUrl || '';
        if (!interesting(url)) return;
        if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
        deliver(url, this.responseText || '');
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
`;
