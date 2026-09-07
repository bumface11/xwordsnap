// Generates simple crossword-grid PNG icons without external deps (raw PNG via zlib).
// Run: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5×5 crossword motif with a symmetric block pattern
const BLOCKS = new Set(['0,0', '4,0', '1,1', '3,1', '2,2', '1,3', '3,3', '0,4', '4,4']);
const BG = [17, 17, 17], LINE = [60, 60, 60], WHITE = [245, 245, 245], ACCENT = [47, 111, 237];

function makeIcon(size, gridFraction) {
  const grid = size * gridFraction;
  const origin = (size - grid) / 2;
  const cell = grid / 5;
  const line = Math.max(2, Math.round(size / 128));
  return encodePng(size, (x, y) => {
    const gx = x - origin, gy = y - origin;
    if (gx < -line || gy < -line || gx > grid + line || gy > grid + line) return BG;
    const c = Math.floor(gx / cell), r = Math.floor(gy / cell);
    if (c < 0 || r < 0 || c > 4 || r > 4) return LINE; // outer border
    if (gx % cell < line || gy % cell < line) return LINE;
    if (BLOCKS.has(`${c},${r}`)) return BG;
    if (c === 0 && r === 0) return ACCENT;
    return WHITE;
  });
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192, 0.85));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512, 0.85));
fs.writeFileSync(path.join(outDir, 'icon-512-maskable.png'), makeIcon(512, 0.6));
console.log('icons written to icons/');
