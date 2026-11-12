import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Icons from 'lucide-react';
import JSZip from 'jszip';
import * as ops from './lib/ops';
import * as tools from './lib/tools';
import { openDocument, getTextRuns, pageText, loadPlain, PII_PATTERNS, findText, pdfjsLib, type PDFDocumentProxy, type TextMatch } from './lib/pdfjs';
import type { OverlayItem, TextRun, FieldType } from './lib/types';
import { Viewer, type ViewerApi } from './components/Viewer';
import { PageOverlay, uid, type ItemTool, type OverlayContext, type ToolStyle } from './components/Overlay';
import { Sidebar, type Panel } from './components/Sidebar';
import { Organize } from './components/Organize';
import { FormDialog, SignatureDialog, CombineDialog, CompareView, Modal, SHORTCUTS, type FormSpec, type Values } from './components/Dialogs';
import { Logo } from './components/Logo';
import type { SignatureInfo } from './lib/signing';

type PjTool = 'pj-highlight' | 'pj-freetext' | 'pj-ink' | 'pj-image';
type Tool = 'select' | 'hand' | PjTool | ItemTool;
type Category = 'view' | 'comment' | 'edit' | 'organize' | 'forms' | 'sign' | 'protect' | 'convert' | 'tools';

const PJ_MODE: Record<PjTool, number> = {
  'pj-highlight': pdfjsLib.AnnotationEditorType.HIGHLIGHT,
  'pj-freetext': pdfjsLib.AnnotationEditorType.FREETEXT,
  'pj-ink': pdfjsLib.AnnotationEditorType.INK,
  'pj-image': pdfjsLib.AnnotationEditorType.STAMP,
};
const P = pdfjsLib.AnnotationEditorParamsType;

const STAMPS = ['Approved', 'Rejected', 'Draft', 'Final', 'Confidential', 'For Comment', 'Not Approved', 'Completed', 'Void', 'Received', 'Paid', 'Sign Here'];
const PAGE_SIZES: Record<string, [number, number]> = { Letter: [612, 792], Legal: [612, 1008], Tabloid: [792, 1224], A3: [841.89, 1190.55], A4: [595.28, 841.89], A5: [419.53, 595.28] };

interface Busy {
  label: string;
  progress?: number;
}
interface Toast {
  id: number;
  msg: string;
  kind?: 'error' | 'ok';
}

