const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
  await page.goto('http://localhost:4173/');
  // One file from the home screen
  let [ch] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.home', { hasText: 'Any file to PDF' }).getByText('Any file to PDF').click()]);
  await ch.setFiles('tests/out/conv/deck.pptx');
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60000 }); await page.waitForTimeout(1000);
  console.log('single:', await page.evaluate(() => window.__anchor.viewer().pagesCount));
  await page.screenshot({ path: 'tests/out/s-anyfile.png' });
  // Several mixed files through Combine
  await page.locator('.cat', { hasText: 'Convert' }).click();
  [ch] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.strip .tool', { hasText: 'Any file' }).first().click()]);
  await ch.setFiles(['tests/out/conv/notes.md', 'tests/out/conv/pic.webp', 'tests/out/conv/data.xlsx', 'tests/out/sample.pdf']);
  await page.waitForSelector('.modal'); await page.screenshot({ path: 'tests/out/s-combine-any.png' });
  await page.locator('.modal .btn.primary').click();
  await page.waitForSelector('.busy', { state: 'detached', timeout: 60000 }); await page.waitForTimeout(1500);
  console.log('combined pages:', await page.evaluate(() => window.__anchor.viewer().pagesCount));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
