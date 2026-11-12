import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Plus, Trash2, ArrowUp, ArrowDown, Pencil, Download, Paperclip, Search, Highlighter, EraserIcon, MessageSquare } from 'lucide-react';
import type { PDFDocumentProxy } from '../lib/pdfjs';
import { findText, type TextMatch } from '../lib/pdfjs';
import type { BookmarkNode } from '../lib/ops';
import type { OverlayItem } from '../lib/types';

export type Panel = 'thumbs' | 'bookmarks' | 'comments' | 'attachments' | 'layers' | 'search';

interface Props {
  panel: Panel;
  doc: PDFDocumentProxy;
  docKey: number;
  page: number;
  goTo: (page: number) => void;
  items: OverlayItem[];
  selectItem: (id: string) => void;
  onSaveOutline: (tree: BookmarkNode[]) => void;
  onAddAttachment: () => void;
  onDownload: (data: Uint8Array, name: string) => void;
  onLayersChanged: (config: unknown) => void;
  onSearchHighlight: (q: string, opts: { caseSensitive: boolean; wholeWord: boolean }) => void;
  onMarkMatches: (matches: TextMatch[], kind: 'highlight' | 'redact') => void;
  ask: (title: string, label: string, initial?: string) => Promise<string | null>;
  searchSeed: number;
}

