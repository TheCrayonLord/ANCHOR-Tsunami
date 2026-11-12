/**
 * Any file to PDF.
 *
 * Every file ends up as a PDF one way or another:
 * - PDFs pass through; images of any kind the browser (or a decoder here) can read become pages.
 * - Documents, spreadsheets, slides, web pages, Markdown, e-books, email and text are laid out as
 *   real text by the built-in engine. Office files use the conversion server instead when one is
 *   set up, for exact layout.
 * - ZIP archives are converted file by file and combined.
 * - Anything else (audio, video, programs, unknown formats) becomes a cover page with the original
 *   file attached inside the PDF, so nothing is ever refused.
 */
import JSZip from 'jszip';
import * as ops from './ops';
import { layoutDocument, heading, para, type Block, type Inline } from './richpdf';

export interface ConvertContext {
  server?: { url: string; token?: string } | null;
  progress?: (p: number, label?: string) => void;
  depth?: number;
}
export interface Converted {
  bytes: Uint8Array;
  how: 'pdf' | 'image' | 'builtin' | 'server' | 'attached';
  note?: string;
}

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const LANDSCAPE: [number, number] = [792, 612];

const IMG_NATIVE = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif']);
const IMG_BROWSER = new Set(['gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'apng']);
const SHEETS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv', 'tsv', 'tab', 'numbers', 'dif', 'slk', 'fods']);
const CODE = new Set(['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php', 'swift', 'kt', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'css', 'scss', 'less', 'vue', 'svelte', 'lua', 'pl', 'r', 'm', 'tex', 'diff', 'patch', 'gradle', 'dockerfile', 'makefile', 'env', 'properties', 'log', 'ics', 'vcf', 'srt', 'vtt']);
const TEXT = new Set(['txt', 'text', 'nfo', 'readme']);
export const SERVER_FORMATS = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'ott', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'odg', 'vsd', 'vsdx', 'pub', 'wpd']);

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

async function canvasPng(draw: (g: CanvasRenderingContext2D) => void, w: number, h: number): Promise<Uint8Array> {
  const k = Math.min(1, 5000 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d')!;
  g.scale(k, k);
  draw(g);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('could not encode image');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode any image the browser understands and re-encode it as PNG. */
export async function browserImageToPng(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (!/svg/.test(mime)) {
    try {
      const bmp = await createImageBitmap(blob);
      const out = { bytes: await canvasPng((g) => g.drawImage(bmp, 0, 0), bmp.width, bmp.height), w: bmp.width, h: bmp.height };
      bmp.close();
      return out;
    } catch {
      /* fall through to an <img> element */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('The image could not be decoded.'));
      img.src = url;
    });
    // SVGs without a size get a sensible default.
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 768;
    const scale = /svg/.test(mime) ? Math.max(1, Math.min(3, 2000 / Math.max(w, h))) : 1;
    return {
      bytes: await canvasPng(
        (g) => {
          if (/svg/.test(mime)) {
            g.fillStyle = '#fff';
            g.fillRect(0, 0, w * scale, h * scale);
          }
          g.drawImage(img, 0, 0, w * scale, h * scale);
        },
        w * scale,
        h * scale,
      ),
      w,
      h,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MIME: Record<string, string> = { gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', apng: 'image/apng', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg' };

async function tiffToPngs(bytes: Uint8Array): Promise<Uint8Array[]> {
  const UTIF = (await import('utif')) as unknown as { decode(b: ArrayBuffer): { width: number; height: number }[]; decodeImage(b: ArrayBuffer, ifd: unknown): void; toRGBA8(ifd: unknown): Uint8Array };
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buf);
  const out: Uint8Array[] = [];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    if (!ifd.width || !ifd.height) continue;
    const rgba = UTIF.toRGBA8(ifd);
    const data = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), ifd.width, ifd.height);
    const tmp = document.createElement('canvas');
    tmp.width = ifd.width;
    tmp.height = ifd.height;
    tmp.getContext('2d')!.putImageData(data, 0, 0);
    out.push(await canvasPng((g) => g.drawImage(tmp, 0, 0), ifd.width, ifd.height));
  }
  if (!out.length) throw new Error('no pages in TIFF');
  return out;
}

async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array[]> {
  const heic2any = ((await import('heic2any')) as unknown as { default: (o: { blob: Blob; toType: string; quality: number; multiple: boolean }) => Promise<Blob | Blob[]> }).default;
  const res = await heic2any({ blob: new Blob([bytes as BlobPart], { type: 'image/heic' }), toType: 'image/jpeg', quality: 0.92, multiple: true });
  const blobs = Array.isArray(res) ? res : [res];
  return Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer())));
}

// ---------------------------------------------------------------------------------------------
// HTML to blocks
// ---------------------------------------------------------------------------------------------

type Style = Omit<Inline, 'text'>;
type ImageResolver = (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;

function dataUrlBytes(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    const raw = m[2] ? atob(m[3].replace(/\s+/g, '')) : decodeURIComponent(m[3]);
    return { bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)), mime: m[1] || 'image/png' };
  } catch {
    return null;
  }
}

