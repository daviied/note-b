// Tablet client: shows nothing until the PC opens a drawing field, then
// becomes a pen-only canvas. Fingers never draw (palm rejection); two fingers
// pan/zoom.
import { connect } from '../common/socket.js';
import {
  PAGE_WIDTH, PAPER_DARK, drawPage, drawStroke, inkColor, applyChange, inverseOf, finishPoints,
  eraseAlong, detectScribble, uid, strokeBBox,
} from '../../shared/ink.js';

const PALETTES = {
  pen: ['#1f1f1f', '#2457d6', '#d63b2f', '#1f8a4c', '#e07b00', '#7b3fd1', '#8a5a2b'],
  pencil: ['#2b2b2b', '#3d5a80', '#9b2c2c', '#2f6b45', '#6b4f2b'],
  highlighter: ['#ffd60a', '#6ee77a', '#ff7ccf', '#62d0ff', '#ffa94d'],
};
const SIZES = { pen: [1.6, 3, 5.5], pencil: [2, 4, 8], highlighter: [14, 24, 38], eraser: [12, 28, 60] };
const PEN_GRACE_MS = 600; // ignore touches this long after the pen was last seen
const PRESSURE_EASE = 0.35; // 1 = raw pen pressure, lower = steadier line width

// ---------------------------------------------------------------------------
// Settings (per device)
// ---------------------------------------------------------------------------

const settings = Object.assign({
  tool: 'pen',
  pen: { color: PALETTES.pen[0], size: 1 },
  pencil: { color: PALETTES.pencil[0], size: 1 },
  highlighter: { color: PALETTES.highlighter[0], size: 1 },
  eraser: { size: 1, mode: 'stroke' },
  scribble: true,
  darkPaper: false,
  autoFullscreen: true,
}, load());
function load() {
  try { return JSON.parse(localStorage.getItem('inkvault.tablet') || '{}'); } catch { return {}; }
}
function save() {
  try { localStorage.setItem('inkvault.tablet', JSON.stringify(settings)); } catch {}
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = s => document.querySelector(s);
const idle = $('#idle');
const board = $('#board');
const stage = $('#stage');
const baseCv = $('#base');
const liveCv = $('#live');
const baseCtx = baseCv.getContext('2d');
// Not `desynchronized`: on some Android GPUs that turns this transparent overlay opaque black.
const liveCtx = liveCv.getContext('2d');
const toast = $('#toast');

let current = null; // { id, note, drawing, undo: [], redo: [] }
let view = { scale: 1, ox: 0, oy: 0 };
let dpr = 1;
let stageRect = stage.getBoundingClientRect();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const sock = connect('tablet', {
  onStatus(ok) {
    document.body.classList.toggle('online', ok);
  },
  onMessage(m) {
    try {
      if (m.type === 'open' && m.drawing) openDrawing(m);
      else if (m.type === 'close') closeDrawing();
      else if (m.type === 'state' && !m.active && current) closeDrawing();
      else if (m.type === 'change' && current && m.id === current.id) {
        applyChange(current.drawing, m.change);
        refreshSelection();
        dirty.base = true;
      }
    } catch (err) {
      reportError(err);
    }
  },
});

function openDrawing({ id, note, drawing }) {
  const same = current && current.id === id;
  if (!same) { cancelInput(); setSelection(null); }
  current = same ? Object.assign(current, { drawing, note }) : { id, note, drawing, undo: [], redo: [] };
  $('#title').textContent = (note || '').replace(/\.md$/i, '').split('/').pop() || 'Drawing';
  idle.hidden = true;
  board.hidden = false;
  resize();
  if (!same) fitWidth();
  dirty.base = dirty.live = true;
  keepAwake(true);
}

function closeDrawing() {
  cancelInput();
  setSelection(null);
  current = null;
  board.hidden = true;
  idle.hidden = false;
  closeMenu();
  keepAwake(false);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const dirty = { base: false, live: false };
let flash = null; // strokes just erased by a scribble, faded out on the live layer

function resize() {
  dpr = window.devicePixelRatio || 1;
  stageRect = stage.getBoundingClientRect();
  for (const cv of [baseCv, liveCv]) {
    cv.width = Math.round(stageRect.width * dpr);
    cv.height = Math.round(stageRect.height * dpr);
  }
  dirty.base = dirty.live = true;
}

function fitWidth() {
  const margin = stageRect.width > 700 ? 24 : 10;
  view.scale = (stageRect.width - margin * 2) / PAGE_WIDTH;
  view.ox = margin;
  view.oy = margin;
  dirty.base = dirty.live = true;
}

function clampView() {
  if (!current) return;
  const w = PAGE_WIDTH * view.scale;
  const h = current.drawing.height * view.scale;
  const W = stageRect.width, H = stageRect.height, m = 60;
  view.ox = w + 2 * m < W ? (W - w) / 2 : Math.min(m, Math.max(W - w - m, view.ox));
  view.oy = Math.min(m, Math.max(Math.min(m, H - h - m), view.oy));
}

function applyView(ctx) {
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
}

function renderBase() {
  const ctx = baseCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, baseCv.width, baseCv.height);
  if (!current) return;
  const d = current.drawing;
  applyView(ctx);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 18 / view.scale;
  ctx.fillStyle = settings.darkPaper ? PAPER_DARK : '#fff';
  ctx.fillRect(0, 0, d.width, d.height);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, d.width, d.height);
  ctx.clip();
  // strokes being dragged are drawn on the live layer instead
  drawPage(ctx, d, { dark: settings.darkPaper, skip: input?.kind === 'move' ? selection.ids : null });
  ctx.restore();
  if (settings.darkPaper) {
    // a dark page needs an edge to stand out from the dark desk around it
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1 / view.scale;
    ctx.strokeRect(0, 0, d.width, d.height);
  }
}

