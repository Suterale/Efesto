// Triangle-count reduction by quadric error edge collapse (Garland-Heckbert).
// Each vertex carries the sum of squared distances to the planes of its faces; the cheapest edge
// is collapsed first, so flat areas lose triangles long before curved or sharp ones do.
// Collapses that would flip a face, pinch the surface (link condition) or leave a sliver are skipped,
// so a closed, consistently wound mesh stays closed and wound the same way.

/**
 * @param mesh    { positions: Float32Array, indices: Uint32Array }
 * @param target  wanted number of triangles (the result can stay above it if no safe collapse is left)
 * @returns { positions, indices }
 */
export function simplify(mesh, target) {
  const P = Float64Array.from(mesh.positions), I = Uint32Array.from(mesh.indices);
  const nv = P.length / 3, nf = I.length / 3;
  target = Math.max(4, Math.floor(target));
  if (nf <= target) return { positions: mesh.positions, indices: mesh.indices };

  const alive = new Uint8Array(nf).fill(1);          // faces
  const dead = new Uint8Array(nv);                    // vertices
  const ver = new Uint32Array(nv);
  const Q = new Float64Array(nv * 10);                // symmetric 4x4: xx xy xz xw yy yz yw zz zw ww
  const vf = Array.from({ length: nv }, () => []);    // faces touching each vertex (may hold dead ones)

  const addPlane = (o, a, b, c, d) => {
    Q[o] += a * a; Q[o + 1] += a * b; Q[o + 2] += a * c; Q[o + 3] += a * d;
    Q[o + 4] += b * b; Q[o + 5] += b * c; Q[o + 6] += b * d;
    Q[o + 7] += c * c; Q[o + 8] += c * d; Q[o + 9] += d * d;
  };
  for (let f = 0; f < nf; f++) {
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    vf[a].push(f); vf[b].push(f); vf[c].push(f);
    const n = faceNormal(P, a, b, c);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-18) continue;
    const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
    const d = -(nx * P[3 * a] + ny * P[3 * a + 1] + nz * P[3 * a + 2]);
    for (const v of [a, b, c]) addPlane(v * 10, nx, ny, nz, d);
  }

  // Cost and best position for merging u and v.
  const out = [0, 0, 0];
  const evalEdge = (u, v) => {
    const q = new Float64Array(10);
    for (let k = 0; k < 10; k++) q[k] = Q[u * 10 + k] + Q[v * 10 + k];
    const ux = P[3 * u], uy = P[3 * u + 1], uz = P[3 * u + 2];
    const vx = P[3 * v], vy = P[3 * v + 1], vz = P[3 * v + 2];
    const err = (x, y, z) =>
      q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
      q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
      q[7] * z * z + 2 * q[8] * z + q[9];
    const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
    let best = Infinity;
    const take = (x, y, z) => { const e = err(x, y, z); if (e < best) { best = e; out[0] = x; out[1] = y; out[2] = z; } };
    take(ux, uy, uz); take(vx, vy, vz); take(mx, my, mz);
    // Optimal point: solve grad = 0; only trusted when it stays close to the edge.
    const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
    if (Math.abs(det) > 1e-12) {
      const bx = -q[3], by = -q[6], bz = -q[8];
      const x = (bx * (q[4] * q[7] - q[5] * q[5]) - q[1] * (by * q[7] - q[5] * bz) + q[2] * (by * q[5] - q[4] * bz)) / det;
      const y = (q[0] * (by * q[7] - q[5] * bz) - bx * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * bz - by * q[2])) / det;
      const z = (q[0] * (q[4] * bz - by * q[5]) - q[1] * (q[1] * bz - by * q[2]) + bx * (q[1] * q[5] - q[4] * q[2])) / det;
      const el = Math.hypot(vx - ux, vy - uy, vz - uz);
      if (Math.hypot(x - mx, y - my, z - mz) <= el) take(x, y, z);
    }
    // Flat areas cost ~0 everywhere: prefer short edges among ties so triangles thin out evenly
    // instead of piling onto a few high-valence hub vertices (which also keeps each collapse cheap).
    const el2 = (vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2;
    return Math.max(best, 0) + 1e-6 * el2;
  };

  // Min-heap of candidate edges; entries go stale when an endpoint changes (checked via ver[]).
  const heap = [];
  const push = e => {
    let i = heap.length; heap.push(e);
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].cost <= e.cost) break; heap[i] = heap[p]; i = p; }
    heap[i] = e;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1].cost < heap[c].cost) c++;
        if (heap[c].cost >= last.cost) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  const candidate = (u, v) => {
    const cost = evalEdge(u, v);
    push({ cost, u, v, vu: ver[u], vv: ver[v], x: out[0], y: out[1], z: out[2] });
  };

  const seen = new Set();
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = I[3 * f + e], b = I[3 * f + (e + 1) % 3];
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv + hi;
      if (!seen.has(key)) { seen.add(key); candidate(lo, hi); }
    }
  }
  seen.clear();

  const liveFaces = v => {
    const list = vf[v];
    let w = 0;
    for (let i = 0; i < list.length; i++) if (alive[list[i]]) list[w++] = list[i];
    list.length = w;
    return list;
  };

  // Would moving u and v to (x, y, z) keep every surviving face healthy?
  const safe = (u, v, x, y, z) => {
    const fu = liveFaces(u), fv = liveFaces(v);
    const nu = new Set(), nvSet = new Set();
    let shared = 0;
    for (const f of fu) {
      const hasV = I[3 * f] === v || I[3 * f + 1] === v || I[3 * f + 2] === v;
      for (let k = 0; k < 3; k++) { const w = I[3 * f + k]; if (w !== u) nu.add(w); }
      if (hasV) shared++;
    }
    for (const f of fv) for (let k = 0; k < 3; k++) { const w = I[3 * f + k]; if (w !== v) nvSet.add(w); }
    // Link condition: u and v may only have the apexes of the faces on their edge in common.
    let common = 0;
    for (const w of nu) if (w !== v && nvSet.has(w)) common++;
    if (shared !== 2 || common !== 2) return false;
    for (const [list, moved] of [[fu, u], [fv, v]]) {
      for (const f of list) {
        const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
        if ((a === u || b === u || c === u) && (a === v || b === v || c === v)) continue;   // collapses away
        const n0 = faceNormal(P, a, b, c);
        const old = P.slice(3 * moved, 3 * moved + 3);
        P[3 * moved] = x; P[3 * moved + 1] = y; P[3 * moved + 2] = z;
        const n1 = faceNormal(P, a, b, c);
        P.set(old, 3 * moved);
        const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
        if (l1 < 1e-12 * Math.max(l0, 1e-12) || l1 < 1e-18) return false;
        if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.25) return false;
      }
    }
    return true;
  };

  let tris = nf;
  while (tris > target && heap.length) {
    const e = pop();
    const { u, v } = e;
    if (dead[u] || dead[v] || ver[u] !== e.vu || ver[v] !== e.vv) continue;
    if (!safe(u, v, e.x, e.y, e.z)) continue;

    // Merge v into u.
    P[3 * u] = e.x; P[3 * u + 1] = e.y; P[3 * u + 2] = e.z;
    for (let k = 0; k < 10; k++) Q[u * 10 + k] += Q[v * 10 + k];
    dead[v] = 1; ver[u]++;
    for (const f of vf[v]) {
      if (!alive[f]) continue;
      const hasU = I[3 * f] === u || I[3 * f + 1] === u || I[3 * f + 2] === u;
      if (hasU) { alive[f] = 0; tris--; continue; }
      for (let k = 0; k < 3; k++) if (I[3 * f + k] === v) I[3 * f + k] = u;
      vf[u].push(f);
    }
    vf[v] = [];
    const around = new Set();
    for (const f of liveFaces(u)) for (let k = 0; k < 3; k++) { const w = I[3 * f + k]; if (w !== u) around.add(w); }
    for (const w of around) candidate(u, w);
  }

  // Compact: keep only vertices still referenced.
  const remap = new Int32Array(nv).fill(-1);
  let nvOut = 0, nfOut = 0;
  for (let f = 0; f < nf; f++) if (alive[f]) {
    nfOut++;
    for (let k = 0; k < 3; k++) { const v = I[3 * f + k]; if (remap[v] < 0) remap[v] = nvOut++; }
  }
  const positions = new Float32Array(nvOut * 3), indices = new Uint32Array(nfOut * 3);
  for (let v = 0; v < nv; v++) if (remap[v] >= 0) {
    positions[3 * remap[v]] = P[3 * v]; positions[3 * remap[v] + 1] = P[3 * v + 1]; positions[3 * remap[v] + 2] = P[3 * v + 2];
  }
  for (let f = 0, o = 0; f < nf; f++) if (alive[f]) for (let k = 0; k < 3; k++) indices[o++] = remap[I[3 * f + k]];
  return { positions, indices };
}

function faceNormal(P, a, b, c) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Closed-surface check, volume and bounding box: what the preview reports next to the triangle count. */
export function meshStats(mesh) {
  const { positions: P, indices: I } = mesh;
  const dir = new Map();
  let vol = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  const nv = P.length / 3;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const key = p * nv + q; dir.set(key, (dir.get(key) || 0) + 1); }
    vol += (P[3 * a] * (P[3 * b + 1] * P[3 * c + 2] - P[3 * b + 2] * P[3 * c + 1])
      - P[3 * a + 1] * (P[3 * b] * P[3 * c + 2] - P[3 * b + 2] * P[3 * c])
      + P[3 * a + 2] * (P[3 * b] * P[3 * c + 1] - P[3 * b + 1] * P[3 * c])) / 6;
  }
  let open = 0;
  for (const [key, n] of dir) {
    const p = Math.floor(key / nv), q = key % nv;
    if (n !== 1 || dir.get(q * nv + p) !== 1) open++;
  }
  return { triangles: I.length / 3, vertices: nv, volume: vol, closed: open === 0, size: [0, 1, 2].map(k => hi[k] - lo[k]) };
}