const cssColor = (v?: string | null) => {
  if (!v) return undefined;
  const h = /#([0-9a-f]{6})\b/i.exec(v);
  if (h) return `#${h[1]}`;
  const s = /#([0-9a-f])([0-9a-f])([0-9a-f])\b/i.exec(v);
  if (s) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const r = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (r) return '#' + [r[1], r[2], r[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  return undefined;
};

const SKIP = new Set(['script', 'style', 'head', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'select', 'button', 'input', 'textarea', 'title', 'meta', 'link']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd', 'form', 'fieldset', 'details', 'summary', 'center', 'body', 'html']);

export async function htmlToBlocks(root: Element, resolveImage?: ImageResolver): Promise<Block[]> {
  const blocks: Block[] = [];
  let cur: Inline[] = [];
  interface BlockProps {
    size?: number;
    align?: 'left' | 'center' | 'right';
    indent: number;
    bullet?: string;
    before?: number;
    after?: number;
    keepWithNext?: boolean;
  }
  let props: BlockProps = { indent: 0 };
  const flush = () => {
    // Trim the paragraph's edges.
    while (cur.length && !cur[0].text.trim() && !cur[0].text.includes('\n')) cur.shift();
    if (cur.length) cur[0] = { ...cur[0], text: cur[0].text.replace(/^[ \t]+/, '') };
    while (cur.length && !cur[cur.length - 1].text.trim()) cur.pop();
    if (cur.length) cur[cur.length - 1] = { ...cur[cur.length - 1], text: cur[cur.length - 1].text.replace(/\s+$/, '') };
    if (cur.some((r) => r.text.trim())) blocks.push({ type: 'p', runs: cur, ...props, indent: props.indent || undefined });
    cur = [];
    props = { ...props, bullet: undefined };
  };
  const addText = (text: string, st: Style) => {
    if (!text) return;
    const last = cur[cur.length - 1];
    if (/^\s/.test(text) && (!last || /\s$/.test(last.text))) text = text.replace(/^\s+/, '');
    if (!text) return;
    cur.push({ ...st, text });
  };
  const inlineText = (el: Element, st: Style): Inline[] => {
    const out: Inline[] = [];
    const go = (n: Node, s: Style) => {
      if (n.nodeType === 3) {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ');
        if (t) out.push({ ...s, text: t });
      } else if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toLowerCase();
        if (SKIP.has(tag)) return;
        if (tag === 'br') return void out.push({ ...s, text: '\n' });
        const s2 = { ...s, ...(tag === 'b' || tag === 'strong' ? { bold: true } : {}), ...(tag === 'i' || tag === 'em' ? { italic: true } : {}) };
        const before = out.length;
        e.childNodes.forEach((c) => go(c, s2));
        if ((BLOCK.has(tag) || tag === 'li' || /^h\d$/.test(tag)) && out.length > before) out.push({ ...s, text: '\n' });
      }
    };
    go(el, st);
    while (out.length && !out[out.length - 1].text.trim()) out.pop();
    if (out.length) out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, '') };
    return out;
  };

  const listStack: { ordered: boolean; n: number }[] = [];
  let images = 0;

  async function walk(node: Node, st: Style, pre = false): Promise<void> {
    if (node.nodeType === 3) {
      const t = node.textContent ?? '';
      addText(pre ? t : t.replace(/\s+/g, ' '), st);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase().replace(/^.*:/, '');
    if (SKIP.has(tag)) return;
    if (el.hasAttribute('hidden') || /display\s*:\s*none/i.test(el.getAttribute('style') ?? '')) return;
    const style = el.getAttribute('style') ?? '';
    const s: Style = { ...st };
    const col = cssColor(/(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]) ?? cssColor(el.getAttribute('color'));
    if (col && col.toLowerCase() !== '#ffffff') s.color = col;
    if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) s.bold = true;
    if (/font-style\s*:\s*italic/i.test(style)) s.italic = true;
    if (/text-decoration[^;]*underline/i.test(style)) s.underline = true;
    if (/text-decoration[^;]*line-through/i.test(style)) s.strike = true;
    const alignM = /text-align\s*:\s*(center|right)/i.exec(style)?.[1] ?? (/^(center|right)$/i.test(el.getAttribute('align') ?? '') ? el.getAttribute('align')! : tag === 'center' ? 'center' : undefined);
    const kids = async (s2 = s, p = pre) => {
      for (const c of Array.from(el.childNodes)) await walk(c, s2, p);
    };

    switch (tag) {
      case 'br':
        cur.push({ ...s, text: '\n' });
        return;
      case 'hr':
        flush();
        blocks.push({ type: 'hr' });
        return;
      case 'b':
      case 'strong':
        return kids({ ...s, bold: true });
      case 'i':
      case 'em':
      case 'cite':
      case 'dfn':
      case 'var':
        return kids({ ...s, italic: true });
      case 'u':
      case 'ins':
        return kids({ ...s, underline: true });
      case 's':
      case 'strike':
      case 'del':
        return kids({ ...s, strike: true });
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return kids({ ...s, mono: true });
      case 'a': {
        const href = el.getAttribute('href') ?? '';
        return kids(/^(https?:|mailto:)/i.test(href) ? { ...s, link: href } : s);
      }
      case 'img': {
        const src = el.getAttribute('src') ?? '';
        if (!src || images >= 400) return;
        let data = dataUrlBytes(src);
        if (!data && resolveImage) data = await resolveImage(src).catch(() => null);
        if (!data) {
          const alt = el.getAttribute('alt');
          if (alt) addText(`[${alt}]`, { ...s, italic: true });
          return;
        }
        try {
          let { bytes, mime } = data;
          let natural: { w: number; h: number } | null = null;
          if (!/png|jpe?g/i.test(mime)) {
            const png = await browserImageToPng(bytes, mime);
            bytes = png.bytes;
            mime = 'image/png';
            natural = png;
          }
          const wAttr = parseFloat(el.getAttribute('width') ?? '') || parseFloat(/(?:^|;)\s*width\s*:\s*([\d.]+)px/i.exec(style)?.[1] ?? '');
          flush();
          images++;
          blocks.push({ type: 'image', bytes, mime, width: wAttr ? wAttr * 0.75 : natural ? natural.w * 0.75 : undefined });
        } catch {
          /* undecodable image */
        }
        return;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        flush();
        const lvl = Number(tag[1]);
        const saved = props;
        props = { ...props, size: [22, 17, 14, 12.5, 11.5, 11][lvl - 1], before: lvl <= 2 ? 14 : 10, after: 6, keepWithNext: true, align: (alignM as 'center') ?? props.align };
        await kids({ ...s, bold: true });
        flush();
        props = saved;
        return;
      }
      case 'pre': {
        flush();
        const text = (el.textContent ?? '').replace(/^\n/, '').replace(/\s+$/, '');
        if (text) blocks.push({ type: 'pre', text });
        return;
      }
      case 'blockquote': {
        flush();
        const saved = props;
        props = { ...props, indent: props.indent + 18 };
        await kids({ ...s, color: s.color ?? '#4a5568' });
        flush();
        props = saved;
        return;
      }
      case 'ul':
      case 'ol':
      case 'menu': {
        flush();
        const saved = props;
        props = { ...props, indent: props.indent + 20, after: 2 };
        listStack.push({ ordered: tag === 'ol', n: (parseInt(el.getAttribute('start') ?? '1', 10) || 1) - 1 });
        await kids();
        flush();
        listStack.pop();
        props = saved;
        return;
      }
      case 'li': {
        flush();
        const l = listStack[listStack.length - 1];
        if (l) l.n++;
        props = { ...props, bullet: l?.ordered ? `${l.n}.` : listStack.length > 1 ? '–' : '•' };
        await kids();
        flush();
        return;
      }
      case 'table': {
        flush();
        const rows: Inline[][][] = [];
        let header = false;
        for (const tr of Array.from(el.querySelectorAll('tr'))) {
          if (tr.closest('table') !== el) continue;
          const cells = Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName));
          if (!cells.length) continue;
          if (!rows.length && cells.every((c) => c.tagName.toLowerCase() === 'th')) header = true;
          const row: Inline[][] = [];
          for (const c of cells) {
            row.push(inlineText(c, c.tagName.toLowerCase() === 'th' ? { bold: true } : {}));
            const span = Math.min(50, parseInt(c.getAttribute('colspan') ?? '1', 10) || 1);
            for (let k = 1; k < span; k++) row.push([]);
          }
          rows.push(row);
        }
        // Layout tables (one column or one row) read better as normal flow.
        const maxCols = Math.max(0, ...rows.map((r) => r.length));
        if (maxCols <= 1 || rows.length <= 1) {
          await kids();
          flush();
          return;
        }
        if (rows.length) blocks.push({ type: 'table', rows, header });
        return;
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'tr':
        return kids();
      case 'td':
      case 'th':
        flush();
        await kids();
        flush();
        return;
      default: {
        if (BLOCK.has(tag)) {
          flush();
          const saved = props;
          if (alignM) props = { ...props, align: alignM.toLowerCase() as 'center' };
          if (tag === 'dd') props = { ...props, indent: props.indent + 18 };
          await kids(tag === 'dt' ? { ...s, bold: true } : tag === 'figcaption' ? { ...s, italic: true } : s);
          flush();
          props = saved;
          return;
        }
        return kids();
      }
    }
  }
  await walk(root, {});
  flush();
  return blocks;
}

