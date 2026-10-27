"""SDF -> triangle mesh (marching cubes) -> STL."""

import numpy as np
from skimage.measure import marching_cubes
from stl import mesh as stl_mesh

# Points evaluated per call, to keep memory bounded on fine grids.
BATCH = 1_000_000


def generate(sdf, step=None, samples=2 ** 22):
    """Sample `sdf` on a regular grid and extract the zero isosurface.

    step:    grid spacing in model units. If None, chosen so the grid has ~`samples` points.
    Returns (verts[N,3], faces[M,3]) with outward-facing, counter-clockwise triangles.
    """
    b = sdf.bounds
    size = b.hi - b.lo
    if step is None:
        step = float(np.cbrt(np.prod(np.maximum(size, 1e-9)) / samples))

    # Pad by a couple of cells so the surface never touches the grid edge (keeps it closed).
    lo = b.lo - 2 * step
    hi = b.hi + 2 * step
    axes = [np.arange(lo[i], hi[i] + step, step) for i in range(3)]
    shape = tuple(len(a) for a in axes)

    X, Y, Z = np.meshgrid(*axes, indexing="ij")
    pts = np.column_stack([X.ravel(), Y.ravel(), Z.ravel()])
    del X, Y, Z
    vol = np.empty(len(pts))
    for i in range(0, len(pts), BATCH):
        vol[i:i + BATCH] = sdf(pts[i:i + BATCH])
    vol = vol.reshape(shape)

    if vol.min() > 0 or vol.max() < 0:
        raise ValueError("SDF has no surface inside its bounds (empty or degenerate shape)")

    verts, faces, _, _ = marching_cubes(vol, level=0.0, spacing=(step, step, step))
    verts += lo
    verts, faces = _weld(verts, faces, tol=step * 1e-6)
    return verts, _orient_outward(verts, faces)


def _weld(verts, faces, tol):
    """Merge coincident vertices and drop the zero-area faces that collapse as a result.

    Marching cubes emits duplicate vertices when the surface passes exactly through a
    grid point. STL readers weld them anyway, so we do it here and keep the mesh manifold.
    """
    keys = np.round(verts / tol).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    faces = inverse.ravel()[faces]
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    return verts[first], faces[ok]


def _orient_outward(verts, faces):
    """Flip winding if the mesh's signed volume is negative (normals pointing inward)."""
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    signed_volume = np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6
    return faces[:, ::-1].copy() if signed_volume < 0 else faces


def save_stl(path, verts, faces):
    m = stl_mesh.Mesh(np.zeros(len(faces), dtype=stl_mesh.Mesh.dtype))
    m.vectors[:] = verts[faces]
    m.update_normals()
    m.save(str(path))
