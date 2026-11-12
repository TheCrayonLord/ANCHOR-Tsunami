/**
 * Groups the text runs of a page into lines and paragraphs, so existing text can be edited a whole
 * paragraph at a time and reflowed. No DOM; works on the runs from `getTextRuns`.
 */
import type { Rect, TextRun } from './types';

export interface Line {
  runs: TextRun[];
  str: string;
  baseline: number;
  x: number;
  right: number;
  size: number;
  fontName?: string;
  rect: Rect;
}

export interface Paragraph {
  lines: Line[];
  text: string;
  size: number;
  fontName?: string;
  lineHeight: number; // multiple of size
  align: 'left' | 'center' | 'right';
  cover: Rect; // area of the original text
  rect: Rect; // box for the replacement text, so its first baseline matches the original
}

const baselineOf = (r: TextRun) => r.rect.y + r.rect.h * (0.22 / 1.18);

/** Merge runs that share a baseline into lines, top to bottom. */
export function toLines(runs: TextRun[]): Line[] {
  const rows: { baseline: number; size: number; runs: TextRun[] }[] = [];
  // Whitespace-only runs are dropped: pdf.js uses them to bridge column gaps, and spaces are re-inserted from the gaps.
  const sorted = runs.filter((r) => r.str.trim().length).sort((a, b) => baselineOf(b) - baselineOf(a) || a.rect.x - b.rect.x);
  for (const r of sorted) {
    const b = baselineOf(r);
    const row = rows.find((x) => Math.abs(x.baseline - b) < Math.max(1.5, Math.min(x.size, r.fontSize) * 0.35));
    if (row) row.runs.push(r);
    else rows.push({ baseline: b, size: r.fontSize, runs: [r] });
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.runs.sort((a, b) => a.rect.x - b.rect.x);
    // A row can hold several columns; split where the horizontal gap is large.
    let cur: TextRun[] = [];
    const flush = () => {
      if (!cur.length) return;
      let str = '';
      let lastRight = -Infinity;
      for (const r of cur) {
        if (str && r.rect.x - lastRight > r.fontSize * 0.15 && !str.endsWith(' ') && !r.str.startsWith(' ')) str += ' ';
        str += r.str;
        lastRight = Math.max(lastRight, r.rect.x + r.rect.w);
      }
      if (!str.trim()) {
        cur = [];
        return;
      }
      const size = Math.max(...cur.map((r) => r.fontSize));
      const x = Math.min(...cur.map((r) => r.rect.x));
      const right = Math.max(...cur.map((r) => r.rect.x + r.rect.w));
      const y = Math.min(...cur.map((r) => r.rect.y));
      const top = Math.max(...cur.map((r) => r.rect.y + r.rect.h));
      const main = cur.reduce((a, b) => (b.str.length > a.str.length ? b : a));
      lines.push({ runs: cur, str: str.replace(/\s+$/, ''), baseline: row.baseline, x, right, size, fontName: main.fontName, rect: { x, y, w: right - x, h: top - y } });
      cur = [];
    };
    let prevRight = -Infinity;
    for (const r of row.runs) {
      if (cur.length && r.rect.x - prevRight > r.fontSize * 2.5) flush();
      cur.push(r);
      prevRight = Math.max(prevRight, r.rect.x + r.rect.w);
    }
    flush();
  }
  return lines.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const styleKey = (f?: string) => (f ?? '').toLowerCase().replace(/^[a-z]{6}\+/, '').replace(/[-,]?(regular|roman|book|mt|ps)$/g, '');

/** The paragraph containing the point (px, py), or null when no text is there. */
export function paragraphAt(runs: TextRun[], px: number, py: number): Paragraph | null {
  const lines = toLines(runs);
  const hitIdx = lines.findIndex((l) => px >= l.rect.x - 1 && px <= l.rect.x + l.rect.w + 1 && py >= l.rect.y - 1 && py <= l.rect.y + l.rect.h + 1);
  if (hitIdx < 0) return null;
  const hit = lines[hitIdx];
  const sameColumn = (l: Line, ref: Line) => l.x < ref.right + ref.size && l.right > ref.x - ref.size;
  const compatible = (l: Line, ref: Line) =>
    near(l.size, ref.size, ref.size * 0.12) && sameColumn(l, ref) && (styleKey(l.fontName) === styleKey(ref.fontName) || !l.fontName || !ref.fontName || /bold/i.test(l.fontName ?? '') === /bold/i.test(ref.fontName ?? ''));

  // Candidate lines in the same column, in reading order.
  const col = lines.filter((l) => l === hit || compatible(l, hit) || sameColumn(l, hit));
  const i0 = col.indexOf(hit);
  const para: Line[] = [hit];
  let spacing: number | null = null;
  const fits = (a: Line, b: Line) => {
    // a is directly above b
    const gap = a.baseline - b.baseline;
    if (gap <= 0 || gap > a.size * 1.9) return false;
    if (!compatible(b, a)) return false;
    if (spacing !== null && !near(gap, spacing, spacing * 0.2)) return false;
    return true;
  };
  for (let i = i0 + 1; i < col.length; i++) {
    const a = para[para.length - 1];
    const b = col[i];
    if (!fits(a, b)) break;
    spacing ??= a.baseline - b.baseline;
    para.push(b);
  }
  for (let i = i0 - 1; i >= 0; i--) {
    const a = col[i];
    const b = para[0];
    if (!fits(a, b)) break;
    spacing ??= a.baseline - b.baseline;
    // A short line ending in a full stop above us is the end of the previous paragraph.
    const maxRight = Math.max(...para.map((l) => l.right));
    if (/[.!?:]["')\]]?$/.test(a.str) && a.right < maxRight - a.size * 4) break;
    para.unshift(a);
  }
  // Within a run of lines, a short line ends its paragraph: split there.
  const maxRight = Math.max(...para.map((l) => l.right));
  const minX = Math.min(...para.map((l) => l.x));
  const hitAt = para.indexOf(hit);
  let start = 0;
  let end = para.length - 1;
  const leftAligned = para.every((l) => near(l.x, minX, l.size * 2.5));
  if (leftAligned)
    for (let i = 0; i < para.length - 1; i++) {
      const l = para[i];
      const short = l.right < maxRight - l.size * 4 && /[.!?:]["')\]]?$/.test(l.str);
      if (!short) continue;
      if (i < hitAt) start = i + 1;
      else if (i >= hitAt) {
        end = i;
        break;
      }
    }
  const ls = para.slice(start, end + 1);

  const size = hit.size;
  const lineHeight = ls.length > 1 ? (ls[0].baseline - ls[ls.length - 1].baseline) / (ls.length - 1) / size : 1.2;
  const xs = ls.map((l) => l.x);
  const rights = ls.map((l) => l.right);
  const centers = ls.map((l) => (l.x + l.right) / 2);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const align: Paragraph['align'] =
    ls.length > 1 && spread(xs) > size && spread(centers) < size * 0.6 ? 'center' : ls.length > 1 && spread(xs) > size && spread(rights) < size * 0.6 ? 'right' : 'left';

  // Join lines, removing end-of-line hyphenation.
  let text = '';
  for (const l of ls) {
    if (!text) text = l.str.trim();
    else if (/[A-Za-zÀ-ɏ]-$/.test(text) && /^[a-zß-ÿ]/.test(l.str.trim())) text = text.slice(0, -1) + l.str.trim();
    else text += ' ' + l.str.trim();
  }
  const x = Math.min(...xs);
  const right = Math.max(...rights);
  const coverY = Math.min(...ls.map((l) => l.rect.y));
  const coverTop = Math.max(...ls.map((l) => l.rect.y + l.rect.h));
  const cover = { x: x - 0.5, y: coverY - 0.5, w: right - x + 1, h: coverTop - coverY + 1 };
  // First baseline sits 0.78 × size below the top of a text box (see ops.applyItems).
  const top = ls[0].baseline + size * 0.78;
  const bottom = ls[ls.length - 1].baseline - size * 0.22;
  const width = (right - x) * 1.03 + size * 0.5;
  const rx = align === 'center' ? (x + right) / 2 - width / 2 : align === 'right' ? right - width : x;
  return { lines: ls, text, size, fontName: hit.fontName, lineHeight: Math.round(lineHeight * 1000) / 1000, align, cover, rect: { x: rx, y: bottom, w: width, h: top - bottom } };
}