function parseHtml(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ---------------------------------------------------------------------------------------------
// Individual formats
// ---------------------------------------------------------------------------------------------

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** True when the bytes look like human-readable text. */
function looksLikeText(bytes: Uint8Array) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  const n = Math.min(bytes.length, 65536);
  if (!n) return true;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) odd++;
  }
  return odd / n < 0.02;
}

async function sheetBlocks(bytes: Uint8Array, name: string): Promise<Block[]> {
  const XLSX = await import('xlsx');
  const e = ext(name);
  const wb = e === 'csv' || e === 'tsv' || e === 'tab' ? XLSX.read(decodeText(bytes), { type: 'string', raw: false, FS: e === 'csv' ? undefined : '\t' } as never) : XLSX.read(bytes, { type: 'array', cellDates: true });
  const blocks: Block[] = [];
  wb.SheetNames.forEach((sn, si) => {
    const ws = wb.Sheets[sn];
    let rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: true }) as unknown[][];
    // Drop empty trailing rows and columns.
    while (rows.length && rows[rows.length - 1].every((c) => String(c ?? '').trim() === '')) rows.pop();
    const width = Math.max(0, ...rows.map((r) => {
      let k = r.length;
      while (k > 0 && String(r[k - 1] ?? '').trim() === '') k--;
      return k;
    }));
    if (si > 0) blocks.push({ type: 'pagebreak' });
    if (wb.SheetNames.length > 1 || !/^(sheet ?1)$/i.test(sn)) blocks.push(heading(sn, 2));
    if (!rows.length || !width) {
      blocks.push(para('(empty sheet)', { italic: true, color: '#667085' }));
      return;
    }
    const total = rows.length;
    const MAX = 20000;
    if (rows.length > MAX) rows = rows.slice(0, MAX);
    blocks.push({ type: 'table', header: true, size: width > 10 ? 7.5 : 8.5, rows: rows.map((r) => Array.from({ length: width }, (_, c) => (String(r[c] ?? '') ? [{ text: String(r[c]) }] : []))) });
    if (total > MAX) blocks.push(para(`Showing the first ${MAX.toLocaleString()} of ${total.toLocaleString()} rows.`, { italic: true }));
  });
  return blocks;
}

