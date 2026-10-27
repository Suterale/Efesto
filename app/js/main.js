import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { buildGLSL, compileJS, layout, MAX_NODES, MAX_MESH_TEX, sceneBounds, structureKey, textSlots, meshSlots } from './sdf.js';
import { FONTS, DEFAULT_FONT, textField, fontReady, loadFont, preloadFonts } from './text.js';
import { surfaceNets, toSTL } from './mesher.js';
import { parseSTL, buildMeshField } from './stl.js';
import { THEMES, DEFAULT_THEME, THEME_KEY, vectorIcon, vectorCombineIcon, asciiIcon, asciiCombineIcon, themeShapeColor } from './themes.js';
import { openPreview, previewOpen } from './preview.js';
import { createAscii } from './ascii.js';

// ---------------------------------------------------------------- model
//
// The document is a tree stored as a flat list; `parent` is the id of the containing group (null at
// top level) and pos / rot are relative to it. Top level result = union(solids) - union(holes).
// Shape: { id, name, type, color, hole, parent, pos[3], rot[3] (deg, XYZ), size[3] (mm), pivot[3], round, blend }
// Text shape adds { text, font, bold, italic, align, ink[2] }: size x / y is the box of the letters, size z the
// depth; ink is that box in ems, so when the text changes the letters keep their size (mm per em).
// Image (reference only, never part of the solid or the STL) adds { img, opacity (%), keepAspect, onTop, locked }:
// a picture on the local XY plane, size x / y in mm; img is a key into `images`, which holds the pixels.
// Imported STL ('mesh') adds { mesh }: a key into `meshes`, which holds its distance field; size is the box
// the model is stretched to (its own size when imported).
// Group: { id, name, type: 'group', mode, hole, parent, pos[3], rot[3], blend }
// pos is where the pivot sits; rotation and scaling happen around it. A shape's pivot is stored as its
// offset from the shape's centre (local frame, mm); a group's pivot is simply its origin.
//   mode 'group'      children just move together; they act as if they were at the parent level
//   mode 'union'      children merge into one solid (holes inside only cut the group)
//   mode 'intersect'  only the volume shared by all solid children is kept

const SHAPES = {
  box:      { label: 'Cubo',     size: [20, 20, 20] },
  sphere:   { label: 'Sfera',    size: [20, 20, 20] },
  cylinder: { label: 'Cilindro', size: [20, 20, 20] },
  cone:     { label: 'Cono',     size: [20, 20, 20] },
  torus:    { label: 'Toro',     size: [20, 20, 5] },
  text:     { label: 'Testo',    size: [41.6, 11.5, 5] },
  image:    { label: 'Immagine', size: [100, 100, 0.1] },
  mesh:     { label: 'Modello',  size: [20, 20, 20] },
};
const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const IMAGE_MAX = 2048;    // px, longest side kept on import
const IMAGE_LIFT = 0.1;    // mm above the workplane when resting on it, so the grid does not show through
const ORIENT = {           // preset rotations: lying on the workplane, or standing up facing -Y / +X
  flat: ['Piano', [0, 0, 0], 'Distesa sul piano di lavoro (vista dall\'alto)'],
  front: ['Fronte', [90, 0, 0], 'In piedi, rivolta verso −Y (vista frontale)'],
  side: ['Lato', [90, 90, 0], 'In piedi, rivolta verso +X (vista laterale)'],
};
const TEXT_EM = 16;   // default letter size of new text: mm per em
const TEXT_KEYS = new Set(['text', 'font', 'bold', 'italic', 'align']);
const MODES = { group: 'Gruppo', union: 'Unione', intersect: 'Intersezione' };
const PALETTE = ['#ff5555', '#ffaa00', '#ffff55', '#55ff55', '#55ffff', '#5555ff', '#ff55ff'];
// Autosave used to live in localStorage under these keys; read once to migrate into IndexedDB.
const LEGACY_KEYS = { project: 'sdfcad.project.v1', images: 'sdfcad.images.v1', meshes: 'sdfcad.meshes.v1' };
const PIXEL_KEY = 'sdfcad.pixel';
const SPACE_KEY = 'sdfcad.space';
const QUALITY_KEY = 'sdfcad.renderq';
const PIXEL_RATIO = 1 / 3;   // render scale of the 3D view in pixel mode
// Render quality, cycled by one button. Scale is relative to the screen's pixel ratio, while moving / at rest;
// steps caps the ray-march loop. "off" trades nearly all the detail for a view that stays fluid on weak GPUs.
const RENDER_MODES = {
  cached:  { label: 'Cache',    move: 0.5,  rest: 0.5, steps: 300, tip: 'risoluzione media fissa, sempre fluida' },
  off:     { label: 'Off',      move: 0.2,  rest: 0.2, steps: 64,  tip: 'qualità minima, massima fluidità' },
  full:    { label: 'Pieno',    move: 1,    rest: 1,   steps: 300, tip: 'sempre a piena risoluzione' },
  dynamic: { label: 'Dinamico', move: 0.5,  rest: 1,   steps: 300, tip: 'veloce in movimento, completa da fermo' },
};
const RENDER_ORDER = ['cached', 'off', 'full', 'dynamic'];

let objects = [];
let selectedIds = [];   // always siblings (same parent)
let nextId = 1;
// The group whose parts are being edited (null = top level). Only that group and its ancestors are
// "open": every other group is one opaque object, its parts neither listed, outlined nor pickable.
let entered = null;
// Imported pictures, key -> { src, w, h, thumb } (data URLs, px). Kept out of the undo history; entries
// are never dropped during a session, so undoing a delete finds its picture again.
const images = new Map();
// Imported STL models, key -> { tris, w, h, d, cell, ext, src }: src is the distance field as gzipped half
// floats in base64 (what gets saved); kept like `images`. Decoded fields live in meshFields, key -> field.
const meshes = new Map();
const meshFields = new Map();

const byId = id => objects.find(o => o.id === id);
const selected = () => selectedIds.length === 1 ? byId(selectedIds[0]) : null;
const isGroup = o => o.type === 'group';
const isImage = o => o.type === 'image';
const isMesh = o => o.type === 'mesh';
const parentOf = o => o.parent ?? null;
const childrenOf = id => objects.filter(o => parentOf(o) === id);
/** Ancestors of o, outermost first. */
function ancestors(o) {
  const out = [];
  for (let p = byId(parentOf(o)); p; p = byId(parentOf(p))) out.unshift(p);
  return out;
}
/** Shown as a hole ghost: a hole itself, or inside a union / intersection that is a hole. */
const isGhost = o => o.hole || ancestors(o).some(a => a.hole && a.mode !== 'group');
/** Hole ghosts stay hidden while a group containing them is folded in the list. */
const openIds = () => new Set(entered == null ? [] : [...ancestors(byId(entered)), byId(entered)].map(g => g.id));
const isOpen = g => openIds().has(g.id);
const isFolded = o => ancestors(o).some(a => !isOpen(a));
const deg = THREE.MathUtils.degToRad, rad2deg = THREE.MathUtils.radToDeg;

// ---------------------------------------------------------------- three.js setup

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
let themeName = DEFAULT_THEME, pixelMode = true, renderQ = 'dynamic', gizmoSpace = 'world', pivotMode = false;
try {
  const t = localStorage.getItem(THEME_KEY);
  if (THEMES[t]) themeName = t;
  pixelMode = localStorage.getItem(PIXEL_KEY) !== '0';
  if (localStorage.getItem(SPACE_KEY) === 'local') gizmoSpace = 'local';
  const q = localStorage.getItem(QUALITY_KEY);
  if (q in RENDER_MODES) renderQ = q;
} catch { /* storage unavailable */ }
let theme = THEMES[themeName];
/** The ASCII theme draws its own coarse cells, so the pixelated render scale does not apply there. */
let interacting = false;   // the camera or an object is moving: the smooth view drops to half resolution
const pixelRatio = () => {
  if (theme.ascii) return Math.min(window.devicePixelRatio, 2);
  const m = RENDER_MODES[renderQ], q = Math.min(window.devicePixelRatio, 2) * (interacting ? m.move : m.rest);
  return pixelMode ? Math.min(PIXEL_RATIO, q) : q;
};
renderer.setPixelRatio(pixelRatio());
renderer.setClearColor(theme.clear, theme.clearAlpha);
view.prepend(renderer.domElement);

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
camera.up.set(0, 0, 1);
camera.position.set(90, -120, 85);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 10);
// Left button is free for picking / box selection; the wheel zooms.
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
orbit.update();

// Workplane: PLANE_SIZE mm square, 10 mm major / 2 mm minor grid (theme divisions are per 200 mm).
const PLANE_SIZE = 1000;
const plane = new THREE.Mesh(
  new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE),
  new THREE.MeshBasicMaterial({ color: theme.plane, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
scene.add(plane);
const gridLines = [];
function buildGrids() {
  for (const g of gridLines) { g.removeFromParent(); g.geometry.dispose(); g.material.dispose(); }
  gridLines.length = 0;
  for (const [div, c, opacity] of theme.grids) {
    const g = new THREE.GridHelper(PLANE_SIZE, div * PLANE_SIZE / 200, c, c);
    g.rotation.x = Math.PI / 2;
    g.material.transparent = true;
    g.material.opacity = opacity;
    scene.add(g);
    gridLines.push(g);
  }
}
buildGrids();
const axes = new THREE.AxesHelper(30);
axes.position.z = 0.05;
scene.add(axes);

// Proxy geometry per shape, in a unit box (size 1), used for picking, hole ghosts and outlines.
const UNIT_GEOM = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 32, 16),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 40).rotateX(Math.PI / 2),
  cone: new THREE.ConeGeometry(0.5, 1, 40).rotateX(Math.PI / 2),
  torus: new THREE.TorusGeometry(0.375, 0.125, 16, 48).scale(1, 1, 4),
  text: new THREE.BoxGeometry(1, 1, 1),
  mesh: new THREE.BoxGeometry(1, 1, 1),
  image: new THREE.PlaneGeometry(1, 1),
};
const OUTLINE_GEOM = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const holeMat = new THREE.MeshBasicMaterial({ color: theme.hole[0], transparent: true, opacity: theme.hole[1], depthWrite: false });
const outlineMat = new THREE.LineBasicMaterial({ color: theme.outline });

const SEL_LAYER = 1;      // three.js layer of selected proxies, for the selection outline
const views = new Map();   // id -> { group, mesh, outline, imgMat }; groups have no mesh / outline

// GPU copies of imported pictures, made on first use.
const imageTextures = new Map();
function imageTexture(key) {
  let t = imageTextures.get(key);
  if (!t && images.has(key)) {
    t = new THREE.TextureLoader().load(images.get(key).src, render);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    imageTextures.set(key, t);
  }
  return t ?? null;
}

function createView(o, parent3) {
  const group = new THREE.Group();
  let mesh = null, outline = null, imgMat = null;
  if (!isGroup(o)) {
    // An image is the only thing three.js draws itself: its proxy is the picture.
    if (isImage(o)) imgMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
    mesh = new THREE.Mesh(UNIT_GEOM[o.type], imgMat ?? pickMat);
    mesh.userData.id = o.id;
    outline = new THREE.LineSegments(OUTLINE_GEOM, outlineMat);
    outline.visible = false;
    group.add(mesh, outline);
  }
  // A group seen from outside (folded in the list) is outlined as one box around all its parts.
  let gmesh = null, goutline = null;
  if (isGroup(o)) {
    gmesh = new THREE.Mesh(UNIT_GEOM.box, pickMat);   // no userData.id: never picked
    goutline = new THREE.LineSegments(OUTLINE_GEOM, outlineMat);
    gmesh.visible = goutline.visible = false;
    group.add(gmesh, goutline);
  }
  parent3.add(group);
  views.set(o.id, { group, mesh, outline, imgMat, gmesh, goutline });
  syncView(o);
}

/** Recreate the three.js hierarchy from the document tree. */
function rebuildViews() {
  transform.detach();
  for (const v of views.values()) { v.group.removeFromParent(); v.imgMat?.dispose(); }
  views.clear();
  const build = (parentId, parent3) => {
    for (const o of childrenOf(parentId)) {
      createView(o, parent3);
      build(o.id, views.get(o.id).group);
    }
  };
  build(null, scene);
}

function syncView(o) {
  const { group, mesh, outline, imgMat } = views.get(o.id);
  group.position.fromArray(o.pos);
  group.rotation.set(deg(o.rot[0]), deg(o.rot[1]), deg(o.rot[2]));
  group.scale.set(1, 1, 1);
  if (!mesh) return;
  mesh.position.fromArray(o.pivot).negate();
  outline.position.copy(mesh.position);
  mesh.scale.fromArray(o.size);
  outline.scale.fromArray(o.size);
  if (!imgMat) { mesh.material = isGhost(o) && !isFolded(o) ? holeMat : pickMat; return; }
  const map = imageTexture(o.img);
  if (imgMat.map !== map) { imgMat.map = map; imgMat.needsUpdate = true; }
  imgMat.color.set(map ? 0xffffff : 0x808080);   // grey card if the picture is missing
  imgMat.opacity = (o.opacity ?? 100) / 100;
  // Drawn after the grid; "on top" also ignores the solids' depth, so it shows through them.
  imgMat.depthTest = !o.onTop;
  mesh.renderOrder = o.onTop ? 2 : 1;
}

function syncAll() {
  objects.forEach(syncView);
  updateOutlines();
}

/**
 * Outline what is selected: a shape on its own, a group folded in the list as a single box, and the
 * parts of a group that is open in the list one by one.
 */
function updateOutlines() {
  const shapes = new Set(), boxes = new Set();
  const mark = o => {
    if (!isGroup(o)) shapes.add(o.id);
    else if (!isOpen(o)) boxes.add(o.id);
    else childrenOf(o.id).forEach(mark);
  };
  selectedIds.map(byId).filter(Boolean).forEach(mark);
  for (const o of objects) {
    const { mesh, outline, gmesh, goutline, group } = views.get(o.id);
    if (outline) {
      outline.visible = shapes.has(o.id);
      if (outline.visible) mesh.layers.enable(SEL_LAYER); else mesh.layers.disable(SEL_LAYER);
    }
    if (!goutline) continue;
    gmesh.visible = goutline.visible = boxes.has(o.id);
    if (!goutline.visible) { gmesh.layers.disable(SEL_LAYER); continue; }
    const box = resultBox(o);
    if (box.isEmpty()) { gmesh.visible = goutline.visible = false; continue; }
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    for (const m of [gmesh, goutline]) { m.position.copy(centre); m.scale.copy(size); }
    gmesh.layers.enable(SEL_LAYER);
  }
}

// ---------------------------------------------------------------- SDF preview (GPU raymarching)

const VERT = /* glsl */`
varying vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
uniform mat4 uCamWorld, uProjInv, uProj, uView;
uniform vec3 uBMin, uBMax;
uniform vec4 uLit, uRim, uSpec;   // light weights; rim colour + strength; shininess, strength, hard
uniform vec2 uBands;             // bands (0 = smooth), dither
uniform float uPix;              // size of one pixel per mm of distance from the camera
uniform highp sampler3D uGrid;   // baked distance field of the whole scene (see bakeGrid)
uniform vec4 uGridA;             // grid size in mm (xyz), 1 when the grid matches the scene
uniform vec4 uGridB;             // cells per axis (xyz), cell size in mm (w)
uniform float uBake;             // 0 = draw the scene; n > 0 = write grid layer n - 1 instead
uniform float uCap;              // largest distance the baked grid stores
uniform int uMaxSteps;           // ray-march iteration cap (the render quality mode lowers it)
uniform int uZero;               // always 0: a loop bound the compiler cannot see, so it does not unroll map()
varying vec2 vNdc;

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBMin - ro) * inv, t1 = (uBMax - ro) * inv;
  vec3 a = min(t0, t1), b = max(t0, t1);
  return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z));
}
// 4x4 ordered (Bayer) dither threshold in [0, 1).
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
// Tetrahedron normal; the colour is the average of the four samples (loops keep map() inlined once, not 4 times).
const vec3 TETRA[4] = vec3[4](vec3(1.0, -1.0, -1.0), vec3(-1.0, -1.0, 1.0), vec3(-1.0, 1.0, -1.0), vec3(1.0, 1.0, 1.0));
vec3 calcNormal(vec3 p, float e, out vec3 col) {
  vec3 n = vec3(0.0);
  col = vec3(0.0);
  for (int i = uZero; i < 4 + uZero; i++) {
    vec4 m = mapC(p + TETRA[i] * e);
    n += TETRA[i] * m.w;
    col += m.rgb;
  }
  col *= 0.25;
  return normalize(n);
}
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, w = 1.0;
  for (int i = 1 + uZero; i <= 5 + uZero; i++) {
    float h = 0.6 * float(i) * float(i);
    occ += (h - map(p + n * h)) * w;
    w *= 0.6;
  }
  return clamp(1.0 - 0.06 * occ, 0.0, 1.0);
}
void main() {
  if (uBake > 0.5) {
    vec3 pos = uBMin + vec3(vNdc * 0.5 + 0.5, 0.0) * vec3(uGridB.xy, 0.0) * uGridB.w + vec3(0.0, 0.0, (uBake - 0.5) * uGridB.w);
    // Only distances up to uCap matter to the march, and only nodes within that reach can produce them.
    gCap = uCap;
    setPoint(pos, uCap);
    vec4 m = mapC(pos);
    gl_FragColor = vec4(min(m.w, uCap), m.rgb);   // the scene grid only reads the distance; baked groups keep the colour too
    return;
  }
  vec4 v = uProjInv * vec4(vNdc, 1.0, 1.0);
  vec3 ro = cameraPosition;
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec2 tb = boxHit(ro, rd);
  if (tb.x > tb.y || tb.y < 0.0) discard;
  setRay(ro, rd);
  float t = max(tb.x, 0.0);
  // Tolerances follow the pixel size, not the distance: the orthographic view is a narrow camera far
  // away, where a fixed fraction of the distance would be millimetres.
  float px = min(0.0005, 0.5 * uPix);
  bool hit = false;
  for (int i = 0; i < uMaxSteps; i++) {
    vec3 pp = ro + rd * t;
    if (uGridA.w > 0.5) {
      // Far from every surface the baked field is enough (minus its worst-case interpolation error).
      float g = textureLod(uGrid, clamp((pp - uBMin) / uGridA.xyz, 0.0, 1.0), 0.0).r * 0.99 - uGridB.w * 1.8 - 0.01;
      if (g > 0.0) {
        t += g * 0.9;
        if (t > tb.y) break;
        continue;
      }
    }
    float d = map(pp);
    if (abs(d) < px * t + 0.002) { hit = true; break; }
    t += d * 0.9;
    if (t > tb.y) break;
  }
  if (!hit) discard;

  vec3 p = ro + rd * t;
  setPoint(p, 16.0);   // normal and occlusion samples reach off the ray (AO up to 15 mm)
  vec3 base;
  vec3 n = calcNormal(p, max(min(0.0004, uPix) * t, 0.002), base);
  vec3 L = normalize(vec3(0.45, -0.35, 0.82));
  float dif = clamp(dot(n, L), 0.0, 1.0);
  float fill = clamp(dot(n, normalize(vec3(-0.6, 0.5, 0.2))), 0.0, 1.0);
  float hemi = 0.55 + 0.45 * n.z;
  float ao = calcAO(p, n);
  // Light optionally quantised to a few (dithered) bands; the theme picks bands, specular and rim glow.
  float lit = uLit.x * hemi * ao + uLit.y * dif * (0.5 + 0.5 * ao) + uLit.z * fill;
  if (uBands.x > 0.5) lit = floor(lit * uBands.x + uBands.y * bayer4(gl_FragCoord.xy)) / uBands.x;
  float sp = pow(clamp(dot(reflect(rd, n), L), 0.0, 1.0), uSpec.x);
  float spec = uSpec.z > 0.5 ? step(0.92, sp) * uSpec.y : sp * uSpec.y;
  vec3 col = base * max(lit, uLit.w) + spec;
  col += uRim.rgb * uRim.a * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);

  vec4 clip = uProj * uView * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}
`;

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
quad.renderOrder = -1;
scene.add(quad);
let shaderKey = null, shaderToken = 0, shaderPending = false;

