// Generates the PWA icons (PNG) at startup so the repo needs no binary files.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

// Purple tile with a white ink squiggle. `pad` shrinks the art for maskable icons.
function icon(size, { pad = 0, rounded = true } = {}) {
  const s = size;
  const wave = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    wave.push([0.22 + 0.56 * t, 0.56 - 0.13 * Math.sin(t * Math.PI * 2.2) - 0.06 * t]);
  }
  return png(s, (x, y) => {
    const u = x / s, v = y / s;
    if (rounded) {
      const r = 0.22, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
      const d = Math.hypot(u - cx, v - cy) - r;
      if (d > 0) return [0, 0, 0, 0];
    }
    const k = 1 - 2 * pad;
    const au = (u - pad) / k, av = (v - pad) / k;
    let d = Infinity, idx = 0;
    for (let i = 1; i < wave.length; i++) {
      const dd = segDist(au, av, wave[i - 1][0], wave[i - 1][1], wave[i][0], wave[i][1]);
      if (dd < d) { d = dd; idx = i; }
    }
    const w = 0.025 + 0.035 * (idx / wave.length); // stroke swells like pressure
    const a = Math.max(0, Math.min(1, (w - d) * s * k + 0.5));
    const bg = [109, 93, 252];
    return [Math.round(bg[0] + (255 - bg[0]) * a), Math.round(bg[1] + (255 - bg[1]) * a), Math.round(bg[2] + (255 - bg[2]) * a), 255];
  });
}

export async function ensureIcons(dir) {
  await fs.mkdir(dir, { recursive: true });
  const files = {
    'icon-192.png': () => icon(192),
    'icon-512.png': () => icon(512),
    'maskable-512.png': () => icon(512, { pad: 0.12, rounded: false }),
    'apple-touch-icon.png': () => icon(180, { rounded: false }),
  };
  for (const [name, make] of Object.entries(files)) {
    const p = path.join(dir, name);
    try { await fs.access(p); } catch { await fs.writeFile(p, make()); }
  }
}
