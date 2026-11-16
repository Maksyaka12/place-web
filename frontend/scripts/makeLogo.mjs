// Draws the Place logo (a ring with a dot: "you are here") and writes the site icons into public/:
// logo.svg, logo.png (512), icon-192.png, apple-touch-icon.png (180) and favicon.ico (48, PNG inside).
// No image libraries: the shapes are rasterized here with 4×4 supersampling. Run: node scripts/makeLogo.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '../public');
// Dark theme tokens: --bg-bar for the plate, --accent for the mark.
const PLATE = [0x0b, 0x0c, 0x0f];
const MARK = [0x66, 0xbe, 0xff];

// Geometry on a 100×100 canvas.
const RADIUS = 22; // plate corner
const RING = { r: 26, w: 9 };
const DOT = 9;

export const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${RADIUS}" fill="#0B0C0F"/>
  <circle cx="50" cy="50" r="${RING.r}" fill="none" stroke="#66BEFF" stroke-width="${RING.w}"/>
  <circle cx="50" cy="50" r="${DOT}" fill="#66BEFF"/>
</svg>
`;

function insidePlate(x, y) {
  const r = RADIUS;
  const cx = Math.min(Math.max(x, r), 100 - r);
  const cy = Math.min(Math.max(y, r), 100 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function colorAt(x, y) {
  if (!insidePlate(x, y)) return null;
  const d = Math.hypot(x - 50, y - 50);
  if (d <= DOT || Math.abs(d - RING.r) <= RING.w / 2) return MARK;
  return PLATE;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt(((x + (sx + 0.5) / ss) / size) * 100, ((y + (sy + 0.5) / ss) / size) * 100);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(pngBuf, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = size;
  head[7] = size;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bpp
  head.writeUInt32LE(pngBuf.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBuf]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  fs.writeFileSync(path.join(OUT, 'logo.svg'), SVG);
  fs.writeFileSync(path.join(OUT, 'logo.png'), render(512));
  fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192));
  fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), render(180));
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico(render(48), 48));
  console.log('Place icons written to', OUT);
}
