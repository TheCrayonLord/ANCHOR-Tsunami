const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--ignore-certificate-errors'],  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:4173/');
  await page.waitForFunction(() => window.__anchor, null, { timeout: 30000 });
  const b64 = fs.readFileSync('tests/out/scan.pdf').toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'sample.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas'); await page.waitForTimeout(800);
  // Make it a "scan": strong compression rasterizes; then strip text by redacting nothing... use compress (keeps text). Instead test OCR on an image-only PDF created from a rendered PNG.
  await page.locator('.cat', { hasText: 'Tools' }).click();
  await page.locator('.strip .tool', { hasText: 'Recognize text' }).click();
  await page.locator('.modal label', { hasText: 'Skip pages' }).click();
  await page.locator('.modal input[type=text]').fill('1');
  await page.locator('.modal .btn.primary').click();
  const t0 = Date.now();
  await page.waitForSelector('.busy', { state: 'detached', timeout: 240000 });
  console.log('ocr took', Date.now() - t0, 'ms');
  console.log('toasts', await page.locator('.toast').allInnerTexts());
  const found = await page.evaluate(async () => { const b = await window.__anchor.snapshot(); const d = await window.__anchor.loadPlain(b); const p = await d.getPage(1); const tc = await p.getTextContent(); return tc.items.map(i => i.str).join(' ').slice(0, 200); });
  console.log('text layer:', found);
  await browser.close();
})();
