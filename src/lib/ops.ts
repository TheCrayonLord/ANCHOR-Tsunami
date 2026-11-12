/**
 * Document operations for ANCHOR Tsunami, built on pdf-lib (the @cantoo fork, which adds encryption).
 * Every operation takes the current PDF bytes and returns new bytes, so the app can keep a simple
 * version history for undo/redo. Nothing in this file touches the DOM, so it also runs under Node.
 */
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFRef,
  PDFPage,
  PDFFont,
  StandardFonts,
  rgb,
  degrees,
  PageSizes,
  TextAlignment,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from '@cantoo/pdf-lib';
import type { DocMeta, OverlayItem, Rect } from './types';

export type Bytes = Uint8Array;

const LOAD = { ignoreEncryption: true, updateMetadata: false } as const;

export async function load(bytes: Bytes, password?: string) {
  // @cantoo/pdf-lib accepts a password to decrypt protected files.
  return PDFDocument.load(bytes, password ? ({ ...LOAD, password } as never) : LOAD);
}

async function save(doc: PDFDocument, opts: { objectStreams?: boolean } = {}) {
  return doc.save({ useObjectStreams: opts.objectStreams ?? true });
}

export function hexToRgb(hex = '#000000') {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const color = (hex?: string) => {
  const { r, g, b } = hexToRgb(hex);
  return rgb(r, g, b);
};
const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

function pdfText(s: string) {
  // Use a hex string with BOM for anything outside Latin-1 so Unicode survives.
  return /^[\x20-\x7e]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s);
}

function standardFont(item: Pick<OverlayItem, 'font' | 'bold' | 'italic'>): StandardFonts {
  const f = item.font ?? 'Helvetica';
  const b = !!item.bold;
  const i = !!item.italic;
  if (f === 'Times') return b && i ? StandardFonts.TimesRomanBoldItalic : b ? StandardFonts.TimesRomanBold : i ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (f === 'Courier') return b && i ? StandardFonts.CourierBoldOblique : b ? StandardFonts.CourierBold : i ? StandardFonts.CourierOblique : StandardFonts.Courier;
  return b && i ? StandardFonts.HelveticaBoldOblique : b ? StandardFonts.HelveticaBold : i ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

/** Standard 14 fonts only cover WinAnsi; replace anything else so drawing never throws. */
function winAnsiSafe(font: PDFFont, s: string) {
  let out = '';
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

export async function pageCount(bytes: Bytes) {
  return (await load(bytes)).getPageCount();
}

/** Reorder pages. `order` lists old indices in their new order; indices left out are deleted. */
export async function reorderPages(bytes: Bytes, order: number[]) {
  const doc = await load(bytes);
  const pages = doc.getPages();
  const ctx = doc.context;
  const refs: PDFRef[] = [];
  const used = new Set<number>();
  for (const idx of order) {
    if (used.has(idx)) {
      const [copy] = await doc.copyPages(doc, [idx]);
      refs.push(copy.ref);
    } else {
      used.add(idx);
      refs.push(pages[idx].ref);
    }
  }
  // Rebuild a flat page tree. Inheritable attributes are pushed down to each page first so that
  // nothing is lost when intermediate page-tree nodes go away.
  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  const root = doc.catalog.Pages();
  for (const ref of refs) {
    const leaf = ctx.lookup(ref) as PDFDict & { getInheritableAttribute(n: PDFName): unknown };
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const k = PDFName.of(key);
      if (!leaf.has(k)) {
        const v = leaf.getInheritableAttribute(k);
        if (v !== undefined) leaf.set(k, v as never);
      }
    }
    leaf.set(PDFName.of('Parent'), rootRef);
  }
  root.set(PDFName.of('Kids'), ctx.obj(refs));
  root.set(PDFName.of('Count'), ctx.obj(refs.length));
  return save(doc);
}

export async function deletePages(bytes: Bytes, indices: number[]) {
  const n = await pageCount(bytes);
  const del = new Set(indices);
  if (del.size >= n) throw new Error('A document needs at least one page.');
  return reorderPages(bytes, [...Array(n).keys()].filter((i) => !del.has(i)));
}

export async function duplicatePages(bytes: Bytes, indices: number[]) {
  const n = await pageCount(bytes);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push(i);
    if (indices.includes(i)) order.push(i);
  }
  return reorderPages(bytes, order);
}

export async function rotatePages(bytes: Bytes, indices: number[], delta: number) {
  const doc = await load(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  }
  return save(doc);
}

export async function insertBlankPage(bytes: Bytes, at: number, size?: [number, number]) {
  const doc = await load(bytes);
  const ref = doc.getPageCount() ? doc.getPage(Math.min(Math.max(at - 1, 0), doc.getPageCount() - 1)) : null;
  doc.insertPage(at, size ?? (ref ? [ref.getWidth(), ref.getHeight()] : PageSizes.Letter));
  return save(doc);
}

/** Insert all pages of another PDF at position `at`. */
export async function insertDocument(bytes: Bytes, other: Bytes, at: number) {
  const doc = await load(bytes);
  const src = await load(other);
  const copied = await doc.copyPages(src, src.getPageIndices());
  copied.forEach((p, k) => doc.insertPage(at + k, p));
  return save(doc);
}

/** Replace pages [from..from+count) with the pages of another PDF. */
export async function replacePages(bytes: Bytes, other: Bytes, from: number) {
  const src = await load(other);
  const doc = await load(bytes);
  const count = Math.min(src.getPageCount(), doc.getPageCount() - from);
  const copied = await doc.copyPages(src, [...Array(count).keys()]);
  for (let k = 0; k < count; k++) {
    doc.removePage(from + k);
    doc.insertPage(from + k, copied[k]);
  }
  return save(doc);
}

