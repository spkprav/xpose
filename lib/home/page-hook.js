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
  function urlOf(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof input.url === 'string') return input.url;
    try { return String(input); } catch (e) { return ''; }
  }
  const queue = [];
  function deliver(url, text) {
    if (!text || text.length > 8000000) return;
    url = String(url || '');
    if (!interesting(url)) return;
    if (window.xposeHome && typeof window.xposeHome.deliver === 'function') {
      try { window.xposeHome.deliver(url, text); } catch (e) {}
      return;
    }
    if (queue.length < 60) queue.push([url, text]);
  }
  setInterval(function() {
    if (!window.xposeHome || typeof window.xposeHome.deliver !== 'function' || !queue.length) return;
    const batch = queue.splice(0, 4);
    for (let i = 0; i < batch.length; i++) {
      try { window.xposeHome.deliver(batch[i][0], batch[i][1]); } catch (e) {}
    }
  }, 250);
  // X replaces window.fetch after startup. Keep wrapping whatever is current
  // so useStoryTopicQuery still comes through.
  function armFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__xposeHome) return;
    const origFetch = window.fetch;
    function wrapped(input) {
      const url = urlOf(input);
      const pending = origFetch.apply(this, arguments);
      if (!interesting(url) || !pending || typeof pending.then !== 'function') return pending;
      return pending.then(function(res) {
        try {
          res.clone().text().then(function(text) { deliver(url, text); }).catch(function() {});
        } catch (e) {}
        return res;
      });
    }
    wrapped.__xposeHome = true;
    window.fetch = wrapped;
  }
  armFetch();
  setInterval(armFetch, 1000);
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    try { this.__xposeHomeUrl = urlOf(url); } catch (e) { this.__xposeHomeUrl = ''; }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        const url = this.__xposeHomeUrl || '';
        if (!interesting(url)) return;
        const type = this.responseType;
        if (type === 'json') {
          if (this.response == null) return;
          deliver(url, typeof this.response === 'string' ? this.response : JSON.stringify(this.response));
          return;
        }
        if (type && type !== '' && type !== 'text') return;
        deliver(url, this.responseText || '');
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
`;
