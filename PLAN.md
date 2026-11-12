# ANCHOR Tsunami: feature inventory and roadmap

ANCHOR Tsunami is a full PDF workbench that runs in the browser and installs as an app (PWA). Its goal is feature parity with Adobe Acrobat Pro in functionality, with its own name, look and code.

No spec documents existed in the project or a repository when the build started (12 Nov 2026), so this inventory comes from two public sources: the PDF standard (ISO 32000-2) and the functional areas of Acrobat Pro's public feature list. Each feature has a status:

- **Done**: built and tested in a real browser.
- **Partial**: works, with limits that are listed.
- **Planned**: not built yet. Its stage number is in the roadmap below.

## Architecture

| Layer | Technology | Role |
|---|---|---|
| UI | React 18 + TypeScript, Vite | App shell, ribbon, sidebar, dialogs, overlay tools |
| Rendering | pdf.js 4.10 (`pdfjs-dist`) | Page rendering, text layer, links, AcroForm filling, XFA display, built-in highlight/ink/text/image editors, search highlighting |
| Writing | pdf-lib (`@cantoo/pdf-lib` fork, which adds AES/RC4 encryption) | Every structural change: pages, annotations, fields, stamping, metadata, outlines, attachments, encryption |
| OCR | tesseract.js 5 | Engine and English data ship with the app, so OCR works offline. Other languages download the first time they are used |
| Packaging | PWA manifest + service worker | Installable, works offline, registers as a handler for `.pdf` files |

Every change follows the same path: current bytes, then an operation in `src/lib/ops.ts` or `src/lib/tools.ts`, then new bytes. Each version goes on an undo stack (40 steps). Work in progress, such as shapes, notes, text, signatures, form entries and pdf.js drawings, is written into the file when you save or run any document operation.

## Feature inventory

### View and navigate
| Feature | Status | Notes |
|---|---|---|
| Open PDF (picker, drag and drop, file handler, `?url=`) | Done | Password-protected files ask for the password |
| Continuous, horizontal, wrapped and page-by-page scrolling | Done | |
| Single page and two-up spreads | Done | |
| Zoom (presets, fit width, fit page, Ctrl+wheel, Ctrl +/−) | Done | |
| Rotate view | Done | View only; Organize rotates the file itself |
| Page thumbnails | Done | |
| Bookmarks: view, navigate, add, rename, reorder, nest, delete | Done | Saved as a real PDF outline |
| Find with match case, whole word and regex; results list | Done | |
| Layers (optional content) on and off | Done | |
| Attachments: list, save, add | Done | |
| Night mode (inverted pages), dark UI theme | Done | |
| Read aloud | Done | Uses the browser's speech engine |
| Full screen | Done | |
| Multiple documents in tabs | Planned (2) | |
| Recent files list | Planned (2) | |
| Presentation mode | Planned (3) | |

### Comment and mark up
| Feature | Status | Notes |
|---|---|---|
| Highlight text | Done | pdf.js highlighter, plus "Highlight all" from search |
| Underline, strikethrough, squiggly | Done | Real text-markup annotations with QuadPoints |
| Sticky notes with popup | Done | |
| Text box (FreeText) | Done | |
| Freehand drawing (Ink) | Done | |
| Rectangle, ellipse, line, arrow | Done | Real Square/Circle/Line annotations with appearance streams |
| Stamps (Approved, Draft, Confidential and 9 more) | Done | |
| Distance measurement with scale | Done | |
| Comments panel with filter | Done | |
| Area and perimeter measurement, polygon, cloud shapes | Planned (2) | |
| Replies, status and review workflow on comments | Planned (3) | |
| Import/export comments (FDF/XFDF), comment summary | Planned (3) | |
| Edit or delete comments made in other apps | Partial | pdf.js can edit existing FreeText, Ink, Highlight and Stamp; other kinds are read only |

