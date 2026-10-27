// Checks a project read from a file, the server or the autosave before the editor touches it. Values from a
// file end up in the page's HTML, in shaders and in typed-array sizes, so anything off is refused: a crafted
// file must not be able to run script, load remote URLs or freeze the tab. Missing fields are fine (older
// files lack some); present ones must have the right type.

const TYPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'text', 'image', 'mesh', 'group']);
const MODES = new Set(['group', 'union', 'intersect']);
const ALIGNS = new Set(['left', 'center', 'right']);
const MESH_MAX_DIM = 512;            // cells per side; the importer makes at most MESH_RES (128)
const MESH_MAX_CELLS = 1 << 24;
const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => Number.isSafeInteger(v);
const vec = n => v => Array.isArray(v) && v.length === n && v.every(isNum);

// Per field: the test its value must pass when present.
const FIELDS = {
  id: isInt,
  parent: v => v === null || isInt(v),
  type: v => TYPES.has(v),
  mode: v => MODES.has(v),
  name: v => typeof v === 'string',
  color: v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  pos: vec(3), rot: vec(3), size: vec(3), pivot: vec(3), ink: vec(2),
  round: isNum, blend: isNum, opacity: isNum,
  roundAxis: v => isInt(v) && v >= 0 && v <= 4,
  edges: v => Array.isArray(v) && v.length === 12 && v.every(isNum),
  text: v => typeof v === 'string', font: v => typeof v === 'string',
  align: v => ALIGNS.has(v),
  img: v => typeof v === 'string', mesh: v => typeof v === 'string',
  hole: v => typeof v === 'boolean', bold: v => typeof v === 'boolean', italic: v => typeof v === 'boolean',
  keepAspect: v => typeof v === 'boolean', onTop: v => typeof v === 'boolean', locked: v => typeof v === 'boolean',
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkObject(o) {
  if (!isObject(o)) throw new Error('oggetto non valido');
  if (!isInt(o.id) || !TYPES.has(o.type)) throw new Error('oggetto senza id o tipo valido');
  if (o.type === 'group' && !MODES.has(o.mode)) throw new Error(`gruppo ${o.id}: modo non valido`);
  for (const [key, ok] of Object.entries(FIELDS)) {
    if (o[key] !== undefined && !ok(o[key])) throw new Error(`oggetto ${o.id}: campo "${key}" non valido`);
  }
}

/** An imported picture { src, w, h, thumb }, as stored in a project or the autosave. */
export function validImage(im) {
  return isObject(im) && typeof im.src === 'string' && IMAGE_URL.test(im.src) && isNum(im.w) && im.w > 0 &&
    isNum(im.h) && im.h > 0 && (im.thumb === undefined || (typeof im.thumb === 'string' && IMAGE_URL.test(im.thumb)));
}

/** An imported STL's field { tris, w, h, d, cell, ext, src }, as stored in a project or the autosave. */
export function validMesh(m) {
  const dim = v => isInt(v) && v > 0 && v <= MESH_MAX_DIM;
  return isObject(m) && dim(m.w) && dim(m.h) && dim(m.d) && m.w * m.h * m.d <= MESH_MAX_CELLS &&
    isInt(m.tris) && m.tris >= 0 && isNum(m.cell) && m.cell > 0 && vec(3)(m.ext) &&
    typeof m.src === 'string' && BASE64.test(m.src);
}

/** The project in `data`, checked; throws with a message for the user if anything is off. */
export function checkProject(data) {
  if (!isObject(data)) throw new Error('non è un progetto');
  const objects = data.objects ?? [];
  if (!Array.isArray(objects)) throw new Error('elenco oggetti non valido');
  objects.forEach(checkObject);
  const ids = new Map(objects.map(o => [o.id, o]));
  if (ids.size !== objects.length) throw new Error('id ripetuti');
  // A parent chain that loops would hang every walk up the tree.
  for (const o of objects) {
    const seen = new Set();
    for (let p = o; p?.parent != null; p = ids.get(p.parent)) {
      if (seen.has(p.id)) throw new Error(`oggetto ${o.id}: gruppi annidati in cerchio`);
      seen.add(p.id);
    }
  }
  if (data.nextId !== undefined && !isInt(data.nextId)) throw new Error('nextId non valido');
  for (const [what, items, ok] of [['immagine', data.images, validImage], ['modello', data.meshes, validMesh]]) {
    if (items === undefined) continue;
    if (!isObject(items)) throw new Error(`elenco ${what} non valido`);
    for (const [k, v] of Object.entries(items)) if (!ok(v)) throw new Error(`${what} "${k}" non valido`);
  }
  return data;
}
