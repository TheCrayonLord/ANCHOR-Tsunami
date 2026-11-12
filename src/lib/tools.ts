/** Browser-side document tools that combine pdf.js rendering with pdf-lib writing. */
import JSZip from 'jszip';
import * as ops from './ops';
import { canvasToBytes, documentText, loadPlain, pageLines, renderPage, type PDFDocumentProxy } from './pdfjs';
import type { OverlayItem, Rect } from './types';

export function download(data: Uint8Array | Blob | string, name: string, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '') || 'document';
}

export function readFile(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Print through a hidden frame, using the browser's own PDF printing. */
export function printPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank');
    }
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  };
  document.body.appendChild(frame);
}

type Progress = (fraction: number, label?: string) => void;

/**
 * Apply redaction marks for real: each affected page is rendered, the marked areas are painted
 * over, and the page is replaced by that image. Text outside the marks is kept searchable.
 */
export async function applyRedactions(bytes: Uint8Array, marks: OverlayItem[], opts: { fill?: string; stripMetadata?: boolean; dpi?: number } = {}, progress?: Progress) {
  const doc = await loadPlain(bytes);
  const byPage = new Map<number, Rect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const rasters: ops.PageRaster[] = [];
  let k = 0;
  for (const [p, rects] of byPage) {
    const page = await doc.getPage(p + 1);
    const scale = (opts.dpi ?? 200) / 72;
    const { canvas, viewport } = await renderPage(page, scale, { rotation: 0 });
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = opts.fill ?? '#000000';
    for (const r of rects) {
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
      ctx.fillRect(Math.min(x1, x2) - 1, Math.min(y1, y2) - 1, Math.abs(x2 - x1) + 2, Math.abs(y2 - y1) + 2);
    }
    // Keep text that is fully outside every mark searchable.
    const tc = await page.getTextContent();
    const keep: { str: string; rect: Rect }[] = [];
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const t = it.transform as number[];
      const h = it.height || Math.hypot(t[0], t[1]);
      const rr = { x: t[4], y: t[5] - h * 0.2, w: it.width, h: h * 1.2 };
      if (!rects.some((m) => overlaps(m, rr))) keep.push({ str: it.str, rect: rr });
    }
    rasters.push({ page: p, jpeg: await canvasToBytes(canvas, 'image/jpeg', 0.92), invisibleText: keep });
    progress?.(++k / byPage.size, `Redacting page ${p + 1}`);
  }
  await doc.destroy();
  return ops.replaceWithRasters(bytes, rasters, { stripMetadata: opts.stripMetadata });
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Strong compression: re-render every page as a JPEG at the given resolution. */
export async function compressByRaster(bytes: Uint8Array, dpi: number, quality: number, progress?: Progress) {
  const doc = await loadPlain(bytes);
  const rasters: ops.PageRaster[] = [];
  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    const { canvas } = await renderPage(page, dpi / 72, { rotation: 0 });
    const tc = await page.getTextContent();
    const text: { str: string; rect: Rect }[] = [];
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const t = it.transform as number[];
      const h = it.height || Math.hypot(t[0], t[1]);
      text.push({ str: it.str, rect: { x: t[4], y: t[5] - h * 0.2, w: it.width, h: h * 1.2 } });
    }
    rasters.push({ page: p, jpeg: await canvasToBytes(canvas, 'image/jpeg', quality), invisibleText: text });
    progress?.((p + 1) / doc.numPages, `Compressing page ${p + 1} of ${doc.numPages}`);
  }
  await doc.destroy();
  return ops.replaceWithRasters(bytes, rasters);
}