/** Copy the given pages into a brand-new document. */
export async function extractPages(bytes: Bytes, indices: number[]) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return save(out);
}

/** Split into several documents. `ranges` are lists of 0-based page indices. */
export async function splitDocument(bytes: Bytes, ranges: number[][]) {
  const out: Bytes[] = [];
  for (const r of ranges) out.push(await extractPages(bytes, r));
  return out;
}

export function rangesEveryN(total: number, n: number) {
  const r: number[][] = [];
  for (let i = 0; i < total; i += n) r.push([...Array(Math.min(n, total - i)).keys()].map((k) => k + i));
  return r;
}

/** Parse "1-3, 5, 8-" style page ranges into 0-based indices. */
export function parsePageList(spec: string, total: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const i = parseInt(part, 10);
      if (i >= 1 && i <= total) out.push(i - 1);
    }
  }
  return out;
}

/** Combine several PDFs (and images) into one document, in order. */
export async function combine(files: { bytes: Bytes; type: string }[]) {
  const out = await PDFDocument.create();
  for (const f of files) {
    if (f.type === 'application/pdf') {
      const src = await load(f.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else {
      await addImagePage(out, f.bytes, f.type);
    }
  }
  return save(out);
}

async function addImagePage(doc: PDFDocument, data: Bytes, type: string, fit?: [number, number]) {
  const img = type.includes('png') ? await doc.embedPng(data) : await doc.embedJpg(data);
  if (fit) {
    const [W, H] = fit;
    const page = doc.addPage([W, H]);
    const s = Math.min((W - 72) / img.width, (H - 72) / img.height, 1);
    page.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
  } else {
    // Images map 1px -> 0.75pt (96 dpi), the way a browser prints them.
    const w = img.width * 0.75;
    const h = img.height * 0.75;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
}

export async function imagesToPdf(images: { bytes: Bytes; type: string }[], pageSize?: [number, number]) {
  const doc = await PDFDocument.create();
  for (const im of images) await addImagePage(doc, im.bytes, im.type, pageSize);
  return save(doc);
}

export async function blankDocument(pages = 1, size: [number, number] = PageSizes.Letter as [number, number]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return save(doc);
}

/** Plain text to PDF with simple word wrap. */
export async function textToPdf(text: string, opts: { fontSize?: number; size?: [number, number] } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fs = opts.fontSize ?? 11;
  const [W, H] = opts.size ?? (PageSizes.Letter as [number, number]);
  const margin = 72;
  const lh = fs * 1.35;
  let page = doc.addPage([W, H]);
  let y = H - margin;
  for (const para of text.replace(/\r/g, '').split('\n')) {
    const lines = wrap(font, winAnsiSafe(font, para), fs, W - margin * 2);
    for (const line of lines.length ? lines : ['']) {
      if (y < margin) {
        page = doc.addPage([W, H]);
        y = H - margin;
      }
      page.drawText(line, { x: margin, y: y - fs, size: fs, font });
      y -= lh;
    }
  }
  return save(doc);
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number) {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/(\s+)/)) {
    const next = line + word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line.trim()) {
      out.push(line.trimEnd());
      line = word.trimStart();
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** Crop pages by margins (pt) measured from the current crop box. */
export async function cropPages(bytes: Bytes, indices: number[], m: { top: number; right: number; bottom: number; left: number }) {
  const doc = await load(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    const c = p.getCropBox();
    p.setCropBox(c.x + m.left, c.y + m.bottom, Math.max(1, c.width - m.left - m.right), Math.max(1, c.height - m.top - m.bottom));
  }
  return save(doc);
}

export async function resizePages(bytes: Bytes, indices: number[], size: [number, number]) {
  const doc = await load(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    const { width, height } = p.getSize();
    const s = Math.min(size[0] / width, size[1] / height);
    p.scaleContent(s, s);
    p.scaleAnnotations(s, s);
    p.setSize(size[0], size[1]);
    p.translateContent((size[0] - width * s) / 2, (size[1] - height * s) / 2);
  }
  return save(doc);
}

// ---------------------------------------------------------------------------------------------
// Pending edits: annotations, page content, links and form fields
// ---------------------------------------------------------------------------------------------

function ellipsePath(x: number, y: number, w: number, h: number) {
  const k = 0.5522847498;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  return [
    `${num(cx + rx)} ${num(cy)} m`,
    `${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`,
    `${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`,
  ].join('\n');
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = (d: number) => [x2 - size * Math.cos(a + d), y2 - size * Math.sin(a + d)];
  const [ax, ay] = p(Math.PI / 7);
  const [bx, by] = p(-Math.PI / 7);
  return `${num(ax)} ${num(ay)} m ${num(x2)} ${num(y2)} l ${num(bx)} ${num(by)} l`;
}

const rgbOps = (hex: string | undefined, op: 'RG' | 'rg') => {
  const { r, g, b } = hexToRgb(hex);
  return `${num(r)} ${num(g)} ${num(b)} ${op}`;
};
const rgbArr = (hex?: string) => {
  const { r, g, b } = hexToRgb(hex);
  return [r, g, b];
};

interface AnnotSpec {
  subtype: string;
  rect: [number, number, number, number];
  ops: string;
  extra?: Record<string, unknown>;
  opacity?: number;
  fonts?: Record<string, PDFRef>;
  item: OverlayItem;
}

function addAnnotation(doc: PDFDocument, page: PDFPage, spec: AnnotSpec) {
  const ctx = doc.context;
  const resources: Record<string, unknown> = {};
  let ops = spec.ops;
  if (spec.opacity !== undefined && spec.opacity < 1) {
    resources.ExtGState = { G0: { Type: 'ExtGState', CA: spec.opacity, ca: spec.opacity } };
    ops = `/G0 gs\n${ops}`;
  }
  if (spec.fonts) resources.Font = spec.fonts;
  const ap = ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: spec.rect, Resources: resources as never });
  const apRef = ctx.register(ap);
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: spec.subtype,
    Rect: spec.rect,
    F: 4,
    AP: { N: apRef },
    ...(spec.extra ?? {}),
  }) as PDFDict;
  const now = pdfDate(new Date());
  dict.set(PDFName.of('M'), PDFString.of(now));
  dict.set(PDFName.of('CreationDate'), PDFString.of(now));
  dict.set(PDFName.of('NM'), PDFString.of(spec.item.id));
  if (spec.item.text) dict.set(PDFName.of('Contents'), pdfText(spec.item.text));
  dict.set(PDFName.of('T'), pdfText(spec.item.author || 'ANCHOR Tsunami'));
  if (spec.opacity !== undefined) dict.set(PDFName.of('CA'), ctx.obj(spec.opacity));
  const ref = ctx.register(dict);
  page.node.addAnnot(ref);
  return ref;
}

