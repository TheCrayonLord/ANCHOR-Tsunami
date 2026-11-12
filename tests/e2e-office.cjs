// Needs the conversion server: PORT=8799 node server/convert-server.mjs (ALLOW_ORIGINS must include http://localhost:4173)
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:4173/');
  await page.locator('.home button, .home .card', { hasText: 'Office to PDF' }).first().click();
  await page.getByLabel('Conversion server address').fill('http://localhost:8799');
  await page.locator('.modal input[type=file]').setInputFiles('tests/out/report-flow.docx');
  await page.locator('.modal .btn.primary').click();
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60000 });
  await page.waitForTimeout(800);
  console.log('opened:', await page.locator('.topbar, header').first().innerText().then((t) => t.split('\n').find((l) => l.includes('.pdf'))));
  await page.screenshot({ path: 'tests/out/s-office.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
