const { chromium } = require('playwright');
const fs = require('fs');
const log = (...a) => console.log(...a);
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
  const pageBox = await page.locator('.pdfViewer .page').first().boundingBox();
  const at = (fx, fy) => [pageBox.x + pageBox.width * fx, pageBox.y + pageBox.height * fy];
  const cat = (n) => page.locator('.cat', { hasText: n }).click();
  const tool = (name) => page.locator('.strip .tool', { hasText: name }).first().click();
  const idle = () => page.waitForSelector('.busy', { state: 'detached', timeout: 60000 });
  const dl = async (fn) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), fn()]); const p = 'tests/out/dl-' + d.suggestedFilename(); await d.saveAs(p); return p + ' ' + fs.statSync(p).size; };

  // Signature: type mode
  await cat('Sign'); await tool('Create signature');
  await page.locator('.seg button', { hasText: 'Type' }).click();
  await page.locator('.sig-type input').fill('Levi Knobloch');
  await page.locator('.modal .btn.primary').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.mouse.click(...at(0.6, 0.85));
  await tool('Add date');
  await page.mouse.click(...at(0.7, 0.05));
  log('items:', await page.evaluate(() => window.__anchor.getItems().map(i => i.kind).join(',')));
  await page.screenshot({ path: 'tests/out/s-sign.png' });

  // Watermark
  await cat('Edit'); await tool('Watermark');
  await page.locator('.modal .btn.primary').click(); await idle(); await page.waitForTimeout(800);
  // Page numbers
  await tool('Page numbers'); await page.locator('.modal .btn.primary').click(); await idle(); await page.waitForTimeout(800);
  await page.screenshot({ path: 'tests/out/s-watermark.png' });

  // Search + highlight all
  await page.keyboard.press('Control+f');
  await page.locator('.search-box input').fill('lazy dog');
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  log('search:', await page.locator('.search-summary').innerText());
  await page.locator('.search-summary button', { hasText: 'Highlight all' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'tests/out/s-search.png' });

  // Bookmark add
  await page.locator('.rail-btn[title=Bookmarks]').click();
  await page.locator('.panel-title .icon-btn').click();
  await page.locator('.modal input').fill('Intro'); await page.locator('.modal .btn.primary').click();
  await page.locator('.panel-actions .btn').click(); await idle(); await page.waitForTimeout(800);
  log('outline:', await page.locator('.outline-title').allInnerTexts());

  // Exports
  await cat('Convert');
  log('docx', await dl(async () => { await tool('Word'); await page.locator('.modal .btn.primary').click(); }));
  log('txt', await dl(() => tool('Text')));
  log('csv', await dl(() => tool('Spreadsheet')));
  log('png', await dl(async () => { await tool('PNG'); await page.locator('.modal .btn.primary').click(); }));
  // Protect
  await cat('Protect'); await tool('Password');
  await page.locator('.modal input[type=password]').nth(0).fill('open123');
  await page.locator('.modal input[type=password]').nth(1).fill('owner123');
  log('protected', await dl(() => page.locator('.modal .btn.primary').click()));
  // Find & redact patterns
  await tool('Find & redact');
  await page.locator('.modal label', { hasText: 'Email addresses' }).click();
  await page.locator('.modal .btn.primary').click(); await idle(); await page.waitForTimeout(400);
  log('redact marks:', await page.evaluate(() => window.__anchor.getItems().filter(i => i.kind === 'redact').length));
  await page.screenshot({ path: 'tests/out/s-findredact.png' });
  // Save (download)
  log('saved', await dl(() => page.keyboard.press('Control+s')));
  // Compare against original
  await cat('Tools');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tool('Compare')]);
  await chooser.setFiles('tests/out/sample.pdf'); await idle(); await page.waitForTimeout(500);
  log('compare:', (await page.locator('.compare-head').innerText()).replace(/\n/g, ' '));
  await page.screenshot({ path: 'tests/out/s-compare.png' });
  await page.keyboard.press('Escape');
  // Properties
  await tool('Properties'); await page.waitForTimeout(400);
  await page.screenshot({ path: 'tests/out/s-props.png' });
  await page.keyboard.press('Escape');
  // Accessibility
  await tool('Accessibility'); await idle(); await page.waitForTimeout(300);
  log('a11y:', (await page.locator('.a11y-list').innerText()).replace(/\n/g, ' / '));
  await page.keyboard.press('Escape');
  // Dark mode screenshot
  await page.locator('button[title="Toggle dark mode"]').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: 'tests/out/s-dark.png' });
  log('errors:', errors.slice(0, 10));
  await browser.close();
})();