export function pdfDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const rectArr = (r: Rect, pad = 0): [number, number, number, number] => [r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad];

function dataUrlBytes(dataUrl: string): { bytes: Bytes; type: string } {
  const [head, b64] = dataUrl.split(',');
  const type = head.match(/data:([^;]+)/)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type };
}

/** Write pending overlay items into the document. Redaction marks are skipped (see applyRedactions). */
export async function applyItems(bytes: Bytes, items: OverlayItem[]) {
  const doc = await load(bytes);
  const fontCache = new Map<string, PDFFont>();
  const getFont = async (name: StandardFonts) => {
    if (!fontCache.has(name)) fontCache.set(name, await doc.embedFont(name));
    return fontCache.get(name)!;
  };
  let form: ReturnType<PDFDocument['getForm']> | null = null;
  const fieldNames = new Set<string>();

  for (const it of items) {
    if (it.page >= doc.getPageCount()) continue;
    const page = doc.getPage(it.page);
    const r = it.rect;
    const w = it.width ?? 2;
    const op = it.opacity ?? 1;
    switch (it.kind) {
      case 'rect':
      case 'ellipse': {
        const inner = { x: r.x + w / 2, y: r.y + w / 2, w: Math.max(0, r.w - w), h: Math.max(0, r.h - w) };
        const path = it.kind === 'rect' ? `${num(inner.x)} ${num(inner.y)} ${num(inner.w)} ${num(inner.h)} re` : ellipsePath(inner.x, inner.y, inner.w, inner.h);
        const paint = it.fill ? (w > 0 ? 'B' : 'f') : 'S';
        addAnnotation(doc, page, {
          subtype: it.kind === 'rect' ? 'Square' : 'Circle',
          rect: rectArr(r),
          ops: `${rgbOps(it.color, 'RG')}\n${it.fill ? rgbOps(it.fill, 'rg') + '\n' : ''}${num(w)} w\n${path}\n${paint}`,
          opacity: op,
          item: it,
          extra: { C: rgbArr(it.color), BS: { W: w, S: 'S' }, ...(it.fill ? { IC: rgbArr(it.fill) } : {}) },
        });
        break;
      }
      case 'line':
      case 'arrow':
      case 'measure': {
        const [[x1, y1], [x2, y2]] = it.pts ?? [
          [r.x, r.y],
          [r.x + r.w, r.y + r.h],
        ];
        const pad = w * 4 + 6;
        const rect: [number, number, number, number] = [Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.max(x1, x2) + pad, Math.max(y1, y2) + pad];
        let ops = `${rgbOps(it.color, 'RG')}\n${num(w)} w 1 J 1 j\n${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`;
        if (it.kind === 'arrow') ops += `\n${arrowHead(x1, y1, x2, y2, 6 + w * 3)} S`;
        const fonts: Record<string, PDFRef> = {};
        if (it.kind === 'measure') {
          ops += `\n${arrowHead(x1, y1, x2, y2, 5 + w * 2)} S\n${arrowHead(x2, y2, x1, y1, 5 + w * 2)} S`;
          const f = await getFont(StandardFonts.Helvetica);
          fonts.F1 = f.ref;
          const label = it.text ?? '';
          const tw = f.widthOfTextAtSize(label, 9);
          const mx = (x1 + x2) / 2 - tw / 2;
          const my = (y1 + y2) / 2 + 4;
          ops += `\nBT ${rgbOps(it.color, 'rg')} /F1 9 Tf ${num(mx)} ${num(my)} Td ${f.encodeText(label).toString()} Tj ET`;
          rect[3] += 14;
        }
        addAnnotation(doc, page, {
          subtype: 'Line',
          rect,
          ops,
          opacity: op,
          fonts,
          item: it,
          extra: {
            L: [x1, y1, x2, y2],
            C: rgbArr(it.color),
            BS: { W: w },
            LE: it.kind === 'arrow' ? ['None', 'OpenArrow'] : it.kind === 'measure' ? ['OpenArrow', 'OpenArrow'] : ['None', 'None'],
            ...(it.kind === 'measure' ? { IT: 'LineDimension', Cap: true } : {}),
          },
        });
        break;
      }
      case 'note': {
        const s = 20;
        const x = r.x;
        const y = r.y + r.h - s;
        const ops = [
          rgbOps(it.color ?? '#ffd84a', 'rg'),
          '0.25 0.25 0.25 RG 0.8 w',
          `${num(x + 1)} ${num(y + 4)} ${num(s - 2)} ${num(s - 5)} re B`,
          `${num(x + 5)} ${num(y + 4)} m ${num(x + 4)} ${num(y)} l ${num(x + 9)} ${num(y + 4)} l f`,
          '0.25 0.25 0.25 RG 0.9 w',
          `${num(x + 4)} ${num(y + 14)} m ${num(x + s - 4)} ${num(y + 14)} l S`,
          `${num(x + 4)} ${num(y + 11)} m ${num(x + s - 4)} ${num(y + 11)} l S`,
          `${num(x + 4)} ${num(y + 8)} m ${num(x + s - 8)} ${num(y + 8)} l S`,
        ].join('\n');
        const ref = addAnnotation(doc, page, {
          subtype: 'Text',
          rect: [x, y, x + s, y + s],
          ops,
          item: it,
          extra: { Name: 'Comment', Open: false, C: rgbArr(it.color ?? '#ffd84a') },
        });
        // A popup lets other viewers show the note's text.
        const popup = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [x + s, y - 100, x + s + 200, y + s], Parent: ref, Open: false }));
        (doc.context.lookup(ref) as PDFDict).set(PDFName.of('Popup'), popup);
        page.node.addAnnot(popup);
        break;
      }
      case 'stamp': {
        const f = await getFont(StandardFonts.HelveticaBold);
        const label = winAnsiSafe(f, (it.text ?? 'APPROVED').toUpperCase());
        const size = Math.min(r.h * 0.5, (r.w - 16) / Math.max(1, f.widthOfTextAtSize(label, 1)));
        const tw = f.widthOfTextAtSize(label, size);
        const c = it.color ?? '#c0392b';
        const ops = [
          `${rgbOps(c, 'RG')} ${rgbOps(c, 'rg')} 2.5 w`,
          `${num(r.x + 2)} ${num(r.y + 2)} ${num(r.w - 4)} ${num(r.h - 4)} re S`,
          `0.8 w ${num(r.x + 5)} ${num(r.y + 5)} ${num(r.w - 10)} ${num(r.h - 10)} re S`,
          `BT /F1 ${num(size)} Tf ${num(r.x + (r.w - tw) / 2)} ${num(r.y + (r.h - size * 0.7) / 2)} Td ${f.encodeText(label).toString()} Tj ET`,
        ].join('\n');
        addAnnotation(doc, page, { subtype: 'Stamp', rect: rectArr(r), ops, opacity: it.opacity ?? 0.85, fonts: { F1: f.ref }, item: it, extra: { Name: 'Approved' } });
        break;
      }
      case 'whiteout':
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: color(it.fill ?? '#ffffff') });
        break;
      case 'text': {
        if (!it.text?.trim() && !it.cover) break;
        if (it.cover) page.drawRectangle({ x: it.cover.x, y: it.cover.y, width: it.cover.w, height: it.cover.h, color: color(it.fill ?? '#ffffff') });
        const f = await getFont(standardFont(it));
        const size = it.fontSize ?? 12;
        const lh = size * 1.2;
        let y = r.y + r.h - size;
        for (const raw of (it.text ?? '').split('\n')) {
          for (const line of (it.nowrap ? [winAnsiSafe(f, raw)] : wrap(f, winAnsiSafe(f, raw), size, Math.max(r.w, size))).concat(raw || it.nowrap ? [] : [''])) {
            const tw = f.widthOfTextAtSize(line, size);
            const x = it.align === 'center' ? r.x + (r.w - tw) / 2 : it.align === 'right' ? r.x + r.w - tw : r.x;
            page.drawText(line, { x, y: y + size * 0.22, size, font: f, color: color(it.color), opacity: op });
            y -= lh;
          }
        }
        break;
      }
      case 'image': {
        if (!it.dataUrl) break;
        const { bytes: data, type } = dataUrlBytes(it.dataUrl);
        const img = type.includes('png') ? await doc.embedPng(data) : await doc.embedJpg(data);
        page.drawImage(img, { x: r.x, y: r.y, width: r.w, height: r.h, opacity: op });
        break;
      }
      case 'link': {
        const ctx = doc.context;
        const action = it.url
          ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(it.url) } }
          : it.destPage !== undefined && it.destPage < doc.getPageCount()
            ? { Dest: [doc.getPage(it.destPage).ref, 'XYZ', null, null, null] }
            : {};
        const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rectArr(r), Border: [0, 0, 0], F: 4, ...action });
        page.node.addAnnot(ctx.register(link));
        break;
      }
      case 'field': {
        form ??= doc.getForm();
        let name = (it.name || `${it.fieldType ?? 'text'}_${it.id.slice(0, 5)}`).replace(/\./g, '_');
        if (it.fieldType !== 'radio') {
          let k = 2;
          const base = name;
          while (fieldNames.has(name) || form.getFieldMaybe(name)) name = `${base}_${k++}`;
        }
        fieldNames.add(name);
        const box = { x: r.x, y: r.y, width: r.w, height: r.h, borderColor: rgb(0.45, 0.5, 0.6), borderWidth: 1 };
        switch (it.fieldType) {
          case 'checkbox':
            form.createCheckBox(name).addToPage(page, box);
            break;
          case 'radio': {
            const g = (form.getFieldMaybe(name) as ReturnType<typeof form.createRadioGroup> | undefined) ?? form.createRadioGroup(name);
            g.addOptionToPage(it.text || `Choice ${g.getOptions().length + 1}`, page, box);
            break;
          }
          case 'dropdown': {
            const d = form.createDropdown(name);
            d.addOptions(it.options?.length ? it.options : ['Option 1', 'Option 2']);
            d.addToPage(page, box);
            break;
          }
          case 'listbox': {
            const l = form.createOptionList(name);
            l.addOptions(it.options?.length ? it.options : ['Option 1', 'Option 2']);
            l.addToPage(page, box);
            break;
          }
          case 'button': {
            const b = form.createButton(name);
            b.addToPage(it.text || 'Button', page, { ...box, backgroundColor: rgb(0.88, 0.92, 0.97) });
            break;
          }
          default: {
            const t = form.createTextField(name);
            if (it.fieldType === 'multiline') t.enableMultiline();
            t.addToPage(page, box);
            if (it.fontSize) t.setFontSize(it.fontSize);
            if (it.align === 'center') t.setAlignment(TextAlignment.Center);
          }
        }
        break;
      }
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly': {
        const quads = it.quads?.length ? it.quads : [r];
        const qp: number[] = [];
        let ops = '';
        for (const q of quads) {
          qp.push(q.x, q.y + q.h, q.x + q.w, q.y + q.h, q.x, q.y, q.x + q.w, q.y);
          if (it.kind === 'highlight') ops += `${num(q.x)} ${num(q.y)} ${num(q.w)} ${num(q.h)} re f\n`;
          else if (it.kind === 'underline') ops += `${num(q.x)} ${num(q.y + q.h * 0.12)} m ${num(q.x + q.w)} ${num(q.y + q.h * 0.12)} l S\n`;
          else if (it.kind === 'strikeout') ops += `${num(q.x)} ${num(q.y + q.h * 0.45)} m ${num(q.x + q.w)} ${num(q.y + q.h * 0.45)} l S\n`;
          else {
            const amp = Math.max(1, q.h * 0.06);
            const step = amp * 2;
            let path = `${num(q.x)} ${num(q.y + amp)} m`;
            for (let x = q.x + step, up = false; x <= q.x + q.w; x += step, up = !up) path += ` ${num(x)} ${num(q.y + (up ? amp * 2 : 0))} l`;
            ops += `${path} S\n`;
          }
        }
        const lw = Math.max(0.8, (quads[0]?.h ?? 10) * 0.07);
        const all = quads.reduce((a, q) => ({ x1: Math.min(a.x1, q.x), y1: Math.min(a.y1, q.y), x2: Math.max(a.x2, q.x + q.w), y2: Math.max(a.y2, q.y + q.h) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
        const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' }[it.kind];
        const head = it.kind === 'highlight' ? `${rgbOps(it.color ?? '#fff176', 'rg')}\n/BM0 gs\n` : `${rgbOps(it.color, 'RG')} ${num(lw)} w\n`;
        const ref = addAnnotation(doc, page, {
          subtype,
          rect: [all.x1 - 1, all.y1 - 1, all.x2 + 1, all.y2 + 1],
          ops: head + ops,
          opacity: it.kind === 'highlight' ? undefined : op,
          item: it,
          extra: { QuadPoints: qp, C: rgbArr(it.color ?? (it.kind === 'highlight' ? '#fff176' : '#000000')) },
        });
        if (it.kind === 'highlight') {
          // Multiply blend so the text under the highlight stays readable.
          const ap = ((doc.context.lookup(ref) as PDFDict).lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as unknown as { dict: PDFDict };
          ap.dict.set(PDFName.of('Resources'), doc.context.obj({ ExtGState: { BM0: { Type: 'ExtGState', BM: 'Multiply', ca: op } } }));
        }
        break;
      }
      case 'redact':
        break; // handled by applyRedactions, which needs rendered pages
    }
  }
  if (form) form.updateFieldAppearances();
  return save(doc);
}