/** Text of a legacy Word 97-2003 .doc file, read from its piece table. */
async function legacyDocText(bytes: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx');
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const find = (n: string) => {
    const c = XLSX.CFB.find(cfb, n)?.content as ArrayLike<number> | undefined;
    return c ? Uint8Array.from(c) : undefined;
  };
  const wd = find('WordDocument');
  if (!wd) throw new Error('not a Word document');
  const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  const flags = dv.getUint16(0x0a, true);
  const table = find(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('missing table stream');
  const ccpText = dv.getInt32(0x4c, true);
  const fcClx = dv.getInt32(0x1a2, true);
  const lcbClx = dv.getInt32(0x1a6, true);
  const t = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let pos = fcClx;
  const end = fcClx + lcbClx;
  while (pos < end && t.getUint8(pos) === 1) pos += 3 + t.getUint16(pos + 1, true); // skip Prc entries
  if (t.getUint8(pos) !== 2) throw new Error('no piece table');
  const lcb = t.getInt32(pos + 1, true);
  pos += 5;
  const n = (lcb - 4) / 12;
  let out = '';
  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  for (let i = 0; i < n; i++) {
    const cpStart = t.getInt32(pos + i * 4, true);
    const cpEnd = t.getInt32(pos + (i + 1) * 4, true);
    const fcRaw = t.getUint32(pos + (n + 1) * 4 + i * 8 + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    const count = Math.min(cpEnd, ccpText) - cpStart;
    if (count <= 0) continue;
    out += compressed ? cp1252.decode(wd.subarray(fc / 2, fc / 2 + count)) : utf16.decode(wd.subarray(fc, fc + count * 2));
  }
  return out
    .replace(/\x13[^\x14\x15]*\x14/g, '') // field codes
    .replace(/[\x13\x14\x15\x01\x08]/g, '')
    .replace(/\x07/g, '\t')
    .replace(/[\r\x0b\x0c]/g, '\n');
}

function rtfToText(rtf: string): string {
  let out = '';
  const stack: boolean[] = [];
  let skip = false;
  let i = 0;
  const SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'generator', 'themedata', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl', 'fldinst', 'filetbl', 'revtbl']);
  let ucSkip = 1;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push(skip);
      i++;
    } else if (ch === '}') {
      skip = stack.pop() ?? false;
      i++;
    } else if (ch === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
      if (m) {
        i += m[0].length;
        const [, word, num] = m;
        if (SKIP_DEST.has(word)) skip = true;
        else if (skip) continue;
        else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') out += '\n';
        else if (word === 'tab' || word === 'cell') out += '\t';
        else if (word === 'uc') ucSkip = Number(num ?? 1);
        else if (word === 'u' && num) {
          out += String.fromCharCode((Number(num) + 65536) % 65536);
          // skip the fallback characters
          for (let k = 0; k < ucSkip && i < rtf.length; k++) {
            if (rtf[i] === '\\' && rtf[i + 1] === "'") i += 4;
            else i++;
          }
        } else if (word === 'emdash') out += '—';
        else if (word === 'endash') out += '–';
        else if (word === 'bullet') out += '•';
        else if (word === 'lquote') out += '‘';
        else if (word === 'rquote') out += '’';
        else if (word === 'ldblquote') out += '“';
        else if (word === 'rdblquote') out += '”';
      } else if (rtf[i + 1] === "'") {
        if (!skip) out += new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(rtf.slice(i + 2, i + 4), 16)));
        i += 4;
      } else if (rtf[i + 1] === '*') {
        skip = true;
        i += 2;
      } else {
        if (!skip && /[\\{}]/.test(rtf[i + 1] ?? '')) out += rtf[i + 1];
        i += 2;
      }
    } else {
      if (!skip && ch !== '\r' && ch !== '\n') out += ch;
      i++;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

const textBlocks = (text: string): Block[] =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n/)
    .map((l) => para(l));

