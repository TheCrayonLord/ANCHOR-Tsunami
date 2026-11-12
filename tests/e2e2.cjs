const { chromium } = require('playwright');
const fs = require('fs');
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept());
  await page.goto('http://localhost:4173/');
  const b64 = fs.readFileSync('tests/out/sample.pdf').toString('base64');
  await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'sample.pdf'); }, b64);
  await page.waitForSelector('.pdfViewer .page canvas');
  await page.waitForTimeout(1000);
  await page.selectOption('.zoom-select', 'page-fit');
  await page.waitForTimeout(800);
  const pageBox = await page.locator('.pdfViewer .page').first().boundingBox();
  const at = (fx, fy) => [pageBox.x + pageBox.width * fx, pageBox.y + pageBox.height * fy];
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150); };
  const tool = (name) => page.locator('.strip .tool', { hasText: new RegExp('^' + name + '$') }).first().click();

  await tool('Rectangle'); await drag(at(0.1, 0.62), at(0.45, 0.75));
  await tool('Ellipse'); await drag(at(0.55, 0.62), at(0.85, 0.75));
  await tool('Arrow'); await drag(at(0.1, 0.8), at(0.4, 0.85));
  await tool('Underline'); await drag(at(0.1, 0.2), at(0.8, 0.215));
  await tool('Strike'); await drag(at(0.1, 0.245), at(0.5, 0.26));
  await tool('Note'); await page.mouse.click(...at(0.9, 0.1)); await page.keyboard.type('Please review this chapter');
  await tool('Stamp'); await page.mouse.click(...at(0.7, 0.88));
  await page.locator('.strip .tool', { hasText: 'Select' }).first().click();
  log('items after comment tools:', await page.evaluate(() => window.__anchor.getItems().map(i => i.kind).join(',')));
  await page.screenshot({ path: 'tests/out/s-comment.png' });

  // Edit text
  await page.locator('.cat', { hasText: 'Edit' }).click();
  await tool('Edit text'); await page.mouse.click(...at(0.3, 0.105));
  await page.keyboard.press('Control+A'); await page.keyboard.type('Chapter 1: Harbor Report (Revised)'); await page.keyboard.press('Escape');
  await tool('Add text'); await page.mouse.click(...at(0.1, 0.92)); await page.keyboard.type('Added by ANCHOR Tsunami');
  await page.mouse.click(...at(0.95, 0.97));
  log('items:', await page.evaluate(() => window.__anchor.getItems().map(i => i.kind + (i.text ? ':' + i.text : '')).join(' | ')));

  // Fill form field via pdf.js annotation layer
  await page.evaluate(() => window.__anchor.setTool('select'));
  await page.locator('.cat', { hasText: 'Forms' }).click();
  const input = page.locator('.annotationLayer input[type=text]').first();
  log('form inputs:', await page.locator('.annotationLayer input').count());
  await input.fill('Levi');

  // Save snapshot: commit
  await page.evaluate(() => window.__anchor.commit('test commit'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/out/s-committed.png' });
  const info = await page.evaluate(async () => {
    const b = await window.__anchor.snapshot();
    const fd = await window.__anchor.ops.getFormData(b);
    return { size: b.length, annots: await window.__anchor.annots(b), fd };
  });
  log('after commit:', JSON.stringify(info));

  // Redaction via search
  await page.evaluate(async () => {
    const { findText } = window.__anchor; // not exported; use markMatches with manual
  });
  await page.locator('.cat', { hasText: 'Protect' }).click();
  await tool('Mark for redaction'); await drag(at(0.1, 0.42), at(0.6, 0.45));
  await page.locator('.pending-bar .btn').click();
  await page.locator('.modal .btn.primary').click();
  await page.waitForSelector('.busy', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/out/s-redacted.png' });

  // Organize
  await page.locator('.cat', { hasText: 'Organize' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'tests/out/s-organize.png' });
  await page.locator('.org-page').nth(1).click();
  await page.locator('.tb', { hasText: 'Right' }).click();
  await page.waitForSelector('.busy', { state: 'detached' });
  await page.locator('.org-page').nth(3).click();
  await page.locator('.tb', { hasText: 'Delete' }).click();
  await page.waitForSelector('.busy', { state: 'detached' });
  await page.waitForTimeout(800);
  log('pages after delete:', await page.locator('.org-page').count());
  await page.screenshot({ path: 'tests/out/s-organize2.png' });
  // Undo
  await page.locator('button[title^="Undo"]').click();
  await page.waitForTimeout(800);
  log('pages after undo:', await page.locator('.org-page').count());

  // Ink with pdf.js editor
  await page.locator('.cat', { hasText: 'Comment' }).click();
  await page.waitForTimeout(800);
  await page.locator('.pdfViewer .page').nth(2).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await tool('Draw');
  await page.waitForTimeout(500);
  log('editor mode:', await page.evaluate(() => window.__anchor.viewer().annotationEditorMode), await page.evaluate(() => [...document.querySelectorAll('.annotationEditorLayer')].map(e => e.className).join('|')));
  const pb = await page.locator('.pdfViewer .page').nth(2).boundingBox();
  const y0 = Math.max(pb.y, 170) + 120;
  await page.mouse.move(pb.x + 200, y0); await page.mouse.down(); await page.mouse.move(pb.x + 300, y0 + 50, { steps: 10 }); await page.mouse.move(pb.x + 400, y0, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(500);
  const ink = await page.evaluate(async () => window.__anchor.annots(await window.__anchor.snapshot()));
  log('ink annots:', ink);
  await page.screenshot({ path: 'tests/out/s-ink.png' });
  log('errors:', errors.slice(0, 10));
  await browser.close();
})();