// ---------------------------------------------------------------------------------------------
// Rasterising operations (redaction, scan-style compression, sanitising)
// ---------------------------------------------------------------------------------------------

export interface PageRaster {
  page: number;
  jpeg: Bytes; // image of the page's visible box, without rotation applied
  invisibleText?: { str: string; rect: Rect }[]; // optional text to keep searchable (e.g. OCR or kept text)
}

/**
 * Replace the listed pages with flat images, then rebuild the file from scratch so that nothing that
 * was on those pages (text, images, annotations, hidden objects) survives in the output.
 */
export async function replaceWithRasters(bytes: Bytes, rasters: PageRaster[], opts: { stripMetadata?: boolean } = {}) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of rasters) {
    const page = doc.getPage(r.page);
    const box = page.getCropBox();
    page.node.set(PDFName.of('Contents'), doc.context.obj([]));
    page.node.set(PDFName.of('Resources'), doc.context.obj({}));
    page.node.delete(PDFName.of('Annots'));
    page.setMediaBox(box.x, box.y, box.width, box.height);
    page.setCropBox(box.x, box.y, box.width, box.height);
    const img = await doc.embedJpg(r.jpeg);
    page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height });
    for (const t of r.invisibleText ?? []) drawInvisibleText(page, font, t.str, t.rect);
  }
  // Rebuild: only objects reachable from the pages are copied, so removed content is truly gone.
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, doc.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  if (!opts.stripMetadata) copyMeta(doc, out);
  else out.setProducer('ANCHOR Tsunami');
  return save(out);
}

