import puppeteer from 'puppeteer';
import path from 'node:path';

const ASSET_DIR = '/Users/pk/obsidian/Life/posts/2026-5-20/22-00/assets';
const htmlPath = 'file://' + path.join(ASSET_DIR, 'featured.html');
const outPath = path.join(ASSET_DIR, 'featured.png');

const browser = await puppeteer.launch({
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(htmlPath, { waitUntil: 'networkidle0' });
await page.screenshot({ path: outPath, omitBackground: false, type: 'png' });
await browser.close();
console.log('wrote', outPath);
