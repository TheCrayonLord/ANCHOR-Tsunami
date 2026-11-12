/** pdf.js setup plus rendering and text helpers that need a browser. */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rect, TextRun } from './types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy };

const base = import.meta.env.BASE_URL;
export const DOC_OPTIONS = {
  cMapUrl: `${base}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  isEvalSupported: false,
  enableXfa: true,
};

/** Open a document; asks for a password through `askPassword` when needed. */
export async function openDocument(bytes: Uint8Array, askPassword: (retry: boolean) => Promise<string | null>) {
  const task = pdfjsLib.getDocument({ ...DOC_OPTIONS, data: bytes.slice() });
  let password: string | undefined;
  task.onPassword = async (update: (pw: string) => void, reason: number) => {
    const pw = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) {
      task.destroy();
      return;
    }
    password = pw;
    update(pw);
  };
  const doc = await task.promise;
  return { doc, password };
}

export async function loadPlain(bytes: Uint8Array, password?: string) {
  return pdfjsLib.getDocument({ ...DOC_OPTIONS, data: bytes.slice(), password }).promise;
}

/** Render a page into a canvas. `rotation` overrides the page's own rotation when given. */
export async function renderPage(page: PDFPageProxy, scale: number, opts: { rotation?: number; forms?: boolean; background?: string } = {}) {
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? page.rotate });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = opts.background ?? '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: opts.forms ? pdfjsLib.AnnotationMode.ENABLE_STORAGE : pdfjsLib.AnnotationMode.ENABLE,
  }).promise;
  return { canvas, viewport };
}

export function canvasToBytes(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.9): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Could not encode image'))),
      type,
      quality,
    ),
  );
}

function realFontName(page: PDFPageProxy, id: string): string | undefined {
  try {
    // Available once the page has been rendered; gives names like "ABCDEF+Helvetica-Bold".
    const objs = page.commonObjs as unknown as { has(id: string): boolean; get(id: string): { name?: string } };
    return objs.has(id) ? objs.get(id)?.name : undefined;
  } catch {
    return undefined;
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;
/**
 * Left edge of every character in a run (plus the right edge), in user-space units from the
 * run's start. Character widths are measured with a similar font and scaled to the run's width.
 */
export function charEdges(r: TextRun): number[] {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const n = r.str.length;
  const edges: number[] = [0];
  if (!measureCtx || n === 0) {
    for (let i = 1; i <= n; i++) edges.push((r.rect.w * i) / Math.max(1, n));
    return edges;
  }
  const fam = r.family || 'sans-serif';
  const name = (r.fontName ?? '').toLowerCase();
  measureCtx.font = `${/bold|black|heavy/.test(name) ? 'bold ' : ''}${/italic|oblique/.test(name) ? 'italic ' : ''}100px ${fam}`;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += measureCtx.measureText(r.str[i]).width;
    edges.push(acc);
  }
  const k = acc > 0 ? r.rect.w / acc : 0;
  return edges.map((e) => e * k);
}

/** Text runs on a page with rectangles in PDF user space. */
export async function getTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const tc = await page.getTextContent();
  const out: TextRun[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str) continue;
    const [a, b, , , e, f] = it.transform as number[];
    const fontSize = Math.hypot(a, b);
    const h = it.height || fontSize;
    out.push({
      str: it.str,
      rect: { x: e, y: f - h * 0.22, w: it.width, h: h * 1.18 },
      fontSize,
      fontName: realFontName(page, it.fontName) ?? (tc.styles as Record<string, { fontFamily?: string }>)[it.fontName]?.fontFamily,
      family: (tc.styles as Record<string, { fontFamily?: string }>)[it.fontName]?.fontFamily,
    });
  }
  return out;
}

export async function pageText(page: PDFPageProxy) {
  const tc = await page.getTextContent();
  let s = '';
  let lastY: number | null = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const y = (it.transform as number[])[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) s += '\n';
    else if (s && !s.endsWith(' ') && it.str && !it.str.startsWith(' ')) s += it.hasEOL ? '\n' : '';
    s += it.str;
    if (it.hasEOL) s += '\n';
    lastY = y;
  }
  return s.replace(/\n{3,}/g, '\n\n');
}

/** Lines of text on a page, top to bottom, for export. */
export async function pageLines(page: PDFPageProxy) {
  const tc = await page.getTextContent();
  const rows: { y: number; parts: { x: number; s: string; size: number }[] }[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const t = it.transform as number[];
    const y = t[5];
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, Math.hypot(t[0], t[1]) * 0.4));
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x: t[4], s: it.str, size: Math.hypot(t[0], t[1]) });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    return { y: r.y, text: r.parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim(), size: Math.max(...r.parts.map((p) => p.size)) };
  });
}

export async function documentText(doc: PDFDocumentProxy, onProgress?: (p: number) => void) {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    pages.push(await pageText(await doc.getPage(i)));
    onProgress?.(i / doc.numPages);
  }
  return pages;
}

export interface TextMatch {
  page: number; // 0-based
  rects: Rect[];
  context: string;
}

/** Find text and return match rectangles in user space (approximated per character). */
export async function findText(doc: PDFDocumentProxy, query: string, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}) {
  const out: TextMatch[] = [];
  if (!query) return out;
  let re: RegExp;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `\\b${src}\\b` : src, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return out;
  }
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const runs = await getTextRuns(page);
    // Concatenate runs; map each character back to its run.
    let full = '';
    const map: { run: number; ch: number }[] = [];
    runs.forEach((r, ri) => {
      for (let c = 0; c < r.str.length; c++) {
        full += r.str[c];
        map.push({ run: ri, ch: c });
      }
      full += ' ';
      map.push({ run: -1, ch: 0 });
    });
    for (const m of full.matchAll(re)) {
      if (!m[0]) continue;
      const start = m.index!;
      const end = start + m[0].length;
      const byRun = new Map<number, [number, number]>();
      for (let k = start; k < end; k++) {
        const { run, ch } = map[k];
        if (run < 0) continue;
        const cur = byRun.get(run);
        byRun.set(run, cur ? [cur[0], ch + 1] : [ch, ch + 1]);
      }
      const rects: Rect[] = [];
      for (const [ri, [a, b]] of byRun) {
        const r = runs[ri];
        const xs = charEdges(r);
        rects.push({ x: r.rect.x + xs[a], y: r.rect.y, w: xs[b] - xs[a], h: r.rect.h });
      }
      out.push({ page: p - 1, rects, context: full.slice(Math.max(0, start - 30), end + 30).trim() });
    }
  }
  return out;
}

/** Regular-expression patterns for "find sensitive data" redaction. */
export const PII_PATTERNS: Record<string, string> = {
  'Email addresses': '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
  'Phone numbers': '(\\+?\\d{1,2}[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}',
  'US Social Security numbers': '\\b\\d{3}-\\d{2}-\\d{4}\\b',
  'Credit card numbers': '\\b(?:\\d[ -]?){13,16}\\b',
  Dates: '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b',
};

// Unicode fonts for text the engine adds are served with the app and fetched on first use.
import { setFontLoader } from './typeset';
setFontLoader(async (file) => {
  const res = await fetch(`${base}fonts/${file}`);
  if (!res.ok) throw new Error(`Could not load font ${file}`);
  return new Uint8Array(await res.arrayBuffer());
});
