/**
 * PDF to Word (.docx).
 *
 * Two layouts:
 * - "flow": text becomes normal Word paragraphs with fonts, sizes, bold/italic, alignment, indents
 *   and spacing; rows of aligned columns become Word tables; images are placed inline where they
 *   appear. Best for editing.
 * - "exact": every paragraph and image is placed at its position on the page (positioned frames and
 *   anchored pictures), so the Word document looks like the PDF while the text stays editable.
 */
import JSZip from 'jszip';
import { pdfjsLib, getTextRuns, type PDFDocumentProxy } from './pdfjs';
import { toLines, type Line } from './paragraph';
import type { Rect, TextRun } from './types';

type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
type Progress = (p: number, label?: string) => void;
export type DocxLayout = 'flow' | 'exact';

const TW = 20; // twips per point
const EMU = 12700; // EMU per point
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

interface FontInfo {
  family: string;
  bold: boolean;
  italic: boolean;
}
const KNOWN: [RegExp, string][] = [
  [/^times ?new ?roman/i, 'Times New Roman'],
  [/^times/i, 'Times New Roman'],
  [/^helvetica|^arial ?mt|^arial$/i, 'Arial'],
  [/^arial ?narrow/i, 'Arial Narrow'],
  [/^courier ?new|^courier/i, 'Courier New'],
  [/^symbol/i, 'Symbol'],
  [/^zapf ?dingbats/i, 'Wingdings'],
];
export function fontInfo(run: Pick<TextRun, 'fontName' | 'family'>): FontInfo {
  const raw = (run.fontName ?? '').replace(/^[A-Z]{6}\+/, '');
  const lower = raw.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(lower);
  const italic = /italic|oblique|-it$|-ita?$/.test(lower);
  let base = raw.split(/[-,]/)[0].replace(/(PS)?MT$|PS$|Std$|LT$/g, '');
  if (!base) base = run.family === 'serif' ? 'Times New Roman' : run.family === 'monospace' ? 'Courier New' : 'Arial';
  for (const [re, name] of KNOWN) if (re.test(base)) return { family: name, bold, italic };
  // "SourceSansPro" -> "Source Sans Pro"
  const family = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  return { family, bold, italic };
}

// ---------------------------------------------------------------------------------------------
// Page analysis
// ---------------------------------------------------------------------------------------------

interface Para {
  lines: Line[];
  align: 'left' | 'center' | 'right' | 'both';
  rect: Rect; // union of the lines
  spacing: number; // baseline-to-baseline, points
}
interface Table {
  rows: Line[][]; // cells per row
  cols: number[]; // left edge of each column
  rect: Rect;
}
interface Img {
  rect: Rect;
  png: Uint8Array;
}
type Block = { kind: 'p'; p: Para; top: number } | { kind: 't'; t: Table; top: number } | { kind: 'img'; img: Img; top: number };

