// InkVault server: a headless REST + WebSocket API over a folder of Markdown
// notes, plus static hosting for the web clients. Any client (web, Android,
// Windows) speaks the protocol in docs/PROTOCOL.md.
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { toSVG, fromSVG, newDrawing, applyChange, sanitizeChange, sanitizeStroke } from '../shared/ink.js';
import { ensureIcons } from './icons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4777;
const VAULT = path.resolve(process.env.VAULT_DIR || path.join(ROOT, 'vault'));
const INK_DIR = 'Drawings';
const TRASH_DIR = '.trash';
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // optional, e.g. https://inkvault.example.ts.net

await fs.mkdir(path.join(VAULT, INK_DIR), { recursive: true });
await ensureIcons(path.join(PUBLIC, 'icons'));
if (!(await exists(path.join(VAULT, 'Welcome.md')))) {
  await fs.writeFile(path.join(VAULT, 'Welcome.md'), WELCOME());
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function vaultPath(rel, { md = false } = {}) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'bad path');
  const abs = path.resolve(VAULT, rel.replace(/^[/\\]+/, ''));
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new HttpError(400, 'path escapes vault');
  if (md && !abs.toLowerCase().endsWith('.md')) throw new HttpError(400, 'notes must be .md');
  return abs;
}
const rel = abs => path.relative(VAULT, abs).split(path.sep).join('/');

async function tree(dir = VAULT) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === VAULT && e.name === INK_DIR) continue;
      out.push({ type: 'folder', name: e.name, path: rel(abs), children: await tree(abs) });
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push({ type: 'file', name: e.name.slice(0, -3), path: rel(abs) });
    }
  }
  return out.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
}

async function allNotes(dir = VAULT, acc = []) {
  for (const n of await tree(dir)) {
    if (n.type === 'file') acc.push(n.path);
    else await allNotes(path.join(VAULT, n.path), acc);
  }
  return acc;
}

async function uniquePath(abs) {
  if (!(await exists(abs))) return abs;
  const ext = path.extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  for (let i = 1; ; i++) {
    const p = `${base} ${i}${ext}`;
    if (!(await exists(p))) return p;
  }
}

async function writeAtomic(abs, data) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, abs);
}

// ---------------------------------------------------------------------------
// Drawings: stored as Drawings/ink-<id>.svg (an image with the stroke data
// embedded), cached in memory and flushed shortly after each change.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{4,40}$/;
const drawings = new Map(); // id -> Promise<drawing|null>
const dirty = new Set();
let flushTimer = null;

const inkFile = id => path.join(VAULT, INK_DIR, `ink-${id}.svg`);

function getDrawing(id) {
  if (!ID_RE.test(id)) return Promise.resolve(null);
  if (!drawings.has(id)) {
    drawings.set(id, fs.readFile(inkFile(id), 'utf8').then(fromSVG).catch(() => null));
  }
  return drawings.get(id);
}

