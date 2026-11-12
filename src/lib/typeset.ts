/**
 * Text drawing with full Unicode support.
 *
 * Lines that only use Western European characters are drawn with the PDF standard fonts (nothing
 * is embedded, files stay small). Any other line is split into runs by script and drawn with
 * embedded, subset Noto fonts: Latin/Greek/Cyrillic, Arabic, Hebrew, Devanagari, Thai, Chinese and
 * Japanese, Korean, and symbols. Right-to-left runs are shaped by fontkit and placed in visual order.
 */
// fontkit's Indic shaper needs the regenerator runtime as a global.
import 'regenerator-runtime/runtime';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, type Color } from '@cantoo/pdf-lib';

export type Family = 'Helvetica' | 'Times' | 'Courier';
export interface TextStyle {
  family?: Family;
  bold?: boolean;
  italic?: boolean;
}

export type FontLoader = (file: string) => Promise<Uint8Array>;
let loader: FontLoader | null = null;
const fileCache = new Map<string, Promise<Uint8Array>>();

/** Tell the engine how to read font files (fetch in the browser, readFile under Node). */
export function setFontLoader(l: FontLoader) {
  loader = l;
}
function loadFile(file: string) {
  if (!loader) throw new Error('No font loader configured for Unicode text.');
  if (!fileCache.has(file)) fileCache.set(file, loader(file));
  return fileCache.get(file)!;
}

type Script = 'latin' | 'arabic' | 'hebrew' | 'devanagari' | 'thai' | 'cjk' | 'hangul' | 'symbol' | 'neutral';

export function scriptOf(cp: number): Script {
  if (cp <= 0x40 || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0xbf) || cp === 0xd7 || cp === 0xf7) return 'neutral';
  if (cp >= 0x2000 && cp <= 0x206f) return 'neutral'; // general punctuation
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return 'hebrew';
  if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return 'arabic';
  if (cp >= 0x0900 && cp <= 0x097f) return 'devanagari';
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 'thai';
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xac00 && cp <= 0xd7af)) return 'hangul';
  if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f)) return 'cjk';
  if ((cp >= 0x2100 && cp <= 0x2bff) || (cp >= 0x1f000 && cp <= 0x1faff)) return 'symbol';
  return 'latin';
}

const RTL = new Set<Script>(['arabic', 'hebrew']);

function fileFor(script: Script, s: TextStyle): string {
  const w = s.bold ? 'Bold' : 'Regular';
  switch (script) {
    case 'arabic':
      return `NotoSansArabic-${w}.ttf`;
    case 'hebrew':
      return `NotoSansHebrew-${w}.ttf`;
    case 'devanagari':
      return `NotoSansDevanagari-${w}.ttf`;
    case 'thai':
      return `NotoSansThai-${w}.ttf`;
    case 'cjk':
      return 'NotoSansSC-Regular.ttf';
    case 'hangul':
      return 'NotoSansKR-Regular.ttf';
    case 'symbol':
      return 'NotoSansSymbols2-Regular.ttf';
    default: {
      if (s.family === 'Courier') return `NotoSansMono-${w}.ttf`;
      const base = s.family === 'Times' ? 'NotoSerif' : 'NotoSans';
      return `${base}-${s.bold && s.italic ? 'BoldItalic' : s.italic ? 'Italic' : w}.ttf`;
    }
  }
}

export function standardFontFor(s: TextStyle): StandardFonts {
  const f = s.family ?? 'Helvetica';
  const b = !!s.bold;
  const i = !!s.italic;
  if (f === 'Times') return b && i ? StandardFonts.TimesRomanBoldItalic : b ? StandardFonts.TimesRomanBold : i ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (f === 'Courier') return b && i ? StandardFonts.CourierBoldOblique : b ? StandardFonts.CourierBold : i ? StandardFonts.CourierOblique : StandardFonts.Courier;
  return b && i ? StandardFonts.HelveticaBoldOblique : b ? StandardFonts.HelveticaBold : i ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

// Characters outside Latin-1 that the WinAnsi encoding of the standard fonts still covers.
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((c) => c.codePointAt(0)!));
export function isWinAnsi(text: string) {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) continue;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(cp)) continue;
    return false;
  }
  return true;
}

export interface Run {
  font: PDFFont;
  text: string;
  rtl: boolean;
}

/** Fonts for one document; create one per PDFDocument. */
export class Typesetter {
  private fonts = new Map<string, Promise<PDFFont>>();
  constructor(private doc: PDFDocument) {
    doc.registerFontkit(fontkit);
  }

  standard(s: TextStyle) {
    const name = standardFontFor(s);
    if (!this.fonts.has(name)) this.fonts.set(name, this.doc.embedFont(name));
    return this.fonts.get(name)!;
  }

  private embedded(file: string) {
    if (!this.fonts.has(file)) this.fonts.set(file, loadFile(file).then((b) => this.doc.embedFont(b, { subset: true })));
    return this.fonts.get(file)!;
  }