function renderLive() {
  const ctx = liveCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, liveCv.width, liveCv.height);
  if (!current) return;
  applyView(ctx);
  if (flash) {
    const t = (performance.now() - flash.start) / 350;
    if (t >= 1) flash = null;
    else {
      for (const s of flash.strokes) drawStroke(ctx, { ...s, color: '#ff4d4d' }, { cache: false, alphaScale: 1 - t });
      dirty.live = true;
    }
  }
  if (input && input.kind === 'draw') {
    const s = input.predicted?.length ? { ...input.stroke, pts: input.stroke.pts.concat(input.predicted) } : input.stroke;
    drawStroke(ctx, s, { cache: false, dark: settings.darkPaper });
  }
  renderSelection(ctx);
  const cursor = input && input.kind === 'erase' ? input.last : settings.tool === 'lasso' && !hover?.eraser ? null : hover;
  if (cursor) {
    const erasing = (input && input.kind === 'erase') || hover?.eraser;
    ctx.lineWidth = 1.2 / view.scale;
    ctx.beginPath();
    if (erasing) {
      ctx.strokeStyle = settings.darkPaper ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)';
      ctx.arc(cursor[0], cursor[1], eraserRadius(), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const t = settings[settings.tool] || settings.pen;
      ctx.fillStyle = inkColor(t.color || '#000000', settings.darkPaper);
      ctx.globalAlpha = 0.6;
      ctx.arc(cursor[0], cursor[1], Math.max(1.5, (SIZES[settings.tool]?.[t.size] || 3) / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function frame() {
  requestAnimationFrame(frame); // first, so one bad frame can never stop rendering for good
  try {
    if (dirty.base) { dirty.base = false; renderBase(); }
    if (dirty.live) { dirty.live = false; renderLive(); }
  } catch (err) {
    reportError(err);
  }
}

// Show unexpected errors on screen instead of failing silently.
let lastError = '';
function reportError(err) {
  const msg = `Error: ${err?.message || err}`;
  console.error(err);
  if (msg === lastError) return;
  lastError = msg;
  showToast(msg, 6000);
}
window.addEventListener('error', e => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', e => reportError(e.reason));
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  const wasFit = current && Math.abs(view.scale - (stageRect.width - (stageRect.width > 700 ? 48 : 20)) / PAGE_WIDTH) < 1e-3;
  resize();
  if (wasFit) fitWidth();
  clampView();
});

// ---------------------------------------------------------------------------
// Changes + undo/redo
// ---------------------------------------------------------------------------

function commit(change, { record = true, inverse = null } = {}) {
  if (!current) return;
  const inv = inverse || inverseOf(current.drawing, change);
  applyChange(current.drawing, change);
  sock.send({ type: 'change', id: current.id, change });
  if (record) {
    current.undo.push({ change, inv });
    if (current.undo.length > 200) current.undo.shift();
    current.redo = [];
  }
  refreshSelection();
  dirty.base = true;
  updateUndoButtons();
}

function undo() {
  if (input) return; // not in the middle of a stroke / drag
  const e = current?.undo.pop();
  if (!e) return;
  commit(e.inv, { record: false });
  current.redo.push(e);
  updateUndoButtons();
}
function redo() {
  const e = current?.redo.pop();
  if (!e) return;
  commit(e.change, { record: false });
  current.undo.push(e);
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#undo').disabled = !current?.undo.length;
  $('#redo').disabled = !current?.redo.length;
}

// ---------------------------------------------------------------------------
// Pen input
// ---------------------------------------------------------------------------

let input = null; // { kind: 'draw'|'erase', pointerId, ... }
let hover = null;
let lastPenSeen = 0;
let liveTimer = 0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const eraserRadius = () => SIZES.eraser[settings.eraser.size] / 2;

function tiltOf(e) {
  if (e.pointerType !== 'pen') return 0;
  if (e.tiltX || e.tiltY) {
    const tx = Math.tan((e.tiltX * Math.PI) / 180);
    const ty = Math.tan((e.tiltY * Math.PI) / 180);
    return clamp(1 - Math.atan(1 / Math.hypot(tx, ty)) / (Math.PI / 2), 0, 1);
  }
  if (typeof e.altitudeAngle === 'number') return clamp(1 - e.altitudeAngle / (Math.PI / 2), 0, 1);
  return 0;
}

function pagePoint(e) {
  const pressure = e.pointerType === 'pen' ? Math.max(0.02, e.pressure || 0) : 0.5;
  return [
    (e.clientX - stageRect.left - view.ox) / view.scale,
    (e.clientY - stageRect.top - view.oy) / view.scale,
    pressure,
    tiltOf(e),
  ];
}

const isPenEraser = e => e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5 || (e.buttons & 2));

function onPenDown(e) {
  if (!current || input) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  endGesture();
  stageRect = stage.getBoundingClientRect();
  try { stage.setPointerCapture(e.pointerId); } catch {}
  const p = pagePoint(e);
  hover = null;
  if (settings.tool === 'eraser' || isPenEraser(e)) {
    input = { kind: 'erase', pointerId: e.pointerId, last: p, removed: new Map(), added: new Map() };
    eraseTo(p);
  } else if (settings.tool === 'lasso') {
    // inside the current selection: drag it; anywhere else: draw a new lasso
    const b = selection && selectionBox();
    if (b && p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY) {
      input = { kind: 'move', pointerId: e.pointerId, start: p, dx: 0, dy: 0 };
      dirty.base = true; // take the selection off the base layer while it moves
    } else {
      setSelection(null);
      input = { kind: 'lasso', pointerId: e.pointerId, pts: [p] };
    }
  } else {
    const t = settings[settings.tool];
    input = {
      kind: 'draw',
      pointerId: e.pointerId,
      stroke: { id: uid(), z: Date.now() * 1000 + Math.floor(Math.random() * 1000), tool: settings.tool, color: t.color, size: SIZES[settings.tool][t.size], pts: [p] },
    };
  }
  dirty.live = true;
}

function onPenMove(e) {
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  if (!input || e.pointerId !== input.pointerId) {
    if (!input && e.pointerType !== 'touch' && current) {
      stageRect = stage.getBoundingClientRect();
      hover = Object.assign(pagePoint(e), { eraser: settings.tool === 'eraser' || isPenEraser(e) });
      dirty.live = true;
    }
    return;
  }
  // Coalesced events carry every pen sample since the last frame (full pen rate);
  // browsers only expose them on https, otherwise we get ~60 samples a second.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const p = pagePoint(ev);
    if (input.kind === 'erase') eraseTo(p);
    else if (input.kind === 'lasso') input.pts.push(p);
    else if (input.kind === 'move') {
      input.dx = p[0] - input.start[0];
      input.dy = p[1] - input.start[1];
    } else {
      const pts = input.stroke.pts;
      const q = pts[pts.length - 1];
      // pen pressure is noisy; ease it so the line edge doesn't wobble
      p[2] = q[2] + (p[2] - q[2]) * PRESSURE_EASE;
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) * view.scale >= 0.75) pts.push(p);
      else q[2] = Math.max(q[2], p[2]);
    }
  }
  if (input.kind === 'draw') {
    // Where the pen is about to be: drawn ahead of time to hide latency, never saved.
    const predicted = e.getPredictedEvents ? e.getPredictedEvents() : [];
    input.predicted = predicted.slice(0, 3).map(ev => {
      const p = pagePoint(ev);
      p[2] = input.stroke.pts[input.stroke.pts.length - 1][2];
      return p;
    });
    sendLive();
  }
  dirty.live = true;
}