/** OpenDocument text and presentations: headings, paragraphs, lists, tables and images. */
async function odfBlocks(zip: JSZip, kind: 'odt' | 'odp'): Promise<Block[]> {
  const xml = await zip.file('content.xml')?.async('string');
  if (!xml) throw new Error('missing content.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const blocks: Block[] = [];
  const local = (e: Element) => e.localName;
  const textOf = (e: Element): string => {
    let s = '';
    e.childNodes.forEach((c) => {
      if (c.nodeType === 3) s += c.textContent;
      else if (c.nodeType === 1) {
        const n = local(c as Element);
        if (n === 'tab') s += '\t';
        else if (n === 'line-break') s += '\n';
        else if (n === 's') s += ' '.repeat(Number((c as Element).getAttribute('text:c') ?? 1));
        else if (n !== 'frame' && n !== 'note') s += textOf(c as Element);
      }
    });
    return s;
  };
  async function images(e: Element) {
    for (const im of Array.from(e.getElementsByTagNameNS('*', 'image'))) {
      const href = im.getAttribute('xlink:href') ?? '';
      const f = zip.file(href);
      if (!f) continue;
      const bytes = await f.async('uint8array');
      const m = MIME[ext(href)] ?? 'image/png';
      try {
        const data = /png|jpe?g/.test(m) ? { bytes, mime: m } : { bytes: (await browserImageToPng(bytes, m)).bytes, mime: 'image/png' };
        blocks.push({ type: 'image', ...data, maxHeight: 420 });
      } catch {
        /* skip */
      }
    }
  }
  async function walk(e: Element, indent = 0, bullet?: string) {
    for (const c of Array.from(e.children)) {
      const n = local(c);
      if (n === 'h') blocks.push(heading(textOf(c), Number(c.getAttribute('text:outline-level') ?? 1)));
      else if (n === 'p') {
        const t = textOf(c);
        if (t.trim()) blocks.push({ type: 'p', runs: [{ text: t }], indent: indent || undefined, bullet });
        else if (!c.getElementsByTagNameNS('*', 'image').length) blocks.push(para(''));
        await images(c);
        bullet = undefined;
      } else if (n === 'list') {
        for (const li of Array.from(c.children)) await walk(li, indent + 20, '•');
      } else if (n === 'table') {
        const rows: Inline[][][] = [];
        for (const tr of Array.from(c.getElementsByTagNameNS('*', 'table-row'))) rows.push(Array.from(tr.children).filter((x) => local(x) === 'table-cell').map((cell) => (textOf(cell).trim() ? [{ text: textOf(cell).trim() }] : [])));
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (n === 'page') {
        if (blocks.length) blocks.push({ type: 'pagebreak' });
        await walk(c, indent);
        await images(c);
      } else await walk(c, indent, bullet);
    }
  }
  const body = doc.getElementsByTagNameNS('*', kind === 'odt' ? 'text' : 'presentation')[0] ?? doc.documentElement;
  await walk(body);
  return blocks;
}

async function epubBlocks(zip: JSZip): Promise<{ blocks: Block[]; title?: string }> {
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = /full-path="([^"]+)"/.exec(container ?? '')?.[1];
  if (!opfPath) throw new Error('not an EPUB');
  const opf = new DOMParser().parseFromString((await zip.file(opfPath)!.async('string')) ?? '', 'application/xml');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  Array.from(opf.getElementsByTagNameNS('*', 'item')).forEach((it) => manifest.set(it.getAttribute('id') ?? '', it.getAttribute('href') ?? ''));
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent ?? undefined;
  const resolve = (from: string, rel: string) => {
    const parts = (from.slice(0, from.lastIndexOf('/') + 1) + decodeURIComponent(rel.split('#')[0])).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    }
    return out.join('/');
  };
  const blocks: Block[] = [];
  for (const ref of Array.from(opf.getElementsByTagNameNS('*', 'itemref'))) {
    const href = manifest.get(ref.getAttribute('idref') ?? '');
    if (!href) continue;
    const path = base + decodeURIComponent(href);
    const html = await zip.file(path)?.async('string');
    if (!html) continue;
    const d = parseHtml(html);
    const part = await htmlToBlocks(d.body, async (src) => {
      const f = zip.file(resolve(path, src));
      return f ? { bytes: await f.async('uint8array'), mime: MIME[ext(src)] ?? 'image/png' } : null;
    });
    if (part.length) {
      if (blocks.length) blocks.push({ type: 'pagebreak' });
      blocks.push(...part);
    }
  }
  return { blocks, title };
}