  private faces = new Map<string, Promise<{ hasGlyphForCodePoint(cp: number): boolean }>>();
  private face(file: string) {
    if (!this.faces.has(file)) this.faces.set(file, loadFile(file).then((b) => fontkit.create(b as never) as never));
    return this.faces.get(file)!;
  }

  /** The font file for a character: its script's font, or the first fallback that has the glyph. */
  private async fileForChar(cp: number, script: Script, s: TextStyle) {
    const first = fileFor(script, s);
    const chain = [first, fileFor('latin', s), 'NotoSans-Regular.ttf', 'NotoSansSymbols2-Regular.ttf', 'NotoSansSC-Regular.ttf'];
    for (const f of chain) if ((await this.face(f)).hasGlyphForCodePoint(cp)) return f;
    return first;
  }

  /** Split a single line into font runs, in visual (left-to-right drawing) order. */
  async runs(line: string, s: TextStyle = {}): Promise<Run[]> {
    if (isWinAnsi(line)) return line ? [{ font: await this.standard(s), text: line, rtl: false }] : [];
    const parts: { script: Script; text: string; file?: string }[] = [];
    for (const ch of line) {
      const cp = ch.codePointAt(0)!;
      let sc = scriptOf(cp);
      const last = parts[parts.length - 1];
      if (sc === 'neutral') sc = last?.script ?? 'neutral';
      const file = sc === 'neutral' ? undefined : await this.fileForChar(cp, sc, s);
      if (last && last.script === sc && (!file || !last.file || last.file === file)) {
        last.text += ch;
        last.file ??= file;
      } else if (last && last.script === 'neutral') {
        last.text += ch;
        last.script = sc;
        last.file = file;
      } else parts.push({ script: sc, text: ch, file });
    }
    // Paragraph direction from the first strong character; RTL lines draw their runs right to left.
    const lineRtl = RTL.has(parts.find((p) => p.script !== 'neutral')?.script ?? 'latin');
    // Trailing punctuation and spaces after a right-to-left run in a left-to-right line belong to the line.
    if (!lineRtl)
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (!RTL.has(p.script)) continue;
        const m = p.text.match(/[\s.,;:!?)\]}"'\u060c\u061b\u061f]+$/u);
        if (m && m[0].length < p.text.length) {
          p.text = p.text.slice(0, -m[0].length);
          parts.splice(i + 1, 0, { script: 'latin', text: m[0], file: fileFor('latin', s) });
        }
      }
    const out: Run[] = [];
    for (const p of parts) {
      const script = p.script === 'neutral' ? 'latin' : p.script;
      out.push({ font: await this.embedded(p.file ?? fileFor(script, s)), text: p.text, rtl: RTL.has(script) });
    }
    return lineRtl ? out.reverse() : out;
  }

  async width(line: string, size: number, s: TextStyle = {}) {
    let w = 0;
    for (const r of await this.runs(line, s)) w += r.font.widthOfTextAtSize(r.text, size);
    return w;
  }

  /** A single font able to show most of `text`, for appearance streams that use one font. */
  async fontFor(text: string, s: TextStyle = {}) {
    if (isWinAnsi(text)) return this.standard(s);
    for (const ch of text) {
      const sc = scriptOf(ch.codePointAt(0)!);
      if (sc !== 'neutral') return this.embedded(fileFor(sc, s));
    }
    return this.embedded(fileFor('latin', s));
  }

  /** Draw one line starting at (x, y); `rotate` in degrees turns the line about its start. */
  async drawLine(page: PDFPage, line: string, o: { x: number; y: number; size: number; color?: Color; opacity?: number; rotate?: number }, s: TextStyle = {}) {
    const rad = ((o.rotate ?? 0) * Math.PI) / 180;
    let x = o.x;
    let y = o.y;
    for (const r of await this.runs(line, s)) {
      page.drawText(r.text, { x, y, size: o.size, font: r.font, color: o.color, opacity: o.opacity, rotate: o.rotate ? degrees(o.rotate) : undefined });
      const w = r.font.widthOfTextAtSize(r.text, o.size);
      x += w * Math.cos(rad);
      y += w * Math.sin(rad);
    }
  }

  /** Word-wrap a paragraph to `maxWidth`. CJK text may break between any two characters. */
  async wrap(text: string, size: number, maxWidth: number, s: TextStyle = {}) {
    const out: string[] = [];
    const tokens = text.match(/[⺀-鿿가-힯豈-﫿぀-ヿ]|\s+|[^\s⺀-鿿가-힯豈-﫿぀-ヿ]+/g) ?? [];
    let line = '';
    for (const t of tokens) {
      const next = line + t;
      if (line.trim() && (await this.width(next, size, s)) > maxWidth) {
        out.push(line.trimEnd());
        line = t.trimStart();
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  }
}

let measurer: Promise<Typesetter> | null = null;
/** Width of each line as ANCHOR Tsunami will draw it, so re-wrapped paragraphs keep their line breaks. */
export async function measureWidths(lines: string[], size: number, s: TextStyle = {}) {
  measurer ??= PDFDocument.create().then((d) => new Typesetter(d));
  const t = await measurer;
  return Promise.all(lines.map((l) => t.width(l, size, s)));
}
