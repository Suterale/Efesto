// 3D text: the string is drawn with the chosen font on a canvas, and the drawing is turned into a
// 2D signed distance field (pixels, negative inside the letters). sdf.js extrudes that field along Z,
// in the shader (as a texture) and in the STL exporter (bilinear lookup), so both see the same shape.
//
// A field is { data: Float32Array (w * h, row 0 = bottom), w, h, inkW, inkH, em }:
//   the image is the ink's bounding box plus TEXT_PAD pixels on every side; em is the font size in pixels,
//   so inkW / em, inkH / em is the size of the text in ems whatever resolution it was drawn at.

import { TEXT_PAD } from './sdf.js';

/** Fonts are vendored in app/vendor/fonts (declared in index.html), so STL output is the same everywhere. */
export const FONTS = {
  sans:     { label: 'Inter (senza grazie)', family: 'Inter' },
  serif:    { label: 'Lora (con grazie)', family: 'Lora' },
  mono:     { label: 'JetBrains Mono (mono)', family: 'JetBrains Mono' },
  grotesk:  { label: 'Space Grotesk', family: 'Space Grotesk' },
  orbitron: { label: 'Orbitron', family: 'Orbitron' },
  rajdhani: { label: 'Rajdhani', family: 'Rajdhani' },
  pixel:    { label: 'VT323 (pixel)', family: 'VT323' },
};
export const DEFAULT_FONT = 'sans';

const EM = 128;          // font size in pixels; long texts are drawn smaller to keep the image bounded
const MAX_SIDE = 2048;   // largest canvas side before scaling the font down
const LINE = 1.25;       // line height, in ems
const CACHE_SIZE = 48;

const fontSpec = (o, px) => `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} ${px}px "${(FONTS[o.font] ?? FONTS[DEFAULT_FONT]).family}"`;
const fieldKey = o => [o.text, o.font, o.bold, o.italic, o.align].join('\u0000');

/** True once the object's font face is loaded (canvas would silently fall back to another font before that). */
export function fontReady(o) {
  return document.fonts.check(fontSpec(o, EM));
}

/** Resolves when the object's font face is loaded. */
export function loadFont(o) {
  return document.fonts.load(fontSpec(o, EM));
}

/** Load every font in both weights, so text fields can be built synchronously afterwards. */
export function preloadFonts() {
  const specs = Object.keys(FONTS).flatMap(font => [false, true].map(bold => fontSpec({ font, bold }, EM)));
  return Promise.all(specs.map(s => document.fonts.load(s).catch(() => [])));
}

const cache = new Map();   // fieldKey -> field (or null for text with no ink); oldest first

/**
 * The distance field for a text object, or null if it has no visible characters or its font is
 * still loading (call loadFont and try again). `onEvict(field)` runs when a field leaves the cache.
 */
export function textField(o, onEvict) {
  const key = fieldKey(o);
  if (cache.has(key)) {
    const f = cache.get(key);
    cache.delete(key);
    cache.set(key, f);   // most recently used last
    return f;
  }
  if (!fontReady(o)) return null;
  const f = buildField(o);
  cache.set(key, f);
  if (cache.size > CACHE_SIZE) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    if (old) onEvict?.(old);
  }
  return f;
}

let canvas = null;

function buildField(o) {
  const lines = String(o.text ?? '').split('\n');
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Lay out at EM, then shrink if the image would get too big.
  ctx.font = fontSpec(o, EM);
  const width = Math.max(...lines.map(l => ctx.measureText(l).width));
  const em = Math.max(16, Math.floor(EM * Math.min(1, MAX_SIDE / (width + 2 * EM), MAX_SIDE / ((lines.length * LINE + 2) * EM))));
  const margin = em;   // room for overhangs (italics, accents, descenders) before cropping to the ink
  canvas.width = Math.ceil(width * em / EM + 2 * margin);
  canvas.height = Math.ceil(lines.length * LINE * em + 2 * margin);
  ctx.font = fontSpec(o, em);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  const widths = lines.map(l => ctx.measureText(l).width), maxW = Math.max(...widths);
  lines.forEach((l, i) => {
    const free = maxW - widths[i];
    const x = margin + (o.align === 'left' ? 0 : o.align === 'right' ? free : free / 2);
    ctx.fillText(l, x, margin + (i * LINE + 1) * em);
  });

  // Coverage (alpha) and the ink's bounding box.
  const W = canvas.width, H = canvas.height;
  const rgba = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!rgba[(y * W + x) * 4 + 3]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;

  // Crop to the ink plus padding, flipping rows so row 0 is the bottom (+Y is up in the model).
  const inkW = x1 - x0 + 1, inkH = y1 - y0 + 1;
  const w = inkW + 2 * TEXT_PAD, h = inkH + 2 * TEXT_PAD;
  const alpha = new Float32Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    alpha[(h - 1 - (y - y0 + TEXT_PAD)) * w + x - x0 + TEXT_PAD] = rgba[(y * W + x) * 4 + 3] / 255;
  }
  return { data: signedDistance(alpha, w, h), w, h, inkW, inkH, em };
}

// ---------------------------------------------------------------- distance transform

const INF = 1e20;

/**
 * Signed Euclidean distance (pixels, negative inside) from a coverage image, using the
 * antialiased edge for sub-pixel accuracy (the TinySDF approach: Felzenszwalb's transform run
 * on the outside and the inside, seeded with each edge pixel's distance from coverage 0.5).
 */
export function signedDistance(alpha, w, h) {
  const n = w * h, outer = new Float64Array(n), inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    outer[i] = a >= 1 ? 0 : a <= 0 ? INF : Math.max(0, 0.5 - a) ** 2;
    inner[i] = a >= 1 ? INF : a <= 0 ? 0 : Math.max(0, a - 0.5) ** 2;
  }
  edt(outer, w, h);
  edt(inner, w, h);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
  return out;
}

function edt(grid, w, h) {
  const len = Math.max(w, h);
  const f = new Float64Array(len), v = new Int32Array(len), z = new Float64Array(len + 1);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, f, v, z);
}

/** 1D squared distance transform (lower envelope of parabolas) along one row or column, in place. */
export function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k], qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