/** Recognise text on scanned pages and add an invisible, selectable text layer. */
export async function runOcr(bytes: Uint8Array, pages: number[], lang: string, progress?: Progress) {
  const { createWorker } = await import('tesseract.js');
  const doc = await loadPlain(bytes);
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  // The engine and English data ship with the app (works offline); other languages download on first use.
  const worker = await createWorker(lang, 1, {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract/`,
    langPath: lang === 'eng' ? `${base}tesseract/lang` : 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/' + lang + '/4.0.0_best_int',
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status !== 'recognizing text') progress?.(0, `OCR: ${m.status}`);
    },
  });
  const result: { page: number; words: { str: string; rect: Rect }[] }[] = [];
  try {
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      progress?.(k / pages.length, `Reading page ${p + 1} (${k + 1} of ${pages.length})`);
      const page = await doc.getPage(p + 1);
      const { canvas, viewport } = await renderPage(page, 300 / 72);
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const words: { str: string; rect: Rect }[] = [];
      for (const block of data.blocks ?? [])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const w of line.words) {
              if (w.confidence < 30 || !w.text.trim()) continue;
              const [x1, y1] = viewport.convertToPdfPoint(w.bbox.x0, w.bbox.y1);
              const [x2, y2] = viewport.convertToPdfPoint(w.bbox.x1, w.bbox.y0);
              words.push({ str: w.text, rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) } });
            }
      result.push({ page: p, words });
    }
  } finally {
    await worker.terminate();
    await doc.destroy();
  }
  progress?.(1, 'Adding text layer');
  return ops.addTextLayer(bytes, result);
}

export async function exportImages(doc: PDFDocumentProxy, name: string, format: 'png' | 'jpeg', dpi: number, pages: number[], progress?: Progress) {
  const type = `image/${format}`;
  const ext = format === 'png' ? 'png' : 'jpg';
  if (pages.length === 1) {
    const { canvas } = await renderPage(await doc.getPage(pages[0] + 1), dpi / 72, { forms: true });
    download(await canvasToBytes(canvas, type, 0.92), `${name}-page${pages[0] + 1}.${ext}`, type);
    return;
  }
  const zip = new JSZip();
  for (let k = 0; k < pages.length; k++) {
    const { canvas } = await renderPage(await doc.getPage(pages[k] + 1), dpi / 72, { forms: true });
    zip.file(`${name}-page${String(pages[k] + 1).padStart(3, '0')}.${ext}`, await canvasToBytes(canvas, type, 0.92));
    progress?.((k + 1) / pages.length, `Rendering page ${pages[k] + 1}`);
  }
  download(await zip.generateAsync({ type: 'blob' }), `${name}-images.zip`, 'application/zip');
}

export async function exportText(doc: PDFDocumentProxy, name: string) {
  const pages = await documentText(doc);
  download(pages.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n'), `${name}.txt`, 'text/plain');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Export to a Word document, keeping paragraphs, headings (by font size) and page breaks. */
export async function exportDocx(doc: PDFDocumentProxy, name: string, progress?: Progress, layout: 'flow' | 'exact' = 'flow') {
  const { buildDocx } = await import('./docx');
  download(await buildDocx(doc, layout, progress), `${name}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/** Export to a self-contained HTML page: page images with selectable text on top. */
export async function exportHtml(doc: PDFDocumentProxy, name: string, progress?: Progress) {
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const lines = await pageLines(await doc.getPage(i));
    parts.push(`<section class="page"><h2 class="pn">Page ${i}</h2>${lines.map((l) => `<p style="font-size:${Math.round(l.size)}px">${esc(l.text)}</p>`).join('')}</section>`);
    progress?.(i / doc.numPages);
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.45;color:#1b2430}.page{border-bottom:1px solid #ddd;padding:1rem 0}.pn{font-size:12px;color:#778;text-transform:uppercase;letter-spacing:.08em}</style></head><body>${parts.join('')}</body></html>`;
  download(html, `${name}.html`, 'text/html');
}

export async function exportExcelCsv(doc: PDFDocumentProxy, name: string) {
  // Tables are approximated by splitting each line on large horizontal gaps.
  const rows: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const lines = new Map<number, { x: number; s: string; w: number }[]>();
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const t = it.transform as number[];
      const key = Math.round(t[5] / 3);
      lines.set(key, [...(lines.get(key) ?? []), { x: t[4], s: it.str.trim(), w: it.width }]);
    }
    for (const key of [...lines.keys()].sort((a, b) => b - a)) {
      const cells = lines.get(key)!.sort((a, b) => a.x - b.x);
      const out: string[] = [];
      let lastEnd = -Infinity;
      for (const c of cells) {
        if (out.length && c.x - lastEnd < 8) out[out.length - 1] += ' ' + c.s;
        else out.push(c.s);
        lastEnd = c.x + c.w;
      }
      rows.push(out.map((c) => `"${c.replace(/"/g, '""')}"`).join(','));
    }
  }
  download('﻿' + rows.join('\r\n'), `${name}.csv`, 'text/csv');
}

// ---------------------------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------------------------

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Word-level diff (Myers / LCS) of two strings. */
export function diffWords(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  const n = A.length;
  const m = B.length;
  if (n * m > 25_000_000) {
    return [
      { type: 'del', text: a },
      { type: 'add', text: b },
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = out[out.length - 1];
    if (last?.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

export async function compareDocuments(a: PDFDocumentProxy, b: PDFDocumentProxy) {
  const [ta, tb] = await Promise.all([documentText(a), documentText(b)]);
  const pages = Math.max(ta.length, tb.length);
  const result: { page: number; parts: DiffPart[]; changes: number }[] = [];
  for (let i = 0; i < pages; i++) {
    const parts = diffWords(ta[i] ?? '', tb[i] ?? '');
    result.push({ page: i, parts, changes: parts.filter((p) => p.type !== 'same' && p.text.trim()).length });
  }
  return result;
}
