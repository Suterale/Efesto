// SDF kernel shared by the GPU preview (GLSL codegen) and the STL exporter (JS evaluator).
//
// Scene semantics (Tinkercad-like): the result is the union of every solid, minus every hole.
// Each node has its own `blend` radius: > 0 gives a smooth fillet where it meets the rest.
// Combination nodes ('union' / 'intersect') merge their children into a single node first;
// holes inside one only cut that combination's own children. A combination's blend also applies
// to every joint between its children (each joint uses the larger of the two radii).
// Distances are negative inside, positive outside. Units are millimetres, Z is up
// (same convention as Tinkercad and slicers, so STL coordinates are written as-is).
//
// A shape node is described by:
//   type   'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'text' | 'mesh'
//   inv    world -> local matrix (rotation + translation only), 16 floats, column-major
//   half   half extents [hx, hy, hz]
//   round  edge rounding radius (box only)
//   roundAxis  0 = all edges, 1/2/3 = only the edges parallel to X/Y/Z, 4 = each edge its own radius (box only)
//   edges  roundAxis 4: 12 radii, edge (axis c, corner s) at c * 4 + s; s bit 0 = negative along axis c+1, bit 1 = along c+2
//   blend  smooth union / subtraction radius
//   hole   true -> subtracted from the solids
//   field  text only: 2D distance field of the letters (see text.js), extruded along local Z;
//          half x / y are the half extents of the ink, half z half the depth
//          mesh only: 3D distance field of an imported STL (see stl.js); half is half its (stretched) size
// A 'baked' node is a whole folded group drawn as one shape by the preview only (never exported): `field` is
//   { baked: true, ext, cell, target } with a 3D texture of (distance, rgb) around the group, `half` is half
//   its box `ext`, and `exact` the live nodes it stands for (used when no texture slot is left).
// A combination node is { type: 'union' | 'intersect', children, blend, hole }:
//   union      union(solid children) - union(hole children)
//   intersect  intersection(solid children) - union(hole children)

export const TYPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'text', 'mesh'];

/** Pixels of empty margin around the ink in a text field. Beyond the image the distance is extrapolated. */
export const TEXT_PAD = 16;
/** Text objects the preview can draw with their letters (one texture unit each, 16 in all); extra ones show as boxes. */
export const MAX_TEXT_TEX = 10;
/** Distinct imported meshes the preview can draw (copies of one mesh share a texture); extra ones show as boxes. */
export const MAX_MESH_TEX = 4;

const isCombo = o => o.type === 'union' || o.type === 'intersect';

/** Every node of the tree, depth first; a node's index here is its uniform slot in the shader. */
export function flattenNodes(nodes, out = []) {
  for (const o of nodes) {
    out.push(o);
    if (isCombo(o)) flattenNodes(o.children, out);
  }
  return out;
}

// Torus: tube radius as a fraction of the outer radius, in the unit shape.
const TORUS_TUBE = 0.25;

// ---------------------------------------------------------------- JS evaluator

