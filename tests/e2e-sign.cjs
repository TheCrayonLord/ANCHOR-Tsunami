const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/offsetParent/.test(m.text()) && errors.push('console: ' + m.text()));
  await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
  await page.goto('http://localhost:4173/');
  const b64 = fs.readFileSync('tests/out/sample.pdf').toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'sample.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas'); await page.waitForTimeout(800);
  await page.selectOption('.zoom-select', 'page-fit'); await page.waitForTimeout(600);
  const box = await page.locator('.pdfViewer .page').first().boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const cat = (n) => page.locator('.cat', { hasText: n }).click();
  const tool = (name) => page.locator('.strip .tool', { hasText: name }).first().click();
  const idle = () => page.waitForSelector('.busy', { state: 'detached', timeout: 120000 });
  const fill = (label, v) => page.getByLabel(label, { exact: true }).fill(v);

  // Create a digital ID
  await cat('Sign'); await tool('Create digital ID');
  await fill('Your name', 'Levi Test'); await fill('Email (optional)', 'levi@example.com');
  await fill('Password', 'hunter22'); await fill('Confirm password', 'hunter22');
  const t0 = Date.now();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator('.modal .btn.primary').click()]);
  await d.saveAs('tests/out/dl-id.p12');
  console.log('digital ID created in', Date.now() - t0, 'ms:', d.suggestedFilename());

  // Sign with it (drag a box)
  await tool('Sign with certificate');
  await page.mouse.move(...at(0.55, 0.86)); await page.mouse.down(); await page.mouse.move(...at(0.92, 0.95), { steps: 5 }); await page.mouse.up();
  await page.waitForSelector('.modal');
  await fill('Digital ID password', 'hunter22');
  await page.locator('.modal label', { hasText: 'Reason' }).locator('input').fill('Approved for release');
  await page.locator('.modal .btn.primary').click();
  await idle(); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'tests/out/s-digisig.png' });

  // Verify
  await tool('Verify signatures');
  await page.waitForSelector('.sig-list li');
  console.log('verify:', (await page.locator('.sig-list li').first().innerText()).replace(/\n/g, ' | '));
  await page.screenshot({ path: 'tests/out/s-verify.png' });
  await page.keyboard.press('Escape');

  // Save and check with poppler
  const [s] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.keyboard.press('Control+s')]);
  await s.saveAs('tests/out/dl-signed.pdf');
  console.log(execSync('pdfsig tests/out/dl-signed.pdf').toString().split('\n').filter((l) => /Name|Validation|Total/.test(l)).join('\n'));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
