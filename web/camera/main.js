// Phone camera client: waits until the PC asks for a picture, then offers
// "Take photo" / "Choose from gallery" (browsers only open these on a tap).
// The photo then goes through a scan step: drag four corners onto the board,
// see it straightened and cleaned up, and send it.
import { connect } from '../common/socket.js';
import { detectQuad, warp, enhance, rotate } from './scan.js';

const MAX_SOURCE = 3200; // px; working size of the photo while editing
const MAX_OUTPUT = 2400; // px; size of what's sent to the PC
const $ = s => document.querySelector(s);
const screens = { idle: $('#idle'), ask: $('#ask'), edit: $('#edit'), result: $('#result'), sending: $('#sending') };
const pending = new Map(); // reqId -> { reqId, note } (oldest first)
let job = null; // { req, src (canvas), quad, warped, cleaned, turns }

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  if (name === 'edit') requestAnimationFrame(drawEditor);
  if (name === 'result') requestAnimationFrame(drawResult);
}

function nextRequest() {
  if (job) return;
  const r = pending.values().next().value;
  if (!r) return show('idle');
  $('#note').textContent = (r.note || 'your note').replace(/\.md$/i, '').split('/').pop();
  show('ask');
}

const sock = connect('camera', {
  onStatus: ok => document.body.classList.toggle('online', ok),
  onMessage(m) {
    if (m.type === 'photo-request') {
      pending.set(m.reqId, m);
      if (navigator.vibrate) navigator.vibrate(60);
      nextRequest();
    } else if (m.type === 'photo-done' || m.type === 'photo-cancel') {
      pending.delete(m.reqId);
      if (job?.req.reqId === m.reqId) {
        job = null;
        if (m.type === 'photo-cancel') toast('Cancelled on the PC');
      }
      nextRequest();
    }
  },
});

// ---------------------------------------------------------------------------
// Loading the photo
// ---------------------------------------------------------------------------

async function start(file) {
  const req = pending.values().next().value;
  if (!file || !req) return;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // this browser can't decode it (rare): skip the scan step and send the original
    return sendBlob(req, file);
  }
  const k = Math.min(1, MAX_SOURCE / Math.max(bmp.width, bmp.height));
  const src = document.createElement('canvas');
  src.width = Math.round(bmp.width * k);
  src.height = Math.round(bmp.height * k);
  src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
  job = { req, src, quad: detectQuad(src), warped: null, cleaned: null, turns: 0 };
  show('edit');
}

// ---------------------------------------------------------------------------
// Step 1: corner editor
// ---------------------------------------------------------------------------

const editCv = $('#edit-canvas');
const editCtx = editCv.getContext('2d');
let drag = null; // { i (corner index), pointerId }
let fit = { s: 1, ox: 0, oy: 0 };

function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
  }
  return { w: r.width, h: r.height, dpr };
}

