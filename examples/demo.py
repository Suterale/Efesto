"""Build a few parts and export them to STL in ./out."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdfcad import box, capsule, cylinder, sphere, torus  # noqa: E402

out = Path(__file__).resolve().parent.parent / "out"
out.mkdir(exist_ok=True)

# 1. Classic CSG: rounded box intersected with a sphere, minus three orthogonal cylinders.
hole = cylinder(0.35, 3)
csg = (box(2, radius=0.1) & sphere(1.3)) - hole - hole.rotate(90, (1, 0, 0)) - hole.rotate(90, (0, 1, 0))

# 2. Mounting bracket: plate with two holes, a fused boss, smooth fillet between them.
plate = box((6, 3, 0.5), radius=0.1)
boss = cylinder(0.9, 2).translate(z=1)
bolt = cylinder(0.3, 1).translate(x=2.2)
bracket = plate.union(boss, k=0.4) - cylinder(0.5, 5) - bolt - bolt.translate(x=-4.4)

# 3. Organic blob: smooth union of a torus and capsules, then hollowed out.
blob = torus(1.5, 0.4).union(capsule(0.5, 2.5).rotate(90, (1, 0, 0)), k=0.5)
blob = blob.union(sphere(0.6).translate(z=0.4), k=0.6).shell(0.1)

for name, part in [("csg", csg), ("bracket", bracket), ("blob", blob)]:
    verts, faces = part.save(out / f"{name}.stl", step=0.02)
    print(f"{name:8s} -> {out / (name + '.stl')}  ({len(faces):,} triangles)")