function copyMeta(from: PDFDocument, to: PDFDocument) {
  const t = from.getTitle();
  if (t) to.setTitle(t);
  const a = from.getAuthor();
  if (a) to.setAuthor(a);
  const s = from.getSubject();
  if (s) to.setSubject(s);
  const k = from.getKeywords();
  if (k) to.setKeywords(k.split(/[,;]\s*|\s+/));
  to.setProducer('ANCHOR Tsunami');
}

function drawInvisibleText(page: PDFPage, font: PDFFont, str: string, rect: Rect) {
  const s = winAnsiSafe(font, str);
  if (!s.trim()) return;
  const w1 = font.widthOfTextAtSize(s, 1);
  const size = Math.max(1, Math.min(rect.h * 0.9, w1 > 0 ? rect.w / w1 : rect.h));
  page.drawText(s, { x: rect.x, y: rect.y + rect.h * 0.15, size, font, opacity: 0 });
}

/** Add an invisible, searchable text layer (from OCR) on top of existing pages. */
export async function addTextLayer(bytes: Bytes, pages: { page: number; words: { str: string; rect: Rect }[] }[]) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.getPage(p.page);
    for (const w of p.words) drawInvisibleText(page, font, w.str, w.rect);
  }
  return save(doc);
}

/** Remove metadata, JavaScript, attachments, and other hidden data by rebuilding the document. */
export async function sanitize(bytes: Bytes) {
  const doc = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, doc.getPageIndices());
  for (const p of pages) {
    p.node.delete(PDFName.of('AA'));
    const annots = p.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) {
      for (let i = annots.size() - 1; i >= 0; i--) {
        const a = annots.lookup(i);
        if (a instanceof PDFDict) {
          const act = a.lookup(PDFName.of('A'));
          if (act instanceof PDFDict && ['JavaScript', 'Launch', 'SubmitForm', 'ImportData'].includes(String(act.lookup(PDFName.of('S'))).slice(1))) a.delete(PDFName.of('A'));
          a.delete(PDFName.of('AA'));
        }
      }
    }
    out.addPage(p);
  }
  out.setProducer('ANCHOR Tsunami');
  out.setCreator('ANCHOR Tsunami');
  return save(out);
}