function markDirty(id) {
  dirty.add(id);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

async function flush() {
  const ids = [...dirty];
  dirty.clear();
  await Promise.all(ids.map(async id => {
    const d = await getDrawing(id);
    if (d) await writeAtomic(inkFile(id), toSVG(d));
  }));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.ico': 'image/x-icon',
};
const PAGES = { '/': 'index.html', '/pc': 'pc.html', '/tablet': 'tablet.html' };

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const readJSON = async req => {
  try { return JSON.parse(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'bad json'); }
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const routes = {
  'GET /api/info': async () => {
    const inDocker = fss.existsSync('/.dockerenv');
    return {
      name: 'InkVault',
      protocol: 1,
      // Inside Docker the interfaces are the container's, which a tablet can't reach.
      urls: PUBLIC_URL ? [PUBLIC_URL.replace(/\/$/, '')] : inDocker ? [] : lanAddresses().map(ip => `http://${ip}:${PORT}`),
      inDocker,
    };
  },
  'GET /api/qr': async (req, url) => {
    const text = url.searchParams.get('text') || '';
    return { __raw: await QRCode.toString(text.slice(0, 500), { type: 'svg', margin: 1 }), type: 'image/svg+xml' };
  },
  'GET /api/tree': async () => tree(),
  'GET /api/notes': async () => allNotes(),
  'GET /api/note': async (req, url) => {
    const abs = vaultPath(url.searchParams.get('path'), { md: true });
    try { return { path: rel(abs), text: await fs.readFile(abs, 'utf8') }; } catch { throw new HttpError(404, 'not found'); }
  },
  'PUT /api/note': async (req, url) => {
    const abs = vaultPath(url.searchParams.get('path'), { md: true });
    await writeAtomic(abs, await readBody(req));
    return { ok: true };
  },
  'POST /api/note': async req => {
    const { folder = '', name = 'Untitled' } = await readJSON(req);
    const clean = String(name).replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Untitled';
    const abs = await uniquePath(vaultPath(path.posix.join(folder || '.', `${clean}.md`), { md: true }));
    await writeAtomic(abs, '');
    broadcastAll({ type: 'tree' });
    return { path: rel(abs) };
  },
  'DELETE /api/note': async (req, url) => {
    // Like Obsidian, deleting moves to <vault>/.trash rather than destroying data.
    const abs = vaultPath(url.searchParams.get('path'));
    if (abs === VAULT) throw new HttpError(400, 'cannot delete vault');
    const dest = await uniquePath(path.join(VAULT, TRASH_DIR, path.basename(abs)));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(abs, dest);
    broadcastAll({ type: 'tree' });
    return { ok: true };
  },
  'POST /api/rename': async req => {
    const { from, to } = await readJSON(req);
    const a = vaultPath(from);
    const b = vaultPath(to, { md: from.toLowerCase().endsWith('.md') });
    if (a === VAULT) throw new HttpError(400, 'cannot rename vault');
    if (a !== b) {
      if (await exists(b)) throw new HttpError(409, 'a file with that name already exists');
      await fs.mkdir(path.dirname(b), { recursive: true });
      await fs.rename(a, b);
    }
    broadcastAll({ type: 'tree' });
    return { path: rel(b) };
  },
  'POST /api/folder': async req => {
    const { path: p } = await readJSON(req);
    const abs = await uniquePath(vaultPath(p));
    await fs.mkdir(abs, { recursive: true });
    broadcastAll({ type: 'tree' });
    return { path: rel(abs) };
  },
  'GET /api/search': async (req, url) => {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (!q) return [];
    const results = [];
    for (const p of await allNotes()) {
      const text = await fs.readFile(path.join(VAULT, p), 'utf8');
      const name = p.toLowerCase();
      const lines = text.split('\n');
      const hits = [];
      lines.forEach((l, i) => { if (l.toLowerCase().includes(q) && hits.length < 5) hits.push({ line: i, text: l.trim().slice(0, 200) }); });
      if (hits.length || name.includes(q)) results.push({ path: p, hits });
      if (results.length >= 100) break;
    }
    return results;
  },
  'POST /api/drawing': async () => {
    const d = newDrawing();
    drawings.set(d.id, Promise.resolve(d));
    await writeAtomic(inkFile(d.id), toSVG(d));
    return d;
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) {
      const out = await routes[key](req, url);
      if (out && out.__raw) return send(res, 200, out.__raw, out.type);
      return send(res, 200, out);
    }
    let m;
    if (req.method === 'GET' && (m = /^\/api\/drawing\/([a-z0-9]+)$/.exec(url.pathname))) {
      const d = await getDrawing(m[1]);
      return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

    const file = PAGES[url.pathname] || url.pathname.slice(1);
    const abs = path.resolve(PUBLIC, file);
    if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found', 'text/plain');
    const data = await fs.readFile(abs).catch(() => null);
    if (!data) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer(handle);

// ---------------------------------------------------------------------------
// WebSocket: live session between PC(s) and tablet(s)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
let active = null; // { id, note } — the drawing currently open on the tablet

function broadcastAll(msg, except = null, role = null) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c !== except && c.readyState === 1 && (!role || c.role === role)) c.send(s);
  }
}

function broadcastState() {
  let tablets = 0, pcs = 0;
  for (const c of wss.clients) {
    if (c.role === 'tablet') tablets++;
    else if (c.role === 'pc') pcs++;
  }
  broadcastAll({ type: 'state', active, tablets, pcs });
}

async function openOnTablets(target = null) {
  const msg = active ? { type: 'open', ...active, drawing: await getDrawing(active.id) } : { type: 'close' };
  if (target) target.send(JSON.stringify(msg));
  else broadcastAll(msg, null, 'tablet');
}

async function applyClientChange(ws, id, rawChange) {
  const d = await getDrawing(id);
  const change = sanitizeChange(rawChange);
  if (!d || !change) return;
  applyChange(d, change);
  markDirty(id);
  broadcastAll({ type: 'change', id, change }, ws);
}

wss.on('connection', ws => {
  ws.role = 'unknown';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Process messages strictly in order even though handlers are async.
  let queue = Promise.resolve();
  ws.on('message', raw => {
    queue = queue.then(() => onMessage(ws, raw)).catch(e => console.error('ws error', e));
  });
  ws.on('close', broadcastState);
});

async function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'hello': {
      ws.role = ['pc', 'tablet'].includes(msg.role) ? msg.role : 'viewer';
      // changes made while the client was offline
      for (const p of Array.isArray(msg.pending) ? msg.pending.slice(0, 500) : []) await applyClientChange(ws, p.id, p.change);
      broadcastState();
      if (ws.role === 'tablet') await openOnTablets(ws);
      break;
    }
    case 'open': {
      if (!(await getDrawing(msg.id))) return;
      active = { id: msg.id, note: typeof msg.note === 'string' ? msg.note.slice(0, 500) : '' };
      await openOnTablets();
      broadcastState();
      break;
    }
    case 'close':
      if (msg.id && active && active.id !== msg.id) return;
      active = null;
      await openOnTablets();
      broadcastState();
      break;
    case 'change':
      await applyClientChange(ws, msg.id, msg.change);
      break;
    case 'live': // in-progress stroke preview; not persisted
      if (typeof msg.id !== 'string' || typeof msg.sid !== 'string') return;
      broadcastAll({ type: 'live', id: msg.id, sid: msg.sid, stroke: msg.stroke ? sanitizeStroke(msg.stroke) : null }, ws);
      break;
  }
}

