// Run: node app/test/mesher.test.mjs
import { compileJS, sceneBounds } from '../js/sdf.js';
import { surfaceNets, toSTL } from '../js/mesher.js';
import { signedDistance } from '../js/text.js';
import { TEXT_PAD } from '../js/sdf.js';
import { simplify, meshStats } from '../js/simplify.js';
import { parseSTL, buildMeshField } from '../js/stl.js';

const I4 = (tx = 0, ty = 0, tz = 0) => [1,0,0,0, 0,1,0,0, 0,0,1,0, -tx,-ty,-tz,1]; // world->local
function rotY(deg, tx = 0, ty = 0, tz = 0) {
  // local->world = T * Ry; world->local = Ry^T * T^-1
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // Ry^T columns (column-major): Ry = [[c,0,s],[0,1,0],[-s,0,c]], Ry^T = [[c,0,-s],[0,1,0],[s,0,c]]
  const m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1];
  m[12] = -(m[0]*tx + m[4]*ty + m[8]*tz); m[13] = -(m[1]*tx + m[5]*ty + m[9]*tz); m[14] = -(m[2]*tx + m[6]*ty + m[10]*tz);
  return m;
}

function check(name, objects, expectedVolume, cells = 128) {
  const f = compileJS(objects), b = sceneBounds(objects);
  const t0 = performance.now();
  const mesh = surfaceNets(f, b, cells);
  const ms = performance.now() - t0;
  const { positions: P, indices: I } = mesh;
  // Directed edge counts: closed + consistent winding <=> every directed edge appears once
  // and its reverse appears once.
  const dir = new Map();
  let bad = 0, vol = 0;
  for (let t = 0; t < I.length; t += 3) {
    const tri = [I[t], I[t+1], I[t+2]];
    for (let e = 0; e < 3; e++) {
      const key = tri[e] + ',' + tri[(e+1)%3];
      dir.set(key, (dir.get(key) || 0) + 1);
    }
    const [a, bb, c] = tri.map(i => [P[3*i], P[3*i+1], P[3*i+2]]);
    vol += (a[0]*(bb[1]*c[2]-bb[2]*c[1]) - a[1]*(bb[0]*c[2]-bb[2]*c[0]) + a[2]*(bb[0]*c[1]-bb[1]*c[0])) / 6;
  }
  for (const [key, n] of dir) {
    const [u, v] = key.split(',');
    if (n !== 1 || dir.get(v + ',' + u) !== 1) bad++;
  }
  const err = Math.abs(vol - expectedVolume) / expectedVolume;
  const ok = bad === 0 && err < 0.01;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(22)} tris=${I.length/3} badEdges=${bad} vol=${vol.toFixed(1)} expected=${expectedVolume.toFixed(1)} err=${(err*100).toFixed(2)}% ${ms.toFixed(0)}ms`);
  const stl = toSTL(mesh);
  if (stl.byteLength !== 84 + 50 * I.length / 3) throw new Error('bad STL size');
  return ok;
}

const obj = (type, inv, half, extra = {}) => ({ type, inv, half, round: 0, blend: 0, hole: false, ...extra });
let ok = true;
ok &= check('sphere r10', [obj('sphere', I4(), [10,10,10])], 4/3*Math.PI*1000);
ok &= check('box 20x10x30', [obj('box', I4(5,5,5), [10,5,15])], 20*10*30);
ok &= check('cylinder r10 h20', [obj('cylinder', I4(), [10,10,10])], Math.PI*100*20);
ok &= check('cone r10 h20', [obj('cone', I4(), [10,10,10])], Math.PI*100*20/3);
ok &= check('torus R7.5 r2.5', [obj('torus', I4(), [10,10,2.5])], 2*Math.PI**2*7.5*2.5**2, 160);
ok &= check('box - cyl hole', [obj('box', I4(), [10,10,10]), obj('cylinder', I4(), [4,4,20], {hole:true})], 8000 - Math.PI*16*20);
ok &= check('rotated box', [obj('box', rotY(30, 3, 0, -2), [10,5,5])], 20*10*10);
ok &= check('union overlapping', [obj('box', I4(), [10,10,10]), obj('box', I4(10,0,0), [10,10,10])], 30*20*20);
// Combinations: holes inside a union only cut that union, not the rest of the scene.
const combo = (type, children, extra = {}) => ({ type, children, blend: 0, hole: false, ...extra });
ok &= check('intersect boxes', [combo('intersect', [obj('box', I4(), [10,10,10]), obj('box', I4(10,0,0), [10,10,10])])], 10*20*20);
ok &= check('union w/ inner hole', [
  combo('union', [obj('box', I4(), [10,10,10]), obj('box', I4(), [5,5,20], {hole:true})]),
  obj('box', I4(), [2,2,2]),
], 8000 - 10*10*20 + 4*4*4);
ok &= check('hole union group', [
  obj('box', I4(), [10,10,10]),
  combo('union', [obj('box', I4(-5,0,0), [3,3,20]), obj('box', I4(5,0,0), [3,3,20])], {hole:true}),
], 8000 - 2*6*6*20);
// A union's own blend fillets the joints between its children (adds material at the joint).
{
  const pair = blend => [combo('union', [obj('box', I4(), [10,10,10]), obj('box', I4(10,0,10), [10,10,10])], { blend })];
  const vol = nodes => { const f = compileJS(nodes), b = sceneBounds(nodes); const { positions: P, indices: I } = surfaceNets(f, b, 96);
    let v = 0; for (let t = 0; t < I.length; t += 3) { const [a, c, d] = [I[t], I[t+1], I[t+2]].map(i => [P[3*i], P[3*i+1], P[3*i+2]]);
      v += (a[0]*(c[1]*d[2]-c[2]*d[1]) - a[1]*(c[0]*d[2]-c[2]*d[0]) + a[2]*(c[0]*d[1]-c[1]*d[0])) / 6; } return v; };
  const v0 = vol(pair(0)), v5 = vol(pair(5));
  const pass = v5 > v0 + 50;
  console.log(`${pass ? 'PASS' : 'FAIL'} union blend fillets   vol blend0=${v0.toFixed(0)} blend5=${v5.toFixed(0)}`);
  ok &= pass;
}
// Text: a synthetic glyph field (a frame: rectangle with a rectangular hole) instead of canvas-drawn
// letters. The ink box maps onto the object's x / y size, extruded over z.
{
  const field = (inkW, inkH, holeW, holeH) => {
    const w = inkW + 2 * TEXT_PAD, h = inkH + 2 * TEXT_PAD, alpha = new Float32Array(w * h);
    for (let y = 0; y < inkH; y++) for (let x = 0; x < inkW; x++) {
      const inHole = Math.abs(x + 0.5 - inkW / 2) < holeW / 2 && Math.abs(y + 0.5 - inkH / 2) < holeH / 2;
      if (!inHole) alpha[(y + TEXT_PAD) * w + x + TEXT_PAD] = 1;
    }
    return { data: signedDistance(alpha, w, h), w, h, inkW, inkH, em: 100 };
  };
  ok &= check('text field block', [obj('text', I4(), [10,5,2.5], { field: field(100, 50, 0, 0) })], 20*10*5);
  ok &= check('text field frame', [obj('text', I4(), [10,5,2.5], { field: field(100, 50, 50, 20) })], (20*10 - 10*4)*5, 160);
  ok &= check('text stretched+rot', [obj('text', rotY(30, 2, 0, 1), [20,4,3], { field: field(100, 50, 50, 20) })], (40*8 - 20*3.2)*6, 160);
  ok &= check('box - text hole', [obj('box', I4(), [15,10,5]), obj('text', I4(0,0,5), [10,5,2.5], { field: field(100, 50, 0, 0), hole: true })], 30*20*10 - 20*10*2.5);
}
// Imported STL: a triangle mesh baked into a 3D distance field, then used like any shape.
{
  // Box mesh (12 triangles, outward winding) and a UV sphere, written as binary STL.
  const boxTris = (x, y, z) => {
    const v = [...Array(8)].map((_, i) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]);
    const quads = [[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
    return quads.flatMap(([a, b, c, d]) => [...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]]);
  };
  const sphereTris = (r, nu = 48, nv = 24) => {
    const p = (i, j) => { const t = Math.PI * j / nv, f = 2 * Math.PI * i / nu; return [r * Math.sin(t) * Math.cos(f), r * Math.sin(t) * Math.sin(f), r * Math.cos(t)]; };
    const out = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = p(i, j), b = p(i, j + 1), c = p(i + 1, j + 1), d = p(i + 1, j);
      if (j > 0) out.push(...a, ...b, ...d);
      if (j < nv - 1) out.push(...b, ...c, ...d);
    }
    return out;
  };
  const binary = tris => {
    const n = tris.length / 9, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
    dv.setUint32(80, n, true);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, tris[t * 9 + k], true);
    return buf;
  };
  const ascii = tris => {
    let s = 'solid x\n';
    for (let t = 0; t < tris.length; t += 9) s += `facet normal 0 0 0\nouter loop\n${[0, 3, 6].map(k => `vertex ${tris[t+k]} ${tris[t+k+1]} ${tris[t+k+2]}\n`).join('')}endloop\nendfacet\n`;
    return new TextEncoder().encode(s + 'endsolid x\n').buffer;
  };
  const t0 = performance.now();
  const boxF = buildMeshField(parseSTL(binary(boxTris(20, 10, 30))));
  const sphF = buildMeshField(parseSTL(ascii(sphereTris(10))));
  console.log(`     mesh fields built in ${(performance.now() - t0).toFixed(0)}ms (${boxF.w}x${boxF.h}x${boxF.d}, ${sphF.w}x${sphF.h}x${sphF.d})`);
  // The tessellated sphere is a bit smaller than the true one: compare with the polyhedron's volume.
  const polyVol = tris => { let v = 0; for (let t = 0; t < tris.length; t += 9) { const [a, b, c] = [0, 3, 6].map(k => tris.slice(t + k, t + k + 3));
    v += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6; } return v; };
  ok &= check('stl box', [obj('mesh', I4(), [10,5,15], { field: boxF })], 20*10*30);
  ok &= check('stl sphere', [obj('mesh', I4(), [10,10,10], { field: sphF })], polyVol(sphereTris(10)));
  ok &= check('stl box stretched+rot', [obj('mesh', rotY(30, 2, 0, 1), [20,5,15], { field: boxF })], 40*10*30);
  ok &= check('box - stl sphere hole', [obj('box', I4(), [15,15,5]), obj('mesh', I4(0,0,5), [10,10,10], { field: sphF, hole: true })],
    30*30*10 - polyVol(sphereTris(10)) / 2);
}
// Decimation: fewer triangles, still closed and the same shape.
{
  const sim = (name, objects, expectedVolume, keep, cells = 128) => {
    const m = surfaceNets(compileJS(objects), sceneBounds(objects), cells);
    const n0 = m.indices.length / 3, t0 = performance.now();
    const r = simplify(m, n0 * keep);
    const ms = performance.now() - t0, s = meshStats(r);
    const err = Math.abs(s.volume - expectedVolume) / expectedVolume;
    const pass = s.closed && err < 0.02 && s.triangles <= n0 * keep * 1.05;
    console.log(`${pass ? 'PASS' : 'FAIL'} simplify ${name.padEnd(14)} ${n0} -> ${s.triangles} tris closed=${s.closed} vol err=${(err*100).toFixed(2)}% ${ms.toFixed(0)}ms`);
    ok &= pass;
    return s;
  };
  sim('sphere 10%', [obj('sphere', I4(), [10,10,10])], 4/3*Math.PI*1000, 0.1);
  const sb = sim('box 1%', [obj('box', I4(), [10,5,15])], 20*10*30, 0.01);
  const pass = sb.triangles < 2500;
  console.log(`${pass ? 'PASS' : 'FAIL'} simplify box flat faces collapse to ${sb.triangles} tris`);
  ok &= pass;
  sim('box-cyl 5%', [obj('box', I4(), [10,10,10]), obj('cylinder', I4(), [4,4,20], {hole:true})], 8000 - Math.PI*16*20, 0.05);
  sim('torus 20%', [obj('torus', I4(), [10,10,2.5])], 2*Math.PI**2*7.5*2.5**2, 0.2, 160);
}
process.exit(ok ? 0 : 1);
