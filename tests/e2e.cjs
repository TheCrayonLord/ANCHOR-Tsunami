const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' , args: ['--no-sandbox'] }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.goto('http://localhost:4173/');
  await page.screenshot({ path: 'tests/out/s-home.png' });
  const b64 = fs.readFileSync('tests/out/sample.pdf').toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'sample.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/out/s-view.png' });
  console.log('errors:', errors.slice(0, 10));
  await browser.close();
})();