// The scene as a float texture, 11 texels per node (see buildGLSL), one row per node.
const NODE_TEXELS = 11;
const nodeData = new Float32Array(NODE_TEXELS * MAX_NODES * 4);
const nodeTexture = new THREE.DataTexture(nodeData, NODE_TEXELS, MAX_NODES, THREE.RGBAFormat, THREE.FloatType);
nodeTexture.minFilter = nodeTexture.magFilter = THREE.NearestFilter;

function makeShaderMaterial(nodes) {
  const textures = Object.fromEntries([
    ...[...textSlots(nodes).values()].map(k => [`uT${k}`, { value: null }]),
    ...[...meshSlots(nodes).values()].map(k => [`uV${k}`, { value: null }]),
  ]);
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: buildGLSL(nodes) + FRAG,
    uniforms: {
      uNodes: { value: nodeTexture }, uCount: { value: 0 },
      ...textures,
      uCamWorld: { value: camera.matrixWorld },
      uProjInv: { value: camera.projectionMatrixInverse },
      uProj: { value: camera.projectionMatrix },
      uView: { value: camera.matrixWorldInverse },
      uBMin: { value: new THREE.Vector3(1, 1, 1) },
      uBMax: { value: new THREE.Vector3(-1, -1, -1) },
      uLit: { value: new THREE.Vector4() }, uRim: { value: new THREE.Vector4() },
      uSpec: { value: new THREE.Vector4() }, uBands: { value: new THREE.Vector2() },
      uPix: { value: 0.001 },
      uZero: { value: 0 }, uMaxSteps: { value: 300 },
      uGrid: { value: null },
      uGridA: { value: new THREE.Vector4() }, uGridB: { value: new THREE.Vector4() },
      uBake: { value: 0 }, uCap: { value: 1e10 },
    },
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
  });
}

/**
 * Make sure the shader matches the scene's structure. Compiling a big scene takes a while, so after the
 * first one it happens in the background: the previous picture stays up (and the UI responsive) until the
 * new program is ready. Returns false while that is the case, i.e. the uniforms must not be written yet.
 */
function rebuildShaderIfNeeded(nodes) {
  const key = structureKey(nodes);
  if (key === shaderKey) return !shaderPending;
  shaderKey = key;
  const material = makeShaderMaterial(nodes);
  if (!quad.material.isShaderMaterial) {
    quad.material = material;
    shaderPending = false;
    return true;
  }
  const token = ++shaderToken;
  shaderPending = true;
  const probe = new THREE.Scene();
  probe.add(new THREE.Mesh(quad.geometry, material));
  const swap = () => {
    if (token !== shaderToken) { material.dispose(); return; }
    shaderPending = false;
    quad.material.dispose();
    quad.material = material;
    render();
  };
  renderer.compileAsync(probe, camera).then(swap, swap);
  return false;
}

const ONE = new THREE.Vector3(1, 1, 1);

/** Colour of a united group: its own, or that of its first solid part until one is chosen. */
function groupColor(g) {
  if (g.color) return g.color;
  const first = objects.find(o => !isGroup(o) && !o.hole && !isImage(o) && ancestors(o).includes(g));
  return first?.color ?? '#c0c0c0';
}

/**
 * Kernel nodes for one object, read from the live view (includes in-progress drags). `lod` is for the
 * preview only: a folded group may then come back as one baked node (see bakedNode) instead of its parts.
 */
function kernelNodes(o, skip = null, tint = null, lod = false) {
  if (o.id === skip) return [];
  if (isGroup(o)) {
    let partsLod = lod;
    if (lod && !isOpen(o)) {
      const baked = bakedNode(o, tint);
      // Waiting for its texture: draw the parts live, without queueing a bake for every group inside it.
      if (baked === WAITING) partsLod = false;
      else if (baked) return [baked];
    }
    // A union / intersection is one object: its parts all take the group's colour.
    const own = o.mode === 'group' ? tint : tint ?? groupColor(o);
    const children = childrenOf(o.id).flatMap(c => kernelNodes(c, skip, own, partsLod));
    // A plain group is transparent: its children combine with the parent level directly.
    return o.mode === 'group' ? children : [{ type: o.mode, hole: o.hole, blend: o.blend, children }];
  }
  if (isImage(o)) return [];   // reference only: not part of the solid
  // The proxy mesh sits at the shape's centre and is scaled to its (live) size.
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  views.get(o.id).mesh.matrixWorld.decompose(p, q, s);
  const inv = new THREE.Matrix4().compose(p, q, ONE).invert().toArray();
  const half = s.toArray().map(v => Math.max(Math.abs(v), 0.01) / 2);
  const node = { type: o.type, hole: o.hole, inv, half, round: o.round, roundAxis: o.roundAxis, edges: o.edges, blend: o.blend, color: tint ?? o.color };
  if (o.type === 'text') {
    node.field = textField(o, disposeField);
    if (!node.field) {
      if (!fontReady(o)) loadFont(o).then(render);
      return [];   // still loading, or nothing but spaces
    }
  }
  if (isMesh(o)) {
    node.field = meshField(o.mesh);
    if (!node.field) return [];   // still decoding, or its data is missing
  }
  return [node];
}

