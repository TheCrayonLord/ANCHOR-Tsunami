/**
 * Certificate-based digital signatures (PAdES baseline: adbe.pkcs7.detached, SHA-256).
 *
 * Signing appends an incremental update, so earlier signatures in the file stay valid. A signature
 * field with an optional visible appearance is added, the byte range is fixed up after saving, and a
 * detached CMS/PKCS#7 signature made with the certificate's private key is written into /Contents.
 */
import forge from 'node-forge';
import { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, PDFDict, PDFRef, rgb } from '@cantoo/pdf-lib';
import { Typesetter } from './typeset';
import type { Rect } from './types';

const SIG_LENGTH = 16384; // bytes reserved for the CMS signature (hex doubles it)
const BR_PLACEHOLDER = 9999999999;

export interface DigitalId {
  name: string;
  email?: string;
  organization?: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  key: forge.pki.PrivateKey;
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
}

const attr = (c: forge.pki.Certificate['subject'], short: string) => (c.getField(short)?.value as string | undefined) ?? undefined;

/** Read a .p12 / .pfx digital ID. */
export function readDigitalId(p12: Uint8Array, password: string): DigitalId {
  const der = forge.util.binary.raw.encode(p12);
  const asn = forge.asn1.fromDer(der);
  const pkcs12 = forge.pkcs12.pkcs12FromAsn1(asn, false, password);
  const keyBags = [
    ...(pkcs12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(pkcs12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = pkcs12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBags[0]?.key;
  if (!key) throw new Error('This file has no private key, so it cannot be used for signing.');
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  // The signing certificate is the one whose public key matches the private key.
  const pub = forge.pki.setRsaPublicKey((key as forge.pki.rsa.PrivateKey).n, (key as forge.pki.rsa.PrivateKey).e);
  const cert = certs.find((c) => forge.pki.publicKeyToPem(c.publicKey) === forge.pki.publicKeyToPem(pub)) ?? certs[0];
  if (!cert) throw new Error('This file has no certificate.');
  return {
    name: attr(cert.subject, 'CN') ?? 'Unknown signer',
    email: attr(cert.subject, 'E') ?? (cert.subject.getField({ name: 'emailAddress' })?.value as string | undefined),
    organization: attr(cert.subject, 'O'),
    issuer: attr(cert.issuer, 'CN') ?? attr(cert.issuer, 'O') ?? 'Unknown issuer',
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    key,
    cert,
    chain: certs.filter((c) => c !== cert),
  };
}

/** Create a self-signed digital ID and return it as a password-protected .p12 file. */
export async function createDigitalId(o: { name: string; email?: string; organization?: string; years: number; password: string }) {
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) =>
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 }, (err, kp) => (err ? reject(err) : resolve(kp))),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + o.years);
  const subject: forge.pki.CertificateField[] = [{ shortName: 'CN', value: o.name }];
  if (o.organization) subject.push({ shortName: 'O', value: o.organization });
  if (o.email) subject.push({ name: 'emailAddress', value: o.email });
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true, codeSigning: false },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], o.password, { algorithm: '3des', friendlyName: o.name });
  const der = forge.asn1.toDer(p12).getBytes();
  return forge.util.binary.raw.decode(der);
}

export interface SignOptions {
  page: number;
  rect?: Rect; // omit for an invisible signature
  reason?: string;
  location?: string;
  contact?: string;
  imageDataUrl?: string; // optional handwritten signature shown in the appearance
  date?: Date;
}

function pdfDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Sign the document. Returns the original bytes plus an incremental update holding the signature. */
export async function signPdf(bytes: Uint8Array, id: DigitalId, o: SignOptions): Promise<Uint8Array> {
  const date = o.date ?? new Date();
  const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true, ignoreEncryption: true } as never);
  const snap = doc.takeSnapshot();
  const ctx = doc.context;
  const page = doc.getPage(o.page);
  const rect = o.rect ?? { x: 0, y: 0, w: 0, h: 0 };

  // Signature value dictionary with placeholders.
  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, BR_PLACEHOLDER, BR_PLACEHOLDER, BR_PLACEHOLDER],
    M: PDFString.of(pdfDate(date)),
    Prop_Build: { App: { Name: 'ANCHOR_Tsunami' } },
  }) as PDFDict;
  sigDict.set(PDFName.of('Contents'), PDFHexString.of('0'.repeat(SIG_LENGTH * 2)));
  sigDict.set(PDFName.of('Name'), PDFHexString.fromText(id.name));
  if (o.reason) sigDict.set(PDFName.of('Reason'), PDFHexString.fromText(o.reason));
  if (o.location) sigDict.set(PDFName.of('Location'), PDFHexString.fromText(o.location));
  if (o.contact) sigDict.set(PDFName.of('ContactInfo'), PDFHexString.fromText(o.contact));
  const sigRef = ctx.register(sigDict);

  // Visible appearance: optional handwritten image on the left, signer details on the right.
  let apRef: PDFRef | undefined;
  if (o.rect && rect.w > 0 && rect.h > 0) {
    const lines = [`Digitally signed by ${id.name}`, `Date: ${date.toLocaleString()}`, ...(o.reason ? [`Reason: ${o.reason}`] : []), ...(o.location ? [`Location: ${o.location}`] : [])];
    const tmp = await PDFDocument.create();
    tmp.registerFontkit((await import('@cantoo/fontkit')).default);
    // Draw the appearance on a scratch page, then embed that page as a form XObject.
    const sp = tmp.addPage([rect.w, rect.h]);
    const tts = new Typesetter(tmp);
    sp.drawRectangle({ x: 0.5, y: 0.5, width: rect.w - 1, height: rect.h - 1, borderColor: rgb(0.05, 0.55, 0.6), borderWidth: 1, color: rgb(0.95, 0.99, 0.99) });
    let textX = 4;
    if (o.imageDataUrl) {
      const b = Uint8Array.from(atob(o.imageDataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const img = o.imageDataUrl.includes('image/png') ? await tmp.embedPng(b) : await tmp.embedJpg(b);
      const ih = rect.h - 8;
      const iw = Math.min(rect.w * 0.45, (img.width / img.height) * ih);
      sp.drawImage(img, { x: 4, y: (rect.h - (iw / img.width) * img.height) / 2, width: iw, height: (iw / img.width) * img.height });
      textX = iw + 10;
    }
    let size = Math.min(10, (rect.h - 6) / (lines.length * 1.25));
    for (const l of lines) size = Math.min(size, ((rect.w - textX - 4) / Math.max(1, await tts.width(l, 1))) * 0.98);
    let y = rect.h - 4 - size;
    for (const l of lines) {
      await tts.drawLine(sp, l, { x: textX, y, size, color: rgb(0.1, 0.15, 0.3) });
      y -= size * 1.25;
    }
    const tmpBytes = await tmp.save();
    const [emb] = await doc.embedPdf(tmpBytes, [0]);
    const xName = 'Sig0';
    const ap = ctx.stream(`q 1 0 0 1 0 0 cm /${xName} Do Q`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rect.w, rect.h], Resources: { XObject: { [xName]: emb.ref } } } as never);
    apRef = ctx.register(ap);
  }

  // Signature field (merged with its widget).
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) ?? (() => {
    const d = ctx.obj({ Fields: [] }) as PDFDict;
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(d));
    return d;
  })();
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = ctx.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
  }
  const n = fields.size() + 1;
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
    V: sigRef,
    T: PDFString.of(`Signature${n}`),
    F: 132, // print + locked
    P: page.ref,
    ...(apRef ? { AP: { N: apRef } } : {}),
  }) as PDFDict;
  const widgetRef = ctx.register(widget);
  fields.push(widgetRef);
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widgetRef);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  // Mark the existing objects we changed so the incremental update rewrites them.
  snap.markRefForSave(page.ref);
  const acroRef = doc.catalog.get(PDFName.of('AcroForm'));
  if (acroRef instanceof PDFRef) snap.markRefForSave(acroRef);
  snap.markRefForSave(ctx.trailerInfo.Root as PDFRef);
  const annotsRef = page.node.get(PDFName.of('Annots'));
  if (annotsRef instanceof PDFRef) snap.markRefForSave(annotsRef);
  const fieldsRef = acro.get(PDFName.of('Fields'));
  if (fieldsRef instanceof PDFRef) snap.markRefForSave(fieldsRef);

  const inc = await doc.saveIncremental(snap, { useObjectStreams: false } as never);
  const full = concat(bytes, inc);
  return fillSignature(full, id);
}

