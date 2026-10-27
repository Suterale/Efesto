// The shader walks `layout()` with a small stack; this runs the same walk in JS and checks it against the
// reference evaluator (compileJS) on random scenes with groups, intersections, holes and blends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileJS, layout, stackDepth } from '../js/sdf.js';

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

/**
 * The shader's mapC, on layout entries: a stack of lists, combinations closed by their `end`. An intersection
 * starts out as everything (-1e10), so its first solid comes through unchanged.
 */
function walk(entries, prim, x, y, z, cull = false) {
  let d = 1e10, inter = 0, k0 = 0, lvl = 0, curEnd = 1 << 30;
  const st = [];
  const joint = (hole, di, k) => {
    k = Math.max(k, 1e-6);
    if (hole) {
      if (d < -1e9) return;
      const b = -di, h = Math.min(Math.max(0.5 - 0.5 * (b - d) / k, 0), 1);
      d = b + (d - b) * h + k * h * (1 - h);
    } else if (inter) {
      const h = Math.min(Math.max(0.5 - 0.5 * (di - d) / k, 0), 1);
      d = di + (d - di) * h + k * h * (1 - h);
    } else {
      const h = Math.min(Math.max(0.5 + 0.5 * (di - d) / k, 0), 1);
      d = di + (d - di) * h - k * h * (1 - h);
    }
  };
  for (let i = 0; i <= entries.length; i++) {
    while (lvl > 0 && i >= curEnd) {
      lvl--;
      const s = st[lvl], dc = d < -1e9 ? 1e10 : d;
      ({ d, inter, k0, curEnd } = s);
      joint(s.hole, dc, s.k);
    }
    if (i === entries.length) break;
    const e = entries[i], o = e.node;
    // The shader's cull: too far to change the list's result, so skip it (a combination up to its end).
    if (cull && e.sphere) {
      const lb = Math.hypot(x - e.sphere[0], y - e.sphere[1], z - e.sphere[2]) - e.sphere[3];
      if (o.hole ? lb >= -d : !inter && lb >= d) {
        if (e.end) i = e.end - 1;
        continue;
      }
    }
    if (e.end) {
      st[lvl] = { d, inter, k0, curEnd, hole: o.hole, k: Math.max(o.blend || 0, k0, 1e-6) };
      lvl++; curEnd = e.end; inter = o.type === 'intersect' ? 1 : 0; d = inter ? -1e10 : 1e10; k0 = o.blend || 0;
      continue;
    }
    joint(o.hole, prim.get(o)(x, y, z), Math.max(o.blend || 0, k0, 1e-6));
  }
  return d;
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

test('a shape or combination too far to change the result may be skipped', () => {
  for (let s = 0; s < 60; s++) {
    const scene = Array.from({ length: 3 + Math.floor(rnd() * 12) }, () => shape(3));
    const ref = compileJS(scene), entries = layout(scene);
    const prim = new Map();
    for (const e of entries) if (!e.end) prim.set(e.node, compileJS([{ ...e.node, hole: false, blend: 0 }]));
    for (let k = 0; k < 200; k++) {
      const x = rnd() * 60 - 30, y = rnd() * 60 - 30, z = rnd() * 60 - 30;
      const a = ref(x, y, z), b = walk(entries, prim, x, y, z, true);
      // Still a valid march step (never past the surface), and the same surface where it is.
      assert.ok(b <= a + 1e-9 || a > 0 && b > 0, `scene ${s} point ${k}: ${a} vs ${b}`);
      if (Math.abs(a) < 0.3) assert.ok(Math.abs(a - b) < 0.3 && Math.sign(a) === Math.sign(b) || Math.abs(b) < 0.3, `scene ${s} point ${k}: ${a} vs ${b}`);
    }
  }
});

test('an intersection without solids is empty, whatever its holes', () => {
  const box = (x, hole) => ({ type: 'box', hole, blend: 0, inv: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, 0, 1], half: [5, 5, 5], round: 0, roundAxis: 0 });
  const scene = [box(0, false), { type: 'intersect', hole: false, blend: 0, children: [box(20, true), box(22, true)] }];
  const ref = compileJS(scene), entries = layout(scene);
  const prim = new Map();
  for (const e of entries) if (!e.end) prim.set(e.node, compileJS([{ ...e.node, hole: false, blend: 0 }]));
  for (const x of [-10, 0, 8, 20, 22, 40]) assert.ok(Math.abs(walk(entries, prim, x, 1, 2) - ref(x, 1, 2)) < 1e-9, `x ${x}`);
});

test('stackDepth counts the combinations layout keeps open at once', () => {
  for (let s = 0; s < 60; s++) {
    const scene = Array.from({ length: 3 + Math.floor(rnd() * 12) }, () => shape(4));
    const entries = layout(scene);
    // Replay the walk's stack: the deepest it gets is what the shader must hold.
    let deepest = 0;
    const open = [];
    entries.forEach((e, i) => {
      while (open.length && i >= open[open.length - 1]) open.pop();
      if (e.end) { open.push(e.end); deepest = Math.max(deepest, open.length); }
    });
    assert.equal(stackDepth(scene), deepest, `scene ${s}`);
  }
});

test('a sharp union of sharp solids in a sharp union is listed as its parts', () => {
  const box = x => ({ type: 'box', hole: false, blend: 0, inv: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, 0, 1], half: [5, 5, 5], round: 0, roundAxis: 0 });
  const inner = { type: 'union', hole: false, blend: 0, children: [box(0), box(8)] };
  assert.deepEqual(layout([{ type: 'union', hole: false, blend: 0, children: [inner, box(20)] }]).map(e => e.end), [0, 0, 0]);
  // A hole, a blend or a blended part keeps it a combination of its own.
  for (const keep of [{ ...inner, hole: true }, { ...inner, blend: 1 }, { ...inner, children: [box(0), { ...box(8), blend: 1 }] }]) {
    assert.equal(layout([box(40), keep]).filter(e => e.end).length, 1);
  }
  assert.equal(stackDepth([{ type: 'union', hole: false, blend: 0, children: [inner, box(20)] }]), 0);
});
