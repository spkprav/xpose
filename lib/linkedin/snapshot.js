// Capture full HTML of whatever the linkedinView currently renders.
// Writes to out/linkedin-recon/snapshots/<phase>-<ISO-timestamp>.html.
// Header comment carries url + title + phase so the file is self-describing.

const fs = require('fs');
const path = require('path');

const SNAP_DIR = path.resolve(__dirname, '..', '..', 'out', 'linkedin-recon', 'snapshots');

function ensureDir() {
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
}

async function snapshotHtml(view, phase = 'manual') {
  if (!view || view.webContents.isDestroyed()) {
    console.error(`[LinkedIn:Snapshot] ${phase}: view destroyed/missing`);
    return { ok: false, error: 'linkedinView destroyed or missing' };
  }
  try {
    ensureDir();
    const result = await view.webContents.executeJavaScript(`
      ({ html: document.documentElement.outerHTML, href: location.href, title: document.title })
    `, true);
    if (!result || typeof result.html !== 'string') {
      console.error(`[LinkedIn:Snapshot] ${phase}: empty page result, href=${result && result.href}`);
      return { ok: false, error: 'empty page result' };
    }
    const safe = (phase || 'page').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(SNAP_DIR, `${safe}-${ts}.html`);
    const header = `<!-- captured ${new Date().toISOString()} url=${result.href} title=${JSON.stringify(result.title)} phase=${phase} -->\n`;
    fs.writeFileSync(file, header + result.html);
    console.log(`[LinkedIn:Snapshot] ${phase} → ${file} (${(result.html.length/1024).toFixed(1)}KB, url=${result.href})`);
    return { ok: true, file, url: result.href, title: result.title, size: result.html.length };
  } catch (err) {
    console.error(`[LinkedIn:Snapshot] ${phase} ERROR:`, err.stack || err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { snapshotHtml, SNAP_DIR };
