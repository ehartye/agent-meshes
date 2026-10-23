"""Geodesic voxel skinning — ported from VAST-AI-Research/SkinTokens
(src/data/vertex_group.py, MIT license), itself modified from Dionne & de Lasa,
"Geodesic voxel binding for production character meshes" (2013).

Why: Euclidean KNN weight transfer leaks influence across empty space — outer
fur re-seats onto the body while the leg core slides out (spider), armor plates
bleed onto the torso, and tube bodies get near-binary segments. This computes
per-joint distances GEODESICALLY through a graph of mesh edges + an occupied
voxel grid, so influence follows the solid. Long single-child bones are
subdivided (10 segments) before the distance pass — smooth gradients along
tubes for free.

Pure numpy/scipy (cKDTree + csgraph Dijkstra) — safe in the stable venv, no
open3d (their Asset.voxel() is replaced by a numpy surface voxelization).
"""
from collections import defaultdict

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import shortest_path
from scipy.spatial import cKDTree


def voxelize_surface(vertices, faces, grid, samples=200_000, seed=0):
    """Occupied-cell centers of a surface voxelization, coords in [-1, 1].
    (Replaces SkinTokens' open3d-based Asset.voxel().)"""
    rng = np.random.RandomState(seed)
    v = np.asarray(vertices, np.float64)
    tri = v[np.asarray(faces)]
    areas = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    prob = areas / (areas.sum() or 1.0)
    fi = rng.choice(len(tri), samples, p=prob)
    r1, r2 = rng.rand(samples, 1), rng.rand(samples, 1)
    s = np.sqrt(r1)
    pts = tri[fi, 0] * (1 - s) + tri[fi, 1] * (s * (1 - r2)) + tri[fi, 2] * (s * r2)
    cells = np.unique(np.clip(((pts + 1.0) * 0.5 * grid).astype(np.int64), 0, grid - 1), axis=0)
    return (cells + 0.5) / grid * 2.0 - 1.0


