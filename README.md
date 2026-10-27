# SDF CAD

A Tinkercad-style 3D editor built on signed distance fields (SDFs), with STL export.

## Install as an app

Open the editor in Chrome or Edge and click the **Install** icon at the right of the address bar (in Safari:
**File → Add to Dock**). SDF CAD then has its own icon and window, and works offline. Projects are saved as
`.json` files wherever you choose.

## Editor (app/)

Double-click `Avvia CAD.command`, or run:

```sh
python3 server.py
```

and open http://127.0.0.1:8765/. Everything runs in the browser; three.js is vendored in `app/vendor`, so it works offline.
`server.py` serves `app/` and keeps project files in `progetti/` (local only: it refuses requests from other sites).

- Add shapes (box, sphere, cylinder, cone, torus) or holes from the left panel.
- Move / rotate / scale with the gizmo (W / E / R), or type exact values in the properties panel.
- **Perno** (pivot, O): drag the gizmo to move the point an object rotates and scales around, without moving the
  object. The properties panel also sets it numerically (offset from the centre, local axes) or snaps it per axis to
  the − face, centre or + face. "Posizione" is the pivot's position.
- **Testo**: 3D text, typed in the properties panel (Enter for a new line). Fonts: Inter (sans), Lora (serif),
  JetBrains Mono (mono), Space Grotesk, Orbitron, Rajdhani, VT323; bold / italic and line alignment. The letters keep
  their size when the text changes; Dimensioni stretches them. Switch it to Foro to engrave text into a solid.
  Fonts are vendored (SIL OFL) in `app/vendor/fonts`, so the same text gives the same STL on any machine.
- **Immagine**: import a PNG / JPEG as a reference (button, or drag files onto the view). It is an object like the
  others (move / rotate / scale, group, duplicate, undo) but is never part of the solid or the STL. Orienta lays it on
  the workplane or stands it up facing front / side; proportions can be locked; opacity, "Sopra i solidi" (shows
  through the model) and "Bloccata" (clicks pass through it; select it from the list). Pictures are downscaled to
  2048 px and saved inside the project file.
- **Importa STL**: load a binary or ASCII STL (button, or drag the file onto the view). The model becomes a normal
  solid: move / rotate / scale (non-uniform too), make it a hole, union / intersect it, fillet it with Fusione, and it
  is part of the exported STL. It is converted to a 3D distance field (128 cells along its longest side), so details
  smaller than about 1/120 of the model are rounded off; units are read as mm. "Dimensioni originali" restores the
  file's size. Closed (watertight) meshes work best; small gaps are tolerated. The field is saved in the project file.
  The preview draws up to 4 different models (copies share one); more show as boxes until removed, but export is exact.
- Holes are subtracted from all solids; "Fusione" gives a smooth fillet with the other objects.
- Shift+click (viewport or list) to multi-select, then combine: **Gruppo** (move together, Cmd+G),
  **Unione** (one solid; holes inside only cut the group) or **Intersezione** (keep only the shared volume).
  Click a group again to edit its parts, Esc steps back out, Cmd+Shift+G ungroups. Groups can be holes too.
- The viewport is GPU raymarched straight from the SDF, so booleans and fillets are live.
- "Esporta STL…" meshes the SDF with surface nets (closed, outward-facing, Z-up, mm), then opens a **mesh preview**:
  flat-shaded surface and/or triangle wireframe, orbit/zoom, triangle/volume/closed-surface stats. The **Ottimizza
  triangoli** slider (or the Leggera / Media / Forte presets) decimates with quadric edge collapse (`app/js/simplify.js`):
  flat areas lose most triangles, the mesh stays closed. It always restarts from the original mesh. Esporta STL saves
  what the preview shows.
- Undo/redo. Autosave in the browser (IndexedDB, so pictures and imported models fit too).
- **Salva** (Cmd+S) / **Salva come…** (Cmd+Shift+S) / **Apri** (Cmd+O): projects are JSON files in `progetti/`. Salva
  asks for a name once, then overwrites that file, in any browser; Apri lists the folder ("Altro file…" opens one from
  elsewhere, and Salva then copies it into the folder). Served without `server.py` (any static server), Chrome / Edge
  overwrite a file picked on disk and Safari / Firefox download a copy instead. The top bar shows the file name,
  with • for unsaved changes.
- **Stile** (top bar, or press T to cycle): Retro Win 95, Cyberpunk, Apple, ASCII, Skeuomorfico, Neo-brutalismo, Y2K.
  A style re-skins the panels, icons and the 3D view (lighting, grid, selection colour); the choice is remembered.
  To add one: a `[data-theme=...]` block in `app/css/themes.css` plus an entry in `app/js/themes.js`.

Code: `app/js/sdf.js` (kernel: GLSL codegen + JS evaluator), `app/js/mesher.js` (surface nets + STL),
`app/js/text.js` (text → 2D distance field), `app/js/stl.js` (STL → 3D distance field), `app/js/main.js` (UI), `app/js/themes.js` + `app/css/themes.css` (styles), `app/js/ascii.js` (ASCII render pass). Tests: `node app/test/mesher.test.mjs`.

## Python kernel (sdfcad/)

The original scripting prototype; same ideas, used from Python code.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Usage

```python
from sdfcad import box, sphere, cylinder

hole = cylinder(0.35, 3)
part = (box(2, radius=0.1) & sphere(1.3)) - hole - hole.rotate(90, (1, 0, 0))
part.save("part.stl", step=0.02)   # step = grid spacing in model units
```

- Primitives: `sphere`, `box` (optional rounded edges), `cylinder`, `capsule`, `torus`
- Booleans: `a | b` (union), `a & b` (intersection), `a - b` (difference)
  - Smooth variants: `a.union(b, k=0.3)`, `a.intersection(b, k=...)`, `a.difference(b, k=...)`
- Modifiers: `.offset(d)`, `.shell(thickness)`
- Transforms: `.translate(x, y, z)`, `.rotate(deg, axis)`, `.scale(s)`

Run the demo with `.venv/bin/python examples/demo.py`, which writes STLs to `out/`. Run the tests with `.venv/bin/pytest`.

## How it works

1. Each shape is an `SDF` node: a vectorized function `f(points[N,3]) -> distances[N]` plus a bounding box.
2. `mesh.generate` samples the field on a regular grid over the bounds and runs marching cubes from scikit-image.
3. `mesh.save_stl` writes a binary STL with outward-facing normals.

## Known limitations

- Marching cubes rounds off sharp edges, slightly; the size of the error is about the grid step.
- Smooth booleans and non-uniform scale produce bounds rather than exact distances. This is fine for meshing.
- Grids are dense, so cost grows as (size/step)^3.
