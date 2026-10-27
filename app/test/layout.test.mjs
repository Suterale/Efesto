// The shader walks `layout()` with a small stack; this runs the same walk in JS and checks it against the
// reference evaluator (compileJS) on random scenes with groups, intersections, holes and blends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileJS, layout } from '../js/sdf.js';

let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const TYPES = ['box', 'sphere', 'cylinder', 'cone', 'torus'];

function shape(depthLeft) {
  const t = rnd() < 0.25 && depthLeft > 0 ? (rnd() < 0.5 ? 'union' : 'intersect') : TYPES[Math.floor(rnd() * TYPES.length)];
  const blend = rnd() < 0.3 ? rnd() * 3 : 0, hole = rnd() < 0.2;
  if (t === 'union' || t === 'intersect') {
    return { type: t, hole, blend, children: Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => shape(depthLeft - 1)) };
  }
  const a = rnd() * 6, c = [rnd() * 30 - 15, rnd() * 30 - 15, rnd() * 30 - 15];
  const ca = Math.cos(a), sa = Math.sin(a);
  // rotation about Z then translation, world -> local (column-major)
  const inv = [ca, -sa, 0, 0, sa, ca, 0, 0, 0, 0, 1, 0,
    -(ca * c[0] + sa * c[1]), -(-sa * c[0] + ca * c[1]), -c[2], 1];
  return { type: t, hole, blend, inv, half: [3 + rnd() * 6, 3 + rnd() * 6, 3 + rnd() * 6], round: 0, roundAxis: 0 };
}

/** The shader's mapC, on layout entries: a stack of lists, combinations closed by their `end`. */
function walk(entries, prim, x, y, z) {
  let d = 1e10, n = 0, inter = 0, k0 = 0, lvl = 0, curEnd = 1 << 30;
  const st = [];
  const joint = (di, hole, dist, k) => {
    k = Math.max(k, 1e-6);
    if (hole) { const b = -dist, h = Math.min(Math.max(0.5 - 0.5 * (b - di.d) / k, 0), 1); di.d = b + (di.d - b) * h + k * h * (1 - h); return; }
    if (inter) {
      if (n < 0.5) di.d = dist;
      else { const h = Math.min(Math.max(0.5 - 0.5 * (dist - di.d) / k, 0), 1); di.d = dist + (di.d - dist) * h + k * h * (1 - h); }
    } else { const h = Math.min(Math.max(0.5 + 0.5 * (dist - di.d) / k, 0), 1); di.d = dist + (di.d - dist) * h - k * h * (1 - h); }
    n += 1;
  };
  const acc = { d };
  for (let i = 0; i <= entries.length; i++) {
    while (lvl > 0 && i >= curEnd) {
      lvl--;
      const s = st[lvl], dc = acc.d, ce = s.e;
      acc.d = s.d; n = s.n; inter = s.inter; k0 = s.k0; curEnd = s.curEnd;
      joint(acc, ce.node.hole, dc, Math.max(ce.node.blend || 0, k0));
    }
    if (i === entries.length) break;
    const e = entries[i], o = e.node;
    if (e.end) {
      st[lvl] = { d: acc.d, n, inter, k0, curEnd, e };
      lvl++; curEnd = e.end; acc.d = 1e10; n = 0; inter = o.type === 'intersect' ? 1 : 0; k0 = o.blend || 0;
      continue;
    }
    const k = Math.max(o.blend || 0, k0, 1e-6);
    joint(acc, o.hole, prim.get(o)(x, y, z), k);
  }
  return acc.d;
}

test('layout walk equals the reference evaluator', () => {
  for (let s = 0; s < 60; s++) {
    const scene = Array.from({ length: 3 + Math.floor(rnd() * 12) }, () => shape(3));
    const ref = compileJS(scene);
    const entries = layout(scene);
    const prim = new Map();
    for (const e of entries) if (!e.end) prim.set(e.node, compileJS([{ ...e.node, hole: false, blend: 0 }]));
    for (let k = 0; k < 40; k++) {
      const x = rnd() * 60 - 30, y = rnd() * 60 - 30, z = rnd() * 60 - 30;
      assert.ok(Math.abs(walk(entries, prim, x, y, z) - ref(x, y, z)) < 1e-9, `scene ${s} point ${k}`);
    }
  }
});

test('a ray that misses a shape\'s sphere may skip it', () => {
  for (let s = 0; s < 60; s++) {
    const scene = Array.from({ length: 4 + Math.floor(rnd() * 10) }, () => shape(2));
    const ref = compileJS(scene), entries = layout(scene);
    for (let k = 0; k < 20; k++) {
      // A line through the scene, sampled along its length, with the nodes it misses removed.
      const o = [rnd() * 80 - 40, rnd() * 80 - 40, rnd() * 80 - 40];
      let v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const l = Math.hypot(...v); v = v.map(a => a / l);
      const missed = new Set(entries.filter(e => e.sphere).filter(e => {
        const w = e.sphere.slice(0, 3).map((a, i) => a - o[i]);
        const t = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
        return w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - t * t >= e.sphere[3] ** 2;
      }).map(e => e.node));
      const strip = list => list.filter(n => !missed.has(n)).map(n => n.children ? { ...n, children: strip(n.children) } : n);
      const cut = compileJS(strip(scene));
      for (let t = -80; t < 80; t += 2) {
        const p = o.map((a, i) => a + v[i] * t), a = ref(...p), b = cut(...p);
        // Where the surface is, both must agree: sign and value near zero.
        if (Math.abs(a) < 0.3) assert.ok(Math.abs(a - b) < 0.3 && Math.sign(a) === Math.sign(b) || Math.abs(b) < 0.3, `scene ${s} ray ${k} t ${t}: ${a} vs ${b}`);
      }
    }
  }
});