function sdBox(x, y, z, hx, hy, hz, r) {
  r = Math.min(r, hx, hy, hz);
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Box whose edges parallel to one axis (1 X, 2 Y, 3 Z) are rounded, others stay sharp. */
function sdBoxAxis(x, y, z, hx, hy, hz, r, axis) {
  if (!axis) return sdBox(x, y, z, hx, hy, hz, r);
  const [a, b, c, ha, hb, hc] = axis === 1 ? [y, z, x, hy, hz, hx] : axis === 2 ? [z, x, y, hz, hx, hy] : [x, y, z, hx, hy, hz];
  r = Math.min(r, ha, hb);
  const qa = Math.abs(a) - ha + r, qb = Math.abs(b) - hb + r;
  const d2 = Math.hypot(Math.max(qa, 0), Math.max(qb, 0)) + Math.min(Math.max(qa, qb), 0) - r;
  const dc = Math.abs(c) - hc;
  return Math.hypot(Math.max(d2, 0), Math.max(dc, 0)) + Math.min(Math.max(d2, dc), 0);
}

/** Box with its own radius per edge (see `edges` above): the sharp box cut by one rounded prism per edge. */
function sdBoxEdges(x, y, z, hx, hy, hz, R) {
  let d = sdBox(x, y, z, hx, hy, hz, 0);
  for (let c = 0; c < 3; c++) {
    const [a, b, ha, hb] = c === 0 ? [y, z, hy, hz] : c === 1 ? [z, x, hz, hx] : [x, y, hx, hy];
    const r = Math.min(R[c * 4 + (a < 0 ? 1 : 0) + (b < 0 ? 2 : 0)], ha, hb);
    if (!(r > 0)) continue;
    const qa = Math.abs(a) - ha + r, qb = Math.abs(b) - hb + r;
    if (qa > 0 && qb > 0) d = Math.max(d, Math.hypot(qa, qb) - r);
  }
  return d;
}

function sdEllipsoid(x, y, z, hx, hy, hz) {
  const k0 = Math.hypot(x / hx, y / hy, z / hz);
  const k1 = Math.hypot(x / (hx * hx), y / (hy * hy), z / (hz * hz));
  return k1 < 1e-12 ? -Math.min(hx, hy, hz) : k0 * (k0 - 1) / k1;
}

function sdCylinder(x, y, z, hx, hy, hz) {
  // Unit cylinder along Z (radius 1, half height 1) in scaled space; min scale keeps it a lower bound.
  const dr = Math.hypot(x / hx, y / hy) - 1, dz = Math.abs(z / hz) - 1;
  const d = Math.min(Math.max(dr, dz), 0) + Math.hypot(Math.max(dr, 0), Math.max(dz, 0));
  return d * Math.min(hx, hy, hz);
}

function sdCone(x, y, z, hx, hy, hz) {
  // Unit capped cone along Z: base radius 1 at z = -1, apex at z = +1.
  const qx = Math.hypot(x / hx, y / hy), qy = z / hz;
  const r1 = 1, r2 = 0, h = 1;
  const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
  const k2x = r2 - r1, k2y = 2 * h;
  const t = Math.min(Math.max(((r2 - qx) * k2x + (h - qy) * k2y) / (k2x * k2x + k2y * k2y), 0), 1);
  const cbx = qx - r2 + k2x * t, cby = qy - h + k2y * t;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  const d = s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
  return d * Math.min(hx, hy, hz);
}

function sdTorus(x, y, z, hx, hy, hz) {
  // Unit torus in XY (outer radius 1); Z half extent maps to the tube radius.
  const sz = hz / TORUS_TUBE;
  const ux = x / hx, uy = y / hy, uz = z / sz;
  const d = Math.hypot(Math.hypot(ux, uy) - (1 - TORUS_TUBE), uz) - TORUS_TUBE;
  return d * Math.min(hx, hy, sz);
}

/** Bilinear lookup in a text field, coordinates in pixels (pixel centres at integers), clamped to the edge. */
function sampleField(f, u, v) {
  u = Math.min(Math.max(u, 0), f.w - 1);
  v = Math.min(Math.max(v, 0), f.h - 1);
  const i = Math.min(Math.floor(u), f.w - 2), j = Math.min(Math.floor(v), f.h - 2);
  const s = u - i, t = v - j, d = f.data, k = j * f.w + i;
  return (d[k] * (1 - s) + d[k + 1] * s) * (1 - t) + (d[k + f.w] * (1 - s) + d[k + f.w + 1] * s) * t;
}

function sdText(x, y, z, hx, hy, hz, f) {
  // Half extents of the whole field image (ink + padding) in mm, and mm per pixel (the smaller
  // axis when stretched, so the distance stays a lower bound).
  const tx = hx * f.w / f.inkW, ty = hy * f.h / f.inkH;
  const s = Math.min(2 * hx / f.inkW, 2 * hy / f.inkH);
  const ox = Math.abs(x) - tx, oy = Math.abs(y) - ty;
  // Outside the image the ink is at least the padding away from its border.
  const d2 = ox > 0 || oy > 0 ? Math.hypot(Math.max(ox, 0), Math.max(oy, 0)) + TEXT_PAD * s
    : sampleField(f, (x / (2 * tx) + 0.5) * f.w - 0.5, (y / (2 * ty) + 0.5) * f.h - 0.5) * s;
  const dz = Math.abs(z) - hz;
  return Math.min(Math.max(d2, dz), 0) + Math.hypot(Math.max(d2, 0), Math.max(dz, 0));
}

/** Trilinear lookup in a mesh field, coordinates in cells (cell centres at integers), clamped to the edge. */
function sampleVolume(f, u, v, w) {
  u = Math.min(Math.max(u, 0), f.w - 1);
  v = Math.min(Math.max(v, 0), f.h - 1);
  w = Math.min(Math.max(w, 0), f.d - 1);
  const i = Math.min(Math.floor(u), f.w - 2), j = Math.min(Math.floor(v), f.h - 2), k = Math.min(Math.floor(w), f.d - 2);
  const s = u - i, t = v - j, r = w - k, d = f.data, sx = 1, sy = f.w, sz = f.w * f.h, q = i + j * sy + k * sz;
  const lerp2 = q => (d[q] * (1 - s) + d[q + sx] * s) * (1 - t) + (d[q + sy] * (1 - s) + d[q + sy + sx] * s) * t;
  return lerp2(q) * (1 - r) + lerp2(q + sz) * r;
}

function sdMesh(x, y, z, hx, hy, hz, f) {
  // Back to the mesh's own size (mm); the smallest stretch keeps the distance a lower bound.
  const sx = 2 * hx / f.ext[0], sy = 2 * hy / f.ext[1], sz = 2 * hz / f.ext[2], k = Math.min(sx, sy, sz);
  const qx = x / sx, qy = y / sy, qz = z / sz;
  const gx = f.w * f.cell / 2, gy = f.h * f.cell / 2, gz = f.d * f.cell / 2;
  // Outside the grid the mesh is at least as far as its bounding box.
  if (Math.abs(qx) > gx || Math.abs(qy) > gy || Math.abs(qz) > gz) {
    return Math.hypot(Math.max(Math.abs(qx) - f.ext[0] / 2, 0), Math.max(Math.abs(qy) - f.ext[1] / 2, 0),
      Math.max(Math.abs(qz) - f.ext[2] / 2, 0)) * k;
  }
  return sampleVolume(f, (qx + gx) / f.cell - 0.5, (qy + gy) / f.cell - 0.5, (qz + gz) / f.cell - 0.5) * k;
}

const JS_PRIMS = { box: null, sphere: sdEllipsoid, cylinder: sdCylinder, cone: sdCone, torus: sdTorus, text: sdText, mesh: sdMesh };

/** Build a fast scalar evaluator f(x, y, z) for a list of nodes. */
export function compileJS(nodes) {
  return compileList(nodes, 'union');
}

function compileNode(o) {
  if (isCombo(o)) return compileList(o.children, o.type, o.blend || 0);
  const m = o.inv, [hx, hy, hz] = o.half, round = o.round || 0, axis = o.roundAxis || 0, prim = JS_PRIMS[o.type], field = o.field;
  const edges = axis === 4 ? o.edges ?? Array(12).fill(round) : null;
  return (x, y, z) => {
    const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
    const lz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (prim) return prim(lx, ly, lz, hx, hy, hz, field);
    return edges ? sdBoxEdges(lx, ly, lz, hx, hy, hz, edges) : sdBoxAxis(lx, ly, lz, hx, hy, hz, round, axis);
  };
}

/** `k0`: the enclosing combination's blend, a minimum for every joint in the list. */
function compileList(nodes, op, k0 = 0) {
  const S = nodes.filter(o => !o.hole).map(o => [compileNode(o), Math.max(o.blend || 0, k0, 1e-6)]);
  const H = nodes.filter(o => o.hole).map(o => [compileNode(o), Math.max(o.blend || 0, k0, 1e-6)]);
  const inter = op === 'intersect';

  return (x, y, z) => {
    let d = 1e10;
    for (let i = 0; i < S.length; i++) {
      const di = S[i][0](x, y, z);
      if (i === 0) { d = di; continue; }
      const k = S[i][1];
      if (inter) {
        const h = Math.min(Math.max(0.5 - 0.5 * (di - d) / k, 0), 1);
        d = di + (d - di) * h + k * h * (1 - h);
      } else {
        const h = Math.min(Math.max(0.5 + 0.5 * (di - d) / k, 0), 1);
        d = di + (d - di) * h - k * h * (1 - h);
      }
    }
    for (let i = 0; i < H.length; i++) {
      const b = -H[i][0](x, y, z), k = H[i][1];
      const h = Math.min(Math.max(0.5 - 0.5 * (b - d) / k, 0), 1);
      d = b + (d - b) * h + k * h * (1 - h);
    }
    return d;
  };
}

/** World-space AABB of the solids (holes only remove material), padded by blend radii. */
export function sceneBounds(nodes, op = 'union', k0 = 0) {
  let box = null;
  for (const o of nodes) {
    if (o.hole) continue;
    const b = isCombo(o) ? sceneBounds(o.children, o.type, o.blend || 0) : shapeBounds(o);
    if (!b) {
      if (op === 'intersect') return null;
      continue;
    }
    const pad = Math.max(o.blend || 0, k0);
    b.lo = b.lo.map(v => v - pad);
    b.hi = b.hi.map(v => v + pad);
    if (!box) box = b;
    else if (op === 'intersect') {
      box = { lo: box.lo.map((v, i) => Math.max(v, b.lo[i])), hi: box.hi.map((v, i) => Math.min(v, b.hi[i])) };
      if (box.lo.some((v, i) => v > box.hi[i])) return null;
    } else {
      box = { lo: box.lo.map((v, i) => Math.min(v, b.lo[i])), hi: box.hi.map((v, i) => Math.max(v, b.hi[i])) };
    }
  }
  return box;
}

function shapeBounds(o) {
  // inv is world->local; its inverse rotation is the transpose of the 3x3 part.
  const m = o.inv, [hx, hy, hz] = o.half;
  const tx = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
  const ty = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
  const tz = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
  // Rows of the local->world rotation are the columns of inv's 3x3.
  const ex = Math.abs(m[0]) * hx + Math.abs(m[1]) * hy + Math.abs(m[2]) * hz;
  const ey = Math.abs(m[4]) * hx + Math.abs(m[5]) * hy + Math.abs(m[6]) * hz;
  const ez = Math.abs(m[8]) * hx + Math.abs(m[9]) * hy + Math.abs(m[10]) * hz;
  return { lo: [tx - ex, ty - ey, tz - ez], hi: [tx + ex, ty + ey, tz + ez] };
}

// ---------------------------------------------------------------- GLSL codegen

const GLSL_LIB = /* glsl */`
float sdBox(vec3 p, vec3 h, float r) {
  r = min(r, min(h.x, min(h.y, h.z)));
  vec3 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdBoxAxis(vec3 p, vec3 h, float r, float axis) {
  if (axis < 0.5) return sdBox(p, h, r);
  vec3 a = axis < 1.5 ? p.yzx : axis < 2.5 ? p.zxy : p;
  vec3 e = axis < 1.5 ? h.yzx : axis < 2.5 ? h.zxy : h;
  r = min(r, min(e.x, e.y));
  vec2 q = abs(a.xy) - e.xy + r;
  float d2 = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float dc = abs(a.z) - e.z;
  return length(max(vec2(d2, dc), 0.0)) + min(max(d2, dc), 0.0);
}
// Per-edge radii: r0 / r1 / r2 hold the 4 edges parallel to X / Y / Z (index = bit 0 negative along the next axis, bit 1 along the one after).
float sdBoxEdges(vec3 p, vec3 h, vec4 r0, vec4 r1, vec4 r2) {
  float d = sdBox(p, h, 0.0);
  for (int c = 0; c < 3; c++) {
    vec3 a = c == 0 ? p.yzx : c == 1 ? p.zxy : p;
    vec3 e = c == 0 ? h.yzx : c == 1 ? h.zxy : h;
    vec4 rv = c == 0 ? r0 : c == 1 ? r1 : r2;
    int s = (a.x < 0.0 ? 1 : 0) + (a.y < 0.0 ? 2 : 0);
    float r = min(s == 0 ? rv.x : s == 1 ? rv.y : s == 2 ? rv.z : rv.w, min(e.x, e.y));
    if (r <= 0.0) continue;
    vec2 q = abs(a.xy) - e.xy + r;
    if (q.x > 0.0 && q.y > 0.0) d = max(d, length(q) - r);
  }
  return d;
}
float sdEllipsoid(vec3 p, vec3 h, float r) {
  float k0 = length(p / h), k1 = length(p / (h * h));
  return k1 < 1e-12 ? -min(h.x, min(h.y, h.z)) : k0 * (k0 - 1.0) / k1;
}
float sdCylinder(vec3 p, vec3 h, float r) {
  float dr = length(p.xy / h.xy) - 1.0, dz = abs(p.z / h.z) - 1.0;
  float d = min(max(dr, dz), 0.0) + length(max(vec2(dr, dz), 0.0));
  return d * min(h.x, min(h.y, h.z));
}
float sdCone(vec3 p, vec3 h, float r) {
  vec2 q = vec2(length(p.xy / h.xy), p.z / h.z);
  vec2 k1 = vec2(0.0, 1.0), k2 = vec2(-1.0, 2.0);
  vec2 ca = vec2(q.x - min(q.x, q.y < 0.0 ? 1.0 : 0.0), abs(q.y) - 1.0);
  vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  float d = s * sqrt(min(dot(ca, ca), dot(cb, cb)));
  return d * min(h.x, min(h.y, h.z));
}
float sdTorus(vec3 p, vec3 h, float r) {
  float sz = h.z / ${TORUS_TUBE.toFixed(4)};
  vec3 u = p / vec3(h.x, h.y, sz);
  float d = length(vec2(length(u.xy) - ${(1 - TORUS_TUBE).toFixed(4)}, u.z)) - ${TORUS_TUBE.toFixed(4)};
  return d * min(h.x, min(h.y, sz));
}
// x: (image / ink width, image / ink height, ink width px, ink height px); t: field in pixels.
float sdText(vec3 p, vec3 h, vec4 x, sampler2D t) {
  vec2 th = h.xy * x.xy;
  float s = min(2.0 * h.x / x.z, 2.0 * h.y / x.w);
  vec2 o = abs(p.xy) - th;
  float d2 = max(o.x, o.y) > 0.0 ? length(max(o, 0.0)) + ${TEXT_PAD.toFixed(1)} * s
    : texture2D(t, p.xy / (2.0 * th) + 0.5).r * s;
  float dz = abs(p.z) - h.z;
  return min(max(d2, dz), 0.0) + length(max(vec2(d2, dz), 0.0));
}
// 3D texture k: an imported mesh (its distance field in mm, see sdMesh in the JS evaluator) or a baked group
// ((distance mm, rgb), never stretched: h is half of x). x: (content size mm, cell mm). Returns (rgb, distance);
// a mesh's rgb means nothing.
vec4 sdVol(int k, vec3 p, vec3 h, vec4 x) {
  vec3 s = 2.0 * h / x.xyz;
  float m = min(s.x, min(s.y, s.z));
  vec3 q = p / s, g = vec3(${volChain(k => `textureSize(uV${k}, 0)`)}) * x.w * 0.5;
  if (any(greaterThan(abs(q), g))) return vec4(0.8, 0.8, 0.8, length(max(abs(q) - 0.5 * x.xyz, 0.0)) * m);
  vec3 u = q / (2.0 * g) + 0.5;
  vec4 v = ${volChain(k => `textureLod(uV${k}, u, 0.0)`)};
  return vec4(v.gba, v.r * m);
}
`;

/** `k == 0 ? f(0) : k == 1 ? f(1) : ... f(last)` over the 3D texture slots (samplers cannot be indexed). */
function volChain(f) {
  return Array.from({ length: MAX_MESH_TEX }, (_, k) => k).reverse()
    .reduce((rest, k) => rest === null ? f(k) : `k == ${k} ? ${f(k)} : ${rest}`, null);
}

/** Texture slot of each text node (flattenNodes order), only for those that get one. */
export function textSlots(nodes) {
  const slots = new Map();
  for (const o of flattenNodes(nodes)) if (o.type === 'text' && slots.size < MAX_TEXT_TEX) slots.set(o, slots.size);
  return slots;
}

/**
 * Texture slot of each distinct mesh or baked field (first use in flattenNodes order), only for those that
 * get one. Imported models are served first, so a baked group never takes a slot a model needs.
 */
export function meshSlots(nodes) {
  const slots = new Map(), all = flattenNodes(nodes);
  for (const type of ['mesh', 'baked']) {
    for (const o of all) {
      if (o.type === type && !slots.has(o.field) && slots.size < MAX_MESH_TEX) slots.set(o.field, slots.size);
    }
  }
  return slots;
}

/**
 * Shader source key: the generated code only depends on how many text textures it samples (the 3D slots
 * are always there) and on its stack `levels`, so moving, folding or deleting shapes never recompiles it.
 */
export function structureKey(nodes, levels) {
  return `${textSlots(nodes).size},${levels}`;
}

/** Most nodes (shapes and combinations) the preview draws; the rest are left out of the picture. */
export const MAX_NODES = 512;
/**
 * Deepest nesting of combinations the preview supports; deeper ones are folded into the list around them.
 * The shader is built for the depth a scene needs (see stackLevels): every level is GPU registers that
 * every pixel holds, whether it uses them or not, and they cost a lot of speed.
 */
export const MAX_DEPTH = 12;
/** Nodes the per-ray mask covers (the first in layout order); later ones are always walked, still culled by distance. */
export const MASK_NODES = 128;

/**
 * The scene as the shader walks it: depth first, and within every list the solids first, then the holes
 * (the order they are combined in). An entry is { node, op, pad, end, sphere, depth }:
 *   op      'union' | 'intersect', the list the node sits in
 *   end     combinations only: index just past the last entry inside it
 *   sphere  [x, y, z, r] world bounding sphere, r including every blend around it, for the nodes a ray
 *           that misses it can skip (shapes and combinations in a union list, holes anywhere); null for
 *           the others. A skipped combination skips everything inside it.
 *   depth   combinations open in the list it sits in (0 at top level)
 * A sharp union of sharp solids inside a sharp union list is listed as its parts: the minimum does not
 * care how it is grouped, and that way they need no level of the shader's stack.
 */
export function layout(nodes) {
  const out = [];
  const walk = (list, op, pad, k0, depth) => {
    if (op === 'union') list = inline(list, k0);
    for (const o of [...list.filter(o => !o.hole), ...list.filter(o => o.hole)]) {
      const combo = isCombo(o);
      const e = { node: o, op, pad, end: 0, sphere: null, depth };
      if (op === 'union' || o.hole) {
        const k = Math.max(o.blend || 0, pad) + 0.01;
        if (!combo) {
          const b = shapeBounds(o);
          e.sphere = [...b.lo.map((v, i) => (v + b.hi[i]) / 2), Math.hypot(...o.half) + k];
        } else {
          // Holes only remove material, so the solids' box (padded by the blends inside) bounds it all.
          const b = sceneBounds(o.children, o.type, o.blend || 0);
          if (b) e.sphere = [...b.lo.map((v, i) => (v + b.hi[i]) / 2), Math.hypot(...b.hi.map((v, i) => v - b.lo[i])) / 2 + k];
        }
      }
      out.push(e);
      if (combo) {
        walk(o.children, o.type, Math.max(pad, o.blend || 0), o.blend || 0, depth + 1);
        e.end = out.length;
      }
    }
  };
  walk(nodes, 'union', 0, 0, 0);
  return out;
}

/** A union list (joints at least `k0`) with its sharp unions of sharp solids replaced by their parts. */
function inline(list, k0) {
  return list.flatMap(o => k0 === 0 && o.type === 'union' && !o.hole && !(o.blend > 0) &&
    o.children.every(c => !c.hole && !(c.blend > 0)) ? inline(o.children, k0) : [o]);
}

/**
 * Levels of the shader's stack the nodes need: one per combination open at once, as layout lists them.
 * Only type, hole, blend and children are read.
 */
export function stackDepth(nodes, op = 'union', k0 = 0) {
  const list = op === 'union' ? inline(nodes, k0) : nodes;
  return list.reduce((m, o) => isCombo(o) ? Math.max(m, 1 + stackDepth(o.children, o.type, o.blend || 0)) : m, 0);
}

/**
 * Stack levels to build the shader with for a scene that needs `depth`: a few sizes only, so that a scene
 * growing a level now and then does not recompile every time.
 */
export function stackLevels(depth) {
  return [2, 4, 8, MAX_DEPTH].find(n => n >= Math.min(depth, MAX_DEPTH));
}

/**
 * GLSL for `vec4 mapC(vec3 p)` returning (linear rgb, distance), reading the scene from texture `uNodes`
 * (see layout; 11 texels per node, row = entry index):
 *   0-2  world -> local rows (xyz, translation)      3  half extents, type code
 *   4    blend, round, roundAxis                    5  colour, flags (1 hole, 2 combination, 4 intersect)
 *   6    text / mesh mapping (combination: end)     7  bounding sphere, radius < 0 = never skipped
 *   8-10 box edge radii (roundAxis 4): edges parallel to X, Y, Z
 * Type codes: 0 box, 1 sphere, 2 cylinder, 3 cone, 4 torus, 10 + k text texture k, 20 + k mesh texture k,
 * 30 + k baked group in texture k (its colour comes from the texture).
 * `uCount` entries are walked with a small stack, so the same code serves every scene. Entries whose bit
 * in the mask `gM` is clear are skipped: setRay / setPoint fill it for a ray / for the neighbourhood of
 * a point. `gCap` caps the distances that matter (grid baking).
 */
export function buildGLSL(nodes, levels) {
  const tex = textSlots(nodes);
  const cases = [...tex.values()].map(k => `else if (ty == ${10 + k}) di = sdText(q, hh.xyz, nf(6, i), uT${k});`);
  return `
#define MAXD ${levels}
#define MASKN ${MASK_NODES}
#define MASKW ${MASK_NODES / 32}
uniform highp sampler2D uNodes;
uniform int uCount;
${[...tex.values()].map(k => `uniform sampler2D uT${k};`).join('\n')}
${Array.from({ length: MAX_MESH_TEX }, (_, k) => `uniform highp sampler3D uV${k};`).join('\n')}
uint gM[MASKW];
float gCap = 1e10;
${GLSL_LIB}
vec4 nf(int k, int i) { return texelFetch(uNodes, ivec2(k, i), 0); }

// Fold one more member (distance di, colour ci) into a list's running result. An intersection starts out as
// everything (-1e10): its first solid then comes through unchanged, as the smooth max of -1e10 and di is di.
void joint(inout float d, inout vec3 c, float inter, float hole, float di, vec3 ci, float k) {
  k = max(k, 1e-6);
  float h;
  if (hole > 0.5) {
    if (d < -1e9) return;   // an intersection without solids: it stays empty, whatever it cuts
    float b = -di;
    h = clamp(0.5 - 0.5 * (b - d) / k, 0.0, 1.0);
    d = mix(b, d, h) + k * h * (1.0 - h);
    return;
  }
  if (inter > 0.5) {
    h = clamp(0.5 - 0.5 * (di - d) / k, 0.0, 1.0);
    d = mix(di, d, h) + k * h * (1.0 - h);
  } else {
    h = clamp(0.5 + 0.5 * (di - d) / k, 0.0, 1.0);
    d = mix(di, d, h) - k * h * (1.0 - h);
  }
  c = mix(ci, c, h);
}

vec4 mapC(vec3 p) {
  // The list being folded: distance, colour, the blend all its joints take at least (k0), intersection or not.
  float d = 1e10, inter = 0.0, k0 = 0.0;
  vec3 c = vec3(0.8);
  int lvl = 0, curEnd = 1 << 30;
  // Per open combination, the list around it: (distance, k0, end, intersection) and (colour, radius the
  // combination joins it with, negative for a hole). Kept this small on purpose: every pixel holds it all.
  vec4 sA[MAXD], sB[MAXD];
  vec4 pp = vec4(p, 1.0);
  for (int i = 0; i <= uCount; i++) {
    // Leave the combinations that end here: their result joins the list around them.
    while (lvl > 0 && i >= curEnd) {
      lvl--;
      float dc = d < -1e9 ? 1e10 : d;   // an intersection without solids is empty
      vec3 cc = c;
      vec4 a = sA[lvl], b = sB[lvl];
      d = a.x; k0 = a.y; curEnd = int(a.z); inter = a.w; c = b.rgb;
      joint(d, c, inter, b.w < 0.0 ? 1.0 : 0.0, dc, cc, abs(b.w));
    }
    if (i == uCount) break;
    if (i < MASKN && (gM[i >> 5] & (1u << uint(i & 31))) == 0u) continue;
    // Too far to change the result (the sphere radius already holds every blend that reaches it): skip the
    // node, a combination with everything inside it. Two texel reads decide, so far nodes stay cheap.
    vec4 s = nf(7, i), f = nf(5, i);
    int fl = int(f.w);
    bool hole = (fl & 1) != 0;
    if (s.w >= 0.0) {
      float lb = length(p - s.xyz) - s.w, dm = min(d, gCap);
      if (hole ? lb >= -dm : (inter < 0.5 && lb >= dm)) {
        if ((fl & 2) != 0) i = int(nf(6, i).x) - 1;
        continue;
      }
    }
    vec4 e = nf(4, i);
    if ((fl & 2) != 0) {
      if (lvl >= MAXD) continue;
      float kj = max(max(e.x, k0), 1e-6);
      sA[lvl] = vec4(d, k0, float(curEnd), inter);
      sB[lvl] = vec4(c, hole ? -kj : kj);
      lvl++;
      curEnd = int(nf(6, i).x);
      inter = (fl & 4) != 0 ? 1.0 : 0.0;
      d = inter > 0.5 ? -1e10 : 1e10; c = vec3(0.8); k0 = e.x;
      continue;
    }
    vec4 hh = nf(3, i);
    vec3 q = vec3(dot(nf(0, i), pp), dot(nf(1, i), pp), dot(nf(2, i), pp));
    float k = max(max(e.x, k0), 1e-6);
    float di;
    vec3 ci = f.rgb;
    int ty = int(hh.w + 0.5);
    if (ty == 1) di = sdEllipsoid(q, hh.xyz, 0.0);
    else if (ty == 2) di = sdCylinder(q, hh.xyz, 0.0);
    else if (ty == 3) di = sdCone(q, hh.xyz, 0.0);
    else if (ty == 4) di = sdTorus(q, hh.xyz, 0.0);
    else if (ty >= 20) { vec4 v = sdVol(ty % 10, q, hh.xyz, nf(6, i)); di = v.w; if (ty >= 30) ci = v.rgb; }
    ${cases.join('\n    ')}
    else if (e.z > 3.5) di = sdBoxEdges(q, hh.xyz, nf(8, i), nf(9, i), nf(10, i));
    else di = sdBoxAxis(q, hh.xyz, e.y, e.z);
    joint(d, c, inter, hole ? 1.0 : 0.0, di, ci, k);
  }
  return vec4(c, d);
}
float map(vec3 p) { return mapC(p).w; }

// Leave node i out of the mask: returns the last entry it takes along (a combination everything inside it,
// whose bits stay clear). A combination reaching past the entries the mask covers stays in instead, as
// those are always walked and would be folded into the list around it.
int maskOut(int i) {
  int last = (int(nf(5, i).w) & 2) != 0 ? int(nf(6, i).x) - 1 : i;
  if (last < MASKN) return last;
  gM[i >> 5] |= 1u << uint(i & 31);
  return i;
}
// Mask for a ray: the nodes it passes near (or that cannot be skipped).
void setRay(vec3 ro, vec3 rd) {
  for (int w = 0; w < MASKW; w++) gM[w] = 0u;
  for (int i = 0; i < min(uCount, MASKN); i++) {
    vec4 s = nf(7, i);
    bool on = s.w < 0.0;
    if (!on) { vec3 v = s.xyz - ro; float t = dot(v, rd); on = dot(v, v) - t * t < s.w * s.w; }
    if (on) gM[i >> 5] |= 1u << uint(i & 31);
    else i = maskOut(i);
  }
}
// Mask for everything within \`reach\` of a point.
void setPoint(vec3 p, float reach) {
  for (int w = 0; w < MASKW; w++) gM[w] = 0u;
  for (int i = 0; i < min(uCount, MASKN); i++) {
    vec4 s = nf(7, i);
    if (s.w < 0.0 || length(p - s.xyz) < s.w + reach) gM[i >> 5] |= 1u << uint(i & 31);
    else i = maskOut(i);
  }
}
`;
}