// GPU copies of text distance fields (half floats, linear filtering), made on first use.
const fieldTextures = new WeakMap();
function fieldTexture(f) {
  let t = fieldTextures.get(f);
  if (!t) {
    const half = new Uint16Array(f.data.length);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(f.data[i]);
    t = new THREE.DataTexture(half, f.w, f.h, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    fieldTextures.set(f, t);
  }
  return t;
}
function disposeField(f) {
  fieldTextures.get(f)?.dispose();
  fieldTextures.delete(f);
}

// GPU copies of imported mesh fields (3D, half floats, linear filtering), made on first use.
const meshTextures = new WeakMap();
function meshTexture(f) {
  if (f.baked) return f.target.texture;
  let t = meshTextures.get(f);
  if (!t) {
    t = new THREE.Data3DTexture(f.half, f.w, f.h, f.d);
    t.format = THREE.RedFormat;
    t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    meshTextures.set(f, t);
  }
  return t;
}

/** The decoded field of an imported mesh, or null while it is being decoded (render runs again after). */
const decoding = new Set();
function meshField(key) {
  if (meshFields.has(key)) return meshFields.get(key);
  const m = meshes.get(key);
  if (m && !decoding.has(key)) {
    decoding.add(key);
    decodeMesh(m).then(f => { meshFields.set(key, f); render(); })
      .catch(err => status(`Modello importato illeggibile: ${err.message}`))
      .finally(() => decoding.delete(key));
  }
  return null;
}

/** The whole scene in the form the SDF kernel expects, optionally leaving out one object. */
function kernelObjects(skip = null, lod = false) {
  scene.updateMatrixWorld();
  return childrenOf(null).flatMap(o => kernelNodes(o, skip, null, lod));
}

// ---- Baked groups
//
// A folded group is one object to the user, so the preview draws it as one: its parts are rendered once
// into a 3D texture (distance + colour) and the ray-marcher then pays a single fetch per step however many
// shapes it holds. The texture lives in the group's own frame, so moving or rotating the group costs
// nothing; it is rebuilt only when the parts change, which needs the group open (and then it is live
// again). The STL export never sees baked nodes, and a group that cannot be baked safely stays live.
const BAKE_RES = 128;        // cells along the longest side of the content, padding excluded
const BAKE_PAD = 3;          // cells of margin around it
const BAKE_MIN_SHAPES = 4;   // smaller groups are cheaper to leave live
const bakes = new Map();     // signature -> { field, used }
let wantedBakes = new Map(), bakeStamp = 0, bakeRunTimer = 0;
const WAITING = Symbol('waiting for bake');

/** How many shapes a folded group stands for, or 0 when it cannot be drawn as one baked field. */
function bakeableShapes(g) {
  let n = 0;
  // `outer`: the node joins the shapes around the group, so a hole or blend of its own would reach them.
  const walk = (o, outer) => {
    if (isImage(o)) return true;
    if (outer && (o.hole || o.blend)) return false;
    if (isGroup(o)) return childrenOf(o.id).every(c => walk(c, outer && o.mode === 'group'));
    if (o.type === 'text' || isMesh(o)) return false;   // their textures are not available to the bake
    n++;
    return true;
  };
  return childrenOf(g.id).every(c => walk(c, g.mode === 'group')) ? n : 0;
}

/** Everything that shapes a group's baked field, but not where the group itself is. */
function bakeKey(g, tint) {
  const part = o => isGroup(o)
    ? [o.mode, o.hole, o.blend, o.color, o.pos, o.rot, childrenOf(o.id).map(part)]
    : [o.type, o.hole, o.blend, o.color, o.round, o.roundAxis, o.edges, o.pos, o.rot, o.size, o.pivot];
  return JSON.stringify([tint, g.mode, g.blend, groupColor(g), childrenOf(g.id).map(part)]);
}

/** The same nodes with their world -> local matrices re-expressed from frame `G` (local -> world). */
function toFrame(nodes, G) {
  return nodes.map(n => ({
    ...n,
    ...(n.inv ? { inv: new THREE.Matrix4().fromArray(n.inv).multiply(G).toArray() } : {}),
    ...(n.children ? { children: toFrame(n.children, G) } : {}),
  }));
}

/**
 * A folded group as one preview node, or null when that is not possible (too small to be worth it, or
 * being scaled). WAITING means its texture is not baked yet: it is queued, and the live parts are drawn.
 */
function bakedNode(g, tint) {
  if (bakeableShapes(g) < BAKE_MIN_SHAPES) return null;
  const G = views.get(g.id).group.matrixWorld, s = new THREE.Vector3();
  G.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  if (s.distanceTo(ONE) > 1e-6) return null;
  const key = bakeKey(g, tint), baked = bakes.get(key);
  const own = g.mode !== 'group';   // a union / intersection carries its own hole and blend, a plain group none
  if (!baked) {
    if (!wantedBakes.has(key)) {
      // The parts as a union list in the group's frame; a union / intersection loses its outer hole flag.
      const exact = kernelNodes(g, null, tint);
      if (!exact.length) return null;
      wantedBakes.set(key, toFrame(exact, G).map(n => own ? { ...n, hole: false } : n));
    }
    return WAITING;
  }
  baked.used = bakeStamp;
  const { field } = baked, centre = new THREE.Vector3(...field.centre);
  const M = G.clone().multiply(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
  return {
    type: 'baked', hole: own && g.hole, blend: own ? g.blend : 0, field, get exact() { return kernelNodes(g, null, tint); },
    inv: M.invert().toArray(), half: field.ext.map(v => v / 2), color: tint ?? groupColor(g),
  };
}

/** Baked groups that did not get a texture slot go back to their live parts. */
function resolveBaked(nodes) {
  const slots = meshSlots(nodes);
  const fix = list => list.flatMap(n => n.type === 'baked' && !slots.has(n.field) ? n.exact
    : n.children ? [{ ...n, children: fix(n.children) }] : [n]);
  return fix(nodes);
}

/** Render the wanted groups into 3D textures, a moment after the scene settles. */
function scheduleBakes() {
  if (!wantedBakes.size || bakeRunTimer) return;
  bakeRunTimer = setTimeout(() => { bakeRunTimer = 0; runBakes(); }, 40);
}

function runBakes() {
  if (shaderPending || !quad.material.isShaderMaterial || sceneDirty) { scheduleBakes(); return; }
  let made = false;
  for (const [key, nodes] of wantedBakes) {
    if (bakes.has(key)) continue;
    // Make room by dropping the group that has gone unused longest; if every texture is in use the
    // newcomer simply stays live (replacing one that is drawn would just make them take turns).
    if (bakes.size >= MAX_MESH_TEX) {
      const [oldKey, old] = [...bakes].sort((a, b) => a[1].used - b[1].used)[0];
      if (old.used === bakeStamp) continue;
      old.field.target.dispose();
      bakes.delete(oldKey);
    }
    const field = bakeField(nodes);
    if (!field) continue;
    bakes.set(key, { field, used: bakeStamp });
    made = true;
  }
  wantedBakes = new Map();
  if (made) render();   // redraw with the baked nodes
}

/** Bake nodes (in the frame they will be drawn in) with the scene shader; null when there is nothing solid. */
function bakeField(nodes) {
  const box = sceneBounds(nodes);
  if (!box) return null;
  const ext = box.hi.map((v, i) => Math.max(v - box.lo[i], 0.01));
  const centre = box.lo.map((v, i) => (v + box.hi[i]) / 2);
  const cell = Math.max(...ext) / BAKE_RES;
  const dims = ext.map(v => Math.ceil(v / cell) + 2 * BAKE_PAD);
  const u = quad.material.uniforms;
  const saved = {
    count: u.uCount.value, bmin: u.uBMin.value.clone(), bmax: u.uBMax.value.clone(),
    gridA: u.uGridA.value.clone(), gridB: u.uGridB.value.clone(), cap: u.uCap.value, grid: u.uGrid.value,
  };
  writeNodes(nodes);
  u.uBMin.value.set(...centre.map((v, i) => v - dims[i] * cell / 2));
  u.uGridB.value.set(...dims, cell);
  u.uCap.value = cell * 8;   // only the neighbourhood of the surface matters, and a small reach skips most parts
  const target = new THREE.WebGL3DRenderTarget(dims[0], dims[1], dims[2], { depthBuffer: false });
  Object.assign(target.texture, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  bakeQuad.material = quad.material;
  const previous = renderer.getRenderTarget();
  for (let z = 0; z < dims[2]; z++) {
    u.uBake.value = z + 1;
    renderer.setRenderTarget(target, z);
    renderer.render(bakeScene, bakeCam);
  }
  renderer.setRenderTarget(previous);
  u.uBake.value = 0;
  u.uCount.value = saved.count;
  u.uBMin.value.copy(saved.bmin);
  u.uBMax.value.copy(saved.bmax);
  u.uGridA.value.copy(saved.gridA);
  u.uGridB.value.copy(saved.gridB);
  u.uCap.value = saved.cap;
  u.uGrid.value = saved.grid;
  return { baked: true, target, ext, centre, cell };
}

const tmpColor = new THREE.Color();
/** Object uniforms, from the live views. Skipped while the camera alone moves (see render). */
function updateSceneUniforms() {
  bakeStamp++;
  wantedBakes = new Map();
  const ko = resolveBaked(kernelObjects(null, true));
  scheduleBakes();
  if (!rebuildShaderIfNeeded(ko)) return;
  writeNodes(ko);
  const u = quad.material.uniforms;
  const b = sceneBounds(ko);
  if (b) {
    u.uBMin.value.fromArray(b.lo).subScalar(1);
    u.uBMax.value.fromArray(b.hi).addScalar(1);
  } else {
    u.uBMin.value.set(1, 1, 1);
    u.uBMax.value.set(-1, -1, -1);
  }
}

/** Write kernel nodes into the node texture and the texture uniforms the shader walks. */
function writeNodes(ko) {
  const u = quad.material.uniforms;
  const entries = layout(ko);
  if (entries.length > MAX_NODES) status(`Troppi oggetti per l'anteprima (${MAX_NODES} al massimo): gli ultimi non si vedono, l'esportazione è completa.`);
  const count = Math.min(entries.length, MAX_NODES);
  const tex = textSlots(ko), vol = meshSlots(ko);
  for (let i = 0; i < count; i++) {
    const { node: k, sphere, end } = entries[i], o = i * NODE_TEXELS * 4;
    nodeData.fill(0, o, o + NODE_TEXELS * 4);
    const set = (texel, ...v) => nodeData.set(v, o + texel * 4);
    tmpColor.set(k.color ?? '#c0c0c0');   // converted to linear by THREE.Color
    if (k.children) {
      set(4, k.blend || 0, 0, 0, 0);
      set(5, 0, 0, 0, 2 + (k.hole ? 1 : 0) + (k.type === 'intersect' ? 4 : 0));
      set(6, Math.min(end, count), 0, 0, 0);
      set(7, 0, 0, 0, -1);
      continue;
    }
    const m = k.inv;
    set(0, m[0], m[4], m[8], m[12]);
    set(1, m[1], m[5], m[9], m[13]);
    set(2, m[2], m[6], m[10], m[14]);
    const type = k.type === 'text' && tex.has(k) ? 10 + tex.get(k)
      : k.type === 'mesh' && vol.has(k.field) ? 20 + vol.get(k.field)
      : k.type === 'baked' && vol.has(k.field) ? 30 + vol.get(k.field)
      : ['box', 'sphere', 'cylinder', 'cone', 'torus'].indexOf(k.type);
    set(3, ...k.half, Math.max(type, 0));
    set(4, k.blend || 0, k.round || 0, k.roundAxis || 0, 0);
    set(5, tmpColor.r, tmpColor.g, tmpColor.b, k.hole ? 1 : 0);
    if ((k.type === 'mesh' || k.type === 'baked') && k.field) set(6, ...k.field.ext, k.field.cell);
    else if (k.field) set(6, k.field.w / k.field.inkW, k.field.h / k.field.inkH, k.field.inkW, k.field.inkH);
    set(7, ...(sphere ?? [0, 0, 0, -1]));
    if (k.roundAxis === 4) {
      const r = k.edges ?? Array(12).fill(k.round || 0);
      set(8, ...r.slice(0, 4));
      set(9, ...r.slice(4, 8));
      set(10, ...r.slice(8, 12));
    }
  }
  nodeTexture.needsUpdate = true;
  u.uCount.value = count;
  for (const [k, slot] of textSlots(ko)) u[`uT${slot}`].value = fieldTexture(k.field);
  for (const [f, slot] of meshSlots(ko)) u[`uV${slot}`].value = meshTexture(f);
}

function updateUniforms(sceneChanged) {
  if (sceneChanged) updateSceneUniforms();
  const u = quad.material.uniforms;
  u.uLit.value.set(...theme.lit);
  u.uSpec.value.set(...theme.spec, 0);
  u.uBands.value.set(theme.bands, theme.dither);
  u.uGridA.value.w = gridValid ? 1 : 0;
  u.uMaxSteps.value = RENDER_MODES[renderQ].steps;
  u.uPix.value = 2 * Math.tan(deg(camera.fov) / 2) / Math.max(renderer.getDrawingBufferSize(bufSize).y, 1);
  tmpColor.set(theme.rim[0]);
  u.uRim.value.set(tmpColor.r, tmpColor.g, tmpColor.b, theme.rim[1]);
}

// Selection silhouette: selected proxies are drawn white into a mask, then a thin edge is drawn
// around the mask on top of the frame.
const maskTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const edgeScene = new THREE.Scene(), edgeCam = new THREE.Camera();
const edgeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { uMask: { value: maskTarget.texture }, uTexel: { value: new THREE.Vector2() }, uWidth: { value: 1 }, uEdge: { value: new THREE.Color(0xff00ff) } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMask; uniform vec2 uTexel; uniform float uWidth; uniform vec3 uEdge;
    varying vec2 vUv;
    void main() {
      if (texture2D(uMask, vUv).r > 0.5) discard;
      float m = 0.0;
      for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
        vec2 o = vec2(x, y);
        if (max(abs(o.x), abs(o.y)) <= uWidth) m = max(m, texture2D(uMask, vUv + o * uTexel).r);
      }
      if (m < 0.5) discard;
      gl_FragColor = vec4(uEdge, 1.0);
    }`,
  depthTest: false, depthWrite: false,
}));
edgeQuad.frustumCulled = false;
edgeScene.add(edgeQuad);
const bufSize = new THREE.Vector2(), clearColor = new THREE.Color();
const ascii = createAscii(renderer);
const overlay = new THREE.Scene();   // the gizmo, drawn after the ASCII pass so it stays readable

function renderSelectionOutline() {
  if (![...views.values()].some(v => v.outline?.visible || v.goutline?.visible)) return;
  renderer.getDrawingBufferSize(bufSize);
  maskTarget.setSize(bufSize.x, bufSize.y);
  edgeQuad.material.uniforms.uTexel.value.set(1 / bufSize.x, 1 / bufSize.y);
  edgeQuad.material.uniforms.uWidth.value = theme.edge ?? (pixelRatio() <= PIXEL_RATIO ? 1 : 2);
  edgeQuad.material.uniforms.uEdge.value.set(theme.outline);
  const clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(clearColor);
  renderer.setClearColor(0x000000);
  camera.layers.set(SEL_LAYER);
  scene.overrideMaterial = maskMat;
  renderer.setRenderTarget(maskTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  camera.layers.set(0);
  renderer.setClearColor(clearColor, clearAlpha);
  renderer.autoClear = false;
  renderer.render(edgeScene, edgeCam);
  renderer.autoClear = true;
}

let frameQueued = false, sceneDirty = true;
/** Redraw after anything but a camera move: the object uniforms are rebuilt from the views. */
function render() {
  placeEdgeHelper();
  sceneDirty = true;
  scheduleBake();
  queueFrame();
}
function queueFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    updateClipPlanes();
    camera.updateMatrixWorld();
    updateUniforms(sceneDirty);
    sceneDirty = false;
    if (theme.ascii) {
      ascii.render(scene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, camera);
      renderer.autoClear = true;
    } else renderer.render(scene, camera);
    renderSelectionOutline();
  });
}

// Baked distance field of the scene: while the scene is still, the ray-marcher leaps through empty space
// with one texture fetch per step and only evaluates the shapes near a surface. Rebuilt a moment after
// the last change (and unused until then); the cell size follows the scene so it always has <= 64 cells
// on its longest side.
const GRID_CELLS = 64;
const bakeScene = new THREE.Scene(), bakeCam = new THREE.Camera();
const bakeQuad = new THREE.Mesh(quad.geometry);
bakeQuad.frustumCulled = false;
bakeScene.add(bakeQuad);
let grid = null, gridValid = false, bakeTimer = 0;

function scheduleBake(delay = 150) {
  gridValid = false;
  clearTimeout(bakeTimer);
  bakeTimer = setTimeout(bakeGrid, delay);
}

function bakeGrid() {
  if (shaderPending || !quad.material.isShaderMaterial) return;   // the swap redraws, which schedules again
  if (sceneDirty) return scheduleBake(50);                      // uniforms not written yet
  const u = quad.material.uniforms;
  const size = new THREE.Vector3().subVectors(u.uBMax.value, u.uBMin.value);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return;
  const cell = Math.max(size.x, size.y, size.z) / GRID_CELLS;
  const dims = size.toArray().map(v => Math.max(Math.ceil(v / cell), 2));
  if (!grid || grid.dims.some((v, i) => v !== dims[i])) {
    grid?.target.dispose();
    // The 3D target ignores texture options in its constructor, so they are set on the texture.
    const target = new THREE.WebGL3DRenderTarget(dims[0], dims[1], dims[2], { depthBuffer: false });
    Object.assign(target.texture, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    grid = { dims, target };
  }
  u.uGridB.value.set(...dims, cell);
  u.uCap.value = cell * 24;
  u.uGridA.value.set(dims[0] * cell, dims[1] * cell, dims[2] * cell, 0);
  u.uGrid.value = grid.target.texture;
  bakeQuad.material = quad.material;
  const previous = renderer.getRenderTarget();
  for (let z = 0; z < dims[2]; z++) {
    u.uBake.value = z + 1;
    renderer.setRenderTarget(grid.target, z);
    renderer.render(bakeScene, bakeCam);
  }
  renderer.setRenderTarget(previous);
  u.uBake.value = 0;
  u.uCap.value = 1e10;
  gridValid = true;
  queueFrame();
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}
new ResizeObserver(resize).observe(view);

function togglePixel() {
  pixelMode = !pixelMode;
  try { localStorage.setItem(PIXEL_KEY, pixelMode ? '1' : '0'); } catch { /* storage unavailable */ }
  renderer.setPixelRatio(pixelRatio());
  document.getElementById('btn-pixel').classList.toggle('active', pixelMode);
  resize();
}
function cycleRenderQuality() {
  renderQ = RENDER_ORDER[(RENDER_ORDER.indexOf(renderQ) + 1) % RENDER_ORDER.length];
  try { localStorage.setItem(QUALITY_KEY, renderQ); } catch { /* storage unavailable */ }
  showRenderQuality();
  renderer.setPixelRatio(pixelRatio());
  resize();
  status(`Qualità vista: ${RENDER_MODES[renderQ].label} (${RENDER_MODES[renderQ].tip})`);
}
function showRenderQuality() {
  const b = document.getElementById('btn-quality');
  b.textContent = `GPU: ${RENDER_MODES[renderQ].label}`;
  b.title = 'Clic per cambiare: ' + RENDER_ORDER.map(k => `${RENDER_MODES[k].label.toUpperCase()} (${RENDER_MODES[k].tip})`).join(', ') + ' (V)';
}
orbit.addEventListener('change', () => { bumpInteraction(); queueFrame(); });

let interactTimer = 0;
/** Render at reduced resolution while moving, and sharpen again 180 ms after the last movement. */
function bumpInteraction() {
  const set = on => {
    const before = pixelRatio();
    interacting = on;
    if (pixelRatio() === before) return;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(view.clientWidth, view.clientHeight, false);
    queueFrame();
  };
  set(true);
  clearTimeout(interactTimer);
  interactTimer = setTimeout(() => set(false), 180);
}

// ---------------------------------------------------------------- view presets

// Camera direction from the orbit target, Z-up. Top/bottom lean slightly toward -Y so the roll is defined.
const VIEW_DIRS = {
  front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
  top: [0, -1e-4, 1], bottom: [0, -1e-4, -1],
};
// True isometric corners (equal angles to all three axes), cycled by repeated clicks.
const ISO_CORNERS = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
const isoStep = { iso: -1, isobot: -1 };
function setView(name) {
  let d = VIEW_DIRS[name];
  if (!d) {
    const i = isoStep[name] = (isoStep[name] + 1) % ISO_CORNERS.length;
    d = [...ISO_CORNERS[i], name === 'iso' ? 1 : -1];
  }
  const dist = camera.position.distanceTo(orbit.target);
  camera.position.copy(orbit.target).addScaledVector(new THREE.Vector3(...d).normalize(), dist);
  orbit.update();
  render();
}

// "Orthographic" is a perspective camera with a tiny field of view, pulled back so the framing stays the
// same: parallel lines stay parallel, and picking, the ray-marcher and the gizmo need no second camera.
const FOV_PERSP = 40, FOV_ORTHO = 1.5;
let ortho = false;

/**
 * Keep the depth range tight around the scene. The orthographic camera sits ~27x farther away, where a
 * 1 mm near plane would leave the depth buffer millimetres of precision (grid, ghosts and gizmo flicker).
 */
function updateClipPlanes() {
  const dist = camera.position.distanceTo(orbit.target);
  const near = ortho ? dist / 2 : 1, far = Math.max(100000, dist * 2);
  if (camera.near === near && camera.far === far) return;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}
function setOrtho(on) {
  const t = fov => Math.tan(deg(fov) / 2);
  const from = camera.fov, to = on ? FOV_ORTHO : FOV_PERSP;
  const dist = camera.position.distanceTo(orbit.target) * t(from) / t(to);
  camera.position.sub(orbit.target).setLength(dist).add(orbit.target);
  camera.fov = to;
  camera.updateProjectionMatrix();
  ortho = on;
  const btn = document.getElementById('btn-ortho');
  btn.textContent = on ? 'Ortog.' : 'Prosp.';
  btn.classList.toggle('active', on);
  orbit.update();
  render();
}
document.getElementById('btn-ortho').onclick = () => setOrtho(!ortho);
for (const b of document.querySelectorAll('#viewcube [data-view]')) b.onclick = () => setView(b.dataset.view);

// ---------------------------------------------------------------- transform gizmo

const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.9);
scene.add(transform);
transform.addEventListener('change', () => { bumpInteraction(); render(); });
transform.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (!e.value) commitGizmo();
});
transform.addEventListener('mouseDown', beginScaleDrag);
transform.addEventListener('objectChange', () => {
  if (pivotMode) previewPivotDrag();
  else if (transform.mode === 'scale') { applyOneSidedScale(); keepImageAspect(); }
  updatePanelValues();
});

/** An image with locked proportions scales X and Y together, whichever of them is dragged. */
function keepImageAspect() {
  const o = selected(), g = transform.object, axis = transform.axis;
  if (!o || !isImage(o) || !o.keepAspect || !axis) return;
  const f = axis.includes('X') ? g.scale.x : axis.includes('Y') ? g.scale.y : null;
  if (f !== null) g.scale.x = g.scale.y = f;
}

// Shift while scaling: the dragged face follows the pointer and the opposite face stays put.
let shiftHeld = false;
for (const t of ['keydown', 'keyup']) window.addEventListener(t, e => { shiftHeld = e.shiftKey; });
window.addEventListener('pointermove', e => { shiftHeld = e.shiftKey; }, true);

const scaleDrag = { pos: new THREE.Vector3(), scale: new THREE.Vector3(), box: new THREE.Box3(), qInv: new THREE.Quaternion() };

/** Remember the pose and local bounding box of the object as a scale drag starts. */
function beginScaleDrag() {
  const g = transform.object;
  if (!g || transform.mode !== 'scale') return;
  g.updateMatrixWorld(true);
  scaleDrag.pos.copy(g.position);
  scaleDrag.scale.copy(g.scale);
  scaleDrag.qInv.copy(transform.worldQuaternionStart).invert();
  scaleDrag.box.copy(localBox(g));
}

/** Bounding box of every shape proxy under a three.js group, in that group's own frame. */
function localBox(g) {
  g.updateMatrixWorld(true);
  const toLocal = g.matrixWorld.clone().invert(), b = new THREE.Box3(), box = new THREE.Box3();
  g.traverse(m => {
    if (!m.isMesh || !m.userData.id) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(b.copy(m.geometry.boundingBox).applyMatrix4(toLocal.clone().multiply(m.matrixWorld)));
  });
  return box;
}

/**
 * Box around what a group actually produces, in its own frame: holes add nothing, a union is the box
 * of its solid parts and an intersection only the box they share, so the outline hugs the result
 * rather than every part it is made from.
 */
function resultBox(g) {
  const root = views.get(g.id).group;
  root.updateMatrixWorld(true);
  const toLocal = root.matrixWorld.clone().invert(), b = new THREE.Box3();
  const parts = o => {
    if (o.hole) return [];
    if (isImage(o)) return [];
    if (!isGroup(o)) {
      const m = views.get(o.id).mesh;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      return [b.copy(m.geometry.boundingBox).applyMatrix4(toLocal.clone().multiply(m.matrixWorld)).clone()];
    }
    const sub = childrenOf(o.id).flatMap(parts);
    if (o.mode === 'group' || !sub.length) return sub;
    return [combine(sub, o.mode)];
  };
  const combine = (boxes, mode) => boxes.reduce((a, c) => mode === 'intersect' ? a.intersect(c) : a.union(c));
  const own = childrenOf(g.id).flatMap(parts);
  return own.length ? combine(own, g.mode) : new THREE.Box3();
}

/** Rework the gizmo's symmetric scale into a one-sided one while Shift is held. */
function applyOneSidedScale() {
  const g = transform.object, axis = transform.axis;
  g.position.copy(scaleDrag.pos);   // the gizmo never moves the object in scale mode
  if (!shiftHeld || !axis || scaleDrag.box.isEmpty()) return;
  const start = transform.pointStart.clone().applyQuaternion(scaleDrag.qInv);
  const delta = transform.pointEnd.clone().applyQuaternion(scaleDrag.qInv).sub(start);
  const shift = new THREE.Vector3();
  ['x', 'y', 'z'].forEach((c, i) => {
    if (!axis.includes(c.toUpperCase())) return;
    const side = start[c] < 0 ? -1 : 1;   // which face was grabbed
    const s0 = scaleDrag.scale[c], len = (scaleDrag.box.max[c] - scaleDrag.box.min[c]) * s0;
    if (len <= 0) return;
    // Uniform (XYZ) keeps the gizmo's factor; single axes and planes follow the pointer exactly.
    const f = axis === 'XYZ' ? Math.max(g.scale[c] / s0, 0.01) : Math.max(len + side * delta[c], 0.1) / len;
    g.scale.setComponent(i, s0 * f);
    const anchor = side > 0 ? scaleDrag.box.min[c] : scaleDrag.box.max[c];
    shift.setComponent(i, anchor * (s0 - g.scale[c]));
  });
  g.position.add(shift.applyQuaternion(g.quaternion));
}

/** Gizmo mode: 'translate' | 'rotate' | 'scale', or 'pivot' (a move that only shifts the pivot). */
function setMode(mode) {
  pivotMode = mode === 'pivot';
  transform.setMode(pivotMode ? 'translate' : mode);
  if (pivotMode) status('Perno: trascina il gizmo per spostare il punto di rotazione e scala; la forma resta ferma.');
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  render();
}

/** Move / rotate along the world axes or the object's own. Scale is always local (world would shear). */
function setSpace(space) {
  gizmoSpace = space;
  transform.setSpace(space);
  try { localStorage.setItem(SPACE_KEY, space); } catch { /* storage unavailable */ }
  const b = document.getElementById('btn-space');
  b.textContent = space === 'world' ? 'Globale' : 'Locale';
  b.classList.toggle('active', space === 'local');
  render();
}

function applySnap() {
  const v = parseFloat(document.getElementById('snap').value);
  transform.setTranslationSnap(v > 0 ? v : null);
  transform.setRotationSnap(v > 0 ? deg(15) : null);
}

/** Bake the gizmo's position / rotation / scale back into the selected object's data. */
function commitGizmo() {
  const o = selected();
  if (!o) return;
  const { group } = views.get(o.id);
  if (pivotMode) {
    shiftPivot(o, pivotDragDelta(o).toArray());
    syncAll();
    commit();
    return;
  }
  o.pos = group.position.toArray().map(round3);
  o.rot = [group.rotation.x, group.rotation.y, group.rotation.z].map(r => round3(rad2deg(r)));
  if (isGroup(o)) bakeScale(o, group.scale.clone());
  else scaleShape(o, group.scale);
  syncAll();
  commit();
}

/** Scale a shape's size by s; the pivot keeps its place relative to the shape (it scales around it). */
function scaleShape(o, s) {
  o.size = o.size.map((v, i) => round3(Math.max(Math.abs(v * s.getComponent(i)), 0.1)));
  o.pivot = o.pivot.map((v, i) => round3(v * s.getComponent(i)));
  if (isImage(o)) o.size[2] = SHAPES.image.size[2];   // a picture has no thickness
}

// ---------------------------------------------------------------- pivot

/**
 * The pivot relative to the object's centre and the half extents around that centre, both in the
 * object's local frame (mm), read from the live view. A group's centre is the middle of its parts.
 */
function pivotInfo(o) {
  const { group, mesh } = views.get(o.id);
  if (mesh) {
    return {
      pivot: mesh.position.clone().multiply(group.scale).negate().toArray(),
      half: o.size.map((v, i) => Math.abs(v * group.scale.getComponent(i)) / 2),
    };
  }
  const b = localBox(group);
  if (b.isEmpty()) return { pivot: [0, 0, 0], half: [0, 0, 0] };
  return {
    pivot: b.getCenter(new THREE.Vector3()).negate().toArray(),
    half: b.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray(),
  };
}

/** Move o's pivot by d (local frame, mm) without moving the object itself. */
function shiftPivot(o, d) {
  const w = new THREE.Vector3(...d).applyEuler(new THREE.Euler(...o.rot.map(deg)));
  o.pos = o.pos.map((v, i) => round3(v + w.getComponent(i)));
  if (isGroup(o)) for (const c of childrenOf(o.id)) c.pos = c.pos.map((v, i) => round3(v - d[i]));
  else o.pivot = o.pivot.map((v, i) => round3(v + d[i]));
}

/** Put the pivot at the centre (side 0) or on the − / + face (side -1 / 1) along one local axis. */
function setPivotSide(o, axis, side) {
  const { pivot, half } = pivotInfo(o);
  const d = [0, 0, 0];
  d[axis] = side * half[axis] - pivot[axis];
  if (Math.abs(d[axis]) < 1e-4) return;
  shiftPivot(o, d);
  syncAll();
  commit();
}

/** How far the gizmo has moved the pivot during a pivot drag, in the object's local frame. */
function pivotDragDelta(o) {
  const { group } = views.get(o.id);
  return group.position.clone().sub(new THREE.Vector3(...o.pos)).applyQuaternion(group.quaternion.clone().invert());
}

/** While dragging the pivot, move the shape (or a group's parts) back so only the pivot moves. */
function previewPivotDrag() {
  const o = selected();
  if (!o) return;
  const d = pivotDragDelta(o), { mesh, outline } = views.get(o.id);
  if (mesh) {
    mesh.position.fromArray(o.pivot).add(d).negate();
    outline.position.copy(mesh.position);
  } else {
    for (const c of childrenOf(o.id)) views.get(c.id).group.position.fromArray(c.pos).sub(d);
  }
}

/**
 * Push a group's scale down into its children's positions and sizes. Exact for children
 * aligned with the group's axes; rotated children get the closest unsheared fit.
 */
function bakeScale(g, s) {
  if (s.equals(ONE)) return;
  const S = new THREE.Matrix4().makeScale(s.x, s.y, s.z);
  for (const c of childrenOf(g.id)) {
    const sc = setPose(c, localMatrix(c).premultiply(S));
    if (isGroup(c)) bakeScale(c, sc);
    else scaleShape(c, sc);
  }
}

/** An object's transform relative to its parent (no size). */
function localMatrix(o) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rot.map(deg)));
  return new THREE.Matrix4().compose(new THREE.Vector3(...o.pos), q, ONE);
}

/** Set pos / rot from a matrix; returns the matrix's leftover scale. */
function setPose(o, m) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q);
  o.pos = p.toArray().map(round3);
  o.rot = [e.x, e.y, e.z].map(r => round3(rad2deg(r)));
  return s;
}

const round3 = v => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- selection & picking

const raycaster = new THREE.Raycaster();
let downAt = null;   // left-button press, unless it grabbed the gizmo
const marquee = document.createElement('div');
marquee.id = 'marquee';
view.append(marquee);

renderer.domElement.addEventListener('pointerdown', e => {
  downAt = e.button === 0 && !transform.axis && !lay ? [e.clientX, e.clientY] : null;
  layDown = lay && e.button === 0 ? [e.clientX, e.clientY] : null;
});
renderer.domElement.addEventListener('pointerup', e => {
  if (!lay || !layDown || e.button !== 0) return;
  const [x0, y0] = layDown;
  layDown = null;
  if (Math.hypot(e.clientX - x0, e.clientY - y0) <= 4) layClick(e);
});
renderer.domElement.addEventListener('pointermove', e => {
  if (!downAt || !(e.buttons & 1)) return;
  const [x0, y0] = downAt, v = view.getBoundingClientRect();
  if (Math.hypot(e.clientX - x0, e.clientY - y0) <= 4) return;
  Object.assign(marquee.style, {
    display: 'block',
    left: `${Math.min(x0, e.clientX) - v.left}px`, top: `${Math.min(y0, e.clientY) - v.top}px`,
    width: `${Math.abs(e.clientX - x0)}px`, height: `${Math.abs(e.clientY - y0)}px`,
  });
});
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || e.button !== 0) return;
  const [x0, y0] = downAt;
  downAt = null;
  marquee.style.display = 'none';
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  if (Math.hypot(e.clientX - x0, e.clientY - y0) > 4) return boxSelect(x0, y0, e.clientX, e.clientY, additive);
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  if (pickEdge(e, additive)) return;
  raycaster.setFromCamera(ndc, camera);
  const pickables = [...views.values()].filter(v => v.mesh && !byId(v.mesh.userData.id).locked).map(v => v.mesh);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (hit) select(pickTarget(byId(hit.object.userData.id)).id, additive);
  else if (!additive) select(null);
});
renderer.domElement.addEventListener('dblclick', () => { const g = selected(); if (g && isGroup(g)) enterGroup(g); });

// ---------------------------------------------------------------- lay
//
// Lay: click a face or a vertex of one object, then a face or a vertex of another. Face on face turns the
// first object so the two faces meet flat (normals opposed) and puts the clicked points together; as soon as
// a vertex is involved the object only slides, so the two points coincide. Vertices are the corners of a
// shape's box that lie on its surface, and a click within a few pixels of one snaps to it.

let lay = null;       // null, or { src } while waiting for clicks; src is the first pick once made
let layDown = null;
const layMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false, transparent: true }));
layMarker.renderOrder = 10;
layMarker.visible = false;
scene.add(layMarker);
const VERTEX_SNAP_PX = 14;

/** First shape surface under the ray: the proxy box finds candidates, sphere tracing finds the true surface. */
function surfaceHit(ray) {
  const pickables = [...views.values()].filter(v => v.mesh && !byId(v.mesh.userData.id).locked).map(v => v.mesh);
  for (const h of raycaster.intersectObjects(pickables, false)) {
    const shape = byId(h.object.userData.id);
    const boxNormal = h.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize();
    const nodes = kernelNodes(shape).map(n => ({ ...n, hole: false, blend: 0 }));
    if (!nodes.length) return { shape, mesh: h.object, point: h.point.clone(), normal: boxNormal, corners: [] };   // image, text still loading…
    const f = compileJS(nodes), m = h.object.matrixWorld;
    const diag = new THREE.Box3().setFromObject(h.object).getSize(new THREE.Vector3()).length();
    const eps = diag * 1e-4, p = new THREE.Vector3();
    let t = h.distance, hitT = null;
    for (let i = 0; i < 300 && t < h.distance + diag; i++) {
      p.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      const d = f(p.x, p.y, p.z);
      if (d < eps) { hitT = t; break; }
      t += Math.max(d * 0.9, eps);
    }
    if (hitT === null) continue;   // the ray crosses the box but misses the shape
    const point = ray.direction.clone().multiplyScalar(hitT).add(ray.origin), e = diag * 1e-3;
    const normal = new THREE.Vector3(
      f(point.x + e, point.y, point.z) - f(point.x - e, point.y, point.z),
      f(point.x, point.y + e, point.z) - f(point.x, point.y - e, point.z),
      f(point.x, point.y, point.z + e) - f(point.x, point.y, point.z - e));
    if (normal.lengthSq() < 1e-12) normal.copy(boxNormal); else normal.normalize();
    const corners = [];
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5).applyMatrix4(m);
      if (Math.abs(f(c.x, c.y, c.z)) < diag * 0.01) corners.push(c);
    }
    return { shape, mesh: h.object, point, normal, corners, diag };
  }
  return null;
}

/** What a click at these screen coordinates would pick: a vertex if one is close, else the face under the cursor. */
function layPickAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  scene.updateMatrixWorld(true);
  raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = surfaceHit(raycaster.ray);
  if (!hit) return null;
  // Snap to the nearest corner under the cursor, if it is close in the picture and near the hit in space.
  let pick = { obj: pickTarget(hit.shape), shape: hit.shape, mesh: hit.mesh, point: hit.point, normal: hit.normal, kind: 'faccia' }, best = VERTEX_SNAP_PX;
  const p = new THREE.Vector3();
  for (const c of hit.corners) {
    p.copy(c).project(camera);
    const d = Math.hypot(r.left + (p.x + 1) / 2 * r.width - clientX, r.top + (1 - p.y) / 2 * r.height - clientY);
    if (d < best && c.distanceTo(hit.point) < hit.diag * 0.35) { best = d; pick = { ...pick, point: c.clone(), normal: null, kind: 'vertice' }; }
  }
  return pick;
}

// What the cursor is over while Lay waits: a translucent face (the whole flat side of a box, else a disc
// at the point) or a larger dot on a vertex.
const LAY_COLOR = 0xffd400;
const layHoverMat = (opacity = 0.4) => new THREE.MeshBasicMaterial({ color: LAY_COLOR, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide });
const layHover = new THREE.Group();
const layQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), layHoverMat());
const layQuadEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: LAY_COLOR, depthTest: false }));
const layDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 32), layHoverMat());
const layVertex = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), layHoverMat(1));
layHover.add(layQuad, layQuadEdge, layDisc, layVertex);
layHover.renderOrder = 9;
layHover.traverse(o => { o.renderOrder = 9; o.matrixAutoUpdate = false; });
layHover.visible = false;
scene.add(layHover);

/** Matrix of the proxy-box face the pick lies on (unit square, in world space), or null if it is not on a flat box side. */
function boxFaceMatrix(pick) {
  const m = pick.mesh.matrixWorld, lp = pick.point.clone().applyMatrix4(m.clone().invert());
  for (let a = 0; a < 3; a++) {
    if (Math.abs(Math.abs(lp.getComponent(a)) - 0.5) > 0.002) continue;
    const s = Math.sign(lp.getComponent(a)), axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    axes[a].setComponent(a, s);
    axes[(a + 1) % 3].setComponent((a + 1) % 3, 1);
    axes[(a + 2) % 3].setComponent((a + 2) % 3, 1);
    const [u, v, w] = [axes[(a + 1) % 3], axes[(a + 2) % 3], axes[a]];
    const n = w.clone().transformDirection(m);
    if (Math.abs(n.dot(pick.normal)) < 0.999) continue;   // rounded or curved here: not the box's flat side
    const basis = new THREE.Matrix4().makeBasis(u, v, w).setPosition(w.clone().multiplyScalar(0.5));
    return m.clone().multiply(basis);
  }
  return null;
}

function layShowHover(pick) {
  layHover.visible = !!pick;
  if (pick) {
    const dist = camera.position.distanceTo(pick.point);
    const face = pick.kind === 'faccia' && boxFaceMatrix(pick);
    layQuad.visible = layQuadEdge.visible = !!face;
    layDisc.visible = pick.kind === 'faccia' && !face;
    layVertex.visible = pick.kind === 'vertice';
    if (face) layQuad.matrix.copy(face), layQuadEdge.matrix.copy(face);
    if (layDisc.visible) {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), pick.normal);
      layDisc.matrix.compose(pick.point.clone().addScaledVector(pick.normal, dist * 0.0005), q, new THREE.Vector3().setScalar(dist * 0.03));
    }
    if (layVertex.visible) layVertex.matrix.makeScale(dist * 0.014, dist * 0.014, dist * 0.014).setPosition(pick.point);
    layHover.traverse(o => o.matrixWorldNeedsUpdate = true);
    layHover.children.forEach(o => o.matrixWorld.copy(o.matrix));
  }
  render();
}

let layHoverQueued = null;
renderer.domElement.addEventListener('pointermove', e => {
  if (!lay || e.buttons) return;
  layHoverQueued = [e.clientX, e.clientY];
  requestAnimationFrame(() => {
    if (!layHoverQueued || !lay) return;
    const [x, y] = layHoverQueued;
    layHoverQueued = null;
    layShowHover(layPickAt(x, y));
  });
});

function layClick(e) {
  const pick = layPickAt(e.clientX, e.clientY);
  if (!pick) return status('Lay: clicca su una forma.');
  if (!lay.src) {
    lay.src = pick;
    layMarker.position.copy(pick.point);
    layMarker.scale.setScalar(camera.position.distanceTo(pick.point) * 0.008);
    layMarker.visible = true;
    render();
    return status(`Lay: ${pick.kind} di «${pick.obj.name}» scelta. Ora clicca una faccia o un vertice di un'altra forma. Esc annulla.`);
  }
  const src = lay.src;
  if (pick.obj === src.obj || ancestors(pick.shape).includes(src.obj)) return status('Lay: scegli un\'altra forma come destinazione.');
  layApply(src, pick);
  layExit();
}

/** Move the first pick's object so its point lands on the target's, turning it flat when both are faces. */
function layApply(s, t) {
  const o = s.obj, { group } = views.get(o.id);
  group.updateMatrixWorld(true);
  const q = new THREE.Quaternion();
  if (s.normal && t.normal) q.setFromUnitVectors(s.normal, t.normal.clone().negate());
  const world = new THREE.Matrix4().makeTranslation(t.point.x, t.point.y, t.point.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-s.point.x, -s.point.y, -s.point.z))
    .multiply(group.matrixWorld);
  setPose(o, group.parent.matrixWorld.clone().invert().multiply(world));
  syncView(o);
  commit();
  status(`«${o.name}» appoggiato: ${s.kind} su ${t.kind} di «${t.obj.name}».`);
}

