// Universal DOM scraper for LinkedIn pages.
//
// LinkedIn ships TWO different DOM templates across surfaces:
//
//  TEMPLATE A — feed, connections, mynetwork (new obfuscated-class shell):
//     <a href="/in/HANDLE">
//       <p>NAME</p>
//       <p>HEADLINE</p>
//     </a>
//
//  TEMPLATE B — people search results (old `entity-result` style, still ships):
//     <a href="/in/HANDLE">         ← avatar link (no text)
//     <a href="/in/HANDLE"><span dir="ltr"><span>NAME</span></span></a>  ← text link
//     <div>HEADLINE</div>           ← sibling div in card
//     <div>LOCATION</div>           ← sibling div
//
// We try Template A first (in-anchor <p> extraction). If that yields nothing
// for an anchor that DOES have text, we fall through to Template B: read the
// anchor's text as name, then walk up to a card container and pick the next
// non-degree, non-location-only sibling divs as headline + location.

async function scrapeProfilesFromPage(view, { selfHandle = null } = {}) {
  if (view.webContents.isDestroyed()) return [];
  return view.webContents.executeJavaScript(`
    (function() {
      const SELF = ${JSON.stringify(selfHandle || '')};

      function visibleText(node) {
        if (!node) return '';
        const aria = node.querySelector && node.querySelector('span[aria-hidden="true"]');
        const t = (aria || node).textContent || '';
        return t.replace(/\\s+/g, ' ').trim();
      }

      const DEGREE_RE   = /(•\\s*(1st|2nd|3rd\\+?|3rd)\\b)|((1st|2nd|3rd\\+?|3rd)\\s+degree)/i;
      const NON_HEADLINE = [
        /^•\\s*(1st|2nd|3rd\\+?|3rd)\\b/i,
        /^Connected on /i,
        /^Connected\\b/i,
        /^Pending\\b/i,
        /^Premium\\b/i,
        /^Status\\b/i,
        /^Open to/i,
        /\\bis a mutual connection\\b/i,
      ];
      function isHeadline(t) {
        if (!t || t.length < 3 || t.length > 280) return false;
        return !NON_HEADLINE.some(re => re.test(t));
      }
      // Location is short geographic-style text. Heuristic: <= 60 chars, no
      // verbs/role keywords. Pretty loose — we just need to NOT misclassify
      // headlines as locations.
      function looksLikeLocation(t) {
        if (!t || t.length < 2 || t.length > 60) return false;
        if (/@|\\bat\\b|engineer|manager|founder|owner|director|developer|consultant|designer|coach/i.test(t)) return false;
        if (DEGREE_RE.test(t)) return false;
        return true;
      }

      const ACTIVITY_VERB = /(commented|reacted|likes? this|reposted|posted this|shared a post|loves this|celebrates this|supports? this|finds this insightful|finds this funny|congratulates|reposted this)/i;

      function stripDegreeFromName(s) {
        return (s || '').replace(/\\s*•\\s*(1st|2nd|3rd\\+?|3rd)\\b.*$/i, '').trim();
      }

      // TEMPLATE B fallback: given an anchor whose text is the name, walk
      // outward to find a card container and read sibling text blocks.
      function templateBExtract(a, name) {
        // Walk up to a container that has multiple text-bearing div children.
        let card = a;
        for (let i = 0; i < 8 && card; i++) {
          card = card.parentElement;
          if (!card) break;
          const divs = Array.from(card.children || []).filter(c => c.tagName === 'DIV');
          if (divs.length < 2) continue;
          const lines = [];
          for (const d of divs) {
            const t = visibleText(d);
            if (!t || t === name) continue;
            // Strip "Name • 2nd • 2nd" duplicates: if line begins with the
            // name, drop that prefix and look at the remainder.
            let stripped = t;
            if (t.toLowerCase().indexOf(name.toLowerCase()) === 0) {
              stripped = t.slice(name.length).trim();
            }
            if (DEGREE_RE.test(stripped) && stripped.length < 30) continue;
            lines.push(stripped || t);
            if (lines.length >= 4) break;
          }
          let headline = null, location = null;
          for (const l of lines) {
            if (!headline && isHeadline(l) && !DEGREE_RE.test(l)) { headline = l; continue; }
            if (!location && looksLikeLocation(l)) { location = l; continue; }
          }
          if (headline || location) return { headline, location };
        }
        return { headline: null, location: null };
      }

      const links = document.querySelectorAll('a[href*="/in/"]');
      const byHandle = new Map();

      for (const a of links) {
        const href = a.href || a.getAttribute('href') || '';
        const m = href.match(/\\/in\\/([^/?#]+)/);
        if (!m) continue;
        const handle = decodeURIComponent(m[1]);
        if (SELF && handle === SELF) continue;
        // Skip URN-format anonymized previews (commercial-limit indicator).
        if (handle.startsWith('ACoAA') && handle.length > 30) continue;

        let name = null;
        let headline = null;
        let location = null;

        // ── TEMPLATE A ──────────────────────────────────────────────
        const ps = a.querySelectorAll('p');
        if (ps.length) {
          name = stripDegreeFromName(visibleText(ps[0]));
          for (let i = 1; i < ps.length; i++) {
            const t = visibleText(ps[i]);
            if (isHeadline(t) && t !== name && !t.startsWith(name)) { headline = t; break; }
          }
        } else {
          // ── TEMPLATE B (old entity-result style) ───────────────────
          const anchorText = stripDegreeFromName(visibleText(a));
          if (anchorText && anchorText.length > 1 && anchorText.length < 100) {
            name = anchorText;
            const ext = templateBExtract(a, name);
            headline = ext.headline;
            location = ext.location;
          }
        }

        if (!name || name.length < 2 || name.length > 100) continue;
        if (/^(View|See|Open|More|Show)\\s/i.test(name)) continue;

        const surroundingText = (a.parentElement && a.parentElement.textContent || '').slice(0, 200);
        const activitySignal = ACTIVITY_VERB.test(surroundingText) ? surroundingText.match(ACTIVITY_VERB)[0] : null;

        const existing = byHandle.get(handle);
        const newRow = {
          platform: 'linkedin',
          handle,
          profile_url: 'https://www.linkedin.com/in/' + handle + '/',
          display_name: name,
          headline: headline || null,
          bio: null,
          location: location || null,
          followers_count: 0,
          following_count: 0,
          company: null,
          title: null,
          raw_data: { source: 'dom-scrape', activity_signal: activitySignal },
        };
        if (!existing) {
          byHandle.set(handle, newRow);
        } else {
          const score = r => (r.headline ? 2 : 0) + (r.location ? 1 : 0) + (r.display_name ? 1 : 0);
          if (score(newRow) > score(existing)) byHandle.set(handle, newRow);
        }
      }

      return Array.from(byHandle.values());
    })()
  `, true);
}

module.exports = { scrapeProfilesFromPage };
