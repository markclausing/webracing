// Draws the app icons and writes them as PNGs.
//
//   node tools/make-icons.js
//
// Hand rolled rather than pulled from a library, the same way websoccer does it:
// a PNG is a header, one zlib stream of filtered scanlines and a trailer, and
// node has zlib built in. That keeps the project at zero dependencies, and the
// icons stay reproducible - run this again and you get the same bytes.
//
// The picture is a corner of road with the red car on it, in the colours the
// game actually uses, taken from constants.js rather than typed out again.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CAR_PRESETS } from '../src/constants.js';
import { TRACKS } from '../src/game/tracks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba length size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlacing

  // Each scanline is prefixed with its filter type; 0 means "store as is".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** '#e0453c' -> [224, 69, 60]. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A bend of road with the red car coming round it.
 *
 * Everything is drawn against a circle centred off the bottom-left corner, so
 * the road sweeps across the icon rather than lying flat: at 32 pixels a
 * straight piece of road is a stripe and could be anything, and a curve reads as
 * a racetrack immediately.
 */
function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (Math.round(y) * size + Math.round(x)) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  const fill = (colour) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, colour);
  };

  // The breakfast table's palette, because that is the first table you race.
  const theme = TRACKS[0].theme;
  const grass = rgb(theme.shoulder);
  const road = rgb(theme.road);
  const line = rgb(theme.line);
  const dark = rgb(theme.floor);

  fill(grass);

  // The bend: a ring centred outside the icon, so only the arc shows.
  const cx = -size * 0.12;
  const cy = size * 1.12;
  const mid = size * 0.86;
  const half = size * 0.21;
  const paint = size * 0.022;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const off = Math.abs(d - mid);
      if (off > half) continue;
      if (off > half - paint * 2) set(x, y, dark);
      else if (off > half - paint * 3.4) set(x, y, line);
      else set(x, y, road);
    }
  }

  // Dashes down the middle of it, spaced by angle so they follow the curve.
  for (let a = 0; a < 900; a++) {
    const t = (a / 900) * Math.PI * 0.5;
    if (Math.floor(a / 75) % 2) continue;
    for (let w = -paint; w <= paint; w += 0.4) {
      set(cx + Math.cos(-t) * (mid + w), cy + Math.sin(-t) * (mid + w), line);
    }
  }

  // The car, angled to the road, drawn as a rounded box with two dark wheels
  // either side and a windscreen towards the nose.
  const car = CAR_PRESETS[0];
  const body = rgb(car.body);
  const trim = rgb(car.trim);
  const glass = rgb(car.glass);
  const black = [22, 20, 24];

  // Where round the bend it sits, and therefore where it is and which way it
  // points. Both worked out from the same angle rather than typed in: guessed,
  // the car sat on the outside line pointing across the road, which on an icon
  // of a racing game is the one thing it must not look like it is doing.
  const t = Math.PI * 0.25;
  const at = { x: cx + Math.cos(-t) * mid, y: cy + Math.sin(-t) * mid };
  const angle = -t - Math.PI / 2; // along the bend, climbing it
  const L = size * 0.3;
  const W = size * 0.17;
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);

  // Walked in the car's own frame and rotated into the icon, so the shape is
  // written down once in the units it makes sense in.
  for (let u = -L / 2 - paint; u <= L / 2 + paint; u += 0.35) {
    for (let v = -W / 2 - paint * 1.6; v <= W / 2 + paint * 1.6; v += 0.35) {
      const x = at.x + u * cs - v * sn;
      const y = at.y + u * sn + v * cs;
      const outside = Math.abs(u) > L / 2 || Math.abs(v) > W / 2;
      // Wheels first: they stick out past the sides, front and back.
      const wheel = Math.abs(v) > W / 2 - paint * 0.4
        && (Math.abs(u - L * 0.26) < L * 0.16 || Math.abs(u + L * 0.28) < L * 0.16);
      if (wheel) set(x, y, black);
      else if (outside) set(x, y, trim);
      else if (u > L * 0.02 && u < L * 0.26 && Math.abs(v) < W * 0.34) set(x, y, glass);
      else set(x, y, body);
    }
  }

  return px;
}

mkdirSync(path.join(ROOT, 'icons'), { recursive: true });
for (const size of [32, 180, 192, 512]) {
  const file = path.join('icons', `icon-${size}.png`);
  writeFileSync(path.join(ROOT, file), encodePng(size, draw(size)));
  console.log(`wrote ${file}`);
}
