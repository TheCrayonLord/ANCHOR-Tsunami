import * as ops from '../src/lib/ops';
import { createDigitalId, readDigitalId, signPdf, verifySignatures } from '../src/lib/signing';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert';
ops.setFontLoader(async (f) => new Uint8Array(await readFile(`public/fonts/${f}`)));

const p12 = await createDigitalId({ name: 'Test Signer', email: 'signer@example.com', organization: 'ANCHOR QA', years: 3, password: 'secret' });
assert.throws(() => readDigitalId(p12, 'wrong'));
const id = readDigitalId(p12, 'secret');
assert.equal(id.name, 'Test Signer');
console.log('ok - create and read digital ID');

const base = await readFile('tests/out/sample.pdf').then((b) => new Uint8Array(b)).catch(() => ops.blankDocument(2));
const signed = await signPdf(base, id, { page: 0, rect: { x: 340, y: 60, w: 220, h: 60 }, reason: 'I approve this document', location: 'Berlin' });
writeFileSync('tests/out/signed.pdf', signed);
let v = verifySignatures(signed);
assert.equal(v.length, 1);
assert.equal(v[0].integrity, 'valid', JSON.stringify(v[0]));
assert.equal(v[0].coversWholeFile, true);
assert.equal(v[0].signer, 'Test Signer');
assert.equal(v[0].reason, 'I approve this document');
assert.ok(v[0].selfSigned);
console.log('ok - sign and verify');

// Second signature keeps the first one valid; the first now no longer covers the whole file.
const twice = await signPdf(signed, id, { page: 0, rect: { x: 40, y: 60, w: 220, h: 60 }, reason: 'Second' });
writeFileSync('tests/out/signed2.pdf', twice);
v = verifySignatures(twice);
assert.equal(v.length, 2);
assert.ok(v.every((s) => s.integrity === 'valid'), JSON.stringify(v));
assert.equal(v[0].coversWholeFile, false);
assert.equal(v[1].coversWholeFile, true);
console.log('ok - second signature, first still valid');

// Tampering inside the signed range breaks it.
const bad = twice.slice();
const at = 400;
bad[at] = bad[at] === 0x41 ? 0x42 : 0x41;
v = verifySignatures(bad);
assert.ok(v.some((s) => s.integrity === 'modified'));
console.log('ok - tampering detected');

// Loadable by pdf-lib and pdf.js-style structure check
const reloaded = await ops.load(twice);
assert.equal(reloaded.getPageCount(), (await ops.load(base)).getPageCount());
console.log('ok - signed file reloads');