function layEnter() {
  lay = { src: null };
  transform.detach();
  renderer.domElement.style.cursor = 'crosshair';
  document.getElementById('btn-lay').classList.add('active');
  status('Lay: clicca la faccia o il vertice da appoggiare. Esc annulla.');
  render();
}

function layExit() {
  lay = layDown = null;
  layMarker.visible = layHover.visible = false;
  renderer.domElement.style.cursor = '';
  document.getElementById('btn-lay').classList.remove('active');
  setSelection(selectedIds);   // brings the gizmo back
}
document.getElementById('btn-lay').onclick = () => lay ? layExit() : layEnter();

/** Screen rectangle [x0, y0, x1, y1] covered by a shape's box, or null if it is behind the camera. */
function screenRect(mesh) {
  const r = renderer.domElement.getBoundingClientRect(), p = new THREE.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5).applyMatrix4(mesh.matrixWorld).project(camera);
    if (p.z > 1) return null;
    const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * Select everything the dragged rectangle touches, at the level of the current selection
 * (inside the open group), or at the top level if nothing there is touched.
 */
function boxSelect(ax, ay, bx, by, additive) {
  const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)], [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
  scene.updateMatrixWorld();
  const touched = objects.filter(o => {
    const mesh = !o.locked && views.get(o.id)?.mesh, s = mesh && screenRect(mesh);
    return s && s[0] <= x1 && s[2] >= x0 && s[1] <= y1 && s[3] >= y0;
  });
  // The ancestor (or self) of each touched shape that is a child of `level`.
  const atLevel = level => [...new Set(touched.map(o => [...ancestors(o), o].find(x => parentOf(x) === level))
    .filter(Boolean).map(x => x.id))];
  const cur = byId(selectedIds[0]);
  let ids = cur ? atLevel(parentOf(cur)) : [];
  if (!ids.length && !(additive && cur)) ids = atLevel(null);
  if (additive && cur) ids = [...new Set([...selectedIds, ...ids])];
  setSelection(ids);
}

/**
 * What a click on a shape selects: its outermost group, unless that group is open (being edited), in
 * which case the item directly inside the open group.
 */
function pickTarget(shape) {
  const open = openIds();
  return [...ancestors(shape), shape].find(x => !open.has(x.id));
}

/** Open a group for editing: its parts become visible in the list and pickable in the view. */
function enterGroup(g) {
  const kids = childrenOf(g.id);
  if (kids.length) setSelection(kids.map(c => c.id));
  status(`Modifichi i pezzi di «${g.name}». Esc per uscire.`);
}

/** Close the open group (or, from a selection inside it, select the group itself). */
function exitGroup() {
  if (selectedIds.length) return select(parentOf(byId(selectedIds[0])));
  const g = byId(entered);
  entered = g ? parentOf(g) : null;
  objects.forEach(syncView);
  updateOutlines(); renderPanel(); renderList(); render();
}