### Edit
| Feature | Status | Notes |
|---|---|---|
| Edit existing text by paragraph | Done | Click any text to edit its whole paragraph; it reflows as you type and keeps the original line breaks, spacing and alignment until you change it. Shift+click edits one line. Text is redrawn in a matching sans, serif or mono face rather than the file's own embedded font |
| Add text | Done | Sans, serif or mono; bold and italic; size; colour |
| Add images | Done | PNG and JPEG |
| Whiteout | Done | |
| Links to a URL or a page | Done | |
| Watermark (text or image, opacity, rotation, behind or in front of content) | Done | |
| Header and footer with `{page}`, `{pages}`, `{date}`, `{file}` tokens | Done | Handles rotated pages |
| Page numbers | Done | |
| Bates numbering | Done | Prefix, start number, digit count |
| Page background colour | Done | |
| Crop pages | Done | |
| Non-Latin text in added content | Done | Text, stamps, headers, footers and watermarks embed subset Noto fonts when needed: Cyrillic, Greek, Arabic and Hebrew (shaped, right to left), Devanagari, Thai, Chinese, Japanese, Korean and symbols |
| Edit or replace existing images, move page objects | Planned (3) | |

### Organize pages
| Feature | Status |
|---|---|
| Reorder by drag and drop | Done |
| Rotate, delete, duplicate | Done |
| Insert blank page, insert pages from a PDF or image, replace pages | Done |
| Extract pages to a new PDF | Done |
| Split every N pages, into N parts, or by ranges (ZIP) | Done |
| Combine PDFs and images | Done |
| Crop, change page size | Done |
| Split by bookmarks or by file size | Planned (2) |

### Forms
| Feature | Status | Notes |
|---|---|---|
| Fill in AcroForm fields | Done | |
| View XFA forms | Partial | Shown and fillable through pdf.js; saving dynamic XFA is limited |
| Create text, paragraph, checkbox, radio, dropdown, list and button fields | Done | |
| Rename fields | Done | Double-click a new field |
| Export and import form data (JSON) | Done | |
| Clear form, flatten form | Done | |
| Form calculations and validation scripts | Planned (2) | Needs pdf.js's scripting sandbox turned on |
| Automatic field detection | Planned (3) | |
| FDF, XFDF and CSV data formats | Planned (3) | |

