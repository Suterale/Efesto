import sys
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdfcad import box, cylinder, sphere  # noqa: E402


def _mesh(sdf, step=0.02):
    v, f = sdf.mesh(step=step)
    return trimesh.Trimesh(v, f, process=True)


def test_sphere_distance_exact():
    s = sphere(1.0)
    assert np.allclose(s([[0, 0, 0], [2, 0, 0], [0, 1, 0]]), [-1, 1, 0])


def test_sphere_volume_and_watertight():
    m = _mesh(sphere(1.0))
    assert m.is_watertight
    assert m.volume > 0  # outward normals
    assert abs(m.volume - 4 / 3 * np.pi) / (4 / 3 * np.pi) < 0.01


def test_box_minus_cylinder_volume():
    part = box(2) - cylinder(0.5, 3)
    m = _mesh(part)
    expected = 8 - np.pi * 0.25 * 2
    assert m.is_watertight
    assert abs(m.volume - expected) / expected < 0.01


def test_translate_and_rotate():
    s = sphere(0.5).translate(x=2).rotate(90, (0, 0, 1))
    assert np.isclose(s([[0, 2, 0]])[0], -0.5)  # (2,0,0) rotated 90 deg about Z -> (0,2,0)
    lo, hi = s.bounds.lo, s.bounds.hi
    assert lo[1] <= 1.5 and hi[1] >= 2.5


def test_stl_roundtrip(tmp_path):
    path = tmp_path / "s.stl"
    sphere(1.0).save(path, step=0.05)
    m = trimesh.load(path)
    assert m.is_watertight and m.volume > 0
