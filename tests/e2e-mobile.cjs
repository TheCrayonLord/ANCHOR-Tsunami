const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  for (const [name, w, h] of [['tablet', 625, 1000], ['phone', 390, 800], ['desktop', 1400, 900]]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, hasTouch: name !== 'desktop' })).newPage();
    await page.goto('http://localhost:4173/');
    const b64 = fs.readFileSync('tests/out/sample.pdf').toString('base64');
    await page.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.__anchor.openBytes(u, 'sample.pdf'); }, b64);
    await page.waitForSelector('.pdfViewer .page canvas'); await page.waitForTimeout(600);
    for (const c of ['comment', 'sign']) {
      await page.locator('.cat').nth(c === 'comment' ? 1 : 5).click();
      await page.locator('.strip .tool').nth(c === 'comment' ? 5 : 6).click(); await page.waitForTimeout(300);
      // any two tools overlapping?
      const overlap = await page.evaluate(() => { const r = [...document.querySelectorAll('.strip-tools > *')].map((e) => e.getBoundingClientRect()); let n = 0; for (let i = 1; i < r.length; i++) if (r[i].left < r[i - 1].right - 0.5) n++; const sb = document.querySelector('.style-bar')?.getBoundingClientRect(); const st = document.querySelector('.strip-tools').getBoundingClientRect(); return { n, styleBelow: sb ? sb.top >= st.bottom - 0.5 : null }; });
      console.log(name, c, JSON.stringify(overlap));
      await page.screenshot({ path: `tests/out/s-${name}-${c}.png`, clip: { x: 0, y: 0, width: w, height: 260 } });
    }
    await page.close();
  }
  await browser.close();
})();
