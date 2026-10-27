// UI themes. The look of the panels lives in css/themes.css ([data-theme=...] blocks); this file holds
// what CSS cannot reach: the colours / shading of the 3D view and the style of the icons.
//
//   icons    'pixel' bitmap icons | 'vector' smooth SVG | 'ascii' text art
//   clear    background of the 3D view; alpha 0 lets the CSS background of #view show through
//   grids    [divisions, colour, opacity] of the workplane grid lines
//   lit      [hemisphere, key, fill, floor] light weights of the raymarched shader
//   bands    number of light bands (0 = smooth); dither is the Bayer strength used between bands
//   spec     [shininess, strength, hard]: hard = 1 draws a single white dot instead of a soft highlight
//   rim      [colour, strength] fresnel glow on the silhouette

const SHAPE_COLORS = {
  box: '#ff5555', sphere: '#55ffff', cylinder: '#ffaa00', cone: '#ff55ff', torus: '#55ff55', text: '#5555ff', image: '#55aaff', mesh: '#ff8800',
};

export const THEMES = {
  minimal: {
    label: 'Minimal', icons: 'vector',
    clear: 0xf4f4f5, clearAlpha: 0, plane: 0xffffff,
    grids: [[100, 0xd4d4d8, 0.35], [20, 0xa1a1aa, 0.8]],
    hole: [0x71717a, 0.3], outline: 0x2563eb,
    lit: [0.46, 0.66, 0.26, 0.18], bands: 0, dither: 0, spec: [40, 0.25, 0], rim: [0xffffff, 0.2],
    shapeColors: { box: '#ef4444', sphere: '#38bdf8', cylinder: '#f59e0b', cone: '#a855f7', torus: '#22c55e' },
  },
  dark: {
    label: 'Minimal (scuro)', icons: 'vector',
    clear: 0x18181b, clearAlpha: 0, plane: 0x27272a,
    grids: [[100, 0x52525b, 0.25], [20, 0x71717a, 0.7]],
    hole: [0xa1a1aa, 0.3], outline: 0x60a5fa,
    lit: [0.40, 0.72, 0.24, 0.12], bands: 0, dither: 0, spec: [40, 0.3, 0], rim: [0xffffff, 0.15],
    shapeColors: { box: '#f87171', sphere: '#38bdf8', cylinder: '#fbbf24', cone: '#c084fc', torus: '#4ade80' },
  },
  win95: {
    label: 'Retro (Win 95)', icons: 'pixel', pixel: true,
    clear: 0x008080, clearAlpha: 1, plane: 0xc0c0c0,
    grids: [[100, 0x808080, 0.2], [20, 0x404040, 0.9]],
    hole: [0x808080, 0.4], outline: 0xff00ff,
    lit: [0.30, 0.75, 0.15, 0.12], bands: 4, dither: 1, spec: [40, 0.25, 1], rim: [0x000000, 0],
  },
  cyber: {
    label: 'Cyberpunk', icons: 'vector',
    clear: 0x12040a, clearAlpha: 0, plane: 0x1a070c,
    grids: [[100, 0xff3b30, 0.10], [20, 0xff3b30, 0.45]],
    hole: [0xff3b30, 0.3], outline: 0x5ef2ff,
    lit: [0.34, 0.80, 0.25, 0.08], bands: 5, dither: 0.5, spec: [60, 0.6, 0], rim: [0x5ef2ff, 0.7],
    shapeColors: { box: '#ff5e50', sphere: '#5ef2ff', cylinder: '#fcee0a', cone: '#a64cff', torus: '#3dff9a' },
  },
  apple: {
    label: 'Apple', icons: 'vector',
    clear: 0xe9e9ee, clearAlpha: 0, plane: 0xffffff,
    grids: [[100, 0xc7c7cc, 0.3], [20, 0xaeaeb2, 0.9]],
    hole: [0x8e8e93, 0.3], outline: 0x007aff,
    lit: [0.46, 0.66, 0.26, 0.18], bands: 0, dither: 0, spec: [48, 0.35, 0], rim: [0xffffff, 0.3],
    shapeColors: { box: '#ff3b30', sphere: '#5ac8fa', cylinder: '#ff9500', cone: '#af52de', torus: '#34c759' },
  },
  ascii: {
    label: 'ASCII', icons: 'ascii', ascii: true,
    clear: 0x000000, clearAlpha: 1, plane: 0x1c1c1c,
    grids: [[100, 0x606060, 0.2], [20, 0x909090, 0.8]],
    hole: [0xffffff, 0.35], outline: 0x3dff7a,
    lit: [0.30, 0.80, 0.18, 0.10], bands: 0, dither: 0, spec: [30, 0.0, 0], rim: [0x000000, 0],
    asciiColors: { fg: 0x3dff7a, bg: 0x050805, color: 0.65 },
  },
  skeu: {
    label: 'Skeuomorfico', icons: 'vector',
    clear: 0x6e4320, clearAlpha: 0, plane: 0x2f7d57,
    grids: [[100, 0xffffff, 0.18], [20, 0xffffff, 0.6]],
    hole: [0xffffff, 0.35], outline: 0xff8a00,
    lit: [0.40, 0.78, 0.22, 0.14], bands: 0, dither: 0, spec: [32, 0.55, 0], rim: [0xfff2d0, 0.12],
    shapeColors: { box: '#d9534f', sphere: '#4a90e2', cylinder: '#e0a030', cone: '#8e5bb5', torus: '#4aa86b' },
  },
  brutal: {
    label: 'Neo-brutalismo', icons: 'vector', edge: 2,
    clear: 0xc4b5fd, clearAlpha: 0, plane: 0xffffff,
    grids: [[100, 0x000000, 0.12], [20, 0x000000, 0.9]],
    hole: [0x000000, 0.22], outline: 0x000000,
    lit: [0.46, 0.70, 0.20, 0.20], bands: 3, dither: 0, spec: [20, 0, 0], rim: [0x000000, 0],
    shapeColors: { box: '#ff6b6b', sphere: '#4dd0ff', cylinder: '#ffde59', cone: '#ff90e8', torus: '#7cf29a' },
  },
  y2k: {
    label: 'Y2K', icons: 'vector',
    clear: 0xb8d8ff, clearAlpha: 0, plane: 0xf1f6ff,
    grids: [[100, 0x9db4de, 0.35], [20, 0x7a5cff, 0.65]],
    hole: [0x2ad8ff, 0.35], outline: 0xff2bd6,
    lit: [0.42, 0.72, 0.28, 0.16], bands: 0, dither: 0, spec: [90, 0.9, 0], rim: [0xff7bf0, 0.45],
    shapeColors: { box: '#ff6fd8', sphere: '#4fd8ff', cylinder: '#ffd84f', cone: '#b57bff', torus: '#7bff8a' },
  },
};

