import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, GripVertical, Trash2, FileText, Image as ImageIcon } from 'lucide-react';

// ---------------------------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Generic form dialog
// ---------------------------------------------------------------------------------------------

export type Field =
  | { key: string; label: string; type: 'text' | 'password' | 'textarea' | 'color' | 'date'; placeholder?: string; help?: string; show?: (v: Values) => boolean }
  | { key: string; label: string; type: 'number' | 'range'; min?: number; max?: number; step?: number; help?: string; show?: (v: Values) => boolean }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; help?: string; show?: (v: Values) => boolean }
  | { key: string; label: string; type: 'checkbox'; help?: string; show?: (v: Values) => boolean }
  | { key: string; label: string; type: 'file'; accept: string; help?: string; show?: (v: Values) => boolean }
  | { key: string; label: string; type: 'heading'; show?: (v: Values) => boolean };

export type Values = Record<string, string | number | boolean | File | null>;

export interface FormSpec {
  title: string;
  intro?: ReactNode;
  fields: Field[];
  initial?: Values;
  submit?: string;
  validate?: (v: Values) => string | null;
  wide?: boolean;
}

export function FormDialog({ spec, onDone }: { spec: FormSpec; onDone: (v: Values | null) => void }) {
  const [v, setV] = useState<Values>(() => {
    const init: Values = {};
    for (const f of spec.fields) {
      if (f.type === 'heading') continue;
      init[f.key] = spec.initial?.[f.key] ?? (f.type === 'checkbox' ? false : f.type === 'number' || f.type === 'range' ? (f.min ?? 0) : f.type === 'select' ? f.options[0]?.value : f.type === 'color' ? '#000000' : f.type === 'file' ? null : '');
    }
    return init;
  });
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const set = (k: string, val: Values[string]) => setV((o) => ({ ...o, [k]: val }));
  const submit = () => {
    const e = spec.validate?.(v) ?? null;
    if (e) return setErr(e);
    onDone(v);
  };
  let firstAssigned = false;
  const ref = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null) => {
    if (!firstAssigned && el) {
      first.current = el;
      firstAssigned = true;
    }
  };
  return (
    <Modal
      title={spec.title}
      onClose={() => onDone(null)}
      wide={spec.wide}
      footer={
        <>
          {err && <span className="form-error">{err}</span>}
          <button className="btn ghost" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {spec.submit ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {spec.intro && <div className="form-intro">{spec.intro}</div>}
        {spec.fields.map((f) => {
          if (f.show && !f.show(v)) return null;
          if (f.type === 'heading') return <h3 key={f.key} className="form-heading">{f.label}</h3>;
          const id = `f-${f.key}`;
          const help = 'help' in f && f.help ? <small>{f.help}</small> : null;
          if (f.type === 'checkbox')
            return (
              <label key={f.key} className="form-check">
                <input ref={ref} type="checkbox" checked={!!v[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
                <span>{f.label}</span>
                {help}
              </label>
            );
          return (
            <label key={f.key} htmlFor={id} className="form-row">
              <span>{f.label}</span>
              {f.type === 'select' ? (
                <select id={id} ref={ref} value={String(v[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea id={id} ref={ref} rows={4} value={String(v[f.key] ?? '')} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
              ) : f.type === 'range' ? (
                <span className="range-row">
                  <input id={id} ref={ref} type="range" min={f.min} max={f.max} step={f.step} value={Number(v[f.key])} onChange={(e) => set(f.key, Number(e.target.value))} />
                  <output>{Number(v[f.key])}</output>
                </span>
              ) : f.type === 'file' ? (
                <input id={id} ref={ref} type="file" accept={f.accept} onChange={(e) => set(f.key, e.target.files?.[0] ?? null)} />
              ) : (
                <input
                  id={id}
                  ref={ref}
                  type={f.type}
                  value={f.type === 'number' ? Number(v[f.key]) : String(v[f.key] ?? '')}
                  placeholder={'placeholder' in f ? f.placeholder : undefined}
                  min={'min' in f ? f.min : undefined}
                  max={'max' in f ? f.max : undefined}
                  step={'step' in f ? f.step : undefined}
                  onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                />
              )}
              {help}
            </label>
          );
        })}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Signature dialog: draw, type or upload
// ---------------------------------------------------------------------------------------------

const SIG_FONTS = ['"Great Vibes", "Segoe Script", cursive', '"Dancing Script", "Brush Script MT", cursive', '"Caveat", "Bradley Hand", cursive', '"Homemade Apple", "Lucida Handwriting", cursive'];

export function SignatureDialog({ initialName, onDone }: { initialName: string; onDone: (r: { dataUrl: string; aspect: number } | null) => void }) {
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [name, setName] = useState(initialName);
  const [font, setFont] = useState(0);
  const [color, setColor] = useState('#13235b');
  const [upload, setUpload] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    if (!c || mode !== 'draw') return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawn.current = false;
    let last: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const b = c.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    };
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      last = pos(e);
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const p = pos(e);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2 + (e.pressure || 0.5) * 2.6;
      ctx.beginPath();
      ctx.moveTo(...last);
      ctx.lineTo(...p);
      ctx.stroke();
      last = p;
      drawn.current = true;
    };
    const up = () => (last = null);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
    };
  }, [mode, color]);

  const clear = () => {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    drawn.current = false;
  };

  const finish = async () => {
    if (mode === 'type') {
      try {
        await Promise.race([document.fonts.load(`96px ${SIG_FONTS[font].split(',')[0]}`), new Promise((r) => setTimeout(r, 1500))]);
      } catch {
        /* fall back to a local font */
      }
    }
    if (mode === 'draw') {
      if (!drawn.current) return;
      onDone(trimCanvas(canvas.current!));
    } else if (mode === 'type') {
      if (!name.trim()) return;
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      const size = 96;
      ctx.font = `${size}px ${SIG_FONTS[font]}`;
      c.width = Math.ceil(ctx.measureText(name).width + 40);
      c.height = Math.ceil(size * 1.6);
      ctx.font = `${size}px ${SIG_FONTS[font]}`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(name, 20, c.height / 2);
      onDone(trimCanvas(c));
    } else if (upload) {
      const img = new Image();
      img.onload = () => onDone({ dataUrl: upload, aspect: img.width / img.height });
      img.src = upload;
    }
  };

  return (
    <Modal
      title="Create signature"
      onClose={() => onDone(null)}
      footer={
        <>
          {mode === 'draw' && (
            <button className="btn ghost" onClick={clear}>
              Clear
            </button>
          )}
          <button className="btn ghost" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={finish}>
            Use signature
          </button>
        </>
      }
    >
      <div className="seg">
        {(['draw', 'type', 'upload'] as const).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {m === 'draw' ? 'Draw' : m === 'type' ? 'Type' : 'Image'}
          </button>
        ))}
        <label className="sig-color">
          Ink <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
      </div>
      {mode === 'draw' && (
        <div className="sig-pad-wrap">
          <canvas ref={canvas} className="sig-pad" />
          <div className="sig-line">Sign above the line</div>
        </div>
      )}
      {mode === 'type' && (
        <div className="sig-type">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus />
          <div className="sig-fonts">
            {SIG_FONTS.map((f, i) => (
              <button key={i} className={font === i ? 'on' : ''} style={{ fontFamily: f, color }} onClick={() => setFont(i)}>
                {name || 'Your name'}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === 'upload' && (
        <div className="sig-upload">
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setUpload(await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(f); }));
            }}
          />
          {upload && <img src={upload} alt="Signature preview" />}
          <small>A PNG with a transparent background looks best.</small>
        </div>
      )}
      <p className="muted small">Your signature stays on this device. It is placed on the page as an image.</p>
    </Modal>
  );
}

function trimCanvas(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d')!;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width,
    y1 = height,
    x2 = 0,
    y2 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 <= x1 || y2 <= y1) return { dataUrl: c.toDataURL('image/png'), aspect: width / height };
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + pad * 2;
  out.height = y2 - y1 + pad * 2;
  out.getContext('2d')!.drawImage(c, x1 - pad, y1 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), aspect: out.width / out.height };
}

