import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { writeFileSync } from 'node:fs';
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const f = await doc.embedFont(StandardFonts.TimesRoman);
const fb = await doc.embedFont(StandardFonts.HelveticaBold);
const wrap = (t: string, size: number, w: number) => {
  const out: string[] = []; let line = '';
  for (const word of t.split(' ')) { const n = line ? line + ' ' + word : word; if (f.widthOfTextAtSize(n, size) > w && line) { out.push(line); line = word; } else line = n; }
  out.push(line); return out;
};
page.drawText('Harbor Operations Summary', { x: 72, y: 700, size: 20, font: fb, color: rgb(0.1, 0.2, 0.4) });
const p1 = 'The harbor handled a record volume of container traffic this quarter. Throughput rose by twelve percent compared with the same period last year, driven mostly by the new eastern berth and longer operating hours at the northern terminal.';
const p2 = 'Maintenance dredging is scheduled for the spring. During that time the inner channel will be limited to vessels with a draft below eleven metres, and pilots should plan arrivals around the tide tables published each week.';
let y = 660;
for (const p of [p1, p2]) { for (const l of wrap(p, 12, 400)) { page.drawText(l, { x: 72, y, size: 12, font: f }); y -= 15; } y -= 15; }
const c = 'Prepared by the Port Authority planning office for internal review only';
for (const l of wrap(c, 12, 250)) { const w = f.widthOfTextAtSize(l, 12); page.drawText(l, { x: 306 - w / 2, y, size: 12, font: f }); y -= 15; }
writeFileSync('tests/out/paragraphs.pdf', await doc.save());
console.log('paragraphs written');
