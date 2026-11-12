import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { OverlayItem, Rect, TextRun, ItemKind, FieldType } from '../lib/types';
import type { PageViewport } from './Viewer';
import { charEdges } from '../lib/pdfjs';

export type ItemTool =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'measure'
  | 'note'
  | 'text'
  | 'edittext'
  | 'image'
  | 'sign'
  | 'digisig'
  | 'stamp'
  | 'redact'
  | 'whiteout'
  | 'link'
  | 'field'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly';

export interface ToolStyle {
  color: string;
  fill: string | null;
  width: number;
  opacity: number;
  fontSize: number;
  font: 'Helvetica' | 'Times' | 'Courier';
  bold: boolean;
  italic: boolean;
}

export interface OverlayContext {
  tool: ItemTool | null;
  style: ToolStyle;
  stampLabel: string;
  fieldType: FieldType;
  pendingImage: { dataUrl: string; aspect: number; width?: number } | null;
  signature: { dataUrl: string; aspect: number } | null;
  author: string;
  measureScale: { unit: string; perPoint: number };
  getRuns: (page: number) => Promise<TextRun[]>;
  add: (item: OverlayItem) => void;
  update: (id: string, patch: Partial<OverlayItem>) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  selectedId: string | null;
  editingId: string | null;
  setEditing: (id: string | null) => void;
  askLink: () => Promise<{ url?: string; destPage?: number } | null>;
  digitalSign: (page: number, rect: Rect) => void;
  toast: (msg: string) => void;
  passive: boolean; // a pdf.js editor tool is active
  presetText: string | null; // text placed by the next click of the Add text tool (e.g. today's date)
  clearPreset: () => void;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function toView(vp: PageViewport, r: Rect) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
function toPdfRect(vp: PageViewport, ax: number, ay: number, bx: number, by: number): Rect {
  const [x1, y1] = vp.convertToPdfPoint(ax, ay);
  const [x2, y2] = vp.convertToPdfPoint(bx, by);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
const inter = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const DEFAULT_SIZE: Partial<Record<ItemTool, [number, number]>> = {
  rect: [120, 80],
  ellipse: [120, 80],
  note: [20, 20],
  text: [220, 40],
  stamp: [170, 54],
  whiteout: [120, 30],
  redact: [120, 18],
};
const FIELD_SIZE: Record<FieldType, [number, number]> = {
  text: [180, 22],
  multiline: [240, 70],
  checkbox: [14, 14],
  radio: [14, 14],
  dropdown: [160, 22],
  listbox: [160, 60],
  button: [100, 26],
};

export function PageOverlay({ page, vp, items, ctx }: { page: number; vp: PageViewport; items: OverlayItem[]; ctx: OverlayContext }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null);
  const drag = useRef<{ mode: 'create' | 'move' | 'resize'; id?: string; ax: number; ay: number; orig?: OverlayItem } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const b = hostRef.current!.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as const;
  };
  const active = !!ctx.tool && !ctx.passive;