/** Select one object, or with `toggle` add / remove it from the selection (siblings only). */
function select(id, toggle = false) {
  if (!toggle) return setSelection(id == null ? [] : [id]);
  if (id == null) return;
  if (selectedIds.includes(id)) return setSelection(selectedIds.filter(x => x !== id));
  const first = byId(selectedIds[0]);
  setSelection(first && parentOf(first) === parentOf(byId(id)) ? [...selectedIds, id] : [id]);
}

function setSelection(ids) {
  selectedIds = ids.filter(byId);
  edgeSel = [];
  const before = entered;
  // Whatever is selected sets the level being edited; an empty selection stays where it was.
  if (selectedIds.length) entered = parentOf(byId(selectedIds[0]));
  else if (entered != null && !byId(entered)) entered = null;
  if (entered !== before) { objects.forEach(syncView); sceneDirty = true; }   // an open group is drawn live, a folded one baked
  updateOutlines();
  const o = selected();
  if (o) transform.attach(views.get(o.id).group);
  else transform.detach();
  renderPanel();
  renderList();
  queueFrame();   // selecting does not change the solid: keep the baked grid
}

// ---------------------------------------------------------------- per-edge rounding

// A box in "Singoli" mode shows its 12 edges as lines you can click; edgeSel holds the chosen ones.
// Edge e runs along axis c = e >> 2; its corner s = e & 3 (bit 0: negative along axis c+1, bit 1: along c+2).
let edgeSel = [];
const EDGE_PTS = Array.from({ length: 12 }, (_, e) => {
  const c = e >> 2, s = e & 3, a = (c + 1) % 3, b = (c + 2) % 3;
  const p = [0, 0, 0];
  p[a] = s & 1 ? -0.5 : 0.5;
  p[b] = s & 2 ? -0.5 : 0.5;
  const q = [...p];
  p[c] = -0.5; q[c] = 0.5;
  return [p, q];
});
const edgeColors = new Float32Array(12 * 2 * 3);
const edgeHelper = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
  vertexColors: true, depthTest: false, depthWrite: false, transparent: true,
}));
edgeHelper.geometry.setAttribute('position', new THREE.Float32BufferAttribute(EDGE_PTS.flat(2), 3));
edgeHelper.geometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
edgeHelper.renderOrder = 10;
edgeHelper.frustumCulled = false;
edgeHelper.visible = false;
const EDGE_IDLE = new THREE.Color(0x8794a8), EDGE_ON = new THREE.Color(0xffd23f);

const editingEdges = o => o && o.type === 'box' && o.roundAxis === 4;

/** Show the edge lines on the selected box when it is in per-edge mode, hide them otherwise. */
function updateEdgeHelper() {
  const o = selected();
  if (!editingEdges(o)) { edgeHelper.visible = false; edgeHelper.removeFromParent(); return; }
  views.get(o.id).group.add(edgeHelper);
  edgeHelper.visible = true;
  for (let e = 0; e < 12; e++) {
    const col = edgeSel.includes(e) ? EDGE_ON : EDGE_IDLE;
    for (let v = 0; v < 2; v++) col.toArray(edgeColors, (e * 2 + v) * 3);
  }
  edgeHelper.geometry.attributes.color.needsUpdate = true;
  placeEdgeHelper();
}

function placeEdgeHelper() {
  const o = selected();
  if (!edgeHelper.visible || !editingEdges(o) || !views.has(o.id)) return;
  const { mesh } = views.get(o.id);
  edgeHelper.position.copy(mesh.position);
  edgeHelper.scale.copy(mesh.scale);
}

/** A click near one of the box's edge lines (in pixels) picks it; Shift / Cmd / Ctrl adds to the choice. */
function pickEdge(ev, additive) {
  const o = selected();
  if (!edgeHelper.visible || !editingEdges(o)) return false;
  scene.updateMatrixWorld();
  const r = renderer.domElement.getBoundingClientRect();
  const px = new THREE.Vector3(), best = { e: -1, d: 10 };
  const toScreen = p => {
    px.set(...p).applyMatrix4(edgeHelper.matrixWorld).project(camera);
    return [(px.x + 1) / 2 * r.width + r.left, (1 - px.y) / 2 * r.height + r.top, px.z];
  };
  EDGE_PTS.forEach(([p, q], e) => {
    const [ax, ay, az] = toScreen(p), [bx, by, bz] = toScreen(q);
    if (az > 1 || bz > 1) return;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(Math.max(((ev.clientX - ax) * dx + (ev.clientY - ay) * dy) / len2, 0), 1) : 0;
    const d = Math.hypot(ev.clientX - (ax + t * dx), ev.clientY - (ay + t * dy));
    if (d < best.d) { best.e = e; best.d = d; }
  });
  if (best.e < 0) return false;
  const on = edgeSel.includes(best.e);
  edgeSel = additive ? (on ? edgeSel.filter(x => x !== best.e) : [...edgeSel, best.e]) : on && edgeSel.length === 1 ? [] : [best.e];
  updateEdgeHelper();
  updateEdgeRow();
  queueFrame();
  return true;
}

/** Point the radius inputs at the chosen edges: their first radius, disabled while none is chosen. */
function updateEdgeRow() {
  const o = selected();
  if (!editingEdges(o)) return;
  document.querySelectorAll('#props [data-edge-r]').forEach(input => {
    input.disabled = !edgeSel.length;
    input.value = edgeSel.length ? round3(o.edges[edgeSel[0]]) : 0;
  });
}

function wireEdgeRows(el, o) {
  if (!editingEdges(o)) return;
  const choose = ids => { edgeSel = ids; updateEdgeHelper(); updateEdgeRow(); queueFrame(); };
  el.querySelector('#edge-all').onclick = () => choose([...Array(12).keys()]);
  el.querySelector('#edge-none').onclick = () => choose([]);
  el.querySelectorAll('[data-edge-r]').forEach(input => {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || !edgeSel.length) return;
      const r = Math.min(Math.max(v, 0), round3(maxRound(o)));
      o.edges ??= Array(12).fill(o.round);
      for (const e of edgeSel) o.edges[e] = r;
      el.querySelectorAll('[data-edge-r]').forEach(other => { if (other !== input) other.value = r; });
      render();
    });
    input.addEventListener('change', () => { updateEdgeRow(); commit(); });
  });
  updateEdgeRow();
}

// ---------------------------------------------------------------- commands

function addShape(type, hole = false) {
  const def = SHAPES[type];
  const count = objects.filter(o => o.type === type).length + 1;
  const o = {
    id: nextId++,
    name: `${hole ? 'Foro ' + def.label.toLowerCase() : def.label} ${count}`,
    type,
    color: PALETTE[(objects.length) % PALETTE.length],
    hole,
    pos: [0, 0, def.size[2] / 2],
    rot: [0, 0, 0],
    size: [...def.size],
    pivot: [0, 0, 0],
    round: 0, roundAxis: 0,
    blend: 0,
  };
  if (type === 'text') {
    Object.assign(o, { text: 'Testo', font: DEFAULT_FONT, bold: false, italic: false, align: 'center' });
    o.ink = def.size.slice(0, 2).map(v => v / TEXT_EM);
    fitText(o);
  }
  objects.push(o);
  createView(o, scene);
  select(o.id);
  commit();
  if (type === 'text') {
    // Ready to type over the placeholder.
    const box = document.querySelector('#props textarea[data-key=text]');
    box?.focus();
    box?.select();
  }
}

/**
 * Resize a text object to fit its current letters at the same letter size (mm per em), around its
 * pivot. Returns true if the size changed. If the font is still loading this happens once it arrives.
 */
function fitText(o) {
  const f = textField(o, disposeField);
  if (!f) {
    if (!fontReady(o)) loadFont(o).then(() => { if (objects.includes(o) && fitText(o)) { syncView(o); commit(); } });
    return false;
  }
  const ink = [f.inkW / f.em, f.inkH / f.em];
  const s = new THREE.Vector3(ink[0] / o.ink[0], ink[1] / o.ink[1], 1);
  o.ink = ink;
  if (Math.abs(s.x - 1) < 1e-6 && Math.abs(s.y - 1) < 1e-6) return false;
  scaleShape(o, s);
  return true;
}

/**
 * Read a PNG / JPEG into `images`, redrawn through a canvas (so camera rotation tags are applied and the
 * longest side is at most IMAGE_MAX px), plus a small thumbnail for the object list. Returns its key.
 */
async function storeImage(file) {
  const bmp = await createImageBitmap(file);
  const draw = (k, type) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return [c.toDataURL(type, 0.92), c.width, c.height];
  };
  const [src, w, h] = draw(Math.min(1, IMAGE_MAX / Math.max(bmp.width, bmp.height)), file.type);
  const [thumb] = draw(Math.min(1, 48 / Math.max(bmp.width, bmp.height)), 'image/png');
  bmp.close();
  const key = `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  images.set(key, { src, w, h, thumb });
  return key;
}

/** Add PNG / JPEG files as reference images lying on the workplane, centred at `at` (world x / y) or the origin. */
async function importImages(files, at = null) {
  files = [...files].filter(f => IMAGE_TYPES.includes(f.type));
  if (!files.length) { status('Formato non supportato: usa immagini PNG o JPEG.'); return; }
  const added = [];
  for (const file of files) {
    let key;
    try { key = await storeImage(file); } catch (err) { status(`Impossibile leggere ${file.name}: ${err.message}`); continue; }
    const { w, h } = images.get(key), width = SHAPES.image.size[0], n = added.length * 10;
    const o = {
      id: nextId++,
      name: file.name.replace(/\.[^.]+$/, '') || `${SHAPES.image.label} ${objects.filter(isImage).length + 1}`,
      type: 'image', img: key, color: '#ffffff', hole: false, parent: null,
      pos: [round3((at?.x ?? 0) + n), round3((at?.y ?? 0) - n), IMAGE_LIFT],
      rot: [0, 0, 0],
      size: [width, round3(width * h / w), SHAPES.image.size[2]],
      pivot: [0, 0, 0], round: 0, roundAxis: 0, blend: 0,
      opacity: 100, keepAspect: true, onTop: false, locked: false,
    };
    objects.push(o);
    createView(o, scene);
    added.push(o.id);
  }
  if (!added.length) return;
  setSelection(added);
  commit();
  status(`${added.length === 1 ? 'Immagine importata' : `${added.length} immagini importate`}: solo riferimento, non entra nell'STL.`);
}

/** Gzip bytes and return them as base64 (for saving a mesh field inside JSON). */
async function gzipBase64(bytes) {
  const z = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let bin = '';
  for (let i = 0; i < z.length; i += 0x8000) bin += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gunzipBase64(b64) {
  const bin = atob(b64), z = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) z[i] = bin.charCodeAt(i);
  return new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** A saved mesh entry back to a field: half floats for the GPU, floats for the exporter. */
async function decodeMesh(m) {
  const half = new Uint16Array(await gunzipBase64(m.src));
  if (half.length !== m.w * m.h * m.d) throw new Error('dati incompleti');
  const data = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) data[i] = THREE.DataUtils.fromHalfFloat(half[i]);
  return { data, half, w: m.w, h: m.h, d: m.d, cell: m.cell, ext: m.ext, tris: m.tris };
}

