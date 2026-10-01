"""Choose rest-space offset directions using sampled skin deformation."""
import numpy as np
from numbers import Integral, Real
from agent_meshes_garment_fit import _points, _faces, _weights


def _unit(values, label):
    scale = np.max(np.abs(values), axis=-1)
    if not np.isfinite(values).all() or np.any(scale == 0):
        raise ValueError(f'{label} must be finite and nonzero')
    scaled = values / scale[..., None]
    return scaled / np.linalg.norm(scaled, axis=-1)[..., None]


def fit_offset_directions(vertices, faces, normals, weights, poses, *, iterations=1000,
                          margins=(.05, .025, .0125, .00625, .003125)):
    """Return unit rest-space directions and an honest sampled alignment report.

    All source geometry and normals share a rest frame. Faces must be fixed
    triangles. ``poses`` supplies nonempty bone-name -> affine 4x4 skin-deform
    matrices including inverse bind; identity/rest is added as sample zero.
    Weights are normalized without pruning (one to four influences per vertex).
    Inputs are not modified. Collapsed triangles or pulled directions raise
    ValueError naming the pose, including collapse caused by blended transforms.

    Each constraint pulls an oriented posed incident-face normal back through
    the vertex's blended linear transform. Positive dot product means an offset
    initially points outward relative to that face. Constraints are normalized
    in rest space; their dot products are NOT posed-space cosines under general
    affine deformation, a physical clearance distance, or a collision test.

    Directions already meeting margins[0] remain unchanged after normalization.
    Others use bounded halfspace projection, restarting from the original normal
    for each decreasing margin. A .25 original-normal projection preference and
    length cap 2 limit departure; these are search heuristics, not proof that a
    feasible direction will be found. ``iterations`` limits projection steps per
    margin and vertex. A raw margin is tested with relative tolerance 1e-4 before
    unit normalization, so it is not a lower bound on returned unit alignment.

    Check report['converged']. Unresolved vertices retain their original unit
    normals and are listed explicitly; failure means this search did not resolve
    them, not mathematical infeasibility. Isolated vertices retain their normals
    and appear in unconstrained_vertices. Per-attempt diagnostics include the
    selected/final attempted margin, projection steps and actual initial/final
    alignment. Pose-dependent constraints are retained only for candidate corners.
    There is no global collision, containment, between-sample or visual guarantee.
    Follow with fit_surface_offsets and inspect the final exported animation.
    """
    if isinstance(iterations, bool) or not isinstance(iterations, Integral) or iterations < 0:
        raise ValueError('iterations must be a nonnegative integer')
    if not isinstance(margins, (list, tuple)) or not margins or any(
            isinstance(m, bool) or not isinstance(m, Real) or not np.isfinite(m) or not 0 < m <= 1
            for m in margins) or any(a <= b for a, b in zip(margins, margins[1:])):
        raise ValueError('margins must be a strictly decreasing nonempty list in (0, 1]')
    margins = tuple(float(m) for m in margins)
    source = _points(vertices, 'vertices')
    polygons = _faces(faces, len(source), 'faces')
    if any(len(face) != 3 for face in polygons):
        raise ValueError('faces must be triangles; freeze source tessellation before fitting')
    triangles = np.asarray(polygons, dtype=int)
    normal = _points(normals, 'normals')
    if normal.shape != source.shape:
        raise ValueError('normals must match vertices')
    original = _unit(normal, 'normals')
    rows = _weights(weights, len(source), 'weights')
    directions = original.copy()
    names = sorted({name for row in rows for name, value in row.items() if value > 0})
    weight_array = np.array([[row.get(name, 0) for name in names] for row in rows])
    if not isinstance(poses, (list, tuple)) or not poses:
        raise ValueError('poses must be a nonempty list of bone matrix dictionaries')
    matrices = [np.array([np.eye(4) for _ in names])]
    for pose in poses:
        if not isinstance(pose, dict) or any(name not in pose for name in names):
            raise ValueError('every pose must provide matrices for all used bones')
        validated = {}
        for name, value in pose.items():
            try:
                matrix = np.asarray(value, dtype=float)
            except (TypeError, ValueError) as exc:
                raise ValueError('pose matrices must be finite nonsingular affine 4x4 arrays') from exc
            if not isinstance(name, str) or not name or matrix.shape != (4, 4) or not np.isfinite(matrix).all() or not np.allclose(
                    matrix[3], [0, 0, 0, 1], rtol=0, atol=1e-10) or np.linalg.slogdet(matrix[:3, :3])[0] == 0:
                raise ValueError('pose matrices must be finite nonsingular affine 4x4 arrays')
            validated[name] = matrix
        matrices.append(np.array([validated[name] for name in names]))
    homogeneous = np.column_stack((source, np.ones(len(source))))

    def coefficients(matrix, pose_index):
        with np.errstate(over='ignore', invalid='ignore'):
            blend = np.einsum('vb,bij->vij', weight_array, matrix)
            points = np.einsum('vij,vj->vi', blend, homogeneous)[:, :3]
            t = points[triangles]
            normal = _unit(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]),
                           f'triangle normals at pose {pose_index}')
            pulled = np.einsum('fcij,fi->fcj', blend[triangles, :3, :3], normal)
            return _unit(pulled, f'pulled directions at pose {pose_index}')

    # First scan identifies vertices needing work without retaining every pose.
    initial = np.full(len(source), np.inf)
    for index, matrix in enumerate(matrices):
        alignment = np.einsum('fci,fci->fc', coefficients(matrix, index), original[triangles])
        np.minimum.at(initial, triangles.ravel(), alignment.ravel())
    candidates = np.flatnonzero(initial < margins[0])
    corner_faces, corners = np.nonzero(np.isin(triangles, candidates))
    corner_vertices = triangles[corner_faces, corners]
    constraints = (np.array([coefficients(matrix, index)[corner_faces, corners]
                            for index, matrix in enumerate(matrices)]) if len(candidates) else None)
    details, changed, unresolved = [], [], []
    for vertex in candidates:
        constraints_here = constraints[:, corner_vertices == vertex, :].reshape(-1, 3)
        solved = False
        steps = 0
        margin = None
        for margin in margins:
            x = original[vertex].copy()
            for _ in range(iterations):
                dot = constraints_here @ x
                worst = int(np.argmin(dot))
                if dot[worst] >= margin * .9999:
                    solved = True
                    break
                x += (margin - dot[worst]) * constraints_here[worst]
                outward = float(x @ original[vertex])
                if outward < .25:
                    x += (.25 - outward) * original[vertex]
                length = np.linalg.norm(x)
                if length > 2:
                    x *= 2 / length
                steps += 1
            # Check the last permitted projection too; exhaustion alone is not failure.
            solved = bool(np.min(constraints_here @ x) >= margin * .9999)
            if solved:
                break
        if solved:
            directions[vertex] = x / np.linalg.norm(x)
            changed.append(int(vertex))
        else:
            unresolved.append(int(vertex))
        details.append({'vertex': int(vertex), 'resolved': solved, 'margin': margin,
                        'projection_steps': steps, 'initial_alignment': float(initial[vertex]),
                        'final_alignment': float(np.min(constraints_here @ directions[vertex]))})
    return {'directions': directions, 'report': {
        'converged': not unresolved, 'changed_vertices': changed,
        'unresolved_vertices': unresolved,
        'unconstrained_vertices': np.flatnonzero(np.isinf(initial)).tolist(),
        'vertices': details, 'samples': len(matrices)}}