function onPenUp(e) {
  if (!input || e.pointerId !== input.pointerId) return;
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  const done = input;
  input = null;
  if (done.kind === 'erase') finishErase(done);
  else if (done.kind === 'lasso') finishLasso(done.pts);
  else if (done.kind === 'move') finishMove(done.dx, done.dy);
  else finishStroke(done.stroke);
  dirty.live = true;
}

function cancelInput() {
  if (input?.kind === 'draw') sock.send({ type: 'live', id: current?.id, sid: input.stroke.id, stroke: null });
  if (input?.kind === 'erase') finishErase(input);
  if (input?.kind === 'move') dirty.base = true; // put the selection back where it was
  input = null;
  hover = null;
}

function sendLive(force = false) {
  const now = performance.now();
  if (!force && now - liveTimer < 45) return;
  liveTimer = now;
  sock.send({ type: 'live', id: current.id, sid: input.stroke.id, stroke: input.stroke });
}

function finishStroke(stroke) {
  stroke.pts = finishPoints(stroke.pts);
  if (settings.scribble && stroke.tool !== 'highlighter') {
    const erase = detectScribble(stroke.pts, current.drawing.strokes);
    if (erase) {
      const gone = new Set(erase.remove);
      flash = { start: performance.now(), strokes: current.drawing.strokes.filter(s => gone.has(s.id)) };
      sock.send({ type: 'live', id: current.id, sid: stroke.id, stroke: null });
      commit(erase);
      return;
    }
  }
  const change = { add: [stroke] };
  const maxY = Math.max(...stroke.pts.map(p => p[1]));
  if (maxY > current.drawing.height - 80) change.height = Math.ceil(maxY + 300); // grow the page as you write
  commit(change);
}

