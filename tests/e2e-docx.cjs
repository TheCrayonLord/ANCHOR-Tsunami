const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await page.goto('http://localhost:4173/');
  const file = process.argv[2] || 'tests/out/report.pdf';
  const b64 = fs.readFileSync(file).toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'report.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas'); await page.waitForTimeout(800);
  for (const layout of ['flow', 'exact']) {
    await page.locator('.cat', { hasText: 'Convert' }).click();
    await page.locator('.strip .tool', { hasText: 'Word' }).first().click();
    await page.locator('.modal select').selectOption(layout);
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('.modal .btn.primary').click()]);
    await d.saveAs(`tests/out/report-${layout}.docx`);
    console.log(layout, fs.statSync(`tests/out/report-${layout}.docx`).size, 'bytes');
  }
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
