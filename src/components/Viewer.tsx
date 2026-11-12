import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pdfjsLib, type PDFDocumentProxy } from '../lib/pdfjs';
import 'pdfjs-dist/web/pdf_viewer.css';

// pdf_viewer.mjs reads globalThis.pdfjsLib when it loads, so it is imported after pdfjs.ts has run.
const viewerModule = import('pdfjs-dist/web/pdf_viewer.mjs');
type ViewerModule = Awaited<typeof viewerModule>;

export interface ViewerApi {
  viewer: InstanceType<ViewerModule['PDFViewer']>;
  eventBus: InstanceType<ViewerModule['EventBus']>;
  linkService: InstanceType<ViewerModule['PDFLinkService']>;
  findController: InstanceType<ViewerModule['PDFFindController']>;
  mod: ViewerModule;
  uiManager: { commitOrRemove(): void; getLayer(i: number): { commitOrRemove(): boolean } | null | undefined } | null;
}

export interface PageViewport {
  width: number;
  height: number;
  rotation: number;
  scale: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
  convertToViewportRectangle(r: number[]): number[];
}

interface Props {
  doc: PDFDocumentProxy | null;
  onReady: (api: ViewerApi) => void;
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  renderOverlay: (pageIndex: number, viewport: PageViewport) => ReactNode;
  invert?: boolean;
  handTool?: boolean;
}

export function Viewer({ doc, onReady, onPageChange, onScaleChange, renderOverlay, invert, handTool }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ViewerApi | null>(null);
  const hostsRef = useRef(new Map<number, HTMLDivElement>());
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onPageChange, onScaleChange, onReady });
  cb.current = { onPageChange, onScaleChange, onReady };

  useEffect(() => {
    let disposed = false;
    viewerModule.then((mod) => {
      if (disposed || !containerRef.current || !viewerRef.current) return;
      const eventBus = new mod.EventBus();
      const linkService = new mod.PDFLinkService({ eventBus, externalLinkTarget: mod.LinkTarget.BLANK });
      const findController = new mod.PDFFindController({ eventBus, linkService });
      const viewer = new mod.PDFViewer({
        container: containerRef.current,
        viewer: viewerRef.current,
        eventBus,
        linkService,
        findController,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
        annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
        annotationEditorHighlightColors: 'yellow=#FFF176,green=#A5E887,blue=#80D8FF,pink=#FF8FC8,red=#FF6B6B',
        enableHighlightFloatingButton: true,
        removePageBorders: false,
        maxCanvasPixels: 2 ** 25,
      } as never);
      linkService.setViewer(viewer);
      const refresh = () => {
        // pdf.js clears unknown children when it re-renders a page, so overlay hosts are re-attached here.
        viewer._pages?.forEach((pv: { div: HTMLDivElement }, i: number) => {
          let host = hostsRef.current.get(i);
          if (!host) {
            host = document.createElement('div');
            host.className = 'at-overlay-host';
            hostsRef.current.set(i, host);
          }
          if (host.parentElement !== pv.div) pv.div.appendChild(host);
        });
        setTick((t) => t + 1);
      };
      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'auto';
        refresh();
      });
      eventBus.on('pagerendered', refresh);
      eventBus.on('annotationeditorlayerrendered', refresh);
      eventBus.on('scalechanging', (e: { scale: number }) => {
        cb.current.onScaleChange(e.scale);
        refresh();
      });
      eventBus.on('rotationchanging', refresh);
      eventBus.on('pagechanging', (e: { pageNumber: number }) => cb.current.onPageChange(e.pageNumber));
      apiRef.current = { viewer, eventBus, linkService, findController, mod, uiManager: null };
      eventBus.on('annotationeditoruimanager', (e: { uiManager: ViewerApi['uiManager'] }) => {
        if (apiRef.current) apiRef.current.uiManager = e.uiManager;
      });
      setReady(true);
      cb.current.onReady(apiRef.current);
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    hostsRef.current.forEach((h) => h.remove());
    hostsRef.current.clear();
    api.viewer.setDocument(doc as never);
    api.linkService.setDocument(doc as never, null);
    setTick((t) => t + 1);
  }, [doc, ready]);

  // Hand tool: drag to scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !handTool) return;
    let start: { x: number; y: number; l: number; t: number } | null = null;
    const down = (e: PointerEvent) => {
      start = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
      el.setPointerCapture(e.pointerId);
      el.classList.add('grabbing');
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      el.scrollLeft = start.l - (e.clientX - start.x);
      el.scrollTop = start.t - (e.clientY - start.y);
    };
    const up = () => {
      start = null;
      el.classList.remove('grabbing');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
  }, [handTool]);

  // Ctrl + wheel zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const v = apiRef.current?.viewer;
      if (!v?.pdfDocument) return;
      v.updateScale({ steps: e.deltaY < 0 ? 1 : -1, origin: [e.clientX, e.clientY] } as never);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const portals: ReactNode[] = [];
  const api = apiRef.current;
  if (api && doc) {
    hostsRef.current.forEach((host, i) => {
      const pv = api.viewer.getPageView(i) as { viewport: PageViewport } | undefined;
      if (!pv || !host.isConnected) return;
      portals.push(createPortal(renderOverlay(i, pv.viewport), host, `ov-${i}`));
    });
  }
  void tick;

  return (
    <div className={`viewer-shell ${invert ? 'invert' : ''} ${handTool ? 'hand' : ''}`}>
      <div ref={containerRef} className="viewer-container" tabIndex={0}>
        <div ref={viewerRef} className="pdfViewer" />
      </div>
      {portals}
    </div>
  );
}
