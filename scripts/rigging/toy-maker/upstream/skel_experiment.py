"""E0 skeleton-quality experiment - single-combo WORKER (isolated pixi env, GPU).

One (mesh, num_samples, temperature, seed) skeleton prediction per process:
UniRig generation can fail natively (no-parts roll = hard crash, no Python
exception), so the driver (skel_matrix.py, stable venv) runs each combo in its
own subprocess and records crashes as data instead of dying.

env: MESH_NPZ, OUT_JSON, OUT_NPZ, DENS, SKEL_TEMP (empty = model default),
SEED, TOY. Spec: docs/specs/2026-07-05-skeleton-quality.md
"""
import os, sys, time, json

COMFY = os.environ["COMFYUI_DIR"]
sys.path.insert(0, COMFY)
sys.path.insert(0, os.path.join(COMFY, "custom_nodes", "ComfyUI-UniRig", "nodes"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0]]
import numpy as np
import torch
from unirig.direct import normalize_vertices, sample_mesh_surface, predict_skeleton
# NOTE: no body_plans / classification here — numpy LAPACK (svd) after torch/CUDA
# init aborts NATIVELY in this env (OpenMP runtime conflict, no traceback). All
# analysis happens in the driver (stable venv), same rule as mesh I/O.

SKEL = os.path.join(COMFY, "models", "unirig", "skeleton.safetensors")
dens = int(os.environ["DENS"])
temp = os.environ.get("SKEL_TEMP", "")
seed = int(os.environ["SEED"])
vsamp = int(os.environ.get("VSAMP", "0"))    # >0 = official-style vertex+surface mix
m = np.load(os.environ["MESH_NPZ"])
faces = m["faces"].astype(np.int64)
norm_v, _ = normalize_vertices(m["vertices"].astype(np.float32))
if vsamp > 0:
    from sample_mix import sample_mix
    pts, nrm = sample_mix(norm_v, faces, sample_mesh_surface, dens, vsamp, seed)
else:
    pts, nrm = sample_mesh_surface(norm_v, faces, num_samples=dens, seed=seed)
torch.manual_seed(seed)
torch.cuda.manual_seed_all(seed)
kw = {"temperature": float(temp)} if temp else {}
t0 = time.time()
skel = predict_skeleton(pts, nrm, SKEL, cls="articulationxl", attn_backend="sdpa", **kw)
joints = np.asarray(skel["joints"], float)
parents = np.array([(-1 if p is None else int(p)) for p in skel["parents"]])
np.savez(os.environ["OUT_NPZ"], joints=joints, parents=parents,
         tails=np.asarray(skel.get("tails", np.zeros((0, 3)))))
with open(os.environ["OUT_JSON"], "w") as f:
    json.dump({"joints": int(len(joints)), "secs": round(time.time() - t0, 1)}, f)
print("RESULT joints=%d in %.1fs" % (len(joints), time.time() - t0), flush=True)
sys.stdout.flush(); sys.stderr.flush()
os._exit(0)
