// A one-page report with heading, paragraphs, a table, an image and centered text, for Word export tests.
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const f = await doc.embedFont(StandardFonts.TimesRoman);
const fb = await doc.embedFont(StandardFonts.HelveticaBold);
const fh = await doc.embedFont(StandardFonts.Helvetica);
const wrap = (t: string, size: number, w: number) => {
  const out: string[] = []; let line = '';
  for (const word of t.split(' ')) { const n = line ? line + ' ' + word : word; if (f.widthOfTextAtSize(n, size) > w && line) { out.push(line); line = word; } else line = n; }
  out.push(line); return out;
};
page.drawText('Harbor Operations Summary', { x: 72, y: 720, size: 20, font: fb, color: rgb(0.1, 0.2, 0.4) });
let y = 690;
const para = (t: string) => { for (const l of wrap(t, 11, 468)) { page.drawText(l, { x: 72, y, size: 11, font: f }); y -= 14; } y -= 10; };
para('The harbor handled a record volume of container traffic this quarter. Throughput rose by twelve percent compared with the same period last year, driven mostly by the new eastern berth and longer operating hours at the northern terminal.');
page.drawText('Quarterly volumes', { x: 72, y, size: 13, font: fb }); y -= 22;
const rows = [['Terminal', 'Containers', 'Change', 'Berths'], ['North', '182,400', '+9%', '6'], ['East', '96,250', '+31%', '4'], ['South', '64,900', '-2%', '3']];
const cols = [72, 220, 340, 440];
for (const [ri, r] of rows.entries()) { r.forEach((c, ci) => page.drawText(c, { x: cols[ci], y, size: 11, font: ri === 0 ? fb : fh })); y -= 18; }
y -= 14;
const png = await doc.embedPng(readFileSync('tests/fixture-gradient.png'));
page.drawImage(png, { x: 246, y: y - 120, width: 120, height: 120 });
y -= 140;
para('Maintenance dredging is scheduled for the spring. During that time the inner channel will be limited to vessels with a draft below eleven metres, and pilots should plan arrivals around the tide tables published each week.');
const c = 'Prepared by the planning office';
page.drawText(c, { x: 306 - f.widthOfTextAtSize(c, 11) / 2, y: 60, size: 11, font: f });
writeFileSync('tests/out/report.pdf', await doc.save());
console.log('report written');
