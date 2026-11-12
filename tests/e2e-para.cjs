const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:4173/');
  const b64 = fs.readFileSync('tests/out/paragraphs.pdf').toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'p.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas'); await page.waitForTimeout(800);
  await page.selectOption('.zoom-select', 'page-width'); await page.waitForTimeout(800);
  const box = await page.locator('.pdfViewer .page').first().boundingBox();
  const scale = box.width / 612;
  const pt = (x, y) => [box.x + x * scale, box.y + (792 - y) * scale];
  await page.locator('.cat', { hasText: 'Edit' }).click();
  await page.locator('.strip .tool', { hasText: 'Edit text' }).first().click();
  const clickAt = async (x, y, shift) => { if (shift) await page.keyboard.down('Shift'); await page.mouse.click(...pt(x, y)); if (shift) await page.keyboard.up('Shift'); await page.waitForTimeout(400); };
  // paragraph 1, line 2
  await clickAt(150, 648);
  let items = await page.evaluate(() => window.__anchor.getItems());
  console.log('p1:', items.length, JSON.stringify({ text: items[0].text, lh: items[0].lineHeight, align: items[0].align }));
  await page.keyboard.press('Control+End');
  await page.screenshot({ path: 'tests/out/s-para-noedit.png' }); await page.keyboard.type(' Dwell times fell.');
  await page.mouse.click(box.x + 5, box.y + box.height - 10); await page.waitForTimeout(200);
  // shift click single line of paragraph 2
  await clickAt(100, 585, true);
  items = await page.evaluate(() => window.__anchor.getItems());
  console.log('single:', JSON.stringify({ text: items[items.length - 1].text, nowrap: items[items.length - 1].nowrap }));
  await page.keyboard.press('Escape');
  // centered paragraph
  await clickAt(306, 528);
  items = await page.evaluate(() => window.__anchor.getItems());
  console.log('centered:', JSON.stringify({ text: items[items.length - 1].text, align: items[items.length - 1].align }));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'tests/out/s-para-edit.png' });
  await page.evaluate(() => window.__anchor.commit('Apply'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/out/s-para-after.png' });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
