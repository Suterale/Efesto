"""Core SDF node: a vectorized distance function plus an axis-aligned bounding box.

Convention: f(p) < 0 inside, > 0 outside, == 0 on the surface.
Every function takes points of shape (N, 3) and returns distances of shape (N,).
"""

import numpy as np


class Bounds:
    """Axis-aligned bounding box, used to decide where the mesher samples."""

    def __init__(self, lo, hi):
        self.lo = np.asarray(lo, dtype=float)
        self.hi = np.asarray(hi, dtype=float)

    def union(self, other):
        return Bounds(np.minimum(self.lo, other.lo), np.maximum(self.hi, other.hi))

    def intersection(self, other):
        lo = np.maximum(self.lo, other.lo)
        hi = np.minimum(self.hi, other.hi)
        return Bounds(lo, np.maximum(lo, hi))

    def expand(self, amount):
        return Bounds(self.lo - amount, self.hi + amount)

    def corners(self):
        return np.array([[x, y, z]
                         for x in (self.lo[0], self.hi[0])
                         for y in (self.lo[1], self.hi[1])
                         for z in (self.lo[2], self.hi[2])])

    def transformed(self, fn):
        """Bounds of the 8 corners after applying a point transform fn."""
        c = fn(self.corners())
        return Bounds(c.min(axis=0), c.max(axis=0))

    def __repr__(self):
        return f"Bounds(lo={self.lo.tolist()}, hi={self.hi.tolist()})"


def _rotation_matrix(axis, angle_deg):
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    a = np.radians(angle_deg)
    x, y, z = axis
    c, s, t = np.cos(a), np.sin(a), 1 - np.cos(a)
    return np.array([
        [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ])


class SDF:
    def __init__(self, fn, bounds):
        self.fn = fn
        self.bounds = bounds

    def __call__(self, p):
        return self.fn(np.asarray(p, dtype=float))

    # ---- booleans -------------------------------------------------------

    def union(self, other, k=0.0):
        a, b = self.fn, other.fn
        if k <= 0:
            return SDF(lambda p: np.minimum(a(p), b(p)), self.bounds.union(other.bounds))

        def fn(p):
            da, db = a(p), b(p)
            h = np.clip(0.5 + 0.5 * (db - da) / k, 0, 1)
            return db + (da - db) * h - k * h * (1 - h)
        return SDF(fn, self.bounds.union(other.bounds).expand(k))

    def intersection(self, other, k=0.0):
        a, b = self.fn, other.fn
        if k <= 0:
            return SDF(lambda p: np.maximum(a(p), b(p)), self.bounds.intersection(other.bounds))

        def fn(p):
            da, db = a(p), b(p)
            h = np.clip(0.5 - 0.5 * (db - da) / k, 0, 1)
            return db + (da - db) * h + k * h * (1 - h)
        return SDF(fn, self.bounds.intersection(other.bounds))

    def difference(self, other, k=0.0):
        a, b = self.fn, other.fn
        if k <= 0:
            return SDF(lambda p: np.maximum(a(p), -b(p)), self.bounds)

        def fn(p):
            da, db = a(p), -b(p)
            h = np.clip(0.5 - 0.5 * (db - da) / k, 0, 1)
            return db + (da - db) * h + k * h * (1 - h)
        return SDF(fn, self.bounds)

    __or__ = union
    __and__ = intersection
    __sub__ = difference

    # ---- modifiers ------------------------------------------------------

    def offset(self, d):
        """Grow (d > 0) or shrink (d < 0) the shape by d. Also rounds convex edges."""
        f = self.fn
        return SDF(lambda p: f(p) - d, self.bounds.expand(max(d, 0)))

    def shell(self, thickness):
        """Hollow the shape, keeping a wall of the given thickness centred on the surface."""
        f = self.fn
        return SDF(lambda p: np.abs(f(p)) - thickness / 2, self.bounds.expand(thickness / 2))

    # ---- transforms -----------------------------------------------------

    def translate(self, x=0.0, y=0.0, z=0.0):
        v = np.array([x, y, z], dtype=float)
        f = self.fn
        return SDF(lambda p: f(p - v), self.bounds.transformed(lambda c: c + v))

    def rotate(self, angle_deg, axis=(0, 0, 1)):
        m = _rotation_matrix(axis, angle_deg)
        f = self.fn
        # Rotating the shape by M == evaluating the field at M^-1 p (row vectors: p @ M).
        return SDF(lambda p: f(p @ m), self.bounds.transformed(lambda c: c @ m.T))

    def scale(self, s):
        """Uniform scale keeps an exact distance field; non-uniform gives a conservative bound."""
        s = np.broadcast_to(np.asarray(s, dtype=float), (3,))
        f = self.fn
        smin = s.min()
        return SDF(lambda p: f(p / s) * smin, self.bounds.transformed(lambda c: c * s))

    # ---- output ---------------------------------------------------------

    def mesh(self, step=None, samples=2 ** 22):
        from .mesh import generate
        return generate(self, step=step, samples=samples)

    def save(self, path, step=None, samples=2 ** 22):
        from .mesh import generate, save_stl
        verts, faces = generate(self, step=step, samples=samples)
        save_stl(path, verts, faces)
        return verts, faces
