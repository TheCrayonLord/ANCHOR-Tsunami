// Converts every fixture in tests/out/conv through the app and reports page counts and text.
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
  await page.goto('http://localhost:4173/');
  const dir = 'tests/out/conv/';
  const only = process.argv.slice(2);
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.out.pdf') && (!only.length || only.includes(f)));
  for (const f of files) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__t'; document.body.appendChild(i); i.click(); })]);
    await chooser.setFiles(dir + f);
    const t0 = Date.now();
    const res = await page.evaluate(async () => {
      const i = document.getElementById('__t'); const file = i.files[0]; i.remove();
      const m = await window.__anchor.convert([file]);
      let s = ''; const b = m.bytes; for (let k = 0; k < b.length; k += 32768) s += String.fromCharCode(...b.subarray(k, k + 32768));
      return { b64: btoa(s), notes: m.notes };
    });
    const out = dir + f + '.out.pdf';
    fs.writeFileSync(out, Buffer.from(res.b64, 'base64'));
    const pages = /Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${out}"`).toString())[1];
    const text = execSync(`pdftotext "${out}" - | head -c 90`).toString().replace(/\s+/g, ' ');
    console.log(`${f.padEnd(18)} ${String(Date.now() - t0).padStart(5)}ms  ${pages}p  ${JSON.stringify(text)}${res.notes.length ? '  NOTE: ' + res.notes[0].slice(0, 50) : ''}`);
  }
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
