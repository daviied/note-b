// Phone camera client: waits until the PC asks for a picture, then offers
// "Take photo" / "Choose from gallery" (browsers only open these on a tap),
// shrinks the photo, uploads it and tells the PC it's there.
import { connect } from '../common/socket.js';

const MAX_SIDE = 2400; // px; plenty for notes, keeps uploads small
const $ = s => document.querySelector(s);
const screens = { idle: $('#idle'), ask: $('#ask'), sending: $('#sending') };
const pending = new Map(); // reqId -> { reqId, note } (oldest first)
let busy = false;

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

function nextRequest() {
  if (busy) return;
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
      nextRequest();
    }
  },
});

// Downscale + re-encode as JPEG (also turns iPhone HEIC into something every browser shows).
async function prepare(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch {
    return file; // couldn't decode it here; send the original
  }
}

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

async function send(file) {
  const r = pending.values().next().value;
  if (!file || !r) return;
  busy = true;
  show('sending');
  const preview = $('#preview');
  preview.src = URL.createObjectURL(file);
  $('#progress').style.width = '0';
  $('#sending-text').textContent = 'Sending to PC…';
  const name = `photo-${r.reqId}.jpg`;
  try {
    const blob = await prepare(file);
    await upload(blob, name, f => { $('#progress').style.width = `${Math.round(f * 100)}%`; });
    sock.send({ type: 'photo-done', reqId: r.reqId, name });
    pending.delete(r.reqId);
    toast('Sent ✓');
  } catch (err) {
    toast(`Couldn't send: ${err.message}`, 4000);
  } finally {
    URL.revokeObjectURL(preview.src);
    busy = false;
    nextRequest();
  }
}

for (const id of ['#take', '#pick']) {
  $(id).addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still fires
    send(file);
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
