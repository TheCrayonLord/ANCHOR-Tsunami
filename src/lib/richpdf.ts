/**
 * A small document layout engine: turns a list of blocks (headings, paragraphs, lists, tables,
 * images, code) into PDF pages with real, selectable text. Used by the "any file to PDF" converters.
 * No DOM; text goes through the Unicode Typesetter.
 */
import { PDFDocument, PDFName, PDFString, rgb, type PDFPage } from '@cantoo/pdf-lib';
import { Typesetter, type TextStyle } from './typeset';

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string; // #rrggbb
  link?: string;
  size?: number; // overrides the block size
}

export type Block =
  | { type: 'p'; runs: Inline[]; size?: number; align?: 'left' | 'center' | 'right'; indent?: number; bullet?: string; before?: number; after?: number; serif?: boolean; fill?: string; keepWithNext?: boolean }
  | { type: 'pre'; text: string; size?: number }
  | { type: 'table'; rows: Inline[][][]; header?: boolean; size?: number }
  | { type: 'image'; bytes: Uint8Array; mime: string; width?: number; height?: number; maxHeight?: number }
  | { type: 'hr' }
  | { type: 'pagebreak' };

export interface LayoutOptions {
  size?: [number, number];
  margin?: number;
  fontSize?: number;
  serif?: boolean;
  title?: string;
}

export const heading = (text: string, level = 1): Block => ({
  type: 'p',
  runs: [{ text, bold: true }],
  size: [22, 17, 14, 12.5, 11.5, 11][Math.min(5, Math.max(0, level - 1))],
  before: level <= 2 ? 14 : 10,
  after: 6,
  keepWithNext: true,
});
export const para = (text: string, o: Partial<Inline> = {}): Block => ({ type: 'p', runs: [{ text, ...o }] });

const hex = (c?: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c ?? '');
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

interface Seg {
  text: string;
  w: number;
  st: Inline;
  size: number;
}