function eraseTo(p) {
  const st = input;
  const change = eraseAlong(current.drawing.strokes, st.last[0], st.last[1], p[0], p[1], eraserRadius(), settings.eraser.mode);
  st.last = p;
  if (!change) return;
  const byId = new Map(current.drawing.strokes.map(s => [s.id, s]));
  for (const id of change.remove) {
    if (st.added.has(id)) st.added.delete(id);
    else st.removed.set(id, byId.get(id));
  }
  for (const s of change.add) st.added.set(s.id, s);
  applyChange(current.drawing, change);
  sock.send({ type: 'change', id: current.id, change });
  dirty.base = true;
}

function finishErase(st) {
  if (!current || !st.removed.size) return;
  current.undo.push({
    change: { remove: [...st.removed.keys()], add: [...st.added.values()] },
    inv: { remove: [...st.added.keys()], add: [...st.removed.values()] },
  });
  current.redo = [];
  updateUndoButtons();
}

// ---------------------------------------------------------------------------
// Touch: never draws. Two fingers pan/zoom; single touches (palms) are ignored entirely.
// ---------------------------------------------------------------------------

const touches = new Map();
let gesture = null;

const penNearby = () => !!input || performance.now() - lastPenSeen < PEN_GRACE_MS;

function onTouchDown(e) {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (penNearby()) return;
  if (touches.size === 2) startGesture();
  else if (touches.size > 2) endGesture();
}

function onTouchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t) return;
  t.x = e.clientX;
  t.y = e.clientY;
  if (penNearby()) { endGesture(); return; }
  if (gesture && touches.size === 2) updateGesture();
}

function onTouchUp(e) {
  touches.delete(e.pointerId);
  if (touches.size < 2) endGesture();
}

function twoTouches() {
  const [a, b] = [...touches.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
function startGesture() {
  const g = twoTouches();
  gesture = { ...g, view: { ...view } };
}
function updateGesture() {
  const g = twoTouches();
  const s0 = gesture.view.scale;
  const fit = (stageRect.width - 20) / PAGE_WIDTH;
  const s = clamp(s0 * (g.d / gesture.d), fit * 0.5, fit * 6);
  const px = (gesture.cx - stageRect.left - gesture.view.ox) / s0;
  const py = (gesture.cy - stageRect.top - gesture.view.oy) / s0;
  view.scale = s;
  view.ox = g.cx - stageRect.left - px * s;
  view.oy = g.cy - stageRect.top - py * s;
  clampView();
  dirty.base = dirty.live = true;
}
function endGesture() {
  gesture = null;
}

// ---------------------------------------------------------------------------
// Lasso selection: circle writing to select it, then drag it, or copy / cut /
// duplicate / delete it from the bar above it. Paste works across drawings.
// ---------------------------------------------------------------------------

let selection = null; // { ids: Set, halo: [stroke] } — halo strokes are the glow drawn behind the selection
let clipboard = (() => { try { return JSON.parse(localStorage.getItem('inkvault.clipboard') || 'null'); } catch { return null; } })();
const SEL_COLOR = '#8b7bff';
const selbar = $('#selbar');

function selectedStrokes() {
  return selection ? current.drawing.strokes.filter(s => selection.ids.has(s.id)) : [];
}

function setSelection(ids) {
  const list = ids && current ? current.drawing.strokes.filter(s => ids.has(s.id)) : [];
  selection = list.length
    ? { ids: new Set(list.map(s => s.id)), halo: list.map(s => ({ ...s, id: `${s.id}h`, color: SEL_COLOR, size: s.size + 7, tool: 'pen' })) }
    : null;
  dirty.live = true;
}

// after any change: drop strokes that no longer exist, pick up moved ones
function refreshSelection() {
  if (selection && input?.kind !== 'move') setSelection(selection.ids);
}

function selectionBox(dx = 0, dy = 0) {
  let b = null;
  for (const s of selectedStrokes()) {
    const r = strokeBBox(s);
    const pad = s.size + 8;
    b = b
      ? { minX: Math.min(b.minX, r.minX - pad), minY: Math.min(b.minY, r.minY - pad), maxX: Math.max(b.maxX, r.maxX + pad), maxY: Math.max(b.maxY, r.maxY + pad) }
      : { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
  }
  return b && { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function finishLasso(pts) {
  let span = 0;
  for (const p of pts) span = Math.max(span, Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]));
  if (span < 8) {
    // a tap: select the stroke under the pen
    const [x, y] = pts[0];
    const hit = eraseAlong(current.drawing.strokes, x, y, x, y, 6, 'stroke');
    setSelection(hit ? new Set([hit.remove[hit.remove.length - 1]]) : null);
    return;
  }
  // a stroke is selected when most of it lies inside the loop
  const ids = new Set();
  for (const s of current.drawing.strokes) {
    const inside = s.pts.filter(p => insidePolygon(p[0], p[1], pts)).length;
    if (inside / s.pts.length >= 0.5) ids.add(s.id);
  }
  setSelection(ids.size ? ids : null);
  if (!ids.size) showToast('Nothing selected');
}

const shifted = (s, dx, dy, extra = {}) => ({
  ...s,
  ...extra,
  pts: s.pts.map(p => [Math.round((p[0] + dx) * 10) / 10, Math.round((p[1] + dy) * 10) / 10, p[2], p[3]]),
});

function growFor(strokes, change) {
  const maxY = Math.max(...strokes.flatMap(s => s.pts.map(p => p[1])));
  if (maxY > current.drawing.height - 80) change.height = Math.ceil(maxY + 300);
  return change;
}

function finishMove(dx, dy) {
  dirty.base = true;
  if (Math.hypot(dx, dy) < 1) return;
  const ids = selection.ids;
  const moved = selectedStrokes().map(s => shifted(s, dx, dy)); // same ids: replaces the originals
  commit(growFor(moved, { add: moved }));
  setSelection(ids);
}

// new copies of strokes (new ids, painted on top in their original order)
function copies(strokes, dx, dy) {
  const base = Date.now() * 1000;
  return [...strokes].sort((a, b) => a.z - b.z).map((s, i) => shifted(s, dx, dy, { id: uid(), z: base + i }));
}

function copySelection() {
  const list = selectedStrokes();
  if (!list.length) return;
  clipboard = list;
  try { localStorage.setItem('inkvault.clipboard', JSON.stringify(list)); } catch {}
  updatePasteButton();
  showToast(`Copied ${list.length} stroke${list.length > 1 ? 's' : ''}`);
}
function deleteSelection() {
  if (!selection) return;
  commit({ remove: [...selection.ids] });
  setSelection(null);
}
function cutSelection() {
  copySelection();
  deleteSelection();
}
function duplicateSelection() {
  const list = selectedStrokes();
  if (!list.length) return;
  const dupes = copies(list, 24, 24);
  commit(growFor(dupes, { add: dupes }));
  setSelection(new Set(dupes.map(s => s.id)));
}
function paste() {
  if (!current || !clipboard?.length) return;
  // centre of the visible part of the page
  const cx = (stageRect.width / 2 - view.ox) / view.scale;
  const cy = (stageRect.height / 2 - view.oy) / view.scale;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of clipboard) for (const p of s.pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const dx = clamp(cx - (minX + maxX) / 2, 10 - minX, PAGE_WIDTH - 10 - maxX); // keep it on the page
  const dy = Math.max(cy - (minY + maxY) / 2, 10 - minY);
  const pasted = copies(clipboard, dx, dy);
  commit(growFor(pasted, { add: pasted }));
  settings.tool = 'lasso';
  save();
  renderToolbar();
  setSelection(new Set(pasted.map(s => s.id))); // selected, ready to drag into place
}

function updatePasteButton() {
  $('#paste').hidden = !clipboard?.length;
}

function renderSelection(ctx) {
  if (input?.kind === 'lasso') {
    ctx.save();
    ctx.strokeStyle = SEL_COLOR;
    ctx.lineWidth = 2 / view.scale;
    ctx.setLineDash([6 / view.scale, 5 / view.scale]);
    ctx.beginPath();
    input.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
  if (!selection) {
    selbar.hidden = true;
    return;
  }
  const moving = input?.kind === 'move';
  const dx = moving ? input.dx : 0;
  const dy = moving ? input.dy : 0;
  ctx.save();
  ctx.translate(dx, dy);
  for (const h of selection.halo) drawStroke(ctx, h, { alphaScale: 0.28 });
  if (moving) for (const s of selectedStrokes()) drawStroke(ctx, s, { dark: settings.darkPaper });
  ctx.restore();
  const b = selectionBox(dx, dy);
  if (!b) return;
  ctx.save();
  ctx.strokeStyle = SEL_COLOR;
  ctx.lineWidth = 1.2 / view.scale;
  ctx.setLineDash([5 / view.scale, 4 / view.scale]);
  ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  ctx.restore();
  // action bar above the selection (below it if there's no room), hidden while dragging
  selbar.hidden = moving;
  if (!moving) {
    const x = stageRect.left + view.ox + ((b.minX + b.maxX) / 2) * view.scale;
    const top = stageRect.top + view.oy + b.minY * view.scale;
    const bottom = stageRect.top + view.oy + b.maxY * view.scale;
    const h = selbar.offsetHeight || 44;
    const y = top - h - 10 > stageRect.top ? top - h - 10 : Math.min(bottom + 10, innerHeight - h - 10);
    selbar.style.left = `${clamp(x - selbar.offsetWidth / 2, 8, innerWidth - selbar.offsetWidth - 8)}px`;
    selbar.style.top = `${y}px`;
  }
}

selbar.addEventListener('pointerdown', e => e.stopPropagation());
selbar.querySelector('[data-act=copy]').onclick = copySelection;
selbar.querySelector('[data-act=cut]').onclick = cutSelection;
selbar.querySelector('[data-act=duplicate]').onclick = duplicateSelection;
selbar.querySelector('[data-act=delete]').onclick = deleteSelection;
$('#paste').onclick = paste;
updatePasteButton();

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

stage.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (e.pointerType === 'touch') onTouchDown(e);
  else onPenDown(e);
});
stage.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') onTouchMove(e);
  else onPenMove(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  stage.addEventListener(type, e => {
    if (e.pointerType === 'touch') onTouchUp(e);
    else onPenUp(e);
  });
}
stage.addEventListener('pointerleave', e => {
  if (e.pointerType !== 'touch' && !input) { hover = null; dirty.live = true; }
});
// iOS: stop the page from scrolling/zooming/selecting under the palm and pen.
for (const type of ['touchstart', 'touchmove', 'touchend']) stage.addEventListener(type, e => e.preventDefault(), { passive: false });
stage.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

// Mouse wheel / trackpad (handy when testing from a desktop browser)
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    const s0 = view.scale;
    const fit = (stageRect.width - 20) / PAGE_WIDTH;
    const s = clamp(s0 * Math.exp(-e.deltaY * 0.01), fit * 0.5, fit * 6);
    const px = (e.clientX - stageRect.left - view.ox) / s0;
    const py = (e.clientY - stageRect.top - view.oy) / s0;
    view.scale = s;
    view.ox = e.clientX - stageRect.left - px * s;
    view.oy = e.clientY - stageRect.top - py * s;
  } else {
    view.ox -= e.deltaX;
    view.oy -= e.deltaY;
  }
  clampView();
  dirty.base = dirty.live = true;
}, { passive: false });

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'c') { e.preventDefault(); copySelection(); }
  else if (mod && k === 'x') { e.preventDefault(); cutSelection(); }
  else if (mod && k === 'v') { e.preventDefault(); paste(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape' && selection) setSelection(null);
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function renderToolbar() {
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === settings.tool));
  const tool = settings.tool;
  const colors = $('#colors');
  colors.innerHTML = '';
  for (const c of PALETTES[tool] || []) {
    const b = document.createElement('button');
    b.className = 'swatch' + (settings[tool].color === c ? ' on' : '');
    b.style.setProperty('--c', inkColor(c, settings.darkPaper)); // show the colour as it will look
    b.setAttribute('aria-label', `Color ${c}`);
    b.onclick = () => { settings[tool].color = c; save(); renderToolbar(); };
    colors.appendChild(b);
  }
  if (PALETTES[tool]) {
    const custom = document.createElement('label');
    custom.className = 'swatch custom';
    custom.title = 'Custom color';
    custom.innerHTML = `<input type="color" value="${settings[tool].color}">`;
    custom.querySelector('input').oninput = e => { settings[tool].color = e.target.value; save(); };
    custom.querySelector('input').onchange = () => renderToolbar();
    if (!PALETTES[tool].includes(settings[tool].color)) custom.classList.add('on');
    colors.appendChild(custom);
  }
  colors.hidden = !PALETTES[tool];
  const sizes = $('#sizes');
  sizes.innerHTML = '';
  sizes.hidden = !SIZES[tool];
  (SIZES[tool] || []).forEach((sz, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (settings[tool].size === i ? ' on' : '');
    b.innerHTML = `<i style="width:${6 + i * 5}px;height:${6 + i * 5}px"></i>`;
    b.setAttribute('aria-label', ['Fine', 'Medium', 'Thick'][i]);
    b.onclick = () => { settings[tool].size = i; save(); renderToolbar(); };
    sizes.appendChild(b);
  });
  $('#opt-scribble').checked = settings.scribble;
  $('#opt-dark').checked = settings.darkPaper;
  $('#opt-precise').checked = settings.eraser.mode === 'precise';
}