const store = {
  get: (k: string, d = '') => {
    try {
      return localStorage.getItem(`anchor.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`anchor.${k}`, v);
    } catch {
      /* storage blocked */
    }
  },
};

declare global {
  interface Window {
    showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
    __anchor?: unknown;
  }
}

export default function App() {
  // Document state ------------------------------------------------------------------------------
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [versions, setVersions] = useState<{ bytes: Uint8Array; label: string }[]>([]);
  const [vIndex, setVIndex] = useState(-1);
  const [savedIndex, setSavedIndex] = useState(0);
  const [fileName, setFileName] = useState('document.pdf');
  const fileHandle = useRef<FileSystemFileHandle | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [docKey, setDocKey] = useState(0);
  const [readOnly, setReadOnly] = useState<string | null>(null);

  // View state ----------------------------------------------------------------------------------
  const apiRef = useRef<ViewerApi | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<'view' | 'organize'>('view');
  const [category, setCategory] = useState<Category>('comment');
  const [tool, setTool] = useState<Tool>('select');
  const [panel, setPanel] = useState<Panel | null>('thumbs');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (store.get('theme') as 'light' | 'dark') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [invert, setInvert] = useState(false);
  const [spread, setSpread] = useState(0);
  const [scrollMode, setScrollMode] = useState(0);
  const [searchSeed, setSearchSeed] = useState(0);
  const [speaking, setSpeaking] = useState(false);

  // Editing state -------------------------------------------------------------------------------
  const [items, setItems] = useState<OverlayItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [style, setStyle] = useState<ToolStyle>({ color: '#e5484d', fill: null, width: 2, opacity: 1, fontSize: 12, font: 'Helvetica', bold: false, italic: false });
  const [stampLabel, setStampLabel] = useState('Approved');
  const [fieldType, setFieldType] = useState<FieldType>('text');
  const [signature, setSignature] = useState<{ dataUrl: string; aspect: number } | null>(() => {
    const s = store.get('signature');
    return s ? JSON.parse(s) : null;
  });
  const [initials, setInitials] = useState<{ dataUrl: string; aspect: number } | null>(() => {
    const s = store.get('initials');
    return s ? JSON.parse(s) : null;
  });
  const [signMode, setSignMode] = useState<'signature' | 'initials'>('signature');
  const [presetText, setPresetText] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; aspect: number; width?: number } | null>(null);
  const [author, setAuthor] = useState(() => store.get('author', 'Me'));
  const [measureScale, setMeasureScale] = useState({ unit: 'in', perPoint: 1 / 72 });

  // UI plumbing ---------------------------------------------------------------------------------
  const [busy, setBusy] = useState<Busy | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [dropping, setDropping] = useState(false);

  const toast = useCallback((msg: string, kind?: Toast['kind']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.set('theme', theme);
  }, [theme]);
  useEffect(() => store.set('author', author), [author]);
  useEffect(() => {
    document.title = bytes ? `${fileName} — ANCHOR Tsunami` : 'ANCHOR Tsunami';
  }, [bytes, fileName]);

  // Dialog helpers ------------------------------------------------------------------------------
  const form = useCallback(
    (spec: FormSpec) =>
      new Promise<Values | null>((resolve) =>
        setDialog(
          <FormDialog
            spec={spec}
            onDone={(v) => {
              setDialog(null);
              resolve(v);
            }}
          />,
        ),
      ),
    [],
  );
  const ask = useCallback(
    async (title: string, label: string, initial = '', type: 'text' | 'password' = 'text') => {
      const v = await form({ title, fields: [{ key: 'v', label, type }], initial: { v: initial } });
      return v ? String(v.v) : null;
    },
    [form],
  );
  const confirm = useCallback(
    (title: string, body: ReactNode, okLabel = 'Continue') =>
      new Promise<boolean>((resolve) =>
        setDialog(
          <Modal
            title={title}
            onClose={() => { setDialog(null); resolve(false); }}
            footer={
              <>
                <button className="btn ghost" onClick={() => { setDialog(null); resolve(false); }}>Cancel</button>
                <button className="btn primary" autoFocus onClick={() => { setDialog(null); resolve(true); }}>{okLabel}</button>
              </>
            }
          >
            {body}
          </Modal>,
        ),
      ),
    [],
  );

  const run = useCallback(
    async <T,>(label: string, fn: (progress: (p: number, l?: string) => void) => Promise<T>): Promise<T | undefined> => {
      setBusy({ label });
      try {
        return await fn((p, l) => setBusy({ label: l ?? label, progress: p }));
      } catch (e) {
        console.error(e);
        toast(`${label} failed: ${(e as Error).message}`, 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  // Loading -------------------------------------------------------------------------------------
  const showDoc = useCallback(async (b: Uint8Array, keepView = true) => {
    const prevPage = page;
    const prevScale = apiRef.current?.viewer.currentScaleValue;
    const d = await loadPlain(b);
    setDoc((old) => {
      old?.destroy();
      return d;
    });
    setDocKey((k) => k + 1);
    runsCache.current.clear();
    if (keepView) {
      const restore = () => {
        const v = apiRef.current?.viewer;
        if (!v) return;
        if (prevScale) v.currentScaleValue = prevScale;
        v.currentPageNumber = Math.min(prevPage, d.numPages);
      };
      apiRef.current?.eventBus.on('pagesinit', restore, { once: true } as never);
    }
    return d;
  }, [page]);

  const openBytes = useCallback(
    async (raw: Uint8Array, name: string, handle: FileSystemFileHandle | null = null) => {
      setBusy({ label: `Opening ${name}` });
      try {
        let working = raw;
        let ro: string | null = null;
        if (ops.isEncrypted(raw)) {
          const { doc: probe, password } = await openDocument(raw, (retry) => ask(retry ? 'Wrong password, try again' : 'Password required', `“${name}” is protected. Enter its password.`, '', 'password'));
          await probe.destroy();
          try {
            working = await ops.decrypt(raw, password ?? '');
            toast('This PDF was password protected. Protection is removed while you edit; use Protect → Password to add it again.');
          } catch {
            ro = 'This file is encrypted with a method ANCHOR Tsunami can display but not edit.';
            working = raw;
          }
        }
        const d = await (async () => {
          if (ro) {
            const { doc: x } = await openDocument(raw, () => ask('Password required', 'Enter the password', '', 'password'));
            return x;
          }
          return loadPlain(working);
        })();
        setDoc((old) => {
          old?.destroy();
          return d;
        });
        setDocKey((k) => k + 1);
        runsCache.current.clear();
        setBytes(working);
        setVersions([{ bytes: working, label: 'Opened' }]);
        setVIndex(0);
        setSavedIndex(0);
        setFileName(name.toLowerCase().endsWith('.pdf') ? name : `${tools.baseName(name)}.pdf`);
        fileHandle.current = handle;
        setItems([]);
        setSelectedId(null);
        setReadOnly(ro);
        setMode('view');
        setPage(1);
        if (/\/ByteRange\s*\[/.test(new TextDecoder('latin1').decode(working.subarray(0, Math.min(working.length, 30_000_000)))))
          void import('./lib/signing').then((m) => {
            const list = m.verifySignatures(working);
            if (!list.length) return;
            const bad = list.filter((x) => x.integrity === 'modified' || x.integrity === 'invalid').length;
            toast(bad ? `${bad} of ${list.length} digital signatures in this file are not valid. See Sign → Verify signatures.` : `This file has ${list.length} digital signature${list.length > 1 ? 's' : ''}. See Sign → Verify signatures.`, bad ? 'error' : undefined);
          });
      } catch (e) {
        if ((e as Error)?.name !== 'PasswordException') toast(`Could not open ${name}: ${(e as Error).message}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [ask, toast],
  );

  const openFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      const images = files.filter((f) => /image\/(png|jpe?g)/.test(f.type));
      const texts = files.filter((f) => f.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(f.name));
      if (pdfs.length === 1 && files.length === 1) return openBytes(await tools.readFile(pdfs[0]), pdfs[0].name);
      if (images.length === files.length) {
        const b = await run('Creating PDF from images', async () => ops.imagesToPdf(await Promise.all(images.map(async (f) => ({ bytes: await tools.readFile(f), type: f.type })))));
        if (b) openBytes(b, `${tools.baseName(images[0].name)}.pdf`);
        return;
      }
      if (texts.length === 1 && files.length === 1) {
        const b = await run('Creating PDF from text', async () => ops.textToPdf(await texts[0].text()));
        if (b) openBytes(b, `${tools.baseName(texts[0].name)}.pdf`);
        return;
      }
      if (pdfs.length + images.length === files.length) return combineFlow(files);
      toast('ANCHOR Tsunami opens PDF, PNG, JPEG and plain-text files.', 'error');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openBytes, run, toast],
  );

  const openDialog = useCallback(async () => {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF and images', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg'], 'text/plain': ['.txt'] } }] });
        const f = await h.getFile();
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return openBytes(await tools.readFile(f), f.name, h);
        return openFiles([f]);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    openFiles(await tools.pickFiles('application/pdf,image/png,image/jpeg,text/plain', true));
  }, [openBytes, openFiles]);

  // Committing edits ----------------------------------------------------------------------------
  const docRef = useRef(doc);
  docRef.current = doc;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;

  /** Current document bytes including form entries, pdf.js annotations and pending overlay items. */
  const snapshot = useCallback(async (opts: { includeItems?: boolean } = {}) => {
    let b = bytesRef.current!;
    const d = docRef.current;
    // Finish any drawing or text box that pdf.js is still editing so it gets saved.
    const ui = apiRef.current?.uiManager;
    if (ui && d) {
      try {
        ui.commitOrRemove();
        for (let i = 0; i < d.numPages; i++) ui.getLayer(i)?.commitOrRemove();
      } catch {
        /* nothing in progress */
      }
    }
    if (d && d.annotationStorage.size > 0) {
      try {
        b = await d.saveDocument();
      } catch (e) {
        console.warn('saveDocument failed', e);
      }
    }
    const pending = itemsRef.current.filter((i) => i.kind !== 'redact');
    if (opts.includeItems !== false && pending.length) b = await ops.applyItems(b, pending);
    return b;
  }, []);

  const hasPending = () => itemsRef.current.some((i) => i.kind !== 'redact') || (docRef.current?.annotationStorage.size ?? 0) > 0;

  const commit = useCallback(
    async (label: string, transform?: (b: Uint8Array) => Promise<Uint8Array>, opts: { keepView?: boolean; clearRedactions?: boolean } = {}) => {
      if (readOnly) {
        toast(readOnly, 'error');
        return false;
      }
      const result = await run(label, async () => {
        const b0 = await snapshot();
        return transform ? transform(b0) : b0;
      });
      if (!result) return false;
      setVersions((v) => [...v.slice(0, vIndex + 1), { bytes: result, label }].slice(-40));
      setVIndex((i) => Math.min(i + 1, 39));
      setBytes(result);
      setItems((its) => (opts.clearRedactions ? [] : its.filter((i) => i.kind === 'redact')));
      setSelectedId(null);
      setEditingId(null);
      await showDoc(result, opts.keepView !== false);
      return true;
    },
    [readOnly, run, snapshot, showDoc, toast, vIndex],
  );

  const undo = useCallback(async () => {
    if (itemsRef.current.length) {
      setItems((its) => its.slice(0, -1));
      return;
    }
    if (vIndex <= 0) return;
    const v = versions[vIndex - 1];
    setVIndex(vIndex - 1);
    setBytes(v.bytes);
    await showDoc(v.bytes);
    toast(`Undid: ${versions[vIndex].label}`);
  }, [vIndex, versions, showDoc, toast]);

  const redo = useCallback(async () => {
    if (vIndex >= versions.length - 1) return;
    const v = versions[vIndex + 1];
    setVIndex(vIndex + 1);
    setBytes(v.bytes);
    await showDoc(v.bytes);
    toast(`Redid: ${v.label}`);
  }, [vIndex, versions, showDoc, toast]);

  const save = useCallback(
    async (as = false) => {
      if (!bytes) return;
      const out = await run('Preparing file', () => snapshot());
      if (!out) return;
      if (itemsRef.current.some((i) => i.kind === 'redact')) toast('Redaction marks are not applied yet. Use Protect → Apply redactions to remove that content.', 'error');
      try {
        if (!as && fileHandle.current && 'createWritable' in fileHandle.current) {
          const w = await (fileHandle.current as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
          await w.write(out as BlobPart);
          await w.close();
          toast(`Saved ${fileName}`, 'ok');
        } else if (window.showSaveFilePicker) {
          const h = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
          const w = await (h as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
          await w.write(out as BlobPart);
          await w.close();
          fileHandle.current = h;
          setFileName(h.name);
          toast(`Saved ${h.name}`, 'ok');
        } else {
          tools.download(out, fileName);
        }
        setSavedIndex(vIndex);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          tools.download(out, fileName);
        }
      }
    },
    [bytes, fileName, run, snapshot, toast, vIndex],
  );

  const print = useCallback(async () => {
    const out = await run('Preparing to print', () => snapshot());
    if (out) tools.printPdf(out);
  }, [run, snapshot]);

  // Viewer controls -----------------------------------------------------------------------------
  const v = () => apiRef.current?.viewer;
  const goTo = useCallback((p: number) => {
    const viewer = apiRef.current?.viewer;
    if (viewer && viewer.pdfDocument) viewer.currentPageNumber = Math.max(1, Math.min(p, viewer.pagesCount));
    if (mode === 'organize') setMode('view');
  }, [mode]);
  const zoom = (val: string | number) => {
    const viewer = v();
    if (!viewer?.pdfDocument) return;
    if (val === 'in') viewer.increaseScale();
    else if (val === 'out') viewer.decreaseScale();
    else viewer.currentScaleValue = String(val);
  };
  const rotateView = (d: number) => {
    const viewer = v();
    if (viewer?.pdfDocument) viewer.pagesRotation = (viewer.pagesRotation + d + 360) % 360;
  };
  useEffect(() => {
    const viewer = v();
    if (viewer?.pdfDocument) viewer.spreadMode = spread;
  }, [spread, docKey]);
  useEffect(() => {
    const viewer = v();
    if (viewer?.pdfDocument) viewer.scrollMode = scrollMode;
  }, [scrollMode, docKey]);

  // The viewer is hidden while organizing; when it comes back, make it re-measure and re-render.
  useEffect(() => {
    if (mode !== 'view') return;
    const t = setTimeout(() => {
      const vw = v();
      if (!vw?.pdfDocument) return;
      const s = vw.currentScaleValue || 'auto';
      vw.currentScaleValue = s === 'page-fit' ? 'page-width' : 'page-fit';
      vw.currentScaleValue = s;
      vw.update();
    }, 30);
    return () => clearTimeout(t);
  }, [mode, docKey]);

  // pdf.js editor modes follow the selected tool.
  useEffect(() => {
    const viewer = v();
    if (!viewer?.pdfDocument) return;
    const m = tool in PJ_MODE ? PJ_MODE[tool as PjTool] : pdfjsLib.AnnotationEditorType.NONE;
    let done = false;
    const apply = () => {
      if (done) return;
      try {
        viewer.annotationEditorMode = { mode: m };
        done = true;
      } catch {
        /* the editor manager is created a moment after the document loads */
      }
    };
    apply();
    const bus = apiRef.current!.eventBus;
    bus.on('annotationeditoruimanager', apply);
    const t = setTimeout(apply, 500);
    return () => {
      clearTimeout(t);
      bus.off('annotationeditoruimanager', apply);
    };
  }, [tool, docKey]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !(tool in PJ_MODE)) return;
    const send = (type: number, value: unknown) => api.eventBus.dispatch('switchannotationeditorparams', { source: null, type, value });
    if (tool === 'pj-ink') {
      send(P.INK_COLOR, style.color);
      send(P.INK_THICKNESS, style.width);
      send(P.INK_OPACITY, style.opacity);
    } else if (tool === 'pj-freetext') {
      send(P.FREETEXT_COLOR, style.color);
      send(P.FREETEXT_SIZE, style.fontSize);
    } else if (tool === 'pj-highlight') {
      send(P.HIGHLIGHT_DEFAULT_COLOR, style.color);
      send(P.HIGHLIGHT_THICKNESS, Math.max(8, style.width * 6));
    }
  }, [tool, style, docKey]);

  // Text runs, cached per page.
  const runsCache = useRef(new Map<number, Promise<TextRun[]>>());
  const getRuns = useCallback((p: number) => {
    if (!runsCache.current.has(p)) runsCache.current.set(p, docRef.current!.getPage(p + 1).then(getTextRuns));
    return runsCache.current.get(p)!;
  }, []);

  // Items ---------------------------------------------------------------------------------------
  const addItem = useCallback((it: OverlayItem) => setItems((a) => [...a, it]), []);
  const updateItem = useCallback((id: string, patch: Partial<OverlayItem>) => setItems((a) => a.map((i) => (i.id === id ? { ...i, ...patch } : i))), []);
  const removeItem = useCallback((id: string) => {
    setItems((a) => a.filter((i) => i.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  // Changing style while an item is selected restyles it.
  const setStyleKey = <K extends keyof ToolStyle>(k: K, val: ToolStyle[K]) => {
    setStyle((s) => ({ ...s, [k]: val }));
    if (selected) {
      const map: Partial<Record<keyof ToolStyle, keyof OverlayItem>> = { color: 'color', fill: 'fill', width: 'width', opacity: 'opacity', fontSize: 'fontSize', font: 'font', bold: 'bold', italic: 'italic' };
      updateItem(selected.id, { [map[k]!]: val } as Partial<OverlayItem>);
    }
  };

  const askLink = useCallback(async () => {
    const r = await form({
      title: 'Create link',
      fields: [
        { key: 'type', label: 'Link to', type: 'select', options: [{ value: 'url', label: 'A web address' }, { value: 'page', label: 'A page in this document' }] },
        { key: 'url', label: 'Web address', type: 'text', placeholder: 'https://', show: (x) => x.type === 'url' },
        { key: 'page', label: 'Page number', type: 'number', min: 1, max: docRef.current?.numPages ?? 1, show: (x) => x.type === 'page' },
      ],
      initial: { type: 'url', url: 'https://', page: 1 },
      submit: 'Create link',
    });
    if (!r) return null;
    if (r.type === 'url') {
      const url = String(r.url).trim();
      return { url: /^[a-z]+:/i.test(url) ? url : `https://${url}` };
    }
    return { destPage: Math.max(0, Number(r.page) - 1) };
  }, [form]);

  const isItemTool = !['select', 'hand'].includes(tool) && !(tool in PJ_MODE);
  const overlayCtx: OverlayContext = {
    tool: isItemTool ? (tool as ItemTool) : null,
    style,
    stampLabel,
    fieldType,
    pendingImage,
    signature: signMode === 'initials' ? initials : signature,
    author,
    measureScale,
    getRuns,
    add: addItem,
    update: updateItem,
    remove: removeItem,
    select: setSelectedId,
    selectedId,
    editingId,
    setEditing: setEditingId,
    askLink,
    digitalSign: (pg, rect) => {
      setTool('select');
      void digitalSignFlow(pg, rect);
    },
    toast,
    passive: tool in PJ_MODE || tool === 'hand',
    presetText,
    clearPreset: () => {
      setPresetText(null);
      setTool('select');
    },
  };

  // Keyboard shortcuts --------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /input|textarea|select/i.test(t.tagName) || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openDialog();
      } else if (!bytes) return;
      else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        print();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPanel('search');
        setSearchSeed((s) => s + 1);
      } else if (typing) return;
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if ((docRef.current?.annotationStorage.size ?? 0) > 0 && !itemsRef.current.length) return; // let pdf.js undo its own edits
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoom('in');
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoom('out');
      } else if (mod && e.key === '0') {
        e.preventDefault();
        zoom('page-width');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        removeItem(selectedId);
      } else if (e.key === 'Escape') {
        setTool('select');
        setSelectedId(null);
        setEditingId(null);
      } else if (!mod && !e.altKey) {
        const map: Record<string, Tool> = { v: 'select', h: 'hand', n: 'note', t: 'text', r: 'rect', l: 'line', e: 'ellipse', a: 'arrow', d: 'pj-ink', u: 'pj-highlight' };
        if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
        else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          if (!(t.closest('.viewer-container') && e.key === 'PageDown')) goTo(page + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(page - 1);
        else if (e.key === 'Home') goTo(1);
        else if (e.key === 'End') goTo(doc?.numPages ?? 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (bytes && (vIndex !== savedIndex || itemsRef.current.length)) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [bytes, vIndex, savedIndex]);

  // Drag and drop files onto the window.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setDropping(true);
      }
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setDropping(false);
      openFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFiles]);

  // Open a file passed through the PWA file handler or ?url=.
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (p) => {
      if (p.files?.[0]) {
        const f = await p.files[0].getFile();
        openBytes(await tools.readFile(f), f.name, p.files[0]);
      }
    });
    const url = new URLSearchParams(location.search).get('url');
    if (url)
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => openBytes(new Uint8Array(b), decodeURIComponent(url.split('/').pop() || 'document.pdf')))
        .catch(() => toast('Could not load the linked PDF.', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =============================================================================================
  // Actions
  // =============================================================================================

  const allPages = () => [...Array(doc?.numPages ?? 0).keys()];
  const pagesField = (label = 'Pages') => ({ key: 'pages', label, type: 'text' as const, placeholder: `All pages, or e.g. 1-3, 5 (of ${doc?.numPages ?? 0})` });
  const parsePages = (v: Values) => {
    const s = String(v.pages ?? '').trim();
    if (!s) return undefined;
    const list = ops.parsePageList(s, doc?.numPages ?? 0);
    return list.length ? list : undefined;
  };

  async function combineFlow(initial: File[] = []) {
    const files = await new Promise<File[] | null>((resolve) => setDialog(<CombineDialog initial={initial} onDone={(f) => { setDialog(null); resolve(f); }} />));
    if (!files?.length) return;
    const b = await run('Combining files', async () => ops.combine(await Promise.all(files.map(async (f) => ({ bytes: await tools.readFile(f), type: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'image/png') })))));
    if (b) openBytes(b, files.length > 1 ? 'Combined.pdf' : files[0].name);
  }

  async function createBlank() {
    const r = await form({
      title: 'New blank PDF',
      fields: [
        { key: 'size', label: 'Page size', type: 'select', options: Object.keys(PAGE_SIZES).map((k) => ({ value: k, label: k })) },
        { key: 'orient', label: 'Orientation', type: 'select', options: [{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }] },
        { key: 'pages', label: 'Number of pages', type: 'number', min: 1, max: 500 },
      ],
      initial: { size: 'Letter', orient: 'p', pages: 1 },
      submit: 'Create',
    });
    if (!r) return;
    let [w, h] = PAGE_SIZES[String(r.size)];
    if (r.orient === 'l') [w, h] = [h, w];
    openBytes(await ops.blankDocument(Number(r.pages) || 1, [w, h]), 'Untitled.pdf');
  }

  async function createFromText() {
    const r = await form({ title: 'Create PDF from text', fields: [{ key: 'text', label: 'Text', type: 'textarea' }, { key: 'size', label: 'Font size', type: 'number', min: 6, max: 36 }], initial: { size: 11 }, submit: 'Create PDF', wide: true });
    if (r && String(r.text).trim()) openBytes(await ops.textToPdf(String(r.text), { fontSize: Number(r.size) }), 'Text.pdf');
  }

  async function watermark() {
    const r = await form({
      title: 'Add watermark',
      fields: [
        { key: 'kind', label: 'Type', type: 'select', options: [{ value: 'text', label: 'Text' }, { value: 'image', label: 'Image' }] },
        { key: 'text', label: 'Text', type: 'text', show: (x) => x.kind === 'text' },
        { key: 'image', label: 'Image', type: 'file', accept: 'image/png,image/jpeg', show: (x) => x.kind === 'image' },
        { key: 'size', label: 'Font size', type: 'number', min: 8, max: 300, show: (x) => x.kind === 'text' },
        { key: 'scale', label: 'Image width (% of page)', type: 'range', min: 5, max: 100, step: 5, show: (x) => x.kind === 'image' },
        { key: 'color', label: 'Colour', type: 'color', show: (x) => x.kind === 'text' },
        { key: 'opacity', label: 'Opacity (%)', type: 'range', min: 5, max: 100, step: 5 },
        { key: 'rotation', label: 'Rotation (°)', type: 'range', min: -90, max: 90, step: 5 },
        { key: 'behind', label: 'Place behind page content', type: 'checkbox' },
        pagesField(),
      ],
      initial: { kind: 'text', text: 'CONFIDENTIAL', size: 72, scale: 50, color: '#d03b3b', opacity: 25, rotation: 45, behind: false },
      submit: 'Add watermark',
    });
    if (!r) return;
    const img = r.kind === 'image' && r.image instanceof File ? await tools.fileToDataUrl(r.image) : undefined;
    if (r.kind === 'image' && !img) return toast('Choose an image for the watermark.', 'error');
    commit('Add watermark', (b) => ops.addWatermark(b, { text: String(r.text), imageDataUrl: img, fontSize: Number(r.size), color: String(r.color), opacity: Number(r.opacity) / 100, rotation: Number(r.rotation), behind: !!r.behind, scale: Number(r.scale) / 100, pages: parsePages(r) }));
  }

  async function headerFooter(preset?: 'numbers' | 'bates') {
    const r = await form({
      title: preset === 'bates' ? 'Bates numbering' : preset === 'numbers' ? 'Page numbers' : 'Header & footer',
      intro: <span>Use <code>{'{page}'}</code>, <code>{'{pages}'}</code>, <code>{'{date}'}</code>, <code>{'{file}'}</code> and <code>{'{bates}'}</code> in any box.</span>,
      fields: [
        { key: 'h', label: 'Header', type: 'heading' },
        { key: 'topLeft', label: 'Left', type: 'text' },
        { key: 'topCenter', label: 'Centre', type: 'text' },
        { key: 'topRight', label: 'Right', type: 'text' },
        { key: 'f', label: 'Footer', type: 'heading' },
        { key: 'bottomLeft', label: 'Left', type: 'text' },
        { key: 'bottomCenter', label: 'Centre', type: 'text' },
        { key: 'bottomRight', label: 'Right', type: 'text' },
        { key: 's', label: 'Style', type: 'heading' },
        { key: 'fontSize', label: 'Font size', type: 'number', min: 5, max: 48 },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'margin', label: 'Margin (pt)', type: 'number', min: 0, max: 144 },
        { key: 'startNumber', label: 'First page number', type: 'number', min: 0, max: 99999 },
        { key: 'batesPrefix', label: 'Bates prefix', type: 'text' },
        { key: 'batesStart', label: 'Bates start', type: 'number', min: 0, max: 99999999 },
        { key: 'batesDigits', label: 'Bates digits', type: 'number', min: 1, max: 12 },
        pagesField(),
      ],
      initial: {
        bottomCenter: preset === 'numbers' ? 'Page {page} of {pages}' : '',
        bottomRight: preset === 'bates' ? '{bates}' : '',
        fontSize: 9,
        color: '#333333',
        margin: 28,
        startNumber: 1,
        batesPrefix: preset === 'bates' ? 'DOC' : '',
        batesStart: 1,
        batesDigits: 6,
      },
      submit: 'Apply',
    });
    if (!r) return;
    commit('Add header/footer', (b) =>
      ops.addHeaderFooter(b, {
        topLeft: String(r.topLeft), topCenter: String(r.topCenter), topRight: String(r.topRight),
        bottomLeft: String(r.bottomLeft), bottomCenter: String(r.bottomCenter), bottomRight: String(r.bottomRight),
        fontSize: Number(r.fontSize), color: String(r.color), margin: Number(r.margin), startNumber: Number(r.startNumber),
        batesPrefix: String(r.batesPrefix), batesStart: Number(r.batesStart), batesDigits: Number(r.batesDigits),
        fileName, pages: parsePages(r),
      }),
    );
  }

  async function background() {
    const r = await form({ title: 'Page background', fields: [{ key: 'color', label: 'Colour', type: 'color' }, pagesField()], initial: { color: '#fff8e1' }, submit: 'Apply' });
    if (r) commit('Add background', (b) => ops.addBackground(b, String(r.color), parsePages(r)));
  }

  async function cropFlow(pages: number[]) {
    const r = await form({
      title: `Crop ${pages.length === doc?.numPages ? 'all pages' : `${pages.length} page${pages.length === 1 ? '' : 's'}`}`,
      intro: 'Margins to trim, in points (72 pt = 1 inch).',
      fields: [
        { key: 'top', label: 'Top', type: 'number', min: 0, max: 2000 },
        { key: 'bottom', label: 'Bottom', type: 'number', min: 0, max: 2000 },
        { key: 'left', label: 'Left', type: 'number', min: 0, max: 2000 },
        { key: 'right', label: 'Right', type: 'number', min: 0, max: 2000 },
      ],
      initial: { top: 36, bottom: 36, left: 36, right: 36 },
      submit: 'Crop',
    });
    if (r) commit('Crop pages', (b) => ops.cropPages(b, pages, { top: Number(r.top), bottom: Number(r.bottom), left: Number(r.left), right: Number(r.right) }));
  }

  async function resizeFlow(pages: number[]) {
    const r = await form({
      title: 'Change page size',
      fields: [
        { key: 'size', label: 'Page size', type: 'select', options: Object.keys(PAGE_SIZES).map((k) => ({ value: k, label: k })) },
        { key: 'orient', label: 'Orientation', type: 'select', options: [{ value: 'p', label: 'Portrait' }, { value: 'l', label: 'Landscape' }] },
      ],
      initial: { size: 'A4', orient: 'p' },
      submit: 'Resize',
    });
    if (!r) return;
    let [w, h] = PAGE_SIZES[String(r.size)];
    if (r.orient === 'l') [w, h] = [h, w];
    commit('Resize pages', (b) => ops.resizePages(b, pages, [w, h]));
  }

  async function splitFlow() {
    const n = doc?.numPages ?? 0;
    const r = await form({
      title: 'Split document',
      fields: [
        { key: 'how', label: 'Split', type: 'select', options: [{ value: 'every', label: 'Every N pages' }, { value: 'ranges', label: 'By page ranges' }, { value: 'size', label: 'Into N equal parts' }] },
        { key: 'n', label: 'N', type: 'number', min: 1, max: n, show: (x) => x.how !== 'ranges' },
        { key: 'ranges', label: 'Ranges (one file per range, separated by ;)', type: 'text', placeholder: '1-3; 4-6; 7-', show: (x) => x.how === 'ranges' },
      ],
      initial: { how: 'every', n: 1, ranges: '' },
      submit: 'Split',
    });
    if (!r) return;
    let ranges: number[][];
    if (r.how === 'ranges') ranges = String(r.ranges).split(';').map((s) => ops.parsePageList(s, n)).filter((x) => x.length);
    else if (r.how === 'size') ranges = ops.rangesEveryN(n, Math.ceil(n / Math.max(1, Number(r.n))));
    else ranges = ops.rangesEveryN(n, Math.max(1, Number(r.n)));
    if (!ranges.length) return toast('No pages matched those ranges.', 'error');
    await run('Splitting', async () => {
      const src = await snapshot();
      const parts = await ops.splitDocument(src, ranges);
      const zip = new JSZip();
      const base = tools.baseName(fileName);
      parts.forEach((p, i) => zip.file(`${base}-part${String(i + 1).padStart(2, '0')}.pdf`, p));
      tools.download(await zip.generateAsync({ type: 'blob' }), `${base}-split.zip`, 'application/zip');
    });
    toast(`Split into ${ranges.length} files (downloaded as a ZIP).`, 'ok');
  }

  async function insertFileFlow(at: number) {
    const [f] = await tools.pickFiles('application/pdf,image/png,image/jpeg');
    if (!f) return;
    const data = await tools.readFile(f);
    const other = f.type === 'application/pdf' ? data : await ops.imagesToPdf([{ bytes: data, type: f.type }]);
    commit(`Insert ${f.name}`, (b) => ops.insertDocument(b, other, at));
  }

  async function replaceFlow(from: number) {
    const [f] = await tools.pickFiles('application/pdf');
    if (!f) return;
    const data = await tools.readFile(f);
    commit(`Replace pages with ${f.name}`, (b) => ops.replacePages(b, data, from));
  }

  async function extractFlow(pages: number[]) {
    const out = await run('Extracting pages', async () => ops.extractPages(await snapshot(), pages));
    if (out) tools.download(out, `${tools.baseName(fileName)}-pages.pdf`);
  }

  async function signFlow(which: 'signature' | 'initials', recreate = false) {
    setSignMode(which);
    const current = which === 'initials' ? initials : signature;
    if (!current || recreate) {
      const defaultName = which === 'initials' ? author.split(/\s+/).map((w) => w[0] ?? '').join('').toUpperCase() : author === 'Me' ? '' : author;
      const res = await new Promise<{ dataUrl: string; aspect: number } | null>((resolve) => setDialog(<SignatureDialog initialName={defaultName} onDone={(r) => { setDialog(null); resolve(r); }} />));
      if (!res) return;
      if (which === 'initials') {
        setInitials(res);
        store.set('initials', JSON.stringify(res));
      } else {
        setSignature(res);
        store.set('signature', JSON.stringify(res));
      }
    }
    setTool('sign');
    toast(`Click on the page to place your ${which}. Drag the corner to resize.`);
  }

  // Certificate signatures --------------------------------------------------------------------
  const digitalId = useRef<{ name: string; bytes: Uint8Array } | null>(null);

  function startDigitalSign() {
    if (readOnly) return toast(readOnly, 'error');
    setTool('digisig');
    toast('Drag a box where the signature should appear, or click for a standard size.');
  }

  async function digitalSignFlow(pageIndex: number, rect: { x: number; y: number; w: number; h: number }) {
    const signing = await import('./lib/signing');
    const r = await form({
      title: 'Sign with a certificate',
      intro: (
        <>
          Signs the document with your digital ID (a .p12 or .pfx file). Anyone can then check who signed it and whether it changed afterwards.
          {hasPending() ? ' Your unsaved changes are applied first.' : ''} <strong>Sign last:</strong> any edit made after signing breaks the signature.
        </>
      ),
      fields: [
        ...(digitalId.current ? [{ key: 'useLast', label: `Use ${digitalId.current.name}`, type: 'checkbox' as const }] : []),
        { key: 'file', label: 'Digital ID file', type: 'file', accept: '.p12,.pfx,application/x-pkcs12', show: (x) => !x.useLast },
        { key: 'password', label: 'Digital ID password', type: 'password' },
        { key: 'reason', label: 'Reason (optional)', type: 'text', placeholder: 'I approve this document' },
        { key: 'location', label: 'Location (optional)', type: 'text' },
        ...(signature ? [{ key: 'image', label: 'Show my handwritten signature too', type: 'checkbox' as const }] : []),
        { key: 'invisible', label: 'Invisible signature (no box on the page)', type: 'checkbox' },
      ],
      initial: { useLast: !!digitalId.current, image: !!signature, invisible: false },
      validate: (x) => (!x.useLast && !x.file ? 'Choose your digital ID file, or create one under Sign → Create digital ID.' : null),
      submit: 'Sign',
    });
    if (!r) return;
    let idFile = digitalId.current;
    if (!r.useLast && r.file instanceof File) idFile = { name: r.file.name, bytes: await tools.readFile(r.file) };
    if (!idFile) return;
    let id: Awaited<ReturnType<typeof signing.readDigitalId>>;
    try {
      id = signing.readDigitalId(idFile.bytes, String(r.password ?? ''));
    } catch (e) {
      const msg = (e as Error).message;
      return toast(/mac|password|invalid/i.test(msg) ? 'That password does not open this digital ID.' : `Could not read the digital ID: ${msg}`, 'error');
    }
    digitalId.current = idFile;
    if (id.validTo < new Date()) toast(`The certificate for ${id.name} expired on ${id.validTo.toLocaleDateString()}. The signature will show as made with an expired certificate.`, 'error');
    const ok = await commit(`Digitally signed by ${id.name}`, (b) =>
      signing.signPdf(b, id, {
        page: pageIndex,
        rect: r.invisible ? undefined : rect,
        reason: String(r.reason || '') || undefined,
        location: String(r.location || '') || undefined,
        imageDataUrl: r.image && signature ? signature.dataUrl : undefined,
      }),
    );
    if (ok) toast(`Signed by ${id.name}. Save the file now; further edits would break the signature.`, 'ok');
  }

  async function createDigitalIdFlow() {
    const r = await form({
      title: 'Create a digital ID',
      intro: 'Makes a self-signed certificate and saves it as a password-protected .p12 file you can reuse in ANCHOR Tsunami and other PDF apps. Self-signed IDs prove the document has not changed, but readers must trust you directly; for legally recognised signatures use an ID from a certificate authority.',
      fields: [
        { key: 'name', label: 'Your name', type: 'text' },
        { key: 'email', label: 'Email (optional)', type: 'text' },
        { key: 'org', label: 'Organisation (optional)', type: 'text' },
        { key: 'years', label: 'Valid for (years)', type: 'number', min: 1, max: 20 },
        { key: 'password', label: 'Password', type: 'password' },
        { key: 'confirm', label: 'Confirm password', type: 'password' },
      ],
      initial: { name: author === 'Me' ? '' : author, years: 5 },
      validate: (x) => (!String(x.name).trim() ? 'Enter your name.' : String(x.password).length < 6 ? 'Use a password of at least 6 characters.' : x.password !== x.confirm ? 'The passwords do not match.' : null),
      submit: 'Create and download',
    });
    if (!r) return;
    const signing = await import('./lib/signing');
    const bytes = await run('Creating digital ID', () =>
      signing.createDigitalId({ name: String(r.name).trim(), email: String(r.email || '').trim() || undefined, organization: String(r.org || '').trim() || undefined, years: Number(r.years) || 5, password: String(r.password) }),
    );
    if (!bytes) return;
    const fname = `${String(r.name).trim().replace(/[^\w.-]+/g, '_')}.p12`;
    tools.download(bytes, fname, 'application/x-pkcs12');
    digitalId.current = { name: fname, bytes };
    toast(`Digital ID saved as ${fname}. Keep it and its password safe.`, 'ok');
  }

  async function verifyFlow() {
    const b = bytesRef.current;
    if (!b) return;
    const signing = await import('./lib/signing');
    const list: SignatureInfo[] = signing.verifySignatures(b);
    const label: Record<SignatureInfo['integrity'], string> = {
      valid: 'Valid: the signed content has not changed',
      modified: 'Broken: the document was changed after signing',
      invalid: 'Invalid: the signature does not match the certificate',
      unknown: 'Could not be checked',
    };
    setDialog(
      <Modal title="Digital signatures" onClose={() => setDialog(null)} wide>
        {!list.length ? (
          <p>This document has no digital signatures.</p>
        ) : (
          <ul className="sig-list">
            {list.map((s, i) => (
              <li key={i} className={`sig-${s.integrity}`}>
                <div className="sig-head">
                  {s.integrity === 'valid' ? <Icons.ShieldCheck size={20} /> : s.integrity === 'unknown' ? <Icons.ShieldQuestion size={20} /> : <Icons.ShieldAlert size={20} />}
                  <strong>{s.signer}</strong>
                  {s.email && <span className="muted">&lt;{s.email}&gt;</span>}
                </div>
                <div>{label[s.integrity]}</div>
                {s.integrity === 'valid' && !s.coversWholeFile && <div className="muted">The document was changed after this signature (for example by a later signature or edit). The signed version is intact.</div>}
                <div className="muted">
                  {s.signedAt && <>Signed {s.signedAt.toLocaleString()}. </>}
                  Issued by {s.issuer}
                  {s.selfSigned ? ' (self-signed: the signer vouches for their own identity)' : ''}.{!s.certValidNow && ' The certificate is not valid today (expired or not yet valid).'}
                </div>
                {(s.reason || s.location) && <div className="muted">{[s.reason && `Reason: ${s.reason}`, s.location && `Location: ${s.location}`].filter(Boolean).join(' · ')}</div>}
                {s.note && <div className="muted">{s.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </Modal>,
    );
  }

  async function chooseImage() {
    const [f] = await tools.pickFiles('image/png,image/jpeg');
    if (!f) return;
    const dataUrl = await tools.fileToDataUrl(f);
    const img = new Image();
    img.onload = () => {
      setPendingImage({ dataUrl, aspect: img.width / img.height });
      setTool('image');
      toast('Click on the page to place the image, or drag to size it.');
    };
    img.src = dataUrl;
  }

  function addDateText() {
    setPresetText(new Date().toLocaleDateString());
    setStyle((st) => ({ ...st, color: '#000000', fontSize: 12 }));
    setTool('text');
    toast('Click where the date should go.');
  }

  function placeMark(kind: 'check' | 'cross' | 'dot') {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d')!;
    g.strokeStyle = g.fillStyle = '#111111';
    g.lineWidth = 12;
    g.lineCap = g.lineJoin = 'round';
    g.beginPath();
    if (kind === 'check') {
      g.moveTo(14, 52);
      g.lineTo(38, 78);
      g.lineTo(84, 18);
      g.stroke();
    } else if (kind === 'cross') {
      g.moveTo(18, 18);
      g.lineTo(78, 78);
      g.moveTo(78, 18);
      g.lineTo(18, 78);
      g.stroke();
    } else {
      g.arc(48, 48, 26, 0, Math.PI * 2);
      g.fill();
    }
    setPendingImage({ dataUrl: c.toDataURL('image/png'), aspect: 1, width: 14 });
    setTool('image');
    toast('Click to place it. Drag the corner to resize.');
  }

  async function protectFlow() {
    const r = await form({
      title: 'Protect with password',
      intro: 'Encrypts the file with AES. The open password is needed to view it; the permissions password is needed to change the restrictions.',
      fields: [
        { key: 'user', label: 'Open password (optional)', type: 'password' },
        { key: 'owner', label: 'Permissions password', type: 'password' },
        { key: 'h', label: 'Allow', type: 'heading' },
        { key: 'printing', label: 'Printing', type: 'select', options: [{ value: 'highResolution', label: 'High resolution' }, { value: 'lowResolution', label: 'Low resolution' }, { value: 'none', label: 'Not allowed' }] },
        { key: 'copying', label: 'Copying text and images', type: 'checkbox' },
        { key: 'modifying', label: 'Changing the document', type: 'checkbox' },
        { key: 'annotating', label: 'Commenting', type: 'checkbox' },
        { key: 'fillingForms', label: 'Filling in forms', type: 'checkbox' },
        { key: 'documentAssembly', label: 'Inserting, deleting and rotating pages', type: 'checkbox' },
        { key: 'contentAccessibility', label: 'Screen readers', type: 'checkbox' },
      ],
      initial: { printing: 'highResolution', copying: true, modifying: false, annotating: true, fillingForms: true, documentAssembly: false, contentAccessibility: true },
      validate: (x) => (!x.owner && !x.user ? 'Set at least one password.' : null),
      submit: 'Protect and save',
    });
    if (!r) return;
    const out = await run('Encrypting', async () =>
      ops.encrypt(await snapshot(), {
        userPassword: String(r.user || ''),
        ownerPassword: String(r.owner || r.user),
        printing: r.printing as 'none',
        copying: !!r.copying,
        modifying: !!r.modifying,
        annotating: !!r.annotating,
        fillingForms: !!r.fillingForms,
        documentAssembly: !!r.documentAssembly,
        contentAccessibility: !!r.contentAccessibility,
      }),
    );
    if (out) {
      tools.download(out, `${tools.baseName(fileName)}-protected.pdf`);
      toast('Protected copy downloaded. You can keep editing the unprotected version here.', 'ok');
    }
  }

  async function applyRedactionsFlow() {
    const marks = items.filter((i) => i.kind === 'redact');
    if (!marks.length) return toast('Mark areas with the Redact tool first, or use Find text to redact.', 'error');
    const r = await form({
      title: `Apply ${marks.length} redaction${marks.length === 1 ? '' : 's'}`,
      intro: (
        <span>
          Marked content is <strong>permanently removed</strong>. Affected pages are flattened to images, so their text, images and comments cannot be recovered. Text outside the marks stays searchable.
        </span>
      ),
      fields: [
        { key: 'fill', label: 'Box colour', type: 'color' },
        { key: 'strip', label: 'Also remove document metadata (title, author, etc.)', type: 'checkbox' },
        { key: 'dpi', label: 'Resolution of redacted pages (dpi)', type: 'select', options: [{ value: '150', label: '150 (smaller)' }, { value: '200', label: '200' }, { value: '300', label: '300 (sharper)' }] },
      ],
      initial: { fill: '#000000', strip: true, dpi: '200' },
      submit: 'Redact permanently',
    });
    if (!r) return;
    commit('Apply redactions', (b) => tools.applyRedactions(b, marks, { fill: String(r.fill), stripMetadata: !!r.strip, dpi: Number(r.dpi) }, (p, l) => setBusy({ label: l ?? 'Redacting', progress: p })), { clearRedactions: true });
  }

  async function redactPatternsFlow() {
    const r = await form({
      title: 'Find text to redact',
      fields: [
        { key: 'text', label: 'Words or phrases (one per line)', type: 'textarea' },
        ...Object.keys(PII_PATTERNS).map((k) => ({ key: k, label: k, type: 'checkbox' as const })),
      ],
      submit: 'Mark for redaction',
    });
    if (!r || !doc) return;
    const res = await run('Searching', async () => {
      const out: TextMatch[] = [];
      for (const line of String(r.text).split('\n').map((s) => s.trim()).filter(Boolean)) out.push(...(await findText(doc, line)));
      for (const [k, re] of Object.entries(PII_PATTERNS)) if (r[k]) out.push(...(await findText(doc, re, { regex: true })));
      return out;
    });
    if (res) markMatches(res, 'redact');
  }

  function markMatches(matches: TextMatch[], kind: 'highlight' | 'redact') {
    const add: OverlayItem[] = [];
    for (const m of matches) {
      if (kind === 'highlight') {
        const all = m.rects.reduce((a, q) => ({ x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), x2: Math.max(a.x2, q.x + q.w), y2: Math.max(a.y2, q.y + q.h) }), { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity });
        add.push({ id: uid(), page: m.page, kind: 'highlight', quads: m.rects, rect: { x: all.x, y: all.y, w: all.x2 - all.x, h: all.y2 - all.y }, color: '#fff176', opacity: 1, author });
      } else for (const q of m.rects) add.push({ id: uid(), page: m.page, kind: 'redact', rect: q, color: '#000000' });
    }
    setItems((a) => [...a, ...add]);
    toast(kind === 'redact' ? `Marked ${add.length} area${add.length === 1 ? '' : 's'} for redaction. Review them, then choose Apply redactions.` : `Highlighted ${matches.length} result${matches.length === 1 ? '' : 's'}.`, 'ok');
  }

  async function removeSecurityFlow() {
    if (!bytes) return;
    toast('This copy is already unlocked for editing. Save it to keep an unprotected file.', 'ok');
  }

  async function sanitizeFlow() {
    const ok = await confirm('Remove hidden information', <p>Removes metadata, attachments, JavaScript, form actions and bookmarks, and rebuilds the file so deleted objects are gone. Visible content stays the same.</p>, 'Remove hidden information');
    if (ok) commit('Sanitize document', ops.sanitize);
  }

  async function propertiesFlow() {
    if (!bytes) return;
    const m = await ops.getMeta(bytes);
    const d = doc!;
    const info = (await d.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null;
    const p1 = await d.getPage(1);
    const [, , w, h] = p1.view;
    const r = await form({
      title: 'Document properties',
      intro: (
        <div className="props-summary">
          <span>File: <strong>{fileName}</strong></span>
          <span>Size: {(bytes.length / 1024).toFixed(1)} KB</span>
          <span>Pages: {d.numPages}</span>
          <span>Page size: {(w / 72).toFixed(2)} × {(h / 72).toFixed(2)} in</span>
          <span>PDF version: {String(info?.info?.PDFFormatVersion ?? '?')}</span>
          <span>Tagged: {(info?.info as { IsTagged?: boolean })?.IsTagged ? 'yes' : 'no'}</span>
        </div>
      ),
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'author', label: 'Author', type: 'text' },
        { key: 'subject', label: 'Subject', type: 'text' },
        { key: 'keywords', label: 'Keywords', type: 'text' },
        { key: 'creator', label: 'Application', type: 'text' },
        { key: 'producer', label: 'PDF producer', type: 'text' },
      ],
      initial: m as Values,
      submit: 'Save properties',
    });
    if (r) commit('Edit properties', (b) => ops.setMeta(b, r as never));
  }

  async function compressFlow() {
    const r = await form({
      title: 'Reduce file size',
      fields: [
        {
          key: 'level',
          label: 'Method',
          type: 'select',
          options: [
            { value: 'lossless', label: 'Optimise structure (lossless)' },
            { value: 'medium', label: 'Flatten pages to images, 150 dpi (smaller)' },
            { value: 'strong', label: 'Flatten pages to images, 100 dpi (smallest)' },
          ],
        },
      ],
      intro: 'Image modes keep text searchable but turn pages into pictures, which removes form fields and comments.',
      submit: 'Reduce size',
    });
    if (!r || !bytes) return;
    const before = (await snapshot()).length;
    const ok = await commit('Reduce file size', (b) => (r.level === 'lossless' ? ops.optimize(b) : tools.compressByRaster(b, r.level === 'medium' ? 150 : 100, r.level === 'medium' ? 0.72 : 0.6, (p, l) => setBusy({ label: l ?? 'Compressing', progress: p }))));
    if (ok) setTimeout(() => {
      const after = bytesRef.current?.length ?? before;
      toast(after < before ? `Reduced from ${(before / 1024).toFixed(0)} KB to ${(after / 1024).toFixed(0)} KB.` : 'The file was already compact; no further savings.', 'ok');
    }, 50);
  }

  async function ocrFlow() {
    const r = await form({
      title: 'Recognize text (OCR)',
      intro: 'Makes scanned pages searchable and selectable by adding an invisible text layer. The page images are not changed. Language data is downloaded the first time.',
      fields: [
        {
          key: 'lang',
          label: 'Language',
          type: 'select',
          options: [
            ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'], ['pol', 'Polish'], ['rus', 'Russian'], ['jpn', 'Japanese'], ['chi_sim', 'Chinese (Simplified)'], ['kor', 'Korean'], ['ara', 'Arabic'], ['hin', 'Hindi'],
          ].map(([value, label]) => ({ value, label })),
        },
        pagesField(),
        { key: 'skip', label: 'Skip pages that already have text', type: 'checkbox' },
      ],
      initial: { lang: 'eng', skip: true },
      submit: 'Recognize text',
    });
    if (!r || !doc) return;
    let pages = parsePages(r) ?? allPages();
    if (r.skip) {
      const keep: number[] = [];
      for (const p of pages) if ((await pageText(await doc.getPage(p + 1))).trim().length < 20) keep.push(p);
      pages = keep;
    }
    if (!pages.length) return toast('Every selected page already has text.', 'ok');
    const ok = await commit('Recognize text', (b) => tools.runOcr(b, pages, String(r.lang), (p, l) => setBusy({ label: l ?? 'Recognizing text', progress: p })));
    if (ok) toast(`Text recognized on ${pages.length} page${pages.length === 1 ? '' : 's'}.`, 'ok');
  }

  async function compareFlow() {
    const [f] = await tools.pickFiles('application/pdf');
    if (!f || !doc) return;
    const res = await run('Comparing documents', async () => {
      const other = await loadPlain(await tools.readFile(f));
      const r = await tools.compareDocuments(doc, other);
      other.destroy();
      return r;
    });
    if (res) setDialog(<CompareView nameA={fileName} nameB={f.name} result={res} onClose={() => setDialog(null)} />);
  }

  async function exportFlow(format: 'docx' | 'xlsx' | 'png' | 'jpeg' | 'txt' | 'html') {
    if (!doc) return;
    const name = tools.baseName(fileName);
    // Export from the current state, including pending edits.
    const current = hasPending() ? await loadPlain((await run('Preparing', () => snapshot())) ?? bytes!) : doc;
    if (format === 'png' || format === 'jpeg') {
      const r = await form({ title: `Export as ${format.toUpperCase()}`, fields: [{ key: 'dpi', label: 'Resolution', type: 'select', options: [{ value: '72', label: '72 dpi (screen)' }, { value: '150', label: '150 dpi' }, { value: '300', label: '300 dpi (print)' }] }, pagesField()], initial: { dpi: '150' }, submit: 'Export' });
      if (!r) return;
      await run('Exporting images', (p) => tools.exportImages(current, name, format, Number(r.dpi), parsePages(r) ?? allPages(), p));
    } else if (format === 'docx') {
      const r = await form({
        title: 'Export to Word',
        fields: [
          {
            key: 'layout',
            label: 'Layout',
            type: 'select',
            options: [
              { value: 'flow', label: 'Flowing text (easiest to edit)' },
              { value: 'exact', label: 'Exact page layout (looks like the PDF)' },
            ],
            help: 'Flowing text keeps fonts, sizes, alignment, tables and images in normal Word paragraphs. Exact layout places every paragraph and image where it is on the page.',
          },
        ],
        initial: { layout: 'flow' },
        submit: 'Export',
      });
      if (!r) return;
      await run('Exporting to Word', (p) => tools.exportDocx(current, name, p, r.layout as 'flow' | 'exact'));
    }
    else if (format === 'xlsx') await run('Exporting table data', () => tools.exportExcelCsv(current, name));
    else if (format === 'html') await run('Exporting to HTML', (p) => tools.exportHtml(current, name, p));
    else await run('Exporting text', () => tools.exportText(current, name));
  }

  async function formDataFlow(kind: 'export' | 'import' | 'clear') {
    if (kind === 'export') {
      const data = await run('Reading form', async () => ops.getFormData(await snapshot()));
      if (!data) return;
      if (!Object.keys(data).length) return toast('This document has no form fields.', 'error');
      tools.download(JSON.stringify(data, null, 2), `${tools.baseName(fileName)}-form-data.json`, 'application/json');
    } else if (kind === 'import') {
      const [f] = await tools.pickFiles('application/json,.json');
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        commit('Import form data', (b) => ops.setFormData(b, data));
      } catch {
        toast('That file is not valid form data (JSON).', 'error');
      }
    } else commit('Clear form', ops.clearForm);
  }

  async function attachFlow() {
    const [f] = await tools.pickFiles('*/*');
    if (f) commit(`Attach ${f.name}`, async (b) => ops.attachFile(b, { name: f.name, bytes: await tools.readFile(f), type: f.type }));
  }

  async function measureScaleFlow() {
    const r = await form({
      title: 'Measurement scale',
      fields: [
        { key: 'unit', label: 'Unit', type: 'select', options: ['in', 'cm', 'mm', 'pt', 'ft', 'm'].map((u) => ({ value: u, label: u })) },
        { key: 'ratio', label: 'Scale (1 unit on paper = N units real)', type: 'number', min: 0.0001, step: 0.0001 },
      ],
      initial: { unit: measureScale.unit, ratio: 1 },
      submit: 'Set scale',
    });
    if (!r) return;
    const perIn: Record<string, number> = { in: 1, cm: 2.54, mm: 25.4, pt: 72, ft: 1 / 12, m: 0.0254 };
    setMeasureScale({ unit: String(r.unit), perPoint: (perIn[String(r.unit)] / 72) * Number(r.ratio || 1) });
    setTool('measure');
  }

  async function readAloud() {
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    if (!doc) return;
    const text = await pageText(await doc.getPage(page));
    if (!text.trim()) return toast('No text on this page. Try Recognize text (OCR) first.', 'error');
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => setSpeaking(false);
    setSpeaking(true);
    speechSynthesis.speak(u);
  }

  async function flattenFlow() {
    const ok = await confirm('Flatten', <p>Form fields and comments become part of the page and can no longer be edited.</p>, 'Flatten');
    if (ok) commit('Flatten', async (b) => ops.flattenAnnotations(await ops.flattenForms(b).catch(() => b)));
  }

  async function settingsFlow() {
    const r = await form({ title: 'Preferences', fields: [{ key: 'author', label: 'Your name (shown on comments)', type: 'text' }, { key: 'theme', label: 'Theme', type: 'select', options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] }], initial: { author, theme }, submit: 'Save' });
    if (r) {
      setAuthor(String(r.author) || 'Me');
      setTheme(r.theme as 'light' | 'dark');
    }
  }

  const accessibilityFlow = async () => {
    if (!doc) return;
    const res = await run('Checking accessibility', async () => {
      const meta = (await doc.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null;
      const tree = await (await doc.getPage(1)).getStructTree().catch(() => null);
      const textPages: number[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, 50); i++) if (!(await pageText(await doc.getPage(i))).trim()) textPages.push(i);
      const outline = await doc.getOutline();
      const lang = (meta?.info as { Language?: string })?.Language;
      return [
        ['Document title is set', !!meta?.info?.Title],
        ['Document is tagged (has a structure tree)', !!tree],
        ['Document language is set', !!lang],
        ['All pages contain real text (not just images)', textPages.length === 0, textPages.length ? `Image-only pages: ${textPages.slice(0, 10).join(', ')}${textPages.length > 10 ? '…' : ''}. Run OCR.` : ''],
        ['Bookmarks for navigation (documents over 20 pages)', doc.numPages <= 20 || !!outline?.length],
      ] as [string, boolean, string?][];
    });
    if (!res) return;
    setDialog(
      <Modal title="Accessibility check" onClose={() => setDialog(null)}>
        <ul className="a11y-list">
          {res.map(([label, pass, note]) => (
            <li key={label} className={pass ? 'pass' : 'fail'}>
              {pass ? <Icons.CheckCircle2 size={16} /> : <Icons.AlertTriangle size={16} />}
              <span>
                {label}
                {note && <small>{note}</small>}
              </span>
            </li>
          ))}
        </ul>
      </Modal>,
    );
  };

  // Expose a small API for automated tests.
  useEffect(() => {
    window.__anchor = {
      annots: async (b: Uint8Array) => {
        const d = await loadPlain(b);
        const out: string[] = [];
        for (let i = 1; i <= d.numPages; i++) for (const a of await (await d.getPage(i)).getAnnotations()) out.push(`${i}:${a.subtype}`);
        d.destroy();
        return out.join(',');
      },
      openBytes, loadPlain, viewer: () => apiRef.current?.viewer, snapshot, commit, setTool, setItems, getItems: () => itemsRef.current, ops, markMatches, applyRedactionsFlow };
  });

  // =============================================================================================
  // Render
  // =============================================================================================

  const redactCount = items.filter((i) => i.kind === 'redact').length;
  const pendingCount = items.length - redactCount;
  const dirty = vIndex !== savedIndex || pendingCount > 0;

  const T = (id: Tool, icon: ReactNode, label: string, hint?: string) => (
    <button key={id} className={`tool ${tool === id ? 'on' : ''}`} onClick={() => setTool(tool === id ? 'select' : id)} title={hint ?? label} aria-pressed={tool === id}>
      {icon}
      <span>{label}</span>
    </button>
  );
  const A = (key: string, icon: ReactNode, label: string, fn: () => void, hint?: string, disabled?: boolean) => (
    <button key={key} className="tool" onClick={fn} title={hint ?? label} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  );
  const S = 18;

  const strips: Record<Category, ReactNode> = {
    view: (
      <>
        {T('select', <Icons.MousePointer2 size={S} />, 'Select', 'Select text and items (V)')}
        {T('hand', <Icons.Hand size={S} />, 'Hand', 'Drag to scroll (H)')}
        <span className="sep" />
        {A('rl', <Icons.RotateCcw size={S} />, 'Rotate view', () => rotateView(-90), 'Rotate the view (does not change the file)')}
        {A('rr', <Icons.RotateCw size={S} />, 'Rotate view', () => rotateView(90))}
        <span className="sep" />
        {A('single', <Icons.File size={S} />, spread === 0 ? '• Single' : 'Single', () => setSpread(0), 'One page at a time')}
        {A('two', <Icons.BookOpen size={S} />, spread === 1 ? '• Two-up' : 'Two-up', () => setSpread(spread === 1 ? 0 : 1), 'Two pages side by side')}
        {A('scroll', <Icons.ArrowDownUp size={S} />, scrollMode === 0 ? 'Vertical' : scrollMode === 1 ? 'Horizontal' : scrollMode === 2 ? 'Wrapped' : 'Page by page', () => setScrollMode((m) => (m + 1) % 4), 'Change scrolling')}
        <span className="sep" />
        {A('night', <Icons.MoonStar size={S} />, invert ? '• Night pages' : 'Night pages', () => setInvert(!invert), 'Invert page colours for reading in the dark')}
        {A('read', speaking ? <Icons.Square size={S} /> : <Icons.Volume2 size={S} />, speaking ? 'Stop' : 'Read aloud', readAloud, 'Read the current page aloud')}
        {A('full', <Icons.Maximize size={S} />, 'Full screen', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
      </>
    ),
    comment: (
      <>
        {T('select', <Icons.MousePointer2 size={S} />, 'Select')}
        <span className="sep" />
        {T('pj-highlight', <Icons.Highlighter size={S} />, 'Highlight', 'Select text to highlight it (U)')}
        {T('underline', <Icons.Underline size={S} />, 'Underline', 'Drag across text to underline')}
        {T('strikeout', <Icons.Strikethrough size={S} />, 'Strike', 'Drag across text to strike it out')}
        {T('squiggly', <Icons.Waves size={S} />, 'Squiggly')}
        <span className="sep" />
        {T('note', <Icons.StickyNote size={S} />, 'Note', 'Sticky note (N)')}
        {T('pj-freetext', <Icons.Type size={S} />, 'Text box', 'Text comment on the page')}
        {T('pj-ink', <Icons.PenTool size={S} />, 'Draw', 'Freehand drawing (D)')}
        <span className="sep" />
        {T('rect', <Icons.Square size={S} />, 'Rectangle', 'Rectangle (R)')}
        {T('ellipse', <Icons.Circle size={S} />, 'Ellipse', 'Ellipse (E)')}
        {T('line', <Icons.Minus size={S} />, 'Line', 'Line (L)')}
        {T('arrow', <Icons.MoveUpRight size={S} />, 'Arrow', 'Arrow (A)')}
        {T('measure', <Icons.Ruler size={S} />, 'Measure', 'Measure a distance')}
        <span className="sep" />
        {T('stamp', <Icons.Stamp size={S} />, 'Stamp')}
        {tool === 'stamp' && (
          <select className="inline-select" value={stampLabel} onChange={(e) => setStampLabel(e.target.value)} aria-label="Stamp">
            {STAMPS.map((s) => <option key={s}>{s}</option>)}
          </select>
        )}
        {tool === 'measure' && A('scale', <Icons.Scale size={S} />, `Scale (${measureScale.unit})`, measureScaleFlow)}
      </>
    ),
    edit: (
      <>
        {T('select', <Icons.MousePointer2 size={S} />, 'Select')}
        <span className="sep" />
        {T('edittext', <Icons.TextCursorInput size={S} />, 'Edit text', 'Click existing text to edit its paragraph (Shift+click for one line)')}
        {T('text', <Icons.Type size={S} />, 'Add text', 'Add text to the page (T)')}
        {A('img', <Icons.ImagePlus size={S} />, 'Add image', chooseImage)}
        {T('pj-image', <Icons.ImageUp size={S} />, 'Image comment', 'Place an image as an annotation')}
        {T('whiteout', <Icons.Eraser size={S} />, 'Whiteout', 'Cover content with a white box')}
        {T('link', <Icons.Link size={S} />, 'Link', 'Drag over an area to link it to a web address or page')}
        <span className="sep" />
        {A('wm', <Icons.Droplets size={S} />, 'Watermark', watermark)}
        {A('hf', <Icons.PanelTop size={S} />, 'Header & footer', () => headerFooter())}
        {A('pn', <Icons.Hash size={S} />, 'Page numbers', () => headerFooter('numbers'))}
        {A('bates', <Icons.ListOrdered size={S} />, 'Bates', () => headerFooter('bates'), 'Bates numbering for legal documents')}
        {A('bg', <Icons.PaintBucket size={S} />, 'Background', background)}
        {A('crop', <Icons.Crop size={S} />, 'Crop', () => cropFlow(allPages()))}
      </>
    ),
    organize: null,
    forms: (
      <>
        {T('select', <Icons.MousePointer2 size={S} />, 'Fill in', 'Click fields to fill them in')}
        <span className="sep" />
        {(
          [
            ['text', <Icons.TextCursor size={S} />, 'Text field'],
            ['multiline', <Icons.AlignLeft size={S} />, 'Paragraph'],
            ['checkbox', <Icons.CheckSquare size={S} />, 'Checkbox'],
            ['radio', <Icons.CircleDot size={S} />, 'Radio'],
            ['dropdown', <Icons.ChevronDownSquare size={S} />, 'Dropdown'],
            ['listbox', <Icons.List size={S} />, 'List'],
            ['button', <Icons.RectangleHorizontal size={S} />, 'Button'],
          ] as [FieldType, ReactNode, string][]
        ).map(([ft, icon, label]) => (
          <button key={ft} className={`tool ${tool === 'field' && fieldType === ft ? 'on' : ''}`} onClick={() => { setFieldType(ft); setTool(tool === 'field' && fieldType === ft ? 'select' : 'field'); }} title={`Add a ${label.toLowerCase()} (double-click a new field to rename it)`}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
        <span className="sep" />
        {A('exp', <Icons.FileJson size={S} />, 'Export data', () => formDataFlow('export'))}
        {A('imp', <Icons.FileInput size={S} />, 'Import data', () => formDataFlow('import'))}
        {A('clr', <Icons.RotateCcwSquare size={S} />, 'Clear form', () => formDataFlow('clear'))}
        {A('flat', <Icons.Layers2 size={S} />, 'Flatten', flattenFlow, 'Make fields and comments part of the page')}
      </>
    ),
    sign: (
      <>
        {A('sig', <Icons.Signature size={S} />, signature ? 'Place signature' : 'Create signature', () => signFlow('signature'))}
        {A('ini', <Icons.CaseSensitive size={S} />, initials ? 'Place initials' : 'Create initials', () => signFlow('initials'))}
        {signature && A('resig', <Icons.Pencil size={S} />, 'Redo signature', () => signFlow('signature', true))}
        {A('date', <Icons.CalendarDays size={S} />, 'Add date', addDateText)}
        <span className="sep" />
        {A('digisig', <Icons.FileBadge size={S} />, 'Sign with certificate', startDigitalSign, 'Certificate-based digital signature (.p12 / .pfx)')}
        {A('verify', <Icons.ShieldCheck size={S} />, 'Verify signatures', () => verifyFlow())}
        {A('newid', <Icons.KeyRound size={S} />, 'Create digital ID', createDigitalIdFlow)}
        <span className="sep" />
        {T('text', <Icons.Type size={S} />, 'Add text')}
        {A('check', <Icons.Check size={S} />, 'Checkmark', () => placeMark('check'))}
        {A('cross', <Icons.X size={S} />, 'Cross', () => placeMark('cross'))}
        {A('dot', <Icons.Dot size={S} />, 'Dot', () => placeMark('dot'))}
        <span className="sep" />
        {T('select', <Icons.MousePointer2 size={S} />, 'Fill in fields')}
      </>
    ),
    protect: (
      <>
        {T('redact', <Icons.SquareDashedBottom size={S} />, 'Mark for redaction', 'Drag over content to mark it for redaction')}
        {A('rfind', <Icons.ScanSearch size={S} />, 'Find & redact', redactPatternsFlow, 'Find words or patterns like emails and phone numbers')}
        {A('rapply', <Icons.ShieldCheck size={S} />, `Apply redactions${redactCount ? ` (${redactCount})` : ''}`, applyRedactionsFlow, undefined, !redactCount)}
        <span className="sep" />
        {A('pw', <Icons.Lock size={S} />, 'Password', protectFlow, 'Encrypt with a password and set permissions')}
        {A('unlock', <Icons.LockOpen size={S} />, 'Remove security', removeSecurityFlow)}
        {A('san', <Icons.SprayCan size={S} />, 'Remove hidden info', sanitizeFlow)}
      </>
    ),
    convert: (
      <>
        {A('docx', <Icons.FileText size={S} />, 'Word', () => exportFlow('docx'), 'Export to Word (.docx)')}
        {A('xlsx', <Icons.Sheet size={S} />, 'Spreadsheet', () => exportFlow('xlsx'), 'Export table data to CSV (opens in Excel)')}
        {A('png', <Icons.FileImage size={S} />, 'PNG', () => exportFlow('png'))}
        {A('jpg', <Icons.Image size={S} />, 'JPEG', () => exportFlow('jpeg'))}
        {A('html', <Icons.Code2 size={S} />, 'HTML', () => exportFlow('html'))}
        {A('txt', <Icons.FileType size={S} />, 'Text', () => exportFlow('txt'))}
        <span className="sep" />
        {A('fromimg', <Icons.Images size={S} />, 'Images → PDF', async () => openFiles(await tools.pickFiles('image/png,image/jpeg', true)))}
        {A('fromtxt', <Icons.FilePlus size={S} />, 'Text → PDF', createFromText)}
        {A('combine', <Icons.Combine size={S} />, 'Combine files', () => combineFlow())}
      </>
    ),
    tools: (
      <>
        {A('ocr', <Icons.ScanText size={S} />, 'Recognize text', ocrFlow, 'OCR: make scanned pages searchable')}
        {A('compress', <Icons.FoldVertical size={S} />, 'Reduce size', compressFlow)}
        {A('compare', <Icons.GitCompare size={S} />, 'Compare', compareFlow, 'Compare with another version')}
        {A('a11y', <Icons.Accessibility size={S} />, 'Accessibility', accessibilityFlow)}
        <span className="sep" />
        {A('props', <Icons.Info size={S} />, 'Properties', propertiesFlow)}
        {A('attach', <Icons.Paperclip size={S} />, 'Attach file', attachFlow)}
        {A('bm', <Icons.Bookmark size={S} />, 'Bookmarks', () => setPanel('bookmarks'))}
        {A('flatten', <Icons.Layers2 size={S} />, 'Flatten', flattenFlow)}
        {A('print', <Icons.Printer size={S} />, 'Print', print)}
      </>
    ),
  };

  const showStyle = isItemTool || tool in PJ_MODE || !!selected;
  const styleKind = selected?.kind ?? (tool as string);
  const textish = ['text', 'edittext', 'pj-freetext'].includes(styleKind);
  const shapeish = ['rect', 'ellipse'].includes(styleKind);
  const lineish = ['rect', 'ellipse', 'line', 'arrow', 'measure', 'pj-ink', 'underline', 'strikeout', 'squiggly'].includes(styleKind);

  const CATS: [Category, ReactNode, string][] = [
    ['view', <Icons.Eye size={19} />, 'View'],
    ['comment', <Icons.MessageSquarePlus size={19} />, 'Comment'],
    ['edit', <Icons.FilePen size={19} />, 'Edit'],
    ['organize', <Icons.LayoutGrid size={19} />, 'Organize'],
    ['forms', <Icons.ClipboardList size={19} />, 'Forms'],
    ['sign', <Icons.Signature size={19} />, 'Sign'],
    ['protect', <Icons.Shield size={19} />, 'Protect'],
    ['convert', <Icons.ArrowRightLeft size={19} />, 'Convert'],
    ['tools', <Icons.Wrench size={19} />, 'Tools'],
  ];

  return (
    <div className={`app ${bytes ? 'has-doc' : 'no-doc'}`}>
      <header className="topbar">
        <div className="brand" onClick={() => !bytes && openDialog()}>
          <Logo size={26} />
          <span className="brand-name">
            ANCHOR <b>Tsunami</b>
          </span>
        </div>
        <nav className="file-actions">
          <button className="icon-btn" onClick={openDialog} title="Open (Ctrl+O)"><Icons.FolderOpen size={18} /></button>
          <button className="icon-btn" onClick={() => save()} disabled={!bytes} title="Save (Ctrl+S)"><Icons.Save size={18} /></button>
          <button className="icon-btn" onClick={() => save(true)} disabled={!bytes} title="Save as (Ctrl+Shift+S)"><Icons.SaveAll size={18} /></button>
          <button className="icon-btn" onClick={print} disabled={!bytes} title="Print (Ctrl+P)"><Icons.Printer size={18} /></button>
          <span className="sep" />
          <button className="icon-btn" onClick={undo} disabled={!bytes || (vIndex <= 0 && !items.length)} title="Undo (Ctrl+Z)"><Icons.Undo2 size={18} /></button>
          <button className="icon-btn" onClick={redo} disabled={!bytes || vIndex >= versions.length - 1} title="Redo (Ctrl+Y)"><Icons.Redo2 size={18} /></button>
        </nav>
        {bytes && (
          <div className="doc-title" title={fileName}>
            <span className="name">{fileName}</span>
            {dirty && <span className="dirty" title="Unsaved changes">●</span>}
            {readOnly && <span className="badge">Read only</span>}
          </div>
        )}
        <span className="grow" />
        {bytes && mode === 'view' && (
          <div className="nav-group">
            <button className="icon-btn" onClick={() => goTo(page - 1)} disabled={page <= 1} title="Previous page"><Icons.ChevronUp size={18} /></button>
            <input
              className="page-input"
              value={page}
              onChange={(e) => setPage(Number(e.target.value) || 1)}
              onKeyDown={(e) => e.key === 'Enter' && goTo(Number((e.target as HTMLInputElement).value))}
              onBlur={(e) => goTo(Number(e.target.value))}
              aria-label="Page number"
            />
            <span className="muted">/ {doc?.numPages ?? 0}</span>
            <button className="icon-btn" onClick={() => goTo(page + 1)} disabled={page >= (doc?.numPages ?? 0)} title="Next page"><Icons.ChevronDown size={18} /></button>
            <span className="sep" />
            <button className="icon-btn" onClick={() => zoom('out')} title="Zoom out (Ctrl+−)"><Icons.ZoomOut size={18} /></button>
            <select className="zoom-select" value={['page-width', 'page-fit', 'auto'].includes(String(v()?.currentScaleValue)) ? String(v()?.currentScaleValue) : 'custom'} onChange={(e) => zoom(e.target.value)} aria-label="Zoom">
              <option value="custom" hidden>{Math.round(scale * 100)}%</option>
              <option value="auto">Automatic</option>
              <option value="page-width">Fit width</option>
              <option value="page-fit">Fit page</option>
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
            </select>
            <button className="icon-btn" onClick={() => zoom('in')} title="Zoom in (Ctrl++)"><Icons.ZoomIn size={18} /></button>
          </div>
        )}
        <span className="grow" />
        <nav className="app-actions">
          {bytes && <button className="icon-btn" onClick={() => { setPanel('search'); setSearchSeed((s) => s + 1); }} title="Find (Ctrl+F)"><Icons.Search size={18} /></button>}
          <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle dark mode">{theme === 'dark' ? <Icons.Sun size={18} /> : <Icons.Moon size={18} />}</button>
          <button className="icon-btn" onClick={settingsFlow} title="Preferences"><Icons.Settings size={18} /></button>
          <button className="icon-btn" onClick={() => setDialog(<Modal title="Keyboard shortcuts" onClose={() => setDialog(null)}><table className="shortcuts"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table></Modal>)} title="Keyboard shortcuts"><Icons.Keyboard size={18} /></button>
        </nav>
      </header>

      {bytes && doc ? (
        <>
          <div className="ribbon">
            <div className="cats" role="tablist">
              {CATS.map(([c, icon, label]) => (
                <button
                  key={c}
                  role="tab"
                  aria-selected={(c === 'organize' && mode === 'organize') || (c !== 'organize' && mode === 'view' && category === c)}
                  className={`cat ${(c === 'organize' ? mode === 'organize' : mode === 'view' && category === c) ? 'on' : ''}`}
                  onClick={async () => {
                    if (c === 'organize') {
                      if (hasPending()) await commit('Apply edits');
                      setMode('organize');
                      setTool('select');
                    } else {
                      setMode('view');
                      setCategory(c);
                    }
                  }}
                >
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {mode === 'view' && (
              <div className="strip">
                <div className="strip-tools">{strips[category]}</div>
                {showStyle && (
                  <div className="style-bar">
                    {!['redact', 'whiteout', 'link', 'field', 'image', 'sign', 'pj-image'].includes(styleKind) && (
                      <label className="swatch" title="Colour">
                        <input type="color" value={selected?.color ?? style.color} onChange={(e) => setStyleKey('color', e.target.value)} />
                      </label>
                    )}
                    {['#e5484d', '#f5a524', '#fff176', '#30a46c', '#0091ff', '#8e4ec6', '#000000'].map((c) => (
                      <button key={c} className="dot-btn" style={{ background: c }} onClick={() => setStyleKey('color', c)} aria-label={`Colour ${c}`} />
                    ))}
                    {shapeish && (
                      <label className="mini" title="Fill">
                        Fill
                        <input type="checkbox" checked={!!(selected?.fill ?? style.fill)} onChange={(e) => setStyleKey('fill', e.target.checked ? '#ffe9a8' : null)} />
                        {(selected?.fill ?? style.fill) && <input type="color" value={selected?.fill ?? style.fill ?? '#ffe9a8'} onChange={(e) => setStyleKey('fill', e.target.value)} />}
                      </label>
                    )}
                    {lineish && (
                      <label className="mini" title="Line width">
                        <Icons.LineChart size={14} />
                        <input type="range" min={0.5} max={12} step={0.5} value={selected?.width ?? style.width} onChange={(e) => setStyleKey('width', Number(e.target.value))} />
                      </label>
                    )}
                    {!textish && (
                      <label className="mini" title="Opacity">
                        <Icons.Blend size={14} />
                        <input type="range" min={0.1} max={1} step={0.05} value={selected?.opacity ?? style.opacity} onChange={(e) => setStyleKey('opacity', Number(e.target.value))} />
                      </label>
                    )}
                    {textish && (
                      <>
                        {styleKind !== 'pj-freetext' && (
                          <select className="inline-select" value={selected?.font ?? style.font} onChange={(e) => setStyleKey('font', e.target.value as ToolStyle['font'])} aria-label="Font">
                            <option value="Helvetica">Sans</option>
                            <option value="Times">Serif</option>
                            <option value="Courier">Mono</option>
                          </select>
                        )}
                        <input className="num-input" type="number" min={4} max={144} value={selected?.fontSize ?? style.fontSize} onChange={(e) => setStyleKey('fontSize', Number(e.target.value))} aria-label="Font size" />
                        {styleKind !== 'pj-freetext' && (
                          <>
                            <button className={`icon-btn ${(selected?.bold ?? style.bold) ? 'on' : ''}`} onClick={() => setStyleKey('bold', !(selected?.bold ?? style.bold))} title="Bold"><Icons.Bold size={15} /></button>
                            <button className={`icon-btn ${(selected?.italic ?? style.italic) ? 'on' : ''}`} onClick={() => setStyleKey('italic', !(selected?.italic ?? style.italic))} title="Italic"><Icons.Italic size={15} /></button>
                          </>
                        )}
                      </>
                    )}
                    {selected && (
                      <button className="icon-btn danger" onClick={() => removeItem(selected.id)} title="Delete (Del)"><Icons.Trash2 size={16} /></button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="workspace">
            {mode === 'view' && (
              <aside className={`sidebar ${panel ? 'open' : ''}`}>
                <div className="rail">
                  {(
                    [
                      ['thumbs', <Icons.GalleryVertical size={19} />, 'Pages'],
                      ['bookmarks', <Icons.Bookmark size={19} />, 'Bookmarks'],
                      ['comments', <Icons.MessagesSquare size={19} />, 'Comments'],
                      ['search', <Icons.Search size={19} />, 'Find'],
                      ['attachments', <Icons.Paperclip size={19} />, 'Attachments'],
                      ['layers', <Icons.Layers size={19} />, 'Layers'],
                    ] as [Panel, ReactNode, string][]
                  ).map(([id, icon, label]) => (
                    <button key={id} className={`rail-btn ${panel === id ? 'on' : ''}`} onClick={() => setPanel(panel === id ? null : id)} title={label} aria-label={label}>
                      {icon}
                    </button>
                  ))}
                </div>
                {panel && (
                  <Sidebar
                    panel={panel}
                    doc={doc}
                    docKey={docKey}
                    page={page}
                    goTo={goTo}
                    items={items}
                    selectItem={(id) => { setSelectedId(id); setTool('select'); }}
                    onSaveOutline={(tree) => commit('Edit bookmarks', (b) => ops.setOutline(b, tree))}
                    onAddAttachment={attachFlow}
                    onDownload={(d, n) => tools.download(d, n, 'application/octet-stream')}
                    onLayersChanged={(cfg) => { const vw = v(); if (vw) vw.optionalContentConfigPromise = Promise.resolve(cfg) as never; }}
                    onSearchHighlight={(q, o) => apiRef.current?.eventBus.dispatch('find', { source: null, type: '', query: q, caseSensitive: o.caseSensitive, entireWord: o.wholeWord, highlightAll: true, findPrevious: false, matchDiacritics: false })}
                    onMarkMatches={markMatches}
                    ask={(t, l, i) => ask(t, l, i)}
                    searchSeed={searchSeed}
                  />
                )}
              </aside>
            )}
            <main className="main">
              <div style={{ display: mode === 'view' ? 'contents' : 'none' }}>
                <Viewer
                  doc={doc}
                  onReady={(api) => (apiRef.current = api)}
                  onPageChange={setPage}
                  onScaleChange={setScale}
                  invert={invert}
                  handTool={tool === 'hand'}
                  renderOverlay={(i, vp) => <PageOverlay page={i} vp={vp} items={items.filter((it) => it.page === i)} ctx={overlayCtx} />}
                />
              </div>
              {mode === 'organize' && (
                <Organize
                  doc={doc}
                  docKey={docKey}
                  onReorder={(order) => commit('Reorder pages', (b) => ops.reorderPages(b, order))}
                  onRotate={(pg, d) => commit('Rotate pages', (b) => ops.rotatePages(b, pg, d))}
                  onDelete={async (pg) => {
                    if (pg.length >= doc.numPages) return toast('A document needs at least one page.', 'error');
                    commit(`Delete ${pg.length} page${pg.length === 1 ? '' : 's'}`, (b) => ops.deletePages(b, pg));
                  }}
                  onDuplicate={(pg) => commit('Duplicate pages', (b) => ops.duplicatePages(b, pg))}
                  onExtract={extractFlow}
                  onInsertBlank={(at) => commit('Insert blank page', (b) => ops.insertBlankPage(b, at))}
                  onInsertFile={insertFileFlow}
                  onReplace={replaceFlow}
                  onSplit={splitFlow}
                  onCrop={cropFlow}
                  onResize={resizeFlow}
                  onOpenPage={(p) => { setMode('view'); setTimeout(() => goTo(p), 50); }}
                />
              )}
              {(redactCount > 0 || pendingCount > 0) && mode === 'view' && (
                <div className="pending-bar">
                  {pendingCount > 0 && <span>{pendingCount} unsaved edit{pendingCount === 1 ? '' : 's'}. They are written into the file when you save.</span>}
                  {redactCount > 0 && (
                    <>
                      <span>{redactCount} area{redactCount === 1 ? '' : 's'} marked for redaction.</span>
                      <button className="btn small danger" onClick={applyRedactionsFlow}>Apply redactions</button>
                    </>
                  )}
                </div>
              )}
            </main>
          </div>
        </>
      ) : (
        <Home onOpen={openDialog} onCombine={() => combineFlow()} onBlank={createBlank} onImages={async () => openFiles(await tools.pickFiles('image/png,image/jpeg', true))} onText={createFromText} />
      )}

      {dropping && (
        <div className="drop-overlay">
          <Icons.Upload size={42} />
          <p>Drop to open</p>
        </div>
      )}
      {busy && (
        <div className="busy" role="status" aria-live="polite">
          <div className="busy-card">
            <div className="spinner" />
            <div>
              <div>{busy.label}…</div>
              {busy.progress !== undefined && (
                <div className="progress">
                  <div style={{ width: `${Math.round(busy.progress * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>
            {t.msg}
          </div>
        ))}
      </div>
      {dialog}
    </div>
  );
}

function Home({ onOpen, onCombine, onBlank, onImages, onText }: { onOpen: () => void; onCombine: () => void; onBlank: () => void; onImages: () => void; onText: () => void }) {
  const cards: [ReactNode, string, string, () => void][] = [
    [<Icons.FolderOpen size={22} />, 'Open a PDF', 'View, comment, edit, fill and sign', onOpen],
    [<Icons.Combine size={22} />, 'Combine files', 'Merge PDFs and images into one PDF', onCombine],
    [<Icons.Images size={22} />, 'Images to PDF', 'Turn photos or scans into a PDF', onImages],
    [<Icons.FilePlus2 size={22} />, 'Blank PDF', 'Start from empty pages', onBlank],
    [<Icons.FileType size={22} />, 'Text to PDF', 'Paste text and make a PDF', onText],
  ];
  return (
    <div className="home">
      <div className="hero">
        <Logo size={72} />
        <h1>
          ANCHOR <b>Tsunami</b>
        </h1>
        <p className="tagline">The complete PDF workbench. Everything runs on your device; your files never leave it.</p>
        <button className="btn primary big" onClick={onOpen}>
          <Icons.FolderOpen size={18} /> Open PDF
        </button>
        <p className="muted small">or drop a file anywhere in this window</p>
      </div>
      <div className="home-cards">
        {cards.map(([icon, title, sub, fn]) => (
          <button key={title} className="home-card" onClick={fn}>
            <span className="hc-icon">{icon}</span>
            <strong>{title}</strong>
            <span className="muted small">{sub}</span>
          </button>
        ))}
      </div>
      <div className="feature-grid">
        {[
          ['View', 'Thumbnails, bookmarks, search, layers, two-up, night mode, read aloud'],
          ['Comment', 'Highlight, underline, notes, drawing, shapes, stamps, measuring'],
          ['Edit', 'Edit and add text, images, links, watermarks, headers, Bates numbers'],
          ['Organize', 'Reorder, rotate, delete, insert, extract, split, crop, combine'],
          ['Forms & Sign', 'Fill and create forms, import/export data, sign and initial'],
          ['Protect', 'True redaction, find sensitive data, passwords, remove hidden info'],
          ['Convert', 'Word, spreadsheet, images, HTML, text; images and text to PDF'],
          ['Tools', 'OCR in 14 languages, compress, compare, accessibility check'],
        ].map(([t, d]) => (
          <div key={t} className="feature">
            <strong>{t}</strong>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