// ---------------------------------------------------------------------------------------------
// Combine files
// ---------------------------------------------------------------------------------------------

export function CombineDialog({ initial, onDone }: { initial: File[]; onDone: (files: File[] | null) => void }) {
  const [files, setFiles] = useState<File[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const add = (list: FileList | null) => list && setFiles((f) => [...f, ...[...list].filter((x) => /pdf|png|jpe?g/i.test(x.type))]);
  return (
    <Modal
      title="Combine files"
      onClose={() => onDone(null)}
      footer={
        <>
          <label className="btn ghost">
            Add files…
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg" hidden onChange={(e) => add(e.target.files)} />
          </label>
          <button className="btn primary" disabled={files.length < 1} onClick={() => onDone(files)}>
            Combine {files.length} file{files.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p className="muted">Drag to set the order. PDFs and images (PNG, JPEG) are supported.</p>
      <ul className="combine-list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) add(e.dataTransfer.files); }}>
        {files.map((f, i) => (
          <li
            key={`${f.name}-${i}`}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx === null || dragIdx === i) return;
              setFiles((arr) => {
                const a = [...arr];
                const [m] = a.splice(dragIdx, 1);
                a.splice(i, 0, m);
                return a;
              });
              setDragIdx(i);
            }}
            onDragEnd={() => setDragIdx(null)}
            className={dragIdx === i ? 'dragging' : ''}
          >
            <GripVertical size={16} className="muted" />
            {f.type === 'application/pdf' ? <FileText size={16} /> : <ImageIcon size={16} />}
            <span className="grow">{f.name}</span>
            <span className="muted small">{(f.size / 1024).toFixed(0)} KB</span>
            <button className="icon-btn" onClick={() => setFiles((a) => a.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
        {!files.length && <li className="empty">Drop files here</li>}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Compare results
// ---------------------------------------------------------------------------------------------

import type { DiffPart } from '../lib/tools';

export function CompareView({ nameA, nameB, result, onClose }: { nameA: string; nameB: string; result: { page: number; parts: DiffPart[]; changes: number }[]; onClose: () => void }) {
  const total = result.reduce((a, r) => a + r.changes, 0);
  const [onlyChanged, setOnlyChanged] = useState(true);
  return (
    <Modal title="Compare documents" onClose={onClose} wide>
      <div className="compare-head">
        <span className="del-chip">{nameA}</span> → <span className="add-chip">{nameB}</span>
        <span className="grow" />
        <strong>{total}</strong>&nbsp;change{total === 1 ? '' : 's'}
        <label className="form-check inline">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only pages with changes
        </label>
      </div>
      <div className="compare-body">
        {result
          .filter((r) => !onlyChanged || r.changes)
          .map((r) => (
            <section key={r.page}>
              <h4>
                Page {r.page + 1} <span className="muted small">({r.changes} change{r.changes === 1 ? '' : 's'})</span>
              </h4>
              <p className="diff">
                {r.parts.map((p, i) => (p.type === 'same' ? <span key={i}>{p.text}</span> : p.type === 'add' ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
              </p>
            </section>
          ))}
        {total === 0 && <p className="muted">No text differences found.</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------------------------

export const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ + O', 'Open'],
  ['Ctrl/⌘ + S', 'Save'],
  ['Ctrl/⌘ + Shift + S', 'Save as'],
  ['Ctrl/⌘ + P', 'Print'],
  ['Ctrl/⌘ + F', 'Find'],
  ['Ctrl/⌘ + Z / Y', 'Undo / Redo'],
  ['Ctrl/⌘ + + / −', 'Zoom in / out'],
  ['Ctrl/⌘ + 0', 'Fit width'],
  ['Delete', 'Delete selected item'],
  ['Esc', 'Back to Select tool'],
  ['V / H', 'Select / Hand tool'],
  ['N / T / R / L', 'Note / Text / Rectangle / Line'],
  ['← → / PgUp PgDn', 'Previous / next page'],
];