def voxel_skin(grid, grid_coords, joints, vertices, faces,
               alpha=0.5, link_dis=1e-5, grid_query=27, vertex_query=27,
               grid_weight=3.0, mode="square", parents=None):
    """(N, J) geodesic skin weights. Near-verbatim SkinTokens port; inputs must
    be normalized to [-1, 1] (same frame as grid_coords)."""
    assert mode in ("square", "exp")
    J = joints.shape[0]
    M = grid_coords.shape[0]
    N = vertices.shape[0]
    _range = 2 / grid * 1.74

    grid_tree = cKDTree(grid_coords)
    vertex_tree = cKDTree(vertices)

    # subdivide long single-child bones so distance flows along the bone
    if parents is not None:
        son = defaultdict(list)
        for i, p in enumerate(parents):
            if p >= 0:
                son[p].append(i)
        divide_joints, joints_map = [], []
        for u in range(len(parents)):
            if len(son[u]) != 1:
                divide_joints.append(joints[u]); joints_map.append(u)
            else:
                pu, pv = joints[u], joints[son[u][0]]
                seg = 10
                for i in range(seg + 1):
                    divide_joints.append((pu * i + pv * (seg - i)) / seg)
                    joints_map.append(u)
        divide_joints = np.stack(divide_joints)
        joints_map = np.array(joints_map)
    else:
        divide_joints = joints
        joints_map = np.arange(J)
    joint_tree = cKDTree(divide_joints)

    combined_vertices = np.concatenate([vertices, grid_coords], axis=0)

    # adjacent grid cells
    dist, idx = grid_tree.query(grid_coords, grid_query)
    dist, idx = dist[:, 1:], idx[:, 1:]
    mask = (0 < dist) & (dist < _range)
    src_gg = np.repeat(np.arange(M), grid_query - 1)[mask.ravel()] + N
    to_gg = idx[mask] + N
    w_gg = dist[mask] * grid_weight

    # near-coincident mesh vertices (seams)
    dist, idx = vertex_tree.query(vertices, 4)
    dist, idx = dist[:, 1:], idx[:, 1:]
    mask = (0 < dist) & (dist < link_dis)
    src_cl = np.repeat(np.arange(N), 3)[mask.ravel()]
    to_cl = idx[mask]
    w_cl = dist[mask]

    # grid cells to mesh vertices
    dist, idx = vertex_tree.query(grid_coords, vertex_query)
    mask = (0 < dist) & (dist < _range)
    src_gv = np.repeat(np.arange(M), vertex_query)[mask.ravel()] + N
    to_gv = idx[mask]
    w_gv = dist[mask]

    combined_tree = cKDTree(combined_vertices)
    _, joint_indices = combined_tree.query(divide_joints)

    # mesh edges
    src_vv = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    to_vv = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    w_vv = np.sqrt(((vertices[src_vv] - vertices[to_vv]) ** 2).sum(-1))

    graph = csr_matrix(
        (np.concatenate([w_cl, w_vv, w_gg, w_gv]),
         (np.concatenate([src_cl, src_vv, src_gg, src_gv]),
          np.concatenate([to_cl, to_vv, to_gg, to_gv]))),
        shape=(N + M, N + M))

    dist_matrix = shortest_path(graph, method="D", directed=False, indices=joint_indices)
    dis_v2b = dist_matrix[:, :N]

    unreachable = np.isinf(dis_v2b).all(axis=0)
    if unreachable.any():
        k = min(J, 3)
        d, idx = joint_tree.query(vertices[unreachable], k)
        d = np.atleast_2d(d); idx = np.atleast_2d(idx)
        un = np.where(unreachable)[0]
        dis_v2b[idx, np.repeat(un, k).reshape(-1, k)] = d

    finite = dis_v2b[np.isfinite(dis_v2b)]
    max_dis = float(finite.max()) if len(finite) else 1.0
    dis_v2b = np.nan_to_num(dis_v2b, nan=max_dis, posinf=max_dis, neginf=max_dis)
    dis_v2b = np.maximum(dis_v2b, 1e-6)

    dis_v2j = np.full((J, N), max_dis)
    for i in range(len(dis_v2b)):
        j = joints_map[i]
        dis_v2j[j] = np.minimum(dis_v2b[i], dis_v2j[j])

    if mode == "exp":
        skin = np.exp(-dis_v2j / max_dis * 20.0)
    else:
        skin = (1.0 / ((1 - alpha) * dis_v2j + alpha * dis_v2j ** 2)) ** 2
    skin = skin / skin.sum(axis=0)
    return skin.T


def geodesic_filter(weights, vertices, faces, joints, parents,
                    grid=64, power=1.0, mode="square"):
    """Opt-in post-filter over transferred weights: W' ∝ W * V^power, where V is
    the geodesic voxel skin. power=1.0 stays SOFT on purpose — official UniRig
    cubes its mask (voxel_mask=3.0) and that binarization is exactly what tears
    tubes and double shells. Orphans (rows the mask zeroes out) take V directly."""
    v = np.asarray(vertices, np.float64)
    lo, hi = v.min(0), v.max(0)
    center = (lo + hi) / 2
    scale = float((hi - lo).max()) / 2 or 1.0
    nv = (v - center) / scale
    nj = (np.asarray(joints, np.float64) - center) / scale
    coords = voxelize_surface(nv, faces, grid)
    V = voxel_skin(grid, coords, nj, nv, np.asarray(faces),
                   parents=np.asarray(parents), mode=mode)
    V = np.nan_to_num(V, nan=0.0, posinf=0.0, neginf=0.0)
    W = weights * np.power(V, power)
    rows = W.sum(1)
    dead = rows < 1e-9
    if dead.any():
        W[dead] = V[dead]
    return (W / (W.sum(1, keepdims=True) + 1e-12)).astype(np.float32)