const top = (l: Line) => l.rect.y + l.rect.h;
const endsSentence = (s: string) => /[.!?:]["')\]]?$/.test(s.trim());

/** Rows of two or more aligned cells become tables. */
function findTables(lines: Line[]): { tables: Table[]; rest: Line[] } {
  const rows = new Map<number, Line[]>();
  for (const l of lines) {
    const key = [...rows.keys()].find((k) => Math.abs(k - l.baseline) < l.size * 0.35);
    if (key === undefined) rows.set(l.baseline, [l]);
    else rows.get(key)!.push(l);
  }
  const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, ls]) => ls.sort((a, b) => a.x - b.x));
  const tables: Table[] = [];
  const used = new Set<Line>();
  let i = 0;
  while (i < ordered.length) {
    if (ordered[i].length < 2) {
      i++;
      continue;
    }
    // Grow a run of multi-cell rows whose cells line up with the first row's columns.
    const cols = ordered[i].map((c) => c.x);
    const group = [ordered[i]];
    let j = i + 1;
    while (j < ordered.length) {
      const r = ordered[j];
      const prev = group[group.length - 1];
      const gap = prev[0].baseline - r[0].baseline;
      if (gap > Math.max(...prev.map((c) => c.size)) * 3) break;
      const aligned = r.length >= 2 && r.every((c) => cols.some((x) => Math.abs(x - c.x) < c.size * 1.5 || (c.x > x && c.x < x + c.size * 6)));
      if (!aligned) break;
      // New columns that start beyond the known ones extend the table.
      for (const c of r) if (!cols.some((x) => Math.abs(x - c.x) < c.size * 1.5)) cols.push(c.x);
      group.push(r);
      j++;
    }
    if (group.length >= 2) {
      cols.sort((a, b) => a - b);
      const all = group.flat();
      all.forEach((l) => used.add(l));
      const x = Math.min(...all.map((l) => l.x));
      const right = Math.max(...all.map((l) => l.right));
      const y = Math.min(...all.map((l) => l.rect.y));
      const t = Math.max(...all.map(top));
      tables.push({ rows: group, cols, rect: { x, y, w: right - x, h: t - y } });
      i = j;
    } else i++;
  }
  return { tables, rest: lines.filter((l) => !used.has(l)) };
}

/** Split lines into paragraphs. */
function findParagraphs(lines: Line[]): Para[] {
  const sorted = [...lines].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  const paras: Line[][] = [];
  for (const l of sorted) {
    // Find an open paragraph in the same column that this line continues.
    let target: Line[] | undefined;
    for (let k = paras.length - 1; k >= Math.max(0, paras.length - 4); k--) {
      const p = paras[k];
      const last = p[p.length - 1];
      const gap = last.baseline - l.baseline;
      if (gap <= 0) continue;
      const sameCol = l.x < last.right + last.size && l.right > last.x - last.size;
      if (!sameCol) continue;
      const sameSize = Math.abs(l.size - last.size) <= last.size * 0.12;
      const sameWeight = /bold/i.test(l.fontName ?? '') === /bold/i.test(last.fontName ?? '');
      const spacing = p.length > 1 ? p[p.length - 2].baseline - last.baseline : null;
      const okGap = gap <= last.size * 1.9 && (spacing === null || Math.abs(gap - spacing) <= spacing * 0.2);
      const maxRight = Math.max(...p.map((x) => x.right));
      const prevEnded = endsSentence(last.str) && last.right < maxRight - last.size * 4 && p.length > 1;
      if (sameSize && sameWeight && okGap && !prevEnded) target = p;
      break;
    }
    if (target) target.push(l);
    else paras.push([l]);
  }
  return paras.map((ls) => {
    const x = Math.min(...ls.map((l) => l.x));
    const right = Math.max(...ls.map((l) => l.right));
    const y = Math.min(...ls.map((l) => l.rect.y));
    const t = Math.max(...ls.map(top));
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const size = ls[0].size;
    let align: Para['align'] = 'left';
    if (ls.length > 1) {
      const body = ls.slice(0, -1);
      if (spread(ls.map((l) => l.x)) > size && spread(ls.map((l) => (l.x + l.right) / 2)) < size * 0.6) align = 'center';
      else if (spread(ls.map((l) => l.x)) > size && spread(ls.map((l) => l.right)) < size * 0.6) align = 'right';
      else if (body.length > 1 && spread(body.map((l) => l.right)) < size * 0.4 && spread(body.map((l) => l.x)) < size * 0.4) align = 'both';
    }
    const spacing = ls.length > 1 ? (ls[0].baseline - ls[ls.length - 1].baseline) / (ls.length - 1) : size * 1.2;
    return { lines: ls, align, rect: { x, y, w: right - x, h: t - y }, spacing };
  });
}