### Fill and sign
| Feature | Status | Notes |
|---|---|---|
| Signature: draw (pressure), type (4 script fonts) or upload | Done | Saved on this device for reuse |
| Initials | Done | |
| Date, checkmark, cross, dot | Done | |
| Certificate-based digital signatures | Done | Sign with a .p12/.pfx digital ID (PKCS#7 detached, SHA-256), visible or invisible. Signatures are added as incremental updates, so earlier signatures stay valid. Verify shows signer, time, reason and whether the file changed after signing. Create a self-signed digital ID in the app. Not yet: trusted-certificate lists, revocation checks and timestamp servers |
| Request signatures from others, track status | Planned (4) | Needs a server |

### Protect
| Feature | Status | Notes |
|---|---|---|
| Mark areas for redaction | Done | |
| Find and redact words and patterns (email, phone, SSN, card numbers, dates) | Done | |
| Apply redactions permanently | Done | Affected pages are flattened and the file is rebuilt, so the content cannot be recovered. Text outside the marks stays searchable |
| Password protection with permissions (print, copy, edit, comment, forms, assembly, accessibility) | Done | |
| Open protected files; remove security | Done | |
| Remove hidden information (metadata, JavaScript, attachments, actions) | Done | |
| Redact without flattening the whole page | Planned (3) | |
| Certificate encryption | Planned (4) | |

### Convert and export
| Feature | Status | Notes |
|---|---|---|
| PDF to Word (.docx) | Done | Two layouts: flowing text (fonts, sizes, colours, bold/italic, alignment, indents, spacing, tables, images) or exact page layout (every paragraph and image positioned as on the page). Vector drawings such as lines and boxes are not carried over |
| PDF to spreadsheet | Partial | CSV with columns found from horizontal gaps |
| PDF to PNG or JPEG (72/150/300 dpi) | Done | |
| PDF to HTML, PDF to text | Done | |
| Images to PDF, text to PDF, blank PDF | Done | |
| Any file to PDF | Done | Open, drop or combine files of any type. Converted in the browser as real text: Word (.docx, and .doc as text), Excel and CSV, PowerPoint (.pptx), OpenDocument, RTF, web pages, Markdown, EPUB, email (.eml, with its attachments), JSON, code and plain text. Images: PNG, JPEG, GIF, WebP, BMP, SVG, AVIF, TIFF, HEIC. ZIP archives are converted file by file. Anything with no page view (audio, video, programs, unknown formats) becomes a cover page with the original file attached. The built-in Office converters keep content and simplify layout; themes, charts and SmartArt are not drawn. For exact Office layout use the conversion server |
| PDF to PowerPoint, Excel (.xlsx) with tables | Planned (3) | |
| Word, Excel, PowerPoint and OpenDocument to PDF | Done | Uses a small conversion server you run yourself (LibreOffice, in `server/`, Docker or Node). Set its address once; Office files can then be opened or dropped straight into the app |
| Web page to PDF | Planned (4) | |
| PDF/A, PDF/X and PDF/UA output and preflight | Planned (4) | |

### Scan and OCR
| Feature | Status | Notes |
|---|---|---|
| Recognize text with an invisible text layer | Done | 14 languages. English works offline. Can skip pages that already have text |
| Deskew, despeckle, editable text from OCR | Planned (3) | |
| Scan from a camera or scanner | Planned (3) | |

### Other tools
| Feature | Status | Notes |
|---|---|---|
| Compare two versions (word-level text diff by page) | Done | |
| Reduce file size: lossless restructure, or 150/100 dpi image modes | Done | |
| Flatten annotations and fields | Done | |
| Document properties and metadata editing | Done | |
| Accessibility check (title, tags, language, image-only pages, bookmarks) | Partial | Checks only; auto-tagging is planned (3) |
| Print | Done | Uses the browser's print dialog |
| Keyboard shortcuts | Done | |
| Undo and redo for document changes | Done | |
| Actions and batch processing | Planned (3) | |
| AI assistant (summarise, ask questions about the document) | Planned (4) | |

## Roadmap

1. **Stage 1, done in this build.** Viewer, commenting, editing, organizing, forms, signing, redaction, security, conversion, OCR, compare, compress, accessibility check, PWA.
2. **Stage 2.** Done: Unicode text, certificate signatures, paragraph editing, layout-preserving Word export, Office to PDF via your own server. Still to do: form calculation scripts, tabs and recent files, area and perimeter measurement, split by bookmarks or size, signature timestamps and trust lists.
3. **Stage 3.** Text editing with the file's own embedded fonts. Moving and replacing page objects. Comment replies and status. FDF/XFDF. PowerPoint and Excel export with tables. Region-only redaction. OCR clean-up and camera scanning. Auto-tagging. Batch actions.
4. **Stage 4, needs a server.** Send for signature with tracking. PDF/A and preflight. Certificate encryption. AI assistant. Desktop packaging (Tauri or Electron) for native file dialogs and printing.

## Testing

- `npm test`: engine tests for every document operation, Unicode text in eight scripts, and certificate signing (sign, second signature, tamper detection; also checked with poppler's `pdfsig`).
- `node tests/e2e2.cjs`, `e2e3.cjs`, `e2e-ocr.cjs`, `e2e-sign.cjs`, `e2e-para.cjs`, `e2e-docx.cjs`, `e2e-office.cjs` (needs the conversion server): browser tests against `npm run preview`. They cover comments, drawing, text editing, form filling, signing, watermark, page numbers, search, bookmarks, redaction, organize with undo, all exports, password protection, compare, properties, accessibility and offline OCR.
