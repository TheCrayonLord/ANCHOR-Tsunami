// ANCHOR Tsunami conversion server: turns Office documents (Word, Excel, PowerPoint, OpenDocument,
// RTF, HTML, text) into PDF with LibreOffice. No dependencies beyond Node 18+ and LibreOffice.
//
//   PORT=8787 ALLOW_ORIGINS=https://thecrayonlord.github.io node convert-server.mjs
//
// POST /convert   body: the file's bytes   header X-Filename: report.docx   ->  application/pdf
// GET  /health    -> {"ok":true}
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const SOFFICE = process.env.SOFFICE || 'soffice';
const MAX_BYTES = Number(process.env.MAX_MB || 50) * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_S || 120) * 1000;
const ORIGINS = (process.env.ALLOW_ORIGINS || 'https://thecrayonlord.github.io,http://localhost:5173,http://localhost:4173').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = process.env.TOKEN || ''; // optional shared secret, sent by the app as "Authorization: Bearer <token>"
const ALLOWED = new Set(['.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.ott', '.txt', '.html', '.htm', '.xls', '.xlsx', '.xlsm', '.ods', '.csv', '.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.odg', '.vsd', '.vsdx', '.pub', '.wpd']);

// LibreOffice handles one conversion per profile at a time, so requests are queued.
let queue = Promise.resolve();
const enqueue = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};

function convert(dir, input) {
  return new Promise((resolve, reject) => {
    const args = [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input];
    const proc = spawn(SOFFICE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Conversion timed out'));
    }, TIMEOUT_MS);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`LibreOffice exited with ${code}: ${err.slice(0, 300)}`));
    });
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ORIGINS.includes('*') || ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, formats: [...ALLOWED] });
  if (req.method !== 'POST' || req.url !== '/convert') return send(res, 404, { error: 'Not found' });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Missing or wrong token' });
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'document.docx')).replace(/[^\w.\- ]+/g, '_').slice(-120);
  const ext = extname(name).toLowerCase();
  if (!ALLOWED.has(ext)) return send(res, 415, { error: `Unsupported file type ${ext || '(none)'}` });
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BYTES) return send(res, 413, { error: 'File too large' });
      chunks.push(c);
    }
  } catch {
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'anchor-'));
  try {
    const input = join(dir, `input${ext}`);
    await writeFile(input, Buffer.concat(chunks));
    await enqueue(() => convert(dir, input));
    const out = (await readdir(dir)).find((f) => f.endsWith('.pdf'));
    if (!out) throw new Error('No PDF was produced');
    send(res, 200, await readFile(join(dir, out)), 'application/pdf');
  } catch (e) {
    send(res, 500, { error: e.message });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}).listen(PORT, () => console.log(`ANCHOR Tsunami conversion server on :${PORT} (origins: ${ORIGINS.join(', ')})`));
