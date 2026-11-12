# ANCHOR Tsunami

A complete PDF workbench that runs on your device: view, comment, edit, organize, fill and create forms, sign, redact, protect, convert, OCR, compare and compress PDFs. Files never leave the browser.

## Run it

```bash
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build at http://localhost:4173
```

### Run the prebuilt app (no Node needed)

Unzip `anchor-tsunami-app.zip`, open a terminal in that folder, run `python3 -m http.server 8080`, then go to http://localhost:8080. The app needs to be served over http(s); opening `index.html` directly from disk will not work because browsers block its workers there.

**Live app:** https://thecrayonlord.github.io/ANCHOR-Tsunami/ (deployed by GitHub Actions on every push to `main`).

`dist/` is a static site. Host it anywhere (any static host, or open it from a local web server). Once it is open in Chrome or Edge, use **Install** in the address bar to get a desktop app that opens `.pdf` files.

### Office to PDF (optional server)

Everything runs in the browser except turning Word, Excel and PowerPoint files into PDF, which needs an office engine. [`server/`](server/README.md) has a small LibreOffice-based conversion server (Docker or plain Node). Run it, then enter its address under **Convert → Office to PDF** or in Preferences.

## Layout

- `src/lib/ops.ts`: document operations on PDF bytes (pdf-lib). Has no DOM code, so the tests run it under Node.
- `src/lib/tools.ts`: browser tools that combine rendering and writing (redaction, OCR, exports, compare).
- `src/lib/pdfjs.ts`: pdf.js setup, text extraction and search.
- `src/lib/typeset.ts`: Unicode text drawing (script detection, Noto font fallback, right-to-left shaping).
- `src/lib/signing.ts`: certificate signatures (sign, verify, create a digital ID).
- `src/lib/paragraph.ts`: groups page text into lines and paragraphs for paragraph editing.
- `src/lib/docx.ts`: PDF to Word with flowing or exact layout.
- `server/`: optional Office-to-PDF conversion server.
- `src/components/`: viewer, page overlay tools, sidebar, organize grid, dialogs.
- `src/App.tsx`: app state, commands and the ribbon UI.

See [PLAN.md](PLAN.md) for the feature inventory and roadmap.

## Tests

```bash
npm test                                                        # engine, Unicode, signing
npx tsx tests/make-paragraphs.ts && npx tsx tests/make-report.ts # fixtures for the browser tests
npm run build && npm run preview &                              # then:
node tests/e2e2.cjs && node tests/e2e3.cjs && node tests/e2e-ocr.cjs
node tests/e2e-sign.cjs && node tests/e2e-para.cjs && node tests/e2e-docx.cjs
```

The `tests/e2e*.cjs` scripts use Playwright with Chromium.
