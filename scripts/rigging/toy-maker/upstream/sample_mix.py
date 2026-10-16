"""Vertex+surface MIX sampling for UniRig skeleton inference (pure numpy).

The official pipeline (UniRig configs/transform/inference_ar_transform.yaml)
feeds the skeleton model `method: mix, num_samples: 65536, vertex_samples: 8192`
— real mesh vertices concatenated with area-weighted surface samples. Our
vendored port only exposed pure surface sampling, and at 2-16k points thin
structures (tails, packed legs) are underrepresented.

Shared by skel_experiment.py (sweeps) and rig_skin_test.py (production);
numpy-only so it is safe in the isolated env (no LAPACK, no trimesh).
"""
import numpy as np


def vertex_normals(v, f):
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    vn = np.zeros_like(v)
    for i in range(3):
        np.add.at(vn, f[:, i], fn)
    n = np.linalg.norm(vn, axis=1, keepdims=True)
    return (vn / np.maximum(n, 1e-12)).astype(v.dtype)


def sample_mix(norm_v, faces, surface_sampler, num_samples, vertex_samples, seed):
    """vertex_samples real vertices + surface samples up to num_samples.
    surface_sampler = unirig.direct.sample_mesh_surface (injected to avoid a
    circular import)."""
    rng = np.random.RandomState(seed)
    vs = int(min(vertex_samples, len(norm_v), num_samples))
    idx = rng.choice(len(norm_v), vs, replace=False)
    vn = vertex_normals(norm_v, faces)
    n_surf = max(0, int(num_samples) - vs)
    if n_surf:
        pts_s, nrm_s = surface_sampler(norm_v, faces, num_samples=n_surf, seed=seed)
        return (np.concatenate([norm_v[idx], pts_s]),
                np.concatenate([vn[idx], nrm_s]))
    return norm_v[idx], vn[idx]