// ---------------------------------------------------------------------------------------------
// Whole-document stamping: watermarks, headers/footers, page numbers, Bates numbers, backgrounds
// ---------------------------------------------------------------------------------------------

export interface WatermarkOpts {
  text?: string;
  imageDataUrl?: string;
  fontSize: number;
  color: string;
  opacity: number;
  rotation: number;
  pages?: number[];
  behind?: boolean;
  scale?: number; // for images, fraction of page width
}

export async function addWatermark(bytes: Bytes, o: WatermarkOpts) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = o.imageDataUrl
    ? await (async () => {
        const { bytes: d, type } = dataUrlBytes(o.imageDataUrl!);
        return type.includes('png') ? doc.embedPng(d) : doc.embedJpg(d);
      })()
    : null;
  const idx = o.pages ?? doc.getPageIndices();
  for (const i of idx) {
    const page = doc.getPage(i);
    const box = page.getCropBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rot = o.rotation + page.getRotation().angle;
    const rad = (rot * Math.PI) / 180;
    if (img) {
      const w = box.width * (o.scale ?? 0.5);
      const h = (img.height / img.width) * w;
      const dx = -w / 2;
      const dy = -h / 2;
      page.drawImage(img, { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad), width: w, height: h, rotate: degrees(rot), opacity: o.opacity });
    } else if (o.text) {
      const t = winAnsiSafe(font, o.text);
      const tw = font.widthOfTextAtSize(t, o.fontSize);
      const dx = -tw / 2;
      const dy = -o.fontSize * 0.35;
      page.drawText(t, {
        x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
        size: o.fontSize,
        font,
        color: color(o.color),
        opacity: o.opacity,
        rotate: degrees(rot),
      });
    }
    if (o.behind) moveLastContentToBack(page);
  }
  return save(doc);
}

/** Move the most recently appended content stream to the start, so it paints underneath. */
function moveLastContentToBack(page: PDFPage) {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() > 1) {
    const last = contents.get(contents.size() - 1);
    contents.remove(contents.size() - 1);
    contents.insert(0, last);
  }
}

export interface HeaderFooterOpts {
  // Each slot may contain tokens: {page} {pages} {date} {file} {bates}
  topLeft?: string;
  topCenter?: string;
  topRight?: string;
  bottomLeft?: string;
  bottomCenter?: string;
  bottomRight?: string;
  fontSize: number;
  color: string;
  margin: number;
  startNumber?: number;
  batesPrefix?: string;
  batesSuffix?: string;
  batesDigits?: number;
  batesStart?: number;
  fileName?: string;
  pages?: number[];
}

export async function addHeaderFooter(bytes: Bytes, o: HeaderFooterOpts) {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = doc.getPageCount();
  const date = new Date().toLocaleDateString();
  const idx = o.pages ?? doc.getPageIndices();
  idx.forEach((i, k) => {
    const page = doc.getPage(i);
    const box = page.getCropBox();
    const rot = page.getRotation().angle;
    const bates = `${o.batesPrefix ?? ''}${String((o.batesStart ?? 1) + k).padStart(o.batesDigits ?? 6, '0')}${o.batesSuffix ?? ''}`;
    const fill = (s?: string) =>
      (s ?? '')
        .replace(/\{page\}/g, String((o.startNumber ?? 1) + i))
        .replace(/\{pages\}/g, String(total))
        .replace(/\{date\}/g, date)
        .replace(/\{file\}/g, o.fileName ?? '')
        .replace(/\{bates\}/g, bates);
    // Work in "visual" coordinates (as the page is displayed), then map back for rotated pages.
    const vw = rot % 180 ? box.height : box.width;
    const vh = rot % 180 ? box.width : box.height;
    const slots: [string | undefined, 'l' | 'c' | 'r', 't' | 'b'][] = [
      [o.topLeft, 'l', 't'],
      [o.topCenter, 'c', 't'],
      [o.topRight, 'r', 't'],
      [o.bottomLeft, 'l', 'b'],
      [o.bottomCenter, 'c', 'b'],
      [o.bottomRight, 'r', 'b'],
    ];
    for (const [tpl, h, v] of slots) {
      const s = winAnsiSafe(font, fill(tpl));
      if (!s) continue;
      const tw = font.widthOfTextAtSize(s, o.fontSize);
      const vx = h === 'l' ? o.margin : h === 'c' ? (vw - tw) / 2 : vw - o.margin - tw;
      const vy = v === 't' ? vh - o.margin - o.fontSize * 0.8 : o.margin;
      const [x, y] = visualToUser(vx, vy, box, rot);
      page.drawText(s, { x, y, size: o.fontSize, font, color: color(o.color), rotate: degrees(rot) });
    }
  });
  return save(doc);
}

