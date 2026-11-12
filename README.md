# ANCHOR Tsunami

A complete PDF workbench that runs on your device: view, comment, edit, organize, fill and create forms, sign, redact, protect, convert, OCR, compare and compress PDFs. Files never leave the browser.

## Run it

```bash
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build at http://localhost:4173
```

`dist/` is a static site. Host it anywhere (any static host, or open it from a local web server). Once it is open in Chrome or Edge, use **Install** in the address bar to get a desktop app that opens `.pdf` files.

## Layout

- `src/lib/ops.ts`: document operations on PDF bytes (pdf-lib). Has no DOM code, so the tests run it under Node.
- `src/lib/tools.ts`: browser tools that combine rendering and writing (redaction, OCR, exports, compare).
- `src/lib/pdfjs.ts`: pdf.js setup, text extraction and search.
- `src/components/`: viewer, page overlay tools, sidebar, organize grid, dialogs.
- `src/App.tsx`: app state, commands and the ribbon UI.

See [PLAN.md](PLAN.md) for the feature inventory and roadmap.

## Tests

```bash
npx tsx tests/make-sample.ts && npx tsx tests/ops.test.ts      # engine
npm run build && npm run preview &                              # then:
node tests/e2e2.cjs && node tests/e2e3.cjs && node tests/e2e-ocr.cjs
```

The `tests/e2e*.cjs` scripts use Playwright with Chromium.
