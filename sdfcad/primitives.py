"""Primitive shapes, all centred on the origin. Exact SDFs (see Inigo Quilez's catalogue)."""

import numpy as np

from .core import SDF, Bounds


def _length(v):
    return np.linalg.norm(v, axis=-1)


def sphere(radius=1.0):
    r = float(radius)
    return SDF(lambda p: _length(p) - r, Bounds([-r] * 3, [r] * 3))


def box(size=(1.0, 1.0, 1.0), radius=0.0):
    """Box with full edge lengths `size`; `radius` rounds the edges without changing the size."""
    h = np.broadcast_to(np.asarray(size, dtype=float), (3,)) / 2
    r = float(radius)
    inner = h - r

    def fn(p):
        q = np.abs(p) - inner
        outside = _length(np.maximum(q, 0))
        inside = np.minimum(q.max(axis=1), 0)
        return outside + inside - r
    return SDF(fn, Bounds(-h, h))


def cylinder(radius=0.5, height=1.0):
    """Cylinder along Z."""
    r, hh = float(radius), float(height) / 2

    def fn(p):
        d = np.stack([np.hypot(p[:, 0], p[:, 1]) - r, np.abs(p[:, 2]) - hh], axis=1)
        return np.minimum(d.max(axis=1), 0) + _length(np.maximum(d, 0))
    return SDF(fn, Bounds([-r, -r, -hh], [r, r, hh]))


def capsule(radius=0.5, height=1.0):
    """Capsule along Z; `height` is the distance between the two hemisphere centres."""
    r, hh = float(radius), float(height) / 2

    def fn(p):
        q = p.copy()
        q[:, 2] -= np.clip(q[:, 2], -hh, hh)
        return _length(q) - r
    return SDF(fn, Bounds([-r, -r, -hh - r], [r, r, hh + r]))


def torus(major=1.0, minor=0.25):
    """Torus in the XY plane."""
    R, r = float(major), float(minor)

    def fn(p):
        q = np.stack([np.hypot(p[:, 0], p[:, 1]) - R, p[:, 2]], axis=1)
        return _length(q) - r
    return SDF(fn, Bounds([-R - r, -R - r, -r], [R + r, R + r, r]))