document.querySelectorAll('[data-tool]').forEach(b => {
  b.onclick = () => {
    settings.tool = b.dataset.tool;
    if (settings.tool !== 'lasso') setSelection(null);
    save();
    renderToolbar();
  };
});
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#done').onclick = () => { if (current) sock.send({ type: 'close', id: current.id }); closeDrawing(); };
$('#more').onclick = e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu, #more')) closeMenu(); });
function closeMenu() { $('#menu').hidden = true; }

$('#opt-scribble').onchange = e => { settings.scribble = e.target.checked; save(); };
$('#opt-dark').onchange = e => {
  settings.darkPaper = e.target.checked;
  save();
  renderToolbar();
  dirty.base = dirty.live = true;
};
$('#opt-precise').onchange = e => { settings.eraser.mode = e.target.checked ? 'precise' : 'stroke'; save(); };
$('#act-extend').onclick = () => { if (current) commit({ height: current.drawing.height + 400 }); closeMenu(); };
$('#act-fit').onclick = () => { fitWidth(); closeMenu(); };
$('#act-clear').onclick = () => {
  closeMenu();
  if (current?.drawing.strokes.length && confirm('Clear this drawing? You can undo this.')) commit({ remove: current.drawing.strokes.map(s => s.id) });
};
$('#act-fullscreen').onclick = () => {
  closeMenu();
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => showToast('Fullscreen not available'));
};

