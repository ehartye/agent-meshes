"""Rig with REAL tails fed to the skin model (rig_mesh drops them -> NaN).

Modes (RIG_MODE env, default "full" = legacy single-shot skeleton+skin):
  full       -> one skeleton + skinning to OUTPUT_NPZ (params below still apply)
  skeletons  -> SKEL_CANDIDATES skeletons to CAND_DIR/cand_<k>.npz (no skinning);
                selection/scoring happens in the STABLE venv (numpy LAPACK aborts
                natively here once torch/CUDA is up — see rigging/README)
  skin       -> skinning for a chosen candidate (SKEL_NPZ) to OUTPUT_NPZ

Skeleton params (all modes): SKEL_SAMPLES (surface points, default 2048),
SKEL_SEED (default 42; same seed + mesh -> same skeleton), SKEL_TEMP (generation
temperature override; empty = model default 1.5). Candidate k uses SEED + 1000*k.
"""
import os
import sys

COMFY = os.environ["COMFYUI_DIR"]
NODES = os.path.join(COMFY, "custom_nodes", "ComfyUI-UniRig", "nodes")
sys.path.insert(0, COMFY)
sys.path.insert(0, NODES)
sys.argv = [sys.argv[0]]

import numpy as np
import torch

MESH_NPZ = os.environ["MESH_NPZ"]
SKEL = os.path.join(COMFY, "models", "unirig", "skeleton.safetensors")
SKIN = os.path.join(COMFY, "models", "unirig", "skin.safetensors")

MODE = os.environ.get("RIG_MODE", "full")
SAMPLES = int(os.environ.get("SKEL_SAMPLES", "2048"))
SEED = int(os.environ.get("SKEL_SEED", "42"))
TEMP = os.environ.get("SKEL_TEMP", "")
K = int(os.environ.get("SKEL_CANDIDATES", "1"))
GEN_KW = {"temperature": float(TEMP)} if TEMP else {}

m = np.load(MESH_NPZ)
verts, faces = m["vertices"].astype(np.float32), m["faces"].astype(np.int64)
print(f"mesh: {len(verts)} verts  mode={MODE} samples={SAMPLES} seed={SEED} "
      f"temp={TEMP or 'default'} k={K}", flush=True)

from unirig.direct import normalize_vertices, sample_mesh_surface, predict_skeleton, predict_skinning

norm_v, params = normalize_vertices(verts)


def _sample(n_samples, seed, vsamp=0):
    """vsamp>0 = official-style vertex+surface mix (R1: triples the fox tail
    hit-rate at 64k; hurts packed spider legs — a roster regime, not a default)."""
    if vsamp > 0:
        from sample_mix import sample_mix
        return sample_mix(norm_v, faces, sample_mesh_surface, n_samples, vsamp, seed)
    return sample_mesh_surface(norm_v, faces, num_samples=n_samples, seed=seed)


def gen_skeleton(seed, n_samples=None, vsamp=None):
    pts, nrm = _sample(n_samples or SAMPLES, seed,
                       int(os.environ.get("SKEL_VSAMP", "0")) if vsamp is None else vsamp)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    skel = predict_skeleton(pts, nrm, SKEL, cls="articulationxl", attn_backend="sdpa", **GEN_KW)
    return pts, nrm, skel


def skel_arrays(skel):
    joints = np.asarray(skel["joints"])
    parents = np.asarray(skel["parents"], dtype=object)
    tails = np.asarray(skel["tails"]) if skel.get("tails") is not None else None
    names = skel.get("names")
    return joints, parents, tails, names


def run_skinning(pts, nrm, joints, parents, tails, out_path, names):
    skin = np.asarray(predict_skinning(pts, nrm, joints, parents, SKIN,
                                       tails=tails, attn_backend="sdpa"))
    print(f"SKIN: shape {skin.shape}, nan={np.isnan(skin).any()}, "
          f"rowsum min={np.nan_to_num(skin).sum(1).min():.3f} "
          f"max={np.nan_to_num(skin).sum(1).max():.3f}", flush=True)
    np.savez(out_path, joints=joints, parents=parents,
             names=np.array(names, dtype=object) if names is not None else np.array([]),
             tails=tails if tails is not None else joints,
             skin_weights=skin, sampled_vertices=pts,
             norm_center=np.asarray(params["center"], dtype=np.float32),
             norm_scale=np.asarray(params["scale"], dtype=np.float32))
    print("saved", out_path, flush=True)


if MODE == "skeletons":
    import json
    cand_dir = os.environ["CAND_DIR"]
    os.makedirs(cand_dir, exist_ok=True)
    # roster: list of [samples, temp_or_empty, seed] regimes (E0: no single config
    # dominates across body plans — diversity beats reseeding one config).
    # Fallback: K reseeds of the base config.
    roster = json.loads(os.environ.get("SKEL_ROSTER", "null")) or \
        [[SAMPLES, TEMP, SEED + 1000 * k] for k in range(K)]
    for k, entry in enumerate(roster):
        n_s, t_s, seed_k = entry[0], entry[1], entry[2]
        vsamp = int(entry[3]) if len(entry) > 3 else 0     # 4th field = mix vertex samples
        pts, nrm = _sample(int(n_s), int(seed_k), vsamp)
        torch.manual_seed(int(seed_k))
        torch.cuda.manual_seed_all(int(seed_k))
        kw = {"temperature": float(t_s)} if t_s else {}
        skel = predict_skeleton(pts, nrm, SKEL, cls="articulationxl", attn_backend="sdpa", **kw)
        joints, parents, tails, names = skel_arrays(skel)
        cname = f"{os.environ.get('CAND_PREFIX', 'cand_')}{k}"
        np.savez(os.path.join(cand_dir, f"{cname}.npz"),
                 joints=joints, parents=parents,
                 names=np.array(names, dtype=object) if names is not None else np.array([]),
                 tails=tails if tails is not None else joints,
                 pts=pts, nrm=nrm, seed=np.int64(int(seed_k)),
                 norm_center=np.asarray(params["center"], dtype=np.float32),
                 norm_scale=np.asarray(params["scale"], dtype=np.float32))
        print(f"candidate {cname}: n={n_s} t={t_s or 'def'} seed={seed_k} joints={len(joints)}", flush=True)
elif MODE == "skin":
    c = np.load(os.environ["SKEL_NPZ"], allow_pickle=True)
    names = list(c["names"]) if len(c["names"]) else None
    tails = c["tails"] if "tails" in c.files else None
    run_skinning(c["pts"], c["nrm"], c["joints"], c["parents"], tails,
                 os.environ["OUTPUT_NPZ"], names)
else:   # full — legacy single-shot (params above still apply)
    pts, nrm, skel = gen_skeleton(SEED)
    joints, parents, tails, names = skel_arrays(skel)
    print(f"skeleton: {len(joints)} joints, tails={'REAL' if tails is not None else 'none'}", flush=True)
    run_skinning(pts, nrm, joints, parents, tails, os.environ["OUTPUT_NPZ"], names)

sys.stdout.flush(); sys.stderr.flush(); os._exit(0)