/** Read an STL into `meshes` (and its decoded field into meshFields). Returns its key. */
async function storeMesh(file) {
  const f = buildMeshField(parseSTL(await file.arrayBuffer()));
  // Stored as half floats, like the text fields on the GPU, and read back from them so the preview,
  // the exporter and a reopened project all see exactly the same numbers.
  f.half = new Uint16Array(f.data.length);
  for (let i = 0; i < f.data.length; i++) {
    f.half[i] = THREE.DataUtils.toHalfFloat(f.data[i]);
    f.data[i] = THREE.DataUtils.fromHalfFloat(f.half[i]);
  }
  const src = await gzipBase64(new Uint8Array(f.half.buffer));
  const key = `mesh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  meshes.set(key, { tris: f.tris, w: f.w, h: f.h, d: f.d, cell: f.cell, ext: f.ext, src });
  meshFields.set(key, f);
  return key;
}

/** Add STL files as solids resting on the workplane, centred at `at` (world x / y) or the origin. */
async function importMeshes(files, at = null) {
  files = [...files].filter(isSTL);
  if (!files.length) return;
  const added = [];
  showBusy('Importa STL', 'Conversione del modello…');
  try {
    for (const file of files) {
      await new Promise(r => setTimeout(r, 30));   // let the overlay paint before the blocking work
      let key;
      try { key = await storeMesh(file); } catch (err) { status(`Impossibile leggere ${file.name}: ${err.message}`); continue; }
      const { ext } = meshes.get(key), n = added.length * 10;
      const o = {
        id: nextId++,
        name: file.name.replace(/\.[^.]+$/, '') || `${SHAPES.mesh.label} ${objects.filter(isMesh).length + 1}`,
        type: 'mesh', mesh: key, color: PALETTE[objects.length % PALETTE.length], hole: false, parent: null,
        pos: [round3((at?.x ?? 0) + n), round3((at?.y ?? 0) - n), round3(ext[2] / 2)],
        rot: [0, 0, 0],
        size: ext.map(v => round3(Math.max(v, 0.1))),
        pivot: [0, 0, 0], round: 0, roundAxis: 0, blend: 0,
      };
      objects.push(o);
      createView(o, scene);
      added.push(o);
    }
  } finally {
    hideBusy();
  }
  if (!added.length) return;
  setSelection(added.map(o => o.id));
  commit();
  const m = meshes.get(added[0].mesh);
  status(added.length === 1
    ? `Importato ${added[0].name}: ${m.tris.toLocaleString('it')} triangoli, ${added[0].size.map(v => v.toFixed(1)).join(' × ')} mm (unità del file lette come mm).`
    : `${added.length} modelli STL importati.`);
}

const isSTL = f => /\.stl$/i.test(f.name);

/** Point on the workplane under a screen position, or null. */
function workplanePoint(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObject(plane, false)[0]?.point ?? null;
}

/** Stand the selected image up or lay it down, resting on the workplane. */
function orientImage(o, rot) {
  o.rot = [...rot];
  syncView(o);
  dropSelected();
}

/** Restore the selected image's original width : height, keeping its width. */
function resetImageAspect(o) {
  const im = images.get(o.img);
  if (!im) return;
  const s = o.size[0] * im.h / im.w / o.size[1];
  o.size[1] = round3(o.size[1] * s);
  o.pivot[1] = round3(o.pivot[1] * s);
  syncView(o);
  commit();
}

/** Give an imported model back the size it had in its file, around its pivot. */
function resetMeshSize(o) {
  const m = meshes.get(o.mesh);
  if (!m) return;
  scaleShape(o, new THREE.Vector3(...m.ext.map((v, i) => Math.max(v, 0.1) / o.size[i])));
  syncView(o);
  commit();
}

const selectedObjects = () => objects.filter(o => selectedIds.includes(o.id));
const subtree = o => [o, ...childrenOf(o.id).flatMap(subtree)];

function deleteSelected() {
  const gone = new Set(selectedObjects().flatMap(subtree));
  if (!gone.size) return;
  objects = objects.filter(x => !gone.has(x));
  rebuildViews();
  select(null);
  commit();
}

function duplicateSelected() {
  const items = selectedObjects();
  if (!items.length) return;
  const copy = (o, parent) => {
    const c = { ...structuredClone(o), id: nextId++, parent };
    objects.push(c);
    childrenOf(o.id).forEach(k => copy(k, c.id));
    return c;
  };
  const copies = items.map(o => {
    const c = copy(o, parentOf(o));
    c.name = o.name + ' copia';
    c.pos = [o.pos[0] + 10, o.pos[1] + 10, o.pos[2]];
    return c;
  });
  rebuildViews();
  setSelection(copies.map(c => c.id));
  commit();
}

function dropSelected() {
  const o = selected();
  if (!o) return;
  kernelObjects();   // refresh world matrices
  let nodes = kernelNodes(o);
  // A plain group keeps its holes as holes; anything else is dropped by its own outer shape.
  if (!(isGroup(o) && o.mode === 'group')) nodes = nodes.map(n => ({ ...n, hole: false, blend: 0 }));
  const { group } = views.get(o.id);
  let lo = sceneBounds(nodes)?.lo[2];
  if (lo === undefined) {
    // Nothing solid (only reference images): rest the lowest edge just above the workplane.
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    lo = box.min.z - IMAGE_LIFT;
  }
  const p = group.getWorldPosition(new THREE.Vector3());
  p.z -= lo;
  group.parent.worldToLocal(p);
  o.pos = p.toArray().map(round3);
  syncView(o);
  commit();
}

/**
 * Drop the selection straight down until it rests on the first shape beneath it
 * (falls back to the floor when nothing is below). Probes vertical columns over the
 * shared footprint with sphere tracing, then refines around the closest contact.
 */
function dropOntoBelow() {
  const o = selected();
  if (!o) return;
  const rest = kernelObjects(o.id);
  let nodes = kernelNodes(o);
  if (!(isGroup(o) && o.mode === 'group')) nodes = nodes.map(n => ({ ...n, hole: false, blend: 0 }));
  const a = sceneBounds(nodes), b = sceneBounds(rest);
  if (!a) return;
  const x0 = Math.max(a.lo[0], b?.lo[0] ?? Infinity), x1 = Math.min(a.hi[0], b?.hi[0] ?? -Infinity);
  const y0 = Math.max(a.lo[1], b?.lo[1] ?? Infinity), y1 = Math.min(a.hi[1], b?.hi[1] ?? -Infinity);
  if (!b || x0 > x1 || y0 > y1 || b.lo[2] >= a.hi[2]) { status('Niente sotto: appoggiato sul piano.'); return dropSelected(); }
  const fa = compileJS(nodes), fb = compileJS(rest), EPS = 0.002;
  const trace = (f, x, y, z, zEnd, dir) => {
    for (let i = 0; i < 400 && (zEnd - z) * dir > 0; i++) {
      const d = f(x, y, z);
      if (d < EPS) return z;
      z += dir * Math.max(d * 0.9, EPS);
    }
    return null;
  };
  // Gap between the selection's underside and the first solid of the scene below it, in one column.
  const gap = (x, y) => {
    const za = trace(fa, x, y, a.lo[2] - 1, a.hi[2] + 1, 1);
    if (za === null || fb(x, y, za) < EPS) return Infinity;   // no underside here, or already overlapping
    const zb = trace(fb, x, y, za, b.lo[2] - 1, -1);
    return zb === null ? Infinity : za - zb;
  };
  let best = Infinity, bx = 0, by = 0, cx = (x1 - x0) / 2, cy = (y1 - y0) / 2;
  const scan = (mx, my, n) => {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = Math.min(Math.max(mx - cx + (2 * cx * i) / n, x0), x1);
      const y = Math.min(Math.max(my - cy + (2 * cy * j) / n, y0), y1);
      const g = gap(x, y);
      if (g < best) { best = g; bx = x; by = y; }
    }
  };
  scan((x0 + x1) / 2, (y0 + y1) / 2, 40);
  for (let r = 0; r < 4 && best < Infinity; r++) {
    cx /= 20; cy /= 20;
    scan(bx, by, 8);
  }
  if (best === Infinity) { status('Niente sotto: appoggiato sul piano.'); return dropSelected(); }
  const { group } = views.get(o.id);
  const p = group.getWorldPosition(new THREE.Vector3());
  p.z -= best;
  group.parent.worldToLocal(p);
  o.pos = p.toArray().map(round3);
  syncView(o);
  commit();
}

/** World-space box of an object: what a group produces, or the shape's own bounds. */
function worldBox(o) {
  const { group, mesh } = views.get(o.id);
  group.updateMatrixWorld(true);
  if (isGroup(o)) {
    const box = resultBox(o);
    return box.isEmpty() ? box : box.applyMatrix4(group.matrixWorld);
  }
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

/**
 * Align the selection along one world axis. 'min' | 'center' | 'max' line everything up on the
 * selection's overall bounds; 'touch-' | 'touch+' stack the others against the first selected object
 * on its − or + side. Other axes stay as they are.
 */
function alignSelected(axis, how) {
  const items = selectedObjects();
  const boxes = new Map(items.map(o => [o, worldBox(o)]));
  const valid = items.filter(o => !boxes.get(o).isEmpty());
  if (valid.length < 2) return;
  const c = ['x', 'y', 'z'][axis];
  const ref = selectedIds.map(byId).find(o => valid.includes(o));
  const all = valid.reduce((a, o) => a.union(boxes.get(o)), new THREE.Box3());
  const mid = b => (b.min[c] + b.max[c]) / 2;
  valid.forEach(o => {
    const b = boxes.get(o);
    let d;
    if (how === 'min') d = all.min[c] - b.min[c];
    else if (how === 'max') d = all.max[c] - b.max[c];
    else if (how === 'center') d = mid(all) - mid(b);
    else if (o === ref) return;
    else if (how === 'touch-') d = boxes.get(ref).min[c] - b.max[c];
    else d = boxes.get(ref).max[c] - b.min[c];
    if (!d) return;
    const { group } = views.get(o.id);
    const p = group.getWorldPosition(new THREE.Vector3());
    p.setComponent(axis, p.getComponent(axis) + d);
    group.parent.worldToLocal(p);
    o.pos = p.toArray().map(round3);
    syncView(o);
  });
  commit();
}

function toggleHole() {
  const items = selectedObjects().filter(o => !(isGroup(o) && o.mode === 'group') && !isImage(o));
  if (!items.length) return;
  const hole = !items[0].hole;
  items.forEach(o => { o.hole = hole; });
  syncAll();
  commit();
}

/** Put the selected siblings into a new group combined with `mode`. */
function groupSelected(mode) {
  const items = selectedObjects();
  if (items.length < 2) { status('Seleziona almeno due oggetti (Shift+clic) per combinarli.'); return; }
  const parent = parentOf(items[0]);
  // The group's origin is the centre of the selection, in the parent's frame.
  scene.updateMatrixWorld();
  const box = new THREE.Box3();
  for (const o of items) box.expandByObject(views.get(o.id).group);
  const center = box.getCenter(new THREE.Vector3());
  (parent ? views.get(parent).group : scene).worldToLocal(center);
  const count = objects.filter(o => isGroup(o) && o.mode === mode).length + 1;
  const g = {
    id: nextId++, name: `${MODES[mode]} ${count}`, type: 'group', mode, hole: false, parent,
    pos: center.toArray().map(round3), rot: [0, 0, 0], blend: 0,
  };
  for (const o of items) {
    o.parent = g.id;
    o.pos = o.pos.map((v, i) => round3(v - g.pos[i]));
  }
  objects.splice(objects.indexOf(items[0]), 0, g);
  rebuildViews();
  select(g.id);
  commit();
  status(`${MODES[mode]} di ${items.length} oggetti. Usa «Modifica pezzi» per entrare nel gruppo.`);
}

/** Dissolve the selected group, keeping its children where they are. */
function ungroupSelected() {
  const g = selected();
  if (!g || !isGroup(g)) return;
  const kids = childrenOf(g.id);
  const G = localMatrix(g);
  for (const c of kids) {
    setPose(c, G.clone().multiply(localMatrix(c)));
    c.parent = parentOf(g);
  }
  objects = objects.flatMap(o => o === g ? kids : kids.includes(o) ? [] : [o]);
  rebuildViews();
  setSelection(kids.map(c => c.id));
  commit();
}

function setGroupMode(g, mode) {
  // Keep default names in step with the mode ("Gruppo 1" -> "Unione 1"); custom names stay.
  const m = g.name.match(/^(\S+) (\d+)$/);
  if (m && m[1] === MODES[g.mode]) g.name = `${MODES[mode]} ${m[2]}`;
  g.mode = mode;
  if (mode === 'group') g.hole = false;
  syncAll();
  commit();
}

// ---------------------------------------------------------------- undo / persistence

let history = [], historyIndex = -1;

function snapshot() {
  return JSON.stringify({ version: 2, nextId, objects });
}

/** The pictures the document uses, key -> image. */
function usedImages() {
  const keys = new Set(objects.filter(isImage).map(o => o.img).filter(k => images.has(k)));
  return Object.fromEntries([...keys].map(k => [k, images.get(k)]));
}

/** The imported models the document uses, key -> mesh entry. */
function usedMeshes() {
  const keys = new Set(objects.filter(isMesh).map(o => o.mesh).filter(k => meshes.has(k)));
  return Object.fromEntries([...keys].map(k => [k, meshes.get(k)]));
}

/** A saved project: the document plus its pictures and imported models. */
const projectFile = () => JSON.stringify({ version: 2, nextId, objects, images: usedImages(), meshes: usedMeshes() });

// The autosave lives in IndexedDB (key -> value in one store): unlike localStorage it has room for
// pictures and imported models. Writes are queued in order; a failed one resolves to false.
const idb = new Promise((resolve, reject) => {
  const req = indexedDB.open('sdfcad', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
function idbRequest(mode, fn) {
  return idb.then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
const idbGet = key => idbRequest('readonly', s => s.get(key)).catch(() => undefined);
const idbSet = (key, value) => idbRequest('readwrite', s => s.put(value, key)).then(() => true, err => {
  console.warn('Autosave failed:', err);
  return false;
});

// Pictures and models are autosaved under their own keys, rewritten only when the set in use changes.
const savedAssetKeys = {};
function autosaveAssets(key, used, label) {
  const keys = Object.keys(used).sort().join();
  if (keys === savedAssetKeys[key]) return;
  savedAssetKeys[key] = keys;
  idbSet(key, used).then(ok => {
    if (ok) return;
    delete savedAssetKeys[key];   // try again on the next change
    if (keys) status(`${label}: salvataggio automatico del browser non riuscito, usa Salva per conservarli nel progetto.`);
  });
}

/** Record the current state as an undo step, autosave, and refresh UI. */
function commit() {
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot());
  if (history.length > 200) history.shift();
  historyIndex = history.length - 1;
  idbSet('project', history[historyIndex]);
  autosaveAssets('images', usedImages(), 'Immagini');
  autosaveAssets('meshes', usedMeshes(), 'Modelli STL');
  refreshAll();
}

// ---------------------------------------------------------------- project file

// Where Salva writes. Started from server.py (Avvia Efesto), projects live in the progetti/ folder and are
// overwritten in place from any browser. Without it: the File System Access API where the browser has it
// (Chrome, Edge, Arc…), else a download under the remembered name.
const canPickFiles = 'showSaveFilePicker' in window;
let saveTarget = canPickFiles ? 'disk' : 'download';   // 'server' | 'disk' | 'download', settled at startup
const FILE_TYPES = [{ description: 'Progetto Efesto', accept: { 'application/json': ['.json'] } }];
const EMPTY_STATE = JSON.stringify({ version: 2, nextId: 1, objects: [] });
// The file the project belongs to: its name, where it lives (a saveTarget, or null if Salva has to ask)
// and, on disk, its handle.
let fileName = null, fileWhere = null, fileHandle = null;
let savedState = EMPTY_STATE;   // the snapshot last saved or opened: anything else is an unsaved change

const isDirty = () => history[historyIndex] !== savedState;

function updateDocName() {
  const name = (fileName || 'Senza titolo').replace(/\.json$/i, '').replace(/\.sdfcad$/i, '');
  const mark = isDirty() ? ' •' : '';
  const el = document.getElementById('doc-name');
  el.textContent = name + mark;
  el.title = fileWhere === 'server' ? `progetti/${fileName}` : 'File del progetto';
  document.title = `${name}${mark} — Efesto`;
}

/** The current state is what is in the file now (remembered across reloads). */
function markSaved(name, where, handle = null) {
  fileName = name;
  fileWhere = where;
  fileHandle = handle;
  savedState = history[historyIndex];
  idbSet('file', { name, where, handle, saved: savedState });
  updateDocName();
}

/** A typed name as a plain .json file name, or null. */
function cleanName(typed) {
  const n = typed?.trim().replace(/[/\\:]/g, '-').replace(/^\.+/, '');
  return n ? (/\.json$/i.test(n) ? n : n + '.json') : null;
}

const projectsApi = name => 'api/projects' + (name ? '/' + encodeURIComponent(name) : '');

async function listProjects() {
  const res = await fetch(projectsApi());
  if (!res.ok) throw new Error(`errore ${res.status}`);
  return res.json();
}

/** Ask for a name to save under; in the projects folder, confirm before replacing another project. */
async function askName() {
  const name = cleanName(prompt('Nome del progetto:', (fileName || 'progetto').replace(/\.json$/i, '')));
  if (!name || saveTarget !== 'server') return name;
  const taken = (await listProjects()).some(f => f.name.toLowerCase() === name.toLowerCase());
  const same = fileWhere === 'server' && name.toLowerCase() === fileName?.toLowerCase();
  return !taken || same || confirm(`Esiste già un progetto "${name}". Sostituirlo?`) ? name : null;
}

/** Write access to a file handle, asking for it if a reload dropped it. */
async function canWrite(handle) {
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return await handle.requestPermission(opts) === 'granted';
}

async function saveProject({ as = false } = {}) {
  document.activeElement?.blur();   // commit a value still being typed
  const data = projectFile();
  let name = fileName, handle = fileHandle;
  const ask = as || fileWhere !== saveTarget;
  try {
    if (saveTarget === 'server') {
      if (ask && !(name = await askName())) return;
      const res = await fetch(projectsApi(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: data });
      if (!res.ok) throw new Error(`il server ha risposto ${res.status}`);
    } else if (saveTarget === 'disk') {
      if (ask) handle = await showSaveFilePicker({ suggestedName: name || 'progetto.sdfcad.json', types: FILE_TYPES });
      else if (!await canWrite(handle)) { status('Permesso di scrittura negato: usa Salva come… per scegliere il file.'); return; }
      const out = await handle.createWritable();
      await out.write(data);
      await out.close();
      name = handle.name;
    } else {
      if (ask && !(name = await askName())) return;
      download(name, data, 'application/json');
    }
  } catch (err) {
    if (err.name !== 'AbortError') status('Salvataggio non riuscito: ' + err.message);   // AbortError: dialog cancelled
    return;
  }
  markSaved(name, saveTarget, saveTarget === 'disk' ? handle : null);
  status(saveTarget === 'server' ? `Salvato in progetti/${name}`
    : saveTarget === 'disk' ? `Salvato ${name}`
    : `Scaricato ${name} (per sovrascrivere sempre lo stesso file avvia Efesto con "Avvia Efesto")`);
}

// ---- Apri: the projects folder in a list, or the browser's file dialog.

const filesDlg = document.getElementById('files');
const filesOpen = () => filesDlg.style.display === 'flex';
function closeProjects() { filesDlg.style.display = 'none'; }

async function openProject() {
  if (saveTarget === 'server') { showProjects(); return; }
  if (saveTarget === 'download') { document.getElementById('file-open').click(); return; }
  let handle;
  try {
    [handle] = await showOpenFilePicker({ types: FILE_TYPES });
  } catch (err) {
    if (err.name !== 'AbortError') status('Impossibile aprire: ' + err.message);
    return;
  }
  const file = await handle.getFile();
  openProjectText(await file.text(), file.name, 'disk', handle);
}

async function showProjects() {
  let list;
  try { list = await listProjects(); } catch (err) { status('Impossibile leggere la cartella progetti: ' + err.message); return; }
  const el = document.getElementById('files-list');
  el.innerHTML = list.length ? '' : '<div class="empty-note">Nessun progetto nella cartella progetti: usa Salva per crearne uno.</div>';
  for (const f of list) {
    const b = document.createElement('button');
    b.className = 'btn file-row';
    b.append(document.createElement('span'), document.createElement('small'));
    b.children[0].textContent = f.name.replace(/\.json$/i, '').replace(/\.sdfcad$/i, '');
    b.children[1].textContent = new Date(f.modified * 1000).toLocaleString('it', { dateStyle: 'short', timeStyle: 'short' });
    b.title = f.name;
    b.onclick = async () => {
      closeProjects();
      try {
        const res = await fetch(projectsApi(f.name));
        if (!res.ok) throw new Error(`errore ${res.status}`);
        openProjectText(await res.text(), f.name, 'server');
      } catch (err) {
        status(`Impossibile aprire ${f.name}: ${err.message}`);
      }
    };
    el.append(b);
  }
  filesDlg.style.display = 'flex';
  el.querySelector('button')?.focus();
}
document.getElementById('files-cancel').onclick = closeProjects;
document.getElementById('files-other').onclick = () => { closeProjects(); document.getElementById('file-open').click(); };
filesDlg.addEventListener('pointerdown', e => { if (e.target === filesDlg) closeProjects(); });

function openProjectText(text, name, where, handle = null) {
  if (isDirty() && !confirm('Il progetto ha modifiche non salvate, che andranno perse. Aprire comunque?')) return;
  try {
    selectedIds = [];
    load(text);
    commit();
  } catch (err) {
    status('File non valido: ' + err.message);
    return;
  }
  markSaved(name, where, handle);
  status(where === null ? `Aperto ${name}: Salva ne crea una copia nella cartella progetti` : `Aperto ${name}`);
}

function load(json, { resetHistory = false } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  for (const [k, im] of Object.entries(data.images || {})) images.set(k, im);
  for (const [k, m] of Object.entries(data.meshes || {})) meshes.set(k, m);
  objects = data.objects || [];
  for (const o of objects) {
    const p = byId(parentOf(o));
    o.parent = p && isGroup(p) ? p.id : null;   // files from before groups existed have no parent
    if (!isGroup(o) && !o.pivot) o.pivot = [0, 0, 0];   // nor from before pivots existed
  }
  nextId = data.nextId || Math.max(0, ...objects.map(o => o.id)) + 1;
  rebuildViews();
  setSelection(selectedIds);
  if (resetHistory) { history = []; historyIndex = -1; commit(); }
  else refreshAll();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  load(history[historyIndex]);
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  load(history[historyIndex]);
}

function refreshAll() {
  renderList();
  renderPanel();
  document.getElementById('btn-undo').disabled = historyIndex <= 0;
  document.getElementById('btn-redo').disabled = historyIndex >= history.length - 1;
  document.getElementById('hint').style.display = objects.length ? 'none' : 'flex';
  updateDocName();
  render();
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- STL export

function exportSTL() {
  const ko = kernelObjects();
  const bounds = sceneBounds(ko);
  if (!bounds) { status('Niente da esportare: aggiungi almeno un solido.'); return; }
  const cells = parseInt(document.getElementById('quality').value, 10);
  showBusy('Esporta STL', 'Generazione mesh…');
  // Let the overlay paint before the (blocking) meshing work.
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const mesh = surfaceNets(compileJS(ko), bounds, cells);
      const nTri = mesh.indices.length / 3;
      if (!nTri) { status('Il risultato è vuoto (i fori rimuovono tutto?)'); return; }
      status(`Mesh generata: ${nTri.toLocaleString('it')} triangoli in ${((performance.now() - t0) / 1000).toFixed(1)} s. Controlla l'anteprima.`);
      openPreview(mesh, {
        onExport(final) {
          download('modello.stl', toSTL(final), 'model/stl');
          const size = [0, 1, 2].map(i => (bounds.hi[i] - bounds.lo[i]).toFixed(1)).join(' × ');
          status(`STL esportato: ${(final.indices.length / 3).toLocaleString('it')} triangoli, ingombro ${size} mm`);
        },
      });
    } catch (err) {
      console.error(err);
      status('Errore durante l\'esportazione: ' + err.message);
    } finally {
      hideBusy();
    }
  }, 30);
}

/** The modal "working…" overlay. */
function showBusy(title, msg) {
  const busy = document.getElementById('busy');
  busy.querySelector('h3').textContent = title;
  busy.querySelector('.dlg div').textContent = msg;
  busy.style.display = 'flex';
}
function hideBusy() {
  document.getElementById('busy').style.display = 'none';
}

function status(msg) {
  document.getElementById('status-msg').textContent = msg;
}

// ---------------------------------------------------------------- UI: shapes, list, properties

