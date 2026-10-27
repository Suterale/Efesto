// SDF -> triangle mesh with naive surface nets, processed slice by slice so memory stays
// proportional to one XY layer. Output is closed and consistently wound (normals outward)
// as long as the bounds enclose the shape. Vertices are projected onto the surface.

/**
 * @param f       scalar SDF f(x, y, z)
 * @param bounds  { lo: [x, y, z], hi: [x, y, z] }
 * @param cells   number of cells along the longest axis
 * @returns { positions: Float32Array (xyz per vertex), indices: Uint32Array (3 per triangle) }
 */
export function surfaceNets(f, bounds, cells = 160) {
  const size = [0, 1, 2].map(i => bounds.hi[i] - bounds.lo[i]);
  const step = Math.max(...size) / cells;
  // Pad two cells so the surface never reaches the grid boundary (keeps the mesh closed).
  const lo = bounds.lo.map(v => v - 2 * step);
  const [nx, ny, nz] = size.map(s => Math.ceil(s / step) + 5);   // grid points per axis

  const evalSlice = (k, out) => {
    const z = lo[2] + k * step;
    for (let j = 0, idx = 0; j < ny; j++) {
      const y = lo[1] + j * step;
      for (let i = 0; i < nx; i++, idx++) out[idx] = f(lo[0] + i * step, y, z);
    }
  };

  const verts = [];
  const tris = [];
  let s0 = new Float32Array(nx * ny), s1 = new Float32Array(nx * ny);
  // Vertex index per cell, for the previous and current cell layers (-1 = no vertex).
  let cPrev = new Int32Array((nx - 1) * (ny - 1)).fill(-1);
  let cCur = new Int32Array((nx - 1) * (ny - 1)).fill(-1);
  const cid = (i, j) => j * (nx - 1) + i;

  // Corner offsets of a cell and its 12 edges as corner pairs.
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);

  const quad = (a, b, c, d, flip) => {
    if (flip) tris.push(a, d, c, a, c, b);
    else tris.push(a, b, c, a, c, d);
  };

  evalSlice(0, s0);
  for (let k = 0; k < nz - 1; k++) {
    evalSlice(k + 1, s1);

    // 1. One vertex per cell that straddles the surface, at the mean of its edge crossings.
    cCur.fill(-1);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = corner[c];
          const v = (dk ? s1 : s0)[(j + dj) * nx + i + di];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0, py = 0, pz = 0, n = 0;
        for (const [a, b] of edges) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          px += corner[a][0] + t * (corner[b][0] - corner[a][0]);
          py += corner[a][1] + t * (corner[b][1] - corner[a][1]);
          pz += corner[a][2] + t * (corner[b][2] - corner[a][2]);
          n++;
        }
        cCur[cid(i, j)] = verts.length / 3;
        verts.push(lo[0] + (i + px / n) * step, lo[1] + (j + py / n) * step, lo[2] + (k + pz / n) * step);
      }
    }

    // 2. One quad per grid edge with a sign change, joining the 4 cells around it.
    //    Quad (c00, c10, c11, c01) in the (b, c) plane has normal +a; flip if outside is -a.
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v0 = s0[j * nx + i];
        const in0 = v0 < 0;
        // X edge at layer k: cells (i, j-1..j, k-1..k), plane axes (y, z).
        if (i < nx - 1 && k > 0 && j > 0 && j < ny - 1 && in0 !== (s0[j * nx + i + 1] < 0)) {
          quad(cPrev[cid(i, j - 1)], cPrev[cid(i, j)], cCur[cid(i, j)], cCur[cid(i, j - 1)], !in0);
        }
        // Y edge at layer k: cells (i-1..i, j, k-1..k), plane axes (z, x).
        if (j < ny - 1 && k > 0 && i > 0 && i < nx - 1 && in0 !== (s0[(j + 1) * nx + i] < 0)) {
          quad(cPrev[cid(i - 1, j)], cCur[cid(i - 1, j)], cCur[cid(i, j)], cPrev[cid(i, j)], !in0);
        }
        // Z edge from layer k to k+1: cells (i-1..i, j-1..j, k), plane axes (x, y).
        if (i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && in0 !== (s1[j * nx + i] < 0)) {
          quad(cCur[cid(i - 1, j - 1)], cCur[cid(i, j - 1)], cCur[cid(i, j)], cCur[cid(i - 1, j)], !in0);
        }
      }
    }

    [s0, s1] = [s1, s0];
    [cPrev, cCur] = [cCur, cPrev];
  }

  const positions = new Float32Array(verts);
  projectToSurface(f, positions, step);
  return { positions, indices: new Uint32Array(tris) };
}

/** A couple of Newton steps along the gradient, each limited to half a cell. */
function projectToSurface(f, pos, step) {
  const e = step * 0.05, maxMove = step * 0.5;
  for (let v = 0; v < pos.length; v += 3) {
    let x = pos[v], y = pos[v + 1], z = pos[v + 2];
    for (let it = 0; it < 3; it++) {
      const d = f(x, y, z);
      const gx = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e);
      const gy = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e);
      const gz = (f(x, y, z + e) - f(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (g2 < 1e-12) break;
      let s = d / g2;
      const move = Math.abs(s) * Math.sqrt(g2);
      if (move > maxMove) s *= maxMove / move;
      x -= s * gx; y -= s * gy; z -= s * gz;
      if (Math.abs(d) < step * 1e-4) break;
    }
    pos[v] = x; pos[v + 1] = y; pos[v + 2] = z;
  }
}

/**
 * Binary STL. `transform(x, y, z) -> [x, y, z]` maps app coordinates to file coordinates
 * (used to convert Y-up to the Z-up convention slicers expect).
 */
export function toSTL(mesh, transform = (x, y, z) => [x, y, z]) {
  const { positions: P, indices: I } = mesh;
  const nTri = I.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = 'sdfcad binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const p = [0, 1, 2].map(c => transform(P[I[3 * t + c] * 3], P[I[3 * t + c] * 3 + 1], P[I[3 * t + c] * 3 + 2]));
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, ...p[0], ...p[1], ...p[2]]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
