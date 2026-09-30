"""Fit garment normal offsets against explicit linear-blend skinning samples.

BVH triangle intersections are a discrete surface diagnostic. A converged result
does not establish continuous animation clearance, detect contained volumes, or
prove visual fit. Blender is needed only when fit_surface_offsets is called.
"""
from numbers import Integral, Real
import numpy as np


def _points(values, label):
    try:
        points = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{label} must be a finite nonempty Nx3 array') from exc
    if points.ndim != 2 or points.shape[1] != 3 or not len(points) or not np.isfinite(points).all():
        raise ValueError(f'{label} must be a finite nonempty Nx3 array')
    return points.copy()


def _faces(values, count, label):
    try:
        faces = [tuple(face) for face in values]
    except TypeError as exc:
        raise ValueError(f'{label} must contain polygons') from exc
    if not faces or any(len(face) < 3 or any(isinstance(i, bool) or not isinstance(i, Integral)
            or i < 0 or i >= count for i in face) or len(set(face)) != len(face) for face in faces):
        raise ValueError(f'{label} must contain polygons with distinct valid vertex indices')
    return [tuple(int(i) for i in face) for face in faces]


def _weights(values, count, label):
    if not isinstance(values, (list, tuple)) or len(values) != count:
        raise ValueError(f'{label} requires one weight dictionary per vertex')
    rows = []
    for row in values:
        if not isinstance(row, dict) or not 1 <= len(row) <= 4 or any(
                not isinstance(name, str) or not name or isinstance(weight, bool)
                or not isinstance(weight, Real) or not np.isfinite(weight) or weight < 0
                for name, weight in row.items()) or max(row.values()) <= 0:
            raise ValueError(f'{label} requires one to four named nonnegative finite weights with positive total')
        # Scaling first also handles very large finite weights without overflow.
        largest = max(row.values())
        scaled = {name: float(weight / largest) for name, weight in row.items()}
        total = sum(scaled.values())
        rows.append({name: weight / total for name, weight in scaled.items()})
    return rows


def _shell_faces(faces, count):
    """Close an orientable manifold surface; refuse ambiguous boundary topology."""
    edges = {}
    incident = {}
    for fi, face in enumerate(faces):
        for vertex in face:
            incident.setdefault(vertex, set()).add(fi)
        for a, b in zip(face, face[1:] + face[:1]):
            edges.setdefault(tuple(sorted((a, b))), []).append((a, b, fi))
    boundaries = []
    boundary_degree = {}
    face_neighbors = {fi: set() for fi in range(len(faces))}
    for uses in edges.values():
        if len(uses) > 2 or (len(uses) == 2 and uses[0][:2] != uses[1][:2][::-1]):
            raise ValueError('thickness requires an orientable manifold surface with consistent winding')
        if len(uses) == 1:
            a, b, _ = uses[0]
            boundaries.append((a, b))
            for vertex in (a, b):
                boundary_degree[vertex] = boundary_degree.get(vertex, 0) + 1
        else:
            first, second = uses[0][2], uses[1][2]
            face_neighbors[first].add(second)
            face_neighbors[second].add(first)
    if any(degree != 2 for degree in boundary_degree.values()):
        raise ValueError('thickness requires manifold boundary loops')
    # Edge checks alone miss pinched vertices with two disconnected face fans.
    for vertex, fan in incident.items():
        visited = set()
        pending = [min(fan)]
        while pending:
            fi = pending.pop()
            if fi not in visited:
                visited.add(fi)
                pending.extend((face_neighbors[fi] & fan) - visited)
        if visited != fan:
            raise ValueError(f'thickness requires a manifold face fan at vertex {vertex}')
    inner = [tuple(i + count for i in reversed(face)) for face in faces]
    rims = [(b, a, a + count, b + count) for a, b in boundaries]
    return faces + inner + rims