// Email ------------------------------------------------------------------------------------------

function decodeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (_m, cs: string, enc: string, data: string) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : Uint8Array.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return data;
    }
  });
}
interface MimePart {
  headers: Record<string, string>;
  type: string;
  body: string; // raw (latin1) body
  parts: MimePart[];
}
function parseMime(raw: string): MimePart {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  const ct = headers['content-type'] ?? 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  const parts: MimePart[] = [];
  if (type.startsWith('multipart/') && boundary) {
    const segs = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const s of segs.slice(1)) if (s.trim()) parts.push(parseMime(s));
  }
  return { headers, type, body, parts };
}
function partBytes(p: MimePart): Uint8Array {
  const enc = (p.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (enc === 'base64') {
    try {
      return Uint8Array.from(atob(p.body.replace(/[^A-Za-z0-9+/=]/g, '')), (c) => c.charCodeAt(0));
    } catch {
      return new Uint8Array();
    }
  }
  const s = enc === 'quoted-printable' ? p.body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : p.body;
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
}
function partText(p: MimePart) {
  const cs = /charset="?([^";]+)"?/i.exec(p.headers['content-type'] ?? '')?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(cs).decode(partBytes(p));
  } catch {
    return new TextDecoder().decode(partBytes(p));
  }
}
async function emailBlocks(bytes: Uint8Array): Promise<{ blocks: Block[]; title: string; attachments: { name: string; bytes: Uint8Array; type: string }[] }> {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 65536) raw += String.fromCharCode(...bytes.subarray(i, i + 65536));
  const root = parseMime(raw);
  const flat: MimePart[] = [];
  const collect = (p: MimePart) => (p.parts.length ? p.parts.forEach(collect) : flat.push(p));
  collect(root);
  const isAttachment = (p: MimePart) => /attachment/i.test(p.headers['content-disposition'] ?? '') || (!p.type.startsWith('text/') && !p.type.startsWith('multipart/'));
  const html = flat.find((p) => p.type === 'text/html' && !isAttachment(p));
  const plain = flat.find((p) => p.type === 'text/plain' && !isAttachment(p));
  const h = (k: string) => decodeWords(root.headers[k] ?? '');
  const subject = h('subject') || '(no subject)';
  const blocks: Block[] = [heading(subject, 2)];
  const rows = [
    ['From', h('from')],
    ['To', h('to')],
    ['Cc', h('cc')],
    ['Date', h('date')],
  ].filter((r) => r[1]);
  for (const [k, v] of rows) blocks.push({ type: 'p', runs: [{ text: `${k}: `, bold: true }, { text: v }], after: 1 });
  const attachments = flat.filter(isAttachment).map((p) => {
    const name = decodeWords(/name\*?="?([^";]+)"?/i.exec((p.headers['content-disposition'] ?? '') + ';' + (p.headers['content-type'] ?? ''))?.[1] ?? 'attachment');
    return { name, bytes: partBytes(p), type: p.type };
  });
  if (attachments.length) blocks.push({ type: 'p', runs: [{ text: 'Attachments: ', bold: true }, { text: attachments.map((a) => a.name).join(', ') }], after: 1 });
  blocks.push({ type: 'hr' });
  const cids = new Map<string, MimePart>();
  flat.forEach((p) => p.headers['content-id'] && cids.set(p.headers['content-id'].replace(/[<>]/g, ''), p));
  if (html)
    blocks.push(
      ...(await htmlToBlocks(parseHtml(partText(html)).body, async (src) => {
        const p = src.startsWith('cid:') ? cids.get(src.slice(4)) : undefined;
        return p ? { bytes: partBytes(p), mime: p.type } : null;
      })),
    );
  else blocks.push(...textBlocks(plain ? partText(plain) : ''));
  return { blocks, title: subject, attachments };
}

// ---------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------