function drawEditor() {
  if (!job || screens.edit.hidden) return;
  const { w, h, dpr } = sizeCanvas(editCv);
  const { src, quad } = job;
  const pad = 22;
  const s = Math.min((w - pad * 2) / src.width, (h - pad * 2) / src.height);
  fit = { s, ox: (w - src.width * s) / 2, oy: (h - src.height * s) / 2 };
  const P = ([x, y]) => [fit.ox + x * s, fit.oy + y * s];
  const ctx = editCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, fit.ox, fit.oy, src.width * s, src.height * s);
  // dim everything outside the quad
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  quad.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill('evenodd');
  ctx.restore();
  // outline + handles
  ctx.strokeStyle = '#8b7bff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  quad.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  quad.map(P).forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, drag?.i === i ? 15 : 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(139,123,255,.35)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
  // magnifier while dragging, in the corner away from the finger
  if (drag) {
    const [hx, hy] = P(quad[drag.i]);
    const R = 58, zoom = 2.5;
    const cx = hx < w / 2 ? w - R - 10 : R + 10;
    const cy = R + 10;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const [ix, iy] = quad[drag.i];
    const ss = s * zoom;
    ctx.drawImage(src, cx - ix * ss, cy - iy * ss, src.width * ss, src.height * ss);
    ctx.strokeStyle = '#8b7bff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

const toImage = e => {
  const r = editCv.getBoundingClientRect();
  return [(e.clientX - r.left - fit.ox) / fit.s, (e.clientY - r.top - fit.oy) / fit.s];
};

editCv.addEventListener('pointerdown', e => {
  if (!job) return;
  const [x, y] = toImage(e);
  let best = -1, bestD = 44 / fit.s; // touch radius in image pixels
  job.quad.forEach(([qx, qy], i) => {
    const d = Math.hypot(qx - x, qy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return;
  drag = { i: best, pointerId: e.pointerId, offset: [job.quad[best][0] - x, job.quad[best][1] - y] };
  editCv.setPointerCapture(e.pointerId);
  drawEditor();
});
editCv.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const [x, y] = toImage(e);
  job.quad[drag.i] = [
    Math.max(0, Math.min(job.src.width, x + drag.offset[0])),
    Math.max(0, Math.min(job.src.height, y + drag.offset[1])),
  ];
  drawEditor();
});
for (const t of ['pointerup', 'pointercancel']) editCv.addEventListener(t, () => { drag = null; drawEditor(); });

$('#edit-whole').onclick = () => {
  const { width: W, height: H } = job.src;
  job.quad = [[0, 0], [W, 0], [W, H], [0, H]];
  drawEditor();
};
$('#edit-auto').onclick = () => { job.quad = detectQuad(job.src); drawEditor(); };
$('#edit-back').onclick = () => { job = null; nextRequest(); };
$('#edit-next').onclick = async () => {
  const btn = $('#edit-next');
  btn.disabled = true;
  btn.textContent = 'Straightening…';
  await new Promise(r => setTimeout(r, 30)); // let the label paint before the heavy work
  try {
    job.warped = warp(job.src, job.quad, MAX_OUTPUT);
    job.cleaned = null;
    show('result');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Next';
  }
};

// ---------------------------------------------------------------------------
// Step 2: result preview
// ---------------------------------------------------------------------------

const resultCv = $('#result-canvas');

function finalCanvas() {
  let c = job.warped;
  if ($('#res-enhance').checked) c = job.cleaned ||= enhance(job.warped);
  return rotate(c, job.turns);
}

function drawResult() {
  if (!job || screens.result.hidden) return;
  const { w, h, dpr } = sizeCanvas(resultCv);
  const img = finalCanvas();
  const s = Math.min(w / img.width, h / img.height);
  const ctx = resultCv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
}

$('#res-back').onclick = () => show('edit');
$('#res-rotate').onclick = () => { job.turns++; drawResult(); };
$('#res-enhance').onchange = async () => {
  await new Promise(r => setTimeout(r, 30));
  drawResult();
};
$('#res-send').onclick = async () => {
  const blob = await new Promise(r => finalCanvas().toBlob(r, 'image/jpeg', 0.88));
  sendBlob(job.req, blob);
};

window.addEventListener('resize', () => { drawEditor(); drawResult(); });

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function upload(blob, name, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/attachment?name=${encodeURIComponent(name)}`);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || `HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(blob);
  });
}

async function sendBlob(req, blob) {
  job ||= { req };
  show('sending');
  const preview = $('#preview');
  preview.src = URL.createObjectURL(blob);
  $('#progress').style.width = '0';
  $('#sending-text').textContent = 'Sending to PC…';
  const name = `photo-${req.reqId}.jpg`;
  try {
    await upload(blob, name, f => { $('#progress').style.width = `${Math.round(f * 100)}%`; });
    sock.send({ type: 'photo-done', reqId: req.reqId, name });
    pending.delete(req.reqId);
    toast('Sent ✓');
    job = null;
  } catch (err) {
    toast(`Couldn't send: ${err.message}`, 4000);
    show(job.warped ? 'result' : 'ask'); // try again from where you were
    return;
  } finally {
    URL.revokeObjectURL(preview.src);
  }
  nextRequest();
}

// ---------------------------------------------------------------------------

for (const id of ['#take', '#pick']) {
  $(id).addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still fires
    start(file);
  });
}
$('#cancel').onclick = () => {
  const r = pending.values().next().value;
  if (!r) return;
  sock.send({ type: 'photo-cancel', reqId: r.reqId });
  pending.delete(r.reqId);
  nextRequest();
};

let toastTimer = 0;
function toast(text, ms = 1500) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
show('idle');