// ---------------------------------------------------------------------------
// Misc: toast, wake lock, PWA install
// ---------------------------------------------------------------------------

let toastTimer = 0;
function showToast(text, ms = 900) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && current) keepAwake(true); });

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});
$('#install').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install').hidden = true;
};
// Tapping the empty idle screen reveals a tiny status line, then hides it again.
idle.addEventListener('click', e => {
  if (e.target.closest('button')) return;
  idle.classList.add('reveal');
  clearTimeout(idle._t);
  idle._t = setTimeout(() => idle.classList.remove('reveal'), 4000);
});
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Fullscreen without installing: browsers only allow it in response to a tap,
// so the first tap (or pen lift) enters fullscreen. Skipped when installed as an app.
const installed = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
function enterFullscreen() {
  if (installed || !settings.autoFullscreen || document.fullscreenElement || document.webkitFullscreenElement) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  try { req?.call(el, { navigationUI: 'hide' })?.catch?.(() => {}); } catch {}
}
for (const type of ['pointerup', 'touchend', 'click']) document.addEventListener(type, enterFullscreen, true);
$('#opt-autofs').checked = settings.autoFullscreen;
$('#opt-autofs').onchange = e => { settings.autoFullscreen = e.target.checked; save(); if (e.target.checked) enterFullscreen(); };

// Over plain http the browser withholds full-rate pen samples; point to the setup page.
if (!window.isSecureContext) {
  fetch('/api/info').then(r => r.json()).then(info => {
    if (!info.https) return;
    $('#setup-link').hidden = false;
    $('#act-setup').hidden = false;
  }).catch(() => {});
}

renderToolbar();
updateUndoButtons();
resize();
