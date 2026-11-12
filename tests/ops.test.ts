import * as ops from '../src/lib/ops';
import { PDFDocument } from '@cantoo/pdf-lib';
import { readFile } from 'node:fs/promises';
ops.setFontLoader(async (f) => new Uint8Array(await readFile(`public/fonts/${f}`)));
import assert from 'node:assert';
const ok = (m: string) => console.log('ok -', m);
let b = await ops.blankDocument(3);
b = await ops.textToPdf('Hello world\nSecond line of the ANCHOR Tsunami test document.');
b = await ops.insertDocument(b, await ops.blankDocument(2), 1); assert.equal(await ops.pageCount(b), 3); ok('insert');
b = await ops.reorderPages(b, [2, 0, 1]); ok('reorder');
b = await ops.duplicatePages(b, [0]); assert.equal(await ops.pageCount(b), 4); ok('duplicate');
b = await ops.deletePages(b, [3]); assert.equal(await ops.pageCount(b), 3); ok('delete');
b = await ops.rotatePages(b, [0], 90); ok('rotate');
const items: any[] = [
  { id: 'a1', page: 0, kind: 'rect', rect: { x: 50, y: 50, w: 100, h: 60 }, color: '#ff0000', width: 2 },
  { id: 'a2', page: 0, kind: 'ellipse', rect: { x: 200, y: 50, w: 100, h: 60 }, color: '#0000ff', fill: '#ccccff', width: 1, opacity: 0.5 },
  { id: 'a3', page: 1, kind: 'arrow', rect: { x: 0, y: 0, w: 0, h: 0 }, pts: [[50, 50], [200, 200]], color: '#00aa00' },
  { id: 'a4', page: 1, kind: 'measure', rect: { x: 0, y: 0, w: 0, h: 0 }, pts: [[50, 300], [200, 300]], text: '2.08 in' },
  { id: 'a5', page: 1, kind: 'note', rect: { x: 300, y: 300, w: 20, h: 20 }, text: 'A note ünïcode' },
  { id: 'a6', page: 2, kind: 'stamp', rect: { x: 100, y: 400, w: 180, h: 60 }, text: 'Approved' },
  { id: 'a7', page: 2, kind: 'text', rect: { x: 100, y: 300, w: 200, h: 60 }, text: 'Added text → arrow', fontSize: 14 },
  { id: 'a8', page: 2, kind: 'link', rect: { x: 100, y: 200, w: 100, h: 20 }, url: 'https://example.com' },
  { id: 'a9', page: 2, kind: 'link', rect: { x: 100, y: 170, w: 100, h: 20 }, destPage: 0 },
  { id: 'b1', page: 2, kind: 'field', fieldType: 'text', name: 'fullName', rect: { x: 100, y: 100, w: 200, h: 20 } },
  { id: 'b2', page: 2, kind: 'field', fieldType: 'checkbox', name: 'agree', rect: { x: 320, y: 100, w: 14, h: 14 } },
  { id: 'b3', page: 2, kind: 'field', fieldType: 'dropdown', name: 'pick', options: ['A','B'], rect: { x: 100, y: 60, w: 100, h: 20 } },
  { id: 'b4', page: 2, kind: 'field', fieldType: 'radio', name: 'grp', text: 'yes', rect: { x: 220, y: 60, w: 14, h: 14 } },
  { id: 'b5', page: 2, kind: 'field', fieldType: 'radio', name: 'grp', text: 'no', rect: { x: 240, y: 60, w: 14, h: 14 } },
  { id: 'b6', page: 0, kind: 'whiteout', rect: { x: 10, y: 10, w: 10, h: 10 } },
];
b = await ops.applyItems(b, items); ok('applyItems');
let d = await PDFDocument.load(b); assert.deepEqual(d.getForm().getFields().map(f=>f.getName()).sort(), ['agree','fullName','grp','pick']); ok('fields');
b = await ops.addWatermark(b, { text: 'CONFIDENTIAL', fontSize: 60, color: '#888888', opacity: 0.3, rotation: 45, behind: true }); ok('watermark');
b = await ops.addHeaderFooter(b, { bottomCenter: 'Page {page} of {pages}', topRight: '{bates}', batesPrefix: 'ACME', fontSize: 9, color: '#333333', margin: 24 }); ok('header/footer');
b = await ops.addBackground(b, '#fffbe6'); ok('background');
b = await ops.setOutline(b, [{ title: 'Start', page: 0, children: [{ title: 'Child', page: 1 }] }, { title: 'End', page: 2 }]); ok('outline');
b = await ops.setMeta(b, { title: 'T', author: 'Levi', keywords: 'a, b' }); assert.equal((await ops.getMeta(b)).title, 'T'); ok('meta');
b = await ops.attachFile(b, { name: 'x.txt', bytes: new TextEncoder().encode('hi'), type: 'text/plain' }); ok('attach');
b = await ops.cropPages(b, [1], { top: 10, right: 10, bottom: 10, left: 10 }); ok('crop');
const flat = await ops.flattenAnnotations(b); ok('flattenAnnotations');
const ff = await ops.flattenForms(b); ok('flattenForms');
const opt = await ops.optimize(b); ok('optimize ' + b.length + ' -> ' + opt.length);
const san = await ops.sanitize(b); ok('sanitize');
const parts = await ops.splitDocument(b, ops.rangesEveryN(3, 2)); assert.equal(parts.length, 2); ok('split');
assert.deepEqual(ops.parsePageList('1-2, 3, 5-', 6), [0,1,2,4,5]); ok('parsePageList');
const enc = await ops.encrypt(b, { userPassword: 'u', ownerPassword: 'o', printing: 'highResolution', modifying: false, copying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false });
assert.ok(ops.isEncrypted(enc)); assert.ok(!ops.isEncrypted(b)); ok('encrypt');
try { const dec = await ops.decrypt(enc, 'u'); assert.ok(!ops.isEncrypted(dec)); ok('decrypt'); } catch (e) { console.log('FAIL decrypt', (e as Error).message); }
const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/ops.pdf', b); writeFileSync('tests/out/flat.pdf', flat); writeFileSync('tests/out/enc.pdf', enc);
console.log('done');
{
  let fd = await ops.getFormData(b); assert.equal(fd.fullName, '');
  b = await ops.setFormData(b, { fullName: 'Levi', agree: true, pick: ['B'], grp: 'no' });
  fd = await ops.getFormData(b); assert.equal(fd.fullName, 'Levi'); assert.equal(fd.agree, true); assert.equal(fd.grp, 'no'); ok('form data');
  b = await ops.clearForm(b); fd = await ops.getFormData(b); assert.equal(fd.fullName, ''); assert.equal(fd.agree, false); ok('clear form');
}
