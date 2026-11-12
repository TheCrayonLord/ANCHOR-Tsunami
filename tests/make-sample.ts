import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica); const fb = await d.embedFont(StandardFonts.HelveticaBold);
const lorem = 'The quick brown fox jumps over the lazy dog. Contact jane.doe@example.com or call 555-123-4567 for details. SSN 123-45-6789.';
for (let p = 1; p <= 4; p++) {
  const pg = d.addPage([612, 792]);
  pg.drawText(`Chapter ${p}: Harbor Report`, { x: 72, y: 700, size: 22, font: fb, color: rgb(0.1, 0.2, 0.4) });
  for (let i = 0; i < 12; i++) pg.drawText(`${i + 1}. ${lorem.slice(0, 80)}`, { x: 72, y: 660 - i * 22, size: 11, font: f });
  pg.drawText(lorem.slice(80), { x: 72, y: 380, size: 11, font: f });
  pg.drawRectangle({ x: 72, y: 150, width: 468, height: 180, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1, color: rgb(0.93, 0.96, 1) });
  pg.drawText(`Figure ${p}`, { x: 280, y: 235, size: 14, font: f });
}
const form = d.getForm();
const tf = form.createTextField('name'); tf.addToPage(d.getPage(0), { x: 72, y: 100, width: 200, height: 22 });
const cb = form.createCheckBox('agree'); cb.addToPage(d.getPage(0), { x: 290, y: 104, width: 14, height: 14 });
mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/sample.pdf', await d.save());
console.log('sample written');