const fmtSize = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`);

/** A cover page with the original file attached inside the PDF. */
async function wrapAsAttachment(file: File, bytes: Uint8Array, why: string): Promise<Converted> {
  const blocks: Block[] = [
    heading(file.name, 1),
    { type: 'table', rows: [[[{ text: 'Type', bold: true }], [{ text: file.type || `${ext(file.name).toUpperCase() || 'Unknown'} file` }]], [[{ text: 'Size', bold: true }], [{ text: fmtSize(bytes.length) }]], [[{ text: 'Modified', bold: true }], [{ text: file.lastModified ? new Date(file.lastModified).toLocaleString() : 'Unknown' }]]], size: 10 },
    para(why),
    para('The original file is attached inside this PDF. Open the Attachments panel (the paperclip in the sidebar) to save it.'),
  ];
  let pdf = await layoutDocument(blocks, { title: file.name });
  pdf = await ops.attachFile(pdf, { name: file.name, bytes, type: file.type || 'application/octet-stream', description: 'Original file' });
  return { bytes: pdf, how: 'attached', note: `${file.name} cannot be shown as pages, so it was attached to a cover page.` };
}

async function viaServer(file: File, server: { url: string; token?: string }): Promise<Uint8Array> {
  const res = await fetch(`${server.url}/convert`, { method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name), ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}) } });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sniff(bytes: Uint8Array): string | null {
  const b = bytes;
  const at = (s: string, o = 0) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (at('%PDF')) return 'pdf';
  if (b[0] === 0x89 && at('PNG', 1)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (at('GIF8')) return 'gif';
  if (at('RIFF') && at('WEBP', 8)) return 'webp';
  if (at('BM') && b.length > 26 && b[5] < 0x40) return 'bmp';
  if ((at('II*') && b[3] === 0) || (at('MM') && b[2] === 0 && b[3] === 42)) return 'tiff';
  if (at('ftyp', 4) && /heic|heix|hevc|mif1|msf1|heim|heis/.test(String.fromCharCode(...b.subarray(8, 12)))) return 'heic';
  if (at('ftyp', 4) && /avif|avis/.test(String.fromCharCode(...b.subarray(8, 12)))) return 'avif';
  if (at('{\\rtf')) return 'rtf';
  if (at('PK\x03\x04')) return 'zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'cfb';
  return null;
}

export async function convertToPdf(file: File, ctx: ConvertContext = {}): Promise<Converted> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let e = ext(file.name);
  const magic = sniff(bytes);
  // Trust the content over the extension for well-known signatures.
  if (magic && magic !== 'zip' && magic !== 'cfb') e = magic;
  const title = stem(file.name);
  const built = async (blocks: Block[], o: Parameters<typeof layoutDocument>[1] = {}, note?: string): Promise<Converted> => ({ bytes: await layoutDocument(blocks.length ? blocks : [para('(This file has no content.)', { italic: true })], { title, ...o }), how: 'builtin', note });

  try {
    if (e === 'pdf') return { bytes, how: 'pdf' };

    // Images
    if (IMG_NATIVE.has(e)) return { bytes: await ops.imagesToPdf([{ bytes, type: e === 'png' ? 'image/png' : 'image/jpeg' }]), how: 'image' };
    if (IMG_BROWSER.has(e)) return { bytes: await ops.imagesToPdf([{ bytes: (await browserImageToPng(bytes, MIME[e])).bytes, type: 'image/png' }]), how: 'image' };
    if (e === 'tif' || e === 'tiff') return { bytes: await ops.imagesToPdf((await tiffToPngs(bytes)).map((b) => ({ bytes: b, type: 'image/png' }))), how: 'image' };
    if (e === 'heic' || e === 'heif') return { bytes: await ops.imagesToPdf((await heicToJpeg(bytes)).map((b) => ({ bytes: b, type: 'image/jpeg' }))), how: 'image' };

    // Office formats go to the conversion server when there is one.
    if (ctx.server?.url && SERVER_FORMATS.has(e)) {
      try {
        return { bytes: await viaServer(file, ctx.server), how: 'server' };
      } catch {
        /* fall back to the built-in converters */
      }
    }
    const officeNote = 'Converted with the built-in converter, which keeps the content but simplifies the layout. For exact Office layout, set up the conversion server (Convert → Office → PDF).';

    if (e === 'docx' || e === 'docm' || e === 'dotx') {
      const mammoth = (await import('mammoth')) as unknown as { convertToHtml(i: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
      const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
      return built(await htmlToBlocks(parseHtml(value).body), { serif: true }, officeNote);
    }
    if (e === 'doc' || e === 'dot') return built(textBlocks(await legacyDocText(bytes)), { serif: true }, 'Old-style .doc files are converted as text only. For full layout, set up the conversion server.');
    if (e === 'rtf') return built(textBlocks(rtfToText(decodeText(bytes))), { serif: true });
    if (SHEETS.has(e)) return built(await sheetBlocks(bytes, file.name), { size: LANDSCAPE, margin: 36 });
    if (e === 'pptx' || e === 'ppsx' || e === 'potx') {
      const { pptxToPdf } = await import('./pptx');
      return { bytes: await pptxToPdf(bytes, title), how: 'builtin', note: officeNote };
    }
    if (e === 'odt' || e === 'ott') return built(await odfBlocks(await JSZip.loadAsync(bytes), 'odt'), { serif: true }, officeNote);
    if (e === 'odp') return built(await odfBlocks(await JSZip.loadAsync(bytes), 'odp'), { size: LANDSCAPE }, officeNote);
    if (e === 'epub') {
      const { blocks, title: t } = await epubBlocks(await JSZip.loadAsync(bytes));
      return built(blocks, { serif: true, title: t ?? title });
    }

    // Web, Markdown, email
    if (e === 'html' || e === 'htm' || e === 'xhtml' || e === 'mhtml' || e === 'mht') {
      if (e === 'mhtml' || e === 'mht') {
        const m = await emailBlocks(bytes);
        return built(m.blocks.slice(m.blocks.findIndex((b) => b.type === 'hr') + 1));
      }
      const d = parseHtml(decodeText(bytes));
      return built(await htmlToBlocks(d.body), { title: d.title || title });
    }
    if (e === 'md' || e === 'markdown' || e === 'mdown') {
      const { marked } = await import('marked');
      return built(await htmlToBlocks(parseHtml(await marked.parse(decodeText(bytes), { gfm: true })).body));
    }
    if (e === 'eml') {
      const m = await emailBlocks(bytes);
      let pdf = await layoutDocument(m.blocks, { title: m.title });
      for (const a of m.attachments.slice(0, 50)) if (a.bytes.length) pdf = await ops.attachFile(pdf, { name: a.name, bytes: a.bytes, type: a.type });
      return { bytes: pdf, how: 'builtin', note: m.attachments.length ? `The email's ${m.attachments.length} attachment${m.attachments.length > 1 ? 's are' : ' is'} in the Attachments panel.` : undefined };
    }

    // Archives: convert each file inside and combine.
    if (e === 'zip' || (magic === 'zip' && !e)) {
      if ((ctx.depth ?? 0) >= 2) return wrapAsAttachment(file, bytes, 'This archive is nested inside another archive.');
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files)
        .filter((f) => !f.dir && !/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\.)/.test(f.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, 300);
      if (!entries.length) return built([heading(file.name), para('This archive is empty.')]);
      const parts: { bytes: Uint8Array; type: string }[] = [];
      for (let i = 0; i < entries.length; i++) {
        ctx.progress?.(i / entries.length, `Converting ${entries[i].name}`);
        const f = new File([(await entries[i].async('uint8array')) as BlobPart], entries[i].name.split('/').pop()!);
        parts.push({ bytes: (await convertToPdf(f, { ...ctx, depth: (ctx.depth ?? 0) + 1, progress: undefined })).bytes, type: 'application/pdf' });
      }
      return { bytes: await ops.combine(parts), how: 'builtin', note: `Converted ${entries.length} file${entries.length > 1 ? 's' : ''} from ${file.name}.` };
    }

    // Text and code
    if (e === 'json') {
      let text = decodeText(bytes);
      try {
        if (text.length < 5_000_000) text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep as written */
      }
      return built([{ type: 'pre', text }]);
    }
    if (CODE.has(e) || CODE.has(file.name.toLowerCase())) return built([{ type: 'pre', text: decodeText(bytes) }]);
    if (TEXT.has(e)) return { bytes: await ops.textToPdf(decodeText(bytes)), how: 'builtin' };

    // Unknown extension: text if it reads as text, otherwise attach.
    if (!/^(audio|video)\//.test(file.type) && magic !== 'cfb' && magic !== 'zip' && looksLikeText(bytes)) {
      const text = decodeText(bytes);
      return /^\s*<(!doctype html|html)/i.test(text) ? built(await htmlToBlocks(parseHtml(text).body)) : built([{ type: 'pre', text }]);
    }
    const kind = /^audio\//.test(file.type) ? 'Audio cannot be shown as pages.' : /^video\//.test(file.type) ? 'Video cannot be shown as pages.' : SERVER_FORMATS.has(e) ? 'This format needs the conversion server to be shown as pages (Convert → Office → PDF).' : 'ANCHOR Tsunami has no page view for this file type.';
    return wrapAsAttachment(file, bytes, kind);
  } catch (err) {
    console.warn('convert failed', file.name, err);
    return wrapAsAttachment(file, bytes, `This file could not be read as ${e ? `a .${e} file` : 'a document'} (${(err as Error).message}).`);
  }
}

/** Convert several files and join them in order. */
export async function convertManyToPdf(files: File[], ctx: ConvertContext = {}): Promise<{ bytes: Uint8Array; notes: string[]; name: string }> {
  const notes = new Set<string>();
  const parts: { bytes: Uint8Array; type: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    ctx.progress?.(i / files.length, `Converting ${files[i].name}`);
    const r = await convertToPdf(files[i], { ...ctx, progress: files.length === 1 ? ctx.progress : undefined });
    if (r.note) notes.add(r.note);
    parts.push({ bytes: r.bytes, type: 'application/pdf' });
  }
  return { bytes: parts.length === 1 ? parts[0].bytes : await ops.combine(parts), notes: [...notes], name: files.length === 1 ? `${stem(files[0].name)}.pdf` : `${stem(files[0].name)} and ${files.length - 1} more.pdf` };
}