function visualToUser(vx: number, vy: number, box: { x: number; y: number; width: number; height: number }, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [box.x + box.width - vy, box.y + vx];
    case 180:
      return [box.x + box.width - vx, box.y + box.height - vy];
    case 270:
      return [box.x + vy, box.y + box.height - vx];
    default:
      return [box.x + vx, box.y + vy];
  }
}

export async function addBackground(bytes: Bytes, hex: string, pages?: number[]) {
  const doc = await load(bytes);
  for (const i of pages ?? doc.getPageIndices()) {
    const page = doc.getPage(i);
    const b = page.getMediaBox();
    page.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, color: color(hex) });
    moveLastContentToBack(page);
  }
  return save(doc);
}

// ---------------------------------------------------------------------------------------------
// Forms, metadata, security, attachments, bookmarks
// ---------------------------------------------------------------------------------------------

export async function flattenForms(bytes: Bytes) {
  const doc = await load(bytes);
  const form = doc.getForm();
  try {
    form.updateFieldAppearances();
  } catch {
    /* some fields have no font; flatten what we can */
  }
  form.flatten();
  return save(doc);
}

/** Bake every annotation's appearance into the page content and drop the annotation objects. */
export async function flattenAnnotations(bytes: Bytes) {
  const doc = await load(bytes);
  try {
    doc.getForm().flatten();
  } catch {
    /* no form */
  }
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFRef[] = [];
    let ops = '';
    const xobjs: Record<string, PDFRef> = {};
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const sub = String(a.lookup(PDFName.of('Subtype'))).slice(1);
      if (['Link', 'Popup', 'Widget'].includes(sub)) {
        if (ref instanceof PDFRef && sub !== 'Popup') keep.push(ref);
        continue;
      }
      const ap = a.lookup(PDFName.of('AP'));
      const n = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : undefined;
      const rect = a.lookup(PDFName.of('Rect'));
      if (!(n instanceof PDFRef) || !(rect instanceof PDFArray)) continue;
      const stream = doc.context.lookup(n) as unknown as { dict: PDFDict };
      if (!stream?.dict) continue; // appearance sub-dictionaries (states) are skipped
      const bbox = stream.dict.lookup(PDFName.of('BBox'));
      const [rx1, ry1, rx2, ry2] = rect.asArray().map((v) => Number(v.toString()));
      const [bx1, by1, bx2, by2] = bbox instanceof PDFArray ? bbox.asArray().map((v) => Number(v.toString())) : [rx1, ry1, rx2, ry2];
      const sx = (rx2 - rx1) / (bx2 - bx1 || 1);
      const sy = (ry2 - ry1) / (by2 - by1 || 1);
      const name = `FlatAnnot${i}`;
      xobjs[name] = n;
      ops += `q ${num(sx)} 0 0 ${num(sy)} ${num(rx1 - bx1 * sx)} ${num(ry1 - by1 * sy)} cm /${name} Do Q\n`;
    }
    if (ops) {
      let res = page.node.lookup(PDFName.of('Resources'));
      if (!(res instanceof PDFDict)) {
        res = doc.context.obj({});
        page.node.set(PDFName.of('Resources'), res as PDFDict);
      }
      let xo = (res as PDFDict).lookup(PDFName.of('XObject'));
      if (!(xo instanceof PDFDict)) {
        xo = doc.context.obj({});
        (res as PDFDict).set(PDFName.of('XObject'), xo as PDFDict);
      }
      for (const [k, v] of Object.entries(xobjs)) (xo as PDFDict).set(PDFName.of(k), v);
      const s = doc.context.register(doc.context.stream(ops));
      const contents = page.node.Contents();
      if (contents instanceof PDFArray) contents.push(s);
      else page.node.set(PDFName.of('Contents'), doc.context.obj([page.node.get(PDFName.of('Contents'))!, s]));
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
  return save(doc);
}

export async function getMeta(bytes: Bytes): Promise<DocMeta> {
  const doc = await load(bytes);
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
  };
}

export async function setMeta(bytes: Bytes, m: DocMeta) {
  const doc = await load(bytes);
  doc.setTitle(m.title ?? '', { showInWindowTitleBar: true });
  doc.setAuthor(m.author ?? '');
  doc.setSubject(m.subject ?? '');
  doc.setKeywords((m.keywords ?? '').split(/[,;]\s*/).filter(Boolean));
  doc.setCreator(m.creator ?? '');
  doc.setProducer(m.producer || 'ANCHOR Tsunami');
  doc.setModificationDate(new Date());
  return save(doc);
}

