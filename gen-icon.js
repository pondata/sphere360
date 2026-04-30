// Pure-Node PNG icon generator (no deps). Run: node gen-icon.js
const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  // 10..12 default 0

  const raw = Buffer.alloc(size * (1 + 3 * size));
  const cx = size / 2, cy = size / 2;
  const rOuter = size * 0.42, rInner = size * 0.30;
  // sphere wireframe: dark gradient bg, glowing ring + meridians

  for (let y = 0; y < size; y++) {
    raw[y * (1 + 3 * size)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = (x - cx), dy = (y - cy);
      const dist = Math.hypot(dx, dy);
      const t = y / size;
      // bg: deep gradient
      let R = 12 + t * 38, G = 14 + t * 22, B = 36 + t * 60;
      // outer glow ring (sphere outline)
      const ring = Math.exp(-Math.pow(dist - rOuter, 2) / 18);
      R += 220 * ring; G += 240 * ring; B += 255 * ring;
      // meridian curves: ellipses scaled by cos(angle)
      const px = dx / rOuter, py = dy / rOuter;
      if (Math.abs(px) <= 1 && Math.abs(py) <= 1) {
        // draw 3 meridians (ellipses with horizontal radius cos(theta))
        for (const theta of [-1.0, -0.4, 0.4, 1.0]) {
          const a = Math.abs(Math.cos(theta));
          if (a < 0.01) continue;
          const ex = px / a;
          const r2 = ex * ex + py * py;
          const m = Math.exp(-Math.pow(Math.sqrt(r2) - 1, 2) * 220);
          R += 120 * m; G += 180 * m; B += 230 * m;
        }
        // 2 latitudes (horizontal lines distorted by sphere)
        for (const lat of [-0.4, 0.0, 0.4]) {
          const yLine = lat;
          const m = Math.exp(-Math.pow(py - yLine, 2) * 400) * (1 - Math.min(1, r2(px,py)));
          R += 80 * m; G += 140 * m; B += 200 * m;
        }
      }
      const idx = y * (1 + 3 * size) + 1 + x * 3;
      raw[idx]     = clamp(R);
      raw[idx + 1] = clamp(G);
      raw[idx + 2] = clamp(B);
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function r2(x, y) { return x*x + y*y; }
function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

for (const sz of [180, 192, 512]) {
  fs.writeFileSync(`icon-${sz}.png`, makePng(sz));
  console.log(`wrote icon-${sz}.png`);
}
