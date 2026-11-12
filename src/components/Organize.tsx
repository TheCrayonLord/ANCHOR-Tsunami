import { useEffect, useState } from 'react';
import { RotateCcw, RotateCw, Trash2, Copy, FileOutput, FilePlus2, FileInput, Scissors, Crop, Replace, CheckSquare, Square as SquareIcon, Maximize2 } from 'lucide-react';
import type { PDFDocumentProxy } from '../lib/pdfjs';
import { Thumb } from './Sidebar';

interface Props {
  doc: PDFDocumentProxy;
  docKey: number;
  onReorder: (order: number[]) => void;
  onRotate: (pages: number[], delta: number) => void;
  onDelete: (pages: number[]) => void;
  onDuplicate: (pages: number[]) => void;
  onExtract: (pages: number[]) => void;
  onInsertBlank: (at: number) => void;
  onInsertFile: (at: number) => void;
  onReplace: (from: number) => void;
  onSplit: () => void;
  onCrop: (pages: number[]) => void;
  onResize: (pages: number[]) => void;
  onOpenPage: (page: number) => void;
}

export function Organize(p: Props) {
  const n = p.doc.numPages;
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [order, setOrder] = useState<number[]>(() => [...Array(n).keys()]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [size, setSize] = useState(150);

  useEffect(() => {
    setOrder([...Array(n).keys()]);
    setSel(new Set());
  }, [p.docKey, n]);

  const selected = [...sel].sort((a, b) => a - b);
  const target = selected.length ? selected : [...Array(n).keys()];
  const click = (i: number, e: React.MouseEvent) => {
    const s = new Set(e.metaKey || e.ctrlKey ? sel : []);
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) s.add(k);
    } else if ((e.metaKey || e.ctrlKey) && sel.has(i)) s.delete(i);
    else s.add(i);
    setSel(s);
    setAnchor(i);
  };

  const after = selected.length ? selected[selected.length - 1] + 1 : n;
  const none = selected.length === 0;

  return (
    <div className="organize">
      <div className="organize-bar">
        <button className="tb" onClick={() => setSel(sel.size === n ? new Set() : new Set([...Array(n).keys()]))} title="Select all / none">
          {sel.size === n ? <CheckSquare size={17} /> : <SquareIcon size={17} />}
          <span>{sel.size ? `${sel.size} selected` : 'Select all'}</span>
        </button>
        <span className="sep" />
        <button className="tb" onClick={() => p.onRotate(target, -90)} title="Rotate left"><RotateCcw size={17} /><span>Left</span></button>
        <button className="tb" onClick={() => p.onRotate(target, 90)} title="Rotate right"><RotateCw size={17} /><span>Right</span></button>
        <button className="tb" disabled={none} onClick={() => p.onDelete(selected)} title="Delete selected pages"><Trash2 size={17} /><span>Delete</span></button>
        <button className="tb" disabled={none} onClick={() => p.onDuplicate(selected)} title="Duplicate selected pages"><Copy size={17} /><span>Duplicate</span></button>
        <button className="tb" disabled={none} onClick={() => p.onExtract(selected)} title="Save selected pages as a new PDF"><FileOutput size={17} /><span>Extract</span></button>
        <span className="sep" />
        <button className="tb" onClick={() => p.onInsertBlank(after)} title="Insert a blank page"><FilePlus2 size={17} /><span>Blank page</span></button>
        <button className="tb" onClick={() => p.onInsertFile(after)} title="Insert pages from another file"><FileInput size={17} /><span>Insert file</span></button>
        <button className="tb" disabled={none} onClick={() => p.onReplace(selected[0])} title="Replace pages starting at the first selected page"><Replace size={17} /><span>Replace</span></button>
        <span className="sep" />
        <button className="tb" onClick={p.onSplit} title="Split into several files"><Scissors size={17} /><span>Split</span></button>
        <button className="tb" onClick={() => p.onCrop(target)} title="Crop pages"><Crop size={17} /><span>Crop</span></button>
        <button className="tb" onClick={() => p.onResize(target)} title="Change page size"><Maximize2 size={17} /><span>Page size</span></button>
        <span className="grow" />
        <label className="zoom-slider" title="Thumbnail size">
          <input type="range" min={90} max={300} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
      </div>
      <p className="muted small organize-hint">Click to select, Shift or Ctrl/⌘ to select several, drag to reorder, double-click to open a page.</p>
      <div className="organize-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 24}px, 1fr))` }}>
        {order.map((orig, pos) => (
          <div
            key={`${p.docKey}-${orig}`}
            className={`org-page ${sel.has(orig) ? 'on' : ''} ${dragging === orig ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragging(orig);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging === null || dragging === orig) return;
              setOrder((o) => {
                const a = o.filter((x) => x !== dragging);
                a.splice(a.indexOf(orig) + (o.indexOf(dragging) < o.indexOf(orig) ? 1 : 0), 0, dragging);
                return a;
              });
            }}
            onDragEnd={() => {
              setDragging(null);
              if (order.some((v, i) => v !== i)) p.onReorder(order);
            }}
            onClick={(e) => click(orig, e)}
            onDoubleClick={() => p.onOpenPage(orig + 1)}
          >
            <div className="org-thumb" style={{ width: size }}>
              <Thumb doc={p.doc} index={orig} width={size} />
              <div className="org-hover">
                <button title="Rotate left" onClick={(e) => { e.stopPropagation(); p.onRotate([orig], -90); }}><RotateCcw size={14} /></button>
                <button title="Rotate right" onClick={(e) => { e.stopPropagation(); p.onRotate([orig], 90); }}><RotateCw size={14} /></button>
                <button title="Delete page" onClick={(e) => { e.stopPropagation(); p.onDelete([orig]); }}><Trash2 size={14} /></button>
              </div>
            </div>
            <span className="org-num">{pos + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