const ICON_BITMAPS = {
  box: [
    '................',
    '.....ooooooooooo',
    '....o+++++++++oo',
    '...o+++++++++o=o',
    '..oooooooooooo=o',
    '..o#########o==o',
    '..o#########o==o',
    '..o#########o==o',
    '..o#########o==o',
    '..o#########o==o',
    '..o#########o==o',
    '..o#########o=o.',
    '..o#########oo..',
    '..ooooooooooo...',
    '................',
    '................',
  ],
  sphere: [
    '................',
    '.....oooooo.....',
    '...oo++++##oo...',
    '..o+++++#####o..',
    '..o++++######o..',
    '.o++++########o.',
    '.o+++#########o.',
    '.o############o.',
    '.o###########=o.',
    '.o##########==o.',
    '..o########==o..',
    '..o#######===o..',
    '...oo#=====oo...',
    '.....oooooo.....',
    '................',
    '................',
  ],
  cylinder: [
    '................',
    '....oooooooo....',
    '..oo++++++++oo..',
    '.o++++++++++++o.',
    '.oo++++++++++oo.',
    '.o#oooooooooo=o.',
    '.o###########=o.',
    '.o###########=o.',
    '.o###########=o.',
    '.o###########=o.',
    '.o###########=o.',
    '.o###########=o.',
    '..oo#######=oo..',
    '....oooooooo....',
    '................',
    '................',
  ],
  cone: [
    '................',
    '.......oo.......',
    '......o+#o......',
    '......o+#o......',
    '.....o++##o.....',
    '.....o+###o.....',
    '....o++###=o....',
    '....o+####=o....',
    '...o++####==o...',
    '...o+#####==o...',
    '..o++#####===o..',
    '..o+######===o..',
    '..oo#######=oo..',
    '....oooooooo....',
    '................',
    '................',
  ],
  torus: [
    '................',
    '................',
    '................',
    '....oooooooo....',
    '..oo++++++++oo..',
    '.o+++######+++o.',
    'o++ooooooooo##=o',
    'o+o.........o#=o',
    'o#o.........o==o',
    'o##ooo....ooo==o',
    '.o###oooooo===o.',
    '..oo########oo..',
    '....oooooooo....',
    '................',
    '................',
    '................',
  ],
  text: [
    '................',
    '.oooooooooooooo.',
    '.o++++++++++++o.',
    '.o############o.',
    '.o====####====o.',
    '.ooooo####ooooo.',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....o+##=o.....',
    '.....oooooo.....',
    '................',
    '................',
  ],
  mesh: [
    '................',
    '.......oo.......',
    '.....oo++oo.....',
    '...oo++++++oo...',
    '..o++++++++++o..',
    '..o##++++++==o..',
    '..o####++====o..',
    '..o######====o..',
    '..o######====o..',
    '..o######====o..',
    '..o######====o..',
    '...oo####==oo...',
    '.....oo##oo.....',
    '.......oo.......',
    '................',
    '................',
  ],
  image: [
    '................',
    '................',
    '.oooooooooooooo.',
    '.o++++++++++++o.',
    '.o+++++++++==+o.',
    '.o++++++++====o.',
    '.o+++++++++==+o.',
    '.o+++#++++++++o.',
    '.o++###+++++++o.',
    '.o+#####++#+++o.',
    '.o##########++o.',
    '.o############o.',
    '.o############o.',
    '.oooooooooooooo.',
    '................',
    '................',
  ],
};
const ICON_COLORS = {
  box: ['#ff9999', '#ff5555', '#aa0000'],
  sphere: ['#aaffff', '#55ffff', '#00aaaa'],
  cylinder: ['#ffdd88', '#ffaa00', '#aa5500'],
  cone: ['#ffaaff', '#ff55ff', '#aa00aa'],
  torus: ['#aaffaa', '#55ff55', '#00aa00'],
  text: ['#aaaaff', '#5555ff', '#0000aa'],
  image: ['#aaddff', '#00aa00', '#ffff55'],
  mesh: ['#ffd0a0', '#ff8800', '#aa4400'],
};
const HOLE_COLORS = ['#ffffff', '#c0c0c0', '#808080'];

function pixelIcon(type, hole) {
  const [light, base, shade] = hole ? HOLE_COLORS : ICON_COLORS[type];
  const fill = { o: '#000', '+': light, '#': base, '=': shade };
  let rects = '';
  ICON_BITMAPS[type].forEach((row, y) => [...row].forEach((c, x) => {
    if (!fill[c]) return;
    // Holes get a checkerboard body so they read as "empty" like the hole swatch.
    const color = hole && c !== 'o' && (x + y) % 2 ? '#808080' : fill[c];
    rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
  }));
  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>`;
}

function renderShapeButtons() {
  const el = document.getElementById('shapes');
  const items = [...Object.keys(SHAPES).filter(t => t !== 'image' && t !== 'mesh').map(t => [t, false]),
    ['box', true], ['cylinder', true], ['image', false], ['mesh', false]];
  el.innerHTML = '';
  for (const [type, hole] of items) {
    const b = document.createElement('button');
    b.className = 'shape-btn' + (hole ? ' hole' : '');
    const icon = theme.icons === 'ascii' ? asciiIcon(type, hole)
      : theme.icons === 'vector' ? vectorIcon(type, hole, themeShapeColor(theme, type)) : pixelIcon(type, hole);
    b.innerHTML = `${icon}${hole ? 'Foro ' + SHAPES[type].label.toLowerCase() : type === 'mesh' ? 'Importa STL' : SHAPES[type].label}`;
    if (type === 'image') b.title = 'Importa un\'immagine PNG o JPEG come riferimento (o trascinala nella vista)';
    if (type === 'mesh') b.title = 'Importa un modello STL come solido modificabile (o trascinalo nella vista)';
    b.onclick = type === 'image' ? () => document.getElementById('file-image').click()
      : type === 'mesh' ? () => document.getElementById('file-stl').click() : () => addShape(type, hole);
    el.append(b);
  }
}

// 12x12 icons for the combine modes: two overlapping squares, filled where material is kept.
const COMBINE_BITMAPS = {
  group: [
    'ooooooo.....',
    'o#####o.....',
    'o#####o.....',
    'o#####o.....',
    'o####oooooo.',
    'o####o####o.',
    'oooooo####o.',
    '....o#####o.',
    '....o#####o.',
    '....o#####o.',
    '....ooooooo.',
    '............',
  ],
  union: [
    'ooooooo.....',
    'o#####o.....',
    'o#####o.....',
    'o#####o.....',
    'o#########o.',
    'o#########o.',
    'oooo######o.',
    '....o#####o.',
    '....o#####o.',
    '....o#####o.',
    '....ooooooo.',
    '............',
  ],
  intersect: [
    'ooooooo.....',
    'o.....o.....',
    'o.....o.....',
    'o.....o.....',
    'o...ooooooo.',
    'o...o##o..o.',
    'ooooooo...o.',
    '....o.....o.',
    '....o.....o.',
    '....o.....o.',
    '....ooooooo.',
    '............',
  ],
};

function combineIcon(mode, hole = false) {
  if (theme.icons === 'ascii') return asciiCombineIcon(mode);
  if (theme.icons === 'vector') return vectorCombineIcon(mode, hole);
  let rects = '';
  COMBINE_BITMAPS[mode].forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '.') return;
    const color = c === 'o' ? '#000' : hole ? ((x + y) % 2 ? '#808080' : '#fff') : '#5555ff';
    rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
  }));
  return `<svg class="cicon" viewBox="0 0 12 12" shape-rendering="crispEdges">${rects}</svg>`;
}

function renderList() {
  const el = document.getElementById('list');
  if (!objects.length) { el.innerHTML = '<div class="empty-note">Scena vuota</div>'; return; }
  el.innerHTML = '';
  const add = (o, depth) => {
    const d = document.createElement('div');
    d.className = 'item' + (selectedIds.includes(o.id) ? ' sel' : '');
    d.style.paddingLeft = `${4 + depth * 14}px`;
    if (isGroup(o)) {
      const open = isOpen(o);
      d.innerHTML = `<button class="fold" title="${open ? 'Esci dal gruppo' : 'Modifica pezzi'}">${open ? '−' : '+'}</button>${combineIcon(o.mode, o.hole)}<span class="name"></span>`;
      d.querySelector('.fold').onclick = e => {
        e.stopPropagation();
        if (open) { entered = o.id; selectedIds = []; exitGroup(); } else enterGroup(o);
      };
    } else if (isImage(o)) {
      d.innerHTML = '<span class="swatch img"></span><span class="name"></span>';
      const thumb = images.get(o.img)?.thumb;
      if (thumb) d.querySelector('.swatch').style.backgroundImage = `url("${thumb}")`;
      if (o.locked) d.title = 'Bloccata nella vista: si seleziona solo da qui';
    } else {
      d.innerHTML = `<span class="swatch${o.hole ? ' hole' : ''}" style="background:${o.color}"></span><span class="name"></span>`;
    }
    d.querySelector('.name').textContent = o.name;
    d.onclick = e => select(o.id, e.shiftKey || e.metaKey || e.ctrlKey);
    el.append(d);
    if (isGroup(o) && isOpen(o)) childrenOf(o.id).forEach(c => add(c, depth + 1));
  };
  childrenOf(null).forEach(o => add(o, 0));
}

/** The three combine buttons, for the multi-selection panel or a group's mode switch. */
function combineButtons(active) {
  return Object.entries(MODES).map(([mode, label]) =>
    `<button class="${active === mode ? 'on' : ''}" data-combine="${mode}">${combineIcon(mode)}${label}</button>`).join('');
}

function xyzInputs(key, step, axes = ['X', 'Y', 'Z']) {
  const cols = axes.length < 3 ? ` style="grid-template-columns: repeat(${axes.length}, 1fr)"` : '';
  return `<div class="xyz"${cols}>${axes.map((a, i) =>
    `<label data-axis="${a}"><input type="number" step="${step}" data-key="${key}" data-i="${i}"></label>`).join('')}</div>`;
}

/** Under the pivot inputs: per axis, snap the pivot to the − face, the centre or the + face. */
function pivotButtons() {
  const tip = ['lato −', 'centro', 'lato +'];
  return `<div class="xyz">${['X', 'Y', 'Z'].map((a, i) => `<div class="seg tri">${[-1, 0, 1].map(s =>
    `<button data-pivot="${i}" data-side="${s}" title="Perno ${a}: ${tip[s + 1]}">${['−', '0', '+'][s + 1]}</button>`).join('')}</div>`).join('')}</div>`;
}

function textRows() {
  const fonts = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
  return `
    <div class="row"><span>Testo</span><textarea data-key="text" rows="2" spellcheck="false" title="Invio per andare a capo"></textarea></div>
    <div class="row"><span>Carattere</span><select data-key="font">${fonts}</select></div>
    <div class="row"><span>Stile</span><div class="seg">
      <button data-flag="bold" title="Grassetto"><b>G</b> Grassetto</button><button data-flag="italic" title="Corsivo"><i>C</i> Corsivo</button></div></div>
    <div class="row"><span>Allinea</span><div class="seg tri">${[['left', 'Sx', 'Allinea a sinistra'], ['center', 'Centro', 'Centra le righe'], ['right', 'Dx', 'Allinea a destra']]
      .map(([a, l, t]) => `<button data-align="${a}" title="${t}">${l}</button>`).join('')}</div></div>`;
}

function meshRows(o) {
  const m = meshes.get(o.mesh);
  const info = m ? `${m.tris.toLocaleString('it')} triangoli, griglia ${m.w}×${m.h}×${m.d}: i dettagli sotto ~${m.cell.toFixed(2)} mm si arrotondano.`
    : 'Dati del modello mancanti.';
  return `
    <div class="row"><span></span><button class="btn" id="act-mesh-size" title="Riporta le dimensioni del file STL"${m ? '' : ' disabled'}>Dimensioni originali</button></div>
    <div class="note">Modello STL importato: ${info}</div>`;
}

const PIVOT_ROWS = `
    <div class="row"><span title="Punto attorno a cui l'oggetto ruota e scala, rispetto al suo centro (assi locali). Modalità Perno (O) per trascinarlo.">Perno</span>${xyzInputs('pivot', 1)}</div>
    <div class="row"><span></span>${pivotButtons()}</div>`;

function renderPanel() {
  const el = document.getElementById('props');
  const o = selected();
  updateEdgeHelper();
  if (selectedIds.length > 1) return renderMultiPanel(el);
  if (!o) { el.innerHTML = '<div class="empty-note">Nessun oggetto selezionato<br>Shift+clic per selezionarne più di uno</div>'; return; }
  if (isGroup(o)) return renderGroupPanel(el, o);
  if (isImage(o)) return renderImagePanel(el, o);
  el.innerHTML = `
    <div class="row"><span>Nome</span><input type="text" data-key="name"></div>${o.type === 'text' ? textRows() : ''}
    <div class="row"><span>Tipo</span><div class="seg">
      <button data-hole="0">Solido</button><button data-hole="1">Foro</button></div></div>
    <div class="row"><span>Colore</span><input type="color" data-key="color"></div>
    <div class="row"><span>Posizione</span>${xyzInputs('pos', 1)}</div>
    <div class="row"><span>Rotazione °</span>${xyzInputs('rot', 5)}</div>
    <div class="row"><span>Dimensioni</span>${xyzInputs('size', 1)}</div>${isMesh(o) ? meshRows(o) : ''}${PIVOT_ROWS}
    ${o.type === 'box' ? `<div class="row"><span title="Quali spigoli arrotondare">Spigoli</span><select data-key="roundAxis">
      <option value="0">Tutti</option><option value="1">Paralleli a X</option><option value="2">Paralleli a Y</option><option value="3">Paralleli a Z</option><option value="4">Singoli</option></select></div>${o.roundAxis === 4 ? `
    <div class="note">Clicca gli spigoli nella vista (⇧ per sceglierne più di uno).</div>
    <div class="row"><span>Selezione</span><div class="seg"><button id="edge-all">Tutti</button><button id="edge-none">Nessuno</button></div></div>
    <div class="row"><span>Raggio spigolo</span><div class="slider">
      <input type="range" min="0" max="20" step="0.1" data-edge-r><input type="number" min="0" step="0.1" data-edge-r></div></div>` : `
    <div class="row"><span>Raggio spigoli</span><div class="slider">
      <input type="range" min="0" max="20" step="0.1" data-key="round"><input type="number" min="0" step="0.1" data-key="round"></div></div>`}` : ''}
    <div class="row"><span title="Raggio di raccordo morbido con gli altri oggetti">Fusione</span><div class="slider">
      <input type="range" min="0" max="20" step="0.1" data-key="blend"><input type="number" min="0" step="0.5" data-key="blend"></div></div>
    <div class="actions">
      <button class="btn" id="act-drop">Appoggia (D)</button>
      <button class="btn" id="act-drop-on" title="Appoggia sulla prima forma sotto (Shift+D)">Appoggia su (⇧D)</button>
      <button class="btn" id="act-dup">Duplica</button>
      <button class="btn danger" id="act-del" style="grid-column: span 2">Elimina</button>
    </div>`;

  wirePanel(el, o);
}

function renderGroupPanel(el, g) {
  const plain = g.mode === 'group';
  if (!plain) g.color = groupColor(g);
  const n = childrenOf(g.id).length;
  el.innerHTML = `
    <div class="row"><span>Nome</span><input type="text" data-key="name"></div>
    <div class="seg three">${combineButtons(g.mode)}</div>
    <div class="note">${{
      group: 'I pezzi restano separati e si muovono insieme.',
      union: 'I pezzi diventano un solido unico; i fori interni tagliano solo questo gruppo.',
      intersect: 'Resta solo il volume comune a tutti i solidi del gruppo.',
    }[g.mode]} ${n} ${n === 1 ? 'pezzo' : 'pezzi'}. Sono nascosti finché non premi «Modifica pezzi».</div>
    <div class="row"><span>Tipo</span><div class="seg">
      <button data-hole="0" ${plain ? 'disabled' : ''}>Solido</button><button data-hole="1" ${plain ? 'disabled' : ''}>Foro</button></div></div>
    ${plain ? '' : '<div class="row"><span title="Tutti i pezzi del gruppo prendono questo colore">Colore</span><input type="color" data-key="color"></div>'}
    <div class="row"><span>Posizione</span>${xyzInputs('pos', 1)}</div>
    <div class="row"><span>Rotazione °</span>${xyzInputs('rot', 5)}</div>
    <div class="row"><span title="Ingombro del gruppo lungo i suoi assi">Dimensioni</span>${xyzInputs('size', 1)}</div>${PIVOT_ROWS}
    ${plain ? '' : `<div class="row"><span title="Raccordo morbido tra i pezzi del gruppo e con gli altri oggetti">Fusione</span><div class="slider">
      <input type="range" min="0" max="20" step="0.1" data-key="blend"><input type="number" min="0" step="0.5" data-key="blend"></div></div>`}
    <div class="actions">
      <button class="btn" id="act-drop">Appoggia (D)</button>
      <button class="btn" id="act-drop-on" title="Appoggia sulla prima forma sotto (Shift+D)">Appoggia su (⇧D)</button>
      <button class="btn" id="act-dup">Duplica</button>
      <button class="btn" id="act-enter" title="Mostra e modifica i singoli pezzi (doppio clic)">Modifica pezzi</button>
      <button class="btn" id="act-ungroup" title="Separa (Ctrl/Cmd+Shift+G)">Separa</button>
      <button class="btn danger" id="act-del">Elimina</button>
    </div>`;
  el.querySelectorAll('[data-combine]').forEach(b => b.onclick = () => {
    if (g.mode !== b.dataset.combine) setGroupMode(g, b.dataset.combine);
  });
  el.querySelector('#act-enter').onclick = () => enterGroup(g);
  el.querySelector('#act-ungroup').onclick = ungroupSelected;
  wirePanel(el, g);
}

/** Two-way switch for a boolean field: [off label, on label]. */
function toggleSeg(key, [off, on]) {
  return `<div class="seg"><button data-toggle="${key}" data-value="0">${off}</button><button data-toggle="${key}" data-value="1">${on}</button></div>`;
}

function renderImagePanel(el, o) {
  el.innerHTML = `
    <div class="row"><span>Nome</span><input type="text" data-key="name"></div>
    <div class="note">Immagine di riferimento: si vede solo nell'editor, non entra nell'STL.</div>
    <div class="row"><span>Posizione</span>${xyzInputs('pos', 1)}</div>
    <div class="row"><span>Rotazione °</span>${xyzInputs('rot', 5)}</div>
    <div class="row"><span>Orienta</span><div class="seg tri">${Object.entries(ORIENT).map(([k, [label, , tip]]) =>
      `<button data-orient="${k}" title="${tip}">${label}</button>`).join('')}</div></div>
    <div class="row"><span>Dimensioni</span>${xyzInputs('size', 1, ['X', 'Y'])}</div>
    <div class="row"><span>Proporzioni</span><div class="seg">
      <button data-toggle="keepAspect" title="Larghezza e altezza cambiano insieme">Bloccate</button>
      <button id="act-aspect" title="Riporta le proporzioni dell'immagine originale">Originali</button></div></div>${PIVOT_ROWS}
    <div class="row"><span>Opacità %</span><div class="slider">
      <input type="range" min="5" max="100" step="1" data-key="opacity"><input type="number" min="5" max="100" step="5" data-key="opacity"></div></div>
    <div class="row"><span title="Visibile anche attraverso i solidi">Sopra i solidi</span>${toggleSeg('onTop', ['No', 'Sì'])}</div>
    <div class="row"><span title="Bloccata: i clic nella vista la attraversano; si seleziona dalla lista Oggetti">Nella vista</span>${toggleSeg('locked', ['Libera', 'Bloccata'])}</div>
    <div class="actions">
      <button class="btn" id="act-drop">Appoggia (D)</button>
      <button class="btn" id="act-dup">Duplica</button>
      <button class="btn danger" id="act-del" style="grid-column: span 2">Elimina</button>
    </div>`;
  el.querySelectorAll('[data-orient]').forEach(b => b.onclick = () => orientImage(o, ORIENT[b.dataset.orient][1]));
  el.querySelector('#act-aspect').onclick = () => resetImageAspect(o);
  wirePanel(el, o);
}

/** Align section of the multi-selection panel: per axis, Min / Centre / Max and Touch − / +. */
function alignButtons() {
  const axes = [['X', 'sinistra / destra'], ['Y', 'dietro / davanti'], ['Z', 'sotto / sopra']];
  const btn = (i, how, label) => `<button data-axis="${i}" data-align="${how}">${label}</button>`;
  return axes.map(([a, hint], i) => `
    <div class="note" style="margin-bottom:2px">${a} – ${hint}</div>
    <div class="seg three" style="margin:2px 0">${btn(i, 'min', 'Min')}${btn(i, 'center', 'Centro')}${btn(i, 'max', 'Max')}</div>
    <div class="seg" style="margin-bottom:6px">${btn(i, 'touch-', `Tocca −${a}`)}${btn(i, 'touch+', `Tocca +${a}`)}</div>`).join('');
}

function renderMultiPanel(el) {
  el.innerHTML = `
    <div class="note">${selectedIds.length} oggetti selezionati.</div>
    <div class="seg three">${combineButtons(null)}</div>
    <div class="note">Gruppo: si muovono insieme · Unione: un solido unico · Intersezione: solo la parte in comune. <kbd>⌘G</kbd> raggruppa.</div>
    <h3>Allinea</h3>
    ${alignButtons()}
    <div class="note">Tocca: affianca gli altri alla prima forma selezionata. Gli altri assi non cambiano.</div>
    <div class="actions">
      <button class="btn" id="act-dup">Duplica</button>
      <button class="btn danger" id="act-del">Elimina</button>
    </div>`;
  el.querySelectorAll('[data-align]').forEach(b => b.onclick = () => alignSelected(+b.dataset.axis, b.dataset.align));
  el.querySelectorAll('[data-combine]').forEach(b => b.onclick = () => groupSelected(b.dataset.combine));
  el.querySelector('#act-dup').onclick = duplicateSelected;
  el.querySelector('#act-del').onclick = deleteSelected;
}

function wirePanel(el, o) {
  el.querySelectorAll(':is(input, textarea, select)[data-key]').forEach(input => {
    input.addEventListener('input', () => applyInput(input));
    input.addEventListener('change', () => { applyInput(input); commit(); });
  });
  wireEdgeRows(el, o);
  el.querySelectorAll('[data-hole]').forEach(b => b.onclick = () => {
    if (o.hole !== (b.dataset.hole === '1')) toggleHole();
  });
  el.querySelectorAll('[data-pivot]').forEach(b => b.onclick = () => setPivotSide(o, +b.dataset.pivot, +b.dataset.side));
  const setText = (key, value) => {
    o[key] = value;
    fitText(o);
    syncView(o);
    commit();
  };
  el.querySelectorAll('[data-flag]').forEach(b => b.onclick = () => setText(b.dataset.flag, !o[b.dataset.flag]));
  el.querySelectorAll('[data-align]').forEach(b => b.onclick = () => setText('align', b.dataset.align));
  // A switch button with no data-value flips the field; otherwise it sets it on (1) or off (0).
  el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    const key = b.dataset.toggle;
    o[key] = b.dataset.value === undefined ? !o[key] : b.dataset.value === '1';
    syncView(o);
    commit();
  });
  const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.onclick = fn; };
  on('#act-drop', dropSelected);
  on('#act-mesh-size', () => resetMeshSize(o));
  on('#act-drop-on', dropOntoBelow);
  on('#act-dup', duplicateSelected);
  on('#act-del', deleteSelected);
  updatePanelValues();
}

/** Write current values (including live gizmo state) into the panel inputs. */
function updatePanelValues() {
  const o = selected();
  const el = document.getElementById('props');
  if (!o) return;
  const { group } = views.get(o.id);
  const { pivot, half } = pivotInfo(o);
  const live = {
    pos: group.position.toArray(),
    rot: [group.rotation.x, group.rotation.y, group.rotation.z].map(rad2deg),
    size: isGroup(o) ? localBox(group).getSize(new THREE.Vector3()).multiply(group.scale).toArray() : o.size?.map((s, i) => s * group.scale.getComponent(i)),
    pivot,
  };
  el.querySelectorAll(':is(input, textarea, select)[data-key]').forEach(input => {
    if (input === document.activeElement && input.type !== 'range') return;
    const key = input.dataset.key;
    if (input.dataset.i !== undefined) input.value = round3(live[key][+input.dataset.i]).toString();
    else input.value = o[key] ?? 0;
  });
  el.querySelectorAll('[data-hole]').forEach(b => b.classList.toggle('on', (b.dataset.hole === '1') === o.hole));
  el.querySelectorAll('[data-flag]').forEach(b => b.classList.toggle('on', !!o[b.dataset.flag]));
  el.querySelectorAll('[data-align]').forEach(b => b.classList.toggle('on', b.dataset.align === o.align));
  el.querySelectorAll('[data-toggle]').forEach(b => {
    const v = !!o[b.dataset.toggle];
    b.classList.toggle('on', b.dataset.value === undefined ? v : v === (b.dataset.value === '1'));
  });
  el.querySelectorAll('[data-pivot]').forEach(b => {
    const i = +b.dataset.pivot;
    b.classList.toggle('on', Math.abs(pivot[i] - b.dataset.side * half[i]) < 0.01);
  });
  const color = el.querySelector('input[data-key=color]');
  if (color) color.disabled = o.hole;
}

/** Largest edge radius a box can show: half its thinnest side (of the two sides across the rounded edges). */
function maxRound(o) {
  const s = o.roundAxis && o.roundAxis < 4 ? o.size.filter((_, i) => i !== o.roundAxis - 1) : o.size;
  return Math.min(...s) / 2;
}

function applyInput(input) {
  const o = selected();
  if (!o) return;
  const key = input.dataset.key;
  if (key === 'pivot') {
    const v = parseFloat(input.value), i = +input.dataset.i;
    if (!Number.isFinite(v)) return;
    const d = [0, 0, 0];
    d[i] = v - pivotInfo(o).pivot[i];
    shiftPivot(o, d);
    syncAll();
    updatePanelValues();
    render();
    return;
  }
  if (input.dataset.i !== undefined) {
    const v = parseFloat(input.value), i = +input.dataset.i;
    if (!Number.isFinite(v)) return;
    if (key === 'size' && isGroup(o)) {
      // Stretch the parts about the group's origin so the group's extent along this axis becomes v.
      const cur = localBox(views.get(o.id).group).getSize(new THREE.Vector3()).getComponent(i);
      if (cur < 1e-6) return;
      const f = new THREE.Vector3(1, 1, 1).setComponent(i, Math.max(v, 0.1) / cur);
      bakeScale(o, f);
      syncAll();
      render();
      return;
    }
    if (key === 'size') {
      // Grow around the pivot, like the gizmo does: its offset from the centre scales with the size.
      const s = Math.max(v, 0.1);
      if (isImage(o) && o.keepAspect) {
        const j = 1 - i, r = s / o.size[i];
        o.pivot[j] = round3(o.pivot[j] * r);
        o.size[j] = round3(o.size[j] * r);
      }
      o.pivot[i] = round3(o.pivot[i] * s / o.size[i]);
      o.size[i] = s;
    } else o[key][i] = v;
  } else if (input.type === 'number' || input.type === 'range') {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    o[key] = key === 'opacity' ? Math.min(Math.max(v, 5), 100) : Math.max(v, 0);
    // A box can't round its edges past half its thinnest side: show the radius that is actually applied.
    if (key === 'round') o.round = Math.min(o.round, round3(maxRound(o)));
  } else if (key === 'roundAxis') {
    o.roundAxis = +input.value;
    o.round = Math.min(o.round, round3(maxRound(o)));
    if (o.roundAxis === 4) o.edges ??= Array(12).fill(o.round);
    edgeSel = [];
    renderPanel();
    updatePanelValues();
  } else {
    o[key] = input.value;
  }
  if (TEXT_KEYS.has(key) && fitText(o)) updatePanelValues();
  syncView(o);
  if (key === 'size' && isImage(o) && o.keepAspect) updatePanelValues();
  if (key === 'name') renderList();
  if (key === 'color') renderList();
  // Keep the paired slider / number box in sync.
  document.querySelectorAll(`#props input[data-key=${key}]:not([data-i])`).forEach(other => {
    if (other !== input) other.value = o[key];
  });
  render();
}

