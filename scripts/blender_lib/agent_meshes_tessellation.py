"""Freeze Blender's rest-surface triangles before cutting or thickening skin."""
from numbers import Integral
import numpy as np


def triangulate_surface(vertices, faces):
    """Return faces and their source polygon indices without moving vertices.

    Uses Blender's loop triangles, matching the rest mesh's render tessellation.
    Reuse these indices for every pose and for both sides of an offset shell.
    Cut clothing from these donor triangles, not independently tessellated
    copies of warped quads. No mesh/object or caller data is retained or changed.
    Blender is required for non-triangle input; triangle input is returned as-is.
    """
    try:
        points=np.asarray(vertices,dtype=float)
        polygons=[tuple(p) for p in faces]
    except (ValueError,TypeError) as exc:
        raise ValueError('Finite vertices and valid polygon indices required') from exc
    if points.ndim!=2 or points.shape[1]!=3 or not len(points) or not np.isfinite(points).all() or np.max(abs(points))>np.finfo(np.float32).max:
        raise ValueError('Vertices must be a finite nonempty Nx3 array representable by Blender')
    if not polygons or any(len(p)<3 or any(
            isinstance(i,bool) or not isinstance(i,Integral) or i<0 or i>=len(points) for i in p) or len(set(p))!=len(p) for p in polygons):
        raise ValueError('Faces require distinct valid vertex indices')
    polygons=[tuple(int(i) for i in p) for p in polygons]
    if all(len(p)==3 for p in polygons):
        return {'faces':polygons,'source_faces':list(range(len(polygons)))}
    import bpy
    mesh=bpy.data.meshes.new('surface-tessellation')
    try:
        mesh.from_pydata(points.tolist(),[],polygons)
        mesh.calc_loop_triangles()
        triangles=[tuple(t.vertices) for t in mesh.loop_triangles]
        parents=[int(t.polygon_index) for t in mesh.loop_triangles]
        if len(triangles)!=sum(len(p)-2 for p in polygons):
            raise ValueError('Surface could not be completely triangulated')
        return {'faces':triangles,'source_faces':parents}
    finally:
        bpy.data.meshes.remove(mesh)
