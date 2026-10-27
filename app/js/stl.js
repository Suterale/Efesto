// STL import: a triangle mesh becomes a 3D signed distance field sampled on a regular grid, so an
// imported model is a shape like any other (holes, unions, fillets, STL export). sdf.js samples the
// grid trilinearly, in the shader (as a 3D texture) and in the exporter, so both see the same shape.
//
// A mesh field is { data: Float32Array (w * h * d, x fastest), w, h, d, cell, ext, tris }:
//   samples sit at cell centres of a grid of w x h x d cells of `cell` mm, centred on the mesh's
//   bounding box; ext is that box's size in mm (the shape's natural size). Distances are in mm,
//   negative inside. The grid has MESH_PAD cells of margin around the box.
//
// Inside / outside comes from ray parity along each axis (majority of the three), so meshes with
// small gaps still work; the distance is exact within a narrow band around the triangles and
// propagated from there with a Euclidean distance transform.

import { edt1d } from './text.js';

export const MESH_PAD = 3;
/** Cells along the longest side of the grid (including padding). */
export const MESH_RES = 128;

const BAND = 2;   // cells around each triangle where the distance is computed exactly

/** Triangles of a binary or ASCII STL as flat vertex coordinates (9 floats per triangle). */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const n = new DataView(buffer).getUint32(80, true);
    // ASCII files start with "solid", but so do some binary ones: trust the size when it matches.
    if (84 + n * 50 === bytes.length) return parseBinary(buffer, n);
  }
  const text = new TextDecoder().decode(bytes);
  if (/^\s*solid/.test(text) && /vertex/.test(text)) return parseASCII(text);
  throw new Error('file STL non valido');
}

function parseBinary(buffer, n) {
  const view = new DataView(buffer), out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;   // skip the normal
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(o + k * 4, true);
  }
  return out;
}

function parseASCII(text) {
  const v = [], re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m; (m = re.exec(text));) v.push(+m[1], +m[2], +m[3]);
  if (!v.length || v.length % 9) throw new Error('file STL non valido');
  return new Float32Array(v);
}

/** Bounding box { lo, hi } of a triangle list. */
export function meshBounds(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = tris[i + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  return { lo, hi };
}

/** Distance field of a triangle mesh; `res` cells along the longest side of the grid. */
export function buildMeshField(tris, res = MESH_RES) {
  const nTri = tris.length / 9;
  if (!nTri || tris.some(v => !Number.isFinite(v))) throw new Error('nessun triangolo valido');
  const { lo, hi } = meshBounds(tris);
  const ext = [0, 1, 2].map(a => hi[a] - lo[a]);
  const cell = Math.max(...ext) / (res - 2 * MESH_PAD);
  if (!(cell > 0)) throw new Error('il modello non ha volume');
  const n = ext.map(e => Math.max(Math.ceil(e / cell - 1e-6), 1) + 2 * MESH_PAD);
  const [w, h, d] = n, size = w * h * d;
  // Grid corner, in the mesh's own coordinates; sample (i, j, k) is at org + (i + 0.5) * cell.
  const org = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2 - n[a] * cell / 2);

  // Exact squared distance near the triangles.
  const dist = new Float64Array(size).fill(1e20);   // edt1d needs a finite "far"
  const P = new Float64Array(9), r = BAND * cell;
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 9; k++) P[k] = tris[t * 9 + k];
    const ex = P[3] - P[0], ey = P[4] - P[1], ez = P[5] - P[2], fx = P[6] - P[0], fy = P[7] - P[1], fz = P[8] - P[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; }
    const range = [0, 1, 2].map(a => {
      const mn = Math.min(P[a], P[a + 3], P[a + 6]) - r, mx = Math.max(P[a], P[a + 3], P[a + 6]) + r;
      return [Math.max(0, Math.ceil((mn - org[a]) / cell - 0.5)), Math.min(n[a] - 1, Math.floor((mx - org[a]) / cell - 0.5))];
    });
    for (let k = range[2][0]; k <= range[2][1]; k++) {
      const z = org[2] + (k + 0.5) * cell;
      for (let j = range[1][0]; j <= range[1][1]; j++) {
        const y = org[1] + (j + 0.5) * cell;
        for (let i = range[0][0]; i <= range[0][1]; i++) {
          const x = org[0] + (i + 0.5) * cell;
          // Skip cells far from the triangle's plane before the full test.
          if (nl > 0 && Math.abs((x - P[0]) * nx + (y - P[1]) * ny + (z - P[2]) * nz) > r) continue;
          const q = i + w * (j + h * k), d2 = pointTriangle2(x, y, z, P);
          if (d2 < dist[q]) dist[q] = d2;
        }
      }
    }
  }

  // Spread the band to every cell (seeded transform, as for text), then sign it.
  const len = Math.max(w, h, d);
  const f = new Float64Array(len), v = new Int32Array(len), zz = new Float64Array(len + 1);
  for (let k = 0; k < d; k++) for (let j = 0; j < h; j++) edt1d(dist, w * (j + h * k), 1, w, f, v, zz);
  for (let k = 0; k < d; k++) for (let i = 0; i < w; i++) edt1d(dist, i + w * h * k, w, h, f, v, zz);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) edt1d(dist, i + w * j, w * h, d, f, v, zz);

  const votes = new Uint8Array(size);
  for (let axis = 0; axis < 3; axis++) parityVote(tris, n, org, cell, axis, votes);
  const data = new Float32Array(size);
  for (let q = 0; q < size; q++) data[q] = Math.sqrt(dist[q]) * (votes[q] >= 2 ? -1 : 1);
  return { data, w, h, d, cell, ext, tris: nTri };
}