export interface SecurityOpts {
  userPassword?: string;
  ownerPassword: string;
  printing: 'none' | 'lowResolution' | 'highResolution';
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  documentAssembly: boolean;
}

export async function encrypt(bytes: Bytes, o: SecurityOpts) {
  const doc = await load(bytes);
  doc.encrypt({
    userPassword: o.userPassword ?? '',
    ownerPassword: o.ownerPassword,
    permissions: {
      printing: o.printing === 'none' ? undefined : o.printing,
      modifying: o.modifying,
      copying: o.copying,
      annotating: o.annotating,
      fillingForms: o.fillingForms,
      contentAccessibility: o.contentAccessibility,
      documentAssembly: o.documentAssembly,
    },
  } as never);
  return doc.save({ useObjectStreams: false });
}

export function isEncrypted(bytes: Bytes) {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (/\/Encrypt\s/.test(tail)) return true;
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20))));
}

/** Remove encryption. Needs the document's password (owner or user). */
export async function decrypt(bytes: Bytes, password: string) {
  const doc = await PDFDocument.load(bytes, { password } as never);
  return doc.save({ useObjectStreams: true });
}

export async function attachFile(bytes: Bytes, file: { name: string; bytes: Bytes; type: string; description?: string }) {
  const doc = await load(bytes);
  await doc.attach(file.bytes, file.name, { mimeType: file.type || 'application/octet-stream', description: file.description, creationDate: new Date(), modificationDate: new Date() });
  return save(doc);
}

export interface BookmarkNode {
  title: string;
  page: number; // 0-based
  children?: BookmarkNode[];
}

/** Replace the document outline (bookmarks) with the given tree. */
export async function setOutline(bytes: Bytes, tree: BookmarkNode[]) {
  const doc = await load(bytes);
  const ctx = doc.context;
  if (!tree.length) {
    doc.catalog.delete(PDFName.of('Outlines'));
    return save(doc);
  }
  const rootRef = ctx.nextRef();
  const build = (nodes: BookmarkNode[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = nodes.map(() => ctx.nextRef());
    let count = 0;
    nodes.forEach((n, i) => {
      const dict: Record<string, unknown> = {
        Title: pdfText(n.title),
        Parent: parent,
        Dest: [doc.getPage(Math.min(n.page, doc.getPageCount() - 1)).ref, PDFName.of('XYZ'), null, null, null],
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < nodes.length - 1) dict.Next = refs[i + 1];
      if (n.children?.length) {
        const c = build(n.children, refs[i]);
        dict.First = c.first;
        dict.Last = c.last;
        dict.Count = c.count;
        count += c.count;
      }
      ctx.assign(refs[i], ctx.obj(dict as never));
      count++;
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(tree, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  return save(doc);
}

/** Re-save with compressed object streams; drops unused objects. */
export async function optimize(bytes: Bytes) {
  const doc = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, doc.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  copyMeta(doc, out);
  // Keep the form if there is one.
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro instanceof PDFDict && out.getPageCount()) {
    // Fields are referenced from widget annotations that were copied with the pages; rebuild the field list from them.
    const fields: PDFRef[] = [];
    for (const p of out.getPages()) {
      const annots = p.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) continue;
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const a = annots.lookup(i);
        if (!(a instanceof PDFDict) || String(a.lookup(PDFName.of('Subtype'))) !== '/Widget') continue;
        let top: PDFRef = ref as PDFRef;
        let cur: PDFDict = a;
        while (cur.get(PDFName.of('Parent')) instanceof PDFRef) {
          top = cur.get(PDFName.of('Parent')) as PDFRef;
          cur = out.context.lookup(top) as PDFDict;
        }
        if (!fields.some((f) => f.toString() === top.toString())) fields.push(top);
      }
    }
    if (fields.length) out.catalog.set(PDFName.of('AcroForm'), out.context.obj({ Fields: fields, NeedAppearances: false }));
  }
  const a = await save(out);
  return a.length < bytes.length ? a : bytes;
}

// ---------------------------------------------------------------------------------------------
// Form data import / export
// ---------------------------------------------------------------------------------------------

export type FormData = Record<string, string | boolean | string[]>;

export async function getFormData(bytes: Bytes): Promise<FormData> {
  const doc = await load(bytes);
  const out: FormData = {};
  for (const f of doc.getForm().getFields()) {
    try {
      if (f instanceof PDFTextField) out[f.getName()] = f.getText() ?? '';
      else if (f instanceof PDFCheckBox) out[f.getName()] = f.isChecked();
      else if (f instanceof PDFRadioGroup) out[f.getName()] = f.getSelected() ?? '';
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) out[f.getName()] = f.getSelected();
    } catch {
      /* unreadable field */
    }
  }
  return out;
}

export async function setFormData(bytes: Bytes, data: FormData) {
  const doc = await load(bytes);
  const form = doc.getForm();
  for (const [name, v] of Object.entries(data)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      if (f instanceof PDFTextField) f.setText(String(v ?? ''));
      else if (f instanceof PDFCheckBox) {
        if (v) f.check();
        else f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        if (v) f.select(String(v));
        else f.clear();
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (Array.isArray(v) ? v.length : v) f.select(Array.isArray(v) ? v : [String(v)]);
        else f.clear();
      }
    } catch {
      /* value not allowed for this field */
    }
  }
  return save(doc);
}

export async function clearForm(bytes: Bytes) {
  const data = await getFormData(bytes);
  const blank: FormData = {};
  for (const [k, v] of Object.entries(data)) blank[k] = typeof v === 'boolean' ? false : Array.isArray(v) ? [] : '';
  return setFormData(bytes, blank);
}