// ---------------------------------------------------------------- wiring

document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
document.getElementById('snap').onchange = applySnap;
document.getElementById('btn-export').onclick = exportSTL;
document.getElementById('btn-undo').onclick = undo;
document.getElementById('btn-redo').onclick = redo;
document.getElementById('btn-pixel').onclick = togglePixel;
document.getElementById('btn-quality').onclick = cycleRenderQuality;
showRenderQuality();

{
  const btn = document.getElementById('btn-keys'), panel = document.getElementById('keys-panel');
  const setOpen = open => { panel.hidden = !open; btn.setAttribute('aria-expanded', open); };
  btn.onclick = () => setOpen(panel.hidden);
  window.addEventListener('pointerdown', e => { if (!panel.hidden && !e.target.closest('#keys-menu')) setOpen(false); }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
}
document.getElementById('btn-space').onclick = () => setSpace(gizmoSpace === 'world' ? 'local' : 'world');
setSpace(gizmoSpace);
document.getElementById('btn-new').onclick = () => {
  if (isDirty() && !confirm('Il progetto ha modifiche non salvate, che andranno perse. Iniziare un nuovo progetto?')) return;
  selectedIds = [];
  load({ objects: [], nextId: 1 });
  commit();
  markSaved(null, null);
};
document.getElementById('btn-save').onclick = () => saveProject();
document.getElementById('btn-save-as').onclick = () => saveProject({ as: true });
document.getElementById('file-image').onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importImages(files);
};
document.getElementById('file-stl').onchange = e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importMeshes(files);
};
// Drop PNG / JPEG / STL files on the view: they land on the workplane where they are dropped.
view.addEventListener('dragover', e => {
  if (![...e.dataTransfer.items].some(i => i.kind === 'file')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
view.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files], at = workplanePoint(e.clientX, e.clientY);
  const stl = files.filter(isSTL), pics = files.filter(f => !isSTL(f));
  if (stl.length) importMeshes(stl, at).then(() => pics.length && importImages(pics, at));
  else importImages(pics, at);
});
document.getElementById('btn-open').onclick = openProject;
document.getElementById('file-open').onchange = e => {
  const file = e.target.files[0];
  e.target.value = '';
  // A file from outside the projects folder: the first Salva asks where it goes.
  if (file) file.text().then(text => openProjectText(text, file.name, saveTarget === 'download' ? 'download' : null));
};

window.addEventListener('keydown', e => {
  if (previewOpen()) return;
  if (filesOpen()) { if (e.key === 'Escape') closeProjects(); return; }
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject({ as: e.shiftKey }); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected('group'); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(childrenOf(entered).map(o => o.id)); return; }
  if (e.code.startsWith('Numpad')) {
    const flip = e.ctrlKey;
    const v = { 1: flip ? 'back' : 'front', 3: flip ? 'left' : 'right', 7: flip ? 'bottom' : 'top', 0: flip ? 'isobot' : 'iso' }[e.key];
    if (v) { e.preventDefault(); setView(v); return; }
    if (e.key === '5') { setOrtho(!ortho); return; }
  }
  if (mod) return;
  switch (e.key.toLowerCase()) {
    case 'w': setMode('translate'); break;
    case 'e': setMode('rotate'); break;
    case 'r': setMode('scale'); break;
    case 'o': setMode('pivot'); break;
    case 'x': setSpace(gizmoSpace === 'world' ? 'local' : 'world'); break;
    case 'h': toggleHole(); break;
    case 'd': e.shiftKey ? dropOntoBelow() : dropSelected(); break;
    case 'p': if (!theme.ascii) togglePixel(); break;
    case 'v': cycleRenderQuality(); break;
    case 't': cycleTheme(); break;
    case 'l': lay ? layExit() : layEnter(); break;
    case 'escape': lay ? layExit() : exitGroup(); break;   // cancel Lay, or step out of a group
    case 'delete': case 'backspace': e.preventDefault(); deleteSelected(); break;
  }
});

// ---------------------------------------------------------------- themes

const themeSelect = document.getElementById('theme');
for (const [name, t] of Object.entries(THEMES)) themeSelect.add(new Option(t.label, name));

function applyTheme(name, { persist = true } = {}) {
  const changed = name !== themeName;
  themeName = name;
  theme = THEMES[name];
  document.documentElement.dataset.theme = name;
  themeSelect.value = name;
  renderer.setClearColor(theme.clear, theme.clearAlpha);
  plane.material.color.set(theme.plane);
  holeMat.color.set(theme.hole[0]);
  holeMat.opacity = theme.hole[1];
  outlineMat.color.set(theme.outline);
  buildGrids();
  // The gizmo lives in its own scene while the ASCII pass is on, so it is not turned into characters.
  transform.removeFromParent();
  (theme.ascii ? overlay : scene).add(transform);
  if (theme.ascii) {
    ascii.setColors(theme.asciiColors);
    document.fonts?.load('bold 12px "VT323"').then(() => { ascii.invalidate(); render(); });
  }
  // Each style has its own idea of pixelation: only the retro one starts pixelated.
  if (changed) pixelMode = !!theme.pixel;
  document.getElementById('btn-pixel').classList.toggle('active', pixelMode && !theme.ascii);
  document.getElementById('btn-pixel').disabled = !!theme.ascii;
  renderer.setPixelRatio(pixelRatio());
  if (persist) try {
    localStorage.setItem(THEME_KEY, name);
    localStorage.setItem(PIXEL_KEY, pixelMode ? '1' : '0');
  } catch { /* storage unavailable */ }
  renderShapeButtons();
  if (changed) refreshAll();
  resize();
}
themeSelect.onchange = () => { applyTheme(themeSelect.value); themeSelect.blur(); };

function cycleTheme() {
  const names = Object.keys(THEMES);
  applyTheme(names[(names.indexOf(themeName) + 1) % names.length]);
}

// ---------------------------------------------------------------- start

applyTheme(themeName, { persist: false });
applySnap();
const serverUp = fetch(projectsApi()).then(r => r.ok, () => false);
// A slow IndexedDB must not hold up startup: after a few seconds start empty (later writes still queue up).
let [saved, savedImages, savedMeshes, file] = await Promise.race([
  Promise.all(['project', 'images', 'meshes', 'file'].map(idbGet)),
  new Promise(r => setTimeout(() => r([]), 4000)),
]);
if (await serverUp) saveTarget = 'server';
const legacy = saved === undefined;
if (legacy) try {
  saved = localStorage.getItem(LEGACY_KEYS.project);
  savedImages = JSON.parse(localStorage.getItem(LEGACY_KEYS.images));
  savedMeshes = JSON.parse(localStorage.getItem(LEGACY_KEYS.meshes));
} catch { /* storage unavailable */ }
for (const [k, im] of Object.entries(savedImages || {})) images.set(k, im);
for (const [k, m] of Object.entries(savedMeshes || {})) meshes.set(k, m);
if (file) ({ name: fileName, where: fileWhere = null, handle: fileHandle = null, saved: savedState } = file);
try {
  load(saved || { objects: [], nextId: 1 }, { resetHistory: true });
} catch {
  load({ objects: [], nextId: 1 }, { resetHistory: true });
}
// Once the autosave is safely in IndexedDB, free the old localStorage copy.
if (legacy && saved && await idbSet('project', history[historyIndex])) {
  try { Object.values(LEGACY_KEYS).forEach(k => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
}
resize();
// Text drawn before its font arrived was skipped; draw it now.
preloadFonts().then(render);