export const DEFAULT_THEME = 'minimal';
export const THEME_KEY = 'sdfcad.theme';

// ---------------------------------------------------------------- vector icons (24 x 24)

// Parts are tagged f (base), l (light) and d (dark); css/index.html colours them from --ic.
const VECTOR_SHAPES = {
  box: '<path class="l" d="M12 3 21 7.5 12 12 3 7.5Z"/><path class="f" d="M3 7.5 12 12v10L3 17Z"/><path class="d" d="M21 7.5 12 12v10l9-5Z"/>',
  sphere: '<circle class="f" cx="12" cy="12" r="9"/><ellipse class="l" cx="9" cy="8.5" rx="4" ry="3" stroke="none"/>',
  cylinder: '<path class="f" d="M4 6v12a8 3 0 0 0 16 0V6Z"/><ellipse class="l" cx="12" cy="6" rx="8" ry="3"/>',
  cone: '<path class="f" d="M12 3 20 18a8 3 0 0 1-16 0Z"/><path class="d" d="M12 3 20 18a8 3 0 0 1-8 3Z"/>',
  torus: '<path class="f" fill-rule="evenodd" d="M3 12a9 6 0 1 0 18 0 9 6 0 1 0-18 0ZM8 12a4 2 0 1 0 8 0 4 2 0 1 0-8 0Z"/>',
  text: '<path class="d" d="M5 5h16v5h-5.5v11h-5V10H5Z"/><path class="f" d="M3 3h16v5h-5.5v11h-5V8H3Z"/>',
  image: '<rect class="l" x="2.5" y="4.5" width="19" height="15"/><path class="f" d="M2.5 19.5 9 11l4.5 5 2.5-3 5.5 6.5Z"/><circle class="d" cx="16.5" cy="9" r="1.8"/>',
  mesh: '<path class="l" d="M12 2 21 7 12 12 3 7Z"/><path class="f" d="M3 7 12 12v10L3 17Z"/><path class="d" d="M21 7 12 12v10l9-5Z"/><path fill="none" d="M3 7l9 15M21 7l-9 15M12 2v10"/>',
};

export function vectorIcon(type, hole, color) {
  return `<svg class="vicon${hole ? ' hole' : ''}" viewBox="0 0 24 24" style="--ic:${color}">${VECTOR_SHAPES[type]}</svg>`;
}

/** Two overlapping squares, filled where material is kept (like the pixel combine icons). */
export function vectorCombineIcon(mode, hole) {
  const color = hole ? '#8e8e93' : '#4f7dff';
  const a = '<rect x="1.5" y="1.5" width="7" height="7"/>', b = '<rect x="4.5" y="4.5" width="7" height="7"/>';
  const fill = c => `<g class="${c}">${a}${b}</g>`;
  const body = {
    group: fill('f'),
    union: `${fill('f')}<rect class="f" x="4.7" y="4.7" width="3.6" height="3.6" stroke="none"/>`,
    intersect: `<g fill="none">${a}${b}</g><rect class="f" x="4.5" y="4.5" width="4" height="4"/>`,
  }[mode];
  return `<svg class="cicon vicon${hole ? ' hole' : ''}" viewBox="0 0 13 13" style="--ic:${color}">${body}</svg>`;
}

// ---------------------------------------------------------------- ASCII icons

const ASCII_SHAPES = {
  box: ['+--+', '|  |', '+--+'],
  sphere: [' .-. ', '(   )', " '-' "],
  cylinder: ['.--.', '|  |', "'--'"],
  cone: [' /\\ ', '/  \\', '----'],
  torus: ['.--.', '( () )', "'--'"],
  text: ['  _  ', ' /_\\ ', '/   \\'],
  image: ['+----+', '|/\\ o|', '+----+'],
  mesh: [' /\\ ', '/__\\', '\\  /'],
};

export function asciiIcon(type, hole) {
  const rows = ASCII_SHAPES[type].map(r => hole ? r.replace(/[-|+]/g, m => (m === '|' ? ':' : '.')) : r);
  return `<pre>${rows.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
}

export function asciiCombineIcon(mode) {
  return `<span class="cicon txt">${{ group: '[ ]', union: '[+]', intersect: '[&amp;]' }[mode]}</span>`;
}

export function themeShapeColor(theme, type) {
  return theme.shapeColors?.[type] ?? SHAPE_COLORS[type];
}