/**
 * Add 1 to `votes` for every cell that a ray along `axis` finds inside the mesh (odd number of
 * crossings before it). Each triangle is tested against the rays through the cell centres its
 * projection covers; the ray is nudged off the exact centre so it never runs along an edge.
 */
function parityVote(tris, n, org, cell, axis, votes) {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const stride = [1, n[0], n[0] * n[1]];
  const flip = new Uint8Array(votes.length);
  const nu = 1.2345e-4 * cell, nv = 2.3456e-4 * cell;
  for (let t = 0; t < tris.length; t += 9) {
    const au = tris[t + u], av = tris[t + v], aw = tris[t + axis];
    const bu = tris[t + 3 + u], bv = tris[t + 3 + v], bw = tris[t + 3 + axis];
    const cu = tris[t + 6 + u], cv = tris[t + 6 + v], cw = tris[t + 6 + axis];
    const area = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (area === 0) continue;   // edge-on to the rays
    const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - org[u]) / cell - 0.5));
    const i1 = Math.min(n[u] - 1, Math.floor((Math.max(au, bu, cu) - org[u]) / cell - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - org[v]) / cell - 0.5));
    const j1 = Math.min(n[v] - 1, Math.floor((Math.max(av, bv, cv) - org[v]) / cell - 0.5));
    for (let j = j0; j <= j1; j++) {
      const pv = org[v] + (j + 0.5) * cell + nv;
      for (let i = i0; i <= i1; i++) {
        const pu = org[u] + (i + 0.5) * cell + nu;
        // Barycentric coordinates of the ray in the projected triangle.
        const l1 = ((pu - au) * (cv - av) - (pv - av) * (cu - au)) / area;
        const l2 = ((bu - au) * (pv - av) - (bv - av) * (pu - au)) / area;
        if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
        const pw = aw + l1 * (bw - aw) + l2 * (cw - aw);
        // The crossing flips every cell centre beyond it.
        const k = Math.max(0, Math.ceil((pw - org[axis]) / cell - 0.5));
        if (k < n[axis]) flip[i * stride[u] + j * stride[v] + k * stride[axis]] ^= 1;
      }
    }
  }
  for (let j = 0; j < n[v]; j++) for (let i = 0; i < n[u]; i++) {
    let inside = 0;
    for (let k = 0, q = i * stride[u] + j * stride[v]; k < n[axis]; k++, q += stride[axis]) {
      inside ^= flip[q];
      votes[q] += inside;
    }
  }
}

/** Squared distance from a point to triangle P (9 coordinates), after Ericson's closest point test. */
function pointTriangle2(px, py, pz, P) {
  const ax = P[0], ay = P[1], az = P[2];
  const abx = P[3] - ax, aby = P[4] - ay, abz = P[5] - az;
  const acx = P[6] - ax, acy = P[7] - ay, acz = P[8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let cx, cy, cz;
  if (d1 <= 0 && d2 <= 0) { cx = ax; cy = ay; cz = az; }
  else {
    const bpx = px - P[3], bpy = py - P[4], bpz = pz - P[5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - P[6], cpy = py - P[7], cpz = pz - P[8];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { cx = P[3]; cy = P[4]; cz = P[5]; }
    else if (d6 >= 0 && d5 <= d6) { cx = P[6]; cy = P[7]; cz = P[8]; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const s = d1 / (d1 - d3);
      cx = ax + s * abx; cy = ay + s * aby; cz = az + s * abz;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const s = d2 / (d2 - d6);
      cx = ax + s * acx; cy = ay + s * acy; cz = az + s * acz;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const s = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      cx = P[3] + s * (P[6] - P[3]); cy = P[4] + s * (P[7] - P[4]); cz = P[5] + s * (P[8] - P[5]);
    } else {
      const den = va + vb + vc;
      if (den === 0) { cx = ax; cy = ay; cz = az; }   // degenerate triangle
      else {
        const s = vb / den, t = vc / den;
        cx = ax + s * abx + t * acx; cy = ay + s * aby + t * acy; cz = az + s * abz + t * acz;
      }
    }
  }
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}