/** Images painted on the page, with their position, as PNG. */
async function scanPage(page: PDFPageProxy): Promise<{ images: Img[]; texts: { text: string; color: string }[] }> {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const out: Img[] = [];
  const texts: { text: string; color: string }[] = [];
  const stack: number[][] = [];
  const colorStack: string[] = [];
  let fill = '000000';
  const hex = (a: ArrayLike<number>) => Array.from(a).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) {
      stack.push(m);
      colorStack.push(fill);
    } else if (fn === OPS.restore) {
      m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      fill = colorStack.pop() ?? fill;
    } else if (fn === OPS.setFillRGBColor) fill = typeof args[0] === 'string' ? (args[0] as string).replace('#', '').toUpperCase() : hex(args as unknown as ArrayLike<number>);
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const glyphs = (args[0] ?? []) as ({ unicode?: string } | number | null)[];
      const text = glyphs.map((g) => (g && typeof g === 'object' ? (g.unicode ?? '') : '')).join('');
      if (text.trim()) texts.push({ text: text.replace(/\s+/g, ''), color: fill });
    }
    else if (fn === OPS.transform) m = mul(args as number[], m);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(m);
      if (Array.isArray(args[0]) && (args[0] as number[]).length === 6) m = mul(args[0] as number[], m);
    } else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() ?? m;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (rect.w < 4 || rect.h < 4) continue;
      try {
        const img = fn === OPS.paintInlineImageXObject ? args[0] : await getObj(page, args[0] as string);
        const png = await imageToPng(img as ImgData, m[3] < 0);
        if (png) out.push({ rect, png });
      } catch {
        /* image could not be decoded */
      }
    }
  }
  return { images: out, texts };
}
interface ImgData {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8ClampedArray | Uint8Array;
  kind?: number;
}
function getObj(page: PDFPageProxy, id: string) {
  const store = (id.startsWith('g_') ? page.commonObjs : page.objs) as unknown as { get(id: string, cb: (v: unknown) => void): void };
  return new Promise<unknown>((resolve) => store.get(id, resolve));
}
async function imageToPng(img: ImgData, flipY: boolean): Promise<Uint8Array | null> {
  if (!img?.width || !img?.height) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  if (flipY) {
    g.translate(0, c.height);
    g.scale(1, -1);
  }
  if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const n = img.width * img.height;
    const rgba = new Uint8ClampedArray(n * 4);
    const d = img.data;
    if (d.length === n * 4) rgba.set(d);
    else if (d.length === n * 3)
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        rgba[i * 4] = d[j];
        rgba[i * 4 + 1] = d[j + 1];
        rgba[i * 4 + 2] = d[j + 2];
        rgba[i * 4 + 3] = 255;
      }
    else {
      // 1 bit per pixel, rows padded to whole bytes
      const stride = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const bit = (d[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const k = (y * img.width + x) * 4;
          rgba[k] = rgba[k + 1] = rgba[k + 2] = v;
          rgba[k + 3] = 255;
        }
    }
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    tmp.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
    g.drawImage(tmp, 0, 0);
  } else return null;
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Give text runs the fill colour of the drawing operation that painted them. */
function colourRuns(runs: TextRun[], texts: { text: string; color: string }[]) {
  let k = 0;
  for (const r of runs) {
    const key = r.str.replace(/\s+/g, '').slice(0, 8);
    if (!key) continue;
    for (let j = k; j < Math.min(texts.length, k + 40); j++) {
      if (texts[j].text.includes(key)) {
        r.color = texts[j].color;
        k = j;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// XML writers
// ---------------------------------------------------------------------------------------------

function runsXml(lines: Line[], opts: { exactBreaks?: boolean } = {}) {
  const out: string[] = [];
  let prev: { key: string; text: string; rPr: string } | null = null;
  const flush = () => {
    if (prev) out.push(`<w:r>${prev.rPr}<w:t xml:space="preserve">${esc(prev.text)}</w:t></w:r>`);
    prev = null;
  };
  lines.forEach((l, li) => {
    let lastRight = -Infinity;
    l.runs.forEach((r, ri) => {
      const f = fontInfo(r);
      const sz = Math.round(r.fontSize * 2);
      const col = r.color && r.color !== '000000' ? r.color : '';
      const key = `${f.family}|${f.bold}|${f.italic}|${sz}|${col}`;
      const rPr = `<w:rPr><w:rFonts w:ascii="${esc(f.family)}" w:hAnsi="${esc(f.family)}" w:cs="${esc(f.family)}" w:eastAsia="${esc(f.family)}"/>${f.bold ? '<w:b/>' : ''}${f.italic ? '<w:i/>' : ''}${col ? `<w:color w:val="${col}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
      let text = r.str;
      if (ri > 0 && r.rect.x - lastRight > r.fontSize * 0.15 && !text.startsWith(' ')) text = ' ' + text;
      if (ri === 0 && li > 0 && !opts.exactBreaks) {
        // Join wrapped lines: drop end-of-line hyphens, otherwise add a space.
        const p = prev as { text: string } | null;
        if (p && /[A-Za-z]-$/.test(p.text) && /^[a-z]/.test(text)) p.text = p.text.slice(0, -1);
        else if (p && !p.text.endsWith(' ')) text = ' ' + text.trimStart();
      }
      lastRight = Math.max(lastRight, r.rect.x + r.rect.w);
      if (prev && prev.key === key) prev.text += text;
      else {
        flush();
        prev = { key, text, rPr };
      }
    });
    if (opts.exactBreaks && li < lines.length - 1) {
      flush();
      out.push('<w:r><w:br/></w:r>');
    }
  });
  flush();
  return out.join('');
}

function paraXml(p: Para, o: { marginLeft: number; contentW: number; before: number; frame?: { x: number; y: number; w: number; h: number } }) {
  const size = p.lines[0].size;
  const lineTw = Math.round(p.spacing * TW);
  const ind = o.frame ? '' : (() => {
    const left = Math.max(0, p.rect.x - o.marginLeft);
    const first = p.lines.length > 1 ? p.lines[0].x - p.lines[1].x : 0;
    if (p.align === 'center' || p.align === 'right') return '';
    return `<w:ind w:left="${Math.round(left * TW)}"${first > size * 0.5 ? ` w:firstLine="${Math.round(first * TW)}"` : first < -size * 0.5 ? ` w:hanging="${Math.round(-first * TW)}"` : ''}/>`;
  })();
  const frame = o.frame
    ? `<w:framePr w:w="${Math.round(o.frame.w * TW)}" w:h="${Math.round(o.frame.h * TW)}" w:hRule="atLeast" w:hSpace="0" w:vSpace="0" w:wrap="around" w:hAnchor="page" w:vAnchor="page" w:x="${Math.round(o.frame.x * TW)}" w:y="${Math.round(o.frame.y * TW)}"/>`
    : '';
  const spacing = `<w:spacing w:before="${Math.round(Math.max(0, o.before) * TW)}" w:after="0" w:line="${lineTw}" w:lineRule="exact"/>`;
  const jc = p.align === 'left' ? '' : `<w:jc w:val="${p.align}"/>`;
  return `<w:p><w:pPr>${frame}${spacing}${ind}${jc}</w:pPr>${runsXml(p.lines, { exactBreaks: !!o.frame })}</w:p>`;
}

function tableXml(t: Table, marginLeft: number, before: number) {
  const widths = t.cols.map((x, i) => (i < t.cols.length - 1 ? t.cols[i + 1] - x : t.rect.x + t.rect.w - x + 6));
  const grid = widths.map((w) => `<w:gridCol w:w="${Math.round(w * TW)}"/>`).join('');
  const rows = t.rows
    .map((cells, ri) => {
      const tcs = t.cols
        .map((x, ci) => {
          const next = t.cols[ci + 1] ?? Infinity;
          const inCell = cells.filter((c) => c.x >= x - c.size * 1.5 && c.x < next - c.size * 1.5);
          const spacing = ri === 0 && before > 0 ? `<w:spacing w:before="${Math.round(before * TW)}" w:after="0"/>` : '<w:spacing w:before="0" w:after="0"/>';
          return `<w:tc><w:tcPr><w:tcW w:w="${Math.round(widths[ci] * TW)}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>${spacing}</w:pPr>${inCell.length ? runsXml(inCell, { exactBreaks: true }) : ''}</w:p></w:tc>`;
        })
        .join('');
      const next = t.rows[ri + 1] ?? t.rows[ri - 1];
      const pitch = next ? Math.abs(cells[0].baseline - next[0].baseline) : cells[0].size * 1.4;
      return `<w:tr><w:trPr><w:trHeight w:val="${Math.round(pitch * TW)}" w:hRule="atLeast"/></w:trPr>${tcs}</w:tr>`;
    })
    .join('');
  // The PDF's own rules are drawings we do not detect, so the table has no borders of its own.
  const b = '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>';
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblInd w:w="${Math.round(Math.max(0, t.rect.x - marginLeft) * TW)}" w:type="dxa"/><w:tblBorders>${b}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="40" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

let picId = 1;
function drawingXml(rid: string, w: number, h: number, anchor?: { x: number; y: number }) {
  const id = picId++;
  const cx = Math.round(w * EMU);
  const cy = Math.round(h * EMU);
  const graphic = `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Image ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  if (!anchor)
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Image ${id}"/>${graphic}</wp:inline></w:drawing></w:r>`;
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(anchor.x * EMU)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(anchor.y * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Image ${id}"/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export async function buildDocx(doc: PDFDocumentProxy, layout: DocxLayout, progress?: Progress): Promise<Blob> {
  picId = 1;
  const body: string[] = [];
  const media: { name: string; data: Uint8Array; rid: string }[] = [];
  // Margins from the text extent of the first few pages.
  let minX = Infinity;
  let maxR = 0;
  let maxTop = 0;
  let minY = Infinity;
  const pages: { lines: Line[]; images: Img[]; w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    // Loading the operator list makes font names and images available.
    const { images, texts } = await scanPage(page);
    const runs = await getTextRuns(page);
    colourRuns(runs, texts);
    const lines = toLines(runs);
    // getTextRuns works in PDF user space; shift for a non-zero page origin.
    const [ox, oy] = [page.view[0], page.view[1]];
    if (ox || oy) {
      for (const l of lines) {
        l.x -= ox;
        l.right -= ox;
        l.baseline -= oy;
        l.rect = { ...l.rect, x: l.rect.x - ox, y: l.rect.y - oy };
        l.runs = l.runs.map((r) => ({ ...r, rect: { ...r.rect, x: r.rect.x - ox, y: r.rect.y - oy } }));
      }
      for (const im of images) im.rect = { ...im.rect, x: im.rect.x - ox, y: im.rect.y - oy };
    }
    pages.push({ lines, images, w: vp.width, h: vp.height });
    for (const l of lines) {
      minX = Math.min(minX, l.x);
      maxR = Math.max(maxR, l.right);
      maxTop = Math.max(maxTop, top(l));
      minY = Math.min(minY, l.rect.y);
    }
    progress?.((i / doc.numPages) * 0.8, `Reading page ${i}`);
  }
  const W = pages[0]?.w ?? 612;
  const H = pages[0]?.h ?? 792;
  const marginL = Number.isFinite(minX) ? Math.max(18, Math.min(minX, 108)) : 72;
  const marginR = Math.max(18, Math.min(W - maxR, 108));
  const marginT = Math.max(18, Math.min(H - maxTop, 108));
  const marginB = Math.max(18, Math.min(Number.isFinite(minY) ? minY : 72, 108));
  const contentW = W - marginL - marginR;

  const addImage = (png: Uint8Array) => {
    const n = media.length + 1;
    const rid = `rIdImg${n}`;
    media.push({ name: `image${n}.png`, data: png, rid });
    return rid;
  };

  pages.forEach((pg, pi) => {
    const sect = `<w:sectPr><w:pgSz w:w="${Math.round(pg.w * TW)}" w:h="${Math.round(pg.h * TW)}"${pg.w > pg.h ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${Math.round(marginT * TW)}" w:right="${Math.round(marginR * TW)}" w:bottom="${Math.round(marginB * TW)}" w:left="${Math.round(marginL * TW)}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;
    const last = pi === pages.length - 1;
    if (layout === 'exact') {
      const parts: string[] = [];
      // Images first, anchored behind the text.
      const anchors = pg.images.map((im) => drawingXml(addImage(im.png), im.rect.w, im.rect.h, { x: im.rect.x, y: pg.h - im.rect.y - im.rect.h })).join('');
      if (anchors) parts.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${anchors}</w:p>`);
      for (const p of findParagraphs(pg.lines)) {
        const size = p.lines[0].size;
        const firstTop = p.lines[0].baseline + size * 0.8;
        // Frames are as wide as the text plus slack, so lines break where the PDF breaks them.
        const frame = { x: p.rect.x - 1, y: pg.h - firstTop, w: p.rect.w + size * 1.5 + 4, h: p.rect.h };
        if (p.align === 'center') frame.x -= (size * 1.5 + 4) / 2;
        if (p.align === 'right') frame.x -= size * 1.5 + 4;
        parts.push(paraXml({ ...p, align: p.align === 'both' ? 'left' : p.align }, { marginLeft: marginL, contentW, before: 0, frame }));
      }
      body.push(...parts);
      // A section per page keeps each page's frames on that page.
      if (!last) body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sect.replace('<w:sectPr>', '<w:sectPr><w:type w:val="nextPage"/>')}</w:pPr></w:p>`);
      else body.push(sect);
      return;
    }

    // Flowing layout: blocks top to bottom.
    const { tables, rest } = findTables(pg.lines);
    const blocks: Block[] = [
      ...findParagraphs(rest).map((p) => ({ kind: 'p' as const, p, top: p.rect.y + p.rect.h })),
      ...tables.map((t) => ({ kind: 't' as const, t, top: t.rect.y + t.rect.h })),
      ...pg.images.map((img) => ({ kind: 'img' as const, img, top: img.rect.y + img.rect.h })),
    ].sort((a, b) => b.top - a.top);
    let prevBottom = pg.h - marginT;
    for (const b of blocks) {
      const before = Math.min(prevBottom - b.top, 72);
      if (b.kind === 'p') {
        body.push(paraXml(b.p, { marginLeft: marginL, contentW, before: Math.max(0, before - (b.p.spacing - b.p.lines[0].size)) }));
        prevBottom = b.p.lines[b.p.lines.length - 1].baseline - b.p.lines[0].size * 0.25;
      } else if (b.kind === 't') {
        body.push(tableXml(b.t, marginL, Math.max(0, before)));
        prevBottom = b.t.rect.y;
      } else {
        const w = Math.min(b.img.rect.w, contentW);
        const h = b.img.rect.h * (w / b.img.rect.w);
        const center = Math.abs(b.img.rect.x + b.img.rect.w / 2 - W / 2) < 24;
        const ind = center ? '<w:jc w:val="center"/>' : `<w:ind w:left="${Math.round(Math.max(0, b.img.rect.x - marginL) * TW)}"/>`;
        body.push(`<w:p><w:pPr><w:spacing w:before="${Math.round(Math.max(0, before) * TW)}" w:after="0"/>${ind}</w:pPr>${drawingXml(addImage(b.img.png), w, h)}</w:p>`);
        prevBottom = b.img.rect.y;
      }
    }
    if (!last) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else body.push(sect);
  });
  progress?.(0.9, 'Writing Word file');

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>ANCHOR Tsunami</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`,
  );
  for (const m of media) zip.file(`word/media/${m.name}`, m.data);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
