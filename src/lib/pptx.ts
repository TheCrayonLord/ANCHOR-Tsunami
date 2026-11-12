/**
 * PowerPoint (.pptx) to PDF, in the browser. Each slide becomes a page of the slide's size; text
 * boxes and pictures are placed where the slide puts them (positions inherited from the layout and
 * master when the slide does not give its own). Themes, charts, SmartArt and effects are not drawn.
 */
import JSZip from 'jszip';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { Typesetter, type TextStyle } from './typeset';
import { browserImageToPng } from './convert';

const EMU = 12700;
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const kids = (e: Element | null | undefined, name: string) => (e ? Array.from(e.children).filter((c) => c.localName === name) : []);
const kid = (e: Element | null | undefined, name: string) => kids(e, name)[0];
const desc = (e: Element | null | undefined, name: string) => (e ? Array.from(e.getElementsByTagNameNS('*', name)) : []);

function xfrm(sp: Element): Box | null {
  const x = desc(kid(sp, 'spPr') ?? kid(sp, 'grpSpPr') ?? sp, 'xfrm')[0] ?? kid(sp, 'xfrm');
  const off = kid(x, 'off');
  const ex = kid(x, 'ext');
  if (!off || !ex) return null;
  return { x: Number(off.getAttribute('x')) / EMU, y: Number(off.getAttribute('y')) / EMU, w: Number(ex.getAttribute('cx')) / EMU, h: Number(ex.getAttribute('cy')) / EMU };
}
const phOf = (sp: Element) => desc(kid(sp, 'nvSpPr') ?? kid(sp, 'nvPicPr'), 'ph')[0];
const hexColor = (e: Element | null | undefined) => {
  const c = desc(e, 'srgbClr')[0]?.getAttribute('val');
  if (!c || !/^[0-9a-f]{6}$/i.test(c)) return null;
  const n = parseInt(c, 16);
  return { c: rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255), lum: (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 };
};

async function relsOf(zip: JSZip, path: string): Promise<Map<string, string>> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const file = path.slice(path.lastIndexOf('/') + 1);
  const xml = await zip.file(`${dir}/_rels/${file}.rels`)?.async('string');
  const map = new Map<string, string>();
  if (!xml) return map;
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  for (const r of Array.from(d.getElementsByTagName('Relationship'))) {
    const target = r.getAttribute('Target') ?? '';
    const parts = (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/');
    const out: string[] = [];
    for (const p of parts) p === '..' ? out.pop() : p !== '.' && out.push(p);
    map.set(r.getAttribute('Id') ?? '', out.join('/'));
    map.set(`type:${(r.getAttribute('Type') ?? '').split('/').pop()}`, out.join('/'));
  }
  return map;
}