  const onDown = (e: RPointerEvent) => {
    if (!active || e.button !== 0 || e.target !== hostRef.current) return;
    e.preventDefault();
    const [x, y] = local(e);
    ctx.select(null);
    ctx.setEditing(null);
    drag.current = { mode: 'create', ax: x, ay: y };
    setDraft({ ax: x, ay: y, bx: x, by: y });
    hostRef.current!.setPointerCapture(e.pointerId);
  };

  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = local(e);
    if (d.mode === 'create') setDraft({ ax: d.ax, ay: d.ay, bx: x, by: y });
    else if (d.orig && d.id) {
      const [px0, py0] = vp.convertToPdfPoint(d.ax, d.ay);
      const [px1, py1] = vp.convertToPdfPoint(x, y);
      const dx = px1 - px0;
      const dy = py1 - py0;
      const o = d.orig;
      if (d.mode === 'move') {
        const sh = (r: Rect) => ({ ...r, x: r.x + dx, y: r.y + dy });
        ctx.update(d.id, {
          rect: sh(o.rect),
          pts: o.pts?.map(([a, b]) => [a + dx, b + dy] as [number, number]),
          quads: o.quads?.map(sh),
          cover: o.cover ? sh(o.cover) : undefined,
        });
      } else {
        // Resize from the bottom-right corner of the on-screen box.
        const v = toView(vp, o.rect);
        const keepAspect = o.kind === 'image';
        let w = Math.max(6, v.width + (x - d.ax));
        let h = Math.max(6, v.height + (y - d.ay));
        if (keepAspect) h = w * (v.height / v.width);
        if (keepAspect && Math.abs(y - d.ay) > Math.abs(x - d.ax)) {
          h = Math.max(6, v.height + (y - d.ay));
          w = h * (v.width / v.height);
        }
        ctx.update(d.id, { rect: toPdfRect(vp, v.left, v.top, v.left + w, v.top + h) });
      }
    }
  };

  const onUp = async (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode !== 'create') return;
    const dr = draft;
    setDraft(null);
    if (!dr || !ctx.tool) return;
    const [x, y] = local(e);
    const tiny = Math.abs(x - dr.ax) < 5 && Math.abs(y - dr.ay) < 5;
    await create(ctx.tool, dr.ax, dr.ay, x, y, tiny);
  };

  async function create(tool: ItemTool, ax: number, ay: number, bx: number, by: number, tiny: boolean) {
    const s = ctx.style;
    const base = { id: uid(), page, author: ctx.author, color: s.color, width: s.width, opacity: s.opacity };
    const zoom = vp.scale;
    const boxAt = (wPt: number, hPt: number, center = false) => {
      const w = wPt * zoom;
      const h = hPt * zoom;
      return center ? toPdfRect(vp, ax - w / 2, ay - h / 2, ax + w / 2, ay + h / 2) : toPdfRect(vp, ax, ay, ax + w, ay + h);
    };
    const dragged = toPdfRect(vp, ax, ay, bx, by);
    const rectFor = (t: ItemTool) => (tiny ? boxAt(...(DEFAULT_SIZE[t] ?? [100, 60])) : dragged);

    switch (tool) {
      case 'rect':
      case 'ellipse':
        ctx.add({ ...base, kind: tool, rect: rectFor(tool), fill: s.fill });
        break;
      case 'line':
      case 'arrow':
      case 'measure': {
        if (tiny) return ctx.toast('Drag to draw a line.');
        const [x1, y1] = vp.convertToPdfPoint(ax, ay);
        const [x2, y2] = vp.convertToPdfPoint(bx, by);
        const len = Math.hypot(x2 - x1, y2 - y1) * ctx.measureScale.perPoint;
        ctx.add({
          ...base,
          kind: tool,
          rect: dragged,
          pts: [
            [x1, y1],
            [x2, y2],
          ],
          text: tool === 'measure' ? `${len.toFixed(2)} ${ctx.measureScale.unit}` : undefined,
        });
        break;
      }
      case 'note': {
        const item: OverlayItem = { ...base, kind: 'note', rect: boxAt(20, 20), color: '#ffd84a', text: '' };
        ctx.add(item);
        ctx.select(item.id);
        ctx.setEditing(item.id);
        break;
      }
      case 'text': {
        const preset = ctx.presetText;
        const rect = preset && tiny ? (() => { const r = boxAt(Math.max(60, preset.length * s.fontSize * 0.6), s.fontSize * 1.4); return r; })() : rectFor('text');
        const item: OverlayItem = { ...base, kind: 'text', rect, text: preset ?? '', fontSize: s.fontSize, font: s.font, bold: s.bold, italic: s.italic };
        ctx.add(item);
        ctx.select(item.id);
        if (preset) ctx.clearPreset();
        else ctx.setEditing(item.id);
        break;
      }
      case 'edittext': {
        const [px, py] = vp.convertToPdfPoint(bx, by);
        const runs = await ctx.getRuns(page);
        const hit = runs.find((r) => px >= r.rect.x - 1 && px <= r.rect.x + r.rect.w + 1 && py >= r.rect.y - 1 && py <= r.rect.y + r.rect.h + 1);
        if (!hit) return ctx.toast('Click directly on a line of text to edit it.');
        const fam = (hit.fontName ?? '').toLowerCase().replace(/^[a-z]{6}\+/, '');
        const font = /mono|courier|consol/.test(fam) ? 'Courier' : /times|roman|serif|georgia|garamond|cambria|minion|book/.test(fam) && !/sans|arial|helv/.test(fam) ? 'Times' : 'Helvetica';
        const bold = /bold|black|heavy|semibold|demi/.test(fam);
        const italic = /italic|oblique/.test(fam);
        const cover = { x: hit.rect.x - 0.5, y: hit.rect.y - 0.5, w: hit.rect.w + 1, h: hit.rect.h + 1 };
        const item: OverlayItem = {
          ...base,
          kind: 'text',
          rect: { x: hit.rect.x, y: hit.rect.y, w: Math.max(hit.rect.w * 1.5 + 20, 60), h: hit.rect.h },
          cover,
          text: hit.str,
          fontSize: Math.round(hit.fontSize * 10) / 10,
          font,
          bold,
          italic,
          nowrap: true,
          color: '#000000',
          opacity: 1,
        };
        ctx.add(item);
        ctx.select(item.id);
        ctx.setEditing(item.id);
        break;
      }
      case 'image':
      case 'sign': {
        const img = tool === 'sign' ? ctx.signature : ctx.pendingImage;
        if (!img) return ctx.toast(tool === 'sign' ? 'Create a signature first.' : 'Choose an image first.');
        const wPt = tool === 'sign' ? 160 : ((img as { width?: number }).width ?? 200);
        const rect = tiny ? boxAt(wPt, wPt / img.aspect, true) : dragged;
        ctx.add({ ...base, kind: 'image', rect, dataUrl: img.dataUrl, opacity: 1 });
        break;
      }
      case 'stamp':
        ctx.add({ ...base, kind: 'stamp', rect: tiny ? boxAt(170, 54, true) : dragged, text: ctx.stampLabel, color: stampColor(ctx.stampLabel), opacity: 0.85 });
        break;
      case 'redact':
        ctx.add({ ...base, kind: 'redact', rect: rectFor('redact'), color: '#000000' });
        break;
      case 'whiteout':
        ctx.add({ ...base, kind: 'whiteout', rect: rectFor('whiteout'), fill: '#ffffff' });
        break;
      case 'digisig':
        ctx.digitalSign(page, tiny ? boxAt(220, 60) : dragged);
        break;
      case 'link': {
        if (tiny) return ctx.toast('Drag a box over the area that should become a link.');
        const target = await ctx.askLink();
        if (!target) return;
        ctx.add({ ...base, kind: 'link', rect: dragged, ...target });
        break;
      }
      case 'field': {
        const [w, h] = FIELD_SIZE[ctx.fieldType];
        const rect = tiny ? boxAt(w, h) : dragged;
        const n = items.filter((i) => i.kind === 'field').length + 1;
        ctx.add({ ...base, kind: 'field', fieldType: ctx.fieldType, rect, name: ctx.fieldType === 'radio' ? 'choice_group' : `${ctx.fieldType}_${page + 1}_${n}`, fontSize: 0 });
        break;
      }
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly': {
        const runs = await ctx.getRuns(page);
        const area = tiny ? (() => {
          const [px, py] = vp.convertToPdfPoint(bx, by);
          return { x: px - 1, y: py - 1, w: 2, h: 2 };
        })() : dragged;
        const quads = runs.filter((r) => inter(r.rect, area)).map((r) => clipRun(r, area, tiny));
        if (!quads.length) return ctx.toast('Drag across the text you want to mark up.');
        const all = quads.reduce((a, q) => ({ x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), x2: Math.max(a.x2, q.x + q.w), y2: Math.max(a.y2, q.y + q.h) }), { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity });
        ctx.add({ ...base, kind: tool as ItemKind, quads, rect: { x: all.x, y: all.y, w: all.x2 - all.x, h: all.y2 - all.y }, color: tool === 'highlight' ? s.color === '#000000' ? '#fff176' : s.color : s.color });
        break;
      }
    }
  }

  const startItemDrag = (e: RPointerEvent, it: OverlayItem, mode: 'move' | 'resize') => {
    if (ctx.passive || e.button !== 0) return;
    e.stopPropagation();
    ctx.select(it.id);
    if (ctx.editingId === it.id && mode === 'move') return;
    const [x, y] = local(e);
    drag.current = { mode, id: it.id, ax: x, ay: y, orig: structuredClone(it) };
    hostRef.current!.setPointerCapture(e.pointerId);
  };

  const draftBox = draft && (
    ctx.tool === 'line' || ctx.tool === 'arrow' || ctx.tool === 'measure' ? (
      <svg className="ov-draft-svg">
        <line x1={draft.ax} y1={draft.ay} x2={draft.bx} y2={draft.by} stroke={ctx.style.color} strokeWidth={Math.max(1, ctx.style.width * vp.scale)} />
      </svg>
    ) : (
      <div
        className={`ov-draft ov-draft-${ctx.tool}`}
        style={{ left: Math.min(draft.ax, draft.bx), top: Math.min(draft.ay, draft.by), width: Math.abs(draft.bx - draft.ax), height: Math.abs(draft.by - draft.ay) }}
      />
    )
  );

  return (
    <div
      ref={hostRef}
      className={`ov-layer ${active ? 'active' : ''} ${ctx.passive ? 'passive' : ''} tool-${ctx.tool ?? 'none'}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {items.map((it) => (
        <ItemView key={it.id} it={it} vp={vp} ctx={ctx} onDrag={startItemDrag} />
      ))}
      {draftBox}
    </div>
  );
}

function clipRun(r: TextRun, area: Rect, whole: boolean): Rect {
  if (whole || r.str.length < 2) return r.rect;
  const xs = charEdges(r);
  const n = r.str.length;
  // First character whose middle is right of the area's left edge, last whose middle is left of its right edge.
  let a = 0;
  while (a < n - 1 && r.rect.x + (xs[a] + xs[a + 1]) / 2 < area.x) a++;
  let b = n;
  while (b > a + 1 && r.rect.x + (xs[b - 1] + xs[b]) / 2 > area.x + area.w) b--;
  return { x: r.rect.x + xs[a], y: r.rect.y, w: xs[b] - xs[a], h: r.rect.h };
}

export function stampColor(label: string) {
  const l = label.toLowerCase();
  if (/approved|final|completed|paid|accepted/.test(l)) return '#1e8e4e';
  if (/draft|review|preliminary|for comment/.test(l)) return '#1f5fbf';
  return '#c0392b';
}

function ItemView({ it, vp, ctx, onDrag }: { it: OverlayItem; vp: PageViewport; ctx: OverlayContext; onDrag: (e: RPointerEvent, it: OverlayItem, m: 'move' | 'resize') => void }) {
  const v = toView(vp, it.rect);
  const sel = ctx.selectedId === it.id;
  const editing = ctx.editingId === it.id;
  const z = vp.scale;
  const sw = Math.max(1, (it.width ?? 2) * z);
  const style = { left: v.left, top: v.top, width: v.width, height: v.height };
  const common = {
    className: `ov-item ov-${it.kind} ${sel ? 'selected' : ''}`,
    onPointerDown: (e: RPointerEvent) => onDrag(e, it, 'move'),
    onDoubleClick: () => (it.kind === 'text' || it.kind === 'note' || it.kind === 'field') && ctx.setEditing(it.id),
    title: it.kind === 'redact' ? 'Redaction mark (applied when you choose Apply redactions)' : undefined,
  };
  const handle = sel && !['line', 'arrow', 'measure', 'note', 'highlight', 'underline', 'strikeout', 'squiggly'].includes(it.kind) && <div className="ov-handle" onPointerDown={(e) => onDrag(e, it, 'resize')} />;

  if (it.kind === 'line' || it.kind === 'arrow' || it.kind === 'measure') {
    const [[x1, y1], [x2, y2]] = it.pts!;
    const [a, b] = vp.convertToViewportPoint(x1, y1);
    const [c, d] = vp.convertToViewportPoint(x2, y2);
    const ang = Math.atan2(d - b, c - a);
    const hs = 6 * z + sw * 2;
    const head = (px: number, py: number, an: number) =>
      `M${px - hs * Math.cos(an - 0.45)},${py - hs * Math.sin(an - 0.45)} L${px},${py} L${px - hs * Math.cos(an + 0.45)},${py - hs * Math.sin(an + 0.45)}`;
    return (
      <svg className={`ov-svg ${sel ? 'selected' : ''}`} style={{ opacity: it.opacity }}>
        <g onPointerDown={(e) => onDrag(e, it, 'move')} className="ov-hit">
          <line x1={a} y1={b} x2={c} y2={d} stroke="transparent" strokeWidth={sw + 12} />
          <line x1={a} y1={b} x2={c} y2={d} stroke={it.color} strokeWidth={sw} strokeLinecap="round" />
          {(it.kind === 'arrow' || it.kind === 'measure') && <path d={head(c, d, ang)} stroke={it.color} strokeWidth={sw} fill="none" />}
          {it.kind === 'measure' && <path d={head(a, b, ang + Math.PI)} stroke={it.color} strokeWidth={sw} fill="none" />}
          {it.kind === 'measure' && (
            <text x={(a + c) / 2} y={(b + d) / 2 - 6} fill={it.color} fontSize={11 * Math.max(0.8, z / 1.33)} textAnchor="middle" className="ov-measure-label">
              {it.text}
            </text>
          )}
        </g>
      </svg>
    );
  }

  if (it.kind === 'highlight' || it.kind === 'underline' || it.kind === 'strikeout' || it.kind === 'squiggly') {
    return (
      <>
        {(it.quads ?? [it.rect]).map((q, i) => {
          const qv = toView(vp, q);
          const line = it.kind === 'underline' ? { bottom: qv.height * 0.08 } : it.kind === 'strikeout' ? { top: qv.height * 0.48 } : null;
          return (
            <div key={i} {...common} className={`${common.className} ov-markup`} style={{ left: qv.left, top: qv.top, width: qv.width, height: qv.height }}>
              {it.kind === 'highlight' && <div className="ov-hl" style={{ background: it.color, opacity: (it.opacity ?? 1) * 0.45 }} />}
              {line && <div className="ov-line" style={{ ...line, height: Math.max(1, qv.height * 0.07), background: it.color }} />}
              {it.kind === 'squiggly' && <div className="ov-squiggle" style={{ color: it.color }} />}
            </div>
          );
        })}
      </>
    );
  }

  switch (it.kind) {
    case 'rect':
    case 'ellipse':
      return (
        <div {...common} style={style}>
          <svg width="100%" height="100%" style={{ opacity: it.opacity, overflow: 'visible' }}>
            {it.kind === 'rect' ? (
              <rect x={sw / 2} y={sw / 2} width={Math.max(0, v.width - sw)} height={Math.max(0, v.height - sw)} stroke={it.color} strokeWidth={sw} fill={it.fill ?? 'none'} />
            ) : (
              <ellipse cx={v.width / 2} cy={v.height / 2} rx={Math.max(0, v.width / 2 - sw / 2)} ry={Math.max(0, v.height / 2 - sw / 2)} stroke={it.color} strokeWidth={sw} fill={it.fill ?? 'none'} />
            )}
          </svg>
          {handle}
        </div>
      );
    case 'note':
      return (
        <div {...common} style={{ ...style, width: 20 * z, height: 20 * z }}>
          <svg viewBox="0 0 20 20" width="100%" height="100%">
            <path d="M2 3h16v11H8l-4 4v-4H2z" fill={it.color ?? '#ffd84a'} stroke="#444" strokeWidth="1" />
            <path d="M5 7h10M5 10h7" stroke="#444" strokeWidth="1" />
          </svg>
          {(sel || editing) && (
            <div className="ov-note-pop" onPointerDown={(e) => e.stopPropagation()}>
              <div className="ov-note-head">
                {it.author || 'Note'}
                <button className="icon-x" onClick={() => ctx.remove(it.id)} title="Delete note">
                  ×
                </button>
              </div>
              <textarea autoFocus={editing} value={it.text ?? ''} placeholder="Type your comment…" onChange={(e) => ctx.update(it.id, { text: e.target.value })} />
            </div>
          )}
        </div>
      );
    case 'text': {
      const fontFamily = it.font === 'Times' ? 'Times New Roman, Times, serif' : it.font === 'Courier' ? 'Courier New, monospace' : 'Helvetica, Arial, sans-serif';
      const tstyle = {
        fontFamily,
        fontSize: (it.fontSize ?? 12) * z,
        lineHeight: 1.2,
        color: it.color,
        fontWeight: it.bold ? 700 : 400,
        fontStyle: it.italic ? 'italic' : 'normal',
        textAlign: it.align ?? 'left',
        opacity: it.opacity,
        whiteSpace: it.nowrap ? 'pre' : 'pre-wrap',
      } as const;
      const cv = it.cover ? toView(vp, it.cover) : null;
      return (
        <>
          {cv && <div className="ov-cover" style={{ left: cv.left, top: cv.top, width: cv.width, height: cv.height, background: it.fill ?? '#fff' }} />}
          <div {...common} style={{ ...style, minHeight: v.height }}>
            {editing ? (
              <textarea
                className="ov-text-edit"
                autoFocus
                style={tstyle}
                value={it.text}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => ctx.update(it.id, { text: e.target.value })}
                onBlur={() => ctx.setEditing(null)}
                onKeyDown={(e) => e.key === 'Escape' && ctx.setEditing(null)}
              />
            ) : (
              <div className="ov-text" style={tstyle}>
                {it.text || <span className="placeholder">Double-click to type</span>}
              </div>
            )}
            {handle}
          </div>
        </>
      );
    }
    case 'image':
      return (
        <div {...common} style={style}>
          <img src={it.dataUrl} alt="" draggable={false} style={{ opacity: it.opacity }} />
          {handle}
        </div>
      );
    case 'stamp':
      return (
        <div {...common} style={style}>
          <div className="ov-stamp" style={{ color: it.color, borderColor: it.color, fontSize: Math.min(v.height * 0.45, v.width / Math.max(4, (it.text ?? '').length * 0.72)), opacity: it.opacity }}>
            {(it.text ?? '').toUpperCase()}
          </div>
          {handle}
        </div>
      );
    case 'redact':
      return (
        <div {...common} style={style}>
          {handle}
        </div>
      );
    case 'whiteout':
      return (
        <div {...common} style={{ ...style, background: it.fill ?? '#fff' }}>
          {handle}
        </div>
      );
    case 'link':
      return (
        <div {...common} style={style} title={it.url ?? `Go to page ${(it.destPage ?? 0) + 1}`}>
          <span className="ov-link-label">{it.url ? it.url.replace(/^https?:\/\//, '') : `→ p.${(it.destPage ?? 0) + 1}`}</span>
          {handle}
        </div>
      );
    case 'field':
      return (
        <div {...common} style={style} title={`${it.fieldType} field “${it.name}”`}>
          {editing ? (
            <input
              className="ov-field-name"
              autoFocus
              value={it.name}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => ctx.update(it.id, { name: e.target.value })}
              onBlur={() => ctx.setEditing(null)}
              onKeyDown={(e) => e.key === 'Enter' && ctx.setEditing(null)}
            />
          ) : (
            <span className="ov-field-label">{it.fieldType === 'checkbox' ? '☐' : it.fieldType === 'radio' ? '◯' : it.name}</span>
          )}
          {handle}
        </div>
      );
    default:
      return null;
  }
}
