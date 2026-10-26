// Whiteboard / document scanning, all in the browser:
//  detectQuad  - guess the board's four corners (largest bright, colourless area)
//  warp        - perspective-correct that quadrilateral into a flat rectangle
//  enhance     - remove shadows / glare: white background, crisp marker colours
//  rotate      - quarter turns

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

// Returns [[x,y] x4] = top-left, top-right, bottom-right, bottom-left, in source pixels.
export function detectQuad(src) {
  const W = src.width, H = src.height;
  const fallback = () => {
    const mx = W * 0.08, my = H * 0.08;
    return [[mx, my], [W - mx, my], [W - mx, H - my], [mx, H - my]];
  };
  const sw = 160;
  const sh = Math.max(1, Math.round((H / W) * sw));
  const small = canvasOf(sw, sh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0, sw, sh);
  const px = sctx.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;

  // brightness + "colourlessness" (boards are white-ish)
  const lum = new Float32Array(n);
  const sat = new Float32Array(n);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
    hist[Math.round(lum[i])]++;
  }
  // Otsu threshold on brightness
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = lum[i] > thr && sat[i] < 70 ? 1 : 0;

  // close small holes (marker writing) so the board is one region
  const grown = new Uint8Array(n);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let on = 0;
    for (let dy = -2; dy <= 2 && !on; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < sw && yy < sh && mask[yy * sw + xx]) { on = 1; break; }
    }
    grown[y * sw + x] = on;
  }

  // largest connected region
  const label = new Int32Array(n).fill(-1);
  let bestId = -1, bestSize = 0;
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (!grown[i] || label[i] >= 0) continue;
    let size = 0;
    stack.push(i);
    label[i] = i;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % sw, y = (j / sw) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < sw - 1 ? j + 1 : -1, y > 0 ? j - sw : -1, y < sh - 1 ? j + sw : -1]) {
        if (k >= 0 && grown[k] && label[k] < 0) { label[k] = i; stack.push(k); }
      }
    }
    if (size > bestSize) { bestSize = size; bestId = i; }
  }
  if (bestId < 0 || bestSize < n * 0.12 || bestSize > n * 0.97) return fallback();

  // corners = extreme points of the region along the diagonals
  const ext = [[Infinity], [-Infinity], [-Infinity], [Infinity]].map(v => ({ v: v[0], p: null }));
  for (let i = 0; i < n; i++) {
    if (label[i] !== bestId) continue;
    const x = i % sw, y = (i / sw) | 0;
    if (x + y < ext[0].v) ext[0] = { v: x + y, p: [x, y] }; // top-left
    if (x - y > ext[1].v) ext[1] = { v: x - y, p: [x, y] }; // top-right
    if (x + y > ext[2].v) ext[2] = { v: x + y, p: [x, y] }; // bottom-right
    if (x - y < ext[3].v) ext[3] = { v: x - y, p: [x, y] }; // bottom-left
  }
  // pull each corner slightly towards the middle, so no sliver of wall sneaks in at the edges
  const k = W / sw;
  const pts = ext.map(e => [(e.p[0] + 0.5) * k, (e.p[1] + 0.5) * k]);
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const inset = 2.5 * k; // ~2.5 pixels of the small analysis image
  return pts.map(([x, y]) => {
    const d = Math.hypot(cx - x, cy - y) || 1;
    return [clamp(x + ((cx - x) / d) * inset, 0, W), clamp(y + ((cy - y) / d) * inset, 0, H)];
  });
}

// ---------------------------------------------------------------------------
// Perspective warp
// ---------------------------------------------------------------------------

// Homography mapping the rectangle (0,0)-(w,h) onto quad (TL, TR, BR, BL).
function homography(w, h, quad) {
  const from = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = quad[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return [...x, 1];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function warp(src, quad, maxSide = 2400) {
  // output size from the average lengths of opposite sides
  let w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  let h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const k = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));

  const sw = src.width, sh = src.height;
  const sdata = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = canvasOf(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const [a, b, c, dd, e, f, g, hh] = homography(w, h, quad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const z = g * px + hh * py + 1;
      const u = (a * px + b * py + c) / z - 0.5;
      const v = (dd * px + e * py + f) / z - 0.5;
      // bilinear sample
      const x0 = clamp(Math.floor(u), 0, sw - 1), y0 = clamp(Math.floor(v), 0, sh - 1);
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = clamp(u - x0, 0, 1), fy = clamp(v - y0, 0, 1);
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sdata[i00 + ch] + (sdata[i10 + ch] - sdata[i00 + ch]) * fx;
        const bot = sdata[i01 + ch] + (sdata[i11 + ch] - sdata[i01 + ch]) * fx;
        d[o + ch] = top + (bot - top) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Clean-up: divide by an estimate of the board's own (uneven) brightness so
// it becomes evenly white, then deepen the ink and its colour.
// ---------------------------------------------------------------------------

export function enhance(src) {
  const W = src.width, H = src.height;
  // background estimate: small copy, "max" filter wipes out thin marker lines, then blur
  const bw = 96;
  const bh = Math.max(1, Math.round((H / W) * bw));
  const small = canvasOf(bw, bh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0, bw, bh);
  let s = sctx.getImageData(0, 0, bw, bh);
  const filter = (data, fn, r) => {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let acc = fn === 'max' ? 0 : 0, cnt = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const xx = clamp(x + dx, 0, bw - 1), yy = clamp(y + dy, 0, bh - 1);
          const v = data[(yy * bw + xx) * 4 + ch];
          if (fn === 'max') acc = Math.max(acc, v); else { acc += v; cnt++; }
        }
        out[(y * bw + x) * 4 + ch] = fn === 'max' ? acc : acc / cnt;
      }
      out[(y * bw + x) * 4 + 3] = 255;
    }
    return out;
  };
  let bg = filter(s.data, 'max', 2);
  bg = filter(bg, 'blur', 2);
  bg = filter(bg, 'blur', 2);
  sctx.putImageData(new ImageData(bg, bw, bh), 0, 0);
  const bgFull = canvasOf(W, H);
  const bctx = bgFull.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, W, H);
  const bgd = bctx.getImageData(0, 0, W, H).data;

  const out = canvasOf(W, H);
  const octx = out.getContext('2d');
  const img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = 0, g = 0, b = 0;
    for (let ch = 0; ch < 3; ch++) {
      const ratio = d[i + ch] / Math.max(bgd[i + ch], 1); // 1 = board, lower = ink
      const v = 255 * Math.pow(clamp((ratio - 0.32) / 0.6, 0, 1), 1.6);
      if (ch === 0) r = v; else if (ch === 1) g = v; else b = v;
    }
    // a little more colour so red / blue / green markers stay distinct
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = y + (r - y) * 1.35;
    d[i + 1] = y + (g - y) * 1.35;
    d[i + 2] = y + (b - y) * 1.35;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

export function rotate(src, quarterTurns) {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (!t) return src;
  const out = canvasOf(t % 2 ? src.height : src.width, t % 2 ? src.width : src.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((t * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}
