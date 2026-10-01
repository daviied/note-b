// Tablet client: shows nothing until the PC opens a drawing field, then
// becomes a pen-only canvas. Fingers never draw (palm rejection); two fingers
// pan/zoom.
import { connect } from '../common/socket.js';
import {
  PAGE_WIDTH, drawPage, drawStroke, applyChange, inverseOf, finishPoints,
  eraseAlong, detectScribble, uid,
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
// desynchronized = low-latency canvas (draws without waiting for the page compositor) where supported
const liveCtx = liveCv.getContext('2d', { desynchronized: true }) || liveCv.getContext('2d');
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
    if (m.type === 'open' && m.drawing) openDrawing(m);
    else if (m.type === 'close') closeDrawing();
    else if (m.type === 'state' && !m.active && current) closeDrawing();
    else if (m.type === 'change' && current && m.id === current.id) {
      applyChange(current.drawing, m.change);
      dirty.base = true;
    }
  },
});

function openDrawing({ id, note, drawing }) {
  const same = current && current.id === id;
  if (!same) cancelInput();
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
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, d.width, d.height);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, d.width, d.height);
  ctx.clip();
  drawPage(ctx, d);
  ctx.restore();
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
    drawStroke(ctx, s, { cache: false });
  }
  const cursor = input && input.kind === 'erase' ? input.last : hover;
  if (cursor) {
    const erasing = (input && input.kind === 'erase') || hover?.eraser;
    ctx.lineWidth = 1.2 / view.scale;
    ctx.beginPath();
    if (erasing) {
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.arc(cursor[0], cursor[1], eraserRadius(), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const t = settings[settings.tool] || settings.pen;
      ctx.fillStyle = t.color || '#000';
      ctx.globalAlpha = 0.6;
      ctx.arc(cursor[0], cursor[1], Math.max(1.5, (SIZES[settings.tool]?.[t.size] || 3) / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function frame() {
  if (dirty.base) { dirty.base = false; renderBase(); }
  if (dirty.live) { dirty.live = false; renderLive(); }
  requestAnimationFrame(frame);
}
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
  dirty.base = true;
  updateUndoButtons();
}

function undo() {
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
    else {
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
  else finishStroke(done.stroke);
  dirty.live = true;
}

function cancelInput() {
  if (input?.kind === 'draw') sock.send({ type: 'live', id: current?.id, sid: input.stroke.id, stroke: null });
  if (input?.kind === 'erase') finishErase(input);
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
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
    b.style.setProperty('--c', c);
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
  colors.hidden = tool === 'eraser';
  const sizes = $('#sizes');
  sizes.innerHTML = '';
  SIZES[tool].forEach((sz, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (settings[tool].size === i ? ' on' : '');
    b.innerHTML = `<i style="width:${6 + i * 5}px;height:${6 + i * 5}px"></i>`;
    b.setAttribute('aria-label', ['Fine', 'Medium', 'Thick'][i]);
    b.onclick = () => { settings[tool].size = i; save(); renderToolbar(); };
    sizes.appendChild(b);
  });
  $('#opt-scribble').checked = settings.scribble;
  $('#opt-precise').checked = settings.eraser.mode === 'precise';
}

document.querySelectorAll('[data-tool]').forEach(b => {
  b.onclick = () => { settings.tool = b.dataset.tool; save(); renderToolbar(); };
});
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#done').onclick = () => { if (current) sock.send({ type: 'close', id: current.id }); closeDrawing(); };
$('#more').onclick = e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu, #more')) closeMenu(); });
function closeMenu() { $('#menu').hidden = true; }

$('#opt-scribble').onchange = e => { settings.scribble = e.target.checked; save(); };
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
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 900);
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