export async function layoutDocument(blocks: Block[], o: LayoutOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ts = new Typesetter(doc);
  const [W, H] = o.size ?? [612, 792];
  const M = o.margin ?? 54;
  const base = o.fontSize ?? 11;
  const contentW = W - 2 * M;
  if (o.title) doc.setTitle(o.title);
  doc.setProducer('ANCHOR Tsunami');

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const need = (h: number) => {
    if (y - h < M && y < H - M) newPage();
  };

  const styleOf = (st: Inline, serif?: boolean): TextStyle => ({ family: st.mono ? 'Courier' : serif ?? o.serif ? 'Times' : 'Helvetica', bold: st.bold, italic: st.italic });
  const wcache = new Map<string, number>();
  const widthOf = async (text: string, size: number, st: TextStyle) => {
    const k = `${st.family}|${st.bold ? 1 : 0}${st.italic ? 1 : 0}|${text}`;
    let w = wcache.get(k);
    if (w === undefined) {
      w = await ts.width(text, 1, st);
      if (wcache.size < 200000) wcache.set(k, w);
    }
    return w * size;
  };

  /** Break styled runs into lines no wider than maxW. */
  async function breakLines(runs: Inline[], size: number, maxW: number, serif?: boolean): Promise<Seg[][]> {
    const lines: Seg[][] = [[]];
    let x = 0;
    for (const r of runs) {
      const st = styleOf(r, serif);
      const sz = r.size ?? size;
      const parts = r.text.split('\n');
      for (let pi = 0; pi < parts.length; pi++) {
        if (pi > 0) {
          lines.push([]);
          x = 0;
        }
        const tokens = parts[pi].match(/[⺀-鿿가-힯豈-﫿぀-ヿ]|[ \t]+|[^ \t⺀-鿿가-힯豈-﫿぀-ヿ]+/g) ?? [];
        for (let tok of tokens) {
          const space = /^[ \t]+$/.test(tok);
          if (space) tok = tok.replace(/\t/g, '    ');
          let w = await widthOf(tok, sz, st);
          if (x + w > maxW && x > 0) {
            if (space) continue; // a space at a line break disappears
            lines.push([]);
            x = 0;
          }
          if (space && x === 0 && lines.length > 1) continue;
          // A single word wider than the line is split by characters.
          while (w > maxW && tok.length > 1) {
            let n = Math.max(1, Math.floor((tok.length * (maxW - x)) / w));
            while (n > 1 && (await widthOf(tok.slice(0, n), sz, st)) > maxW - x) n--;
            const head = tok.slice(0, n);
            lines[lines.length - 1].push({ text: head, w: await widthOf(head, sz, st), st: r, size: sz });
            lines.push([]);
            x = 0;
            tok = tok.slice(n);
            w = await widthOf(tok, sz, st);
          }
          const line = lines[lines.length - 1];
          const last = line[line.length - 1];
          if (last && last.st === r) {
            last.text += tok;
            last.w += w;
          } else line.push({ text: tok, w, st: r, size: sz });
          x += w;
        }
      }
    }
    // Trailing spaces do not count towards alignment.
    for (const l of lines) {
      const last = l[l.length - 1];
      if (last && /\s+$/.test(last.text)) {
        const t = last.text.replace(/\s+$/, '');
        last.w = t ? await widthOf(t, last.size, styleOf(last.st, serif)) : 0;
        last.text = t;
      }
    }
    return lines;
  }

  async function drawSegs(segs: Seg[], x: number, baseline: number, serif?: boolean, pg: PDFPage = page) {
    for (const s of segs) {
      if (!s.text) continue;
      const col = hex(s.st.color) ?? (s.st.link ? rgb(0.05, 0.35, 0.75) : rgb(0.1, 0.1, 0.12));
      await ts.drawLine(pg, s.text, { x, y: baseline, size: s.size, color: col }, styleOf(s.st, serif));
      if (s.st.underline || s.st.link) pg.drawLine({ start: { x, y: baseline - s.size * 0.12 }, end: { x: x + s.w, y: baseline - s.size * 0.12 }, thickness: s.size * 0.05, color: col });
      if (s.st.strike) pg.drawLine({ start: { x, y: baseline + s.size * 0.28 }, end: { x: x + s.w, y: baseline + s.size * 0.28 }, thickness: s.size * 0.05, color: col });
      if (s.st.link && /^(https?:|mailto:)/i.test(s.st.link)) {
        const a = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, baseline - s.size * 0.25, x + s.w, baseline + s.size * 0.8], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(s.st.link) } });
        pg.node.addAnnot(doc.context.register(a));
      }
      x += s.w;
    }
  }

  const lineH = (segs: Seg[], size: number) => Math.max(size, ...segs.map((s) => s.size)) * 1.35;

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    switch (b.type) {
      case 'pagebreak':
        if (y < H - M) newPage();
        break;
      case 'hr':
        need(14);
        y -= 7;
        page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.75, 0.78, 0.82) });
        y -= 7;
        break;
      case 'p': {
        const size = b.size ?? base;
        const indent = b.indent ?? 0;
        const maxW = Math.max(40, contentW - indent);
        const lines = await breakLines(b.runs, size, maxW, b.serif);
        if (lines.length === 1 && !lines[0].length) {
          y -= size * 0.7;
          break;
        }
        if (y < H - M) y -= b.before ?? 0;
        const firstH = lineH(lines[0], size);
        // Headings stay with the text that follows them.
        need(b.keepWithNext ? firstH * lines.length + base * 3 : firstH);
        for (let li = 0; li < lines.length; li++) {
          const segs = lines[li];
          const lh = lineH(segs, size);
          need(lh);
          const tw = segs.reduce((a, s) => a + s.w, 0);
          const x = M + indent + (b.align === 'center' ? (maxW - tw) / 2 : b.align === 'right' ? maxW - tw : 0);
          if (b.fill) page.drawRectangle({ x: M + indent - 3, y: y - lh, width: maxW + 6, height: lh, color: hex(b.fill) });
          const baseline = y - lh + lh * 0.28;
          if (li === 0 && b.bullet) await ts.drawLine(page, b.bullet, { x: M + indent - (await widthOf(b.bullet, size, {})) - 5, y: baseline, size, color: rgb(0.1, 0.1, 0.12) }, {});
          await drawSegs(segs, x, baseline, b.serif);
          y -= lh;
        }
        y -= b.after ?? size * 0.45;
        break;
      }
      case 'pre': {
        const size = b.size ?? Math.min(base, 9.5);
        const st: TextStyle = { family: 'Courier' };
        const cw = await widthOf('M', size, st);
        const cols = Math.max(20, Math.floor((contentW - 12) / cw));
        const lh = size * 1.3;
        y -= 4;
        for (const raw of b.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
          // Hard-wrap long lines; wide (CJK) characters are measured.
          const chunks: string[] = [];
          if (raw.length <= cols && !/[^\x00-ɏ]/.test(raw)) chunks.push(raw);
          else {
            let cur = '';
            let w = 0;
            for (const ch of raw) {
              const chw = /[^\x00-ɏ]/.test(ch) ? await widthOf(ch, size, st) : cw;
              if (w + chw > contentW - 12 && cur) {
                chunks.push(cur);
                cur = '';
                w = 0;
              }
              cur += ch;
              w += chw;
            }
            chunks.push(cur);
          }
          for (const c of chunks) {
            need(lh);
            page.drawRectangle({ x: M, y: y - lh, width: contentW, height: lh + 0.5, color: rgb(0.955, 0.96, 0.97) });
            if (c.trim()) await ts.drawLine(page, c, { x: M + 6, y: y - lh + lh * 0.28, size, color: rgb(0.12, 0.14, 0.2) }, st);
            y -= lh;
          }
        }
        y -= 8;
        break;
      }
      case 'image': {
        try {
          const img = /png/i.test(b.mime) ? await doc.embedPng(b.bytes) : await doc.embedJpg(b.bytes);
          let w = b.width ?? img.width * 0.75; // CSS px to points
          let h = b.height ?? (b.width ? (img.height / img.width) * b.width : img.height * 0.75);
          const maxH = Math.min(b.maxHeight ?? Infinity, H - 2 * M);
          const k = Math.min(1, contentW / w, maxH / h);
          w *= k;
          h *= k;
          need(h + 6);
          page.drawImage(img, { x: M + (w < contentW * 0.7 ? 0 : (contentW - w) / 2), y: y - h, width: w, height: h });
          y -= h + 8;
        } catch {
          /* an image that cannot be decoded is skipped */
        }
        break;
      }
      case 'table': {
        const size = b.size ?? Math.min(base, 9.5);
        const pad = 3.5;
        const nCols = Math.max(0, ...b.rows.map((r) => r.length));
        if (!nCols) break;
        // Natural width of each column (longest cell, capped), from a sample of the rows.
        const natural = new Array<number>(nCols).fill(18);
        const sample = b.rows.length > 400 ? [...b.rows.slice(0, 200), ...b.rows.slice(-200)] : b.rows;
        for (const row of sample) {
          const head = !!b.header && row === b.rows[0];
          for (let c = 0; c < row.length; c++) {
            let w = 1.5;
            for (const r of row[c]) w += await widthOf(r.text.split('\n')[0].slice(0, 60), r.size ?? size, styleOf(head ? { ...r, bold: true } : r));
            natural[c] = Math.max(natural[c], Math.min(w, 220));
          }
        }
        // Split very wide tables into groups of columns that fit the page.
        const minW = 34;
        const groups: number[][] = [];
        let cur: number[] = [];
        let acc = 0;
        for (let c = 0; c < nCols; c++) {
          const w = Math.max(minW, Math.min(natural[c], 110)) + 2 * pad;
          if (cur.length && acc + w > contentW) {
            groups.push(cur);
            cur = [];
            acc = 0;
          }
          cur.push(c);
          acc += w;
        }
        groups.push(cur);
        const fits = natural.reduce((a, n) => a + n + 2 * pad, 0) <= contentW;
        const useGroups = fits ? [Array.from({ length: nCols }, (_, i) => i)] : groups;
        for (const cols of useGroups) {
          const want = cols.map((c) => natural[c] + 2 * pad);
          const total = want.reduce((a, n) => a + n, 0);
          const widths = total <= contentW ? want : want.map((w) => Math.max(minW, (w / total) * contentW));
          const scale = Math.min(1, contentW / widths.reduce((a, n) => a + n, 0));
          const colW = widths.map((w) => w * scale);
          const tableW = colW.reduce((a, n) => a + n, 0);
          const grid = rgb(0.78, 0.81, 0.85);
          for (let ri = 0; ri < b.rows.length; ri++) {
            const row = b.rows[ri];
            const isHead = !!b.header && ri === 0;
            const cells: Seg[][][] = [];
            let rowH = size * 1.35 + 2 * pad;
            for (let k = 0; k < cols.length; k++) {
              const runs = (row[cols[k]] ?? []).map((r) => (isHead ? { ...r, bold: true } : r));
              const lines = runs.length ? await breakLines(runs, size, colW[k] - 2 * pad) : [];
              cells.push(lines);
              rowH = Math.max(rowH, lines.reduce((a, l) => a + lineH(l, size), 0) + 2 * pad);
            }
            rowH = Math.min(rowH, H - 2 * M);
            need(rowH);
            if (isHead) page.drawRectangle({ x: M, y: y - rowH, width: tableW, height: rowH, color: rgb(0.93, 0.95, 0.97) });
            let x = M;
            for (let k = 0; k < cols.length; k++) {
              let cy = y - pad;
              for (const l of cells[k]) {
                const lh = lineH(l, size);
                if (cy - lh < y - rowH - 0.5) break;
                await drawSegs(l, x + pad, cy - lh + lh * 0.28);
                cy -= lh;
              }
              page.drawRectangle({ x, y: y - rowH, width: colW[k], height: rowH, borderColor: grid, borderWidth: 0.5 });
              x += colW[k];
            }
            y -= rowH;
          }
          y -= 12;
        }
        break;
      }
    }
  }
  // Give the viewer a sensible initial title display.
  if (o.title) doc.catalog.set(PDFName.of('ViewerPreferences'), doc.context.obj({ DisplayDocTitle: true }));
  return doc.save();
}