function concat(a: Uint8Array, b: Uint8Array) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode(...b.subarray(i, i + 65536));
  return s;
};

/** Compute the byte range of the last placeholder, sign it, and write the CMS signature in. */
function fillSignature(pdf: Uint8Array, id: DigitalId) {
  const text = latin1(pdf);
  const brText = `/ByteRange [ 0 ${BR_PLACEHOLDER} ${BR_PLACEHOLDER} ${BR_PLACEHOLDER} ]`;
  const brAt = text.lastIndexOf(brText);
  if (brAt < 0) throw new Error('Signature placeholder not found.');
  const contentsMarker = `<${'0'.repeat(SIG_LENGTH * 2)}>`;
  const cStart = text.indexOf(contentsMarker, brAt - SIG_LENGTH * 2 - 2000 > 0 ? brAt - SIG_LENGTH * 2 - 2000 : 0);
  if (cStart < 0) throw new Error('Signature contents placeholder not found.');
  const cEnd = cStart + contentsMarker.length;
  const range = [0, cStart, cEnd, pdf.length - cEnd];
  let brNew = `/ByteRange [ ${range.join(' ')} ]`;
  brNew += ' '.repeat(brText.length - brNew.length);
  const out = pdf.slice();
  for (let i = 0; i < brNew.length; i++) out[brAt + i] = brNew.charCodeAt(i);

  const signed = latin1(out.subarray(0, cStart)) + latin1(out.subarray(cEnd));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(signed);
  p7.addCertificate(id.cert);
  id.chain.forEach((c) => p7.addCertificate(c));
  p7.addSigner({
    key: id.key as forge.pki.rsa.PrivateKey,
    certificate: id.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest } as never,
      { type: forge.pki.oids.signingTime, value: new Date() as never },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = forge.util.bytesToHex(der);
  if (hex.length > SIG_LENGTH * 2) throw new Error('Signature is larger than the space reserved for it.');
  const padded = hex + '0'.repeat(SIG_LENGTH * 2 - hex.length);
  for (let i = 0; i < padded.length; i++) out[cStart + 1 + i] = padded.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export interface SignatureInfo {
  field: string;
  signer: string;
  issuer: string;
  email?: string;
  signedAt?: Date;
  reason?: string;
  location?: string;
  integrity: 'valid' | 'modified' | 'invalid' | 'unknown';
  coversWholeFile: boolean; // false when the document was changed after this signature
  selfSigned: boolean;
  certValidNow: boolean;
  note?: string;
}

/** Find and check every signature in a PDF. */
export function verifySignatures(pdf: Uint8Array): SignatureInfo[] {
  const text = latin1(pdf);
  const out: SignatureInfo[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    k++;
    const [a, b, c, d] = m.slice(1).map(Number);
    if (b === BR_PLACEHOLDER) continue;
    const info: SignatureInfo = { field: `Signature ${k}`, signer: 'Unknown', issuer: 'Unknown', integrity: 'unknown', coversWholeFile: c + d === pdf.length, selfSigned: false, certValidNow: false };
    // Pull the surrounding dictionary text for the optional entries.
    const dictStart = text.lastIndexOf('<<', m.index);
    const dictText = text.slice(dictStart, b) + text.slice(c, Math.min(text.length, c + 1500)).split('endobj')[0];
    const readStr = (key: string) => {
      const mm = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f]*>)`).exec(dictText);
      if (!mm) return undefined;
      const v = mm[1];
      if (v.startsWith('(')) return v.slice(1, -1).replace(/\\(.)/g, '$1');
      const hex = v.slice(1, -1);
      const bytes = forge.util.hexToBytes(hex);
      if (bytes.startsWith('\xfe\xff')) {
        let s = '';
        for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
        return s;
      }
      return bytes;
    };
    info.reason = readStr('Reason');
    info.location = readStr('Location');
    try {
      const contentsHex = text.slice(b + 1, c - 1).replace(/0+$/, '');
      const der = forge.util.hexToBytes(contentsHex.length % 2 ? contentsHex + '0' : contentsHex);
      const asn = forge.asn1.fromDer(der, { strict: false } as never);
      const msg = forge.pkcs7.messageFromAsn1(asn) as forge.pkcs7.PkcsSignedData & { rawCapture: Record<string, unknown> };
      const cert = msg.certificates[0];
      if (cert) {
        info.signer = attr(cert.subject, 'CN') ?? 'Unknown';
        info.issuer = attr(cert.issuer, 'CN') ?? attr(cert.issuer, 'O') ?? 'Unknown';
        info.email = cert.subject.getField({ name: 'emailAddress' })?.value as string | undefined;
        info.selfSigned = cert.subject.hash === cert.issuer.hash;
        const now = new Date();
        info.certValidNow = now >= cert.validity.notBefore && now <= cert.validity.notAfter;
      }
      const raw = msg.rawCapture as { authenticatedAttributes?: forge.asn1.Asn1[]; signature?: string; digestAlgorithm?: string };
      const attrs = raw.authenticatedAttributes ?? [];
      let digestAttr: string | undefined;
      for (const at of attrs) {
        const seq = at.value as forge.asn1.Asn1[];
        const oid = forge.asn1.derToOid(seq[0].value as string);
        const val = (seq[1].value as forge.asn1.Asn1[])[0];
        if (oid === forge.pki.oids.messageDigest) digestAttr = val.value as string;
        if (oid === forge.pki.oids.signingTime) {
          try {
            info.signedAt = val.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(val.value as string) : forge.asn1.generalizedTimeToDate(val.value as string);
          } catch {
            /* unreadable time */
          }
        }
      }
      const algOid = raw.digestAlgorithm ? forge.asn1.derToOid(raw.digestAlgorithm) : forge.pki.oids.sha256;
      const mdFor = () =>
        algOid === forge.pki.oids.sha1 ? forge.md.sha1.create() : algOid === forge.pki.oids.sha384 ? forge.md.sha384.create() : algOid === forge.pki.oids.sha512 ? forge.md.sha512.create() : forge.md.sha256.create();
      const content = latin1(pdf.subarray(a, a + b)) + latin1(pdf.subarray(c, c + d));
      const md = mdFor();
      md.update(content);
      const digest = md.digest().getBytes();
      if (!digestAttr) {
        info.integrity = 'unknown';
        info.note = 'The signature format is not one ANCHOR Tsunami can check.';
      } else if (digestAttr !== digest) {
        info.integrity = 'modified';
      } else if (cert && raw.signature) {
        const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
        const amd = mdFor();
        amd.update(forge.asn1.toDer(set).getBytes());
        try {
          info.integrity = (cert.publicKey as forge.pki.rsa.PublicKey).verify(amd.digest().getBytes(), raw.signature) ? 'valid' : 'invalid';
        } catch {
          info.integrity = 'unknown';
          info.note = 'The signature uses a key type ANCHOR Tsunami cannot check (for example ECDSA).';
        }
      }
    } catch (e) {
      info.integrity = 'unknown';
      info.note = `Could not read the signature: ${(e as Error).message}`;
    }
    out.push(info);
  }
  return out;
}