export async function pptxToPdf(bytes: Uint8Array, title?: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const parse = async (p: string) => {
    const s = await zip.file(p)?.async('string');
    return s ? new DOMParser().parseFromString(s, 'application/xml') : null;
  };
  const pres = await parse('ppt/presentation.xml');
  if (!pres) throw new Error('not a PowerPoint file');
  const sz = pres.getElementsByTagNameNS('*', 'sldSz')[0];
  const W = Number(sz?.getAttribute('cx') ?? 12192000) / EMU;
  const H = Number(sz?.getAttribute('cy') ?? 6858000) / EMU;
  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  let slidePaths = Array.from(pres.getElementsByTagNameNS('*', 'sldId'))
    .map((s) => presRels.get(s.getAttribute('r:id') ?? ''))
    .filter((p): p is string => !!p && !!zip.file(p));
  if (!slidePaths.length)
    slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(a.slice(16))![0]) - Number(/\d+/.exec(b.slice(16))![0]));

  const doc = await PDFDocument.create();
  const ts = new Typesetter(doc);
  if (title) doc.setTitle(title);
  const layoutCache = new Map<string, { doc: Document | null; rels: Map<string, string> }>();
  const loadPart = async (p?: string) => {
    if (!p) return null;
    if (!layoutCache.has(p)) layoutCache.set(p, { doc: await parse(p), rels: await relsOf(zip, p) });
    return layoutCache.get(p)!;
  };
  const imgCache = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>> | null>();
  const embed = async (path: string) => {
    if (imgCache.has(path)) return imgCache.get(path)!;
    let img = null;
    try {
      const data = await zip.file(path)?.async('uint8array');
      if (data) {
        const e = path.split('.').pop()!.toLowerCase();
        if (e === 'png') img = await doc.embedPng(data);
        else if (e === 'jpg' || e === 'jpeg') img = await doc.embedJpg(data);
        else if (/^(gif|bmp|webp|svg)$/.test(e)) img = await doc.embedPng((await browserImageToPng(data, e === 'svg' ? 'image/svg+xml' : `image/${e}`)).bytes);
      }
    } catch {
      img = null;
    }
    imgCache.set(path, img);
    return img;
  };

  for (const path of slidePaths) {
    const slide = await parse(path);
    if (!slide) continue;
    const rels = await relsOf(zip, path);
    const layout = await loadPart(rels.get('type:slideLayout'));
    const master = await loadPart(layout?.rels.get('type:slideMaster'));
    const page = doc.addPage([W, H]);

    // Background: the slide's own solid fill, else the layout's or master's.
    let dark = false;
    for (const d of [slide, layout?.doc, master?.doc]) {
      const bg = hexColor(desc(d?.documentElement, 'bg')[0]);
      if (bg) {
        page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: bg.c });
        dark = bg.lum < 0.45;
        break;
      }
    }
    const defaultColor = dark ? rgb(1, 1, 1) : rgb(0.1, 0.1, 0.12);

    /** Position of a placeholder inherited from the layout or master. */
    const inherited = (sp: Element): Box | null => {
      const ph = phOf(sp);
      if (!ph) return null;
      const type = ph.getAttribute('type') ?? 'body';
      const idx = ph.getAttribute('idx');
      for (const part of [layout?.doc, master?.doc]) {
        const cands = desc(part?.documentElement, 'sp').filter((s) => phOf(s));
        const match = cands.find((s) => idx && phOf(s)!.getAttribute('idx') === idx) ?? cands.find((s) => (phOf(s)!.getAttribute('type') ?? 'body') === type) ?? (type === 'ctrTitle' ? cands.find((s) => phOf(s)!.getAttribute('type') === 'title') : type === 'subTitle' ? cands.find((s) => (phOf(s)!.getAttribute('type') ?? 'body') === 'body') : undefined);
        const b = match && xfrm(match);
        if (b) return b;
      }
      return null;
    };

    async function drawText(sp: Element, box: Box) {
      const body = kid(sp, 'txBody');
      if (!body) return;
      const type = phOf(sp)?.getAttribute('type') ?? '';
      const isTitle = /^(title|ctrTitle)$/.test(type);
      if (/^(sldNum|dt|ftr)$/.test(type)) return;
      const anchor = kid(body, 'bodyPr')?.getAttribute('anchor') ?? (isTitle ? 'ctr' : 't');
      interface P {
        text: string;
        size: number;
        st: TextStyle;
        color: ReturnType<typeof rgb>;
        align: string;
        bullet: boolean;
        level: number;
      }
      const paras: P[] = [];
      for (const p of kids(body, 'p')) {
        const pPr = kid(p, 'pPr');
        let text = '';
        let size = 0;
        let bold = false;
        let italic = false;
        let color: ReturnType<typeof rgb> | null = null;
        for (const r of Array.from(p.children)) {
          if (r.localName === 'r' || r.localName === 'fld') {
            const t = kid(r, 't')?.textContent ?? '';
            const rPr = kid(r, 'rPr');
            if (t.trim() && rPr) {
              size ||= Number(rPr.getAttribute('sz') ?? 0) / 100;
              bold ||= rPr.getAttribute('b') === '1';
              italic ||= rPr.getAttribute('i') === '1';
              color ??= hexColor(kid(rPr, 'solidFill'))?.c ?? null;
            }
            text += t;
          } else if (r.localName === 'br') text += '\n';
        }
        const level = Number(pPr?.getAttribute('lvl') ?? 0);
        const hasBullet = !isTitle && !/subTitle/i.test(type) && !!phOf(sp) && !kid(pPr, 'buNone') && text.trim().length > 0;
        paras.push({
          text,
          size: size || (isTitle ? 36 : /subTitle/i.test(type) ? 22 : Math.max(12, 22 - level * 2)),
          st: { bold: bold || isTitle, italic },
          color: color ?? defaultColor,
          align: pPr?.getAttribute('algn') ?? (/ctrTitle|subTitle/.test(type) ? 'ctr' : 'l'),
          bullet: hasBullet || !!kid(pPr, 'buChar') || !!kid(pPr, 'buAutoNum'),
          level,
        });
      }
      if (!paras.some((p) => p.text.trim())) return;
      const pad = 7;
      const innerW = Math.max(20, box.w - 2 * pad);
      // Shrink the text until it fits the box.
      let scale = 1;
      let laid: { lines: string[]; p: P; size: number; indent: number }[] = [];
      let total = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        laid = [];
        total = 0;
        for (const p of paras) {
          const size = Math.max(6, p.size * scale);
          const indent = (p.bullet ? size * 1.1 : 0) + p.level * size * 1.2;
          const lines: string[] = [];
          for (const part of p.text.split('\n')) lines.push(...(part.trim() ? await ts.wrap(part, size, innerW - indent, p.st) : ['']));
          laid.push({ lines, p, size, indent });
          total += lines.length * size * 1.2 + size * 0.3;
        }
        if (total <= box.h - 2 * pad || scale < 0.35) break;
        scale *= 0.9;
      }
      let y = H - box.y - pad;
      if (anchor === 'ctr') y -= Math.max(0, (box.h - 2 * pad - total) / 2);
      else if (anchor === 'b') y -= Math.max(0, box.h - 2 * pad - total);
      for (const { lines, p, size, indent } of laid) {
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          const tw = await ts.width(line, size, p.st);
          const x = box.x + pad + indent + (p.align === 'ctr' ? (innerW - indent - tw) / 2 : p.align === 'r' ? innerW - indent - tw : 0);
          const baseline = y - size;
          if (li === 0 && p.bullet && line.trim()) await ts.drawLine(page, '•', { x: box.x + pad + indent - size * 0.9, y: baseline, size, color: p.color }, {});
          if (line.trim() && baseline > -size && baseline < H + size) await ts.drawLine(page, line, { x, y: baseline, size, color: p.color }, p.st);
          y -= size * 1.2;
        }
        y -= size * 0.3;
      }
    }

    async function drawTable(frame: Element, box: Box) {
      const tbl = desc(frame, 'tbl')[0];
      if (!tbl) return;
      const cols = desc(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Number(g.getAttribute('w')) / EMU);
      let y = H - box.y;
      for (const tr of kids(tbl, 'tr')) {
        const h = Number(tr.getAttribute('h') ?? 370840) / EMU;
        let x = box.x;
        const cells = kids(tr, 'tc');
        let rowH = h;
        const texts: string[][] = [];
        const size = 11;
        for (let c = 0; c < cells.length; c++) {
          const t = desc(cells[c], 'p').map((p) => desc(p, 't').map((n) => n.textContent).join('')).join('\n');
          const lines: string[] = [];
          for (const part of t.split('\n')) lines.push(...(await ts.wrap(part, size, Math.max(10, (cols[c] ?? 60) - 8), {})));
          texts.push(lines);
          rowH = Math.max(rowH, lines.length * size * 1.25 + 6);
        }
        for (let c = 0; c < cells.length; c++) {
          const w = cols[c] ?? 60;
          page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, borderColor: rgb(0.7, 0.72, 0.76), borderWidth: 0.5 });
          let ty = y - 4 - size;
          for (const l of texts[c]) {
            if (l.trim()) await ts.drawLine(page, l, { x: x + 4, y: ty, size, color: defaultColor }, {});
            ty -= size * 1.25;
          }
          x += w;
        }
        y -= rowH;
      }
    }

    async function drawTree(tree: Element | undefined, depth = 0) {
      if (!tree || depth > 6) return;
      for (const el of Array.from(tree.children)) {
        const n = el.localName;
        if (n === 'sp') {
          const box = xfrm(el) ?? inherited(el);
          if (!box) continue;
          const fill = kid(kid(el, 'spPr'), 'solidFill');
          const fc = hexColor(fill);
          if (fc) page.drawRectangle({ x: box.x, y: H - box.y - box.h, width: box.w, height: box.h, color: fc.c });
          await drawText(el, box);
        } else if (n === 'pic') {
          const box = xfrm(el) ?? inherited(el);
          const rid = desc(el, 'blip')[0]?.getAttribute('r:embed');
          const target = rid && rels.get(rid);
          if (!box || !target) continue;
          const img = await embed(target);
          if (img) page.drawImage(img, { x: box.x, y: H - box.y - box.h, width: box.w, height: box.h });
        } else if (n === 'graphicFrame') {
          const box = xfrm(el);
          if (box) await drawTable(el, box);
        } else if (n === 'grpSp') await drawTree(el, depth + 1);
      }
    }
    // Pictures on the layout (logos and so on) first, then the slide.
    for (const pic of kids(desc(layout?.doc?.documentElement, 'spTree')[0], 'pic')) {
      const box = xfrm(pic);
      const target = layout?.rels.get(desc(pic, 'blip')[0]?.getAttribute('r:embed') ?? '');
      const img = box && target ? await embed(target) : null;
      if (img && box) page.drawImage(img, { x: box.x, y: H - box.y - box.h, width: box.w, height: box.h });
    }
    await drawTree(desc(slide.documentElement, 'spTree')[0]);
  }
  if (!doc.getPageCount()) doc.addPage([W, H]);
  return doc.save();
}