export function Sidebar(p: Props) {
  return (
    <div className="sidebar-panel">
      {p.panel === 'thumbs' && <Thumbnails {...p} />}
      {p.panel === 'bookmarks' && <Bookmarks {...p} />}
      {p.panel === 'comments' && <Comments {...p} />}
      {p.panel === 'attachments' && <Attachments {...p} />}
      {p.panel === 'layers' && <Layers {...p} />}
      {p.panel === 'search' && <SearchPanel {...p} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Thumbnails({ doc, docKey, page, goTo }: Props) {
  const n = doc.numPages;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [page]);
  return (
    <div className="thumbs" ref={listRef}>
      <h3 className="panel-title">Pages</h3>
      {Array.from({ length: n }, (_, i) => (
        <button key={`${docKey}-${i}`} data-page={i + 1} className={`thumb ${page === i + 1 ? 'on' : ''}`} onClick={() => goTo(i + 1)}>
          <Thumb doc={doc} index={i} width={132} />
          <span>{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

export function Thumb({ doc, index, width, rotation = 0 }: { doc: PDFDocumentProxy; index: number; width: number; rotation?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const vp1 = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const scale = (width / vp1.width) * Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const c = ref.current!;
      c.width = vp.width;
      c.height = vp.height;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      const t = page.render({ canvasContext: ctx, viewport: vp });
      task = t;
      await t.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, index, width, rotation]);
  return <canvas ref={ref} className="thumb-canvas" style={{ width }} />;
}

// ---------------------------------------------------------------------------------------------

interface OutlineItem {
  title: string;
  dest: unknown;
  url?: string | null;
  items: OutlineItem[];
}

async function destPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[] | null);
    if (!d) return null;
    const ref = d[0];
    return typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never);
  } catch {
    return null;
  }
}

async function toNodes(doc: PDFDocumentProxy, items: OutlineItem[]): Promise<BookmarkNode[]> {
  const out: BookmarkNode[] = [];
  for (const it of items) out.push({ title: it.title, page: (await destPage(doc, it.dest)) ?? 0, children: await toNodes(doc, it.items ?? []) });
  return out;
}

function Bookmarks({ doc, docKey, page, goTo, onSaveOutline, ask }: Props) {
  const [tree, setTree] = useState<BookmarkNode[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    doc.getOutline().then(async (o) => {
      const nodes = await toNodes(doc, (o ?? []) as OutlineItem[]);
      if (live) {
        setTree(nodes);
        setDirty(false);
      }
    });
    return () => {
      live = false;
    };
  }, [doc, docKey]);

  const mutate = (fn: (t: BookmarkNode[]) => void) => {
    const t = structuredClone(tree ?? []);
    fn(t);
    setTree(t);
    setDirty(true);
  };
  const at = (t: BookmarkNode[], path: number[]) => {
    let list = t;
    for (let i = 0; i < path.length - 1; i++) list = list[path[i]].children ??= [];
    return { list, idx: path[path.length - 1] };
  };

  const add = async (parent?: number[]) => {
    const title = await ask('New bookmark', `Title (links to page ${page})`, `Page ${page}`);
    if (!title) return;
    mutate((t) => {
      if (!parent) t.push({ title, page: page - 1 });
      else {
        const { list, idx } = at(t, parent);
        (list[idx].children ??= []).push({ title, page: page - 1 });
      }
    });
    if (parent) setOpen((s) => new Set(s).add(parent.join('.')));
  };

  const render = (nodes: BookmarkNode[], path: number[] = []) => (
    <ul className="outline">
      {nodes.map((n, i) => {
        const pth = [...path, i];
        const key = pth.join('.');
        const has = !!n.children?.length;
        const isOpen = open.has(key);
        return (
          <li key={key}>
            <div className="outline-row">
              <button className="twisty" onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(key)) x.delete(key); else x.add(key); return x; })} style={{ visibility: has ? 'visible' : 'hidden' }}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <button className="outline-title" onClick={() => goTo(n.page + 1)} title={`Page ${n.page + 1}`}>
                {n.title}
              </button>
              <span className="row-actions">
                <button title="Rename" onClick={async () => { const t = await ask('Rename bookmark', 'Title', n.title); if (t) mutate((tr) => { const { list, idx } = at(tr, pth); list[idx].title = t; }); }}><Pencil size={13} /></button>
                <button title="Set to current page" onClick={() => mutate((tr) => { const { list, idx } = at(tr, pth); list[idx].page = page - 1; })}>{page}</button>
                <button title="Add child" onClick={() => add(pth)}><Plus size={13} /></button>
                <button title="Move up" onClick={() => mutate((tr) => { const { list, idx } = at(tr, pth); if (idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]]; })}><ArrowUp size={13} /></button>
                <button title="Move down" onClick={() => mutate((tr) => { const { list, idx } = at(tr, pth); if (idx < list.length - 1) [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]]; })}><ArrowDown size={13} /></button>
                <button title="Delete" onClick={() => mutate((tr) => { const { list, idx } = at(tr, pth); list.splice(idx, 1); })}><Trash2 size={13} /></button>
              </span>
            </div>
            {has && isOpen && render(n.children!, pth)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      <h3 className="panel-title">
        Bookmarks
        <button className="icon-btn" title="Add bookmark for the current page" onClick={() => add()}>
          <Plus size={16} />
        </button>
      </h3>
      {tree === null ? <p className="muted pad">Loading…</p> : tree.length ? render(tree) : <p className="muted pad">No bookmarks yet. Use + to bookmark the current page.</p>}
      {dirty && (
        <div className="panel-actions">
          <button className="btn primary small" onClick={() => { onSaveOutline(tree ?? []); setDirty(false); }}>
            Save bookmarks
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface AnnotInfo {
  page: number;
  subtype: string;
  contents: string;
  author: string;
  color?: string;
  date?: string;
}

const SUBTYPE_LABEL: Record<string, string> = {
  Text: 'Note',
  FreeText: 'Text box',
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strikethrough',
  Squiggly: 'Squiggly',
  Ink: 'Drawing',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Line: 'Line',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  Stamp: 'Stamp',
  Caret: 'Insert text',
  FileAttachment: 'Attachment',
  Sound: 'Sound',
  Redact: 'Redaction',
};

function Comments({ doc, docKey, goTo, items, selectItem }: Props) {
  const [list, setList] = useState<AnnotInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      const out: AnnotInfo[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const anns = await (await doc.getPage(i)).getAnnotations();
        for (const a of anns) {
          if (!SUBTYPE_LABEL[a.subtype]) continue;
          const c = a.color ? `rgb(${a.color[0]},${a.color[1]},${a.color[2]})` : undefined;
          out.push({ page: i, subtype: a.subtype, contents: a.contentsObj?.str ?? a.contents ?? '', author: a.titleObj?.str ?? '', color: c, date: a.modificationDate ?? undefined });
        }
      }
      if (live) setList(out);
    })();
    return () => {
      live = false;
    };
  }, [doc, docKey]);
  const pending = items.filter((i) => ['note', 'rect', 'ellipse', 'line', 'arrow', 'stamp', 'highlight', 'underline', 'strikeout', 'squiggly', 'measure'].includes(i.kind));
  const f = filter.toLowerCase();
  const shown = (list ?? []).filter((a) => !f || `${a.contents} ${a.author} ${SUBTYPE_LABEL[a.subtype]}`.toLowerCase().includes(f));
  return (
    <div>
      <h3 className="panel-title">Comments</h3>
      <input className="panel-search" placeholder="Filter comments" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {pending.length > 0 && (
        <>
          <div className="group-label">Not saved yet</div>
          {pending.map((it) => (
            <button key={it.id} className="comment" onClick={() => { goTo(it.page + 1); selectItem(it.id); }}>
              <span className="dot" style={{ background: it.color }} />
              <span className="grow">
                <strong>{it.kind[0].toUpperCase() + it.kind.slice(1)}</strong> · p.{it.page + 1}
                {it.text && <span className="comment-text">{it.text}</span>}
              </span>
            </button>
          ))}
        </>
      )}
      <div className="group-label">In document</div>
      {list === null ? (
        <p className="muted pad">Loading…</p>
      ) : shown.length ? (
        shown.map((a, k) => (
          <button key={k} className="comment" onClick={() => goTo(a.page)}>
            <span className="dot" style={{ background: a.color ?? '#999' }} />
            <span className="grow">
              <strong>{SUBTYPE_LABEL[a.subtype]}</strong> · p.{a.page} {a.author && <span className="muted">· {a.author}</span>}
              {a.contents && <span className="comment-text">{a.contents}</span>}
            </span>
          </button>
        ))
      ) : (
        <p className="muted pad">
          <MessageSquare size={14} /> No comments in this document.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Attachments({ doc, docKey, onAddAttachment, onDownload }: Props) {
  const [list, setList] = useState<{ filename: string; content: Uint8Array; description?: string }[] | null>(null);
  useEffect(() => {
    doc.getAttachments().then((a: Record<string, { filename: string; content: Uint8Array; description?: string }> | null) => setList(a ? Object.values(a) : []));
  }, [doc, docKey]);
  return (
    <div>
      <h3 className="panel-title">
        Attachments
        <button className="icon-btn" title="Attach a file" onClick={onAddAttachment}>
          <Plus size={16} />
        </button>
      </h3>
      {list === null ? (
        <p className="muted pad">Loading…</p>
      ) : list.length ? (
        list.map((a, i) => (
          <div key={i} className="attach-row">
            <Paperclip size={14} />
            <span className="grow" title={a.description}>
              {a.filename}
              <span className="muted small"> {(a.content.length / 1024).toFixed(1)} KB</span>
            </span>
            <button className="icon-btn" title="Save attachment" onClick={() => onDownload(a.content, a.filename)}>
              <Download size={15} />
            </button>
          </div>
        ))
      ) : (
        <p className="muted pad">No files are attached to this PDF.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Layers({ doc, docKey, onLayersChanged }: Props) {
  const [cfg, setCfg] = useState<{ config: { setVisibility(id: string, v: boolean): void; isVisible(g: unknown): boolean; getGroup(id: string): unknown }; groups: { id: string; name: string }[] } | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    doc.getOptionalContentConfig().then((config) => {
      const groups: { id: string; name: string }[] = [];
      const order = (config as unknown as { getOrder(): unknown[] | null }).getOrder?.() ?? null;
      const ids = order ? order.flat(Infinity as 1).filter((x): x is string => typeof x === 'string') : [...(config as unknown as Iterable<[string, { name: string }]>)].map(([id]) => id);
      for (const id of ids) {
        const g = config.getGroup(id) as { name?: string } | null;
        if (g) groups.push({ id, name: g.name ?? id });
      }
      setCfg({ config: config as never, groups });
    });
  }, [doc, docKey]);
  return (
    <div>
      <h3 className="panel-title">Layers</h3>
      {!cfg ? (
        <p className="muted pad">Loading…</p>
      ) : cfg.groups.length ? (
        cfg.groups.map((g) => (
          <label key={g.id} className="form-check layer-row">
            <input
              type="checkbox"
              checked={cfg.config.isVisible(cfg.config.getGroup(g.id))}
              onChange={(e) => {
                cfg.config.setVisibility(g.id, e.target.checked);
                onLayersChanged(cfg.config);
                force((x) => x + 1);
              }}
            />
            <span>{g.name}</span>
          </label>
        ))
      ) : (
        <p className="muted pad">This document has no layers.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function SearchPanel({ doc, goTo, onSearchHighlight, onMarkMatches, searchSeed }: Props) {
  const [q, setQ] = useState('');
  const [cs, setCs] = useState(false);
  const [ww, setWw] = useState(false);
  const [re, setRe] = useState(false);
  const [res, setRes] = useState<TextMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [searchSeed]);
  const run = async () => {
    if (!q) return;
    setBusy(true);
    const r = await findText(doc, q, { caseSensitive: cs, wholeWord: ww, regex: re });
    setRes(r);
    setBusy(false);
    if (!re) onSearchHighlight(q, { caseSensitive: cs, wholeWord: ww });
  };
  return (
    <div>
      <h3 className="panel-title">Find</h3>
      <form className="search-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="search-box">
          <Search size={15} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text" aria-label="Search text" />
        </div>
        <div className="search-opts">
          <label><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Match case</label>
          <label><input type="checkbox" checked={ww} onChange={(e) => setWw(e.target.checked)} /> Whole words</label>
          <label><input type="checkbox" checked={re} onChange={(e) => setRe(e.target.checked)} /> Regex</label>
        </div>
      </form>
      {busy && <p className="muted pad">Searching…</p>}
      {res && !busy && (
        <>
          <div className="search-summary">
            {res.length} result{res.length === 1 ? '' : 's'}
            {res.length > 0 && (
              <span>
                <button className="btn tiny" onClick={() => onMarkMatches(res, 'highlight')} title="Highlight every result"><Highlighter size={13} /> Highlight all</button>
                <button className="btn tiny" onClick={() => onMarkMatches(res, 'redact')} title="Mark every result for redaction"><EraserIcon size={13} /> Redact all</button>
              </span>
            )}
          </div>
          <div className="results">
            {res.slice(0, 500).map((m, i) => (
              <button key={i} className="result" onClick={() => goTo(m.page + 1)}>
                <span className="muted small">p.{m.page + 1}</span> {m.context}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