// Drop dead connections (tablets that went to sleep) so the PC's status is accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, async () => {
  const urls = (await routes['GET /api/info']()).urls;
  console.log(`\nInkVault running — vault: ${VAULT}`);
  console.log(`  PC:      http://localhost:${PORT}/pc`);
  for (const u of urls) console.log(`  Tablet:  ${u}/tablet`);
  if (!urls.length) console.log(`  Tablet:  http://<this PC's LAN IP>:${PORT}/tablet   (set PUBLIC_URL to show a QR code)`);
  if (urls[0]) console.log('\n' + (await QRCode.toString(`${urls[0]}/tablet`, { type: 'terminal', small: true })));
});

async function shutdown() {
  clearTimeout(flushTimer);
  await flush().catch(console.error);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function WELCOME() {
  return `# Welcome to InkVault

Type notes here on your PC. When you want to sketch, press **Insert drawing** (or \`Ctrl+Alt+D\`).
A drawing field appears in the note and opens on your tablet automatically.

- Click any drawing field on the PC to send it to the tablet.
- Press **Done** (PC or tablet) to release the tablet.
- Link notes with \`[[Note name]]\` — \`Ctrl+click\` to follow.
- \`Ctrl+O\` quick switcher · \`Ctrl+E\` reading view · \`Ctrl+Shift+F\` search

On the tablet: scribble over ink to erase it, two-finger tap to undo, three-finger tap to redo.
`;
}
