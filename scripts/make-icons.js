// Generates the PNG app icons (iOS home screen needs PNG). Run: node scripts/make-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TOP = [47, 214, 163];
const BOTTOM = [12, 92, 74];

function pixel(x, y) {
  // x, y in 0..1. Background gradient + vinyl disc with a mint label.
  let c = mix(TOP, BOTTOM, (x + y) / 2);
  const dx = x - 0.5;
  const dy = y - 0.5;
  const r = Math.hypot(dx, dy);
  if (r < 0.34) {
    c = [16, 16, 16];
    if (r > 0.13 && Math.floor(r * 90) % 3 === 0) c = [36, 36, 36]; // grooves
    // highlight
    const a = Math.atan2(dy, dx);
    const glare = Math.max(0, Math.cos(a * 2 - 0.9)) * 0.08 * (r > 0.13 ? 1 : 0);
    c = mix(c, [255, 255, 255], glare);
  }
  if (r < 0.11) c = TOP;
  if (r < 0.025) c = [16, 16, 16];
  return c;
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          acc = acc.map((v, i) => v + p[i]);
        }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
  console.log(`icon-${size}.png`);
}
