import { createWorker } from 'tesseract.js';
const w = await createWorker('eng');
const { data } = await w.recognize('tests/out/scan-1.png', {}, { blocks: true });
console.log('words', data.blocks?.flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words))).length, data.text.slice(0, 80));
await w.terminate();