def fit_surface_offsets(vertices, faces, normals, weights, reference_vertices,
                        reference_faces, reference_weights, poses, *, offset,
                        minimum_offset, thickness=0, iterations=24):
    """Return fitted vertices/faces/weights, source offsets and a collision report.

    All geometry shares a rest coordinate frame. ``poses`` is a nonempty list of
    bone-name -> affine 4x4 skin-deform matrices (already including inverse bind).
    Identity/rest is automatically added. Every used bone must exist in every
    supplied pose. Normals and weight totals are normalized without influence
    pruning; more than four influences is an error. Inputs are never modified.

    Offsets start at ``offset`` and only decrease, never below ``minimum_offset``.
    A reduction multiplies colliding vertices' offsets by .72, then diffuses the
    decrease conservatively across edges for ten passes. ``iterations`` is the
    maximum number of reductions; zero performs only an intersection check.

    Positive thickness creates a closed shell along supplied normals at the
    fitted offsets +/- thickness/2, duplicating weights. The outer vertices come
    first, then inner vertices; outer faces retain winding, inner faces reverse
    it, and boundary edges receive rims. No modifier recomputes the normals.
    Shell input must have manifold, consistently wound topology. Surface mode
    keeps the original topology. minimum_offset must exceed thickness/2.

    ``report`` gives per-pose maximum body and nonadjacent self-intersection pair
    counts, initially and after fitting. Faces sharing a vertex are excluded
    from self tests. Peak pose indices use zero for the automatic rest sample,
    then supplied pose index + 1 (None if clear; first sample wins a peak tie).
    ``history`` includes the initial check and each reduction. Up to three final
    pair examples from each peak sample identify output faces and source vertex
    indices, their offsets, and whether all those vertices reached the minimum.
    Convergence applies only to sampled surface intersections:
    no containment, between-sample, distance-clearance or aesthetic guarantee.
    """
    for name, value in [('offset', offset), ('minimum_offset', minimum_offset), ('thickness', thickness)]:
        if isinstance(value, bool) or not isinstance(value, Real) or not np.isfinite(value):
            raise ValueError(f'{name} must be finite')
    if thickness < 0 or minimum_offset <= thickness / 2 or offset < minimum_offset:
        raise ValueError('require thickness >= 0 and offset >= minimum_offset > thickness/2')
    if isinstance(iterations, bool) or not isinstance(iterations, Integral) or iterations < 0:
        raise ValueError('iterations must be a nonnegative integer')
    source = _points(vertices, 'vertices')
    normal = _points(normals, 'normals')
    if normal.shape != source.shape:
        raise ValueError('normals must match vertices')
    scale = np.max(np.abs(normal), axis=1)
    if np.any(scale == 0):
        raise ValueError('normals must be nonzero')
    normal /= scale[:, None]
    normal /= np.linalg.norm(normal, axis=1)[:, None]
    polygons = _faces(faces, len(source), 'faces')
    rows = _weights(weights, len(source), 'weights')
    body = _points(reference_vertices, 'reference_vertices')
    body_faces = _faces(reference_faces, len(body), 'reference_faces')
    body_rows = _weights(reference_weights, len(body), 'reference_weights')
    names = sorted({name for row in rows + body_rows for name, value in row.items() if value > 0})
    if not isinstance(poses, (list, tuple)) or not poses:
        raise ValueError('poses must be a nonempty list of bone matrix dictionaries')
    matrices = [np.array([np.eye(4) for _ in names])]
    for pose in poses:
        if not isinstance(pose, dict) or any(name not in pose for name in names):
            raise ValueError('every pose must provide matrices for all used bones')
        # Validate extra matrices too, so malformed supplied animation is visible.
        validated = {}
        for name, value in pose.items():
            try:
                matrix = np.asarray(value, dtype=float)
            except (ValueError, TypeError) as exc:
                raise ValueError('pose matrices must be finite affine 4x4 arrays') from exc
            if not isinstance(name, str) or not name or matrix.shape != (4, 4) or not np.isfinite(matrix).all() or not np.allclose(
                    matrix[3], [0, 0, 0, 1], rtol=0, atol=1e-10) or np.linalg.det(matrix[:3, :3]) == 0:
                raise ValueError('pose matrices must be finite nonsingular affine 4x4 arrays')
            validated[name] = matrix
        matrices.append(np.array([validated[name] for name in names]))

    output_faces = _shell_faces(polygons, len(source)) if thickness else polygons
    face_sets = [set(face) for face in output_faces]
    edge_pairs = sorted({tuple(sorted((a, b))) for face in polygons for a, b in zip(face, face[1:] + face[:1])})
    a, b = np.array(edge_pairs, dtype=int).T
    degree = np.bincount(np.concatenate((a, b)), minlength=len(source))
    source_weights = np.array([[row.get(name, 0) for name in names] for row in rows])
    reference_weights_array = np.array([[row.get(name, 0) for name in names] for row in body_rows])
    source_h = np.column_stack((source, np.ones(len(source))))
    body_h = np.column_stack((body, np.ones(len(body))))
    from mathutils.bvhtree import BVHTree
    samples = []
    for matrix in matrices:
        blend = np.einsum('vb,bij->vij', source_weights, matrix)
        base = np.einsum('vij,vj->vi', blend, source_h)[:, :3]
        direction = np.einsum('vij,vj->vi', blend[:, :3, :3], normal)
        body_blend = np.einsum('vb,bij->vij', reference_weights_array, matrix)
        body_points = np.einsum('vij,vj->vi', body_blend, body_h)[:, :3]
        if not all(np.isfinite(points).all() for points in (base, direction, body_points)):
            raise ValueError('posed geometry must remain finite')
        samples.append((base, direction, BVHTree.FromPolygons(body_points.tolist(), body_faces)))

    def geometry(base, direction, limits):
        if thickness:
            return np.concatenate((base + direction * (limits[:, None] + thickness / 2),
                                   base + direction * (limits[:, None] - thickness / 2)))
        return base + direction * limits[:, None]

    def collisions(limits):
        bad = set()
        max_body = max_self = 0
        peak_body = peak_self = None
        body_examples = self_examples = []

        def example_vertices(face_ids):
            ids = sorted({vertex % len(source) for fi in face_ids for vertex in output_faces[fi]})
            return {'source_vertices': ids, 'offsets': limits[ids].tolist(),
                    'all_vertices_at_minimum': bool(np.all(limits[ids] == minimum_offset))}

        for pose_index, (base, direction, body_tree) in enumerate(samples):
            points = geometry(base, direction, limits)
            if not np.isfinite(points).all():
                raise ValueError('offset geometry must remain finite')
            tree = BVHTree.FromPolygons(points.tolist(), output_faces)
            body_pairs = body_tree.overlap(tree)
            self_pairs = [(i, j) for i, j in tree.overlap(tree) if i < j and face_sets[i].isdisjoint(face_sets[j])]
            if len(body_pairs) > max_body:
                max_body, peak_body = len(body_pairs), pose_index
                body_examples = [dict(pose_index=pose_index, reference_face=i, garment_face=j,
                                      **example_vertices([j])) for i, j in sorted(body_pairs)[:3]]
            if len(self_pairs) > max_self:
                max_self, peak_self = len(self_pairs), pose_index
                self_examples = [dict(pose_index=pose_index, garment_faces=[i, j],
                                      **example_vertices([i, j])) for i, j in sorted(self_pairs)[:3]]
            for _, fi in body_pairs:
                bad.update(vertex % len(source) for vertex in output_faces[fi])
            for i, j in self_pairs:
                bad.update(vertex % len(source) for vertex in output_faces[i] + output_faces[j])
        return bad, {'max_body_pairs': max_body, 'max_self_pairs': max_self,
                     'peak_body_pose': peak_body, 'peak_self_pose': peak_self,
                     'body_pair_examples': body_examples, 'self_pair_examples': self_examples,
                     'colliding_vertices': len(bad),
                     'colliding_vertices_at_minimum': int(sum(limits[i] == minimum_offset for i in bad))}

    def history_entry(iteration, diagnostic):
        return {'iteration': iteration, **{key: value for key, value in diagnostic.items()
                                          if key not in ('body_pair_examples', 'self_pair_examples')}}

    limits = np.full(len(source), float(offset))
    bad, diagnostic = collisions(limits)
    initial = diagnostic.copy()
    history = [history_entry(0, diagnostic)]
    performed = 0
    reason = 'iteration_limit'
    while bad and performed < iterations:
        previous = limits.copy()
        selected = sorted(bad)
        limits[selected] = np.maximum(minimum_offset, limits[selected] * .72)
        for _ in range(10):
            total = np.bincount(np.concatenate((a, b)), weights=np.concatenate((limits[b], limits[a])), minlength=len(source))
            average = np.divide(total, degree, out=limits.copy(), where=degree > 0)
            limits = np.maximum(minimum_offset, np.minimum(limits, .5 * limits + .5 * average))
        performed += 1
        bad, diagnostic = collisions(limits)
        history.append(history_entry(performed, diagnostic))
        if np.array_equal(previous, limits):
            reason = 'minimum_offset_reached'
            break
    if not bad:
        reason = 'sampled_surfaces_clear'
    elif diagnostic['colliding_vertices_at_minimum'] == len(bad):
        reason = 'minimum_offset_reached'
    return {
        'vertices': [tuple(point) for point in geometry(source, normal, limits).tolist()],
        'faces': output_faces,
        'weights': [dict(row) for row in (rows + rows if thickness else rows)],
        'offsets': limits.tolist(),
        'report': {'converged': not bad, 'iterations': performed, 'sampled_poses': len(samples),
                   'initial_max_body_pairs': initial['max_body_pairs'],
                   'initial_max_self_pairs': initial['max_self_pairs'],
                   'initial_peak_body_pose': initial['peak_body_pose'],
                   'initial_peak_self_pose': initial['peak_self_pose'],
                   **diagnostic, 'reason': reason, 'history': history},
    }
