// Mesh preview shown before an STL is written: the real triangles, shaded and/or as wireframe,
// with a triangle-count control backed by quadric decimation (simplify.js).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { simplify, meshStats } from './simplify.js';

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('it');

let renderer, scene, camera, controls, solid, lines, light, raf = 0, session = null;

function init() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  $('pv-canvas').prepend(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
  light = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(light, light.target);
  controls.addEventListener('change', draw);
  new ResizeObserver(resize).observe($('pv-canvas'));
  for (const id of ['pv-shade', 'pv-wire']) $(id).onchange = applyDisplay;
}

function resize() {
  if (!renderer) return;
  const el = $('pv-canvas'), w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  camera.aspect = w / h; camera.updateProjectionMatrix();
  draw();
}

function draw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    light.position.copy(camera.position).add(new THREE.Vector3(0.3, 0.2, 0.6).multiplyScalar(camera.position.length()));
    renderer.render(scene, camera);
  });
}

function applyDisplay() {
  if (!solid) return;
  const shade = $('pv-shade').checked, wire = $('pv-wire').checked;
  solid.visible = shade;
  lines.visible = wire;
  // Lines over a solid need the solid pushed back a little; lines alone should be dark-on-light or vice versa.
  lines.material.color.set(shade ? 0x10202a : 0x9fd0ff);
  lines.material.opacity = shade ? 0.55 : 0.9;
  draw();
}

function show(mesh) {
  for (const o of [solid, lines]) if (o) { scene.remove(o); o.geometry.dispose(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  // Flat shading on purpose: the facets are the point of a preview.
  solid = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xc8d4e0, roughness: 0.75, metalness: 0.05, flatShading: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }));
  lines = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true }));
  scene.add(solid, lines);
  applyDisplay();
}

function frame(stats) {
  const [sx, sy, sz] = stats.size, r = Math.max(Math.hypot(sx, sy, sz) / 2, 1);
  const c = session.centre;
  controls.target.set(...c);
  camera.near = r / 100; camera.far = r * 100;
  camera.position.set(c[0] + r * 1.6, c[1] - r * 2.1, c[2] + r * 1.4);
  camera.updateProjectionMatrix();
  controls.update();
  draw();
}

function report(mesh) {
  const s = meshStats(mesh), o = session.original;
  const pct = (s.triangles / o.triangles * 100).toFixed(s.triangles === o.triangles ? 0 : 1);
  $('pv-stats').innerHTML =
    `Triangoli: <b>${fmt(s.triangles)}</b> (${pct}% dell'originale)<br>` +
    `Vertici: ${fmt(s.vertices)}<br>` +
    `Ingombro: ${s.size.map(v => v.toFixed(1)).join(' × ')} mm<br>` +
    `Volume: ${fmt(Math.round(s.volume))} mm³ (${((s.volume - o.volume) / o.volume * 100).toFixed(2)}%)<br>` +
    `Solido chiuso: ${s.closed ? 'sì' : '<b>NO</b>, la superficie ha buchi'}<br>` +
    `Dimensione file: ${(84 + 50 * s.triangles) / 1e6 < 1 ? Math.round((84 + 50 * s.triangles) / 1e3) + ' KB' : ((84 + 50 * s.triangles) / 1e6).toFixed(1) + ' MB'}`;
  return s;
}

function setBusy(on, msg = 'Ottimizzo…') {
  $('pv-busy').style.display = on ? 'flex' : 'none';
  $('pv-busy-msg').textContent = msg;
  for (const id of ['pv-export', 'pv-level', 'pv-apply', 'pv-reset']) $(id).disabled = on;
}

/** Slider position (0..100) -> triangle count, logarithmic so small targets stay reachable. */
function levelToTris(level) {
  const n = session.original.triangles, min = Math.max(100, Math.round(n / 200));
  return Math.round(Math.exp(Math.log(min) + (Math.log(n) - Math.log(min)) * level / 100));
}

function updateLevelLabel() {
  const level = +$('pv-level').value;
  $('pv-target').textContent = level >= 100 ? 'nessuna riduzione' : `circa ${fmt(levelToTris(level))} triangoli`;
}

function optimise(target) {
  setBusy(true);
  // Let the overlay paint before the blocking work.
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const mesh = target >= session.original.triangles ? session.originalMesh : simplify(session.originalMesh, target);
      session.current = mesh;
      show(mesh);
      const s = report(mesh);
      session.stats = s;
      $('pv-time').textContent = target >= session.original.triangles ? '' : `Ottimizzato in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } catch (err) {
      console.error(err);
      $('pv-time').textContent = 'Errore: ' + err.message;
    } finally { setBusy(false); }
  }, 30);
}

/**
 * @param mesh   { positions, indices } straight from the mesher
 * @param opts   { onExport(mesh), onClose() }
 */
export function openPreview(mesh, { onExport, onClose } = {}) {
  init();
  const stats = meshStats(mesh);
  session = {
    originalMesh: mesh, original: stats, current: mesh, stats, onExport, onClose,
    centre: (() => {
      const P = mesh.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
      return lo.map((v, k) => (v + hi[k]) / 2);
    })(),
  };
  $('pv-level').value = 100;
  $('pv-time').textContent = '';
  updateLevelLabel();
  $('preview').style.display = 'flex';
  resize();
  show(mesh);
  report(mesh);
  frame(stats);
}

export function closePreview() {
  if (!session) return;
  $('preview').style.display = 'none';
  for (const o of [solid, lines]) if (o) { scene.remove(o); o.geometry.dispose(); }
  solid = lines = null;
  const { onClose } = session;
  session = null;
  onClose?.();
}

export const previewOpen = () => !!session;

// Wiring that does not depend on the renderer.
$('pv-level').oninput = updateLevelLabel;
$('pv-apply').onclick = () => { const l = +$('pv-level').value; optimise(l >= 100 ? Infinity : levelToTris(l)); };
$('pv-reset').onclick = () => { $('pv-level').value = 100; updateLevelLabel(); optimise(Infinity); };
for (const b of document.querySelectorAll('[data-pv-preset]')) {
  b.onclick = () => {
    $('pv-level').value = b.dataset.pvPreset;
    updateLevelLabel();
    optimise(+b.dataset.pvPreset >= 100 ? Infinity : levelToTris(+b.dataset.pvPreset));
  };
}
$('pv-export').onclick = () => { if (session) { const { current, onExport } = session; onExport?.(current); closePreview(); } };
$('pv-cancel').onclick = closePreview;
window.addEventListener('keydown', e => { if (session && e.key === 'Escape') { e.stopPropagation(); closePreview(); } }, true);
